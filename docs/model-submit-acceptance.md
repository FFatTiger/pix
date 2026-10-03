# MODEL-01：发送模型与多 TAB 生命周期验收

状态：修复与完整候选验证通过，尚未发布。此记录不将旧版历史页刷新验收当作发送链路验收。

用户报告输入框显示模型 A，发送后变为 B，并明确要求覆盖多 TAB、多会话。

## 已复现的原因

- Client 只携带手动暂存模型，未携带历史、首页默认或实时基准中的可见模型；收到受理回执时暂存又先于观察接回被清除。
- Adapter 打开已有会话时将全局默认作为显式模型传入 SDK，覆盖其原生持久模型恢复顺序。其他会话切模型会影响这个全局默认，因此会放大跨会话差异。
- 普通模型/思考变更的异步执行窗口与 turn admission 不互斥，两个 TAB 的操作可交错。

`2b230b0` 基线上新增真实 Chrome 测试明确失败：同会话 TAB1 显示 `pix-e2e-alpha`、Worker 为 `pix-e2e-beta`，发送实际使用 beta；不同会话也出现 alpha 显示、beta 请求。实际请求由本地受控 provider 记录，以 prompt hash 和 model 关联，不用 admission snapshot 替代执行证据。

## 最终候选行为

- 协商 `runtime.submit-turn.v1` 后，发送捕获可见模型并通过同一次 `activationOverrides` 提交。已知不可变且未改变的实时模型省略冗余设置；不支持的显式修改失败，不静默换模型。
- SessionController 同步安装权威 admission snapshot，再完成公开 promise。观察接回前的显示资格受 exact session、presentation provenance、history generation、operation/epoch 和生命周期围栏约束；不另存已受理模型，不按模型值猜测历史新旧。
- 暂存只保留未发送选择，容量限制不变。按捕获的不可变 revision 清理；A→B→A、清除后迟到回执、新选择均不会被旧回执误清。
- 同 epoch 较旧的普通 snapshot 不能回退模型/游标。断线或致命失效清除受理显示资格；无 final leaf 的快速终态等待有界观察结果后通过既有历史更新机制收敛。
- Adapter 以 SDK session context 的消息语义判断 continuation，已有会话由 SDK 原生恢复模型。普通模型/思考变更与发送受理在每个 runtime 内互斥；冲突返回 `session_busy`，interrupt/stop 与其他会话独立。关闭期间不会继续启动 prompt，也不读取已销毁驱动。
- Adapter 行为版本从 3 升至 4；sessiond/Worker wire contract 仍为 5/4，组合为 **5/4/4**。旧 Worker/daemon 不得静默复用；发布仍受现有显式维护规则约束。

## 验收矩阵与证据

| 场景 | 证据与状态 |
|---|---|
| 同一会话、两个真实 TAB | 最终 `2225eb8` 产品代码 / `eda5f8f` 测试诊断候选 PASS；随后 exact-operation oracle `0b8f1e8` 再次 PASS：可见 alpha 对应 3 次 alpha 请求，一个 Worker；关闭第二 TAB 后继续发送成功 |
| 不同会话、两个真实 TAB | 最终候选和 exact-operation oracle 均 PASS：alpha/beta 各自模型与 Worker；A 在 provider gate 等待时 B 先完成 |
| 旧回执、会话切换、代际与快速终态 | Client 全套 1034 项通过；独立最终复验 PASS；新增同实例流式→完成 fade 回归另 3/3 通过 |
| Adapter 模型恢复/互斥/关闭 | Adapter 434 项通过；独立对抗复验 PASS；父级真实 continuation + barrier 13 项通过 |
| E2E 驱动可靠性 | 独立 PASS：新鲜请求记录、终态/最终重复请求检查、真实 TAB 关闭确认、CDP 超时/断连后恰好一次失败；取消后等待场景退出再清理 |
| 完整最终门禁 | `/tmp/model-submit-gates/status.json` 中 architecture/typecheck/test/build、client boundaries、adapter commands、Startup/Runtime/Sessions 均 exit 0；`/tmp/model-submit-e2e-final/status.json` 中 multi-tab、真实 SDK、严格浏览器全部 exit 0 |

真实 SDK 验证 5 类历史（含 1000 条消息、工具密集、压缩后、大 JSONL）各两次冷/热发送，另有 3 个有界失败和同 operation 去重。严格浏览器验证短历史 A→B→A、刷新/重开、新会话首发及工具密集长历史。最终 served/file JS SHA-256 为 `1902ca3bb36672e5…`，源码/静态产物一致。

## 间歇性终态指示记录

在 `2225eb8` 的一次 S1 实跑中，provider 模型正确且回答终止标记已到，但整页 `.is-streaming` 查询 20 秒未清。相同产物随后连续 4 次双 TAB 通过，最终 SDK/严格浏览器也通过。原失败发生在增加状态诊断之前，缺少 exact operation 与 DOM 节点分类，不能事后认定为产品已修复或纯测试错误。

独立诊断确认，原 oracle 将最后回答文本与全页任意旧 assistant/Markdown 的 streaming class 混用，且 Markdown class 有独立 280ms 动画 hold。最终测试改为更强的关联条件：本次 outbound operationId 收到 completed，唯一匹配 reply nonce 的回答 root/Markdown 已 settled，并且 composer idle；仍保留结构化超时诊断。`MessageView.stream.test.tsx` 用 fake timers 验证同实例流式→完成时 root 立即清除、Markdown hold 按既定时限结束。此为测试精确化，不声称解决未经复现的产品终态缺陷；若再次出现，按 operation/cursor/节点证据继续追踪。

双 TAB 驱动命令为 `npm run test:e2e:multi-tab`。同一独立 Chrome profile 中打开两个 targets，各自运行实际 Client/RuntimeProvider/WebSocket，连接真实本地 Host/sessiond/SDK Worker。provider 为 loopback 受控服务，所有配置、JSONL、认证与浏览器 profile 都在临时目录。退出时关闭自有 TAB/Chrome、通过既有 teardown 停止临时服务并清理目录。用户运行会话和生产 `~/.pi` 未用于写入测试。

原有 Startup/Runtime/Sessions、真实 SDK 和单 TAB 长生命周期语料仍保留，最终门禁会一并运行。已移除百分比的 `≈` 展示符号（`2b230b0`），此修复不恢复该符号。
