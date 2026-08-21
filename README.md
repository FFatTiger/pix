# pix

独立的新一代 pix 产品仓库。

目标架构：Vite Client + Hono Host + 独立 `pix-sessiond` + 每会话 Worker + Runtime Protocol + Pi 防腐层。旧 Next.js 产品树只作为迁移来源，不进入本仓库的产品路径。

## 当前里程碑

**M3 — Read and Operate**：M2 Minimal Runtime Happy Path 已完成并通过独立验证。当前 `main` 已包含真实对话、只读历史、History/Live Thinking/Bash 语义展示、selected history visible-branch normalized JSON 导出、Files/Git/Worktrees 只读工作区，以及 Models/Auth Providers/Skills/Plugins/Commands/Trust 的端到端只读 Domain Catalog。Trust 已支持 set-trusted mutation（独立 `project.trust` token、`POST /v1/trust`、Pi SDK trust.json 持久化）。OAuth、配置写入、安装、资源重载和 Extension 执行仍明确后置。

## 平台支持矩阵

跨端专题见 [跨端完善计划](docs/cross-platform-hardening-plan.md)。“支持”只由 required CI 与 packaged smoke 定义，不以编译成功或 README 宣称定义。当前诚实状态：

| 平台 | 支持等级 | 含义 |
|---|---|---|
| Windows 原生 | **Supported** | 默认 `~/.pi/pix` 可原生启动：SID/DACL/file-ID backend、Node 原生 named pipe（secret AUTH + 实例锁）、AllowedRoot（合法 in-root alias）、required start/shutdown smoke。Worker/Git 子孙清理对齐 VS Code `taskkill /T /F`。不以 WSL 作为 Windows 方案。Job Object 与 ledger v2 file-ID schema **不在产品路径**。仍未关门：packaged install/upgrade、完整 Windows `npm test`、持久 AllowedRoot。 |
| Linux | **Unverified-native** | 主要产品路径按 POSIX 设计。PR tooling + required `npm test` 已存在；还没有发行 smoke / 签名 / 产品化验证。 |
| macOS | **Unverified-native** | 主要产品路径按 POSIX 设计。PR tooling + required `npm test` 已存在；还没有发行 smoke / 公证 / 产品化验证。 |
| 浏览器 / PWA | **Partial** | localhost/HTTPS 可走普通 Web；HTTP LAN 是受密码保护的普通 Web，**不承诺**可安装 PWA。 |

Node 基线：`engines.node >=22.22.0`。当前锁文件在 Node `22.19.0` 下以 `npm ci --engine-strict` 确定性拒绝（`@lobehub/ui@5.30.2` 要求 `>=22.22.0`），因此 required CI 最低 lane pin `22.22.x`，另以 LTS `24.12.x` 验证。高于最低值的 Node 可用，但必须落在声明范围并通过对应 CI/smoke；Windows **Supported** 指原生 source-build 启动与日常开发路径，不是 G7 packaged 发行支持。不得在 G7 完成前宣称 Linux/macOS 已被产品化验证。

## 从这里开始

- [执行计划](docs/refactor-execution-plan.md) — 当前里程碑、任务看板、依赖、验收和执行规则
- [目标架构](docs/refactor-architecture.md) — 进程边界、技术选型和长期不变量
- [迁移台账](docs/migration-ledger.md) — 旧工作区成果来源、排除项和重验状态
- [跨端完善计划](docs/cross-platform-hardening-plan.md) — Windows / Linux / macOS 问题、目标与分阶段路线

`docs/refactor-execution-plan.md` 是当前执行单一事实源。

### 当前协作基线

- `main@bd322486`：本切片从该 commit 建立跨端 G0 基线；D1B Thinking/Bash 展示、visible-branch export 与 D3A Worktrees 只读列表已合入。
- History 与 Live 共用结构化 Transcript projector；Thinking 安全折叠，Bash 显示 command/output/status 且不渲染 `fullOutputPath`；二者均不新增执行能力或 Worker 激活。
- Visible-branch export 仅对 selected history SessionContext 可见，在 Client 本地生成 normalized JSON；不是 archive、raw JSONL 或全分支导出，不新增 Host API、Worker 或 Runtime 命令。
- Workspace Dock 已提供 Files/Git/Worktrees Tabs；`worktree` 仅代表 GET/list，sessiond down 时仍可读取，Client 无创建、删除、切换或 promotion 控件。
- D3B 端到端只读 Catalog 仍保持完成；不得恢复聚合 `sdk-data`、Catalog Mutation/OAuth 路由或隐式 `process.cwd`。

新任务默认从最新 `main` 分支创建；需要接续进行中任务时，先确认文件范围并避免重复修改同一模块。
