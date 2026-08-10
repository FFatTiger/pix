# pi-web 架构重构执行与协作手册

> **全局状态：`PAUSED`（项目负责人于 2026-08-10 要求暂停所有工作）。**
> 在收到明确恢复通知前：不得继续开发、提交、推送、合并、认领新任务或启动自动化实现；保留现有分支、worktree、Draft PR 和本地未提交进度。
>
> **本文件是本轮重构的执行单一事实源（Execution SSOT）。**
> 架构原则与目标见 [`refactor-architecture.md`](./refactor-architecture.md)；所有任务认领、依赖、文件所有权、状态同步、验收和合并顺序以本文件为准。  
> 新同事加入项目时，先阅读本文件，再阅读 `AGENTS.md` 和自己任务涉及的源码。

- 最后更新：2026-08-10 10:45 CST
- 项目状态：`PAUSED`
- 目标主线：Vite Client + Hono Host + `pi-sessiond` + 每会话 Worker + Protocol v1
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
2. 一个 Agent Session 对应一个独立 Worker 进程。
3. 只读浏览历史不创建 Worker。
4. Client 实时状态使用一条 `WS /v1/runtime`，支持 `snapshot + resume`。
5. HTTP 资源接口统一为 `/v1/*`。
6. Client 不 import Pi SDK、Next 服务端代码或 Node-only 模块。
7. Host 不创建、不持有 `AgentSession`。
8. JSONL 和 `~/.pi` 继续是真相源。
9. Hono 同一端口托管 `/v1`、WebSocket 和 Vite 静态资源。
10. PWA 支持电脑本机和手机连接电脑 Host；LAN 模式强制 gate。

### 2.2 本轮不做

- Tauri / Electron 安装包
- 手机本地运行 Agent
- 用 SQLite 取代 JSONL
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

---

## 3. 目标进程与包边界

```text
packages/
  protocol/       纯协议：Zod schema、版本、共享 DTO
  sessiond/       会话权威、Worker 调度、事件日志、resume
  agent-worker/   每会话 Pi SDK 执行进程
  host/           Hono HTTP、WS 网关、gate、文件/git、静态资源
  client/         Vite React + TanStack + PWA
  cli/            pi-web / pi-host / pi-sessiond 启停入口
```

### 3.1 依赖方向

```text
client ───────────────▶ protocol
host ─────────────────▶ protocol
sessiond ─────────────▶ protocol
agent-worker ─────────▶ protocol
cli ──────────────────▶ host/sessiond 启动入口

host ──本机 RPC───────▶ sessiond ──Node IPC──────▶ agent-worker
```

禁止出现：

```text
client ──▶ Pi SDK / Node fs / sessiond 内部模块
host ────▶ AgentSession / agent-worker 内部实现
worker ──▶ Host cache / React / Hono
protocol ▶ React / Next / Hono / Pi SDK / Node 进程管理
```

### 3.2 数据所有权

| 数据 | 权威所有者 | 说明 |
|---|---|---|
| 运行中 AgentSession | sessiond + 对应 Worker | sessiond 管生命周期，Worker 持有 SDK 实例 |
| Runtime eventId/epoch | sessiond | Host 不生成事件编号 |
| Runtime UI 投影 | sessiond snapshot + Client SessionStore | Query 不轮询实时状态 |
| 历史 JSONL | `~/.pi` 文件 | 与 pi CLI 共用真相源 |
| 会话列表索引 | Host SQLite 投影 | 可重建，不替代 JSONL |
| 文件/git/worktree | Host | 受 allow-root 和 gate 保护 |
| models/auth/plugins/skills 配置 | Host | 可使用 Pi 配置类，但不能创建 AgentSession |
| UI 本地偏好 | Client localStorage/IndexedDB | theme、面板、草稿等 |

---

## 4. 已冻结的架构决策

修改以下决策必须先更新本节，并通知所有受影响任务负责人。

| ID | 决策 | 状态 |
|---|---|---|
| `D-001` | Protocol v1 使用 Zod；公开类型从 schema 推导 | 已冻结 |
| `D-002` | Client、Host、sessiond、Worker 只能通过 Protocol DTO 交互 | 已冻结 |
| `D-003` | sessiond 是运行时唯一权威；Host 只代理和 attach | 已冻结 |
| `D-004` | 一个 Worker 只持有一个 `AgentSession` | 已冻结 |
| `D-005` | 只有 Worker 可以创建/持有 `AgentSession` | 已冻结 |
| `D-006` | Host/sessiond 可用 `SessionManager` 做只读 JSONL 解析；不得因此创建 Worker | 已冻结 |
| `D-007` | HTTP 历史浏览与 SQLite read model 归 Host；sessiond 只保留激活所需 locator 和 mutation 协调 | 已冻结 |
| `D-008` | 浏览器实时主通道只有 `WS /v1/runtime`；不保留 Agent SSE/运行态轮询作为新架构主路径 | 已冻结 |
| `D-009` | 每个命令带 `commandId`；sessiond 在 session/epoch 内 at-most-once | 已冻结 |
| `D-010` | attach 使用 `epoch + lastEventId`；gap 或 epoch 变化时回完整 snapshot | 已冻结 |
| `D-011` | 首期事件日志仅在 sessiond 内存保存；默认每会话最多 2,000 条或 10 MiB，任一先到即淘汰，可配置 | 已冻结 |
| `D-012` | Worker 崩溃不自动重放 prompt；标记 crashed，用户显式重新激活 | 已冻结 |
| `D-013` | JSONL 是真相源；SQLite 损坏后必须可从 JSONL 重建 | 已冻结 |
| `D-014` | Runtime snapshot 必须包含 partial streaming message、队列、extension UI、compaction/bash/model/tools 等可恢复状态 | 已冻结 |
| `D-015` | fork 保持现有 pi-web 语义：创建独立 JSONL 和 `parentSession`；旧 Worker 在返回结果后退出 | 已冻结 |
| `D-016` | all-tools-off 时 `toolNames=[]`，且 system prompt 持续保持空 | 已冻结 |
| `D-017` | 旧 Next 应用在迁移期间保持可运行，但默认不开发新的 sessiond→Next SSE 兼容桥；除非集成负责人显式开启该工作包 | 已冻结 |
| `D-018` | LAN 模式强制 gate；sessiond 永远只监听本机，不直接暴露到 LAN | 已冻结 |
| `D-019` | capability 降级按能力值判断，不按 web/pwa/app 外壳判断 | 已冻结 |
| `D-020` | 开发期间禁止运行 `next build` | 已冻结 |

### 4.1 Protocol v1 必须覆盖的命令

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

### 4.2 Protocol v1 最低事件集合

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

---

## 5. 当前任务看板

> 本表由集成负责人维护。状态发生变化时，在同一个提交中更新本表。

### 5.1 Wave 0：共享基线

| ID | 工作包 | 状态 | 负责人 | 分支 / Worktree | 依赖 | 当前结果 |
|---|---|---|---|---|---|---|
| `G0` | 执行与协作手册 | `DONE` | 当前会话 | `main` | 无 | `docs/refactor-execution-plan.md` |
| `P0` | Workspace + Protocol v1 | `PAUSED` | `FFatTiger` / `protocol-base-impl` | `refactor/protocol-base`；[PR #15](https://github.com/FFatTiger/pi-web/pull/15)；[pix #1](https://github.com/FFatTiger/pix/issues/1) | 无 | Protocol 修复代理已停止；保留 commit `478ca71` 及 worktree 内当前进度，等待恢复通知 |
| `V-P0` | Protocol v1 独立验证 | `PAUSED` | `protocol-base-verifier` | 只读验证 `refactor/protocol-base` | `P0` | 首轮 FAIL：4 个阻塞类契约问题；等待修复后由同一验证者复验 |
| `C0` | Vite Client Shell | `DONE` | `client-shell-impl` | `refactor/client-shell` / `pi-web-worktrees/client-shell` | 无 | commit `d8978b5`；登录 deep-link 修复；7 files / 50 tests、typecheck/build/boundaries 通过 |
| `V-C0` | Client Shell 独立验证 | `DONE` | `client-shell-verifier` + 集成负责人复跑 | 只读验证 `refactor/client-shell` | `C0` | 首轮 HIGH 已关闭；主会话复跑 typecheck、50 tests、build、boundaries、diff check 全部 PASS |
| `I0` | 归一化集成分支和 root lockfile | `PAUSED` | `FFatTiger` | `refactor/architecture-v1`（已创建并推送） | `V-P0`, `V-C0` | 不合并 P0/C0、不归一化 lockfile，等待恢复通知 |

### 5.2 Wave 1：Runtime、Host、Client 数据层并行

| ID | 工作包 | 状态 | 负责人 | 建议分支 | 依赖 | 主要目录 |
|---|---|---|---|---|---|---|
| `R1` | pi-sessiond Core | `BLOCKED` | 待认领 | `refactor/sessiond-core` | `P0`, `I0` | `packages/sessiond/**` |
| `R2` | agent-worker Core | `BLOCKED` | 待认领 | `refactor/agent-worker-core` | `P0`, `I0` | `packages/agent-worker/**` |
| `H0A` | Protocol-independent Hono Host Foundation | `PAUSED` | `Pililink`（已通知暂停） | `refactor/h0-host-foundation`；[pix #2](https://github.com/FFatTiger/pix/issues/2) | 无（禁止 runtime wiring） | 不得开始或继续开发；保留分支，等待恢复通知 |
| `H0B` | Hono Host Protocol/runtime wiring | `BLOCKED` | 待认领 | `refactor/host-runtime-wiring` | `P0`, `I0`, `H0A`, `R1` | 后续接正式 Protocol/sessiond；不得由 H0A 自行发明协议 |
| `C1` | Client Protocol + HTTP Query | `BLOCKED` | 待认领 | `refactor/client-data` | `P0`, `C0`, `I0` | `packages/client/src/api/**` 等 |
| `CLI0` | CLI / sessiond single-instance 启动 | `BLOCKED` | 待认领 | `refactor/cli-runtime` | `R1`, `R2`, `H0` | `packages/cli/**`, `bin/**` |

### 5.3 Wave 2：可继续横向拆分

| ID | 工作包 | 状态 | 负责人 | 依赖 | 主要目录 |
|---|---|---|---|---|---|
| `H1A` | Sessions read model / export | `BLOCKED` | 待认领 | `H0` | `packages/host/src/services/sessions*`, routes |
| `H1B` | Files / git / cwd / worktree | `BLOCKED` | 待认领 | `H0` | Host 对应 services/routes |
| `H1C` | Models / auth / plugins / skills | `BLOCKED` | 待认领 | `H0` | Host 对应 services/routes |
| `H2` | WS Runtime Gateway | `BLOCKED` | 待认领 | `H0`, `R1` | `packages/host/src/runtime/**` |
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
| `PWA1` | LAN gate / 配对 / capability 降级 | `BLOCKED` | 待认领 | `H0`, `C1`, `C2` |
| `M1` | Session rename/delete/trust/worktree 协调 | `BLOCKED` | 待认领 | `R1`, `H1A`, `H1B`, `H1C` |
| `L1` | 旧 Next runtime/SSE/轮询移除 | `BLOCKED` | 待认领 | `X1`, `PWA1`, 功能对等验收 |
| `REL1` | 发布/安装/升级验证 | `BLOCKED` | 待认领 | `L1`, 全量验证 |

### 5.5 当前关键路径

```text
P0 ─▶ I0 ─┬─▶ R1 ─┬─▶ H2 ─▶ C2 ─▶ X1
           ├─▶ R2 ─┘
           ├─▶ H0 ─┬─▶ H1A/B/C
           │        └─▶ H2
           └─▶ C1 ───────▶ C2

C0 ─▶ V-C0 ─▶ I0
```

---

## 6. 工作包说明

## P0 — Workspace + Protocol v1

### 目标

建立所有包共享的稳定契约和 npm workspace 基线。

### 独占文件

```text
package.json
package-lock.json
tsconfig.json（如确有必要）
packages/protocol/**
```

### 交付

- `workspaces: ["packages/*"]`
- Protocol v1 Zod schemas 和推导类型
- capabilities、errors、handshake
- 26 个 RuntimeCommand
- RuntimeEvent、RuntimeSnapshot
- 浏览器 WS envelope
- Host ↔ sessiond RPC envelope
- sessiond ↔ Worker IPC envelope
- contract tests
- ESM + declarations 构建产物

### 验收

- 不 import React、Next、Hono、Pi SDK 或 Node 进程模块
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
15f3722895a353ee908b7f3226a54223b8d878bd
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
- 29 个测试

### 合并时必须处理

1. 等 `V-C0` 独立验证结论。
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

- 不创建 `AgentSession`
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

## R2 — agent-worker Core

### 目标

把当前 `lib/rpc-manager.ts` 的单会话 Pi SDK 行为提取成独立进程。

### 独占文件

```text
packages/agent-worker/**
```

### 可参考但首轮不要删除的旧文件

```text
lib/rpc-manager.ts
lib/pi-types.ts
lib/custom-ui-terminal.ts
lib/startup-preferences.ts
lib/model-scope.ts
lib/side-chat-extension.ts
```

### 交付

- Worker IPC server
- SDK session factory
- 单 Session controller
- typed command dispatcher
- SDK event adapter
- runtime snapshot producer
- extension UI/headless widget
- graceful shutdown
- fork JSONL 语义
- bash-only session 持久化
- startup/model/tools/reload 行为测试

### 必须保持的初始化顺序

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
16. 发送 ready + 初始 snapshot

### 验收

- 26 个命令 exhaustive dispatch
- abort 类命令可打断长操作
- fork 先返回结果，再关闭旧 Worker
- extension shutdown 在 dispose 前执行
- reload 后工具与空 system prompt 规则仍有效
- SDK Event 不直接泄漏到 Protocol

---

## H0 — Hono Host Skeleton

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

- Host 不 import `AgentSession`
- API 404 不返回 `index.html`
- `/assets/*` immutable
- `sw.js`/manifest no-cache
- WS upgrade 同样经过 Host/Origin/gate
- sessiond 不可用时 Host 仍可浏览只读资源

---

## H1A — Sessions Read Model / Export

### 目标

让 Client 通过 HTTP 浏览历史，且 Worker 数量保持 0。

### 交付

- `GET /v1/sessions`
- `GET /v1/sessions/:id`
- context / thinking / bash-output / export
- `SessionRepository` 抽象
- 现有 JSONL/SessionManager adapter
- SQLite adapter seam
- running 状态与 sessiond snapshot 合并接口

### 关键规则

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

迁移配置和资源管理 HTTP API，不把 AgentSession 搬进 Host。

### 交付

- models/models-config/catalog/discover/test
- provider API key/OAuth/logout
- plugins read/write
- skills list/search/install/update/toggle
- project trust HTTP 部分

### 关键规则

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

例外：`P0` 在首个基线提交中独占根 package/lockfile。P0 完成后，所有根文件修改权移交集成负责人。

### 7.2 各团队目录

| 团队 | 可修改 |
|---|---|
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

1. 先定义 Protocol 或 service interface。
2. 两边分别提交自己的实现。
3. 由集成负责人提交最后 wiring。
4. 禁止一个开发者顺手修改另一个团队正在开发的文件。

---

## 8. 分支、Worktree 和合并规则

### 8.1 当前已有 worktree

```text
main
pi-web-worktrees/protocol-base   -> refactor/protocol-base
pi-web-worktrees/client-shell    -> refactor/client-shell
```

### 8.2 集成基线建立

P0 和 C0 验收后：

1. 从 `main` 创建 `refactor/architecture-v1`。
2. 合并/拣选 P0。
3. 合并/拣选 C0。
4. 根目录执行 `npm install`，统一 workspace lockfile。
5. 运行基线 typecheck/test/lint/client build，禁止 `next build`。
6. 后续所有任务从该集成 commit 创建分支/worktree。

### 8.3 分支命名

```text
refactor/<task-id>-<short-name>
```

示例：

```text
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
refactor(protocol): define runtime protocol v1
refactor(sessiond): add worker supervisor and event journal
refactor(client): add runtime session store
```

### 8.5 合并顺序

```text
P0
→ C0
→ R1 + R2 + H0 + C1（目录隔离，可并行评审）
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

### 9.4 Protocol / Runtime 包

目标脚本：

```bash
npm run build --workspace packages/protocol
npm run test --workspace packages/protocol
npm run typecheck --workspace packages/sessiond
npm run test --workspace packages/sessiond
npm run typecheck --workspace packages/agent-worker
npm run test --workspace packages/agent-worker
```

### 9.5 独立验证要求

以下改动必须由非实现者执行 `verification`：

- Protocol 契约
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
任务：R1 pi-sessiond Core
负责人：<name>
状态：IN_PROGRESS
Base commit：<integration commit>
Branch：refactor/r1-sessiond-core
Worktree：<absolute path>
修改范围：packages/sessiond/**
预计交付：<date/milestone>
已知依赖：P0/I0 DONE
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

- Protocol 无法表达所需字段
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

- `P0 DONE`
- `C0 DONE`
- 集成分支建立
- 根 workspace/lockfile 正常
- Client/Protocol 各自 build/test 通过

## M1 — Runtime Separated

完成条件：

- `R1`, `R2`, `CLI0` 基础完成
- 每 session 一个 Worker
- Host/Web 断开不杀 Worker
- 只读查询不创建 Worker
- event journal/snapshot/attach 工作

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
- 发布包包含 Host/Client/sessiond/Worker/CLI
- 安装、升级、卸载和 `down --all` 验证完成

---

## 12. 已知风险

| 风险 | 对策 |
|---|---|
| snapshot 和订阅之间丢事件 | sessiond 内原子建立 boundary + subscription + replay |
| partial assistant 尚未写 JSONL | snapshot 保存 streaming message |
| 长 compact/bash 阻塞 abort | 控制类命令允许并发下发，不进同一串行队列 |
| fork 后旧 wrapper 状态污染 | fork 返回后关闭旧 Worker，重新激活旧 session 时重读原文件 |
| Side Chat 带不可序列化 SessionManager | 改为 DTO + host request |
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
| 2026-08-10 | 项目负责人要求暂停所有工作：停止 Protocol 实现代理；P0/I0/H0A 标记 PAUSED；pix Issues #1/#2 已留言通知；Draft PR #14/#15 保留且不合并 |
| 2026-08-10 | 分工落地：`FFatTiger` 负责 P0/I0；`Pililink` 分派 H0A，可立即从 `refactor/h0-host-foundation` 开始；创建 pix Issues #1/#2 和 pi-web Draft PR #14/#15 |
| 2026-08-10 | Protocol `478ca71` 独立验证 FAIL；P0 退回修复：RPC/IPC method-payload 强绑定、cwd lifecycle、streaming message、extension response、整数 event cursor |
| 2026-08-10 | 创建执行与协作手册；记录 P0、C0 当前进度；冻结 Wave 0～3、文件所有权、验收和同步规则 |
