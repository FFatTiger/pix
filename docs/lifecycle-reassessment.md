# Pix 生命周期重新评估与重构方案

> 状态：`IMPLEMENTATION / 独立方案审查 PASS，LC-00 已启动`。用户已明确授权实施；构建与验证在隔离候选环境进行，生产会话不作为测试对象。
> 评估基线：Pix `5002eec`；源项目 HEAD `73ca7c0` 及本机经审查工作区，名称和出处见 migration-ledger §104，差异见 §9。评估日期：2026-09-09。
> 执行入口仍为 [refactor-execution-plan.md](./refactor-execution-plan.md)；本文件承载本次重构的行为契约、范围与验收。既有硬边界以 [refactor-architecture.md](./refactor-architecture.md) 和 [AGENTS.md](../AGENTS.md) 为准。

## 1. 评估结论与证据范围

**推荐：保留现有进程架构，重整观察、执行和恢复的行为契约与调用衔接。** 第一条交付链是“点进 busy 会话就能继续看流，同时绝不隐式启动 Worker”；第二条是用失败时间线定位并修复长会话发送；发布与回退必须保证不兼容检查不会自动结束活动会话。不会另建一套 Runtime store，也不会把全仓重写当成前置。

Pix 的迁移同时改变了技术栈、进程归属、实时协议和页面状态寿命。旧系统中“再次订阅同一个内存 AgentSession”的操作，被拆为跨进程身份解析、Worker 激活、消息受理、观察订阅和快照恢复。额外的故障状态没有始终映射成一致的用户行为；部分测试还把偏离源行为的规则固定为验收条件。

本轮以源项目的可观察行为为迁移基线，保留 Pix 明确需要的会话保活与协议安全能力。恢复行为不等于复制旧 Next 模块、轮询或 SDK 类型。

| 编号 | 当前证据 | 能证明什么 | 不能据此声称什么 |
|---|---|---|---|
| E1 | `AppShell.tsx` 仅在选中 ID 等于 `initialSessionIdRef` 时自动恢复 busy 会话观察；`AppShell.test.tsx` 要求 busy A→B→A 零 attach | 后续点进 busy 会话被既有策略排除，测试与用户期望冲突 | 这一个条件解释所有长会话发送失败 |
| E2 | Host `coldAttach` 在 `worker_unavailable` 后调用 `runtime.activate` | 当前 attach 不保证仅观察；客户端 running watch 存在过期竞态 | 放宽前端 effect 就能安全恢复所有流 |
| E3 | `tests/e2e/runtime.mjs` 使用真实进程链和模拟 Runtime Factory；Sessions E2E 的运行部分也使用替身 | 现有测试有协议/进程覆盖价值 | 它们覆盖了真实 SDK、浏览器 UI 与长上下文模型调用的完整交集 |
| E4 | `5002eec` 消除了 runtime open 无条件 SDK 全量扫描；用户旧会话 ready 约 1.7s | 一处冷启动性能问题已定位并修复 | 用户报告的长会话发送问题已解决 |
| E5 | `runtime-open.test.ts` 使用 header-only 语料，在首个初始化 trace 处停止；另一次 1,096-message、约 3.56MB 隔离副本可在约 1.4s ready | 索引定位/ID 校验有回归；特定长历史能够初始化 | 长历史 admission、模型请求、首个事件、终态和重连续流全部成功 |
| E6 | `/Users/proxy` 被 `browseKindForWorkspace` 分类为 `session_only`，先前只读查询能看到其中 54 个会话 | 主目录缺少 Project 行是明确的分类策略问题 | 应通过改变 runtime 授权或 Worker 生命周期修复目录展示 |

长会话发送失败的最终原因仍为 **未定位**。消息数、JSONL 字节数、当前分支上下文 token、实时帧大小是不同指标；不得把其中一个直接当成另一个的证据。

本轮没有重新运行上述历史实验。历史 PASS 只保留其原覆盖范围；不得继续把“生命周期主线已关闭”当作当前产品结论。

## 2. 架构选择的评估原则

- Vite/Hono 迁移本身不要求增加 daemon、Worker 或重写订阅语义。
- “Web 可重启、运行会话继续”需要会话执行脱离 Host；已有 sessiond 承担该职责。
- 每会话 Worker 提供故障隔离，但引入启动、IPC、版本和资源管理成本。当前仓库已将其设为硬边界，本轮必须评估成本，不能在没有替代证据时拆除。
- 已有 RuntimeConnection、exact SessionController、Registry 和唯一观察 lease；不得再增加第二套生命周期 store 或页面级恢复状态机。
- 本轮成功以用户操作的完整行为判断；模块拆分、测试数量、单次短会话成功均不能单独关闭问题。

| 方案 | 收益 | 代价与适用性 | 本轮判断 |
|---|---|---|---|
| 保留当前进程边界，重整观察/执行契约与调用衔接 | 保住 Host 可重启、Worker 隔离和已有身份防护；改动集中在失配的接缝 | 仍要维护 IPC/协议/恢复，但可通过完整链路验收约束 | **推荐方案**；保留进程架构，修复明确失配的接缝 |
| 所有 SDK 会话移入 sessiond 单进程 | 减少一跳 Worker IPC，接近旧 Map 所有权 | 弱化会话故障隔离，改变既定每会话 Worker/SDK import 边界；需重新评估内存、崩溃和扩展隔离 | 当前没有证据证明这一跳是长会话失败根因，不纳入本轮 |
| 会话重新放回 Hono Host | 最接近旧版服务端对象复用 | Host 重启会话保活目标无法维持，违反现有生命周期权威边界 | 不选；只有产品目标明确改变后才有重新评估意义 |

简化优先针对重复决策和错误语义，不以减少文件数、增加一个总状态机或更换 SDK 接入方式作为目标。保留 `submitTurn` 的唯一发送受理权威；保留独立中断/read 通道和 shared reducer；不在页面层再拼一遍 activate→settings→prompt。

## 3. 交付边界

RA-PLAN 已交付评估结论、行为契约、分阶段任务板、验证矩阵与发布条件。用户随后明确要求“开始实施”，原先仅评估/停止代码修改的约束已被这次授权替代。实施和候选构建/测试已获授权；仍须隔离当前生产会话，生产切换服从 §7 的兼容及维护条件。

`/Users/proxy` 可见性单列为后续目录任务：在 catalog owner 修正分类与持久投影重建/版本条件，证明 Projects 总数、分页和历史会话可达性；不通过启动 Worker、放宽权限或把主目录塞入 Client 临时列表处理。

外部旧 Web/CLI 与 Pix 共享 JSONL 只说明历史互通。跨运行时实时订阅、正在运行文件的写入归属与接管是单独的能力边界；不能从“本 sessiond 没有 Worker”推导“没有外部写入者”。一个只有 Pix 遵守的锁也不能证明对外部工具的排他性。**本轮支持 Pix-owned 会话的实时恢复，以及已停止外部写入的历史继续运行；不承诺外部运行中会话无缝接管。** 若产品要求跨运行时接管，须先另立双方都遵守的 ownership/lease 协议与迁移方案，在此之前不得把该能力列为支持。候选验证使用隔离 agentDir，避免碰正在运行的用户文件。本轮不会新增跨运行时桥接服务。

## 4. 拟定行为契约

每个动作必须分别回答“选中谁、观察谁、谁在执行、这条消息是否已受理”。它们由既有 owner 分别维护，不合成一个页面级巨型状态机。

| 动作/状态 | 目标行为 | 明确禁止 |
|---|---|---|
| 选择未运行的历史会话 | 立即展示该 session/branch 的历史；不启动 Worker | 用加载历史、查状态或打开菜单触发 activation |
| 选择正在运行的 Pix 会话 | 在授权和能力满足时观察其 snapshot + events；URL、侧栏、Tab、前进后退使用相同规则 | 仅首次 URL 可恢复；把另一会话的订阅误当作当前已连接 |
| A→B→A、快速 B→C | 最后选择意图拥有前台观察；晚到结果仍按原 session/generation 处理 | A 的消息出现在 B，B 的晚到 attach 抢回 C |
| 选中会话由 idle 进入 busy | authoritative watch 到达后补观察，不依赖用户再点一次 | 轮询 JSONL 猜执行状态 |
| 已观察会话从 busy 完成 | 保持观察直到终态/投影收敛；随后可保留当前 idle 订阅 | busy=false 抢先 detach 导致丢掉 terminal 或最后一段输出 |
| 浏览器刷新/网络恢复/Host 重启 | 重新握手、取得 running authority、恢复选中观察；用 epoch/cursor 恢复事件 | 因刷新或换浏览器生成一条新 prompt |
| 发送已有会话 | 既有 `submitTurn` 负责验证、按需激活、settings 与恰一次 prompt；页面立即展示真实发送状态 | Composer 自己编排第二条 activate→settings→prompt 链 |
| 输入框“停止”按钮 | 中断当前 turn（`abort`），Worker 可继续存活并接受下一次发送 | 把中断输出等同于销毁会话 |
| 显式结束运行实例 | `stop` 回收对应 Worker、结束 epoch | 页面切换、订阅释放、组件销毁、浏览器断开触发 stop |
| 权限缺失、running 未知、能力不支持 | 历史/错误状态诚实呈现；不猜测可执行或不存在 | 空结果假成功、隐式扩根、降级到会自动启动的观察调用 |

初次选中一个已存在但 idle 的 Worker，**不自动观察**，保留源行为和现有 idle 测试；selected idle→busy 由 authoritative watch 触发观察。已取得的观察不会仅因 busy→idle 立即释放，以免错过终态。这里 busy 指 sessiond 的执行活动集合，包含 prompt、streaming、bash 和 compaction，不由组件各自猜测。Pix 现有可配置 idle 回收策略保持独立，本轮不把旧版 10 分钟或本机删除 timer 的改动带入。

### 4.1 服务端保证观察不激活

建议在 **Browser→Host 的 WS attach payload** 增加 `attachMode: "existing_only"`，并在 `protocol/src/features.ts` 定义握手 feature `runtime.observe-existing.v1`。这是拟定 wire 名称，尚未实现。该 feature **只属于 Browser–Host 握手**，不加入 `SESSIOND_BUILD_CAPABILITIES`、Runtime Core capability 或 Worker IPC vocabulary，因此这一观察扩展本身不改变共享 Worker/daemon fingerprint。Host 只有在自己的 existing-only handler 已接通、基础 sessiond attach seam 及当前 sessiond build 已确认兼容时才接受该 feature；未知/不兼容时不广告。

`RuntimeAttachParamsSchema` 位于 `protocol/src/handshake.ts` 且被 sessiond 复用；应在 `protocol/src/ws.ts` 区分浏览器扩展 payload，Host 显式去掉浏览器字段后调用原 RPC，不能把新字段直接传入 sessiond strict schema。

sessiond 的 `prepareAttach()` 已通过 `requireActive()` 核验 record，并在无 await 的边界建立订阅/捕获 snapshot。**优先复用这个已存在的原语，只增加必要的契约测试；没有证据时不重写它。** Host 对 `existing_only` 只调用一次 `client.attach`，绝不进入 `runtime.activate` fallback。Registry lease、journal 与 reducer 同样复用，不新增另一套 socket 或状态 owner。

- sessiond 在自己的 authority 边界核验已有 record 并建立订阅；running watch 只是触发观察的提示，不能作为“此刻一定仍有 Worker”的授权证明。
- watch 后 Worker 退出、被 stop 或 identity 改变：观察返回结构化不可用/epoch 变化；绝不通过 Host 的 `coldAttach` fallback 启动它。
- 自动观察仅在该语义已协商且端到端接通时使用。旧后端不支持时明确降级，不能换用可激活的旧 attach 来假装支持。
- 两个浏览器的观察相互独立；一个浏览器释放订阅不能结束另一个订阅或停止 Worker。
- 初始 snapshot 与其后的 replay/live events 必须共享明确边界；wrong ID、late generation、重复和乱序帧继续由现有匹配/共享 reducer 防护。

Client 的目标 API 明确区分 `observeExisting()` 和仅供显式执行意图使用的 `activateAndObserve()`；两者通过**同一个 Registry lease** 传递 intent，不产生第二个状态机。逐一迁移现有 `acquire()` 调用：AppShell 和已受理 submitTurn 后的观察使用前者；冷态 Compact 等明确执行操作及有限 v2 prompt shim 才能使用后者。**已有会话发送继续先走原子 submitTurn，不增加一条先 acquire 再 submit 的生产主路径。**

`activateAndObserve()` 的目标 wire 路径明确为：另一个可协商的 Browser WS `activate` 请求（拟定 feature `runtime.explicit-activate.v1`，同样只属 Browser–Host）→ Host 转发既有 `runtime.activate` RPC → 收到 exact session/epoch 结果 → `observeExisting`。它不是把 activating 行为藏回 attach；它只服务已列清单的显式冷态非 prompt 操作。当前 Browser 尚无 activate envelope，**LC-01 必须定义请求/响应/schema/feature/固定错误，LC-04 完成所有调用迁移后才能删除 activating attach**。该 envelope 复用 connection 的 bounded attempt/matcher，不引入新的执行 registry；它不自动发送 prompt，超时/断线不自动重试激活，结果待确认时先观察/查询既有 authority。观察失败不能二次启动 Worker；普通发送仍只用 submitTurn。

**Host 独立授权是两个新 WS 入口的必备前置，不依赖 Client 检查。** 每次 `activate` 和 `attach(existing_only)` 在调用任何 activation/attach RPC 之前，都必须通过既有 Host gate/Origin 规则、对应 feature 已协商、Host `agent` capability、**Host 对 exact session 重新计算的 `workspaceAccess=authorized`**。Host 的可信身份来源按操作明确分域：“只观察”通过有界、认证的 `runtime.listRunning` 要求 exact live sessionId/cwd/projectRoot/epoch，合法响应中缺少该 ID 就返回 `worker_unavailable`，不读 Catalog、不调用 attach；显式激活优先使用同一 live authority，仅在合法 running 响应确认没有该 ID 时读取可信 Catalog 的持久身份。运行态读取失败/超时/schema 错误不能被当作空集合，历史查询失败也不返回假成功。新会话已在 sessiond 存活但尚未落盘/进入索引时，可用这个 exact live authority 进行授权，不依赖 Client provisional header。两类路径均复用 `resources/workspace-access.ts` 的 `classifyWorkspaceAccess` 与 AllowedRoots 身份校验；不信任客户端/Adapter 提供的 access 标记或客户端 cwd/projectRoot，不维护 Host 生命周期缓存，也不新建第二套权限规则。

`history_only`、`unavailable`、unknown、缺失/过期 identity、授权撤回或授权查询失败均 fail closed：按既有 Protocol 固定错误码返回，零 `runtime.activate`、零 attach RPC、零 Worker 创建，不扩根、不落入 legacy fallback。既有正在执行的任务不因本浏览器授权失败被隐式 stop。握手只有在这条 Host 授权 seam 和 corresponding handler 都接通时才广告新 feature。Client 的下一段谓词是 UX 提前门控，不能替代这个服务端决策。

自动观察的准入谓词固定为：gate 已认证或明确不要求认证、Host `agent` capability、`runtime.observe-existing.v1` 已协商、当前 exact HTTP `workspaceAccess=authorized`、sessiond busy baseline 已知且该 session 在 busy 集合。权限或 feature 撤回使当前观察意图失效并取消/释放本浏览器订阅，保留可读历史和既有执行，不调用 stop。

实施中的读取状态澄清：HTTP metadata 正在有界获取且尚无结果，与完成后得到 unknown/拒绝/错误不同。前者始终不授予新的 live action/attach 权限，但不因它单独撤销此前已建立的合法观察；HTTP owner 仍只从可信 detail/list header 取得权限，不从 runtime/cwd 猜授权。完成后未知或拒绝/错误仍按 fail-closed 处理，全局 Gate/agent/feature 撤回不受 metadata pending 延迟。该区别必须由 hook/query 状态及真实 re-entry 用例证明，不通过预填测试权限掩盖。

AppShell/route 仍是 selection 真相源，只向既有 Registry 声明当前 presentation target；Registry 在 target 或准入权限改变时推进一个单调 `presentationRevision`（若现有 lease revision 的语义完全相同则复用）。target 使用现有 route/tab 派生 identity，draft/home 必须包含 cwd，不能把所有 null sessionId 当同一个意图；相同 key/权限的重复声明保持幂等。新 create 只在 captured draft revision 仍当前时才允许 promotion 与导航，晚到结果不能把用户从另一草稿/文件页拉回。发送/显式操作在起始时捕获 `{target, presentationRevision}`；迟到的 admission、activation 或 attach 结果要申请前台观察，必须仍匹配 Registry 的当前 target/revision。**不得把“回调晚调用 acquire”视为更新的用户选择。** 过期回调只取消其前台观察请求，不能撤销已经受理的后台 turn、清理其他会话 draft，或重放 prompt。

用户自动 busy 观察也带当前 revision；某次符合准入条件的 attach 已在途时，busy→idle 不使该请求自动失效，仍消费其合法 snapshot/末段/terminal。target 切换、授权撤回或 epoch/identity fence 失败才使它失效。busy 变化本身不重新 mint presentation revision。原子 submitTurn、独立 terminal 订阅、Registry single-flight/latest-intent、每个 attach attempt 的 generation 继续分别承担原职责。

新旧协议过渡仅桥接 Protocol v2 既有的显式 activating attach。旧后端无法证明 `existing_only` 时，不提供自动观察。既有 activating fallback 的明确删除版本是 **Protocol v3 首次成为最低支持版本、build fence 排除不支持原子 submitTurn 的 daemon/Worker，且所有显式 activating 调用已迁移到协商的 activate envelope/原子 submitTurn 并通过对应回归的发布**；到时 attach 固定为只观察并移除临时 mode。LC-04 必须记录调用清单、版本条件和对应测试，不能误称本轮已删除全部 v2 兼容。

### 4.2 发送与恢复的语义

`not_delivered`、`accepted`、`uncertain`、terminal error 不能只靠 `retryable` 猜测。

- activation/validation 在 prompt dispatch 前失败，authority 应给出可证明的未投递；保留草稿和 staged settings，去掉幽灵气泡。
- 同 epoch、同一 operation 的恢复重发只能走已有幂等协议；不得 mint 新 operation 伪装重试。观察重连本身不代表需要重发 prompt。
- 已受理后报错，显示本次 turn 的失败；admission ack 不等于模型完成。
- 回包丢失且无法证明未投递时，显示待确认，保留关联身份并按现有 resume/dedupe 收敛；不自动发送一个新操作。
- epoch 改变后，可能已投递的旧操作不得重放；迟到结果不能结算新 epoch 的 pending slot。
- 读取状态、工具、统计不能占据长 prompt 的控制通道；abort/stop 必须仍可到达。每个等待有预算，预算耗尽后恰一次结算并呈现原因。
- 页面从新建草稿提升为已创建会话时，只转移仍匹配的 provenance，不替换在途 TurnPending 对象；收到 accepted 后须结算原调用的 promise 和发送事务，不能仅在 terminal 时清空忙碌显示。
- admission 可晚于同 epoch 的 observation。其旧 revision/snapshot 只提供本次受理及乐观条目父节点信息，不覆盖已经推进的较新权威 cursor/投影；确认手续仍完整完成，跨 epoch 不比较大小。
- 流式文字按共享投影发布；模型暂停输出时也能看到已收到的最后一段，不能等待下一条事件来冲刷被额外缓存截留的 partial。

## 5. 长会话诊断与验收设计

先复现、定位，再决定长历史代码的改动。不能因为会话长，就直接提高 frame limit、启动超时、上下文上限，或重写分页/虚拟列表。

一次失败要取得贯穿各层的关联记录：

```text
用户发送动作
  → Client handler / submit frame
  → Host receive / sessiond request
  → sessiond locate / activate / Worker-ready
  → Adapter initialization trace / ready
  → Worker admission / SDK prompt dispatch
  → model request / first event
  → browser receive / reducer apply / render
  → terminal status / persisted commit
```

记录 `sessionId` 的可关联脱敏值、operation/envelope/generation/epoch/revision、阶段开始/结束、固定错误码、数据尺寸和耗时。每个进程使用自己的单调时钟测阶段耗时，跨进程用 identity 关联顺序，不直接相减不同进程时钟。不要记录 prompt、历史内容、密钥、Cookie、完整模型配置或原始错误堆栈中的敏感内容。

同时记录：JSONL bytes、entry/message count、selected branch 深度、compaction 情况、实际提交的上下文 token/模型限制、各层 frame bytes。先判断是 UI 没发、启动失败、admission 失败、模型拒绝、事件丢失还是渲染/历史合并失败，再把修复交给对应 owner。

### 5.1 三层测试各自证明什么

| 测试层 | 复用/新增范围 | 负责证明 |
|---|---|---|
| 确定性 owner/协议测试 | 复用 `runtime/testing/harness.ts`、sessiond/Worker fakes、shared contract suites | 竞态、身份、幂等、exactly-once settlement、stop 与 observer 隔离 |
| 真实 SDK + 可控 provider + 真实进程 | 隔离 agentDir/cwd，使用合成 JSONL，通过 Adapter 接入本地可控模型流；不替换 AgentRuntimeFactory | 长历史真实加载、settings/资源初始化、SDK prompt、tool/compaction 内容形态和协议映射 |
| 真实浏览器与候选产物 | root 测试工具管理浏览器，真实点击/键盘/路由/网络中断，记录 DOM 与 wire 的关联 | 用户能看到输入、当前流、错误和终态；页面操作确实走通完整链路 |

已有模拟 Runtime E2E 保留；带真实 JSONL、但 stub 掉 SDK prompt 的 hybrid Worker 只能作为分段诊断，不能替代第二层真实 SDK prompt 或最终发布验收。仓库当前没有 Playwright/Puppeteer/Cypress；第一道确定性回归复用 jsdom + Node WS，无需先引入框架。最终真实浏览器驱动仍必须进入 root 测试工具和明确脚本，不能把临时 `/tmp` CDP 脚本当发布门禁。工具选型在 LC-00 固定；如需新依赖，必须说明相对手写 CDP 驱动的维护收益，仅作为测试依赖，不进入产品 runtime。

### 5.2 最小发布矩阵

以下每一行都要覆盖正确状态和可观察失败。竞态用可控屏障/假时钟制造，不能只靠重复运行碰运气。

| 场景 | 验收证据 |
|---|---|
| inactive 历史从 URL/侧栏/Tab 打开 | 正确历史、零 Worker 创建、零 prompt |
| busy 会话从 URL/侧栏/Tab/前进后退打开 | 同一会话 snapshot + 后续流可见，零 activation |
| A→B→A 与快速 B→C | 当前流正确、无跨会话内容；晚到结果不能夺取观察 |
| B 发送在途→select C→B admission/activation 晚到 | B 可后台完成，C 的 presentation target/lease 不被夺走；不能仅按回调调用先后判断最新意图 |
| busy=false 先于在途 attach snapshot/terminal；terminal 恰逢 A/B lease transfer | 仍接收目标的合法末段和终态；不因全局 watch 更早到达而丢失结果 |
| watch busy 后 Worker 恰好退出 | 明确 unavailable，零新 Worker |
| idle→busy 与 busy→completed 边界 | 无需再次点击即可接流；末段和 terminal 不丢 |
| raw WS 绕过 UI 调用新 activate / existing-only attach | Host 独立核验 gate、feature、agent capability 和 exact workspace access；history_only/unavailable/unknown/授权查询失败或在转发前撤权均固定拒绝，零 activate/attach RPC、零新 Worker；伪造 access/cwd 不获授权 |
| 新 create 已返回 live identity、Catalog 可见性被屏障延迟 | 使用 exact sessiond live identity 并通过同一 Host roots classifier 后可观察；错误/缺失 ID、未授权 live root 仍零 attach/activate；释放 Catalog 不产生第二次观察 |
| 同一 session 两个浏览器 | 均可观察，一个断开/切走不影响另一个与执行 |
| 短历史、1k-message、工具输出密集、已压缩/未压缩长历史发送 | SDK 实际受理与执行，首个事件可见，terminal/持久化身份一致；再次发送成功 |
| 长历史先到/后到、冷/热缓存、迟到的另一分支历史 | 当前 UI 不串线，不重复/吞掉已提交用户消息；设置不被旧响应覆盖 |
| 请求送达但 admission ack 丢失 | 同一 operation 收敛，不重复执行；页面显示真实投递状态 |
| snapshot 边界、journal gap、epoch_changed | 合法 resume/rebase；旧 epoch 消息不重放 |
| 刷新、网络断开、Host 重启 | 已执行任务继续；恢复观察不新建 prompt |
| SDK/provider 错误、超过模型上下文、schema/frame 拒绝 | 原因类别可见、有界结算，无“没反应”或假成功 |
| abort / 明确 stop / 权限撤回 / controller dispose | 相应作用范围正确，pending 恰一次结算，其他会话不受影响 |

性能结果单独记录环境、输入规模和阶段 p50/p95；确定性生命周期正确性不能由 wall-clock 阈值替代。支持范围以内必须完成完整发送与恢复，超出明确资源上限时必须诚实拒绝，不能把静默失败列为通过。

## 6. 分阶段实施与暂停条件

下列为已授权的实施任务；当前执行状态只在根执行计划的任务板维护。

| 任务 | Owner / 范围 | 交付物与完成条件 |
|---|---|---|
| LC-00 行为基线和失败证据 | Client 测试、root 测试工具、各层既有诊断 seam | 固定旧/新 commit 与候选 source/dist/进程版本；当前 busy 切换场景先失败；长会话失败有关联时间线；明确测试替换映射 |
| LC-01 服务端只观察契约 | Protocol、Host、sessiond；按需 cross-package contract tests | Browser-only observe/explicit-activate 契约与冷态调用清单固定；两个新入口均有 Host exact workspace 独立授权及 raw-WS 绕过 UI 的零 RPC/零 Worker 拒绝测试；existing-only 复用既有 authority |
| LC-02 选择与观察收敛 | Client Registry/Controller/RuntimeConnection 边界、AppShell/相关测试 | 所有入口统一选择意图；Registry presentation revision 阻止迟到 admission 抢回前台；消除 initial-URL 特例，busy A→B→A、terminal 竞态与多浏览器通过 |
| LC-03 长会话发送与恢复 | 仅证据指向的 owner 包 | 先写实际失败回归，再修 dispatch/admission/SDK/merge/render 中被证明的缺陷；长会话完整流、终态及再次发送通过 |
| LC-04 收口与错误诚实性 | 本轮触及的 Client/Host/Protocol、CLI、文档/架构门禁 | 所有 activating 调用有目标 wire 与测试，删除重复观察决策；兼容有明确版本移除条件；CLI 版本失配不自动 shutdown，产品错误集中 i18n |
| LC-05 独立产品验收与候选发布 | root 工具、CLI/发布流程、独立 verifier | 三层测试和矩阵通过、混合版本降级可验证、候选演练无隐式 activation/重复 prompt/丢流；再进入明确的发布步骤 |

LC-00 是前置。LC-01→LC-02 建立观察链；LC-03 的实现必须等待长会话证据，诊断可与前两项并行，但重叠文件的实现串行。LC-04 在新路径获得覆盖后才删除旧路径；LC-05 不接受“只验证了这一小块”。

暂停条件：未能复现长会话失败时，不启动猜测性长历史改造；发现新方案需要第二个运行时 owner、绕过权限、模糊发送身份或对旧 epoch 自动重放时，回到契约评估；不得扩大为全仓改名/文件拆分/新 Adapter 项目。

## 7. 发布、回退与证据要求

- 实施使用独立 checkout、agentDir/sessiondDir/Host state 和端口，不构建覆盖生产目录、不重启生产进程，禁止以用户正在写入的 JSONL 作为测试存储。
- 记录候选 source commit、各包 dist manifest/hash、**实际 HTTP 返回的 Client JS hash**、认证 `system.hello`/instanceId、Worker-ready build 和配置来源。SDK/Worker 首次加载的 adapter 实现身份也要记录；源码、磁盘 dist、现有进程三者分别列出。构建成功不等于现有进程已加载该实现。
- observation 新语义必须经过 feature/版本协商。旧后端不支持时自动观察不可用，不走 activating fallback；已有其他有限兼容路径按各自记录管理，不顺手扩大本轮删除范围。
- 本轮的 v2 observation 过渡按 §4.1 的 Protocol v3 最低版本发布条件移除；LC-04 删除当前客户端中被替代的含糊调用，并核对所有剩余桥接的版本/feature、删除条件和测试。不得另加没有移除条件的旁路。
- **Browser-only feature 不进入共享 fingerprint**，LC-01 用 contract test 固定这一点。若后来确实修改 sessiond/Worker/Adapter 的互操作语义，再更新其对应 contract/fingerprint，并按需要维护窗口的版本发布；不能为前端新增观察语义无端使活动 Worker 失配。
- **维护约束已实现**：普通 `cli/src/supervise.ts` start/ensure 遇到不兼容的存活 daemon 返回维护升级错误并保留实例，不因 staleBuild/knownLegacy 自动 shutdown。即使它看似空闲也不根据客户端快照猜测可替换；对 unverifiable、malformed、超时同样保留 authority。明确的维护操作仍走认证 RPC，与普通启动分开。
- Client/Host 升级与回退只允许在与现存 daemon/Worker 兼容时进行；必须核对实际 served Client hash 和 feature 协商。需要替换 daemon 的版本不进入自动滚动流程。只有显式维护升级才可替换：停止新受理，证明全部 runtime records（含 idle）、启动/创建/受理在途槽均为空，并确认目标 instance/build 仍相同，然后经认证 RPC shutdown。这个零运行状态必须由 authority 原子围栏保证，**先 listRunning 再关进程的两次客户端调用不构成证明**；旧 daemon 缺少这种维护能力时，自动升级/回退被阻止，保留运行实例，另行执行明确授权的停机迁移。禁止 PID/SIGTERM 旁路。
- 出现隐式启动、重复 prompt、错会话内容、丢失当前流、无限等待或错误假成功，立即停止扩大候选范围。不能热替换活动 Worker，不能回退或覆盖用户 JSONL。旧进程继续使用其兼容产物直到维护条件满足，不把 `pix down --all` 当作失败用例后的自动清理。

| 版本组合/操作 | 必须验证的行为 |
|---|---|
| 新 Client + 旧 Host | 缺 observe feature 时零自动 activating fallback，显示观察能力不可用；既有支持操作按原能力运行 |
| 旧 Client + 新 Host | Browser payload 不被新增字段破坏；显式 v2 activating 路径保持单独有限覆盖，不冒充 existing-only |
| 新 Client/Host + 当前兼容 daemon/Worker | 新 Browser features 不改变共享 fingerprint；existing-only 为零 activation |
| source 与 dist/served Client hash 不符 | 候选验收失败，不以源码测试报告替代部署证据 |
| 需要新 backend contract，当前有 busy/idle/starting runtime | `start/ensure` 拒绝替换并保留实例；不丢任务 |
| 活动 daemon 无原子维护/空运行证明能力 | 不自动升级或自动回退 daemon；保留进程并报告维护需求 |
| 空运行维护期间恰有新 create/submit 抵达 | authority admission fence 拒绝新受理或拒绝升级，不出现检查后新任务被关掉 |
| Host/Client 回退到不支持现存契约的产物 | 拒绝回退，现存 Worker/JSONL 保持，不自动 shutdown |

- 最终独立验收按矩阵执行用户动作，附 wire/DOM/authority 对账。每个核心矩阵至少两次独立干净启动，另做一次强制重连；候选至少完成 20 次发送（含 5 次长历史恢复发送）及 5 次 busy 会话切换续流。这是拟定最低覆盖量，不能代替确定性竞态测试。
- 实现阶段保留根 architecture/typecheck/test/build/diff 检查、受影响 package gates、共享 Adapter/cross-package suites，以及 Startup/Runtime/Sessions E2E。方案文档阶段只做文档一致性、路径/链接、diff 与独立方案审查，不宣称重新通过运行时测试。

## 8. 需要替换、保留和另列的内容

| 内容 | 处理 |
|---|---|
| sessiond、每会话 Worker、SDK Adapter、Protocol shared reducer | 保留所有权边界，不因这次症状改进程模型 |
| Registry / exact Controllers / 单浏览器 observation lease | 保留；在已有 owner 内统一观察决策，禁止第二份缓存/生命周期 |
| `initialSessionIdRef` 限定的自动续流 | 在只观察契约和回归建立后替换 |
| busy 选择一律零 attach 的断言 | 按零 activation/stop、正确订阅、迟到隔离替换；保留甚至强化原身份安全覆盖 |
| Host attach 隐式 activation | 从自动观察路径消除；显式 legacy 调用先列清单再迁移，不能无测试整段删除 |
| `5002eec` 索引优化与回归 | 保留；仅作为定位/初始化的局部证据，不再代表长发送问题关闭 |
| `/Users/proxy` Project 可见性 | 独立目录任务，包含持久索引分类失效/重建验收 |
| 外部旧 Web/CLI 运行中的接管 | 单独范围与能力决策；共享历史不被描述成共享实时进程 |
| 旧文档 Phase DONE/PASS、v1 示例、旧 SessionStore/分页/optimistic 术语 | 保留出处与历史证据；当前执行与目标契约明确更新，不能混为现状 |

## 9. 实施入口与源行为对照

### 9.1 关键文件与职责

| 文件/入口 | 本轮需要检查或修改的责任 |
|---|---|
| `packages/client/src/routes/router.tsx`、`components/shell/AppShell.tsx` | 路由提供 selection，所有入口同语义；替换初始 ID 特例 |
| `packages/client/src/runtime/{runtime-connection,session-controller-registry,session-controller,exact-runtime,runtime-provider}.ts*` | 复用唯一连接/lease/exact controller；传递 observation intent，维持相关命令的独立结算 |
| `packages/protocol/src/{handshake,ws,features,build}.ts` | Browser observe/explicit-activate schema 与 feature；Browser-only feature 不进入共享 fingerprint，必要 backend 变化才改 contract |
| `packages/cli/src/supervise.ts`、sessiond 维护/关闭 authority | 移除普通 start/ensure 的自动 stale shutdown；不兼容活动实例保留，维护替换需 authority 原子准入围栏与空运行证明 |
| `packages/host/src/composition/runtime-gateway.ts`、`resources/workspace-access.ts` 与 Host composition | 新入口转发前独立获取 exact session 并复用 classifier/AllowedRoots 授权；existing-only 禁止激活，浏览器字段不泄入 strict RPC；旧 explicit 路径单独覆盖 |
| `packages/sessiond/src/service.ts` 的 `prepareAttach` / `submitTurn` | 复用已有原子订阅边界和发送 authority；只修改证据要求的缺陷 |
| `packages/agent-worker/src/controller/worker-controller.ts`、`pi-sdk-adapter/src/internal/{sdk-runtime,adapter}.ts` | 长历史初始化→admission→prompt→terminal 的诊断与实际根因修复，不复制 locator |
| `packages/client/src/features/session-history/use-session-transcript.ts`、`components/shell/Composer.tsx` | HTTP history 与 live/optimistic 合并、草稿/错误反馈；不发明另一条执行链 |
| `packages/client/src/components/shell/AppShell.test.tsx`、`boundaries.test.ts` | 替换错误零 attach 断言，保留 idle、不启动 Worker、迟到身份隔离覆盖；静态门禁检查责任而非仅换方法名 |
| `tests/e2e/{runtime,sessions-history,startup}.mjs`、root `scripts/*`、Adapter testing/contract suites | 保留既有 fakes 与真实进程用例，补实际 SDK prompt/浏览器矩阵与 source/dist/运行版本记录 |

### 9.2 源项目的可观察行为与限制

旧仓库 HEAD 为 `73ca7c0aae22d404e9ccc50cb304a98635935f1a`（2026-08-11）。本轮检查的 lifecycle 文件中，`lib/rpc-manager.ts` 存在未提交的 idle timer 删除，不能把工作区与 HEAD 混称同一已发布版本。旧运行服务实际加载的代码仍需 LC-00 单独记录。

- `components/AppShell.tsx:588` / `ChatWindow key`：选择会话重建页面局部状态，不 shutdown SDK 会话。
- `hooks/useAgentSession.ts:1799`：mount 读历史/状态，发现 streaming/prompt running 后连事件；cleanup 只关闭订阅。侧栏点入与初始恢复都会经过该逻辑。
- `lib/rpc-manager.ts:1445`：服务端进程内 Map 复用活 wrapper，同 session 的启动合并。Pix 保留“复用已有执行、不重复启动”的效果，通过 sessiond authority 实现。
- `app/api/sessions/[id]/state/route.ts`：状态读取不启动 wrapper；`app/api/agent/[id]/events/route.ts` 则可隐式启动。前者的只读性质保留，后者的隐式启动不能成为新观察契约。
- `hooks/useAgentSession.ts:1363`：Stop/Esc 是 abort，连接断开不等于结束 runtime。
- 原 SSE 没有完整 journal replay，侧栏/结束判断存在轮询；旧 URL 主要使用 replace，不能据此声称前进后退已完整支持。Pix 的 snapshot/resume 和浏览器导航验收属于明确增强，不能从旧行为直接继承 PASS。
- HEAD 有 10 分钟 idle 回收，当前旧工作区删除了 timer；本轮不据此修改 Pix 的 idle 策略。

本机审查文件 SHA-256（仅用于源比对，不代表正在运行的服务身份）：

```text
components/AppShell.tsx  13b9330af7e65825323fec8553ae12932c44839d335c716f968934c2ec6378b2
hooks/useAgentSession.ts 6a1feff93a1f6ceedd36a32dcc723b1d4e098346fb2dd9336bc4bd0d561ec89c
lib/rpc-manager.ts       1e40ce9f621054cc2632b2aee83ae98c1a8a2ab4844497aab66a7efa98624098
```

### 9.3 本轮审查与交付记录

已完成三个独立只读角度的研究：运行时所有权与方案取舍、测试/观测/发布缺口、源项目行为。父审查明确不采用“hybrid stub prompt 足以证明真实 SDK 长发送”或“已有会话先 acquire 再 submitTurn”的建议；它们会缩小所需验收范围或重建重复激活链。

最终独立方案审查 **PASS**：显式激活 wire 与兼容移除条件、presentation revision 防迟到抢占、fingerprint/维护升级边界，以及 Host 对新 WS 入口的独立授权四项方案阻塞均已关闭。文档本地链接和 `git diff --check` 通过；RA-PLAN 交付时，根任务板将方案标为完成，实施任务尚未开始，且没有运行代码修改、依赖变更、构建、运行时测试或部署。用户后续的“开始实施”授权已记入当前任务板；方案 PASS 本身不代表长会话发送或续流故障已修复。
