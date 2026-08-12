# pix

独立的新一代 pix 产品仓库。

目标架构：Vite Client + Hono Host + 独立 `pix-sessiond` + 每会话 Worker + Runtime Protocol + Pi 防腐层。旧 Next.js 产品树只作为迁移来源，不进入本仓库的产品路径。

## 当前里程碑

**M3 — Read and Operate**：M2 Minimal Runtime Happy Path 已完成并通过 GPT 最终验证。当前 checkpoint 已支持从首页输入绝对项目路径创建真实对话；D1 Sessions Adapter 与 D2 Runtime capability 地基已进入主线，历史只读链和 Files/Git/Worktree production wiring 在独立协作分支继续。

## 从这里开始

- [执行计划](docs/refactor-execution-plan.md) — 当前里程碑、任务看板、依赖、验收和执行规则
- [目标架构](docs/refactor-architecture.md) — 进程边界、技术选型和长期不变量
- [迁移台账](docs/migration-ledger.md) — 旧工作区成果来源、排除项和重验状态

`docs/refactor-execution-plan.md` 是当前执行单一事实源。

### 当前协作分支

- `main`：稳定 checkpoint（M2 DONE、D1A-1、D2-P0、first-run project entry）
- D1A-2 phase 1 已进入 `main`；phase 2（Host routes + Client只读历史 + 0 Worker E2E）应从最新 `main` 新建分支
- `m3/d3a1-production-resources`：D3A-1 Files/Git/Worktree production composition（`1c7a848`，等待GPT安全验证）

新任务默认从最新 `main` 分支创建；需要接续上述进行中任务时，先与对应分支负责人确认并避免重复修改同一文件。
