# pix 新架构执行计划

> **执行单一事实源（SSOT）**
>
> 当前目标不是继续维护旧 Next.js 单体，而是在独立的 `pix` 仓库中交付新架构产品。
> 第一里程碑必须是一个可以实际构建和启动的独立应用。

- 最后更新：2026-08-11
- 项目状态：`ACTIVE`
- 当前里程碑：`M1 — Bootable Standalone App`
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

## M1 — Bootable Standalone App

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
| `B2` | Host + Client Boot Surface | `IN_REVIEW` | `B0`, `B1` | `c65d2df` + root lockfile；Client 82/82、Host 132/132、真实Client dist托管 smoke PASS；最终随M1启动链统一GPT验证 |
| `B3` | sessiond Daemon Bootstrap | `DONE` | `B0`, `B1` | `5dc9469` + `44529c3`；GPT复验 PASS；sessiond 38/38，启动信号40/40、回归118/118、专项24/24 |
| `B4` | Production Composition + CLI | `READY` | `B2`, `B3` | `pix`、`pix-host`、`pix-sessiond`、ensure/reuse、`down --all` |
| `B5` | Startup E2E | `BLOCKED` | `B4` | build/start/browser/API/PID/lifecycle E2E |

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
| `R0` | Protocol Process Corrections | `BLOCKED` | `M1` | create/open、epoch、interrupt commandId、stream/bash 语义修正 |
| `R1` | Agent Worker Controller + Mapper | `BLOCKED` | `R0` | Worker IPC、显式 Mapper、create/open/prompt/abort/snapshot/shutdown |
| `R2` | Child Process Worker Factory | `BLOCKED` | `B3`, `R1` | sessiond 每会话启动一个 Worker |
| `A1` | Pi SDK Agent Adapter | `BLOCKED` | `B1` | 迁 Agent 路径，修 custom UI/sanitizer，最小 capability |
| `H1` | Runtime WS Gateway | `BLOCKED` | `B2`, `B3`, `R0` | Host WS ↔ sessiond RPC |
| `C1` | RuntimeSocket + SessionStore | `BLOCKED` | `B2`, `R0`, `H1` | handshake/create/attach/prompt/abort/reconnect/snapshot |
| `X1` | Minimal Runtime E2E | `BLOCKED` | `R2`, `A1`, `H1`, `C1`, `B4` | prompt、stream、abort、Host restart/resume、去重、隔离 |

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

| ID | 工作包 | 依赖 | 交付 |
|---|---|---|---|
| `D1` | Sessions Read Path | `M2`, Session Catalog Adapter | list/detail/context/export；历史浏览 0 Worker |
| `D2` | Runtime Command Expansion | `M2` | model/thinking/tools/bash/compact/fork/navigate/reload |
| `D3A` | Files/Git/Worktree | `M2`, `B2` | 迁 H1B、安全策略、busy preflight、Client UI |
| `D3B` | Models/Auth/Skills/Plugins/Trust | `M2`, Data/Resource Adapter | 修安全问题后接 Host/Client |
| `D4` | Mutations + Side Chat | `D1`, `D2`, `D3A`, `D3B` | rename/delete/trust/worktree 协调、Side Chat |

## Wave 4 — Scale、PWA、Release

| ID | 工作包 | 依赖 |
|---|---|---|
| `SCALE1` | SQLite JSONL Projection | `D1` |
| `UX1` | Chat/Sidebar Virtualization | `D1`, `D2` |
| `PWA1` | LAN Gate、配对、后台 Resume | `M2`, `D3A` |
| `REL1` | 安装、升级、卸载、发布验证 | 发布范围功能完成 |

`PiRpcAdapter` 保持 `BACKLOG`，不进入当前关键路径。

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
1. B0：DONE（`e087bf0`）
2. B1：DONE（`ea7e207`，GPT 独立验证 PASS）
3. 当前：B3 DONE；启动 B4 Production Composition + CLI
4. B4 完成后执行 B5 Startup E2E，达到 M1
5. 达到 M1 后再启动 M2 Runtime Vertical Slice
```

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
