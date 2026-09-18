# pix 重构方案

> 状态：目标进程/包边界保留；生命周期行为与验收正在重新评估
> 2026-09-10 生命周期实施入口：[lifecycle-reassessment.md](./lifecycle-reassessment.md)，当前验证与发布状态以 [refactor-execution-plan.md](./refactor-execution-plan.md) 为准。Vite/Hono、独立 sessiond、每会话 Worker、SDK Adapter 与 JSONL/WS 边界不变。本文保留的早期 v1 握手示例仅为历史设计说明；当前版本、分页与投影必须服从代码中的单一 owner 和本文件对应现行契约。
> 当前仓库：`pix`（独立产品仓库，不继承旧 Next.js 产品树）
> 主线：先交付可启动的新架构应用，再完成 Runtime vertical slice，之后扩展到 PWA 跨端
> 桌面原生壳：仅预留，当前不交付
> 任务认领、进度看板、文件所有权和协作规则：[`refactor-execution-plan.md`](./refactor-execution-plan.md)

## 1. 目标

将 pix 从「Next.js 进程内嵌 AgentSession」重构为「协议中心的本机 Agent 工作站」：

- Web 进程可随时重启，**不杀死**正在运行的会话
- 一份 Client，支持浏览器 / 安装式 PWA（电脑 + 手机）
- 与 pi CLI 共存：`jsonl` / `~/.pi` 仍是真相源
- 为以后桌面客户端（Tauri sidecar）预留同一 Host/协议，但现阶段不做壳

## 2. 一句话定案

**Vite + React + TanStack（Client） + Hono 薄 Web/API + 独立 `pix-sessiond` + 每会话 Worker + Agent Runtime Port + Pi 防腐层 + WebSocket + SQLite 索引**

## 3. 目标架构

```
Browser / 安装式 PWA（桌面 + 手机主入口）
        │
Web 进程（可随时重启）
  Vite 静态资源
  Hono：门禁 · HTTP API · WS 网关 · 文件/git
        │  本机 IPC / localhost RPC
        ▼
pix-sessiond（常驻守护进程，会话权威）
  会话注册表 · Worker 调度 · 事件总线 · 空闲回收
        │
agent-worker × N（每会话一个进程，承载应用运行时）
        │  AgentRuntimePort（pix 自有语义）
        ▼
Pi 防腐层（ACL）
  ├─ PiSdkAdapter（当前：@earendil-works/pi-*）
  └─ PiRpcAdapter（未来：pi --mode rpc）
```

| 进程/模块 | 职责 | 重启影响 |
|------|------|----------|
| **Web** | UI、HTTP、WS 网关、门禁、文件/git | 可重启；客户端重连即可 |
| **pix-sessiond** | Runtime/Worker 的唯一生命周期权威 | **不**随 Web 退出 |
| **agent-worker** | 单会话应用运行时、Protocol ↔ Runtime Core 映射、承载后端 Adapter | 仅会话结束 / 空闲回收 / 显式停止时退出 |
| **Pi ACL** | 将 pix 自有 Port 翻译为 Pi SDK 或 Pi RPC；归一化事件、错误、工具与资源 | Adapter 可替换；上层协议和业务保持稳定 |

### 硬规则

1. `pix` 是独立产品仓库；旧 Next.js 单体只作为迁移来源，不是运行时、构建时或发布依赖
2. `pix` 从第一天起不存在 Next.js 产品路径；不迁入根 `app/`、Next Route Handlers、`next.config.*`、Next CLI 或 `.next`
3. UI、Host、sessiond 和 Worker Controller **永不**直接 import pi SDK，也不解析 Pi RPC 原始帧
4. `packages/runtime-core` 定义 pix 自有的 Runtime/Resource Ports 和规范化模型；它不依赖 Protocol、Pi SDK 或 Pi RPC
5. `packages/pi-sdk-adapter` 是当前 Pi SDK 防腐层，也是唯一可 import `@earendil-works/pi-*` 的包
6. 未来的 `packages/pi-rpc-adapter` 是 Pi RPC 防腐层，也是唯一可启动/解析 `pi --mode rpc` 的包
7. Protocol 是进程/网络边界；Runtime Port 是进程内应用边界；两者通过显式 Mapper 转换，不共享同一个类型作为捷径
8. `pix-sessiond` 是 Session **唯一权威**；Web 只做代理与附着（attach）
9. 只读浏览历史 → **0 Worker**（含 `SessionCatalogPort.readSessionTree` 的分支树投影：纯持久化 JSONL 只读投影，0 Worker，不激活 runtime）

### 会话分支树（BranchNavigator 切片）冻结语义

- `SessionCatalogPort.readSessionTree(sessionId)` 返回规范化 `SessionTree`：节点仅携带 entryId、父子链接、规范化 kind（`user|assistant|toolResult|bashExecution|custom|system`）与安全截断的单行预览 label（≤40 码元，含脱敏）；线性链压缩进 `skippedEntryIds`，仅保留根/分叉点/叶子。绝不暴露 SDK TreeNode、raw path、raw message、thinking/tool 原文。
- `currentLeafId` 是**持久化目录头**（无 leafId 的 `sessions.context` 所解析的同一叶子）；live 运行时的内存 navigate 叶子可能尚未落盘，树**不伪造持久化**：live 模式活动叶子以 runtime snapshot（`RuntimeState.leafId`）为准覆盖，history 模式用 selected context leaf。该语义已在 runtime-core/protocol DTO 与 Client 助手中冻结。
- 链路：adapter 纯投影器（复用同一 list 缓存/revision fence/openSession 身份校验）→ sessiond `sessions.tree` RPC → Host `GET /v1/sessions/:id/tree`（`sessions` capability，无新 token，拒绝任何 query）→ Client typed query（key 按 sessionId 隔离）。

### 会话历史完整轻量读取（source-parity contract）

- `sessions.context` 未提供 `limit` 时返回 selected persisted branch 的**完整 projected entries**；显式 `limit/before` 继续作为有限兼容分页面。完整读取仍是 JSONL 只读投影、0 Worker，`pageInfo.hasMore=false`。
- Client 默认发送 `deferThinking=1&deferMedia=1`：非空 assistant thinking 只携带 `{thinking:"", deferred:true}`；toolResult 中 base64 图片从首包移除并替换为包含数量、MIME 与近似解码字节数的诚实文本摘要。URL 图片与 user/assistant 图片不被该规则改写。
- deferred thinking 只能通过 exact `(sessionId, entryId, blockIndex)` 读取；未知 session/entry、错误 role/block type 一律 `not_found`，禁止按文本、顺序或相邻 block 猜测。
- Client session selection 立即提交 URL，不等待历史 body；Transcript subtree 按 session identity remount，Query key 绑定 `(sessionId, historyGeneration, anchor)`，迟到的 A 响应不能投影到 B。完整 branch 到达后只显示最后 50 个 rendered rows，向上每次仅在本地再 reveal 50，不发隐藏历史请求。
- 历史 JSON、Vite JS 与 CSS 由 Host 原生压缩中间件按 `Accept-Encoding` 压缩；206、已编码、SSE、图片与 binary 不进入该压缩面。
- 任意单个 deferred media 即使超过 RPC frame 上限，也必须在 adapter 投影阶段被移除；不得提高 sessiond frame/queue/timeout 来容纳它。重文本导致完整轻量响应仍超过既有 frame 上限时诚实失败，不伪装截断或成功。

### Materialized Catalog 分页契约

- Projects 与 Sessions 是两个独立资源：共享一个 JSONL-authoritative、SQLite-disposable Catalog Indexer，但拥有独立 Port/RPC/HTTP DTO、Query key和加载状态。项目列表绝不从当前 Session 页推断。
- Wire/Host仍使用 one-based `page/pageSize/total/totalPages` 真分页；Client不展示页码、上一页或下一页，而以“查看更多”渐进追加。每次显式点击只请求该资源的恰好下一页，禁止后台自动补页、跨资源推进或“找下一个项目”。Projects=10/次；最近会话与项目内会话均为5/次，是当前 Client 固定值。
- Index ready 后任一 page query必须是 indexed SQLite read：0 readdir、0 lstat、0 JSONL read、0 Git spawn；全量 identity reconcile仅允许在daemon启动、后台周期scrub、watch gap/损坏恢复。已知索引不可用时fail closed，不在请求路径回退全扫描。
- `session_projection`物化session browse identity/排序键；`project_projection`物化projectRoot/sessionCount/latestActivity。过滤/分组/total先于slice；sessions稳定序为activity DESC + sessionId binary ASC，projects为latestActivity DESC + projectRoot binary ASC。当前临时可见性策略把所有带原生 `parentSession` lineage 或 `pix-fork-provenance.parentSessionId` 的 child/subagent/fork 在索引阶段归为 hidden，因此不进入Sessions/Projects items、totals或分页；exact deep-link detail仍是独立读取，不反插browse列表。
- JSONL始终真相源。Pix mutation与exact file watch增量更新对应row/project summary；SQLite可删除重建。Host仍只拥有AllowedRoots workspaceAccess分类，不改变catalog membership/total。
- Deep-link exact detail和未持久化new-session identity在page之外显示/缓存，绝不插入authoritative page或伪造total。

10. 实时状态只走 **WebSocket + snapshot/resume**，不用轮询冒充
11. `jsonl` / `~/.pi` 仍是真相源
12. 对外 Client/Host 只认 Protocol；进程内应用服务只认 Runtime/Resource Ports；按 **capabilities** 降级
13. Web 退出/崩溃：**不**终止 sessiond，不杀 worker
14. capability 只声明已经完整接通并验证的能力
15. Session catalog 可见性不是工作区授权。Host AllowedRoots 是路径安全权威；session list/detail 的 additive `workspaceAccess`（`authorized | history_only | unavailable`）由 Host 分类，Protocol 只做严格投影。缺字段是 unknown legacy，不得猜测为 `authorized`。history-only 可读 JSONL，但不得因此展示 models/files/skills/write/send，也不得自动扩根。Client 以 HTTP session header/detail 为权威，对现有选中会话 fail-closed（history_only/unavailable/unknown 零 controller admission）。**Phase 6 已落地并获 Fresh GLM verifier PASS。**
16. Daemon/Worker 复用不能只比较 protocol major。Protocol build contract 是 product/sessiond/Worker/adapter contract generation + current capability/IPC vocabulary fingerprint 的唯一 owner；missing/malformed/mismatch 均不得静默复用。普通 CLI start/ensure 遇到不兼容的存活 daemon 必须保留实例并报告维护需求，不自动 shutdown；显式维护关闭须走 authenticated instance-fenced RPC，不能以 PID/SIGTERM 代替。sessiond/Worker 双方在创建 runtime、rekey、projection、dispatch 前互验 build。历史 Phase 7A 验证与本轮维护条件分别见 ledger 和 lifecycle-reassessment §7。
17. Session revision 不得混域：live revision 是 same-epoch `(epoch,eventId)`，跨 epoch永不排序；persisted branch fence只做 `leafId` equality；turn status revision仍是 per-turn sequence。已提供 `operationId/turnId/userEntryId/finalLeafId` 时 optimistic/history必须按 identity对账，禁止文本/FIFO猜测；navigate/compact的 authoritative `session_changed` 走 regular adapter event channel并由 sessiond journal加 cursor。**Phase 5A 已落地并通过独立 verifier + Runtime E2E；Phase 5B strict quiescent whole-epoch rollover已获 Fresh DeepSeek verifier PASS（§88）。**
18. Epoch容量只能整体旋转，禁止单ID eviction、提高上限或重启Worker伪装修复。rotation必须由sessiond与Worker双重证明严格idle，触发请求在admission前保持零dispatch；exact rotate ack后原子切换epoch/journal/cursor0并清整组per-epoch ledgers，再向现有attach推`epoch_changed` snapshot。old/missing epoch零副作用；ack不确定/commit失权必须关闭live record，绝不在sessiond/Worker epoch分裂时继续服务。

### 发送模型意图与多客户端

- 同一 session 的多个 TAB 共享 sessiond 的一个 Worker 和执行模型。每个 TAB 的未发送选择由本地、有界、按 session 分组的 staging owner 管理，不能写入权威快照。
- 协商 `runtime.submit-turn.v1` 后，发送捕获当时输入框显示的已知模型，并通过同一次 `activationOverrides` 交给原子受理事务。显示模型来自历史或当前实时快照时同样适用；已知不可变且完全相同的实时模型可省略冗余设置，显式不支持的选择必须失败，不能静默换模型。
- 接受受理与接回观察之间，模型显示可使用 exact SessionController 已确认的 admission snapshot；可见资格随原发送的 presentation provenance、history generation 和会话生命周期失效，不能另建已受理模型缓存，也不能按模型值猜测历史新旧。权威观察接管后沿用正常共享投影。staging 清理只能消费发送时捕获的记录 revision，迟到回执不能清掉新选择。
- Adapter 在每个 runtime 内将普通模型/思考变更与 turn admission 互斥；进行中冲突返回 `session_busy`。互斥只覆盖设置及受理，不阻塞 interrupt/stop，也不阻塞另一会话。已有会话恢复模型复用 SDK 的 session-context 语义，不能将全局默认当作显式选择覆盖持久会话。
- 验收同时覆盖确定性的迟到回执、会话切换与互斥测试，以及同一 Chrome profile 下的两个真实 TAB。实际 provider 请求的模型与发送前显示模型一致；同会话只有一个 Worker，不同会话可以并行。单 TAB 或只看 admission snapshot 不足以证明实际执行模型。

### Pi 防腐层（ACL）

Pi ACL 使用 Port/Adapter 结构隔离 Pi 的接入方式：

```text
pix Runtime Protocol（跨进程/网络 DTO）
      │  Protocol Mapper
      ▼
agent-worker application controller
      │
      ▼
Runtime Core：AgentRuntimeFactory / AgentRuntimePort
      │
      ├─ PiSdkAdapter ──▶ AgentSession / Pi SDK events
      └─ PiRpcAdapter ──▶ pi --mode rpc / JSONL frames（未来）
```

防腐层对上层暴露以下窄 Port（命名在实现前通过 `ACL0` 最终冻结）：

```text
AgentRuntimeFactory / AgentRuntimePort   # 单会话命令、事件、状态、停止
SessionCatalogPort / SessionLocatorPort  # list/resolve/read/context/tree 和激活定位
ModelCatalogPort                         # 模型、默认值、thinking 能力
CredentialStorePort                      # provider auth，不暴露原始 credential
ResourceCatalogPort                      # skills/plugins/commands
ProjectTrustPort                         # 项目信任与资源 reload 边界
ThemeCatalogPort                         # 只读主题目录（builtin/global/trusted project → CSS vars）
```

各进程只注入自己需要的 Port：

- Worker：`AgentRuntimeFactory`
- sessiond：`SessionLocatorPort`
- Host：`SessionCatalogPort`、`ModelCatalogPort`、`CredentialStorePort`、`ResourceCatalogPort`、`ProjectTrustPort`、`ThemeCatalogPort`

防腐层负责：

- SDK/RPC 命令、事件、错误、模型、工具名和参数到 pix 规范模型的双向翻译
- `AgentSession`、SDK `Model`、SDK Event、Pi RPC method/frame 等外部类型的封装
- SDK/RPC 能力差异的 capability 投影；上层只处理规范化的 `UNSUPPORTED_CAPABILITY`
- session id/file、extension UI、tool result、usage、thinking、compaction、fork 等语义归一化
- 为 Runtime、历史会话、模型/认证、插件/技能提供窄 Port，避免 Host/sessiond 直接依赖 Pi 类

Adapter 选择只发生在各进程的 composition root。当前所有 Port 默认由 SDK/文件系统 Adapter 实现；未来可以只把 Agent Runtime 切到 RPC，其他 Port 继续使用现有实现：

```text
PIX_AGENT_BACKEND=sdk   # 当前默认：PiSdkAgentRuntimeAdapter
PIX_AGENT_BACKEND=rpc   # 未来：PiRpcAgentRuntimeAdapter
```

sessiond、Host、Client、pix Runtime Protocol 和应用服务不得出现 `if (backend === "sdk")` 之类的供应商分支。Adapter 的 capability 决定可用功能。

### Port 形态（伪代码）

`runtime-core` 中的接口表达 pix 需要什么，不表达 Pi SDK/RPC 怎么提供：

```ts
interface AgentRuntimeFactory {
  create(input: RuntimeStartInput): Promise<AgentRuntimePort>;
  open(input: RuntimeOpenInput): Promise<AgentRuntimePort>;
}

interface AgentRuntimePort {
  readonly identity: RuntimeIdentity;
  getCapabilities(): RuntimeCapabilitySet;
  getSnapshot(): Promise<RuntimeState>;
  subscribe(listener: (event: RuntimeEvent) => void): () => void;
  execute(command: RuntimeCommand): Promise<RuntimeCommandResult>;
  interrupt(command: RuntimeInterrupt): Promise<void>;
  close(reason: RuntimeCloseReason): Promise<void>;
}
```

设计约束：

- `RuntimeCommand`、`RuntimeEvent`、`RuntimeState` 是 Runtime Core Model，与 Protocol DTO 分开
- `interrupt` 是独立控制通道，保证 abort 类操作不被 prompt/bash/compact 长操作阻塞
- `close` 使用规范化 reason；Adapter 负责映射 SDK shutdown 或 RPC process termination
- Port 只承诺规范语义；后端能力差异通过 capability 和规范错误返回
- SDK/RPC 原始对象只在 Adapter 内存活，不能存入 sessiond registry、Protocol event journal 或 Host cache

`pi-sdk-adapter` 使用子路径导出隔离不同进程的依赖：

```text
@fffattiger/pix-pi-sdk-adapter/agent      # Worker composition root
@fffattiger/pix-pi-sdk-adapter/sessions   # Host/session locator/catalog
@fffattiger/pix-pi-sdk-adapter/models     # Host model application service
@fffattiger/pix-pi-sdk-adapter/resources  # Host skills/plugins/trust service
@fffattiger/pix-pi-sdk-adapter/themes     # Host 只读主题目录（builtin/global/project JSON 解析）
```

各子路径不得通过聚合 barrel 提前加载其它 Adapter。未来 `pi-rpc-adapter` 可以先只实现 `/agent`，其余 Port 继续注入现有 SDK/文件系统实现，实现按 Port 渐进替换。

## 4. 技术选型

| 层 | 选型 | 说明 |
|----|------|------|
| 当前交付 | **PWA 跨端** | 本机 loopback + 局域网连 Host |
| 页面 | **Vite + React 19** | 无 SSR |
| 前端工程 | **TanStack Router / Query / Virtual** | 路由、HTTP 资源缓存、长列表 |
| 客户端连接全局状态 | **RuntimeConnection** | 唯一 RuntimeSocket owner；handshake/features/global running/create wire/attempt routing；不拥有 semantic lease/attached business state |
| 客户端会话运行时状态 | **SessionController（exact-session owner）+ SessionControllerRegistry（bounded registry/one lease owner）** | controller 固定 sessionId 并独立保留 cursor/reducer/lanes；registry 拥有 exact admission/max32 LRU/create reservation/one attachment lease；React 只消费 exact/connection hooks，不走 Query 轮询 |
| Web/API | **Hono（Node 22）** | 薄网关，不持有会话权威状态 |
| 会话管理 | **独立 `pix-sessiond`** | 与 Web 进程解耦，保证会话保活 |
| Agent 运行时 | **每会话 child_process Worker** | 崩溃隔离、可回收、并发上限可配 |
| Runtime 应用边界 | **`AgentRuntimePort`** | pix 自有命令、状态、事件和错误语义 |
| Pi 接入 | **防腐层 + Adapter** | 当前 `PiSdkAdapter`；未来可加 `PiRpcAdapter`，上层不变 |
| Runtime 线协议 | **pix Runtime Protocol** | 版本以 `packages/protocol/src/version.ts` 为准；产品命令、事件、snapshot/resume，不表达 SDK/RPC 类型 |
| 实时通道 | **WebSocket 主通道** | 承载 pix Runtime Protocol 命令、事件和 resume |
| 运行时 | **Node 22 LTS** | 对齐 pi SDK |
| 桌面原生壳 | **仅架构预留** | 协议/Host 可被 Tauri 挂载；当前不交付 |

### UI-first runtime transaction and running-state projection

- 发送消息先写入按 `sessionId` 归属的独立 optimistic transaction layer；权威历史/live projection 永不被乐观写入。合并顺序固定为 persisted → committed live → optimistic tail；按 Protocol 提供的 operation/turn/entry identity 对账，文本不能代替已有权威身份。FIFO 仅在 wire 明确保证顺序且确定性测试证明时适用，禁止盲目跨会话匹配。
- read-only history → live attach 只允许同一 session 的 generation 0 历史作为临时 placeholder；跨 session、live rebase/branch generation 绝不复用旧页面。
- prompt transport ack 只是 admission，不是运行终态；UI running marker 持续到权威事件接管，避免 ack→agent_start 闪断。
- admission 与 observation 可交错到达。Client 已知的同 epoch cursor 比 admission revision 新时，确认仍应完成身份、原 promise 与乐观条目的对账，但不得用旧 admission snapshot/cursor 回退当前权威投影；不同 epoch 的 revision 不排序。发送记录只更新必要的 provenance 字段，不替换 transport callback 正在持有的 pending 对象。
- 部分回复直接来自共享 Protocol accumulator。不得用没有后续发布保证的第二份节流缓存隐藏已经收到的文字；模型暂停时，最后一段合法回复仍须可见，且不依赖下一条网络事件触发显示。
- sessiond 以协商 feature `runtime.running-watch.v1` 的 revisioned `running_state` 发布全局 live/turn-busy 真相；该全局订阅独立于 per-session attach，不 touch/activate Worker，首页与只读历史保持 0 Worker，attach replacement 也不会形成 completion 丢失窗口。Client `RuntimeConnection` 是唯一 running owner，按 socket generation + sessiond revision 栅栏原子替换集合，Sidebar 会话、项目目录和顶部 Tab 通过 `useRuntimeConnection()` 只消费该集合，选中会话 exact busy 由 `useSelectedRuntime()` 即时叠加。Protocol v2 未协商时暂保留一次性 `listRunning` + `running_sessions_changed` legacy 路径（Protocol v3 同步删除）；controller 必须先 cursor-accept/reduce legacy event 再通知 connection，协商 watch 后 connection 忽略其 state payload但 cursor仍推进，禁止过滤制造假 gap；禁止轮询。
- 选择历史/文件 Tab 不启动目标 Worker；已有 attach 可作为后台事件订阅保留，所有 transcript/composer/capability/context 均按 active session identity fail-closed，后台 A 状态绝不投影到 B。
- **本轮评估澄清**：零 Worker 历史浏览限制的是隐式启动执行，不禁止观察一个已运行的 Worker。选择身份、观察订阅、执行激活、中断当前 turn 和结束 Worker 必须分别定义；具体重构契约与迁移顺序见本轮方案。在服务端证明“观察绝不激活”之前，不把放宽客户端自动 attach 条件当作完整修复。

### 上下文占用来源

- 历史页的 `SessionContext.contextTokens` 与 `settings.model`、`leafId` 来自同一次已验证的 selected-branch 读取；Adapter 在分页和 thinking/media deferral 之前计算完整原始上下文的 token 估算。Client 只使用现有模型目录中 exact provider/id 的窗口，缺少分子、模型或窗口时保持未知，不借用同 ID 后台 Worker 的统计。
- 运行态通过已有 `runtime_state_changed.context` 一起发布模型、当前 leaf 和占用；Adapter 在消息持久化后以及模型、分支、压缩变化时发布，sessiond 和 Client 通过同一 Protocol reducer 按 epoch/eventId 接受。独立 stats 读取只供累计统计，不覆盖占用或其 null 未知状态。读取占用不重载 Worker，也不改变执行分支。
- 待发送模型属于未应用的用户意图：历史页按其 exact catalog window 展示明确标记的估算；自动观察保留待发送模型而运行态仍使用另一模型时，不将另一模型的百分比标在该选择旁。真正应用模型后，接受运行态的对应占用。
- Protocol v2 的 `contextTokens` 为 additive optional，缺字段视为未知；与 `settings` 一起在 Protocol v3 最低支持版本切换时改为 required。新事件 payload 与读取字段要求 sessiond/Worker/Adapter contract 5/4/3，升级仍服从维护约束，不热替换活动进程。

### 生命周期修复冻结项（Phase 1 起）

- 0 Worker 的 `sessions.context` 是 selected JSONL branch 的完整页面读取模型：除 entries/leaf/pageInfo 外，必须携带 branch-resolved `settings.model`（可为 `null`）与 `settings.thinkingLevel`。当前 Protocol v2 为 additive optional，以便旧 daemon 连接仍能被识别；字段缺失只能显示 unknown，禁止用 catalog default、第一项、assistant message 或 `auto` 冒充；Protocol v3 的 daemon build fence 落地后改为 required。
- `sessions.read` 只承载 exact session header/workspace authority；完整 transcript entries 只能经有界 `sessions.context` 页面传输。sessiond 必须在 RPC framing 前移除 `SessionDetail.entries`，Host 对 mixed/legacy producer 再做防御性移除；禁止用提高 RPC writer byte limit 或 timeout 允许任意长 detail frame。
- Client session catalog 由 TanStack Query 管理独立 Projects/Sessions/项目内 Sessions 分页资源；采用当前 Materialized Catalog 分页契约（见上文），不恢复旧的无界列表或递增 prefix/overlap 拼接。URL-selected id 不要求属于当前已加载列表，通过 exact detail 获取其显示/授权信息；不得因此自动翻页或启动 Worker。
- `settings` 必须由 Adapter 在已验证 leaf membership 后从 Pi `buildSessionContext()` 投影，Host/Client 不重新推导。历史分页使用同一 session/branch query key，后续 page 不得覆盖首个 page 的 metadata。
- runtime command 的 at-most-once 账本与 read RPC 分域：stats/tools/commands/state 等纯读取不得因为页面 mount/reconnect 累计耗尽 mutation command quota。Phase 2B 已以协商特性 `runtime.read-rpc.v1` 落地独立 Browser `read/read_result`、Host→sessiond `runtime.read`、sessiond→Worker `worker.read/worker.readResult`；Client/Host/sessiond 均有独立 bound，sessiond 以 sessionId+epoch+requestId+唯一 dispatchId 做严格匹配，Worker ready feature fence 阻止旧 Worker build 被错误复用。旧 Protocol v2 command-envelope read 仅是有限 shim；在 Protocol v3 成为最低版本且 Phase 7 build contract 能证明所有可复用 daemon/Worker 支持该 feature 后删除。任何 accepted-id 的有界化必须保留 replay safety，禁止简单驱逐旧 id。
- `select`、`attach`、`activate`、`detach`、`stop`、`reload` 的语义严格区分；发送另一会话不得被实现成组件自行拼接的多个可独立成功的生命周期命令。最终由 sessiond 提供一次有身份/版本 fence 的 submit-turn 意图。

### 明确不选

| 项 | 原因 |
|----|------|
| Next.js 长期底座 | 请求模型不适合长生命周期 Agent；Web 重启会带走进程内会话 |
| TanStack Start | 仍是全栈页面框架，不解决 Agent 宿主与会话保活 |
| Go 主后端 | Agent 内核是 Node SDK，最终仍要 Node Worker，双运行时过重 |
| Electron 同进程塞 SDK | 与 PWA/Web 协议分叉；崩溃面大 |
| 手机端跑 Agent | 无完整本机 dev 环境；手机只连电脑上的 Host |
| 用 DB 取代 jsonl | 破坏与 pi CLI 互通 |
| UI/Host/sessiond 直连 Pi SDK 或原始 RPC | Pi 接入细节向全栈扩散，后续无法低成本切换 |
| Runtime Protocol 直接镜像 SDK/RPC 类型 | 外部依赖升级会破坏客户端和跨进程契约 |
| 用 TanStack Query 轮询冒充 streaming | 破坏 resume 与跨端一致性 |

## 5. 会话保活（相对现状的关键修复）

### 现状问题

AgentSession 活在 Web/Next 进程内。重启 Web（或热更新拖垮进程）会杀掉所有运行中会话。

### 目标行为

| 事件 | 期望 |
|------|------|
| 重启 Web / 发版切换 Web 进程 | 会话与 Worker 继续跑 |
| 浏览器刷新 / PWA 重建 | `attach + lastEventId` 恢复 UI |
| 手机切后台再回来 | 同一 resume 路径 |
| 显式 stop / 空闲超时 | 才回收 Worker |
| sessiond 自身退出 | 会话结束（接受）；需单独升级 sessiond 时处理 |

### 单实例约定

- sessiond 使用锁文件 + 固定本机 endpoint  
  例如：`~/.pi/pix/sessiond.sock` 或 `127.0.0.1:<固定/协商端口>` + `~/.pi/pix/sessiond.lock`
- Web 启动：
  1. 发现已有 sessiond → 接入  
  2. 否则拉起 sessiond 再接入  
- Web 关闭：只断连接，**不** SIGTERM sessiond（可用显式 CLI/`pix down --all` 收全套）

## 6. 协议：pix Runtime Protocol

### 传输

| 通道 | 用途 |
|------|------|
| `WS /v1/runtime` | prompt / steer / follow_up / abort / set_model / compact / fork… + 事件流 |
| `HTTP /v1/*` | sessions、files、git、models、skills、plugins、themes、gate 等资源 API；selected history visible-branch export 当前复用 sessions context 并在 Client 本地生成，不设专用 export endpoint |
| Web ↔ sessiond | 本机 IPC/RPC（实现细节可演进；对外仍表现为上述协议） |

### 握手

以下保留早期 v1 设计示例用于说明交换方向，不是当前 wire schema 或实现常量。当前版本、字段与可协商 feature 由 `packages/protocol/src/{version,handshake,features}.ts` 定义；本轮新增观察/显式激活语义仍为方案，不能从示例推导支持情况。

Client → Host：

```json
{
  "protocolVersion": 1,
  "client": { "shell": "web|pwa", "platform": "win|mac|linux|ios|android" },
  "features": ["virtual-scroll", "notifications"],
  "auth": "<gate-token-if-any>"
}
```

Host → Client：

```json
{
  "protocolVersion": 1,
  "host": {
    "mode": "local|lan",
    "capabilities": ["agent", "files", "files.write", "git", "worktree"]
  },
  "limits": { "maxUpload": 0, "maxOpenSessions": 0 },
  "sessionSnapshotSupport": true
}
```

### Resume

- 连接携带 `sessionId` + `lastEventId` / `epoch`
- Host/sessiond 推送 `state_snapshot`，再续后续事件
- 禁止依赖「轮询 `/running` 猜是否结束」作为主路径

### 能力协商

Client 按 `capabilities` 显隐功能：

| 能力 | 无此能力时 |
|------|------------|
| `agent` | 只读浏览 |
| `files.write` | 禁用写入 |
| `worktree` | 隐藏 worktree 切换 |
| `models.configure` | Models 退化为只读目录，不显示 models.json 保存/导入面 |
| `themes` | 隐藏主题切换（内置/自定义主题不可用） |

> **当前状态（客户端）**：pix client 已移除主题功能（运行时切换、主题目录请求、设置、持久化/bootstrap、View Transitions）与壁纸（WallpaperLayer/设置/资源）。Client 固定深色外观（`html.dark` 常驻），不再消费 `/v1/themes`。下方 Host/runtime-core/pi-sdk-adapter 的只读主题契约保持不变（向后兼容、当前客户端未使用）。

### 全局 models.json 编辑器

`ModelConfigStorePort`（runtime-core）→ `@fffattiger/pix-pi-sdk-adapter/models` → Host `GET/PUT /v1/models/config` 与 `POST /v1/models/discover` → Client Models Settings。它与只读 `/v1/models` 独立：只在 `models.configure` seam 真实挂载时广告，sessiond down 时仍可用。

- GET 返回 SHA-256 revision、Provider/显式模型编辑投影和内置 Provider 目录；API Key 只投影 `apiKeyConfigured`，绝不返回 key/header 值。
- PUT 使用 expectedRevision compare-and-swap；API Key 只能 `preserve/remove/replace` 单向输入。Adapter 按 `sourceId/sourceIndex` 合并，保留 UI 未编辑且可能含敏感值的 headers/compat/modelOverrides/sampling 等 Pi 字段；候选文件先通过离线 ModelRuntime 验证，再以 owner-only bounded atomic document 写入。
- discovery 是认证后的显式网络动作：20 秒有界、2 MiB 响应上限、只接受 http/https；已有 key 仅在 Provider identity 与 Base URL 都未改变时可内部复用，改 endpoint 必须重新输入 key，shell-command key 不执行。响应只返回去重后的模型 id/name。
- Client 使用 typed transport/TanStack mutation；无裸 fetch。Models 页为独立 Provider/模型树、Provider/模型表单、密钥遮罩、导入、增删与保存/取消；Add Provider 目录按自定义、订阅、API Key 分组。OAuth 订阅卡在 OAuth mutation seam 未交付前诚实 disabled，不伪造登录成功。

### 只读主题目录（D3B-R6）

`ThemeCatalogPort`（runtime-core）→ `@fffattiger/pix-pi-sdk-adapter/themes`（高保真移植旧桌面 Web 端的 `lib/theme.ts`）→ Host `GET /v1/themes` / `GET /v1/themes/:name`（Protocol strict DTO：`ThemeSetInfo` / `ThemeListResponse` / `ResolvedThemeResponse`）：

- 解析语义与源一致：5 套 builtin（gruvbox / miku-aqua / orbital-rose / scarlet-tether / solarized，dark+light）、`<agentDir>/themes/*.json` 全局主题、trusted 项目 `<cwd>/.pi/themes/*.json`；`-dark`/`-light` 文件名配对、单文件按 bg0 亮度推断极性、`vars` 引用/256 色/无 `#` 六位 hex/空串默认链、52 个 pi token → 固定 29 个 CSS vars；解析优先级 global → project → builtin（按源实际确认）。
- 安全强化（相对源的固定偏差）：主题名先按 slug 白名单校验后才触碰文件系统，源里的「name 作为直接文件路径」回退被移除；发现/解析要求文件 realpath 仍在 themes 目录内且目录仍在 caller-owned base（agentDir / cwd）内（symlink 逃逸跳过）；主题文件有大小上限；非安全颜色字面量（`url()`、`expression()`、命名色等）一律按未设置 token 走默认链，绝不进 CSS vars；单个坏 JSON 不影响列表；错误结构化（`not_found`/`invalid_input`）且不泄路径/原始内容。
- Host 边界：`?cwd=` 必须是 AllowedRoots 授权的绝对路径（无隐式 cwd）；未 trust 的项目不加载项目主题（global/builtin 仍可读）；`mode` 严格 `light|dark`（默认 `dark`）；cssVars 键 29 白名单、值仅安全 hex/rgba；固定消毒 400（`CWD_REQUIRED`/`INVALID_THEME_NAME`/`INVALID_THEME_MODE`）/404（`THEME_NOT_FOUND`）/503（`CATALOG_UNAVAILABLE`）。
- capability：只读 `themes` token 仅在 seam 真实接线时广告；主题读取不依赖 sessiond，degraded（sessiond down）诚实保留 token 与真实读取；HTTP/bootstrap/health/WS 四面一致。

## 7. 数据流

```
只读资源:
  UI → TanStack Query → HTTP /v1 → Web(Hono) → SQLite / FS / git

跑 Agent:
  UI → WS command → Web 网关 → pix-sessiond → worker application controller
     → AgentRuntimePort → PiSdkAdapter（当前）/ PiRpcAdapter（未来） → Pi
  UI ← exact/connection hooks ← SessionControllerRegistry(one lease) ← exact SessionController ← RuntimeConnection ← RuntimeSocket ← WS ← sessiond ← normalized runtime events ← Pi ACL
```

| 现状 | 目标 |
|------|------|
| SSE + POST + 多路轮询 | 一条 WS 运行时通道 |
| `startRpcSession` 进 Web 进程 | sessiond 持有；Web 只 attach |
| 每次 `listAll` 扫盘 | SQLite 索引 + watch |
| Web 重启杀会话 | Web 重启会话仍在 |

## 8. 包结构

```
packages/
  protocol/        # 网络/进程线协议：zod schema、版本、共享 DTO
  runtime-core/    # pix 自有 Ports、规范化模型和应用错误；零 Pi 依赖
  pi-sdk-adapter/  # 当前 Pi SDK 防腐层；唯一可 import @earendil-works/pi-* 的包
  pi-rpc-adapter/  # 未来 Pi RPC 防腐层；当前只保留架构位置，不交付
  runtime-contract-tests/ # Adapter 共享行为契约测试（测试包，不进入生产产物）
  sessiond/        # 守护进程：会话权威、Worker 调度、事件总线
  agent-worker/    # 单会话进程壳：Protocol mapper + application controller + Adapter composition
  host/            # Hono 薄 Web/API + WS 网关 + 静态资源
  client/          # Vite React + TanStack
  cli/             # pix / pix-host / sessiond 启停入口
  shell-tauri/     # 预留，当前不交付
```

### 产物（当前）

| 产物 | 内容 |
|------|------|
| `pix` | CLI：确保 sessiond + 启 Web（兼容现有 npx 心智） |
| `pix-sessiond` | 可独立运行的会话守护进程 |
| Web UI | `client` 构建的静态资源，由 host 托管 |
| PWA | manifest + service worker，挂在 host 静态资源上 |

## 9. 跨端策略（当前主线：PWA）

| 端 | 连接 | 能力 |
|----|------|------|
| 电脑浏览器 / 桌面 PWA | 本机 Web → sessiond | 完整 |
| 手机 / 平板 PWA | 电脑局域网 Web → 同一 sessiond | 看会话、轻操作、steer/follow-up；**不在手机跑 Agent** |

### 安全分级

| 场景 | 策略 |
|------|------|
| `127.0.0.1` | Host/Origin 防护；gate 可配 |
| **LAN** | **强制 gate / 配对**；禁止裸奔 |
| 文件 | allow-root；worker 只能碰授权路径 |
| sessiond | 默认只监听本机；不随 LAN 暴露；由 Web 网关统一对外 |

手机连电脑 = 高权限 agent 入口，按远程控制台做鉴权，不是「顺便打开局域网」。

## 10. 与桌面客户端的关系（仅设计预留）

```
未来（不在当前交付）:
  Tauri Shell → 同一 Client dist → 本机 Web/host 或直连协议
                     │
                     └── 仍附着同一 pix-sessiond
```

当前约束：

- **不**实现 Tauri/Electron 安装包  
- **不**为桌面壳单独分叉业务协议  
- 保持：Client 静态化、Session 在 sessiond、单协议  

这样以后上桌面壳是加 Shell，不是翻架构。

## 11. 落地里程碑

执行不再按技术层横向堆叠，而是按可验收的纵向产品切片推进。

| 里程碑 | 交付 | 完成标准 |
|------|------|----------|
| **M1 可启动独立应用** | 独立 `pix` workspace、Vite Client、Hono Host、sessiond daemon、production composition、CLI | `npm run build` 后可用一个命令启动；Host 托管真实 Client；`/v1/health`、capabilities、bootstrap 可用；Host 退出后 sessiond PID 不变；仓库内无 Next 产品路径 |
| **M2 最小 Runtime Slice** | agent-worker、Pi SDK Agent Adapter、Host WS Gateway、Client RuntimeConnection/SessionControllerRegistry | create/open → attach → prompt → stream → done；支持 abort、snapshot/resume、commandId 去重；Host 重启不杀 Worker |
| **M3 日常使用切片** | 历史会话、完整 Runtime 命令、files/git/worktree、models/auth/resources、跨边界 mutation | 历史浏览 0 Worker；主要现有功能通过新架构可用 |
| **M4 Scale + PWA** | SQLite 投影、长列表虚拟化、LAN gate/配对、移动端恢复 | 千级会话与长聊天指标达标；手机可安全连接电脑 Host |
| **M5 Release** | 安装、升级、卸载和发布验证 | 发布物只包含新架构 Client/Host/sessiond/Worker/Adapter/CLI，不包含 Next 产品路径 |

建议优先顺序：**M1 → M2 → M3 → M4 → M5**。

M1、M2 已完成并通过GPT最终独立对抗验证。当前唯一活动里程碑是 M3：扩展只读历史、Runtime命令、工作区和领域资源能力，同时继续保持独立启动、daemon保活、0 Worker历史浏览、能力诚实与零Next产品路径不变量。

## 12. 验收指标

- Web 进程重启后，运行中会话仍存活，客户端可 attach 恢复
- 只读打开历史：**0** agent worker
- `@earendil-works/pi-*` import 只存在于 `pi-sdk-adapter`
- Worker Controller 使用 fake Runtime Port 的测试可运行，不需要加载 Pi SDK
- `PiSdkAdapter` 通过共享 Adapter contract suite；未来 `PiRpcAdapter` 复用同一 suite
- 会话列表 P95：千级会话 **\< 50ms**（索引命中时）  
- 单 worker 崩溃：不影响其他会话与 UI  
- 约 1 万条消息：主线程可交互（Virtual）  
- 手机断线重连：靠 snapshot，不靠猜 `ended`  
- 默认对外仍是 **一个端口**（Web）；sessiond 仅本机  

## 13. 现状对照（摘要）

| 领域 | 现状（Next 单体） | 目标 |
|------|-------------------|------|
| 页面框架 | Next App Router | Vite + React + TanStack |
| API | `app/api/*` Route Handlers | Hono `/v1/*` |
| Agent 生命周期 | `lib/rpc-manager.ts` 进 Web 进程并直接调用 SDK | `pix-sessiond` 常驻；Worker 只认 Runtime Port；Pi ACL 负责 SDK/RPC |
| 实时 | SSE + POST + 轮询对账 | WebSocket + snapshot |
| 会话列表 | `SessionManager.listAll` + 短缓存 | Adapter 持有可重建 SQLite 投影；Host 通过 Catalog seam 读取 |
| 跨端 | 偏桌面浏览器；PWA 基础存在 | PWA 为第一跨端形态 |
| 重启 | 杀会话 | 不杀会话 |

## 14. 最终判断

| 问题 | 答案 |
|------|------|
| 页面用什么？ | Vite + React + TanStack Router/Query/Virtual |
| Web 后端用什么？ | Hono（薄，可重启） |
| 会话跑哪？ | **独立 pix-sessiond** 管生命周期；具体 Pi runtime 存在于 Worker Adapter 内 |
| Agent 跑哪？ | sessiond 调度的每会话 Node Worker；Worker 通过 `AgentRuntimePort` 调用 Pi ACL |
| 当前怎么接 Pi？ | `PiSdkAgentRuntimeAdapter`；Pi SDK 类型只存在于 `pi-sdk-adapter` |
| 以后改 Pi RPC？ | 增加 `PiRpcAgentRuntimeAdapter` 并通过同一 Adapter contract suite；上层协议和业务无需改造 |
| 实时怎么做？ | WebSocket + resume |
| 当前跨端？ | **PWA**（本机完整能力，手机连 Host） |
| 桌面客户端？ | 架构预留，**现在不做** |
| Next？ | **不进入 `pix` 产品路径**；旧 Next 仓库只作为选择性迁移来源 |

切换接入方式只影响 Pi ACL Adapter 和各进程 composition root，不改变 pix Runtime Protocol、Runtime Core、sessiond 调度、Host 网关或 Client 状态模型。
