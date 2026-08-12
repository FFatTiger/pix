# pix

独立的新一代 pix 产品仓库。

目标架构：Vite Client + Hono Host + 独立 `pix-sessiond` + 每会话 Worker + Runtime Protocol + Pi 防腐层。旧 Next.js 产品树只作为迁移来源，不进入本仓库的产品路径。

## 当前里程碑

**M3 — Read and Operate**：M2 Minimal Runtime Happy Path 已完成并通过独立验证。当前 `main` 已包含真实对话、只读历史、Files/Git 工作区，以及 Models/Auth Providers/Skills/Plugins/Commands/Trust 的端到端只读 Domain Catalog。D3B 只读链已完成；OAuth、配置写入、安装、资源重载、Trust 修改和 Extension 执行仍明确后置。

## 从这里开始

- [执行计划](docs/refactor-execution-plan.md) — 当前里程碑、任务看板、依赖、验收和执行规则
- [目标架构](docs/refactor-architecture.md) — 进程边界、技术选型和长期不变量
- [迁移台账](docs/migration-ledger.md) — 旧工作区成果来源、排除项和重验状态

`docs/refactor-execution-plan.md` 是当前执行单一事实源。

### 当前协作基线

- `main@8001fa4`：稳定 checkpoint；D3B-R1A Domain Ports、R1B Host API 与 Client 只读 Catalog Dock 已完成并通过独立验证。
- Host 已开放只读 `/v1/models`、`/v1/auth/providers`、`/v1/skills`、`/v1/plugins`、`/v1/commands`、`/v1/trust`；项目级读取强制授权后的 canonical `cwd`。
- Client 已按 capability 提供 Models/Providers/Skills/Plugins/Commands Tabs 与 Trust 状态；无 capability、无项目或 Dock 关闭时不发起隐藏请求。
- 下一任务从最新 `main` 新建分支；不得恢复聚合 `sdk-data`、Catalog Mutation/OAuth 路由或隐式 `process.cwd`。

新任务默认从最新 `main` 分支创建；需要接续进行中任务时，先确认文件范围并避免重复修改同一模块。
