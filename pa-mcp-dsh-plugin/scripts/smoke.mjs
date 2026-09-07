#!/usr/bin/env node
/**
 * pa-mcp-dsh-plugin 冒烟测试（无 dsh / 无 LLM key，验证链路底层可用）
 *
 * 作用：spawn 一个真实的 PA_MCP python 进程(stdio MCP server)，用
 * @modelcontextprotocol/sdk 的 Client 连上：
 *   1. tools/list 断言工具数 >= 100（PA_MCP 当前 111）；
 *   2. tools/call 调用一个只读本地工具(list_strategies)断言 isError === false。
 *
 * 这等价于插件 execute 的核心转发逻辑，是 CI/本地「PA_MCP 改动后冒烟」的入口。
 * 任一步失败则以非 0 退出（供 CI 判定）。
 *
 * 用法：
 *   node scripts/smoke.mjs [paMcpRoot] [pythonBin]
 *   env: PA_MCP_ROOT / PYTHON_BIN 亦可
 */
import { dirname, join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

function resolvePaRoot(argv) {
  if (argv[0]) return argv[0]
  if (process.env.PA_MCP_ROOT) return process.env.PA_MCP_ROOT
  const sibling = resolve(repoRoot, '..', 'PA_MCP', 'PA_MCP')
  return existsSync(join(sibling, 'venv')) ? sibling : repoRoot
}
function resolvePython(root, argv) {
  if (argv[1]) return argv[1]
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN
  const win = join(root, 'venv', 'Scripts', 'python.exe')
  const posix = join(root, 'venv', 'bin', 'python')
  if (existsSync(win)) return win
  if (existsSync(posix)) return posix
  return 'python'
}

const fail = (msg) => { console.error(`[smoke] ✗ ${msg}`); process.exit(1) }
const ok = (msg) => console.log(`[smoke] ✓ ${msg}`)

const MIN_TOOLS = 100
const PROBE_TOOL = 'list_strategies'

async function main() {
  const root = resolvePaRoot(process.argv.slice(2))
  const python = resolvePython(root, process.argv.slice(2))
  console.log(`[smoke] root=${root}`)
  console.log(`[smoke] python=${python}`)

  const transport = new StdioClientTransport({
    command: python,
    args: ['-m', 'pa_mcp.server'],
    cwd: root,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PA_MCP_ROOT: root },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'pa-mcp-dsh-plugin-smoke', version: '0.0.0' })
  await client.connect(transport)

  const { tools } = await client.listTools()
  if (tools.length < MIN_TOOLS) fail(`tools/list 仅 ${tools.length} 个工具（期望 >=${MIN_TOOLS}）`)
  ok(`tools/list 返回 ${tools.length} 个工具（>=${MIN_TOOLS}）`)

  const probe = tools.find((t) => t.name === PROBE_TOOL)
  if (!probe) fail(`未发现探测工具 ${PROBE_TOOL}`)
  ok(`探测工具 ${PROBE_TOOL} 存在，schema=${JSON.stringify(probe.inputSchema)}`)

  const res = await client.callTool({ name: PROBE_TOOL, arguments: {} })
  if (res.isError) fail(`${PROBE_TOOL} 返回 isError=true：${JSON.stringify(res.content)}`)
  ok(`${PROBE_TOOL} 调用成功（isError=false），content 长度 ${JSON.stringify(res.content).length}`)

  await client.close()
  console.log('[smoke] ✅ 全部通过：PA_MCP 可被 MCP 客户端 spawn+list+call')
  process.exit(0)
}

main().catch((e) => fail(e.stack || e.message))
