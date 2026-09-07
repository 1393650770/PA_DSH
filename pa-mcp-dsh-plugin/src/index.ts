/**
 * pa-mcp-dsh-plugin —— 把 PA_MCP(纯 Python MCP server)暴露为 dsh 原生工具
 *
 * 设计（对应「改 PA_MCP 无需手动同步插件」）：
 *   - 插件在 apply() 时 spawn 一个常驻的 PA_MCP python 进程（stdio MCP server）；
 *   - 用 @modelcontextprotocol/sdk 的 Client 连上它，调 listTools() 拿到全部
 *     工具及其 JSON schema；
 *   - 逐个 `ctx.tools.register(defineTool(...))`，把每个 MCP 工具注册成 dsh
 *     **原生工具**（命名 pa__<原名>），execute 内部把参数经 tools/call 转发回
 *     PA_MCP python 进程。
 *   - 因此 PA_MCP 里增/改/删工具，插件下次启动自动发现，**无需在 TS 侧手写
 *     任何工具定义**。PA_MCP 是工具的单一事实来源。
 *
 * 仅命名导出（name/inject/Config/apply）。勿 export default（会丢 inject）。
 *
 * @module pa-mcp-dsh-plugin
 */
import { dirname, join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool, type JsonValue } from '@deepseek-ai/dsh-tools'
// Side-effect type import: declaration-merges `ctx.tools` onto Context.
import type {} from '@deepseek-ai/dsh-tools'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

export const name = 'pa-mcp-dsh-plugin'
export const inject = ['tools']

const _here = dirname(fileURLToPath(import.meta.url))
// 仓库根 = src/ 的上一级（lib/src/index.js -> 两级上去到仓库根）
const _repoRoot = resolve(_here, '..', '..')

export interface Config {
  /** PA_MCP 项目根目录（含 venv/ 与 src/）。默认向上找同名目录。 */
  paMcpRoot?: string
  /** python 可执行（须能 `-m pa_mcp.server`）。默认 PA_MCP_ROOT/venv。 */
  pythonBin?: string
  /** 给暴露的工具加的前缀（避免与宿主工具撞名）。默认 'pa__'。 */
  toolPrefix?: string
  /** MCP 连接/单次调用超时(ms)。 */
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  paMcpRoot: z.string(),
  pythonBin: z.string(),
  toolPrefix: z.string(),
  timeoutMs: z.number().default(120_000),
})

interface PaMcpBridge {
  client: Client
  transport: StdioClientTransport
  close: () => Promise<void>
}

/** 探测 PA_MCP 根目录：config 指定 -> 环境变量 -> 仓库父级同名目录。 */
function resolvePaRoot(cfg: Config): string {
  if (cfg.paMcpRoot) return cfg.paMcpRoot
  if (process.env.PA_MCP_ROOT) return process.env.PA_MCP_ROOT
  // 仓库通常在 D:/Project/AI/pa-mcp-dsh-plugin，PA_MCP 在相邻 D:/Project/AI/PA_MCP/PA_MCP
  const sibling = resolve(_repoRoot, '..', 'PA_MCP', 'PA_MCP')
  return existsSync(join(sibling, 'venv')) ? sibling : _repoRoot
}

function resolvePython(root: string, cfg: Config): string {
  if (cfg.pythonBin) return cfg.pythonBin
  const win = join(root, 'venv', 'Scripts', 'python.exe')
  const posix = join(root, 'venv', 'bin', 'python')
  if (existsSync(win)) return win
  if (existsSync(posix)) return posix
  return 'python'
}

/**
 * 镜像 dsh `ctx.subprocess` 的 `scrubbedParentEnv()` 语义：子进程环境默认
 * **不继承**宿主里的凭据形变量(KEY/PASSWORD/SECRET/TOKEN)与 `DSH_*`/`dsh_*`
 * 保留字，防止 DEEPSEEK_API_KEY 等凭据泄漏进被 spawn 的 python 子进程。
 * 刻意不依赖 @deepseek-ai/dsh-subprocess 包(免得把整个 service 模块拖成
 * 运行时依赖)，语义对齐即可。
 */
function scrubbedEnv(): Record<string, string> {
  const sensitive = /KEY|PASSWORD|SECRET|TOKEN/i
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env as Record<string, string>)) {
    if (sensitive.test(k)) continue
    if (k.startsWith('DSH_') || k.startsWith('dsh_')) continue
    out[k] = v
  }
  return out
}

/** spawn PA_MCP 并建立 MCP 客户端连接。 */
async function spawnBridge(cfg: Config): Promise<PaMcpBridge> {
  const root = resolvePaRoot(cfg)
  const python = resolvePython(root, cfg)
  const transport = new StdioClientTransport({
    command: python,
    args: ['-m', 'pa_mcp.server'],
    cwd: root,
    // 沙箱卫生：从 scrubbed 环境起步，只显式放行运行 python 所需的少数变量
    env: { ...scrubbedEnv(), PYTHONIOENCODING: 'utf-8', PA_MCP_ROOT: root },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'pa-mcp-dsh-plugin', version: '0.1.0' })
  await client.connect(transport)
  return { client, transport, close: async () => { await client.close(); await transport.close() } }
}

/** 把 MCP 的 JSON Schema 参数对象转成 dsh 的 parameters 对象 DSL。 */
function toParameterDsl(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = (schema.properties ?? {}) as Record<string, any>
  const required = new Set((schema.required as string[]) ?? [])
  const out: Record<string, unknown> = {}
  for (const [field, spec] of Object.entries(properties)) {
    const p: Record<string, unknown> = {}
    if (typeof spec?.description === 'string') p.description = spec.description
    if (spec?.enum !== undefined) p.enum = spec.enum
    const t = typeof spec?.type === 'string' ? spec.type : ''
    switch (t) {
      case 'string': p.type = 'string'; break
      case 'integer': p.type = 'integer'; break
      case 'number': p.type = 'number'; break
      case 'boolean': p.type = 'boolean'; break
      default:
        // object/array/null/复合 schema —— dsh 的 schema 子集不接受裸 object(需
        // 显式 additionalProperties)。统一用 author-only 的 json 类型宽松放行，
        // 由远端 MCP(PA_MCP python)做真正的参数校验。
        p.type = 'json'
        break
    }
    if (required.has(field)) p.required = true
    if (spec?.default !== undefined) p.default = spec.default
    out[field] = p
  }
  return out
}

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const bridge = await spawnBridge(config)
  // 清理：宿主进程退出时由 OS 结束子进程；bridge 也提供 close 供必要时主动调用
  const prefix = config.toolPrefix ?? 'pa__'
  const { tools } = await bridge.client.listTools()

  for (const t of tools) {
    const publicName = `${prefix}${t.name}`
    ctx.tools.register(defineTool({
      name: publicName,
      description: `[PA_MCP] ${t.description ?? t.name}（转发到本地 PA_MCP python 进程执行）`,
      parameters: toParameterDsl(t.inputSchema as Record<string, unknown>) as never,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args) {
        const res = await bridge.client.callTool({ name: t.name, arguments: args as Record<string, unknown> })
        return mcpResultToJson(res)
      },    }))
  }

  ctx.logger?.info?.(
    `[pa-mcp-dsh-plugin] 已注册 ${tools.length} 个 PA_MCP 原生工具（前缀 ${prefix}），`
    + `连接 PA_MCP@${resolvePaRoot(config)}`,
  )
}

/** 把 MCP call 结果转成 dsh 工具必须返回的 Record<string, JsonValue>。 */
function mcpResultToJson(res: {
  content?: unknown
  structuredContent?: unknown
  toolResult?: unknown
  isError?: boolean
}): Record<string, JsonValue> {
  // 优先用结构化结果（已是 JSON）；退回解析 text
  let body: unknown = res.structuredContent
  if (body === undefined) body = res.toolResult
  if (body === undefined) {
    const text = extractText(res.content)
    body = text ? safeParse(text) : res.content
  }
  if (res.isError) {
    return { ok: false as JsonValue, error: String(body) as JsonValue }
  }
  return { ok: true as JsonValue, result: body as JsonValue }
}

function extractText(content: unknown): string {
  const arr = Array.isArray(content) ? content : []
  return arr
    .filter((c: any) => c?.type === 'text')
    .map((c: any) => c.text)
    .join('\n')
}

/** 尽力把字符串当 JSON 解析；失败原样返回字符串。 */
function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
