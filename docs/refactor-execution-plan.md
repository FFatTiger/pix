# pix 新架构执行计划

> **执行单一事实源（SSOT）**
>
> 当前目标不是继续维护旧 Next.js 单体，而是在独立的 `pix` 仓库中交付新架构产品。
> 第一里程碑必须是一个可以实际构建和启动的独立应用。

- 最后更新：2026-08-13
- 项目状态：`ACTIVE`
- 当前里程碑：`M3 — Read and Operate`（M1、M2 已完成并通过 GPT 最终验证）
- 当前仓库：`/Users/proxy/Documents/program/pix`
- 旧成果来源：旧 Next 单体 worktree（精确路径与来源 commit 见 `migration-ledger.md`），迁移完成前只读保留
- 产品主线：Vite Client + Hono Host + 独立 `pix-sessiond` + 每会话 Worker + Runtime Protocol + Pi 防腐层

---

## 1. 当前目标

把旧的：

```text
Next.js 页面/API/静态资源
└── Web 进程内 AgentSession
```

替换为：

```text
Browser / PWA
      │
      ├── HTTP /v1/*
      └── WS /v1/runtime
      ▼
Hono Host（可随时重启）
      │ 本机 RPC
      ▼
pix-sessiond（常驻会话权威）
      │ Node IPC
      ▼
agent-worker × N（每会话一个进程）
      │ AgentRuntimePort
      ▼
PiSdkAdapter（当前）/ PiRpcAdapter（未来）
```

### 1.1 不可变约束

1. `pix` 是独立产品仓库，不以旧 Next.js 单体为运行时或构建时依赖。
2. `pix` 不包含 Next.js 产品路径：无根 `app/`、无 `next.config.*`、无 Next CLI、无 `.next`。
3. Client 使用 Vite + React + TanStack。
4. Host 使用 Hono，在同一端口提供 `/v1`、WebSocket 和 Client 静态资源。
5. Host 可以退出或重启，但不得因此停止 sessiond 或 Worker。
6. sessiond 是运行时唯一权威；Host 只做代理和 attach。
7. 一个 Agent Session 对应一个独立 Worker 进程。
8. Worker Controller 只依赖 `AgentRuntimePort`，不依赖具体 Pi 后端。
9. Pi SDK import 只允许存在于 `packages/pi-sdk-adapter/**`。
10. Runtime Core Model 与 Protocol DTO 分离，通过显式 Mapper 转换。
11. JSONL / `~/.pi` 继续是真相源；SQLite 只能是可重建投影。
12. 只读历史浏览不得启动 Worker。
13. 浏览器实时主通道只有 `WS /v1/runtime`，不新增 SSE 或运行态轮询。
14. capability 只能声明已经完整接通并验证的产品能力。
15. 不为保留旧 Next 兼容性引入桥接代码。

### 1.2 当前明确不做

- 迁移旧 `app/**`、`components/**`、`hooks/**`、`lib/**`
- 迁移旧 Next API routes 或旧 CLI 入口（`bin/`）
- 保持旧 Next 产品在 `pix` 中可运行
- Tauri / Electron
- 手机本地运行 Agent
- 用 SQLite 取代 JSONL
- Pi RPC Adapter 实现
- sessiond 无停机升级
- Worker 崩溃后自动重放 prompt

---

## 2. 第一里程碑定义

## M1 — Bootable Standalone App（`DONE`）

完成证据：`a7e9e29`；GPT 最终独立对抗验证 `PASS`，B2/B4/B5 全部验收通过，M2 已解锁。

M1 的含义是：**新架构在独立 `pix` 仓库中成为一个真实、可安装、可构建、可启动的应用。**

M1 不要求 Agent prompt 已经可用；最小 Runtime happy path 属于 M2。但 M1 不能只是单包 demo 或开发服务器。

### 2.1 M1 必须交付

1. 所有源码、构建配置和依赖都位于 `pix`。
2. 根 workspace 不包含 Next 依赖和 Next 产品入口。
3. 以下命令成立：

   ```bash
   npm ci
   npm run build
   npm run start -- --hostname 127.0.0.1 --port 30141 --no-open
   ```

4. 启动命令会：
   - 发现并复用已有 sessiond，或启动独立 sessiond；
   - 启动 Hono Host；
   - 由 Host 托管构建后的 Vite Client；
   - 使用绝对路径定位 Client dist，不依赖启动 cwd。
5. 浏览器访问 `/` 能加载真实 Client JavaScript/CSS 并渲染应用状态。
6. 以下端点真实可用：
   - `GET /v1/health`
   - `GET /v1/capabilities`
   - `GET /v1/bootstrap`
7. Client 从真实 Host API 读取状态，不使用硬编码 demo session。
8. Host 退出后 sessiond PID 保持不变。
9. 只有显式 `pix down --all` 才停止 sessiond。
10. 未接通的 Agent/files/sessions 能力不得出现在 capability 中。

### 2.2 M1 不要求

- 创建 Agent Session
- prompt、streaming、abort
- Worker 进程
- 历史会话列表
- models/auth/skills/plugins
- files/git/worktree
- PWA/LAN
- SQLite

### 2.3 M1 验收

```bash
cd /Users/proxy/Documents/program/pix
npm ci
npm run check:architecture
npm run typecheck
npm test
npm run build
npm run test:e2e:startup
```

手工生命周期验收：

```bash
npm run start -- --hostname 127.0.0.1 --port 30141 --no-open
curl -fsS http://127.0.0.1:30141/v1/health
curl -fsS http://127.0.0.1:30141/v1/capabilities
curl -fsS http://127.0.0.1:30141/v1/bootstrap
curl -fsS -H 'Accept: text/html' http://127.0.0.1:30141/
npm run cli -- status
```

停止 Host 后，`status` 必须报告相同 sessiond PID。最后：

```bash
npm run cli -- down --all
npm run cli -- status
```

---

## 3. 现有成果重新评估

旧成果只能标记为迁移来源，不能因为旧分支通过过测试就直接在 `pix` 中标记 `DONE`。迁移、重建 lockfile 和 composition 后必须重新验证。

| 成果 | 来源 | 评估 | 新计划 |
|---|---|---|---|
| Runtime Core | `integration-v1/packages/runtime-core` | 规范模型、Ports、边界测试完整；可复用 | 迁入 `B1`，重新 build/test |
| Runtime Contract Tests | `integration-v1/packages/runtime-contract-tests` | 契约矩阵和 reference fake 完整；可复用 | 迁入 `B1` |
| Protocol v1 | `integration-v1/packages/protocol` | HTTP/WS/sessiond/Worker schema 较完整；可复用 | 迁入 `B1`；M2 前执行 `R0` 修正 |
| Hono Host | `integration-v1/packages/host` | gate/security/static/server 完整；RuntimeWsSeam 和 production composition 缺失 | M1 迁基础；M2 补 Runtime Gateway |
| Vite Client | `client-data/packages/client` | 可构建，已接正式 Protocol/typed HTTP；RuntimeSocket 仍是 stub | M1 迁 boot surface；M2 补 RuntimeStore |
| Pi SDK Adapter | `pi-sdk-adapter/packages/pi-sdk-adapter` | Agent/data/resource 能力较完整，但旧计划仍记录 4 个未关闭问题 | M2 拆出 Agent Adapter；数据/resource 后移 |
| sessiond Core | `sessiond-core/packages/sessiond` | service/RPC/journal/attach 逻辑已有；全部未提交，缺 daemon 与真实 Worker factory | M1 迁 source-only 并完成 daemon；M2 补 Worker factory |
| Agent Worker | 无 | 完全缺失 | M2 新建 |
| CLI / Composition | 无新架构实现 | 旧入口仍启动 Next | M1 新建，属于里程碑核心 |
| Host Runtime Wiring | 只有 seam | 未接 sessiond | M2 新建 |
| Client RuntimeSocket | no-op stub | 不可用于 Runtime | M2 新建 |

### 3.1 迁移可用性结论

**可直接作为候选迁移：**

- `runtime-core`
- `runtime-contract-tests`
- `protocol`
- Host 的 gate/security/static/server 基础
- Client 的 Vite shell、gate、health/capability HTTP 基础
- sessiond 的 service/RPC/journal/source tests
- Pi SDK Adapter 的 Agent 路径

**需要补齐后才构成产品：**

- 独立 root workspace
- production composition root
- sessiond daemon main
- CLI 和 single-instance 生命周期
- Host 对 Client dist 的生产装配
- Startup E2E

**M2 才补：**

- agent-worker
- child-process Worker factory
- Host Runtime WS Gateway
- Client RuntimeSocket / SessionStore
- Pi SDK Agent Adapter 真实装配

---

## 4. 原计划问题与修正

### 4.1 原计划的问题

1. 把旧 Next 应用“迁移期间继续可运行”冻结成约束，导致新包一直堆在旧仓库。
2. 按 Runtime Core、Protocol、Host、Client 横向分层交付，没有早期纵向启动路径。
3. CLI 和 composition 被放到 Runtime/WS/Worker 全部完成之后。
4. 每个包都有单元测试，但没有生产入口调用 `createHostApp`、`SessiondService` 等实现。
5. H0A 被要求与 Protocol/sessiond 完全隔离，只留下未实现 seam。
6. C0/C1 留下 demo 数据和 Runtime stub，没有产品级启动验收。
7. 旧分支的验证状态与 `pix` 独立仓库中的可用状态混为一谈。

### 4.2 已废弃的旧决策

- 废弃“旧 Next 应用在迁移期间保持可运行”。
- 废弃旧 `I0`：不再维护旧架构集成分支作为产品主线。
- 废弃旧 `L1`：Next 不进入 `pix`，因此不存在最后再移除 Next 的阶段。
- 废弃“CLI 必须等 R1/R2/H0B 全部完成后才能开始”。
- 旧验证只记录为来源证据，不自动继承 `DONE`。

---

## 5. 新任务看板

状态定义：

| 状态 | 含义 |
|---|---|
| `BACKLOG` | 当前不执行 |
| `BLOCKED` | 依赖未满足 |
| `READY` | 可开始 |
| `IN_PROGRESS` | 正在实现 |
| `IN_REVIEW` | 等待独立验证 |
| `DONE` | 已在 `pix` 中验证并集成 |

## Wave 1 — 独立仓库与可启动应用

| ID | 工作包 | 状态 | 依赖 | 交付 |
|---|---|---|---|---|
| `B0` | Pix Product Workspace | `DONE` | 无 | `e087bf0`；独立 npm workspace、根 scripts、TS 配置、架构检查、零 Next；根脚本 40/40 |
| `B1` | Core + Protocol Migration | `DONE` | `B0` | `ea7e207`；来源 tree 字节一致；GPT 独立验证 PASS；scripts 40/40、Protocol 109/109、Contract 75/75、Core 3/3 |
| `B2` | Host + Client Boot Surface | `DONE` | `B0`, `B1` | `c65d2df` + root lockfile；Client 82/82、Host 132/132、真实Client托管与LAN fail-closed；M1 GPT最终验证PASS |
| `B3` | sessiond Daemon Bootstrap | `DONE` | `B0`, `B1` | `5dc9469` + `44529c3`；GPT复验 PASS；sessiond 38/38，启动信号40/40、回归118/118、专项24/24 |
| `B4` | Production Composition + CLI | `DONE` | `B2`, `B3` | `8f918a9`；`pix`/`pix-host`/`pix-sessiond`、ensure/reuse、RPC probe、`down --all`；CLI 29/29；M1 GPT最终验证PASS |
| `B5` | Startup E2E | `DONE` | `B4` | `a7e9e29`；build/start/API/Client asset/Host restart/PID reuse/down cleanup；独立4/4 PASS；M1 GPT最终验证PASS |

依赖图：

```text
B0
└── B1
    ├── B2
    └── B3
        B2 + B3 ──▶ B4 ──▶ B5 ──▶ M1
```

并行规则：

- `B0` 完成后，`B1` 先建立公共包基线。
- `B1` 完成后，`B2` 与 `B3` 可并行。
- `B4` 由集成负责人统一完成，避免 CLI/Host/sessiond composition 相互冲突。

## Wave 2 — 最小 Runtime Vertical Slice

目标：`M2 — Minimal Runtime Happy Path`。

| ID | 工作包 | 状态 | 依赖 | 交付 |
|---|---|---|---|---|
| `R0` | Protocol Process Corrections | `DONE` | `M1` | `2672c5c`；GPT独立验证PASS；create/open mode、sessiond epoch、interrupt commandId、partial/bash delta；Protocol110、sessiond40 |
| `R1` | Agent Worker Controller + Mapper | `DONE` | `R0` | `f7388b1` + `710ab1c` + lock `43d5b53`；90/90 + 约90项对抗检查；GPT PASS |
| `R2` | Child Process Worker Factory | `DONE` | `B3`, `R1` | `536b776` + `ee05c09` + hardening `e4335a7`,`9b59801`,`0a7d21e`,`c593070`,`cb2d2c7`；GPT复验PASS |
| `A1` | Pi SDK Agent Adapter | `DONE` | `B1` | `526b19e` + `fd4612b`；GPT独立验证PASS；SDK0.84真实create/open smoke、92/92、显式prompt+abort capability |
| `H1` | Runtime WS Gateway | `DONE` | `B2`, `B3`, `R0` | `e9e7d49` + `f960390` + `976c4c6` + `a6eb571`；有界入站/interrupt并发，非法limit回退安全默认；Host172；GPT最终PASS |
| `C1` | RuntimeSocket + SessionStore | `DONE` | `B2`, `R0`, `H1` | `08f0362` + `d06db38` + `2368938`；Client149；原FAIL全部修复，GPT 29/29对抗探针复验PASS |
| `X1` | Minimal Runtime E2E | `DONE` | `R2`, `A1`, `H1`, `C1`, `B4` | `34d2a3a` + `f711ab2` + `f87dea4`；GPT最终复验PASS；真实链路10/10、动态WS capability、Node718+Client149 |

依赖图：

```text
M1 ──▶ R0 ──┬──▶ R1 ──▶ R2 ──┐
             ├──▶ H1 ──────────┤
             └──▶ C1 ──────────┤
B1 ──▶ A1 ─────────────────────┤
B4 ────────────────────────────┘
                               ▼
                              X1 ──▶ M2
```

### 5.1 M2 最小能力范围

只开放并验证：

```text
create/open
attach/detach
prompt
abort
getSnapshot
stop
```

其余 Protocol 命令可以保留 schema，但 capability 不得宣称可用。

### 5.2 R0 必须重新确认的协议点

1. Worker init 显式携带 `mode: "create" | "open"`。
2. epoch 只由 sessiond 生成和拥有。
3. interrupt 保留浏览器端 `commandId`，实现端到端 at-most-once。
4. Runtime Core 完整 partial message 到 Protocol delta 必须由有状态 Mapper 转换。
5. `bash_update` 必须统一为 delta 或累计输出，禁止 Adapter 与 projection 重复拼接。

## Wave 3 — 可日常使用的产品切片

目标：`M3 — Read and Operate`。

| ID | 工作包 | 状态 | 依赖 | 交付 |
|---|---|---|---|---|
| `D1` | Sessions Read Path | `IN_PROGRESS` | `M2`, Session Catalog Adapter | D1A DONE；D1B-1 `723fac4` Thinking、D1B-2 `83a3859` Bash History/Live、D1B-3 `665e31a` selected history visible-branch normalized JSON export、D1B-4 `1a5d28f` Sidebar 只读会话元数据、D1B-5 `5244e44`+`65c33c0` Transcript history capability fail-closed DONE；D1-WP1 cache hardening `3fae308`+`faa0fe0` DONE（Fresh GPT 首轮发现同generation旧扫描覆盖/负缓存期限与容量问题，修复后复验 PASS）：warm miss scan合并、共享revision fence、固定30s负缓存期限+1024 LRU、delete ENOENT幂等且其他fs错误sanitize；D1-WP2 shared ports `8621383` DONE（Fresh GPT PASS）：catalog+locator+activation context共用一个store，冷resolve→activate从两次全量扫描降为一次；D1-WP3 `dfd552e` DONE：真实Sessions E2E补分页/leafId分支/delete/rename/repeated-list零Worker契约；**D4 session-history delete（source `1d05532`，Fresh GPT 二轮验证 PASS，已集成 main）完成 stopped/live/stop-then-delete/down-503/LAN-auth 删除契约（详见 migration-ledger §47）**；后续为更完整只读会话能力，SQLite索引/虚拟列表仍属Wave4 SCALE1/UX1 |
| `D2` | Runtime Command Expansion | `IN_PROGRESS` | `M2` | P0 DONE；P1 `ed1b867` + hardening `9bfaf68` DONE（GPT PASS）：state/commands/last-text/stats/rename与SessionActions已进main；P2 `79e2e1a`（integration `76f7c1b` + hardening `940610a`）runtime thinking control DONE（DeepSeek 独立验证 PASS）：set_thinking_level 经 sessiond 快照权威终态化、Client typed helper、SessionActions capability-gated UI、真实 Runtime E2E 验证（详见 migration-ledger §28）；P3 `79c84ac` runtime model control DONE（Fresh DeepSeek 独立验证 PASS）：真实 `set_model` slice，adapter `runtime.model.set`、sessiond authority finalization 泛化 `{set_thinking_level,set_model}`、Client `setModel`、SessionActions Model control（Models catalog × runtime snapshot cwd）、fixture/E2E set→state→detach/reattach model+pin（详见 migration-ledger §31）；P6 runtime tools+reload DONE（本分支 feat/d2p6-tools-reload，base main 1d3ad63，backend-first，UI 后置）：production cap 精确加 runtime.tools.read/runtime.tools.write/runtime.reload（14 token）；sessiond AUTHORITY_COMMAND_TYPES 精确扩 `{set_thinking_level,set_model,set_auto_retry,set_tools,reload}`（get_tools 纯查询不 refresh；set_tools/reload authority 快照收敛 tools/systemPrompt/thinking/capabilities 后 release/cache，复用 singleflight/triple-match/epoch/rekey/fail-closed）；Client SessionStore typed getTools()/setTools(names)/reload() + RuntimeProvider 暴露，无 UI；E2E 单连接真实贯通 initial tools + get_tools + set subset/all-off 权威 + reload 重应用 + detach/reattach + unknown-tool invalid_input + closed compact/fork/auto_name；root tests/typecheck/architecture/boundaries + Runtime E2E 2 轮 + Startup/Sessions E2E PASS（详见 migration-ledger §39）；后续 bash→compact→extension UI→fork/navigate；P4 `e005a42` runtime queue control DONE（Fresh GPT 独立验证 PASS）：production cap 精确加 steer/follow_up/queue（9 token），Client SessionStore 双槽 pendingQueuedTurn（prompt 长跑不阻塞 steer/follow_up）+ typed interrupt admission（clear vs abort 不串线），Composer Steer/Follow-up/queue 展示（权威 snapshot 字段、无泄漏 image data），sessiond AUTHORITY 扩 `{set_thinking_level,set_model,set_auto_retry}`（set_auto_retry→snapshot.autoRetryEnabled 权威 + detach/reattach 保持，Client 无 setAutoRetry UI），**Host runtime-gateway 双 lane 最小修复（父会话正式扩 scope）**：serial lane + 独立 bounded FIFO queuedTurnSerial（steer|follow_up）同 limits，长 prompt 不再 HOL 阻塞 queued turn，overflow close1009 lane-safe 记数、browser close 双 lane short-circuit；E2E 单连接真实贯通 block prompt + steer/follow_up + queue snapshot/clear + set_auto_retry 权威 + detach/reattach + abort，2 轮无孤儿（详见 migration-ledger §32）；P5 runtime bash control DONE（main `28f6b8e`（source `3ce5d2d`），Fresh GPT 独立验证 PASS）：production cap 精确加 runtime.bash/runtime.bash.abort（11 token），Client SessionStore typed runBash（单 inflight pendingCommand 槽诚实 session_busy，bash_update delta 共享投影精确累积）+ abortBash（独立 interrupt 旁路 typed admission 不 HOL），detach/session-switch 类型感知恰一次 reject 长 bash（prompt 语义保留），E2E 单连接真实贯通普通 bash 精确投影 + `__block__` 长 bash + abort_bash 非阻塞 + cancelled + detach/reattach 持久 + closed tools/reload；未改 Protocol/runtime-core/sessiond/Host/daemon/package-lock；Bash 不进 AUTHORITY_COMMAND_TYPES；后续 tools/reload→compact→extension UI→fork/navigate；P8 source `f568eeb`（base main 125d0a6，Fresh GPT 独立验证 PASS，已集成 main；backend-first，UI 后置）DONE：production cap 精确 16→17 加 `runtime.extension_ui`（extension_ui_response/input，fork/navigate/auto_name 仍关闭）；投影收敛用既有 canonical `ExtensionUiRequest.closed`——Protocol schema/event 加 strict optional closed、adapter `finishUiRequest` 对任何 settle 恰一次发 close tombstone（response/cancel/abort/timeout/signal/onSettled）、Protocol 纯 reducer 对 closed:true 删除且永存 tombstone、sessiond/client 共享 reducer 故 detach/reattach/replay 不复活（sessiond service.ts 未改）；runtime-core response/input 命令保留 `method`（worker mapper 不再丢弃）、adapter 对 response/input 精确 method 校验（错 method⇒invalid_input 保持 pending、unknown id⇒not_found）；**Host 泛化 interleaving lane（父级纠正探索假设：serial lane 被 await-UI 的 prompt HOL，response 走普通 serial 会死锁）**：queuedTurnSerial→interleavingSerial 容纳 steer/follow_up+extension_ui_response/input 四类，同 limits/overflow close1009/browser-close short-circuit/FIFO；E2E 单连接真实贯通 confirm wrong-method→correct resume、detach/reattach 持久与 close 后不复活、input/editor incremental、select cancel、custom、abort 清 pending、status/widget/title/notify 事件、closed fork/navigate/auto_name、reload 不 broaden、无孤儿（详见 migration-ledger §45）；**P8 Client UI（integration `4e09278` + focus fix `46db2b4`，Fresh verifier PASS，Client-only，DONE）**：专用单飞行 extension-UI reply 槽 + typed `respondExtensionUi`（最终 response only、无 incremental input——真实 adapter 语义），features/extension-request 五表单 UI + noninteractive 被动 notice，Composer 禁用/焦点恢复，AppShell 挂载，Client 627/627（新增 46）+ AppShell 25/25，根门禁与 Runtime/Startup/Sessions E2E 全 PASS（详见 migration-ledger §50）；后续 fork/navigate |
| `D3A` | Files/Git/Worktree | `IN_PROGRESS` | `M2`, `B2` | D3A-1 DONE；D3A-2 Files/Git只读工作区 DONE；Worktrees只读列表 `b79b54c` DONE：full/degraded均广告list token、无Mutation UI。Client error sanitization `39c07db` DONE：Git/Files错误位固定文案、不渲染Host raw message。Files Search UI（D3A-Files-Search-UI）DONE（DeepSeek 独立验证 PASS）：FilesPanel 顶部 250ms debounce 文件搜索、joinRelative 安全相对路径、aria-live 状态区、code-first describeIndexError。**事务性多文件上传（D3A-Upload-Transaction）DONE（main `18da293`；Fresh GPT 独立验证 PASS）**：`packages/host/src/routes/files.ts` POST `/v1/files` 改为 preflight→stage→commit/rollback journal 三段式，单请求接受的创建/覆盖全量原子（后失败回滚已创建文件、按字节还原已覆盖原文件），`conflict=skip` 条目不参与回滚；新增 per-directory KeyedMutex 序列化同目录并发上传、无锁嵌套；目录/根身份与子目标在 commit 边界用 AllowedRoot 语义重验（symlink/目录替换拒绝）；私有 fault-injection seam（`setUploadFaultHooks`，未进 public surface）供测试确定性注败；未改 UI/API schema/capability/依赖（详见 migration-ledger §35）。D3A-P0 durable trusted-roots ledger `f7c9a80` DONE（Fresh GPT 独立验证 PASS）：Pix创建的worktree授权持久化、Host重启恢复、严格单Host锁、损坏账本不可变、未认证LAN零副作用；§39/§41 managed-worktree 托管账本/路由/能力接线 DONE（main `dfbd8ee`+`8260b75`，Fresh GPT 独立验证 PASS）：worktree.write 能力 token（full/sessiond-up only）、managedByPix 严格 GET、POST/DELETE 以托管 record+双重活体佐证授权（外部/planted/manual/legacy 403 WORKTREE_NOT_MANAGED）、force 仅跳 dirty/untracked 且不可绕 authority/main/busy/sessiond-down、全部 Git/process 错误 sanitize 固定 code。**D3A Managed-Worktree Client UI（本分支 feat/d3a-worktree-ui，base main 13859b1，待独立验证后合入）**：create/open/delete 垂直切片，门控 `worktree.write`（仅 `worktree` 保持 list-only）；Open/Switch=Client URL cwd navigation（AppShell navigate 清 session）；create 纯 client validator 镜像 Host safeBranch 逐字节（255 边界接受、无 auto-trim）；Delete 仅 managed 非 main，dirty 409→row-local 不可逆确认 force 恰一次，busy 永不 force；单飞行 + SessionActions 风格 generation/cap/cwd refs 防 stale/late；固定 sanitize 错误映射（code-first→transport-kind→fallback）；AppShell 唯一导航 owner；Client 549/549、typecheck/build/boundary/architecture/diff-check PASS（详见 migration-ledger §42）。Files/Git 其他 mutation 范围（如 Files write UI）仍后置 |
| `D3B` | Models/Auth/Skills/Plugins/Trust | `DONE` | `M2`, D1领域化Adapter | R1A `773d3f2` + R1B `4668658` + Client `f9151b7`/`4b1e9d9`/`9603aa8`/`8001fa4`：独立只读Ports、Host GET API、canonical cwd、严格DTO、capability-gated Catalog Dock与Trust状态；独立验证PASS。OAuth/写入/安装/reload/Trust修改/执行extension后置 |
| `D4` | Mutations + Side Chat | `IN_PROGRESS` | `D1`, `D2`, `D3A`, `D3B` | **D4 session-history delete（source `1d05532`，base main `125d0a6`；Fresh GPT 二轮独立验证 PASS，已集成 main）DONE**：仅 stopped/history 可删，live（idle/prompt/bash/compact）fail closed `session_busy` 且绝不 stop-then-delete；delete 与 activate 共用同一 mutex fence 串行化（激活先赢→delete conflict 不删文件；delete 先提交→activation not_found 且零 worker；并发 delete/delete 恰一成功+固定 not_found；fence 仅持同步 admission、异步 worker-start 在锁外，rekey 不自锁、不同 id 不串行、同 id delete 立即 session_busy）；Host `DELETE /v1/sessions/:id`（mutation guard system.ping 先于 RPC、仅挂 seam 才挂路由、`{success:true}`、404/409 SESSION_IN_USE/503 固定 sanitize、无 body/force/query（任意非空 query 固定 400）、auth/LAN gate 最前）；能力 `session.delete` 仅 full/sessiond-up（Host types/ALL/production FULL/CLI/bootstrap/health/WS），degraded/down 排除、`sessions` 读保留；production sessiond client 窄 delete RPC；Client Sidebar 行内两步确认（Cancel 安全默认聚焦 + Delete session，`session.delete` 门控、attached/live 隐藏、同步单飞行、generation refs 使 late inert、固定文案、sibling 不导航），AppShell 成功删除选中会话只清 `session` 保留 `cwd`；Sessiond 14 测试 + Host 11 测试 + Client 14 测试 + Sessions/Startup/Runtime E2E 全 PASS（详见 migration-ledger §47）。独立验证首轮 FAIL 回归（activate mutex 跨 worker start 自锁、DELETE query/force 面）已修复，二轮对抗复验 PASS。**D4 session-rename upper-layer（source `f575b82` + same-kind fix `a6cdedd`，current-main integration `1cb32e3` + `66e7e4c`，Fresh verifier 二轮 PASS，已合入 main）DONE（backend-first，无 Host/Client）**：sessiond 身份变更收敛到服务持有的 per-session FIFO identity lane 协调器（activate / sessions.rename / runtime.command(set_session_name) / 显式 stop / delete；同 id 串行、异 id 并行、全局 mutex 仅短同步 records/rekey/alias 迁移、绝不锁下 await 长 I/O）；生产默认 catalog/locator/mutation 同来自一个 createPiSdkSessionPorts()（sessionMutation undefined/null 覆盖语义）；delete catalog I/O 移入 lane、stopped-only/prompt busy/无 force 语义保留；显式 stop 走 lane、全局 shutdown lane-free bypass 不死锁；rekey 短锁下绑定 authoritative alias 到同一 startup reservation、目标占用 fail-closed、旧 id 排队请求 stale conflict 绝不 offline 回退；live/offline rename 双路径 + 捕获 record+epoch ownership 双重检查（ok:false 绝不 false success、旧结果 inert）；revisioned 标题 overlay 应用 sessions.list/read（旧读不清新 revision、delete 移除、stop 保留、rekey 移动）；canonical 名单次化并回传 RPC；无 lane/alias/activation 泄漏。sessiond 229 用例（新增 28 rename + 4 coordinator + 2 daemon）；独立验证首轮 FAIL（同 kind pending 用 Set 去重致 lane 被先 settle 的兄弟清空、新操作绕过在排队的同 kind 兄弟）已修复为 per-kind 正引用计数 Map，新增 coordinator 直测 + service 级 kind-race 复现对旧实现确定性 FAIL/对修复 PASS；root tests/typecheck/build/architecture/boundaries、Sessions/Runtime/Startup E2E 全 PASS（详见 migration-ledger §51）。**D4 Host Session Rename API（source `33f0fea` + capability honesty fix `ed733f5`，Fresh verifier 二轮 PASS，已合入 main）DONE（backend-first，无 Client source/package-lock/sessiond 改动/live）**：Host 能力 `session.write`（Protocol token 已存在）加 HostCapability/ALL 与 production FULL（session.delete 后），仅 sessiond-up + rename seam 挂载时广告、degraded/down 排除（discovery only，auth/gate 仍是授权）；窄 `SessionRenameClient`/`SessionRenameSeam` 平行 D4 delete，production sessiond 窄 client 只调 `sessions.rename` RPC 恰一次，read/delete seam 全兼容；`PATCH /v1/sessions/:id` 仅挂 seam 时存在，成功固定 `{success:true}`（sessiond 确认 live/offline 后）；冻结顺序 auth/LAN gate → mutation guard system.ping（先于 query/body 解析，down→503 零 RPC/零 body）→ 任意 query（含裸 `?`）400 INVALID_QUERY → canonical session id → 415 application/json → 4KiB body（413）→ 严格单 own 字段 `name`（无数组/prototype/未知键，malformed 400）→ 名字 canonicalize 恰一次（string/trim/非空/≤200 JS UTF-16/拒 NUL+C0+DEL，Unicode/emoji/内部空格允许，无 coercion）→ rename 恰一次；固定映射 not_found 404 SESSION_NOT_FOUND / conflict+epoch_changed 409 SESSION_CHANGED / 其余（unavailable/timeout/unsupported/internal/busy/unknown/raw）503 SESSION_RENAME_UNAVAILABLE，live rename 绝不映射 busy（sessiond 支持），无 raw id/name/path/secret/endpoint/stack 泄漏；默认 full 组合（CLI host-runner + E2E bootStack）暴露 rename seam，null/unavailable 测试 fail closed；Host 18 测试 + production-resources 能力断言 + CLI 46 + Sessions（live+offline HTTP PATCH/即时标题/同 id/path/history/worker 诚实/LAN/down 收回+503）+ Startup（upCaps 含 session.write、degraded 不含）+ Runtime E2E + root tests/typecheck/build/architecture/boundaries 全 PASS（详见 migration-ledger §52）。**PR#3 Worker Diagnostics 手工 port（source `db74383`，current-main integration `49e6918`，Fresh verifier PASS，DONE）**：SessiondService 内部 `workerPids()` + `workersByStatus`、DaemonHandle 进程内 diagnostics；Runtime/Sessions E2E 删除 pgrep/process scan/fail-open 空数组，保留预捕获 PID 的 OS liveness 退出证明；无 Protocol/Host/CLI/WS/capability 公开面（详见 migration-ledger §54）。Client UI / live catalog 持久化仍后置 |

### 5.2 M3 Wave 1 冻结切片

1. `D1A`：DONE。D1A-1 `a38c3c8` 为独立、纯只读 `pi-sdk-adapter/sessions` Catalog/Locator；D1A-2 `5570d69` + `429274f` 完成Host/Client/0 Worker链路。真实missing read/context固定404且无泄漏，unknown固定503，严格十进制分页；GPT复验PASS。
2. `D2-P0`：DONE（`c4a2f76` + `5a96fd4`；GPT复验PASS）；第二条并发command明确session_busy、snapshot内外sessionId不一致启动rollback、rekey rejection有界处理；未开放新能力。
3. `D3A-1`：DONE（main `95ee707`，原branch `1c7a848`；GPT安全验证PASS）；Host204、CLI32、全仓tests、startup/runtime E2E、typecheck/architecture/boundaries PASS。
4. `D3B-R1A`：DONE（main `773d3f2`）。Runtime Core read/mutation ports分离；Protocol只读tokens；Adapter以`models`/`credentials`/`resources`/`trust`四个独立子路径提供离线、零写入、零Extension执行的目录读取。Skill真实路径 containment 覆盖子目录和整根符号链接逃逸；正常与clean env Adapter 164/164；独立安全验证PASS。禁止恢复聚合`sdk-data.ts`。
5. `D3B-R1B`：DONE（main `4668658`）。Host按挂载Port条件注册只读Models/Auth/Skills/Plugins/Commands/Trust API；项目读取使用AllowedRoot授权后的canonical cwd；full/degraded均诚实广告Catalog能力。Host严格投影DTO，Trust异常、恶意getter/proxy/cyclic/toJSON、额外Secret字段和稀疏数组均fail closed且日志不泄漏；Host256/256、CLI46/46、三条E2E与独立28/28对抗验证PASS。
6. `D3B-Client`：DONE（main `f9151b7` + `4b1e9d9` + `9603aa8` + `8001fa4`）。Client使用Protocol item schemas与本地strict envelope；提供独立Catalog Dock、五个capability-gated Tabs及只读Trust状态，与Files/Git互斥。无capability、Dock关闭或项目Catalog无cwd时零请求；query key隔离CWD竞态；Provider状态逐行失败隔离；错误与Trust reason不泄漏自由文本；不存在Catalog Mutation/OAuth控件或调用面。Client268/268、Host260/260、typecheck/build/boundary/architecture及Startup/Runtime/Sessions E2E全部PASS，独立验证PASS。
7. `D1B-1`：DONE（main `723fac4`）。History、live completed与streaming partial使用同一个block-aware projector；Thinking/text交错顺序保留，streaming默认展开且可手动折叠，completed默认收起；不新增API或`/thinking`请求，不泄漏attached A到selected B。Client281/281、typecheck/build/boundary/architecture PASS。
8. `D1B-2`：DONE（main `83a3859`）。History bashExecution与live `state.bash`使用共享view-model，显示command/output/exit/cancelled/truncated；空输出固定文案，live row使用稳定ID。`fullOutputPath`不进入view-model或DOM，不发Bash命令/API。无权威execution ID时绝不猜测去重，message与state并存可重复但不吞数据。Client314/314、typecheck/build/boundary/architecture PASS。
9. `D1B-3`：DONE（main `665e31a`）。仅对具备sessions capability且不匹配attached live的selected history SessionContext显示导出；复用既有context query key，在Client本地生成`pix.visible-branch` v1 normalized JSON。导出只包含当前可见branch，不是archive、全部分支或raw JSONL；不新增Host API、Worker、Runtime命令或capability。JSON clone只接受规范JSON值、数组、plain/null-prototype object；拒绝cycle、accessor、exotic prototype与恶意Proxy，安全保留`__proto__`/`constructor`而不污染原型。Bash role固定`bashExecution`，image仅导出placeholder，`fullOutputPath`及未白名单字段省略；Object URL清理never-throw，busy lock跨macrotask阻止重复下载，A→B晚到query不污染B导出。Client354/354、typecheck/build/boundary/architecture与gate tests19/19 PASS；Client-only只读节点按规则不单独启动verifier。
10. `D3A-Worktrees-Read`：DONE（main `b79b54c`）。`worktree`冻结为GET/list token，production full/degraded与HTTP/WS一致；Workspace Dock新增Worktrees只读Tab，展示main/linked、branch/detached及AllowedRoot授权状态。无create/delete/open/switch/promotion UI；sessiond down真实GET仍可用，POST仍在Git副作用前503。Client297/297、Host260/260、CLI46/46、Startup E2E与门禁PASS。
11. D1A-2、D1B Thinking/Bash/visible-branch export、D3A只读工作区与D3B端到端只读链均已合并。Mutation/OAuth/Trust设置仍留在D4或后续显式切片。
12. `D2-P2`：DONE（source `79e2e1a`，integration cherry-pick `76f7c1b` + hardening `940610a`，branch `integrate/d2p2-thinking-control`；DeepSeek 独立验证 PASS）。生产 capability 精确新增 `runtime.thinking.set`；sessiond 对 set_thinking_level 成功帧先做有界 worker.getSnapshot 权威刷新再发布终态（refresh 失败 fail-closed、同 commandId singleflight、三重匹配丢弃 malformed/late/wrong-id 帧、epoch/rekey 所有权守卫）；Client `setThinkingLevel` typed helper 单 inflight 诚实 session_busy/unsupported；SessionActions 仅 attached-live 且 capability 时显示、Protocol 档位、固定错误文案、晚到 settle fail-closed。实现验证：Adapter164、sessiond146、client411、分包全量（protocol116/core7/contract75/worker105/host263/cli46）PASS，root build/typecheck EXIT 0，architecture/boundaries PASS，Runtime E2E 2/2、Startup E2E、Sessions E2E PASS。独立验证另行完成 root `npm test` EXIT 0（1377 workspace tests + Client411），并设计 snapshot mismatch、rekey-during-finalization、concurrent-finalization 三组对抗 probe 全 PASS；确认实现阶段约20分钟 runner stall 属非确定性环境/并发争用，不是稳定缺陷。base 与 candidate 同点的 E2E epoch-change cold-attach 失败为 pre-existing（8086770 catalog-derived activation 暴露 fixture 不持久化），hardening 仅修复 D2 范围内 tests/e2e/runtime.mjs 的 fixture catalog 覆盖，未改 daemon/gateway/resolver（migration-ledger §28/§29）。
13. `D3A-Upload-Transaction`：DONE（main `18da293`；实现者 Fresh DeepSeek；Fresh GPT 独立验证 PASS）。事务性多文件上传 C1 切片，branch `feat/d3a-upload-transaction`，base main `811c94e`。仅改 `packages/host/src/routes/files.ts`（生产）+ 新增 `packages/host/test/uploads-transaction.test.mjs`（12 用例）+ 两份 docs；未改 UI/API schema/capability/依赖/package-lock/Client/CLI/protocol/sessiond/ledger 相关文件。POST `/v1/files` 现在三阶段：preflight（保留授权、name/duplicate、每文件25MiB、总100MiB、symlink 与 conflict 校验；`INVALID_CONFLICT` 现早于文件逐项校验，属于已记录的可观察错误优先级变化；按 conflict 模式规划全批 create/overwrite/skip，`error` 冲突在 preflight 即 409）→ stage（每个接受文件写入目标目录内唯一 `.pix-upload-<uuid>.tmp`，O_EXCL/O_NOFOLLOW/0600，失败清理全部 temp）→ commit（per-directory `KeyedMutex` 下以 rollback journal 逐项提交：create 用 `link(staged,target)`+unlink 原子 create-if-absent；overwrite 先 `link(target,backup)` 硬链接备份同目录原 inode 再 `rename(staged,target)`，成功删 backup、失败 `rename(backup,target)` 字节/元数据精确还原；成功统一删 backup）。commit 边界用 AllowedRoot 语义重验：目录 canonical 路径 + dev/ino 身份（替换→409 DIRECTORY_REPLACED）、根身份（ROOT_REPLACED）、每目标 authorizeChild（symlink/目录→409 UNSAFE_TARGET），并在每次 `beforeCommit` seam 后重验。abort（`c.req.raw.signal`）在 stage/commit 每步检查，观察到的 abort→499（按阶段为 UPLOAD_ABORTED 或 MUTATION_ABORTED）+ 回滚已提交项 + best-effort 清理 temp。并发：每请求仅取一个 per-directory 锁、无嵌套，同目录 FIFO 串行、异目录并行（KeyedMutex 自动回收 idle key）。错误保持固定/sanitized（新增 code 仅 DIRECTORY_REPLACED/UPLOAD_ABORTED，无路径无内容）；私有 fault-injection seam `setUploadFaultHooks`（`UploadFaultHooks`）从 `dist/routes/files.js` 供测试注入 beforeStage/beforeCommit/beforeRestore，未从 index.ts 导出（非 public surface）。实现验证：定向新增 12 用例（后文件 commit 失败→首个创建移除；覆盖后失败→原文件字节精确还原；混合 create/overwrite 与 skip 条目不回滚；staging 失败零 final/temp 残留；重复文件名；symlink 交换/根/目录替换于 preflight→commit 间被拒；同目录并发串行 + 异目录并行；成功/失败无 temp/backup 残留且响应不泄漏；error 模式冲突中途出现→整批 409 回滚；skip 模式中途出现→skip 不回滚且 temp 清理；abort 清理+回滚）全 PASS（5 轮无 flake），Host 全量 281/281（基线 269 + 12）、Host typecheck/build、check:boundaries（38 files）、check:architecture、`git diff --check` 全 PASS。独立验证以全新 `/tmp` build 复验 Host 281/281，并做约70项上传对抗探针。残余风险：进程崩溃在 commit 中段无 durable journal 无法自动恢复（仅请求级回滚；诚实记录，不承诺崩溃耐久）；恢复失败、进程崩溃，或外部进程在请求中途重命名整个目标目录时可能遗留 `.pix-upload-*.bak/.tmp`（best-effort 清理，不保证；目录重命名场景已实测）；上传中的 temp 也可能短暂出现在文件列表；overwrite 硬链接备份依赖文件系统支持硬链接（APFS/ext4 目标平台 OK）。详见 migration-ledger §35。

14. `D2-P7`：IN_REVIEW（branch `feat/d2p7-compact-control`，base main `13859b1`，未 merge/push/deploy）。Manual Compact + Abort Compaction 生产切片，backend-first，无 UI/CSS，无 Host/Protocol/runtime-core 生产改动，无 D3A 文件。生产 capability 14→16：精确新增 `runtime.compact`（compact）、`runtime.compact.abort`（abort_compaction）；`set_auto_compaction` 在既有语义映射下 wire-open（归 runtime.compact，诚实，无 Client helper/UI）；fork/navigate/extension_ui/auto_name 仍关闭。关键决策：成功 `compact` 加入 sessiond `AUTHORITY_COMMAND_TYPES`（精确 6）——`compaction_end` 只清活动、不携带 post-compaction messages/messageCount/contextUsage，所以必须在有界 worker.getSnapshot 权威刷新应用完整 post-compaction snapshot 后才 return/cache，复用 set_tools/reload 的 singleflight/triple-match/epoch/rekey/fail-closed；refresh 失败固定 unavailable 并缓存，同 commandId 重试不重执行；失败/中断 compact 不触发 refresh 不缓存假成功。Adapter compact 前置 busy guard（streaming/bash/compacting/promptRunning 在途 → 结构化 session_busy，mutation/SDK 前，无部分 state/event）；Client typed `compact(customInstructions?)`（单 pendingCommand 槽、customInstructions 严格非空不 trim）`abortCompaction()`（typed sendInterrupt 非 HOL）并暴露 RuntimeApi；detach/session switch/stop/dispose/epoch 清理 genericize（settlePendingControlCommand 覆盖 bash+compact）。fixture/E2E：capability 16、确定性 compact trim（messages/messageCount/contextUsage）、`__block__` hold ≤30s 硬 failsafe、abort_compaction 释放→interrupted + compaction_end{aborted:true}、idle abort 幂等、命令/中断 capability 门禁镜像生产。验证：root test 1715 pass/1 skip（scripts44/cli46/agent-worker105/client566/host372/adapter206/protocol116/contract75/runtime-core7/sessiond178+1skip）、typecheck/build/architecture/boundaries PASS、Runtime E2E 2 轮（含 D2-P7 bash→compact pin 与 D3A busy probes）+ Startup + Sessions PASS、真实 SDK 无网络 compact 失败 smoke（结构化、快照 isCompacting:false、idle abort 幂等、set_auto_compaction 离线；bash 后 compact 非 session_busy）。GPT 独立验证 FAIL 已修复（F1 active-bash guard 不再被终态 bash 永久阻塞；F2 exact-owner 清理 running/aborting + 合成 compaction_end 清投影，SDK 正常 end 不 double-emit），复验全绿。Rebase 7230f75→185b2de onto main 4663691；compact 记录由 §42 重编号 §43（main §42 D3A UI 保留）。详见 migration-ledger §43。

15. `D2-P8`：DONE（source `f568eeb`，base main `125d0a6`；Fresh GPT 独立验证 PASS，已集成 main，未 push/deploy）。Extension UI Backend 生产切片，backend-first，无 Client UI/CSS，无 D4 session-delete/side chat/fork/navigate/package-lock/live service。生产 capability 16→17：精确新增 `runtime.extension_ui`（extension_ui_response/input）；fork/navigate/auto_name 仍关闭。正确性决策：① 投影收敛用既有 canonical `ExtensionUiRequest.closed?: boolean`——Protocol schema/event 加 strict optional `closed`（仅 true），adapter `finishUiRequest` 单漏斗对任何 settle（成功/cancelled/abort/prompt interruption/SDK timeout/signal/onSettled）恰一次发 close tombstone（closed:true）后 race-safe 删 pending/emitState；Protocol 纯 reducer 对 closed:true 删除且永存 tombstone、未知 close 幂等、保序；sessiond/client 共享 reducer，detach/reattach/replay 不复活（sessiond service.ts 未改）。② 方法相关性：runtime-core response/input 命令保留 `method`（worker mapper 不再丢弃），adapter 对 response 与 input 都校验 pending 精确 method——错 method⇒结构化 invalid_input、request 保持 pending/usable 不 settle/input/close；unknown id⇒not_found；cancelled 对交互方法允许；保持 result-method shape 校验、无 coercion、用户文本永不入日志。③ 无 sessiond AUTHORITY_COMMAND_TYPES 变更；**Host 泛化 interleaving lane（父级纠正：serial lane 被 await-UI 的 prompt HOL，response 走普通 serial 死锁；最小修复在 runtime-gateway.ts，queuedTurnSerial→interleavingSerial 容纳 steer/follow_up+extension_ui_response/input，同 limits/overflow close1009/raw redaction/browser-close short-circuit/FIFO，create/getSnapshot 仍 serial，无新 lane）**。④ 本 slice 无 Client SessionStore helper/UI。⑤ 交互方法 select/confirm/input/editor/custom；notify/status/widget/title 是事件/state。验证：独立复验 root test 1756 pass/1 skip（scripts44/cli46/agent-worker105/client567/host377/adapter219/protocol132/contract76/runtime-core10/sessiond180，source 文档旧计数已修正）、typecheck/build/architecture/boundaries/diff-check PASS、Runtime E2E 2 轮（新增 scenarioD2P8ExtensionUiControl 单连接真实链：wrong-method invalid_input 保持 pending + 正确 response 经 interleaving lane 恢复 prompt + unknown/late not_found + same-commandId at-most-once 无重复 close + detach 前 response 后 reattach 持久/不复活 + input/editor incremental + select cancel + custom + abort 清 pending + status/widget/title/notify + closed fork/navigate/auto_name + reload 不 broaden + shutdown 无孤儿）+ Startup + Sessions PASS；另有 97+ Protocol/Reducer/Mapper/Adapter/Host/epoch 对抗探针全 PASS。**D2-P8 Client UI（integration `4e09278` + focus fix `46db2b4`，Fresh verifier PASS，Client-only）DONE**：仅改 packages/client + 两份 docs，未触碰 backend/Protocol/Host/sessiond/adapter/fixture/E2E/package-lock/live。传输：新增专用单飞行 `pendingExtensionUiCommand` 槽（prompt 仍 pendingCommand 故 sendCommand 会 session_busy），typed `respondExtensionUi(request, reply)` 仅发最终 `extension_ui_response`（不发 incremental input——真实 adapter 首 input 即 settle，fixture 增量非生产真理），精确 method/reply 兼容校验、correlated ack 解包、无 coercion；handleResponse 按 envelope+generation+commandId+type 关联，同 epoch 重发同 commandId、epoch_changed 不重发、routeSendFailure/detach/stop/dispose/session switch/capability loss 恰一次 settle，prompt 在飞不阻塞 reply、reply 在飞不阻塞 prompt，全局恰一 reply 第二 busy。UI：features/extension-request/（纯 helpers + ExtensionRequests.tsx）在 AppShell workspace 内 TranscriptList 与 Composer 间仅 selectionMatchesLive 挂载，交互请求确定性序渲染、多请求仅首可操作其余 disabled+waiting、confirm/select/input/editor/custom 五表单（Cancel 安全默认聚焦、Escape、Enter/CmdEnter、IME guard、空串仅显式提交、editor prefill 按 identity seed 一次、custom lines 严格文本节点）、noninteractive/未知防御被动 notice 无响应命令；同步 busyRef + mounted/gen/session/live/cap/request-content 键控使 late settle/request-id 复用惰性；Composer 在交互请求 pending 时禁用固定文案 “Extension is waiting for input.”（保留既有更严重优先级），最终 close 焦点恢复 textarea（显式 ref prop 无 document 查询）；固定 describeExtensionUiError、role=region/polite/aria-busy、≥40px 触控、:active scale 0.98 仅 transform 120ms、reduced-motion 移除、无入场动画。验证：Client 627/627（+46：store 12 + helper 7 + DOM 23 + AppShell 4）且 AppShell 25/25（+4 mount placement/门/regression），client typecheck/build/boundary、根 check:architecture/typecheck/build/test、Runtime E2E + Startup + Sessions（backend 回归）全 PASS，git diff-check 干净；无 Playwright 依赖、不声明浏览器视觉 PASS（观感为非阻塞 manual gap）；独立 verifier 已重放同/异 id in-flight reply 焦点恢复与 no-steal 并给出 PASS。详见 migration-ledger §50。

## Wave 4 — Scale、PWA、Release

| ID | 工作包 | 依赖 |
|---|---|---|
| `SCALE1` | SQLite JSONL Projection | `D1` |
| `UX1` | Chat/Sidebar Virtualization | `D1`, `D2` |
| `PWA1` | LAN Gate、配对、后台 Resume | `M2`, `D3A` |
| `REL1` | 安装、升级、卸载、发布验证 | 发布范围功能完成 |

`PiRpcAdapter` 保持 `BACKLOG`，不进入当前关键路径。

### Wave 4 工具化前置（跨平台安全工具子集，main `417f1c9` + hardening `776fbe5`，Fresh GPT PASS）

Wave 4 的 REL1 发布/安装/卸载需要跨平台脚本，因此先落地三个 Node 内置工具
（scripts/run-node-test.mjs、scripts/remove-paths.mjs、scripts/tool-invocation.mjs）
把 test-glob 展开、clean/remove、npm/tsc 调用从 POSIX shell/`.cmd`/PATH shim 迁移到
确定性 Node 路径（shell:false、无 command injection）。所有 workspace 的
package.json 已改用这些 wrapper，root 编排继续经 run-workspaces.mjs；browser/client
Vitest 不走 node --test。check:architecture 增加三门禁（script 值不得含 rm -rf、
raw `node --test` 不得传 shell 依赖 glob、build-deps/prebuild-deps 可执行代码不得用
npm.cmd/.bin/tsc/shell:true，注释不误报）。

注意：本工具化**不建立原生 Windows 产品支持**。Host state directory / Named Pipe /
DACL / process-tree 生命周期仍是独立工作包（另见 migration-ledger §46），不在本子集宣称。

硬化（migration-ledger §46.1，独立验证 FAIL 后修复）：run-node-test 解析器 fail-closed —— 取值型
node test flag 必须 `--flag=value`，分离形式在 discovery/spawn 前以固定消息拒绝，
布尔 flag 可与 pattern 共存，`--watch*` 与未知 flag 拒绝；嵌套调用剥离 `NODE_TEST_CONTEXT`
防静默跳过。architecture 三把门禁按精确 normal-form 回归实现（命令位置 + 注释/echo
文本不误报、全部 `node --test` 出现点、词法注释剥离），不是穷尽式 shell/JS 解析器或
安全沙箱。remove-paths 只接受相对路径（拒绝绝对/纯空白路径）；tool-invocation 校验
真实 npm/typescript 包元数据与路径约束。

---

## 6. 新仓库目标结构

```text
pix/
  package.json
  package-lock.json
  tsconfig.base.json
  README.md

  docs/
    refactor-architecture.md
    refactor-execution-plan.md
    migration-ledger.md

  packages/
    client/
    host/
    protocol/
    runtime-core/
    runtime-contract-tests/
    sessiond/
    agent-worker/
    pi-sdk-adapter/
    cli/

  scripts/
    check-architecture.mjs

  tests/
    e2e/
    fixtures/
```

产品命名已统一为 `pix`：npm 包为 `@fffattiger/pix-*`（client / host / protocol / runtime-core / runtime-contract-tests / sessiond），CLI 产物为 `pix` / `pix-host` / `pix-sessiond`，不提供旧品牌 alias。上游 Pi SDK 概念（`@earendil-works/pi-*`、`PI_CODING_AGENT_DIR`、`~/.pi`、`packages/pi-sdk-adapter`）属于 Pi 上游，保持原名。旧品牌名仅作为历史证据保留在 `migration-ledger.md`。

---

## 7. 迁移规则

1. 禁止 merge/cherry-pick 整个旧重构分支到 `pix`。
2. 只迁移 `packages/**` 中的新架构成果及必要的通用配置思想。
3. 不迁旧根 `package.json`、lockfile、tsconfig；这些文件在 `pix` 重新建立。
4. sessiond 只迁：

   ```text
   package.json
   scripts/**
   src/**
   test/**
   tsconfig.json
   tsconfig.test.json
   ```

5. sessiond 不迁：

   ```text
   dist/**
   dist-test/**
   *.tsbuildinfo
   node_modules/**
   ```

6. 旧 worktree 在迁移和 hash 校验完成前保持只读，不删除。
7. 每个迁入包记录来源 commit/path/tree hash，见 `migration-ledger.md`。
8. 迁入后重新生成唯一 root lockfile。
9. 迁入后必须重新运行 package tests；旧 PASS 只作参考。
10. 不允许为了通过构建从旧 `app/lib/components/hooks` 拷贝依赖。

---

## 8. Composition Root 规则

| 进程 | Composition Root | 允许依赖 |
|---|---|---|
| Host | `packages/host/src/composition/**` | Protocol、sessiond client、Client dist、Host services |
| sessiond | `packages/sessiond/src/composition/**` | Sessiond core、WorkerProcessFactory、locator |
| Worker | `packages/agent-worker/src/composition/**` | Worker Controller、选定的 Agent Adapter |
| CLI | `packages/cli/src/**` | Host/sessiond 启停入口和进程发现 |

规则：

- Host 可以依赖 Protocol 和 sessiond client，但不能依赖 Runtime Core Model、Pi SDK 或 AgentSession。
- sessiond client/server 应提供窄子路径导出。
- Worker Controller 不 import Pi SDK。
- `PIX_AGENT_BACKEND` 只在 Worker composition root 读取。
- Composition Root 只做依赖装配和环境读取，不承载业务规则。

---

## 9. 质量门槛

### 9.1 根检查

```bash
npm run check:architecture
npm run typecheck
npm test
npm run build
git diff --check
```

### 9.2 `check:architecture` 最低检查

- 无 `next`、`eslint-config-next` 依赖。
- 无 `next/` import。
- 无根 `app/`、`next.config.*`、`.next`。
- Pi SDK import 只存在于 `packages/pi-sdk-adapter/**`。
- Host/sessiond/Worker Controller 无 `AgentSession`、`SessionManager`。
- Runtime Core 无 Protocol/Pi SDK/Hono/React import。
- Protocol 无 Runtime Core/Pi SDK/Hono/React import。
- 所有生产 bin target 存在。
- Client dist 进入 production build/package 布局。
- 跨平台工具门禁：任何 package.json script 值不得 `rm -rf`/`rm -r`（用
  `scripts/remove-paths.mjs`）；raw `node --test` 不得传 shell 依赖 glob（用
  `scripts/run-node-test.mjs`）；build-deps/prebuild-deps 可执行代码不得出现
  `npm.cmd` / `.bin/tsc` / `shell:true`（用 `scripts/tool-invocation.mjs`，注释忽略）。

### 9.3 独立验证

以下工作必须由非实现者验证：

- 迁移后的 Runtime Core / Protocol
- sessiond daemon 与 single-instance
- Host security/gate/static/WS
- Agent Worker / Pi SDK Adapter
- CLI lifecycle
- Startup E2E 和 Runtime E2E
- 三个以上文件的核心 Client Runtime

结果只能是：`PASS`、`FAIL` 或说明环境限制的 `PARTIAL`。

---

## 10. 当前立即执行顺序

```text
1. M1：DONE（B0–B5；最终集成 `a7e9e29`；GPT 独立对抗验证 PASS）
2. `R0`：DONE（`2672c5c`，GPT PASS）；`A1`：DONE（`526b19e` + `fd4612b`，GPT PASS）
3. H1/C1/R1：DONE；R1 GPT最终PASS
4. R2：DONE（GPT orphan36/36、redaction308/308、clean build与全仓门禁PASS）
5. X1：DONE（`34d2a3a` + `f711ab2` + `f87dea4`；GPT最终复验PASS）
6. M2：DONE；M3 当前 checkpoint：D1A只读历史、D1B Thinking/Bash展示与selected history visible-branch normalized JSON export、D1B-4 Sidebar 只读会话目录元数据与 capability 撤回 fail-closed、D1B-5 Transcript history capability fail-closed、D2-P0/P1轻命令、D3A Files/Git/Worktrees只读工作区、D3B端到端只读Catalog均已合并；§39/§41 managed-worktree 托管账本/路由/能力接线已合入 main；**D3A Managed-Worktree Client UI（create/open/delete 垂直切片，门控 worktree.write）在独立 worktree feat/d3a-worktree-ui 完成实现与测试，待独立验证后合入 main**（Files/Git 其余 mutation 范围，如 Files write UI，仍后置）
7. `sessiond cold-open activation cwd`：DONE（实现 `8086770`；Grok 独立验证 PARTIAL，候选范围无 F1/F2并明确建议合入；唯一覆盖缺口为 base 同样存在的 Host `files.ts` Node v24/@types 类型错误阻塞 root build/Startup E2E）。production composition 默认 activation context 不再用 M1 stub（无 requestedCwd 时 `/workspace` 导致 Client Continue live cold-open 在错误项目启动 Worker）：新增私有 `createCatalogActivationContext(catalog)` 复用与 sessionCatalog 同实例的 Pi SDK 只读 catalog，无显式 cwd 时从 `catalog.readSession` 取 cwd/projectRoot并防御验证为非空绝对路径（`node path.isAbsolute`，拒绝空/NUL/相对，不 realpath），catalog 缺失 fail closed，structured RuntimeError `not_found` 由既有 RPC boundary sanitize/preserve；显式 requestedCwd 与 `activationContext` override 优先级不变，`sessionCatalog: null` 同时使默认 resolver fail closed。仅改 sessiond `daemon.ts` + `daemon.test.ts`，无 Adapter API/Protocol/Host/Client 改动。Grok复验daemon 15/15、sessiond 134 total（133 pass + 1 Windows skip，0 fail）、真实 Pi SDK catalog production probe、typecheck/build/boundary/architecture/diff-check均PASS。
8. `Host files route Node v24/@types-node 类型兼容`：DONE（实现 `785c88a`；Grok 独立验证 PASS，无 F1/F2并建议合入）。此前阻塞 root build/Startup E2E 的 Host `files.ts` 类型错误（ReadStream `data` 回调显式 `Buffer` 过窄：TS2345；`value instanceof File` 谓词因 buffer/undici File 名义冲突非法：TS2677/TS2339）已修复：ReadStream 明确 `encoding: null` 并以 `string | Buffer` 兼容回调（string 用 TextEncoder UTF-8 编码、Buffer 用 `new Uint8Array(chunk)` 拷贝入队，不暴露池化 ArrayBuffer 的逻辑字节范围之外）；Upload 改为最小结构接口 `UploadFile` + 基于 `FormData#getAll` 实际 union 的 fail-closed guard（排除 string，校验 name / safe 非负 size / arrayBuffer），不用名义 global File/instanceof/any，未关 strict。仅改 `packages/host/src/routes/files.ts` + `packages/host/test/resources.test.mjs`。父验收：Host 263/263、root build、9 workspace官方tsconfig等价typecheck、Host boundary、architecture、diff-check、clean-gate Startup E2E 2/2均PASS；Grok复验base@types22错误、candidate@types22/25编译、263/263与二进制/range/upload/symlink/0600/cleanup对抗probe、clean-gate Startup E2E 2/2均PASS。raw本机401来自仓库外启用的Gate配置，与候选无关。
9. `D3A-Files-Search-UI`：DONE（实现者 DeepSeek；Fresh DeepSeek 独立验证 PASS）。纯 Client 切片，在 FilesPanel 顶部加 compact 文件搜索（`type=search`，aria-label `Search files`）：raw 本地 state、trim≥2 字符、250ms debounce；空/1字符绝不请求空 q 全量 index，1 字符固定提示，清空恢复目录浏览且 currentDir 保留；query 只用 `options.files.index(cwd, debouncedQuery)`（enabled=canFiles && canonical root ready && len≥2），TanStack signal 保留、key 含 cwd+q 隔离迟到响应，raw 变化立即隐藏旧结果；新增纯函数 `joinRelative(root, rel)` 逐段拒绝空/`.`/`..`/NUL/反斜杠/绝对/重复/尾斜线并用既有 normalize/isWithinRoot 保证在 canonical root 内；结果列表 ul+buttons 显示 relative path、aria-live=polite 状态区（Searching/No matches/N matches/Results truncated）、点击 valid 走 joinRelative→setSelectedFile 复用 meta/read preview、null 固定 `Invalid search result.` 且不发 meta/read；新增 code-first `describeIndexError`，INDEX_ABORTED 固定 `Search cancelled.`，网络/timeout 用既有 HttpError kind；cap 撤回整面板早退零请求/结果不可见、恢复不闪旧结果。允许文件：`paths.ts`/`paths.test.ts`、`FilesPanel.tsx`/`FilesPanel.test.tsx`、`app.css`、`resources.test.ts`/`query-options.test.ts`、两份 docs。实现验证：定向 paths 18 + FilesPanel 27 + resources 6 + query-options 8、Client 全量 428/428、root build/typecheck、root tests、boundary(82 files)/architecture/diff-check 与 raw-error scan 均 PASS。独立验证另有 joinRelative 恶意边界 57/57、StrictMode/cap撤回/cwd切换/root未就绪/401/form submit/response-union 九组 DOM 对抗 probe 全 PASS，无 F1/F2。无浏览器视觉验收（DeepSeek 无视觉能力），仅 DOM/a11y 测试覆盖；详见 migration-ledger §30。
10. `session-list-piweb-parity`：DONE（main `b5d6a4c` + docs `5f10352`，Fresh GPT 独立验证 PASS）。全量会话列表性能 hotfix（branch `fix/session-list-piweb-parity`，base 57ec461）。pi-sdk-adapter session store list 改为一次 `SessionManager.listAll()`/冷刷新 + normalized path→id map 派生 `parentSessionId`，绝不对每会话 `open`/getEntries 二次读；per-store 30s TTL 缓存 + 单一 in-flight promise 合并并发；warm 后 read/context/locate/resolveLeafId/delete 走 sessionId→path/info index，不再重跑全局 listAll；open 校验 id，stale path invalidate+rebuild 恰一次后 not_found，绝不错会话；delete 立即失效（create/discovery/rename 无窄 seam，记录最长 30s 陈旧）；Client sessions list query 加 `staleTime: 30_000` 并保留无 cwd 冷启动请求。本机 616 会话语料：冷 list 从旧 ~5.5s（含 2.53s 完全阻塞 event loop 的同步二次读，1ms 心跳 0 tick）降到新 ~2.97s（≈纯 listAll，心跳 2027 ticks），热 list 从 ~5.5s/次降到 1ms/次。验证：root build/typecheck EXIT 0、architecture/boundaries PASS、adapter 171/171、client 482/482、sessiond 158 pass/1 skip、runtime-core/protocol/contract/worker/cli/host 全绿、Sessions/Startup/Runtime 三条 E2E PASS、diff-check PASS。已合入 main 并部署至 `test-pi.huu.im`；公网实测 616 条会话冷 3.63s、热 0.58s，sessiond 健康；详见 migration-ledger §33/§34。
11. `D3A-P0` 可持久化 Trusted-Roots Ledger：DONE（main `f7c9a80`，source `dfb1759`，Fresh GPT 独立验证 PASS；branch `feat/d3a-p0-ledger-final`，base main 811c94e）。把仅内存的 Host 创建 worktree 受信根 claim 持久化为 PIX_HOST_DIR 下的 `trusted-roots.json`（schema v1，确定性 JSON，0600）+ `trusted-roots.lock` 生命周期锁（O_EXCL 0600）。严格单 Host：open 在 listen 前获取排它 lifetime host-dir 锁并持有至优雅 close()；任何既有锁（存活 LEDGER_LOCK_BUSY 或 stale LEDGER_LOCK_STALE）都以固定 sanitized 错误拒绝启动，绝无自动 stale 回收；SIGKILL 遗留 stale 锁下次启动 fail closed 且不动账本，operator/test 显式删除 fixture 锁后重启恢复授权。PIX_HOST_DIR 安全：新建 leaf 以 fd 设 0700；既有目录绝不 chmod，要求当前用户所有权（支持时）+0700+真实非 symlink+仅含已识别 Pix ledger/lock/temp 布局；变更前拒绝根/home 本身/共享 tmp/repo 树/被占用目录。损坏账本是不可变证据：缺失⇒空，corrupt/unknown-version/wrong-kind/duplicate/sparse/wrong-permission/hardlink/unsafe 使启动与 mutation fail closed，绝不改写/截断/重命名/删除（测试断言 bytes+inode 不变）。持久性：temp O_EXCL|O_NOFOLLOW 0600→write+fsync→身份校验→原子 rename→目录 fsync（FATAL 除窄枚举 EINVAL/ENOTSUP/EISDIR，附测试/注释）；返回 201 即发布完成。磁盘先于内存授权；rehydrate 佐证（canonical dev/ino+repo 身份+base 包含+`git worktree list`）+ 保留 foreign claims + 容量下调失败不破坏性清空；create 回滚只删精确 owner claim；delete 在 git 删除成功后移除 claim 且 restart 不复活；碰撞 fail closed。LAN：已认证 create/delete 可写持久 claim，未认证由既有 gate 在 Git/fs 前阻止；最小公开面（index.ts 只导出窄 facade）。验证：逐包typecheck、architecture/boundaries PASS、host 297/297（基线269+新增28）、cli46、adapter171、sessiond159（158+1 Windows skip）、runtime-core7、protocol116、contract75、agent-worker105、client482、scripts44；Startup/Sessions E2E PASS，独立锁/ledger/并发/rehydrate/启动失败探针全PASS，diff-check与工作树clean。已合入main，未部署；详见 migration-ledger §38。
12. `D4 Session-Rename Adapter Foundation`：FOUNDATION ONLY / DONE（main `953640b`，source `a266b01`，base main `125d0a6`；Fresh GPT 独立持久化/并发验证 PASS，未 push/deploy；由后续 sessiond 切片接线）。离线会话重命名 adapter/runtime-core 地基：新增 runtime-core `SessionMutationPort`（仅 `renameSession(sessionId,name)`，与只读 `SessionCatalogPort` 分离，catalog 保留既有 deleteSession 不变）；`createPiSdkSessionPorts()` 扩展为 catalog+locator+mutation 共享同一 `PiSdkSessionStore`（既有 `{catalog,locator}` destructure 向后兼容），新增 `createPiSdkSessionMutation()`；`PiSdkSessionStore.renameSession` 用既有 exact open/index path + `manager.getSessionId` 身份校验（missing/stale/wrong id → not_found，绝不新建/append 复用路径），名字规范化（trim、非空、≤200 Unicode JS code units、拒绝 NUL/C0/DEL，Unicode/emoji/内部空格允许），经 SDK `appendSessionInfo` 追加（不改 header/file），append 失败映射为 sanitized external/retryable file-kind 错误（无 path/raw message/name 泄漏），成功后立即 invalidate 同一共享 store 使下次 list/read 立即看到新标题（无 30s 陈旧窗口；标题真相源=JSONL 最新 session_info）；rename 与 delete 按 session id 共享 per-session FIFO 串行化（rename/rename 最后提交者胜；rename/delete 两种顺序确定性；不同 session id 并行、无全局锁；delete ENOENT 幂等与全部 revision/negative-cache fence 保留）。**仅地基：无 Host route/capability、无 sessiond production 接线（其 SessionMutationPort stub 未动）、无 Client API/UI、无 live `set_session_name` 改动、无 Protocol/sessiond/Host/Client 改动、无 package-lock/live 服务/部署**。允许范围：`packages/runtime-core/src/ports.ts`、`packages/pi-sdk-adapter/src/internal/session-store.ts`、`packages/pi-sdk-adapter/src/sessions/index.ts`、runtime-core type/boundary tests、adapter session/shared-port/public-surface tests、docs（migration-ledger §44）。验证：runtime-core 9/9、adapter 223/223（新增 17 定向：真实 JSONL rename 持久+即时、trim/blank/201/NUL/C0/DEL/Unicode/emoji、missing/stale/reused-path fail-closed、append 错误 sanitize、共享缓存即时刷新 bounded rescan、FIFO/rename-delete 确定性/不同 id 并行/重复 delete、public surface + shared-pair）、adapter boundaries PASS（21 source/10 public declarations 无 SDK 泄漏）、command coverage 26/26、runtime-core typecheck/build PASS、root diff-check 见提交。详见 migration-ledger §44。后续 slice：sessiond 在 live/offline 间选择 + activation fence。
13. `secure-Windows-state Slice 1 — local-authority POSIX 平台基础`：DONE（source `1dd6e7d` + raw-leak hardening `1d2caf2` 独立 security PASS；current-main 集成 `c2af2b9` + `6b3047d` + tooling adaptation `4951ac3` + evidence `5f96df8` 独立 integration-ready PASS，已合入 main，未 push/deploy）。新增 dependency-free workspace `@fffattiger/pix-local-authority`（`packages/local-authority`，零 runtime deps）：平台中立 secure-state contracts（`state/contracts.ts`，零 node: import）+ 从 Host `host-state-directory.ts` 抽取/适配的高保真 POSIX backend（`state/posix.ts`）：canonical 绝对路径（最近已存在祖先 realpath + 校验缺失尾 + canonical 组件回走；macOS `/var`→`/private/var` 系统别名不再误拒）、稳定 POSIX identity/principal、安全私有目录 + 原子持久文档发布（temp O_EXCL→fsync→身份→rename→目录 fsync + lockCheck）、lifetime lock 原语（busy/stale/unsafe 分类 + 精确 dev/ino+instanceId 释放）。Host 内部 `HostStateDirectoryLease` 委托底层操作、保留公共/API/error/layout/byte 语义（trusted-roots.json / managed-worktrees.json / trusted-roots.lock 不变；单一 lease/单一 mutex/单一 lock 由两账本共享）；validate-before-lock、既有根 validate-only（owner/0700/无中间符号链接，绝不静默 chmod 修复）、temp/fsync/rename 故障注入、第二 Host 阻塞、stale 不自动回收、replacement-path 安全精确释放均保留。Host boundary 只放行 `@fffattiger/pix-local-authority/state`；check:architecture 新增 local-authority boundary（禁 Protocol/Runtime Core/Pi SDK/Hono/React）。当前 main 集成验证：Host 394/394、安全重点 84/84、local-authority 43/43、architecture 14 gates PASS、architecture self-test 31/31、root 1345 pass + 1 skip、Startup/Sessions/Runtime E2E PASS、Node 22.19/24.12/24.18 focused/full 证据、diff-check 与 npm pack dry-run PASS。平台基础说明：本切片为 source-only 抽取/委托，无 persisted migration、无数据迁移脚本；lock/ledger 文件格式与字节不变。原生 Windows 仍不支持——需 native backend + secure named pipe + CI 门禁（Windows 专用测试矩阵）后才可声明，本切片不宣称。详见 migration-ledger §48/§49。**后续修复：ensurePrivateDirectory EEXIST/created 分类 + fd identity 钉住（§55，DONE）**：source `14e7ca2` + `772269d` + 残余窗口枚举 `56fa417`，合并 main `aef1a50`；首轮独立 verifier FAIL（mkdir 后 open 前替换真实目录被 fchmod 0700、跳过 validateExistingLeaf）已由 opened-handle fstat dev/ino 钉住修复，二轮 Fresh verifier PASS；确定性注入测试 10 个（旧实现对两个 swap 用例确定性 FAIL）；两个同 UID 残余窗口（mkdir→identity 捕获 lstat 之间、最终 pathname 检查之后）诚实枚举不宣称 fail-closed；local-authority 53/53、Host 420/420、Startup E2E 全绿；未 push/deploy。详见 migration-ledger §55/§55.1。
13. `secure-Windows-state Slice 1 — local-authority POSIX 平台基础`：DONE（source `1dd6e7d` + raw-leak hardening `1d2caf2` 独立 security PASS；current-main 集成 `c2af2b9` + `6b3047d` + tooling adaptation `4951ac3` + evidence `5f96df8` 独立 integration-ready PASS，已合入 main，未 push/deploy）。新增 dependency-free workspace `@fffattiger/pix-local-authority`（`packages/local-authority`，零 runtime deps）：平台中立 secure-state contracts（`state/contracts.ts`，零 node: import）+ 从 Host `host-state-directory.ts` 抽取/适配的高保真 POSIX backend（`state/posix.ts`）：canonical 绝对路径（最近已存在祖先 realpath + 校验缺失尾 + canonical 组件回走；macOS `/var`→`/private/var` 系统别名不再误拒）、稳定 POSIX identity/principal、安全私有目录 + 原子持久文档发布（temp O_EXCL→fsync→身份→rename→目录 fsync + lockCheck）、lifetime lock 原语（busy/stale/unsafe 分类 + 精确 dev/ino+instanceId 释放）。Host 内部 `HostStateDirectoryLease` 委托底层操作、保留公共/API/error/layout/byte 语义（trusted-roots.json / managed-worktrees.json / trusted-roots.lock 不变；单一 lease/单一 mutex/单一 lock 由两账本共享）；validate-before-lock、既有根 validate-only（owner/0700/无中间符号链接，绝不静默 chmod 修复）、temp/fsync/rename 故障注入、第二 Host 阻塞、stale 不自动回收、replacement-path 安全精确释放均保留。Host boundary 只放行 `@fffattiger/pix-local-authority/state`；check:architecture 新增 local-authority boundary（禁 Protocol/Runtime Core/Pi SDK/Hono/React）。当前 main 集成验证：Host 394/394、安全重点 84/84、local-authority 43/43、architecture 14 gates PASS、architecture self-test 31/31、root 1345 pass + 1 skip、Startup/Sessions/Runtime E2E PASS、Node 22.19/24.12/24.18 focused/full 证据、diff-check 与 npm pack dry-run PASS。平台基础说明：本切片为 source-only 抽取/委托，无 persisted migration、无数据迁移脚本；lock/ledger 文件格式与字节不变。原生 Windows 仍不支持——需 native backend + secure named pipe + CI 门禁（Windows 专用测试矩阵）后才可声明，本切片不宣称。详见 migration-ledger §48/§49。
14. `authenticated-shutdown`（认证 sessiond 控制平面关闭 + ACK-before-close + CLI RPC-only down）：PENDING 独立 PASS（branch `feat/authenticated-shutdown`，base main `5b8a7c9`，本 worktree，未 push/deploy/live）。编号：§55 保留给仍在飞的 Local Authority race（eexist/锁竞争），本切片占用 §56。手动 port 仅取 PR#3 有价值的 lifecycle 语义，不复制 PID/SIGTERM/PowerShell kill fallback。Protocol 新增内部 `system.shutdown`（strict `{instanceId}`/`{accepted:true}`，SESSIOND_RPC_METHODS 1:1）；serial-writer 新增 `enqueueFlushed(data, timeoutMs)` 有界交付屏障（真实 write callback + write=false 时 drain，跨 callback/drain/error/close/timeout 恰一次 settle，late 事件 no-op）；SessiondRpcServer 可选 `shutdownAuthority{instanceId, initiate}`，无 authority → unsupported fail closed，instanceId 错配 → forbidden 固定文案（不 echo），屏障成功才 `initiate()`（失败/超时绝不触发关闭）；daemon 注入 initiateShutdown 一次性 guard → idempotent shutdown，`runDaemon`/bin await closed 使外部 daemon RPC 关闭后以 exitCode 0 退出；CLI `down` 移除 SIGTERM/PID authority，改 RPC-only（inspectSessiond 读锁+secret+ping → `system.shutdown` exact instanceId → 有限等待 lock/socket 消失，pid 仅观察），失败原因固定 sanitized。无 Host HTTP/capability/health/WS 变更，`system.shutdown` 为 sessiond 控制 RPC 而非产品能力。验证（实现者已执行，独立 PASS 待补）：protocol 132/132、cli 52/52（新增 down-rpc 6 用例含 static 禁 SIGTERM/SIGKILL/taskkill/powershell/unix-kill 源检查）、sessiond 269/1 skip（新增 serial-writer-ack 11 + shutdown-rpc 12，多轮稳定；serial-writer-ack 含 1 个 follow-up 写回调报错 fail-closed 用例）、root build/typecheck/test 全绿、check:architecture PASS、sessiond/host boundary PASS、Startup（含 CLI `down --all` 经 RPC 退出并清 lock/socket）+ Runtime + Sessions E2E 全 PASS、git diff --check 干净。详见 migration-ledger §56。```

旧 worktree 中的 ACL1/C1/R1 不再继续开发；后续实现必须在 `pix` 中进行。

---

## 11. 任务交接格式

```text
任务：<ID + 名称>
状态：IN_REVIEW
Branch：<branch>
Commit：<hash>
Base：<hash>

修改范围：
- ...

实现摘要：
- ...

来源迁移：
- 旧路径/commit/tree hash
- 明确排除项

验证：
- command: PASS/FAIL

残余风险：
- ...

集成步骤：
1. ...
```

---

## 12. 决策记录

| ID | 决策 | 状态 |
|---|---|---|
| `N-001` | `pix` 是新架构独立产品仓库 | 冻结 |
| `N-002` | M1 必须交付可构建、可启动的新架构应用 | 冻结 |
| `N-003` | Next.js 不进入 `pix` 产品路径 | 冻结 |
| `N-004` | 旧成果按包迁移，不整体合并旧分支 | 冻结 |
| `N-005` | M1 启动 Hono + Vite Client + 独立 sessiond；最小 Agent Runtime 属于 M2 | 冻结 |
| `N-006` | CLI/composition 是 M1 核心，不再后置 | 冻结 |
| `N-007` | 旧测试结果不自动继承，迁入 `pix` 后重新验证 | 冻结 |
| `N-008` | capability 只声明完整接通且已验证的能力 | 冻结 |
| `N-009` | 产品命名统一为 `pix`：包 `@fffattiger/pix-*`、CLI `pix`/`pix-host`/`pix-sessiond`、env `PIX_*`；不保留旧品牌 alias，上游 Pi SDK 概念保持原名（历史证据仅存 `migration-ledger.md`） | 冻结 |
| `N-010` | secure-state 基础设施为依赖无关 workspace `@fffattiger/pix-local-authority`：平台中立 contracts（零 node: import）+ 高保真 POSIX backend；Host state lease 委托底层操作并映射固定 Host 错误码/消息；Host boundary 只放行 `@fffattiger/pix-local-authority/state` | 冻结（Slice 1） |
| `N-011` | secure-state canonical 路径：绝对路径 + 最近已存在祖先 realpath + 校验缺失尾 + canonical 组件回走；接受 macOS 根级系统别名（`/var`→`/private/var` 等），拒绝非根级用户符号链接中间组件、lexical 父级逃逸、根、网络/Windows 声明 | 冻结（Slice 1） |
| `N-012` | 原生 Windows secure-state 仍不支持（无 native backend / secure named pipe / Windows CI 门禁）；不因 contracts 平台中立而宣称支持 | 冻结（pending） |
