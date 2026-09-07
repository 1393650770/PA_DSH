#!/usr/bin/env python3
"""PA_MCP → dsh 原生插件样例的 Python 桥。

被 dsh 的 Cordis 插件以 `python bridge.py --tool <name> --args <json>` 拉起，
直接读 PA_MCP 的数据文件（DuckDB 行情库 + Paper 账户），返回 JSON。

设计约束：
- 不 import `pa_mcp.server` / 不启动 MCP —— 避免拉起整个 server 的依赖面。
  只做"读数据文件 + 少量计算"，保持极轻、无状态、单次进程即退。
- 只读为主：行情查询是只读；持仓/风控预检也只读，不落单。
- 每个工具调用都是独立进程，无热状态；未来可升级为长驻 stdio 桥以省去
  python 冷启动，但那是优化，不是正确性前提。

调用契约：
    python bridge.py --tool <tool_name> [--args '<json字符串>']
    成功 →  stdout 输出单行 JSON: {"ok": true, "data": {...}}
    失败 →  stdout 输出单行 JSON: {"ok": false, "error": "...", "error_type": "..."}
    进程退出码：0=已产出结果(含业务拒绝)；非0=桥自身异常。

样例提供的 3 个代表性工具（对应 dsh 插件里的 pa_quote / pa_positions /
pa_order_risk）：
    quote        查某只股票的最新行情快照（读 kline_daily）
    positions    当前纸面账户持仓 + 现金（读 paper_account.json，缺省则空账户）
    order_risk   预检一笔买入是否越过单票 20% 上限（读账户 + 行情估价）
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

# ── 路径解析：优先 PA_MCP 根（由插件经 argv/env 传入），否则按脚本相对位置推断 ──
_HERE = Path(__file__).resolve().parent
# 默认假定：样例目录在 D:/Project/AI/PA_MCP/dsh-plugin-sample/，PA_MCP 根在上一级
_PA_ROOT = Path(os.environ.get("PA_MCP_ROOT", "")) if os.environ.get("PA_MCP_ROOT") else _HERE.parents[1]
_DB_PATH = Path(os.environ.get("PA_MCP_DB", _PA_ROOT / "data" / "pa_mcp.duckdb"))
_ACCOUNT_PATH = Path(os.environ.get("PA_MCP_ACCOUNT", _PA_ROOT / "data" / "paper_account.json"))

# 单票仓位上限（与 pa_mcp/risk/guard.py 默认 max_single_stock 对齐，供预检参考）
MAX_SINGLE_STOCK = 0.20


# ── 轻量数据访问：延迟 import duckdb，保证 --help / 参数错误也能优雅退出 ──
def _query_duck(sql: str, params: list | None = None) -> list[dict]:
    """对行情库跑一条只读 SQL，返回 dict 列表（dupdb 连接用完即关）。"""
    import duckdb

    con = duckdb.connect(str(_DB_PATH), read_only=True)
    try:
        if params:
            rows = con.execute(sql, params).fetchall()
            cols = [d[0] for d in con.description]
        else:
            rows = con.execute(sql).fetchall()
            cols = [d[0] for d in con.description]
        return [dict(zip(cols, r)) for r in rows]
    finally:
        con.close()


def _load_account() -> dict:
    """读 paper 账户；文件不存在时返回默认空账户（100 万现金，与 PaperBroker 一致）。"""
    if _ACCOUNT_PATH.exists():
        with open(_ACCOUNT_PATH, encoding="utf-8") as f:
            data = json.load(f)
    else:
        data = {"cash": 1_000_000.0, "positions": {}, "orders": {}, "fills": []}
    positions = data.get("positions", {})
    if isinstance(positions, dict):
        # {symbol: {quantity, available, avg_cost,...}}
        items = [{"symbol": s, **{k: p.get(k) for k in ("quantity", "available", "avg_cost", "buy_date")}}
                 for s, p in positions.items()]
    else:  # 兼容 list 形态
        items = [dict(p) for p in positions]
    return {"cash": float(data.get("cash", 0.0)), "positions": items}


def _market_value(pos_list: list[dict]) -> float:
    """用最新 close 估算持仓市值；取不到则退回 avg_cost。"""
    total = 0.0
    for p in pos_list:
        qty = float(p.get("quantity") or 0)
        px = _latest_close(p["symbol"])
        if px is None:
            px = float(p.get("avg_cost") or 0)
        total += qty * px
    return total


def _latest_close(symbol: str) -> float | None:
    try:
        rows = _query_duck(
            "SELECT close FROM kline_daily WHERE symbol=? "
            "AND close IS NOT NULL ORDER BY date DESC LIMIT 1", [symbol])
        return float(rows[0]["close"]) if rows else None
    except Exception:
        return None


# ── 工具实现 ──
def tool_quote(symbol: str) -> dict:
    rows = _query_duck(
        "SELECT date, open, high, low, close, volume, amount "
        "FROM kline_daily WHERE symbol=? "
        "AND close IS NOT NULL ORDER BY date DESC LIMIT 1", [symbol])
    if not rows:
        return {"ok": False, "error": f"无 {symbol} 的行情数据（kline_daily 无记录）",
                "error_type": "NO_DATA"}
    r = rows[0]
    return {"ok": True, "data": {
        "symbol": symbol, "as_of": str(r["date"]),
        "open": r["open"], "high": r["high"], "low": r["low"],
        "close": r["close"], "volume": r["volume"], "amount": r["amount"],
        "note": "数据来自本地 DuckDB 最新日线；盘中实时价请走 MCP 的 get_realtime_quote",
    }}


def tool_positions() -> dict:
    acct = _load_account()
    pos = acct["positions"]
    mv = _market_value(pos)
    cash = acct["cash"]
    nav = cash + mv
    rows = [{
        "symbol": p["symbol"], "quantity": p.get("quantity"),
        "available": p.get("available"), "avg_cost": p.get("avg_cost"),
        "market_value_est": (p.get("quantity") or 0) * (_latest_close(p["symbol"])
                             or (p.get("avg_cost") or 0)),
    } for p in pos]
    return {"ok": True, "data": {
        "account": "paper", "cash": round(cash, 2), "positions": rows,
        "market_value_est": round(mv, 2), "nav_est": round(nav, 2),
        "note": "市值/净值用本地最新 close 估算，非实时",
    }}


def tool_order_risk(symbol: str, side: str, quantity: int) -> dict:
    """预检一笔买单是否越过单票 20% 上限（读账户 + 本地行情估价，不下单）。"""
    acct = _load_account()
    cash = acct["cash"]
    pos_list = acct["positions"]
    mv = _market_value(pos_list)
    nav = cash + mv
    if nav <= 0:
        nav = 100_000.0

    px = _latest_close(symbol)
    if px is None:
        return {"ok": False, "error": f"无法获取 {symbol} 估价，无法预检",
                "error_type": "NO_PRICE"}

    est_value = quantity * px
    # 该票现有市值（含拟买部分）
    current_holding = next((p for p in pos_list if p["symbol"] == symbol), None)
    cur_value = (current_holding.get("quantity") or 0) * px if current_holding else 0.0
    new_weight = (cur_value + est_value) / nav

    verdict = "approve" if side == "buy" and new_weight <= MAX_SINGLE_STOCK else "reject"
    reasons = []
    if side != "buy":
        reasons.append("风控单票上限预检仅对 buy 有意义，sell 不适用（返回 reject 以提示）")
    if new_weight > MAX_SINGLE_STOCK:
        reasons.append(
            f"拟买后 {symbol} 占总净值 {new_weight:.1%} > 上限 {MAX_SINGLE_STOCK:.0%}")
    # 最大可买（不越上限）参考量
    max_qty = 0
    if side == "buy":
        budget = (nav * MAX_SINGLE_STOCK - cur_value)
        max_qty = int(budget // px // 100 * 100) if budget > 0 else 0

    return {"ok": True, "data": {
        "symbol": symbol, "side": side, "quantity": quantity,
        "est_price": px, "est_value": round(est_value, 2),
        "nav_est": round(nav, 2), "current_weight": round(cur_value / nav, 4),
        "new_weight": round(new_weight, 4), "single_stock_cap": MAX_SINGLE_STOCK,
        "verdict": verdict, "reasons": reasons,
        "max_buyable_under_cap": max_qty,
        "note": "仅为单票上限预检；完整风控（行业/总仓/日内亏损）请走 MCP 的 place_order",
    }}


# ── 分发 ──
_TOOLS = {"quote": tool_quote, "positions": tool_positions, "order_risk": tool_order_risk}


def _emit(obj: dict) -> int:
    print(json.dumps(obj, ensure_ascii=False))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="PA_MCP dsh 样例 python 桥")
    ap.add_argument("--tool", required=True, choices=sorted(_TOOLS), help="工具名")
    ap.add_argument("--args", default="{}", help="工具参数的 JSON 字符串")
    args = ap.parse_args()

    try:
        raw = json.loads(args.args) if args.args else {}
        if not isinstance(raw, dict):
            raise ValueError("args 必须是 JSON 对象")
        return _emit(_TOOLS[args.tool](**raw))
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        return _emit({"ok": False, "error": str(e), "error_type": "BRIDGE_ERROR"})


if __name__ == "__main__":
    sys.exit(main())
