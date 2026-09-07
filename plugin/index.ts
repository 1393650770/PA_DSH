/**
 * PA_MCP → dsh 原生工具插件（样例）
 *
 * 目标：验证「不经 MCP，直接用 dsh 原生工具 API 消费一个 Python 量化数据层」
 * 整条链路是否可行。PA_MCP 是纯 Python（DuckDB + akshare + 111 个 async 工具）。
 * 本插件是一个 Cordis 插件：
 *   - 用 `@deepseek-ai/dsh-tools` 的 `ctx.tools.register(defineTool(...))` 注册工具；
 *   - 每个工具的 `execute` 内部 spawn 一次 python（scripts/bridge.py），
 *     由 python 侧直接读 PA_MCP 的 DuckDB / paper 账户，返回 JSON；
 *   - 这样复用全部 Python 数据层，无需在 TS 里重写量化逻辑。
 *
 * 工具清单（代表性 3 个，后续可扩展至 PA_MCP 全部 111 个）：
 *   pa_quote        查询单只股票最新行情快照（只读，本地 DuckDB）
 *   pa_positions    当前纸面账户持仓 + 现金（只读，paper_account.json）
 *   pa_order_risk   预检一笔买单是否越过单票 20% 上限（只读，不下单）
 *
 * 生产化注意（见 README）：
 *   - 本样例用 node 内建 child_process.execFile spawn python，便于独立验证。
 *     正式接入 dsh 时，应改用 `ctx.subprocess`（注入 'subprocess'）以纳入
 *     dsh 的沙箱/权限策略；装配时需加载一个 subprocess provider 插件。
 *   - python 每次调用冷启动较重；正式版可升级为长驻 stdio 桥
 *     （bridge.py 的 stdin/stdout JSON 循环），一次拉起多次服务。
 *
 * @module pa-mcp-dsh-sample
 */
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool, type JsonValue } from '@deepseek-ai/dsh-tools'
// Side-effect type import: declaration-merges `ctx.tools` onto Context.
import type {} from '@deepseek-ai/dsh-tools'

export const name = 'pa-mcp-dsh-sample'

/** Services required by this plugin. */
export const inject = ['tools']

const SAMPLE_DIR = dirname(fileURLToPath(import.meta.url))
// plugin/ 上一级(..) => dsh-plugin-sample，再上一级根是 D:/Project/AI/PA_MCP，
// 但 PA_MCP 数据项目在 D:/Project/AI/PA_MCP/PA_MCP。
const PA_ROOT_DEFAULT = resolve(SAMPLE_DIR, '..', '..', 'PA_MCP')

/** Runtime configuration（由 cordis.yml 注入）。 */
export interface Config {
  /** python 可执行（须装有 duckdb）。默认自动探测：PA_MCP venv → 系统 python。 */
  pythonBin?: string
  /** PA_MCP 项目根目录（数据文件相对它定位）。缺省自动推断。 */
  paMcpRoot?: string
  /** 行情库 .duckdb 绝对路径。缺省 PA_MCP_ROOT/data/pa_mcp.duckdb。 */
  dbPath?: string
  /** paper 账户 json 绝对路径。缺省 PA_MCP_ROOT/data/paper_account.json。 */
  accountPath?: string
  /** 每次 python 调用超时（毫秒），缺省 60s。 */
  toolTimeoutMs?: number
}

export const Config: z<Config> = z.object({
  pythonBin: z.string(),
  paMcpRoot: z.string(),
  dbPath: z.string(),
  accountPath: z.string(),
  toolTimeoutMs: z.number().default(60_000),
})

interface ResolvedEnv {
  pythonBin: string
  env: Record<string, string>
  timeoutMs: number
}

/**
 * 把可选配置落成运行所需的具体值（默认/探测）。
 * python 优先级：配置显式指定 → PA_MCP venv 的 python（已装 duckdb）→ 系统 python。
 */
function resolveEnv(cfg: Config, fallbackRoot: string): ResolvedEnv {
  const root = cfg.paMcpRoot ?? fallbackRoot
  let pythonBin = cfg.pythonBin
  if (!pythonBin) {
    const venvWin = join(root, 'venv', 'Scripts', 'python.exe')
    const venvPosix = join(root, 'venv', 'bin', 'python')
    if (existsSync(venvWin)) pythonBin = venvWin
    else if (existsSync(venvPosix)) pythonBin = venvPosix
    else pythonBin = 'python'
  }
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PA_MCP_ROOT: root,
    PA_MCP_DB: cfg.dbPath ?? join(root, 'data', 'pa_mcp.duckdb'),
    PA_MCP_ACCOUNT: cfg.accountPath ?? join(root, 'data', 'paper_account.json'),
  }
  return { pythonBin, env, timeoutMs: cfg.toolTimeoutMs ?? 60_000 }
}

/** spawn 一次 python bridge，返回解析后的 JSON。 */
function runBridge(envCfg: ResolvedEnv, tool: string, args: Record<string, unknown>): Promise<BridgeResult> {
  const bridge = join(SAMPLE_DIR, '..', 'scripts', 'bridge.py')
  return new Promise((res, rej) => {
    execFile(
      envCfg.pythonBin,
      [bridge, '--tool', tool, '--args', JSON.stringify(args)],
      { env: envCfg.env, timeout: envCfg.timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          rej(new Error(`python bridge 失败: ${err.message}` + (stderr ? `\nstderr: ${stderr}` : '')))
          return
        }
        try {
          res(JSON.parse(stdout.trim()) as BridgeResult)
        } catch {
          rej(new Error(`bridge 输出非 JSON: ${String(stdout).slice(0, 500)}` + (stderr ? `\nstderr: ${stderr}` : '')))
        }
      },
    )
  })
}

/** 把 BridgeResult 转成 dsh 工具返回的 JSON 值；业务 ok=false 也正常返回（含 error）。 */
function toToolResult(r: BridgeResult): Record<string, JsonValue> {
  if (r.ok) {
    const data = r.data as Record<string, JsonValue> | undefined
    return { ok: true as JsonValue, ...(data ?? {}) }
  }
  return {
    ok: false as JsonValue,
    error: (r.error ?? 'unknown error') as JsonValue,
    error_type: (r.error_type ?? 'BRIDGE_ERROR') as JsonValue,
  }
}

/** bridge 桥结果（脚本约定）。 */
interface BridgeResult {
  ok: boolean
  data?: unknown
  error?: string
  error_type?: string
}

export function apply(ctx: Context, config: Config = {}): void {
  const envCfg = resolveEnv(config, PA_ROOT_DEFAULT)

  ctx.tools.register(defineTool({
    name: 'pa_quote',
    description: '查询 PA_MCP 本地行情库中某只 A 股最新日线快照（开高低收/量/额）。'
      + ' 只读本地 DuckDB，非盘中实时。示例代码：600519（贵州茅台）。',
    parameters: {
      symbol: { type: 'string', required: true, description: 'A 股代码，如 600519 / 000001' },
    },
    output: {
      schema: { type: 'object' as const, additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args: { symbol: string }) {
      return toToolResult(await runBridge(envCfg, 'quote', args))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'pa_positions',
    description: '查询 PA_MCP 纸面账户当前持仓与现金。只读 paper_account.json；'
      + ' 市值/净值用本地最新 close 估算，非实时。',
    parameters: {},
    output: {
      schema: { type: 'object' as const, additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute() {
      return toToolResult(await runBridge(envCfg, 'positions', {}))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'pa_order_risk',
    description: '预检一笔 PA_MCP 纸面买单是否越过单票 20% 仓位上限。'
      + ' 只读账户 + 本地行情估价，**不下单**。返回 verdict=approve/reject 与可买参考量。',
    parameters: {
      symbol: { type: 'string', required: true, description: 'A 股代码，如 600519' },
      side: { type: 'string', required: true, enum: ['buy', 'sell'], description: '方向（上限预检仅对 buy 有意义）' },
      quantity: { type: 'integer', required: true, description: '股数（A 股按 100 股/手）' },
    },
    output: {
      schema: { type: 'object' as const, additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args: { symbol: string; side: 'buy' | 'sell'; quantity: number }) {
      return toToolResult(await runBridge(envCfg, 'order_risk', args))
    },
  }))
}

// 注意：不导出 default。cordis 加载器读取的是命名的 name/inject/apply 导出；
// 若再 `export default apply`，加载器会用 `new default()` 实例化 apply，
// 从而丢失命名导出里的 inject 元数据，导致 `ctx.tools` 报 "cannot get without
// inject"。与官方 tool-bash 一致：仅命名导出。
