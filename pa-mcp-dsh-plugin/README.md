# pa-mcp-dsh-plugin

把 **PA_MCP**（纯 Python 全栈 A 股量化 MCP server，111 个工具）以 **dsh（DeepSeek Harness）原生插件** 的形式接入，让 Harness 的 agent 用**原生工具调用**消费同一个 Python 量化数据层。

> 一句话架构：**插件是一个"PA_MCP 客户端壳"**。它 spawn 一个常驻的 PA_MCP python 进程（stdio MCP server），启动时用 MCP `tools/list` **自动发现全部工具并逐个 `ctx.tools.register` 成原生工具**，agent 调用时经 MCP `tools/call` 转发回 python 执行。

```
dsh agent / headless
        │  ctx.tools(111 个原生工具 pa__*)
        ▼
pa-mcp-dsh-plugin (src/index.ts)
        │  启动: spawn + tools/list 自动发现
        │  调用: tools/call 转发
        ▼
python -m pa_mcp.server   （常驻 stdio 子进程）
        │
        ▼
PA_MCP 全部业务：行情/自选/回测/策略/风控……（111 工具，唯一事实来源）
```

---

## 为什么是这个形态（你选定的方向）

你要求「改 PA_MCP 就要同步改 dsh 插件仓库」。三选一时你定了：

- ✅ **插件壳 + 自动发现工具**：插件**不手写任何工具定义**，启动时动态读 PA_MCP 的 `tools/list` 把全部工具注册出来。
- ✅ **独立 git 仓库**：插件独立成仓（本仓库），PA_MCP 是它的数据层依赖（运行时通过 `paMcpRoot` 指向本地路径）。

于是维护契约变成：**改 PA_MCP 只改 python 侧 → 插件下次启动自动发现新工具 → 零手动同步**。工具签名、参数、数量变了，插件都不需要改。

---

## 快速自测（验证链路，无需 dsh / LLM key）

三个独立环节都已实测，你可以按序复验：

**① PA_MCP 本身可被 stdio MCP 客户端调用**（最底层前提）：
```bash
cd D:/Project/AI/pa-mcp-dsh-plugin
D:/Project/AI/PA_MCP/PA_MCP/venv/Scripts/python.exe -m pa_mcp.server   # 手动起一个，Ctrl+C 停
```
用任意 MCP 客户端连上去 `tools/list` 应返回 **111 个工具**、每个带完整 `inputSchema`。

**② 插件的 execute 转发逻辑**（等价于 agent 调用一个只读工具）：见 `examples/` 或下方"实机装配"。核心是 `execute(args) -> mcpClient.callTool({name, args}) -> 还原 JsonValue`。

**③ 实机装配进 dsh（见下）**，验证 111 个工具自动注册进 `ctx.tools`。

---

## 目录结构

```
pa-mcp-dsh-plugin/
├── src/index.ts           # Cordis 插件壳：spawn PA_MCP + 自动发现 + 逐工具注册 + 转发
├── scripts/smoke.mjs      # 无 dsh/无 key 冒烟：spawn PA_MCP→list≥100 工具→call list_strategies
├── package.json           # type:module；deps: @modelcontextprotocol/sdk；peer: dsh-tools/cordis/schemastery
├── tsconfig.json
├── lib/                   # tsc 编译产物（gitignore；clone 后 npm run build）
├── examples/
│   ├── e2e-headless.patch.yml         # 把插件插入 dsh headless profile 的装配样例
│   └── notify-plugin-from-pamcp.yml   # [放 PA_MCP 仓库] push 后通知本插件仓跑冒烟
├── .github/workflows/smoke.yml        # CI：装 python+PA_MCP、node+插件、跑冒烟
└── README.md
```

---

## 插件做了什么（`src/index.ts`）

插件只有命名导出（`name` / `inject` / `Config` / `apply`），**无 default export**（这是 cordis 的红线，见"踩坑"）。

```ts
export const name = 'pa-mcp-dsh-plugin'
export const inject = ['tools']          // 声明要用 ctx.tools（cordis 等它就绪）

export async function apply(ctx, config) {
  const bridge = await spawnPaMcp(config)        // spawn python -m pa_mcp.server + MCP Client 连接
  const { tools } = await bridge.client.listTools()   // 自动发现全部工具 + JSON schema
  for (const t of tools) {
    ctx.tools.register(defineTool({
      name: `pa__${t.name}`,                       // 加前缀防撞名
      description: `[PA_MCP] ${t.description}`,
      parameters: toParameterDsl(t.inputSchema),   // MCP JSON schema → dsh 参数 DSL
      output: { schema: { type: 'object', additionalProperties: true }, render: text },
      async execute(args) {
        const res = await bridge.client.callTool({ name: t.name, arguments: args })
        return mcpResultToJson(res)                // 还原成 {ok,result|error}
      },
    }))
  }
}
```

关键点：

- **schema 映射**：PA_MCP 111 个工具里，110 个参数是纯标量/枚举（string/integer/number/boolean），直接映射；只有 `agent_plan_update` 的参数是嵌套 object，dsh 的 schema 子集不接受裸 object（要求显式 `additionalProperties`），故对 object/array/复合统一映射为 dsh 的 **`json` 类型**（宽松放行，真正的参数校验交给远端 PA_MCP python 做）。
- **生命周期**：PA_MCP 子进程随插件存活；宿主退出时由 OS 回收子进程。`bridge.close()` 也暴露，供需要主动关闭的场景调用。
- **结果还原**：优先用 MCP 返回的 `structuredContent`（已是 JSON），退回解析 `content` 里的 text。

---

## 实机装配 & 测试（需要 dsh CLI）

### 前置
1. 本机装了 dsh CLI（样例在 `/tmp/dsh-host`：`npm install @deepseek-ai/dsh@0.1.2-rc.1`）。
2. 插件已编译：`cd pa-mcp-dsh-plugin && npm install && npm run build`（产出 `lib/src/index.js`）。
3. PA_MCP 在本地（含 `venv/`，能 `python -m pa_mcp.server`）。

### 第 1 步：确认插件进组合树（无需 LLM）
```bash
dsh --profile headless --patch examples/e2e-headless.patch.yml --dump-config \
  | grep -n "pa-mcp-dsh\|pa__"
```
组合树里应有 `pa-mcp-dsh` 行。

### 第 2 步：无 key 探测（确认工具注册成功）
```bash
dsh --profile headless --patch examples/e2e-headless.patch.yml "用 pa__list_strategies 列出策略"
```
若输出**只**是 `MISSING_CREDENTIAL: no API key`、且**没有** `plugin tree failed to load` 或 schema 错误，说明插件已干净加载、PA_MCP 已 spawn、111 个工具已成功注册进 `ctx.tools`（任何注册失败都会在此时报错）。

### 第 3 步：真实 agent 调用（需要 `DEEPSEEK_API_KEY`）
```bash
export DEEPSEEK_API_KEY=sk-...
dsh --profile headless --patch examples/e2e-headless.patch.yml "用 pa__list_strategies 列出策略"
```
agent 应选中 `pa__list_strategies`、发起调用，并返回 PA_MCP 的真实策略列表（`ok:true, result:[...]`）。换成 `"查 pa__get_realtime_quote 600519"` 可验证行情类工具。

> headless agent 用 deepseek-official 路由，与 dsh 内置工具走同一个凭据门槛；配好 key 即可跑通最后一步。

---

## 实测验证记录（真实 dsh host + 真实 PA_MCP）

已实测到「111 工具自动注册」这一档：

| 环节 | 状态 |
|------|------|
| python MCP 客户端连 PA_MCP → `tools/list` 拿 111 工具（含完整 schema） | ✅ |
| 同一客户端 `tools/call` 调 `list_strategies` / `get_stock_name` 返回真实数据 | ✅ |
| 插件对真实 `dsh-tools`/`cordis`/`schemastery` + `@modelcontextprotocol/sdk` 做 `tsc` | ✅ 0 错误 |
| dsh host 加载插件 → spawn PA_MCP → 111 工具注册进 `ctx.tools`（无 schema 错、只差 LLM key） | ✅ |
| 插件 execute 转发逻辑独立探针（MCP callTool → 真实数据） | ✅ |
| `scripts/smoke.mjs`（spawn→list≥100→call list_strategies） | ✅ 本地跑通 |
| agent 实际用 LLM 选中并调用一次工具 | 🔶 需 `DEEPSEEK_API_KEY` |

过程中发现并修复/规避的问题（沉淀）：

1. **无 `export default apply`**：cordis 对 default export 会用 `new` 实例化，丢失 `inject` 元数据 → 报 `cannot get property "tools" without inject`。插件只用命名导出。
2. **嵌套 object 参数 schema**：dsh schema 子集不接受裸 `{type:'object'}`（要求显式 `additionalProperties`），`agent_plan_update` 的 `plan` 参数会因此注册失败。对 object/array/复合统一映射为 `json` 类型放行。
3. **execute 返回值必须是 `Record<string, JsonValue>`**：不能用 `{ ok, error?: undefined }` 这类带 `undefined` 成员的联合（MCP SDK 返回有 `toolResult` 变体，需兼容 `content`/`structuredContent`/`toolResult` 三种）。

---

## 安装 & 装配（两种方式）

### 方式 A：本地开发引用（file:// URL，最快迭代）
`examples/e2e-headless.patch.yml` 就是这种：patch 的 `name` 用 **`file://` URL 指向编译产物** `lib/src/index.js`，配合 `config.paMcpRoot` 指到本地 PA_MCP。适合改插件源码时反复重载调试。

### 方式 B：打包成正式 npm 插件（生产）
插件已可按标准 npm 包安装，供 profile 用**包名**引用：

```bash
# 在插件仓库内：打包（prepack 会自动 build）
npm pack                 # 产出 pa-mcp-dsh-plugin-0.1.0.tgz

# 在装 dsh 的宿主里装进你的 profile 依赖目录（示例）
npm install ./pa-mcp-dsh-plugin-0.1.0.tgz
```

然后在你的 profile patch 里用**包名**（而非 file:// 路径）引用：
```yaml
- insert:
    - id: pa-mcp-dsh
      name: pa-mcp-dsh-plugin        # 包名，npm 从 node_modules 解析
      config:
        paMcpRoot: 'D:/Project/AI/PA_MCP/PA_MCP'
```

`npm pack --dry-run` 应确认 tarball 含：`lib/src/index.js` + `lib/src/index.d.ts` + `package.json` + `README.md` + `examples/`（`files` 白名单控制，`node_modules`/`lib` 之外的源码不入包）。运行时依赖 `@modelcontextprotocol/sdk` 会随包声明被装上；`@deepseek-ai/dsh-tools`/`cordis`/`schemastery` 是 **peerDependencies**，由宿主 dsh 提供。

> 发布到私有 registry 后，用户 profile 直接 `name: pa-mcp-dsh-plugin@^0.1` 即可，无需本地 tarball。

---

## 踩坑 & 注意（dsh v0.1 特有）

- **Windows 装配 path 要用 `file://` URL**，且指向编译产物 `lib/src/index.js`（目录 import 不被 ESM 支持）。
- **别用裸 cordis 手搓最小 host 复刻 `ctx.tools`**（实测 `ctx.tools` 在独立装配里是 undefined）——`ctx.tools` 只在完整 dsh agent/host 栈里被正确装配，测试要走 dsh CLI。
- `node_modules/` 与 `lib/` 已 gitignore；clone 后需 `npm install && npm run build` 才有 `lib/`。
- **凭据卫生**：`src/index.ts` 的 spawn 已对子进程环境做 scrub（丢弃 `*KEY*/*PASSWORD*/*SECRET*/*TOKEN*` 与 `DSH_*`/`dsh_*`），对齐 dsh `ctx.subprocess` 的 `scrubbedParentEnv()` 语义——避免 `DEEPSEEK_API_KEY` 等凭据泄漏进被 spawn 的 python 进程。
- **更深的沙箱（可选硬化，未默认启用）**：dsh 提供 `ctx.subprocess`（base profile 已含 `dsh-subprocess-local`，row `id: subprocess`），`spawn({argv,cwd,stdio,graceMs,signal,env})` 返回带**原始 stdin/stdout 管道 + 整树级 `terminate()`/abort** 的句柄，且环境自动 scrub。把它接进来需要给 MCP 写一个自定义 `Transport`（把 `ctx.subprocess` 的原始管道喂给 `@modelcontextprotocol/sdk` 的 Client，SDK 自带 `StdioClientTransport` 不接受外部已起好的子进程）并把 `'subprocess'` 加进 `inject`。本插件当前用 MCP SDK 自带 spawn + 本地 scrub（够用、风险低）；若你需要整树强杀与纳入 harness 沙箱执行世界，这是明确的下一步（API 已探明）。

---

## CI 冒烟（改 PA_MCP 自动校验插件兼容）

核心入口是一个**无 dsh / 无 LLM key** 的 node 冒烟脚本：spawn 真实 PA_MCP → `tools/list` 断言 ≥100 个工具 → `tools/call` 调 `list_strategies` 断言成功。任一步失败即以非 0 退出。

```bash
# 本地一键（自动找 PA_MCP 兄弟目录 + venv python）
cd pa-mcp-dsh-plugin
node scripts/smoke.mjs
# 或显式指定：node scripts/smoke.mjs <PA_MCP根> <python>（env: PA_MCP_ROOT / PYTHON_BIN）
```

**两种 CI 触发方式**（`.github/workflows/smoke.yml` 已内置，均在 ubuntu 上装 python3.12 的 PA_MCP + node 的插件 + 跑冒烟）：

1. **本仓库 push/PR**：每次改插件自身就跑一次冒烟（PA_MCP 分支用 `vars.PA_MCP_REPO` / `vars.PA_MCP_BRANCH` 指定，默认同机构同名 `PA_MCP`@main）。
2. **PA_MCP 推送触发**：把 `examples/notify-plugin-from-pamcp.yml` 拷进 **PA_MCP 仓库**的 `.github/workflows/`，并在 PA_MCP 侧配 `PLUGIN_REPO`(如 `owner/pa-mcp-dsh-plugin`) + `PLUGIN_REPO_TOKEN`(有插件仓写权限的 PAT)。这样 PA_MCP 每次 push 都会让插件仓自动冒烟 → **"改 PA_MCP"与"验插件兼容"联动**。

> 注意：smoke 是**兼容性**冒烟，验证 PA_MCP 仍可被 MCP spawn+list+call；它不覆盖 PA_MCP 自身业务正确性（那属 PA_MCP 的测试）。PA_MCP 若工具数<100 或改名破坏 `list_strategies`，会红，提醒你检查插件侧命名/前缀是否需同步。

---

## 维护契约（回应你的核心诉求）

| 你在 PA_MCP 改了什么 | 需要动本插件吗 |
|----------------------|----------------|
| 加/删/改一个工具的**签名/参数** | ❌ 不用——重启插件自动重新发现 |
| 改工具的**业务逻辑**（python 侧） | ❌ 不用 |
| 改/加 python **依赖** | 需在 PA_MCP 的 venv 里装好即可，插件不动 |
| 改插件**自身行为**（前缀/超时/spawn 方式） | ✅ 才需要动 `src/index.ts` |

所以日常迭代 PA_MCP 时，本插件仓库基本是**只读的**；只有当你改了"桥接策略"（命名、超时、是否需要沙箱、长驻 vs 每次拉起）才回来改它。
