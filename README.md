# pix

独立的新一代 pix 产品仓库。

目标架构：Vite Client + Hono Host + 独立 `pix-sessiond` + 每会话 Worker + Runtime Protocol + Pi 防腐层。旧 Next.js 产品树只作为迁移来源，不进入本仓库的产品路径。

## 当前里程碑

**M2 — Minimal Runtime Happy Path**：M1 可启动独立应用已完成并通过GPT最终验证。当前接通 agent-worker、Pi SDK Agent Adapter、Host Runtime WebSocket 与 Client RuntimeStore，实现 create/open、prompt、stream、abort 和 snapshot/resume。

## 从这里开始

- [执行计划](docs/refactor-execution-plan.md) — 当前里程碑、任务看板、依赖、验收和执行规则
- [目标架构](docs/refactor-architecture.md) — 进程边界、技术选型和长期不变量
- [迁移台账](docs/migration-ledger.md) — 旧工作区成果来源、排除项和重验状态

`docs/refactor-execution-plan.md` 是当前执行单一事实源。
