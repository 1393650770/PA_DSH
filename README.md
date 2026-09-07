# PA_MCP → DeepSeek Harness (dsh) 原生工具插件 —— 接入样例

本目录验证一条核心命题：**能否不经 MCP，用 dsh 的原生工具 API，把一个
纯 Python 量化数据层（PA_MCP）暴露给 dsh 的 agent？**

> 结论（已在真实 dsh host 验证到「工具注册」，见 [验证状态](#验证状态)）：**可行。**
> 样例插件用
> `@deepseek-ai/dsh-tools` 的 `ctx.tools.register(defineTool(...))` 注册原生工具，
> 每个工具的 `execute` 内部 spawn 一次 python（`scripts/bridge.py`），由 python
> 直接读 PA_MCP 的 DuckDB 行情库与纸面账户，返回 JSON。这样**复用全部 Python
> 数据层**，无需在 TS 里重写量化逻辑。

---

## 目录结构

```
dsh-plugin-sample/
├── scripts/
│   └── bridge.py            # python 侧极轻桥：读 PA_MCP 数据文件，输出 JSON
├── plugin/
│   ├── index.ts             # Cordis 插件：注册 3 个原生工具，execute 内 spawn python
│   ├── package.json         # 插件包声明（peerDeps: dsh-tools / cordis / schemastery）
│   ├── tsconfig.json
│   └── lib/                 # 编译产物（tsc 生成）
├── examples/
│   ├── cordis.sample.yml    # 把插件接入 dsh profile 的装配样例
│   └── e2e-headless.patch.yml  # 实机测试用 --patch 补丁（headless profile）
└── README.md
```

## 架构

```
dsh agent
   │  tool call: pa_quote / pa_positions / pa_order_risk
   ▼
ctx.tools  (由 @deepseek-ai/dsh-tools 提供)
   │  register(defineTool({ name, parameters, output, execute }))
   ▼
本插件 execute()
   │  node:child_process.execFile → python scripts/bridge.py --tool <name> --args <json>
   ▼
scripts/bridge.py   （读 D:/Project/AI/PA_MCP/PA_MCP/data/…）
   ├─ data/pa_mcp.duckdb      行情日线（只读）
   └─ data/paper_account.json 纸面账户（只读）
```

三个代表性工具（对应后续可扩展的全量 111 个）：

| dsh 工具 | 用途 | 对应 PA_MCP MCP 工具 |
|---------|------|---------------------|
| `pa_quote` | 单只 A 股最新日线快照（开高低收/量额） | `get_realtime_quote`（只读本地库） |
| `pa_positions` | 纸面账户持仓 + 现金 | `portfolio_summary` 等（只读账户） |
| `pa_order_risk` | 预检买单是否越过单票 20% 上限 | `place_order` 的风控预检部分（只读，不下单） |

## 快速自测（不依赖 dsh，验证 python 桥本身 —— 现在就能跑，无需任何 key）

```bash
cd D:/Project/AI/PA_MCP/dsh-plugin-sample
export PA_MCP_ROOT="D:/Project/AI/PA_MCP/PA_MCP"
D:/Project/AI/PA_MCP/PA_MCP/venv/Scripts/python.exe scripts/bridge.py --tool quote --args '{"symbol":"600519"}'
D:/Project/AI/PA_MCP/PA_MCP/venv/Scripts/python.exe scripts/bridge.py --tool positions
D:/Project/AI/PA_MCP/PA_MCP/venv/Scripts/python.exe scripts/bridge.py --tool order_risk --args '{"symbol":"600519","side":"buy","quantity":3000}'
```

每个工具成功时 stdout 是单行 `{"ok": true, "data": {...}}`：
- `pa_quote` 应返回 600519 的 close≈1307.88（读本地 kline_daily 最新一根）
- `pa_order_risk` 3000 股应 `verdict: reject`（权重约 392% > 20% 上限），100 股应 `approve`

## 实机测试手册（在 dsh host 里测到「agent 真正调用工具」）

> 本目录已验证到「插件在真实 dsh host 里干净加载、3 工具注册进 `ctx.tools`」。
> 要让 dsh 的 agent 实际发起 `pa_quote` 调用，需要 `DEEPSEEK_API_KEY`（headless
> 默认走 deepseek-official 路由；这与 dsh 内置 bash 等工具是同一个凭据门槛）。

### 前置：装 dsh CLI（一次）

```bash
mkdir -p /tmp/dsh-host && cd /tmp/dsh-host
npm init -y
npm install @deepseek-ai/dsh@0.1.2-rc.1     # 约 522 包
./node_modules/.bin/dsh --help
```

> 插件编译产物 `plugin/lib/` 不入库（.gitignore）。若全新 clone 后 `lib/` 不存在，
> 先 `cd plugin && npm install && npm run build` 生成（需 node ≥18）。
> 本地已 build 过，`plugin/lib/index.js` 当前存在，可直接跑下面的步骤。

### 第 1 步：确认插件被 dsh 组合（无需 key）

```bash
cd /tmp/dsh-host
./node_modules/.bin/dsh --profile headless \
  --patch "D:/Project/AI/PA_MCP/dsh-plugin-sample/examples/e2e-headless.patch.yml" \
  --dump-config | grep -A2 "pa-mcp-sample"
```

预期：输出里有 `- id: pa-mcp-sample` + `name: file:///.../lib/index.js` 两行，
证明插件已进入组合树。

### 第 2 步：无 key 先看插件能否干净加载（可选探测）

```bash
./node_modules/.bin/dsh --profile headless \
  --patch "D:/Project/AI/PA_MCP/dsh-plugin-sample/examples/e2e-headless.patch.yml" \
  "hi"
```

预期：若**没有**出现 `plugin tree failed to load ... pa-mcp-sample` 之类的错误、
而只报 `MISSING_CREDENTIAL: ... no API key ...`，就说明插件已成功加载并注册工具
（该 key 报错与 base 内置工具相同，非插件问题）。

### 第 3 步：设好 key 跑真实工具调用

```bash
export DEEPSEEK_API_KEY="sk-..."
./node_modules/.bin/dsh --profile headless \
  --patch "D:/Project/AI/PA_MCP/dsh-plugin-sample/examples/e2e-headless.patch.yml" \
  "用 pa_quote 查 600519 最新收盘价"
```

预期：agent 选择并调用 `pa_quote`，返回里能看到 600519 的 close/date。
（提示词也可换 `pa_positions`、`pa_order_risk` 试其它两个。）

### 判定「测试通过」的标准

- bridge 三工具都返回 `ok: true`（第 0 步，无需 key）→ 数据层链路 OK
- `--dump-config` 含 `pa-mcp-sample`（第 1 步）→ 插件被组合 OK
- 无 key 跑只报 MISSING_CREDENTIAL、无 plugin-load 错误（第 2 步）→ 工具注册 OK
- 有 key 跑能拿到 600519 行情（第 3 步）→ agent→工具→python→数据 全链路 OK

## 装配进 dsh（把插件固化到你的 dsh 环境）

把 `examples/cordis.sample.yml` 的条目写进你 profile 的用户补丁层
（`~/.dsh/profiles/<profile>/cordis.patch.yml`），并确保宿主已加载
`@deepseek-ai/dsh-tools`（base/headless 等 profile 默认含，提供 `ctx.tools`）。
Windows 插件路径必须是 `file://` URL 且指向编译产物 `lib/index.js`（见下）。

## 验证状态

| 项目 | 状态 |
|------|------|
| python 桥 `bridge.py` 单独跑通（真实行情/持仓/风控判定） | ✅ 已验证 |
| 插件 `index.ts` 对真实 `@deepseek-ai/dsh-tools`/`cordis`/`schemastery` 类型做 `tsc` 类型检查 | ✅ 通过（0 错误） |
| 插件编译产出可加载 `lib/index.js` | ✅ 通过 |
| 真实 dsh host（`@deepseek-ai/dsh` CLI）装配并加载本插件，3 工具注册进 `ctx.tools` | ✅ 已验证 |
| agent 实际发起一次工具调用（LLM 驱动） | 🔶 需 `DEEPSEEK_API_KEY`，步骤见「[实机测试手册](#实机测试手册在-dsh-host-里测到agent-真正调用工具)」 |

## 端到端验证记录

已在真实 dsh host 中完成到「工具注册」的端到端验证（按上文「实机测试手册」的
第 1、2 步跑通），过程中发现并修复了 3 个只在真实 dsh 加载时才暴露的问题，
全部沉淀到代码/样例：

1. **Windows 路径需 `file://` URL**：patch 的 `name` 不能用裸 `D:/...`，必须
   `file:///D:/...`，且指向编译产物 `lib/index.js`（目录 import 不被 ESM 支持）。
2. **ESM 里不能用 `require`**：插件是 `"type":"module"`，读文件探测 python 路径
   用了 `require('node:fs')` 会在真实 ESM 加载时报 `ReferenceError: require is
   not defined`；改为顶部 `import { existsSync }`。
3. **不要 `export default apply`**：加了 default export 会让 cordis 用
   `new default()` 实例化 `apply`，从而丢失命名的 `inject` 元数据，报
   `cannot get property "tools" without inject`。只保留命名的
   `name`/`inject`/`Config`/`apply` 导出（与官方 tool-bash 一致）。

**剩余一步**：让 agent 真正发起一次工具调用，只需 `DEEPSEEK_API_KEY`（headless
默认走 deepseek-official 路由；与内置 bash 工具同一凭据门槛）。配置与验证步骤见
上文「[实机测试手册](#实机测试手册在-dsh-host-里测到agent-真正调用工具)」。

> 提示：不要试图脱离 dsh host 用裸 cordis 手动 `new Context()` + ToolRuntime 来
> 复刻 `ctx.tools` —— dsh 的 service 装配由 app-boot/agent 完成，单独挂
> ToolRuntime 并不会把 `ctx.tools` 暴露到根 ctx（实测 `root.tools` 为 undefined）。
> 要端到端验证就走 dsh CLI（上面的手册），不要在最小 host 上浪费时间。

## 生产化注意

- 样例用 node 内建 `execFile` spawn python，便于独立验证。**生产接入**应改用
  `ctx.subprocess`（注入 `'subprocess'` 服务），以纳入 dsh 的沙箱 / 权限策略，
  装配时需加载一个 subprocess provider（如 `@deepseek-ai/dsh-subprocess-local`）。
- python 每次调用有冷启动开销。全量 111 工具或高频场景，建议把 `bridge.py`
  升级为**长驻 stdio 桥**（stdin/stdout 走 JSON 请求/响应），一次拉起、多次服务。
- 样例桥只读，绝不落单；真实下单仍应走 PA_MCP 的 `place_order`（含完整风控：
  单票/行业/总仓/日内亏损/连亏停手），本桥的 `pa_order_risk` 只是单票上限的
  预检演示。

## 扩展到 PA_MCP 全部 111 个工具

1. 在 `scripts/bridge.py` 的 `_TOOLS` 增加 `tool_xxx` 实现（读 DuckDB/账户即可，
   与现有 3 个同构；需实时行情/下单的再引入 pa_mcp 内部模块）。
2. 在 `plugin/index.ts` 的 `apply()` 里对每个工具补一个 `ctx.tools.register(
   defineTool({...}))`，参数 schema 对齐 PA_MCP 工具定义。
3. 高频工具升级长驻 stdio 桥后，`runBridge` 改为向常驻进程写一行请求、读一行
   响应，其余不变。

> 说明：PA_MCP 自身也是标准 MCP server，若只想"让 dsh 用上它"，更省力的官方
> 途径是直接用 `@deepseek-ai/dsh-mcp-client`（配 `command=venv\Scripts\python.exe
> -m pa_mcp.server`）接入。本样例验证的是**独立的原生工具（不经 MCP）**路径，
> 供你在二者间按需取舍。
