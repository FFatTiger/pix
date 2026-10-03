# 生命周期修复：验收与发布交接

2026-09-10。修复已通过独立验收，并在用户明确授权维护后部署到生产。入口：[https://m.huu.im:30145](https://m.huu.im:30145)。上线后真实浏览器的两次发送、刷新保留和持久化核对已完成。

## 已验证的用户行为

- 选择正在执行的会话，可以看到当前回复；切换、刷新和关闭后重新打开浏览器，不会重复发送该条消息。
- 已有历史会话可以冷发送、显示回复、结束并再次发送。真实 SDK 覆盖 1000 条消息以及约 2.2MB JSONL；浏览器覆盖 320 条工具密集消息。
- 新建会话可连续发送两次，两次回答都显示；第二次回答用独立标记核验，不会误认上一条内容。
- 主目录属于正常 Projects。分类版本升级会重建旧缓存，保留临时目录、隐藏会话和父子关系的排除策略。
- 权限撤销会释放浏览器观察，保留后台会话；未知权限不会授予新的执行能力。

## 最终修复身份

验证使用生产代码提交 `ec324d5d82503b92f743f6e1cd25205006534a37`；实际上线提交为 `5225c740db84874613d1afa6cf4c69d82e5d1176`。两者之间仅增加验收和架构记录，不改变产品代码。本次上线结果记录本身亦为文档更新，不要求替换正在运行的程序。

| 缺陷 | 修复 |
|---|---|
| 部分回复被 90ms 缓存截留，模型暂停后不显示 | `b9371a5`：直接发布共享投影中的部分回复 |
| 新建会话页面提升后，确认回调不再识别正在等待的记录 | `e892100`：原位更新 provenance，保留 pending 对象身份 |
| 晚到的发送确认把已收到消息的进度退回旧值，导致第二条回答丢失 | `ec324d5`：保留已知的同 epoch 较新 cursor/snapshot，同时照常完成确认和身份对账 |

其余观察、授权、兼容及目录分类改动的来源见 [migration-ledger.md §105](./migration-ledger.md)。当前任务状态以 [执行计划](./refactor-execution-plan.md) 为准。

## 独立验证

- 全量 Client：88 个测试文件、996 项通过。
- 根级 `check:architecture`、`typecheck`、`test`、`build`、`git diff --check` 通过；Client/Host/Adapter 边界、Adapter 26 项命令覆盖通过。
- Node 测试：2055 项通过、0 失败、1 项平台条件跳过；CLI 79、Adapter 406、Host 584 均通过。
- 既有 Startup、Runtime、Sessions E2E 均通过。
- 真实 SDK：5 份语料，各发送两次；请求内容、两次持久化身份、结束后的空闲状态、失败重试及同操作去重均通过。
- 默认浏览器脚本独立运行三次：36 次发送，其中 15 次长历史发送；6 次 A→B→A busy 选择恢复循环，另覆盖刷新与浏览器重开。当前部分回复、唯一第二回复、精确一次请求、空闲状态和 Worker 身份检查均通过。
- Chrome 关闭拒绝的清理探针通过；最终无自有 Worker、Chrome、临时 profile 或测试目录残留。

最后一轮根级测试曾出现启动退出超时和 heap OOM。未改源码、测试预算、Node 参数或堆上限；两个文件单独复跑为 41 通过、0 失败、1 平台跳过，随后原始默认 `npm test` 完整复跑退出 0。失败记录保留，不以跳过或增加预算代替通过。

独立浏览器实际加载的资源为 `assets/index-BC_qErqZ.js`，大小 2,641,270 字节，SHA-256：

```text
2f8d9fe97e2ca2b5daaa4088e6ebe99728a21d3d3335398afc5815dd7e7a9c58
```

三个运行均确认 served bytes 与对应构建文件一致。固定验证目录中的日志为：

- `lifecycle-final-product-logs/final-cursor-*`：独立完整构建、SDK 和三次浏览器执行；退出文件均为 0。
- `lifecycle-root-verification-logs/cursor-final-*`、`cursor-isolated-failures*`：根级检查、原始失败、单独复跑和默认总测试恢复通过。

这些目录位于本机 `pix-worktrees` 下，为验证记录，不属于生产会话数据。该结论不承诺超过既有 RPC/上下文限制的任意大记录都可加载。

## 发布边界与具体操作顺序

本次目录分类使用 Adapter contract 2 / projection schema 5。旧运行进程不能与新版本混用同一索引；已有会话正在执行时，不能直接替换其代码或仅覆盖前端资源来宣布整个修复上线。

以下为本次授权采用的维护顺序；执行结果见下节：

1. 在维护开始前确认目标 Pix 服务、当前代码、daemon 实例和会话状态，暂停该入口的新请求；记录实际版本，避免操作其他独立实例。
2. 经明确授权，通过正式 CLI/认证 RPC 关闭目标服务及其后台会话。仍在执行的任务会被中断；已经写入的 JSONL 历史保留。不用 PID/SIGTERM 绕过正常关闭。
3. 保留旧代码与配置备份，切换到验收候选，在不兼容的旧进程已经退出后启动一致版本。索引由其 owner 按新 schema 重建；不覆盖或回滚用户 JSONL。
4. 核对新服务的实际 Client 资源、握手能力、backend build 和只读 Projects/历史入口，使用独立临时会话做发送及恢复验证，确认后恢复使用。
5. 若失败，保持诚实的不可用状态。回退同样需要一致版本维护，不能热换活动 Worker，也不能把旧索引/JSONL 覆盖回去来隐藏错误。

此维护边界来自已审查的 [lifecycle-reassessment.md §7](./lifecycle-reassessment.md#7-发布回退与证据要求)。用户已明确同意本次维护。检查发现原 Pix Host/sessiond 均已退出，未中断既有活动会话；没有操作其他项目的服务。

## 实际上线与复验结果

- 正式目录 `/Users/proxy/Documents/program/pix` 的 main 已快进到 `5225c74`，随后完整构建退出 0。原代码通过 `backup/lifecycle-before-upgrade` 保留；配置、旧日志、锁记录和旧前端文件备份在权限 0700 的 `~/.local/state/pix/deploy-backups/20260910T050349Z`。
- 只清理了确认进程已死、socket 无监听且身份未变的陈旧启动记录；用户 JSONL、现有密码和历史没有删除或改写。期间的自建第一次启动通过 Host 正常关闭及 `cli down --all` 退出后再完整构建，没有 PID 信号旁路终止 daemon。
- 官方 CLI 恢复 Host `127.0.0.1:30145` 和 sessiond。nginx 与端口 `30141` 上的原有服务保持不动；公网正常 TLS 访问 `/v1/health` 为 200、sessiond up。
- 原登录保护仍启用，未登录 Projects/会话/能力接口和 WebSocket 返回 401；使用原密码正常登录成功。认证 hello 为 Protocol 2 / Adapter contract 2，existing-only、explicit activate、submit-turn 等本轮能力正常协商。
- 本地、公网与磁盘实际资源一致：`assets/index-B8FVfOTl.js`，2,641,270 字节，SHA-256 `537f47e22ef7c69c5c2c8c0453bc1a3ea619060c31c9c6f7822fde4af899eeff`。这是生产目录的实际构建身份，未把独立测试目录的资源名当成生产资源名。
- Projects 包含 `/Users/proxy`；历史详情可读，读取前后运行 Worker 均为 0。
- 上线后独立真实浏览器新建专用会话：第一条唯一回答约 7.9 秒显示，第二条约 5.6 秒显示；两轮均结束且输入恢复空闲，刷新后两条问答保留，持久化 context 含两条精确请求和对应回答。
- 两个不同 operation 均各接受一次并完成；观测到第三个传输帧是第一个 operation 的同身份重发，返回 duplicate，没有第三条用户意图。
- 所有自建测试会话经正常 stop/delete 清理，详情复查 404、测试 Worker 为 0；测试 Chrome/profile 和空工作目录均已删除。最终 Host/sessiond 保持运行。

上线复验脚本曾错误要求总 context 条目恰为 4，而实际为 8（除两组问答外还有其他上下文条目）；原始失败记录保留。父审查核对原始结果中两条精确请求、两个唯一回答、刷新、终态身份和清理证据均通过，按这些既定行为标准接受复验，不将总条目数作为产品行为要求。

受保护的实际上线记录为备份目录内 `deploy-handoff.json`、`verify-results.json` 和 `smoke/postdeploy-browser-smoke-final-assessment.json`；未记录密码或 cookie。
