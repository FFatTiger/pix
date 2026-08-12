# pix

独立的新一代 pix 产品仓库。

目标架构：Vite Client + Hono Host + 独立 `pix-sessiond` + 每会话 Worker + Runtime Protocol + Pi 防腐层。旧 Next.js 产品树只作为迁移来源，不进入本仓库的产品路径。

## 当前里程碑

**M3 — Read and Operate**：M2 Minimal Runtime Happy Path 已完成并通过 GPT 最终验证。当前扩展 sessions 只读路径、完整 Runtime commands、Files/Git/Worktree，以及 Models/Auth/Skills/Plugins/Trust 产品切片。

## 从这里开始

- [执行计划](docs/refactor-execution-plan.md) — 当前里程碑、任务看板、依赖、验收和执行规则
- [目标架构](docs/refactor-architecture.md) — 进程边界、技术选型和长期不变量
- [迁移台账](docs/migration-ledger.md) — 旧工作区成果来源、排除项和重验状态

`docs/refactor-execution-plan.md` 是当前执行单一事实源。
