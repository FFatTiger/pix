# pi-web 架构重构执行与协作手册

> **全局状态：`PAUSED`（项目负责人于 2026-08-10 要求暂停所有工作）。**
> 在收到明确恢复通知前：不得继续开发、提交、推送、合并、认领新任务或启动自动化实现；保留现有分支、worktree、Draft PR 和本地未提交进度。
>
> **本文件是本轮重构的执行单一事实源（Execution SSOT）。**
> 架构原则与目标见 [`refactor-architecture.md`](./refactor-architecture.md)；所有任务认领、依赖、文件所有权、状态同步、验收和合并顺序以本文件为准。  
> 新同事加入项目时，先阅读本文件，再阅读 `AGENTS.md` 和自己任务涉及的源码。

- 最后更新：2026-08-11 08:36 CST
- 项目状态：`PAUSED`
- 目标主线：Vite Client + Hono Host + `pi-sessiond` + 每会话 Worker + Agent Runtime Port + Pi 防腐层 + Protocol v1
- 当前交付：浏览器 / PWA；不交付 Tauri/Electron
- 集成负责人：`FFatTiger`（当前会话）
- 集成分支：`refactor/architecture-v1`

---

## 1. 怎么使用这份文档

### 1.1 项目负责人分派任务

1. 查看[当前任务看板](#5-当前任务看板)。
2. 只分派状态为 `READY` 的任务；`BLOCKED` 任务不得提前实现其依赖部分。
3. 在看板中填写负责人、分支、worktree 和开始日期。
4. 把对应[工作包说明](#6-工作包说明)直接发给开发者。
5. 开发者提交交接信息后，将任务改为 `IN_REVIEW`。
6. 独立验证通过且已进入集成分支后，才能改为 `DONE`。

### 1.2 开发者认领任务

1. 找到任务 ID，例如 `R1`、`H1B`、`C2`。
2. 确认依赖已是 `DONE`，任务状态是 `READY`。
3. 从最新集成分支创建独立 branch/worktree。
4. 只修改任务声明的文件范围。
5. 如需修改共享契约或他人所有文件，先在本文件的[决策记录](#4-已冻结的架构决策)中提出变更，不得私自跨界修改。
6. 完成后按[交接模板](#103-任务交接模板)提交。

### 1.3 状态定义

| 状态 | 含义 |
|---|---|
| `BACKLOG` | 已定义，但当前波次不执行 |
| `BLOCKED` | 依赖未完成，禁止开始 |
| `READY` | 依赖满足，可立即认领 |
| `IN_PROGRESS` | 已有负责人，正在开发 |
| `IN_REVIEW` | 开发完成，等待独立验证或集成 |
| `PAUSED` | 主动暂停，必须写明原因 |
| `DONE` | 已验证并进入集成分支 |

> 一个 commit 已存在不等于 `DONE`；必须经过独立验证并合入集成分支。

---

## 2. 交付目标和边界

### 2.1 本轮必须实现

1. Web/Host 重启时，运行中的 sessiond 和 Worker 不退出。
2. 一个 Agent Session 对应一个独立 Worker 进程；Worker 只通过 `AgentRuntimePort` 使用 Agent 后端。
3. Pi 相关操作统一经过防腐层；当前使用 `PiSdkAdapter`，未来可增加 `PiRpcAdapter`。
4. 只读浏览历史不创建 Worker。
5. Client 实时状态使用一条 `WS /v1/runtime`，支持 `snapshot + resume`。
6. HTTP 资源接口统一为 `/v1/*`。
7. Client、Host、sessiond 和 Worker Controller 不 import Pi SDK，也不解析 Pi RPC 原始帧。
8. Host 不创建、不持有 `AgentSession`。
9. JSONL 和 `~/.pi` 继续是真相源。
10. Hono 同一端口托管 `/v1`、WebSocket 和 Vite 静态资源。
11. PWA 支持电脑本机和手机连接电脑 Host；LAN 模式强制 gate。

### 2.2 本轮不做

- Tauri / Electron 安装包
- 手机本地运行 Agent
- 用 SQLite 取代 JSONL
- Pi RPC Adapter 实现（本轮只冻结 Ports、Mapper 责任和共享契约测试）
- sessiond 无停机滚动升级
- sessiond 重启后继续恢复正在执行的 prompt
- Worker 崩溃后自动重放 prompt
- Go 后端
- 新功能继续堆叠到旧 Next runtime

### 2.3 成功指标

| 指标 | 验收标准 |
|---|---|
| Host 重启 | sessiond PID 和 Worker PID 不变 |
| 历史浏览 | Worker 数量增加 0 |
| Worker 隔离 | 一个 Worker 崩溃不影响其他会话 |
| Resume | Client 刷新/后台恢复后通过 snapshot 恢复状态 |
| 会话列表 | 千级会话索引命中 P95 `< 50ms` |
| 长聊天 | 约一万条消息时 DOM 保持有界、输入可交互 |
| 网络入口 | 默认只对外暴露 Host 一个端口 |
| 后端可替换性 | 同一规范场景切换 SDK/RPC Adapter 时，Runtime/Protocol fixture 一致；差异只通过 capability 表达 |
| 依赖边界 | `@earendil-works/pi-*` 仅出现在 `pi-sdk-adapter`；Host/sessiond/Worker Controller 为 0 |

---

## 3. 目标进程与包边界

```text
packages/
  protocol/       网络/进程线协议：Zod schema、版本、共享 DTO
  runtime-core/   pi-web 自有 Runtime/Resource Ports、规范化模型、应用错误
  pi-sdk-adapter/ 当前 Pi SDK 防腐层；唯一允许 SDK imports
  pi-rpc-adapter/ 未来 Pi RPC 防腐层；当前不交付实现
  runtime-contract-tests/ Adapter 共享行为契约测试（测试包）
  sessiond/       会话权威、Worker 调度、事件日志、resume
  agent-worker/   单会话进程壳：Protocol Mapper + Controller + Adapter composition
  host/           Hono HTTP、WS 网关、gate、文件/git、静态资源
  client/         Vite React + TanStack + PWA
  cli/            pi-web / pi-host / pi-sessiond 启停入口
```

### 3.1 依赖方向

```text
client ───────────────▶ protocol
host ─────────────────▶ protocol + runtime-core ports
sessiond ─────────────▶ protocol + runtime-core ports
agent-worker ─────────▶ protocol + runtime-core ports
pi-sdk-adapter ───────▶ runtime-core ports + @earendil-works/pi-*
pi-rpc-adapter ───────▶ runtime-core ports + pi --mode rpc（未来）
cli ──────────────────▶ host/sessiond 启动入口

host ──本机 RPC───────▶ sessiond ──Node IPC──────▶ agent-worker
agent-worker controller ──▶ AgentRuntimePort ──▶ selected Pi Adapter
```

禁止出现：

```text
client ──▶ Pi SDK / Node fs / sessiond 内部模块
host ────▶ AgentSession / SessionManager / Pi SDK / Pi RPC frame
sessiond ▶ AgentSession / SessionManager / Pi SDK / Pi RPC frame
worker controller ▶ Pi SDK / Pi RPC frame / Host cache / React / Hono
protocol ▶ React / Next / Hono / Pi SDK / Pi RPC / runtime-core
runtime-core ▶ Protocol / React / Hono / Pi SDK / Pi RPC / Node 进程管理
pi-sdk-adapter 之外的模块 ▶ @earendil-works/pi-*
pi-rpc-adapter 之外的模块 ▶ Pi RPC method/frame parser
```

### 3.2 数据所有权

| 数据 | 权威所有者 | 说明 |
|---|---|---|
| 活跃 Agent Runtime | sessiond + 对应 Worker | sessiond 管生命周期；Worker Controller 持有 `AgentRuntimePort`，具体 Adapter 封装 Pi 实例/进程 |
| Runtime eventId/epoch | sessiond | Host 和 Adapter 不生成对外事件编号 |
| Runtime UI 投影 | sessiond snapshot + Client SessionStore | Query 不轮询实时状态 |
| Runtime 内部规范模型 | `runtime-core` | 与 Protocol DTO 通过 Mapper 转换；与 SDK/RPC 类型隔离 |
| Pi SDK/RPC 语义翻译 | `pi-sdk-adapter` / `pi-rpc-adapter` | 工具、事件、错误、usage、extension UI、模型与能力归一化 |
| 历史 JSONL | `~/.pi` 文件 | 与 pi CLI 共用真相源；Host 通过 `SessionCatalogPort` 访问 |
| 会话列表索引 | Host SQLite 投影 | 可重建，不替代 JSONL |
| 文件/git/worktree | Host | 受 allow-root 和 gate 保护 |
| models/auth/plugins/skills | Host application services + 注入 Port | Pi 具体实现位于防腐层 |
| UI 本地偏好 | Client localStorage/IndexedDB | theme、面板、草稿等 |

### 3.3 Composition Root 与装配规则

| 进程 | Composition Root | 可装配内容 | 禁止 |
|---|---|---|---|
| Worker | `packages/agent-worker/src/composition/*` | `AgentRuntimeFactory` 的 SDK/RPC 实现 | Controller 直接 new `AgentSession` 或 spawn Pi RPC |
| sessiond | `packages/sessiond/src/composition/*` | `SessionLocatorPort`、Worker process factory | registry/supervisor import Pi 类 |
| Host | `packages/host/src/composition/*` | Session/Model/Credential/Resource/Trust Ports | route/service import Pi 类或根据 backend 分支 |
| CLI | `packages/cli/src/composition/*` | 启动 Host/sessiond、选择配置 | 将 Adapter 细节传播给 Client |

规则：

1. Composition Root 只负责选择实现、读取环境配置和构造依赖图，不承载业务规则。
2. Adapter 包使用子路径 exports，确保 Worker 不加载 Host 专用 Pi 资源代码，Host 也不加载 Agent runtime。
3. `PI_WEB_AGENT_BACKEND` 只允许在 Worker composition root 读取。
4. sessiond registry 和 Host capability 响应只存规范化 capability，不存后端名称。
5. 测试默认注入 fake Port；真实 SDK/RPC 仅在 Adapter contract/integration tests 中加载。

---

## 4. 已冻结的架构决策

修改以下决策必须先更新本节，并通知所有受影响任务负责人。

| ID | 决策 | 状态 |
|---|---|---|
| `D-001` | pi-web Runtime Protocol v1 使用 Zod；公开 wire 类型从 schema 推导 | 已冻结 |
| `D-002` | Client、Host、sessiond 通过 Protocol DTO 交互；Worker 的 Protocol Mapper 与 Runtime Core 显式转换 | 已冻结 |
| `D-003` | sessiond 是运行时唯一权威；Host 只代理和 attach | 已冻结 |
| `D-004` | 一个 Worker 只承载一个 `AgentRuntimePort` 实例 | 已冻结 |
| `D-005` | `runtime-core` 定义 pi-web 自有 Ports/模型，不依赖 Protocol、Pi SDK 或 Pi RPC | 已冻结 |
| `D-006` | `pi-sdk-adapter` 是唯一可 import Pi SDK 的生产包；SDK 类型不得越过 Adapter 边界 | 已冻结 |
| `D-007` | 未来 `pi-rpc-adapter` 是唯一可解析 Pi RPC 帧的生产包；切换 Adapter 不修改 Protocol/业务层 | 已冻结 |
| `D-008` | Protocol DTO 与 Runtime Core Model 分离，通过显式 Mapper 转换 | 已冻结 |
| `D-009` | Host/sessiond 通过 `SessionCatalogPort`/`SessionLocatorPort` 等窄 Port 使用 Pi 资源，不直接 import `SessionManager` 或 Pi 配置类 | 已冻结 |
| `D-010` | HTTP 历史浏览与 SQLite read model 归 Host；sessiond 只保留激活所需 locator 和 mutation 协调 | 已冻结 |
| `D-011` | 浏览器实时主通道只有 `WS /v1/runtime`；不保留 Agent SSE/运行态轮询作为新架构主路径 | 已冻结 |
| `D-012` | 每个命令带 `commandId`；sessiond 在 session/epoch 内 at-most-once | 已冻结 |
| `D-013` | attach 使用 `epoch + lastEventId`；gap 或 epoch 变化时回完整 snapshot | 已冻结 |
| `D-014` | 首期事件日志仅在 sessiond 内存保存；默认每会话最多 2,000 条或 10 MiB，任一先到即淘汰，可配置 | 已冻结 |
| `D-015` | Worker 崩溃不自动重放 prompt；标记 crashed，用户显式重新激活 | 已冻结 |
| `D-016` | JSONL 是真相源；SQLite 损坏后必须可从 JSONL 重建 | 已冻结 |
| `D-017` | Runtime snapshot 必须包含 partial streaming message、队列、extension UI、compaction/bash/model/tools 等可恢复状态 | 已冻结 |
| `D-018` | fork 的规范语义由 Runtime Port 定义；SDK/RPC Adapter 都必须创建独立 JSONL 和 `parentSession`，并在返回结果后结束旧 runtime | 已冻结 |
| `D-019` | all-tools-off 的规范语义是 `toolNames=[]` 且 system prompt 为空；由 Adapter 保证 | 已冻结 |
| `D-020` | LAN 模式强制 gate；sessiond 永远只监听本机，不直接暴露到 LAN | 已冻结 |
| `D-021` | capability 降级按 Adapter/Host 能力值判断，不按后端类型或外壳判断 | 已冻结 |
| `D-022` | 开发期间禁止运行 `next build` | 已冻结 |
| `D-023` | 旧 Next 应用在迁移期间保持可运行；新架构不为旧 SSE/轮询继续扩展供应商耦合 | 已冻结 |

### 4.1 pi-web Runtime Protocol v1 必须覆盖的命令

```text
prompt                 steer                   follow_up
abort                  get_state               set_model
fork                   navigate_tree           set_thinking_level
compact                abort_compaction        set_session_name
get_session_stats      get_last_assistant_text set_auto_compaction
set_auto_retry         clear_queue             get_tools
set_tools              get_commands            reload
extension_ui_response  extension_ui_input      bash
abort_bash             generate_session_title
```

### 4.2 pi-web Runtime Protocol v1 最低事件集合

```text
agent_start             agent_end               agent_settled
prompt_done             prompt_error            message_start
message_update          message_end             tool_execution_start
tool_execution_end      queue_update            retry_start
retry_end               compaction_start        compaction_end
bash_update             extension_error         extension_ui_request
session_changed         runtime_state_changed   worker_crashed
running_sessions_changed runtime_unavailable
```

### 4.3 Runtime Capability 与 Adapter 一致性

Runtime capability 属于 `runtime-core`，表达规范能力，不表达 SDK/RPC 后端名称。最低集合：

```text
runtime.prompt            runtime.steer             runtime.follow_up
runtime.abort             runtime.model.set         runtime.thinking.set
runtime.tools.read        runtime.tools.write       runtime.compact
runtime.compact.abort     runtime.fork              runtime.navigate
runtime.bash              runtime.bash.abort        runtime.reload
runtime.extension_ui      runtime.auto_name         runtime.session.rename
runtime.queue             runtime.stats
```

规则：

1. Adapter 创建 runtime 时返回 capability snapshot；reload 后允许 capability 更新并发规范事件。
2. Worker 在调用 Adapter 前执行 capability gate；Adapter 仍做防御校验。
3. Protocol/Host 把 Runtime capability 投影为对外 capability；Client 不接收 `sdk`、`rpc` 等后端标识。
4. 缺失能力返回 `UNSUPPORTED_CAPABILITY`，不得伪造成功或静默降级为另一命令。
5. `runtime-contract-tests` 对每个 capability 运行共享用例；未声明的 capability 不要求实现对应命令。

### 4.4 SDK / RPC 语义映射责任

| 规范语义 | Pi SDK Adapter | Pi RPC Adapter（未来） | 上层看到的结果 |
|---|---|---|---|
| runtime identity | `AgentSession.sessionId/sessionFile` | RPC state/session metadata | `RuntimeIdentity` |
| prompt/steer/follow-up | SDK methods | RPC methods/queue | 规范 command result + events |
| abort/interrupt | SDK abort APIs | RPC abort / process control | 独立 interrupt 语义 |
| message streaming | SDK events | RPC JSONL events | 规范 message start/update/end |
| tool call/result | SDK message/event shapes | RPC tool frames | 统一工具名、参数、result、isError |
| model/thinking/tools | SDK model/tool APIs | RPC capability/methods | 规范状态；缺失则 capability false |
| extension UI | SDK UI context | RPC 支持时映射 | 规范 request/response；缺失则 capability false |
| fork/navigate | SDK/session file semantics | RPC 原生命令或 ACL 组合实现 | 相同 JSONL/parentSession 结果 |
| usage/context | SDK usage/context API | RPC usage/token frames | 规范 usage/context model |
| errors | SDK Error | RPC error frame/exit | 规范 `RuntimeError` |

任何新增 Pi SDK/RPC 字段先在 Adapter 内评估；只有成为稳定产品语义后，才按顺序修改 Runtime Core → Mapper → Protocol。禁止为了透传外部字段直接扩展 Protocol。

---

## 5. 当前任务看板

> 本表由集成负责人维护。状态发生变化时，在同一个提交中更新本表。

### 5.1 Wave 0：共享基线

| ID | 工作包 | 状态 | 负责人 | 分支 / Worktree | 依赖 | 当前结果 |
|---|---|---|---|---|---|---|
| `G0` | 执行与协作手册 | `DONE` | 当前会话 | `main` | 无 | `docs/refactor-execution-plan.md` |
| `W0` | npm Workspace Foundation | `PAUSED` | `FFatTiger` | `refactor/w0-workspace-foundation` | 无 | 恢复后从 `478ca71` 提取纯 workspace/package 基线，不包含 Protocol schema；Zod 由 Protocol 包声明，根 lockfile 统一记录 |
| `ACL0` | Runtime Core + Pi ACL Contracts | `PAUSED` | 待认领 | `refactor/runtime-core-ports` | `W0` | 恢复后冻结内部 Ports、规范模型、应用错误和 Adapter contract test kit |
| `P0` | Runtime Protocol v1 | `PAUSED` | `FFatTiger` / `protocol-base-impl` | `refactor/protocol-base`；[PR #15](https://github.com/FFatTiger/pi-web/pull/15)；[pix #1](https://github.com/FFatTiger/pix/issues/1) | `W0`, `ACL0` | 现有 Protocol 需按 Runtime Core 规范语义重审；保留 commit `478ca71` 和 worktree 进度，恢复时先 rebase 到 W0/ACL0 |
| `V-P0` | Protocol v1 独立验证 | `PAUSED` | `protocol-base-verifier` | 只读验证 `refactor/protocol-base` | `P0` | 首轮 FAIL：4 个阻塞类契约问题；等待修复后由同一验证者复验 |
| `C0` | Vite Client Shell | `DONE` | `client-shell-impl` | `refactor/client-shell` / `pi-web-worktrees/client-shell` | 无 | commit `d8978b5`；登录 deep-link 修复；7 files / 50 tests、typecheck/build/boundaries 通过 |
| `V-C0` | Client Shell 独立验证 | `DONE` | `client-shell-verifier` + 集成负责人复跑 | 只读验证 `refactor/client-shell` | `C0` | 首轮 HIGH 已关闭；主会话复跑 typecheck、50 tests、build、boundaries、diff check 全部 PASS |
| `I0` | 归一化集成分支和 root lockfile | `PAUSED` | `FFatTiger` | `refactor/architecture-v1`（已创建并推送） | `W0`, `ACL0`, `V-P0`, `V-C0` | 按 W0 → ACL0 → P0/C0 的顺序合入并归一化 lockfile；等待恢复通知 |

### 5.2 Wave 1：Runtime、Host、Client 数据层并行

| ID | 工作包 | 状态 | 负责人 | 建议分支 | 依赖 | 主要目录 |
|---|---|---|---|---|---|---|
| `ACL1` | Pi SDK Adapter | `BLOCKED` | 待认领 | `refactor/pi-sdk-adapter` | `W0`, `ACL0` | 可与 P0 并行；`packages/pi-sdk-adapter/**`，通过共享 Adapter contract suite；合并由 I0 统一协调 |
| `ACL2` | Pi RPC Agent Adapter（未来） | `BACKLOG` | 待认领 | `refactor/pi-rpc-adapter` | `ACL0`, `ACL1` contract baseline | 本轮不实现；未来只改 `packages/pi-rpc-adapter/**` 和 composition config，通过同一 contract suite |
| `R1` | pi-sessiond Core | `BLOCKED` | 待认领 | `refactor/sessiond-core` | `ACL0`, `P0`, `I0` | `packages/sessiond/**`；依赖 Runtime Ports/fakes，不 import Pi SDK |
| `R2` | agent-worker Application Shell | `BLOCKED` | 待认领 | `refactor/agent-worker-core` | `ACL0`, `ACL1`, `P0`, `I0` | `packages/agent-worker/**`；Protocol Mapper + Controller + Adapter composition，不 import Pi SDK |
| `H0A` | Protocol-independent Hono Host Foundation | `PAUSED` | `Pililink`（已通知暂停） | `refactor/h0-host-foundation`；[pix #2](https://github.com/FFatTiger/pix/issues/2) | 无（禁止 runtime wiring） | 不得开始或继续开发；保留分支，等待恢复通知 |
| `H0B` | Hono Host Protocol/runtime wiring | `BLOCKED` | 待认领 | `refactor/host-runtime-wiring` | `P0`, `I0`, `H0A`, `R1` | 后续接正式 Protocol/sessiond；不得由 H0A 自行发明协议 |
| `C1` | Client Protocol + HTTP Query | `BLOCKED` | 待认领 | `refactor/client-data` | `P0`, `C0`, `I0` | `packages/client/src/api/**` 等 |
| `CLI0` | CLI / sessiond single-instance 启动 | `BLOCKED` | 待认领 | `refactor/cli-runtime` | `R1`, `R2`, `H0A`, `H0B` | `packages/cli/**`, `bin/**` |

### 5.3 Wave 2：可继续横向拆分

| ID | 工作包 | 状态 | 负责人 | 依赖 | 主要目录 |
|---|---|---|---|---|---|
| `H1A` | Sessions read model / export | `BLOCKED` | 待认领 | `H0A`, `ACL0`, `ACL1` | Host service 依赖 `SessionCatalogPort`；Pi/JSONL 解析实现留在 Adapter |
| `H1B` | Files / git / cwd / worktree | `BLOCKED` | 待认领 | `H0A` | Host 对应 services/routes |
| `H1C` | Models / auth / plugins / skills | `BLOCKED` | 待认领 | `H0A`, `ACL0`, `ACL1` | Host application services 依赖 Model/Credential/Resource/Trust Ports |
| `H2` | WS Runtime Gateway | `BLOCKED` | 待认领 | `H0A`, `H0B`, `R1` | `packages/host/src/runtime/**` |
| `R3` | Side Chat + 跨边界 mutation | `BLOCKED` | 待认领 | `R1`, `R2` | sessiond/worker Side Chat 模块 |
| `C2` | RuntimeSocket + SessionStore | `BLOCKED` | 待认领 | `C1`, `H2`, `R1` | `packages/client/src/runtime/**` |
| `C3A` | Chat/Minimap/Side Chat Virtual | `BLOCKED` | 待认领 | `C2` | Client transcript 组件 |
| `C3B` | Session Sidebar Virtual | `BLOCKED` | 待认领 | `C1`, `C2` | Client sidebar 组件 |
| `C3C` | Files / Models / Skills / Plugins UI | `BLOCKED` | 待认领 | `C1`, `H1B`, `H1C` | Client 资源 UI |
| `DB0` | SQLite Session Index | `BLOCKED` | 待认领 | `H1A` | Host index/repository |

### 5.4 Wave 3：整合、PWA 和清理

| ID | 工作包 | 状态 | 负责人 | 依赖 |
|---|---|---|---|---|
| `X1` | Runtime 跨进程 E2E | `BLOCKED` | 待认领 | `R1`, `R2`, `H2`, `C2`, `CLI0` |
| `PWA1` | LAN gate / 配对 / capability 降级 | `BLOCKED` | 待认领 | `H0A`, `H0B`, `C1`, `C2` |
| `M1` | Session rename/delete/trust/worktree 协调 | `BLOCKED` | 待认领 | `R1`, `H1A`, `H1B`, `H1C` |
| `L1` | 旧 Next runtime/SSE/轮询移除 | `BLOCKED` | 待认领 | `X1`, `PWA1`, 功能对等验收 |
| `REL1` | 发布/安装/升级验证 | `BLOCKED` | 待认领 | `L1`, 全量验证 |

### 5.5 当前关键路径

```text
W0 ─▶ ACL0 ─┬─▶ P0 ─▶ V-P0 ─▶ I0 ─▶ R1 ─▶ H0B/H2 ─▶ C2 ─▶ X1
             └─▶ ACL1 ────────────────▶ R2 ────────────┘

H0A ────────────────────────────────▶ H1A/B/C
C0 ─▶ V-C0 ─────────────────────────▶ I0 ─▶ C1 ─▶ C2
```

---

## 6. 工作包说明

## W0 — npm Workspace Foundation

### 目标

建立不含业务契约的 monorepo/build 基线，供 Runtime Core、Protocol、Adapter、Host 和 Client 独立开发。

### 独占文件

```text
package.json
package-lock.json
tsconfig.json
.gitignore
packages/*/package.json 的集成归一化（由集成负责人执行）
```

### 交付

- `workspaces: ["packages/*"]`
- 统一 Node 22 / ESM / TypeScript 构建约定
- workspace build/typecheck/test 脚本命名
- 根 Next tsc 与各 package 独立 typecheck 的边界
- 发布文件策略和 dist 忽略策略

### 验收

- 不包含 Runtime/Protocol/Pi 业务 schema
- 现有 Next TypeScript 检查继续通过
- 新 workspace 可以单独安装、构建和测试
- 根 lockfile 是唯一 lockfile

---

## ACL0 — Runtime Core + 防腐层契约

### 目标

先定义 pi-web 自有的应用语义，再设计 Protocol 和具体 Pi Adapter。Runtime Core 是稳定的内核边界，Pi SDK/RPC 只是外部实现。

### 独占文件

```text
packages/runtime-core/**
packages/runtime-contract-tests/**
```

### 必须定义的 Ports

```text
AgentRuntimeFactory / AgentRuntimePort
SessionCatalogPort / SessionLocatorPort
ModelCatalogPort
CredentialStorePort
ResourceCatalogPort
ProjectTrustPort
```

### 必须定义的规范模型

- Runtime command/state/event/error/capability
- message/content/tool call/tool result
- model/thinking/usage/context
- extension UI/status/widget
- session locator/header/context
- model/auth/resource/trust DTO

### 硬规则

- 不 import Protocol、Zod、Pi SDK、Pi RPC、React、Hono 或 Node 进程管理
- Port 接口不出现 `AgentSession`、`SessionManager`、SDK `Model/Event/Error` 或 RPC method/frame
- Runtime Core Model 与 Protocol DTO 分开；Mapper 属于进程 adapter/application shell
- 外部后端缺能力时返回规范化 capability/error，不暴露后端类型
- `runtime-contract-tests` 导出可复用 suite；生产包不包含测试代码

### Adapter Contract Suite 最低矩阵

| 领域 | 必测行为 |
|---|---|
| lifecycle | create/open、identity、subscribe/unsubscribe、close reason、重复 close |
| command | 支持能力的成功路径、缺能力错误、非法输入、command correlation |
| interrupt | prompt/bash/compact 运行中可抢占；重复 interrupt 幂等 |
| streaming | start/update/end 顺序、partial snapshot、断流后的最终状态 |
| tools | 规范工具名/参数、tool result、`isError`、written files |
| model | set/get、无效模型、thinking pins、capability update |
| queue | steer/follow-up、clear、snapshot 恢复 |
| extension UI | pending request、response/cancel、重连 snapshot |
| compaction | manual/auto reason、start/end、abort |
| fork | 新 JSONL、parentSession、fork point、旧 runtime 结束顺序 |
| usage | input/output/cache/cost/context 规范化，0 值保留 |
| errors | 外部错误映射、敏感信息清理、retryable 分类 |

### 验收

- 架构依赖测试证明 Runtime Core 零 Pi/Protocol imports
- fake Adapter 通过完整 contract suite
- 明确 SDK/RPC 必须一致的语义和允许 capability 降级的语义
- fork、all-tools-off、abort、partial streaming、extension UI、tool result、usage 均有契约测试

---

## P0 — Runtime Protocol v1

### 目标

建立网络/进程边界契约。Protocol 以 ACL0 的规范语义为输入，但维护独立 wire schema，不直接导出 Runtime Core Model。

### 独占文件

```text
packages/protocol/**
```

### 交付

- Protocol v1 Zod schemas 和推导类型
- capabilities、errors、handshake
- 26 个 RuntimeCommand
- RuntimeEvent、RuntimeSnapshot
- 浏览器 WS envelope
- Host ↔ sessiond RPC envelope
- sessiond ↔ Worker IPC envelope
- contract tests
- Protocol 与 Runtime Core 的字段映射矩阵和双向 fixture（Mapper 实现在 Worker/Host application boundary）

### 验收

- 不 import React、Next、Hono、Runtime Core、Pi SDK/RPC 或 Node 进程模块
- 所有 wire DTO 都可独立版本化；不得直接 re-export Runtime Core 类型
- 对 Runtime Core 的共同语义使用 fixture/mapping matrix 校验，Protocol 包自身保持零 Runtime Core dependency
- 非法版本、命令、模型、图片和工具参数可被拒绝
- 全部命令和事件 round-trip 测试
- Protocol build/typecheck/test 通过
- 根 Next TypeScript 检查不回退
- `git diff --check` 通过

---

## C0 — Vite Client Shell

### 当前结果

已完成 commit：

```text
d8978b5ebcdcaa4b6775537c2ea0e663f7de677a
```

已包括：

- Vite + React 19
- TanStack Router / Query / Virtual
- `/`、`/login`、`session/cwd` search
- `/v1` HTTP client 和 gate flow
- capability 只读模式
- 虚拟化 transcript 骨架
- PWA manifest/SW/offline
- Client 边界检查
- 50 个测试

### 合并时必须处理

1. `V-C0` 已完成并通过。
2. 合到集成分支后，将 `src/protocol-shim.ts` 替换为 Protocol 包导入。
3. 根目录执行一次 `npm install`，把 Client workspace 依赖归一化进根 lockfile。
4. 不提交 Client 自己的 lockfile 或 `node_modules`。

---

## R1 — pi-sessiond Core

### 目标

实现独立、常驻、唯一权威的多会话守护进程。

### 独占文件

```text
packages/sessiond/**
```

### 交付

- 本机 endpoint、lock、instance ID、local secret
- RPC server/client
- Session registry 和并发启动去重
- Worker supervisor
- 新 session `createRequestId` 幂等
- 真实 session ID re-key
- command correlation 和 `commandId` 去重
- per-session epoch/event journal
- snapshot projection
- attach/detach/resume 原子边界
- running session 集合
- idle reaper
- Worker crash 隔离
- graceful stop / delete / sessiond shutdown reason
- 激活所需 session locator
- fake Worker 集成测试

### 关键限制

- 不创建或 import `AgentSession`/`SessionManager`
- 只依赖 Protocol、Runtime Core 中 sessiond 所需的 Port，以及 fake implementations
- 不把 socket 暴露到 LAN
- Web/Host 断开不停止 Worker
- 长命令不能阻塞 `abort`、`abort_bash`、`abort_compaction`
- `getSnapshot` 和只读查询不得启动 Worker

### 验收

- 同 session 并发 activate 只启动一个 Worker
- 两个并发 create 不合并
- 一个 Worker crash 不影响其他 Worker
- Client socket 断开后 Worker 存活
- journal gap/epoch mismatch 返回 snapshot
- idle 到期 graceful shutdown

---

## ACL1 — Pi SDK Adapter

### 目标

在唯一的 Pi SDK 防腐层中实现 ACL0 的 Ports，并把现有 `lib/rpc-manager.ts` 等代码里的 Pi 语义归一化。未来 Pi RPC Adapter 必须通过相同 contract suite。

### 独占文件

```text
packages/pi-sdk-adapter/**
```

### 建议结构

```text
packages/pi-sdk-adapter/src/
  agent/        # AgentRuntimeFactory/Port
  sessions/     # SessionCatalog/Locator
  models/       # ModelCatalog
  credentials/  # CredentialStore
  resources/    # Skills/plugins/commands
  trust/        # ProjectTrust
  mappers/      # SDK type ↔ Runtime Core Model
  internal/     # SDK-only helpers，禁止从 exports 暴露
```

每个公开子路径只导出 Runtime Core Port 的实现工厂；声明文件中不得出现 SDK 类型。

### 可参考但首轮不要删除的旧文件

```text
lib/rpc-manager.ts
lib/pi-types.ts
lib/custom-ui-terminal.ts
lib/startup-preferences.ts
lib/model-scope.ts
lib/session-reader.ts
lib/provider-listing-runtime.ts
lib/skills-service.ts
lib/side-chat-extension.ts
```

### 交付

- `PiSdkAgentRuntimeFactory` / `PiSdkAgentRuntimeAdapter`
- SDK command/event/error/message/tool/usage mapper
- SDK extension UI/headless widget adapter
- SDK session catalogue/locator adapter
- SDK model/auth/resource/trust adapters
- fork、bash-only session、startup/model/tools/reload 语义
- Adapter capability projection
- 共享 Adapter contract suite 全量通过；测试通过 factory fixture 注入 Adapter，contract test kit 不 import 具体实现

### 必须保持的 SDK 初始化顺序

1. `SessionManager.open/create`
2. 取得真实 cwd
3. 初始化 theme
4. project trust gate
5. extension/Side Chat 模式处理
6. 创建 AgentSession services
7. 解析 visible models
8. 读取默认 model
9. 判断 continuation
10. 选择初始 model scope
11. 构造 AgentSession
12. 持久化显式启动偏好
13. 设置 active tools
14. all-tools-off 时强制空 system prompt
15. bind extensions
16. 产生规范化 ready state

### 验收

- `@earendil-works/pi-*` imports 只存在于本包
- SDK 类型从任何公开 Port/Protocol 声明中消失
- 26 个规范命令映射完整
- abort 类命令可打断长操作
- fork、reload、extension shutdown 和 tool result/usage 通过契约测试
- capability 不支持项返回规范化错误

---

## ACL2 — Pi RPC Agent Adapter（未来）

### 目标

在不修改 Runtime Core、pi-web Runtime Protocol、sessiond、Host、Client 和 Worker Controller 的前提下，为 `AgentRuntimeFactory/Port` 增加 Pi RPC 实现。

### 允许修改

```text
packages/pi-rpc-adapter/**
packages/agent-worker/src/composition/**（仅注册/选择 Adapter）
配置与发布清单（由集成负责人修改）
```

### 禁止修改

```text
packages/runtime-core/**
packages/protocol/**
packages/sessiond/**
packages/host/**
packages/client/**
packages/agent-worker/src/controller/**
```

如果实现 RPC 时必须修改上述禁止范围，说明 ACL0 的规范语义或 capability 设计存在缺口；先提交架构决策变更，不能直接穿透修补。

### 验收

- `PiRpcAgentRuntimeAdapter` 通过与 SDK Adapter 相同的 contract suite
- SDK/RPC 对共同 capability 产生相同 Runtime fixtures
- RPC 缺失能力只反映在 capability/error
- SDK/RPC 切换只改 composition config，业务代码 diff 为 0
- RPC 子进程退出、stderr、坏 JSONL、request correlation、abort/kill 均有测试

---

## R2 — agent-worker Application Shell

### 目标

实现单会话进程壳：接收 Worker IPC，映射 Protocol DTO 与 Runtime Core Model，调用注入的 `AgentRuntimeFactory`。Worker Controller 不知道当前后端来自 SDK 或 RPC。

### 独占文件

```text
packages/agent-worker/**
```

### 交付

- Worker IPC server
- Protocol ↔ Runtime Core mapper
- 单 Session application controller
- typed command dispatcher
- runtime snapshot/event forwarding
- Adapter composition root（只在这里读取 `PI_WEB_AGENT_BACKEND` 并动态加载对应 Adapter 包）
- graceful shutdown
- Worker lifecycle tests（使用 fake `AgentRuntimePort`）

### 验收

- Worker 源码不 import `@earendil-works/pi-*`，不解析 Pi RPC frame
- Controller tests 全部使用 fake Runtime Port
- 26 个命令 exhaustive dispatch
- abort 类控制命令不会被长命令队列阻塞
- Adapter 选择逻辑只存在于 composition root
- Runtime Event 通过 Mapper 转成 Protocol Event，外部类型不会泄漏

---

## H0A — Hono Host Foundation

### 目标

建立可重启的薄 Host，单端口提供 HTTP、WS upgrade 和 Client 静态资源。

### 独占文件

```text
packages/host/**
```

### 交付

- `createHostApp(deps)` 依赖注入
- Node 22 Hono server
- request ID / logging / unified errors
- Host、Origin、DNS-rebinding 防护
- gate status/login/logout
- 静态 Vite assets
- SPA fallback
- SW/manifest cache headers
- health/capabilities
- sessiond 不可用时只读降级
- WebSocket upgrade 骨架和认证入口

### 中间件顺序

1. request ID / logging
2. Host/Origin protection
3. public PWA asset 白名单
4. gate
5. `/v1/*`
6. static assets
7. SPA fallback
8. error mapping

### 验收

- Host 不 import `AgentSession`、`SessionManager`、Pi SDK 或 Pi RPC parser
- API 404 不返回 `index.html`
- `/assets/*` immutable
- `sw.js`/manifest no-cache
- WS upgrade 同样经过 Host/Origin/gate
- sessiond 不可用时 Host 仍可浏览只读资源

---

## H1A — Sessions Read Model / Export

### 目标

让 Client 通过 HTTP 浏览历史，且 Worker 数量保持 0。Host application service 只依赖 `SessionCatalogPort`；当前 JSONL/SDK 读取实现在 `pi-sdk-adapter`。

### 交付

- `GET /v1/sessions`
- `GET /v1/sessions/:id`
- context / thinking / bash-output / export
- `SessionRepository` / `SessionCatalogPort` application adapter
- 注入 `SessionCatalogPort`，不直接 import `SessionManager`
- SQLite projection adapter seam
- running 状态与 sessiond snapshot 合并接口

### 关键规则

- Host 源码不 import Pi SDK、`SessionManager` 或 Pi RPC parser
- 只读请求不 attach、不 activate Worker
- 活跃 session rename/delete 必须先经 sessiond
- export 保留深树迭代 patch

---

## H1B — Files / Git / CWD / Worktree

### 目标

迁移 Host 本机资源能力并保留安全边界。

### 交付

- AllowedRootService
- `/v1/files`
- upload/range/preview/watch
- `/v1/file-index`
- `/v1/git/status`、`/v1/git/diff`
- `/v1/cwd/*`
- `/v1/worktrees`

### 关键规则

- 防 symlink escape
- LAN 下禁止任意目录扩权，除非 capability/policy 明确允许
- worktree 删除前接入 sessiond busy preflight
- `force` 只覆盖 dirty git，不等于强杀 Agent

---

## H1C — Models / Auth / Plugins / Skills

### 目标

迁移配置和资源管理 HTTP API。Host application service 只依赖 `ModelCatalogPort`、`CredentialStorePort`、`ResourceCatalogPort` 和 `ProjectTrustPort`。

### 交付

- models/models-config/catalog/discover/test
- provider API key/OAuth/logout
- plugins read/write
- skills list/search/install/update/toggle
- project trust HTTP 部分

### 关键规则

- Host 源码不 import Pi SDK、Pi 配置类或 Pi RPC parser
- status API 永不返回原始 key
- credential 文件修改保留锁
- dual-auth provider 不能重复显示
- project scope 必须 allowed-root + trust
- 插件/技能安装是高权限操作，按 capability 降级

---

## H2 — WebSocket Runtime Gateway

### 目标

把浏览器 Protocol WS 安全地代理到 sessiond，不在 Host 复制运行时状态。

### 交付

- `WS /v1/runtime`
- handshake timeout/version validation
- attach/detach/create/command
- snapshot/event forwarding
- sessiond reconnect
- per-client bounded queue/backpressure
- runtime unavailable/capability downgrade

### 关键规则

- eventId/epoch 由 sessiond 生成
- Host shutdown 只断连接，不 stop sessiond
- 慢 Client 队列超限时断开，要求重新 snapshot，不得阻塞 sessiond

---

## C1 — Client Protocol + HTTP Query

### 目标

将 C0 的 shim/stub 接到正式 Protocol 和 `/v1` HTTP 资源层。

### 交付

- 删除 `protocol-shim.ts`
- Protocol 包导入
- typed HTTP client
- Query keys/options/mutations
- sessions/models/files/git/skills/plugins/worktrees/auth
- capability provider 接 Host handshake/status
- 401 统一跳转 login
- 组件中不直接写网络请求

### 验收

Client 源码中以下检查均无结果：

```bash
grep -R 'from "next/' packages/client/src
grep -R '@earendil-works/pi-' packages/client/src
grep -R '"/api/' packages/client/src
grep -R 'new EventSource' packages/client/src
```

---

## C2 — RuntimeSocket + SessionStore

### 目标

替换旧 `useAgentSession.ts` 中的 SSE、POST 和轮询恢复逻辑。

### 交付

- 单 Runtime WebSocket
- handshake/capabilities
- 多 session attach/detach
- reconnect/backoff
- epoch/eventId 去重
- command result correlation
- command timeout
- snapshot hydration
- SessionStore/event projection
- running session IDs
- Query baseline + runtime overlay bridge
- visibility/online resume

### 关键规则

- Query 不轮询 agent state
- snapshot 与 replay 顺序不能丢事件
- final event 后只 invalidate 对应 session Query
- partial streaming message 在 Host 重启后可恢复
- command 响应丢失后不能重复 prompt

---

## C3A / C3B / C3C — Client 体验迁移

### C3A：聊天、Minimap、Side Chat

- Chat row model 与 view 分离
- TanStack Virtual 动态测量
- streaming pinned-to-bottom
- 用户上滚后不强制拉回
- Minimap 使用 virtual index，不依赖全部 DOM refs
- Side Chat 复用虚拟 transcript

### C3B：Session Sidebar

- Query session list
- running IDs 来自 SessionStore
- tree 展平为 row model
- 千级 session virtual
- rename/delete mutation
- DnD 基于 row ID，不依赖所有 DOM 存在

### C3C：资源 UI

- File Explorer/Viewer
- Worktree
- Models/Skills/Plugins
- file watch 事件只 invalidate Query
- capability 隐藏/禁用写操作

---

## DB0 — SQLite Session Index

### 目标

加速会话列表，但不改变真相源。

### 交付

- SQLite schema/migration owner
- JSONL watcher/invalidation
- session/cwd/projectRoot/parentSession 索引
- 增量更新
- 全量重建命令
- corruption recovery
- 性能基准

### 验收

- 删除数据库后可从 JSONL 重建
- 千级会话索引命中 P95 `< 50ms`
- JSONL 与 DB 不一致时以 JSONL 为准

---

## R3 / M1 — Side Chat 和跨边界 mutation

### Side Chat

- 生命周期归 sessiond
- Side Worker 继续执行 extension
- main snapshot 改成可序列化 DTO
- main Worker 不存在时从 JSONL 读取，不为查看 Side Chat 启动 main Worker

### Mutation

以下操作必须由 sessiond 协调 Worker 后再改 JSONL/文件系统：

- session rename/delete
- auto-name
- project trust reload
- worktree remove
- active session reparent

---

## CLI0 — CLI 和 single-instance

### 交付

- `pi-web`
- `pi-host`
- `pi-sessiond`
- 发现已有 sessiond 则复用
- 没有则 detached spawn
- stale socket/lock 处理
- Unix socket / Windows named pipe
- Web 退出不杀 sessiond
- `down --all` 等显式全停入口

---

## X1 — 跨进程 E2E

必须真实启动：

1. sessiond
2. 至少两个 Worker/fake Worker
3. Host
4. WS Client

必测：

- create → prompt → streaming
- prompt 中重启 Host，sessiond/Worker PID 不变
- Client attach snapshot + replay
- 一个 Worker crash 不影响另一个
- 只读 sessions/detail/context 不创建 Worker
- duplicate commandId 不重复执行
- epoch mismatch/full snapshot
- delete 先 quiesce 后 unlink
- busy trust/worktree remove 返回 409

---

## 7. 文件所有权与冲突控制

### 7.1 集成负责人独占

```text
package.json
package-lock.json
tsconfig.json
bin/**
next.config.ts
本文件的任务状态表
```

`W0` 在首个基线提交中由集成负责人独占根 package/lockfile。后续所有根 workspace 和 lockfile 修改继续由集成负责人统一落地；各包负责人只修改自己的 package manifest，并在交接中列出所需依赖。

### 7.2 各团队目录

| 团队 | 可修改 |
|---|---|
| Runtime Core | `packages/runtime-core/**`、`packages/runtime-contract-tests/**` |
| Pi SDK Adapter | `packages/pi-sdk-adapter/**` |
| Pi RPC Adapter（未来） | `packages/pi-rpc-adapter/**` |
| Protocol | `packages/protocol/**` |
| sessiond | `packages/sessiond/**` |
| Worker | `packages/agent-worker/**` |
| Host | `packages/host/**` |
| Client | `packages/client/**` |
| CLI | `packages/cli/**`，但根 `bin/**` 由集成负责人落地 |

### 7.3 旧代码限制

第一阶段默认不得修改：

```text
app/**
components/**
hooks/**
lib/rpc-manager.ts
```

这些文件保持当前 Next 产品可运行。只有被明确分派的迁移/清理任务可以修改，且必须列出精确路径。

### 7.4 跨目录改动规则

如果一个任务需要跨两个团队目录：

1. 先定义或修订 Runtime/Resource Port；跨进程字段再定义 Protocol schema。
2. Pi 具体实现只在 Adapter 团队目录修改。
3. 各团队分别提交自己的实现。
4. 由集成负责人提交最后 wiring 和根 lockfile。
5. 禁止一个开发者顺手修改另一个团队正在开发的文件。

---

## 8. 分支、Worktree 和合并规则

### 8.1 当前已有 worktree

```text
main
pi-web-worktrees/integration-v1  -> refactor/architecture-v1
pi-web-worktrees/protocol-base   -> refactor/protocol-base
pi-web-worktrees/client-shell    -> refactor/client-shell
```

### 8.2 集成基线建立

W0、ACL0 和 C0 验收、P0 按 ACL0 重审后：

1. 从 `main` 创建或更新 `refactor/architecture-v1`。
2. 合并/拣选 W0。
3. 合并/拣选 ACL0。
4. 合并/拣选 P0 和 ACL1（目录隔离）。
5. 合并/拣选 C0。
6. 根目录执行 `npm install`，统一 workspace lockfile。
7. 运行基线 typecheck/test/lint/client build，禁止 `next build`。
8. 后续所有任务从该集成 commit 创建分支/worktree。

### 8.3 分支命名

```text
refactor/<task-id>-<short-name>
```

示例：

```text
refactor/w0-workspace
refactor/acl0-runtime-core
refactor/acl1-pi-sdk-adapter
refactor/r1-sessiond-core
refactor/r2-agent-worker
refactor/h1b-host-files
refactor/c2-runtime-store
```

### 8.4 提交要求

- 一个 commit/提交序列只解决一个工作包。
- 不提交 `node_modules`、`.next`、临时 socket、运行日志和本地 credential。
- 生成文件必须注明生成方式。
- Commit message 建议：

```text
refactor(workspace): establish package build baseline
refactor(runtime-core): define agent runtime ports
refactor(pi-adapter): implement Pi SDK runtime adapter
refactor(protocol): define runtime protocol v1
refactor(sessiond): add worker supervisor and event journal
refactor(client): add runtime session store
```

### 8.5 合并顺序

```text
W0
→ ACL0
→ P0 + ACL1（共享 Runtime 语义，目录隔离，可并行）
→ C0
→ R1 + H0A + C1（目录隔离，可并行评审）
→ R2 + H0B
→ H1A/H1B/H1C + H2 + R3
→ C2
→ C3A/C3B/C3C + DB0
→ CLI0 + M1
→ X1 + PWA1
→ L1
→ REL1
```

---

## 9. 验证与质量门槛

### 9.1 所有任务最低要求

```bash
git diff --check
```

并运行本工作包的：

- typecheck
- unit tests
- lint（适用时）
- build（适用时）

### 9.2 根项目

```bash
node_modules/.bin/tsc --noEmit --incremental false
npm test
npm run lint
```

> 开发期间永远不要运行 `next build`。

### 9.3 Client

```bash
npm run typecheck --workspace packages/client
npm run test --workspace packages/client
npm run build --workspace packages/client
npm run check:boundaries --workspace packages/client
```

### 9.4 Protocol / Runtime Core / Adapter / Runtime 包

目标脚本：

```bash
npm run build --workspace packages/runtime-core
npm run test --workspace packages/runtime-core
npm run test --workspace packages/runtime-contract-tests
npm run build --workspace packages/protocol
npm run test --workspace packages/protocol
npm run typecheck --workspace packages/pi-sdk-adapter
npm run test --workspace packages/pi-sdk-adapter
npm run typecheck --workspace packages/sessiond
npm run test --workspace packages/sessiond
npm run typecheck --workspace packages/agent-worker
npm run test --workspace packages/agent-worker
```

增加架构边界检查：

- `packages/runtime-core/**` 无 Protocol/Pi SDK/Pi RPC import
- `packages/pi-sdk-adapter/**` 之外无 `@earendil-works/pi-*` import
- `packages/pi-rpc-adapter/**` 之外无 Pi RPC frame/method parser
- Host/sessiond/Worker Controller 无 `AgentSession`、`SessionManager`、SDK Model/Event import

### 9.5 独立验证要求

以下改动必须由非实现者执行 `verification`：

- Runtime Core Ports / Adapter contract suite
- Protocol 契约
- Pi SDK/RPC Adapter
- sessiond/Worker
- Host security/gate/WS
- SQLite/migration
- CLI/single-instance
- 跨进程 lifecycle
- 修改 3 个以上文件的核心 Client runtime

验证结果只能是：

- `PASS`
- `FAIL`
- `PARTIAL`（环境限制必须明确）

`FAIL` 后由原实现者修复，再由同一个验证者复验。

---

## 10. 协作和同步格式

### 10.1 开始任务时

在任务看板填写，并发送：

```text
任务：ACL0 Runtime Core + Pi ACL Contracts
负责人：<name>
状态：IN_PROGRESS
Base commit：<integration commit>
Branch：refactor/acl0-runtime-core
Worktree：<absolute path>
修改范围：packages/runtime-core/**, packages/runtime-contract-tests/**
预计交付：<date/milestone>
已知依赖：W0 DONE
```

### 10.2 每日/阶段同步

```text
任务：<TASK-ID>
状态：IN_PROGRESS / BLOCKED / IN_REVIEW
已完成：
- ...

下一步：
- ...

阻塞：
- 无 / 具体依赖、接口或错误

契约变化：
- 无 / 需要修改的 Protocol schema 和原因

验证：
- 已运行命令及结果
```

### 10.3 任务交接模板

```text
任务：<TASK-ID + 名称>
状态：IN_REVIEW
Branch：<branch>
Commit：<hash>
Base commit：<hash>

修改文件：
- path

实现摘要：
- ...

契约/API：
- 新增/修改的 schema、method、route、event

验证结果：
- command: PASS/FAIL

未完成/残余风险：
- ...

集成步骤：
1. ...
2. ...

禁止遗漏：
- 是否改了 root package/lockfile
- 是否生成 migration/build artifact
- 是否需要环境变量
```

### 10.4 阻塞升级规则

以下情况不要自行猜测，立即标记 `BLOCKED`：

- Runtime Core Port 无法表达所需规范语义
- Protocol 无法表达所需 wire 字段
- 需要把 SDK/RPC 类型带出 Adapter 边界
- 需要在 Host/sessiond/Worker Controller 中判断具体后端类型
- 需要修改其他团队独占文件
- snapshot 无法恢复某类运行态
- Host 与 sessiond 对同一 mutation 所有权不清
- JSONL 写入可能与活跃 Worker 竞争
- LAN 文件权限可能扩大
- 需要改变已冻结决策

---

## 11. Milestone 验收门

## M0 — Foundation

完成条件：

- `W0 DONE`
- `ACL0 DONE`
- `P0 DONE`
- `C0 DONE`
- 集成分支建立
- 根 workspace/lockfile 正常
- Runtime Core/Protocol/Client 各自 build/test 通过

## M1 — Runtime Separated

完成条件：

- `ACL1`, `R1`, `R2`, `CLI0` 基础完成
- 每 session 一个 Worker
- Worker Controller 只依赖 `AgentRuntimePort`
- SDK imports 只存在于 `pi-sdk-adapter`
- Host/Web 断开不杀 Worker
- 只读查询不创建 Worker
- event journal/snapshot/attach 工作
- SDK Adapter 通过共享 contract suite
- 使用 fake `AgentRuntimePort` 可完成 Worker/sessiond 集成测试

## M2 — Read-only Vertical Slice

完成条件：

- Hono 托管 Vite Client
- Client 可登录并浏览 sessions/detail/context
- capability 无 `agent` 时只读 UI 正常
- 历史浏览 Worker 数为 0

## M3 — Runtime Vertical Slice

完成条件：

- Client 通过 WS create/attach/prompt/abort
- streaming snapshot 可恢复
- Host 重启后继续 attach
- duplicate commandId 不重复 prompt
- Worker crash 隔离

## M4 — Feature Parity

完成条件：

- model/thinking/tools/compact/fork/navigate/bash/reload
- files/git/worktree
- models/auth/plugins/skills
- Side Chat
- rename/delete/auto-name/trust
- 核心现有功能无回退

## M5 — Scale + PWA

完成条件：

- SQLite 指标达标
- Chat/Sidebar Virtual 达标
- LAN 强制 gate
- 手机 PWA 后台恢复
- capability 降级完整

## M6 — Legacy Removal

完成条件：

- 删除旧 Agent SSE/运行态轮询
- Next 不再承载最终产品路径
- 发布包包含 Host/Client/sessiond/Worker/Runtime Core/Pi SDK Adapter/CLI
- 安装、升级、卸载和 `down --all` 验证完成

---

## 12. 已知风险

| 风险 | 对策 |
|---|---|
| Pi SDK/RPC 接入细节越过 ACL | 依赖检查 + package boundary tests；只有对应 Adapter 包允许外部类型/import |
| SDK/RPC 行为不一致 | 两种 Adapter 运行同一 `runtime-contract-tests`；差异通过 capability 显式表达 |
| Protocol 与 Runtime Core 锁死 | 保持独立模型和 Mapper；分别版本化、分别测试 |
| partial assistant 尚未写 JSONL | sessiond snapshot 保存 Runtime Core streaming message 投影 |
| snapshot 和订阅之间丢事件 | sessiond 内原子建立 boundary + subscription + replay |
| 长 compact/bash 阻塞 abort | 控制类命令允许并发下发，不进同一串行队列 |
| fork 后旧 wrapper 状态污染 | fork 返回后关闭旧 Worker，重新激活旧 session 时重读原文件 |
| Side Chat 的 SDK snapshot 含不可序列化对象 | Runtime Core 定义 `SideChatMainSnapshot` DTO；Adapter 负责从 SDK/RPC 构造，Worker/sessiond 只传规范 DTO |
| Host 与 Worker 同时写 JSONL | active mutation 必须由 sessiond quiesce/协调 |
| 慢浏览器阻塞 sessiond | Host 每连接有界队列，超限断开并重新 snapshot |
| SQLite 与 JSONL 不一致 | JSONL 优先，索引可删除重建 |
| Client Query 与 RuntimeStore 双写 | Query 是持久化基线，SessionStore 是实时 overlay，以 revision/cursor 对齐 |
| 外部 pi CLI 同时写同一 JSONL | 首期记录为已知限制，不宣称已解决；后续再评估锁策略 |
| 多 worktree 同改 lockfile | root package/lockfile 仅集成负责人修改 |
| 开发运行 Next build 污染 `.next` | 明确禁止，CI/文档持续提醒 |

---

## 13. 给新同事的最短说明

可以直接把下面这段发给新加入的同事：

> 请先阅读 `docs/refactor-execution-plan.md`。它是本次 pi-web 重构的任务和协作单一事实源。找到状态为 `READY` 的任务，确认依赖和文件范围后认领；从 `refactor/architecture-v1` 最新集成 commit 创建独立 worktree。不要跨任务修改其他团队目录，也不要直接修改根 `package.json`/lockfile。完成后按文档中的交接模板提交 commit、验证结果和残余风险。

架构背景需要进一步了解时，再阅读：

```text
docs/refactor-architecture.md
AGENTS.md
```

---

## 14. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-08-11 | ACL 方案语义收口：新增 W0、ACL2、capability/映射矩阵、composition root 规则和可替换性验收；Protocol 正式命名为 pi-web Runtime Protocol v1 |
| 2026-08-10 | 暂停期间修订架构：新增 `runtime-core` Ports 与 Pi 防腐层；当前 `pi-sdk-adapter`、未来 `pi-rpc-adapter`；Protocol 与 Runtime Model 分离；Host/sessiond/Worker Controller 禁止直接依赖 Pi 类型 |
| 2026-08-10 | 项目负责人要求暂停所有工作：停止 Protocol 实现代理；P0/I0/H0A 标记 PAUSED；pix Issues #1/#2 已留言通知；Draft PR #14/#15 保留且不合并 |
| 2026-08-10 | 分工落地：`FFatTiger` 负责 P0/I0；`Pililink` 分派 H0A，可立即从 `refactor/h0-host-foundation` 开始；创建 pix Issues #1/#2 和 pi-web Draft PR #14/#15 |
| 2026-08-10 | Protocol `478ca71` 独立验证 FAIL；P0 退回修复：RPC/IPC method-payload 强绑定、cwd lifecycle、streaming message、extension response、整数 event cursor |
| 2026-08-10 | 创建执行与协作手册；记录 P0、C0 当前进度；冻结 Wave 0～3、文件所有权、验收和同步规则 |
