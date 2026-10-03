# Pix 生命周期修复计划

> 状态：`REOPENED / 历史实施记录`
> 2026-09-09：用户要求停止零散修补并重新评估。当前方案见 [lifecycle-reassessment.md](./lifecycle-reassessment.md)，执行状态仍由 [refactor-execution-plan.md](./refactor-execution-plan.md) 管理。下文 Phase 的 DONE/PASS 仅表示当时实现与验证范围；“busy A→B→A 零 attach”不再是当前目标验收，“生命周期主线已关闭”的产品结论已撤回。不得从历史记录推导本轮实现或部署授权。
> 范围：迁移后页面/会话生命周期、读取模型、运行时命令域、版本生命周期。
> 目标：恢复旧 Next 单体的可观察语义，同时保留 pix 的 0 Worker 历史浏览、sessiond 持久权威、WS resume 和安全边界。

## 1. 目标与非目标

### 1.1 目标

1. 页面选择、历史读取、运行时附着、prompt 发送和重连都有唯一的身份与状态机。
2. 只读历史在 0 Worker 下仍能显示 JSONL 中真实的 model/thinking/workspace 状态，不使用默认值或消息猜测。
3. 普通读取不会消耗有副作用命令的 at-most-once 容量；长期会话不会因读取累计而永久进入 `command id capacity reached`。
4. prompt 的受理、执行、完成和不确定投递在协议中可区分，不由一个长时间 Promise 占据所有控制面。
5. 选中的历史会话如果没有当前 Host 授权，明确显示为 history-only，而不是显示为可完整操作的项目。
6. Host/sessiond/Worker/Adapter 的版本和协议兼容性可验证，禁止静默复用不兼容的旧 daemon/Worker。
7. 页面 reload、路由切换、WS 重连、sessiond 重启和 Worker 停止的影响范围明确且有确定性测试。

### 1.2 非目标

- 不恢复 Next.js 产品路径。
- 不用 SQLite 替换 JSONL 真相源。
- 不通过删除旧 command id、提高容量或周期性重启掩盖 at-most-once 设计问题。
- 不让 Client 直接访问 Worker、Pi SDK、sessiond IPC 或 raw Pi RPC。
- 不为了修复 UI 增加 polling 作为实时通道。

## 2. 当前事实基线

| 事实 | 代码证据 | 影响 |
|---|---|---|
| 旧版按 ChatWindow/sessionKey 重建页面状态 | 旧 Next 单体 `components/AppShell.tsx`、`ChatWindow key` | 会话切换天然清理页面局部状态 |
| 旧版 read path 已返回 branch 的 model/thinking | 旧 Next 单体 `lib/session-reader.ts` | detached 页面不需要猜当前模型 |
| pix 页面使用跨路由长期存在的单个 SessionStore | `packages/client/src/runtime/runtime-provider.tsx`、`session-store.ts` | selected/attached/intended/pending 等身份被拆开维护 |
| pix 选择历史默认不启动 Worker，发送才 transition/attach | `packages/client/src/components/shell/AppShell.tsx`、`Composer.tsx`、`session-store.ts` | 发送从一次 prompt 变成 activation→settings→prompt 事务 |
| pix 的 `SessionContext` 没有 model/thinking | `packages/runtime-core/src/session.ts`、`packages/protocol/src/domain.ts` | detached UI 只能从 assistant/default/`auto` 推断 |
| sessiond 用 `acceptedCommands` 记录整个 epoch 的所有 runtime command | `packages/sessiond/src/service.ts:169,865-890` | 读取和 mutation 共用一个永久增长的容量域 |
| result cache 有界，但 accepted id 账本不驱逐 | `packages/sessiond/src/service.ts:1676-1686` | 长会话达到 10,000 后 epoch 永久拒绝新 command |
| Host gateway 的普通 serial lane 等待完整 Worker command | `packages/host/src/composition/runtime-gateway.ts` | 长 prompt 与普通读取/生命周期操作发生 HOL 阻塞 |
| session list 可见性与资源授权没有同一 read model | `packages/host/src/routes/sessions.ts`、`catalogs.ts`、`resources/allowed-roots.ts` | 历史会话可见但 models/files/skills 403 |
| CLI 复用通过协议探针的旧 sessiond | `packages/cli/src/probe.ts`、`start.ts`、`sessiond-lifecycle.ts` | dist/daemon/Worker 可能版本撕裂 |

## 3. 不可变生命周期不变量

### I1：身份三元组

任何 runtime 操作都必须绑定：

```text
(sessionId, epoch, operationId/commandId)
```

- sessionId 不得由 URL、cwd 或 SDK permissive helper 推断替换。
- epoch 变化后，未明确证明同 epoch 的操作不得重放。
- late frame 只能结算创建它的 generation/identity。

### I2：读写分域

- JSONL history/read model：0 Worker、可在 detached 状态读取。
- runtime snapshot/event：仅 Worker live 时产生，由 sessiond 投影。
- mutation command：才进入 at-most-once 受理域。
- read RPC 不得因 UI 刷新消耗 mutation command quota。

### I3：一个页面意图只能有一个 owner

- URL/selected session：AppShell/route owner。
- 每 session 的 attach/cursor/prompt transaction：SessionController owner。
- React 组件只能消费 controller/read query，不能自己启动第二套生命周期。
- staged settings 必须是明确的用户意图，不得冒充 persisted/runtime state。

### I4：权威值不可猜测

model、thinking、leaf、cwd、projectRoot、context usage 均必须来自对应 owner：

- detached：JSONL read projection；
- attached：runtime snapshot；
- unknown：显示 unknown/不可用，不用 default、第一项或 `auto` 冒充真实值。

### I5：生命周期动词语义固定

```text
select   = 只改变页面选择，不启动 Worker
attach   = 建立 WS journal subscription，不改变 session 身份
activate = sessiond 确认/启动该 session 的 Worker
 detach  = 取消页面订阅，保留 Worker（若仍满足保活条件）
 stop    = sessiond 结束 Worker 并关闭 epoch
 reload  = 页面/Host 重建连接，不等于 stop
```

## 4. 实施阶段

### Phase 0：基线、观测与保护（先行）

**目的：** 防止在 dirty worktree 和混合 dist 环境中误判。

1. 保留现有 Client selector/context-usage 改动，不做无关格式化。
2. 建立 `lifecycle-repair-plan.md`（本文件）与 migration ledger 条目。
3. 在 sessiond/Host/Worker 启动日志中只记录 sanitized：product version、protocol version、adapter contract、epoch、sessionId hash；不记录 secret/path/raw prompt。
4. 为 page action 建立 deterministic trace 字段：`pageGeneration`、`sessionId`、`epoch`、`attachGeneration`、`operationId`。
5. 现场验证必须分别记录源码、dist mtime、进程启动时间，禁止把“重建某个包”当作全链路升级。

**验收：** reload、WS reconnect、session switch 的日志能证明每个 late response 被哪个 generation 丢弃；不改变用户可见行为。

### Phase 1：恢复完整 0 Worker read model（当前首先实现）

**Owner：** runtime-core → protocol → pi-sdk-adapter → Host sessions route → Client history hook/Composer。

1. 在 `runtime-core SessionContext` 增加 branch-resolved 的 `model` 与 `thinkingLevel`，允许 `model: null` 表示已知没有 persisted model；不得用 catalog default 填充。
2. `pi-sdk-adapter` 使用 Pi `SessionManager.buildSessionContext()` 对 selected leaf 读取真实设置；显式验证 leaf membership 后再调用 SDK helper。
3. Host `/v1/sessions/:id/context` 保留并投影这两个字段；不在 Host 重算。
4. `useSessionTranscript` 暴露 persisted metadata；Composer detached 状态只使用 `staged → persisted`，删除 assistant/default/first-model fallback。
5. metadata 与 context 使用同一个 selected leaf/page key；翻页不能把 A/B 或不同 branch 的设置混合。
6. 新增空 session、model change、thinking change、branch leaf、未知/不存在 catalog model、reload 后 detached 的契约测试。

**验收：** 0 Worker 选择历史会话时，发送前后 model/thinking 不发生“猜测值→真实值”跳变；空 session 明确显示 unknown/无 model，而非 catalog 第一项。

### Phase 2：拆分 read RPC 与 mutation command 域

**Owner：** protocol/sessiond/Host gateway/Client SessionStore。

1. 将 `get_session_stats`、`get_tools`、`get_commands`、可由 snapshot 满足的 `get_state` 从 runtime mutation command quota 中移出，设计独立、有限、可取消的 read lane。
2. read lane 仍携带 `(sessionId, epoch, requestId)`，但不写入 mutation at-most-once ledger；late read response 只能按 request generation 丢弃。
3. prompt、set_model、set_thinking、compact、bash、fork/navigate 等 mutation 保留 at-most-once。
4. 为 mutation ledger 选择不会破坏 replay safety 的有界方案：优先使用 authority-issued epoch/sequence fence 或 epoch rotation；禁止简单 FIFO 删除旧 commandId。
5. 证明相同 commandId 的同 epoch retry 不重复 Worker 调用；不同 epoch 是否可重用必须在协议中明确，并补旧 epoch frame/command replay 测试。
6. Composer 不再用 `get_session_stats` 作为页面 mount 的常规刷新；优先使用 snapshot + read-side stats，只有 capability 需要时才读。
7. Worker 层用 deterministic deferred harness 证明长 prompt 未完成时 read 可先完成，且 wire id/commandId/type correlation 不串线、结果恰一次、无 fatal/exit 泄漏。

**验收：** 模拟超过 command limit 的长 session：大量 mount/read/reconnect 后仍能发送；恶意重复/跨类型 commandId 仍 fail closed；读取不会阻塞 prompt。

### Phase 3：把 activation + settings + prompt 收敛为 sessiond 意图

**Owner：** protocol/sessiond/Worker adapter；Client 只保留一个 submitTurn API。

目标请求形状：

```ts
submitTurn({
  sessionId,
  expectedEpoch?,
  expectedRevision?,
  prompt,
  images?,
  activationOverrides?: { model?, thinkingLevel? },
  operationId,
})
```

1. sessiond 负责 identity validation、activate/open、settings 应用、prompt admission 的顺序。
2. settings 与 prompt 要么形成同一个明确的 authority transaction，要么返回明确的 `activation_failed`；不能由 Client 顺序拼接多个普通 command。
3. prompt admission 必须快速返回 accepted/duplicate/rejected；完整执行通过 event/snapshot 表达。
4. Worker prompt execution 的长 Promise 不得占据 Host 所有 serial lane。
5. 旧的 `transitionTo → applyStagedActivationSettings → fetchSnapshot → dispatchPrompt` 逐步删除，保留 operationId/generation 保护。

**验收：** 首次发送、 detached→live、A→B 切换、settings 失败、prompt timeout、reload 期间发送均可确定区分“未投递/已受理/不确定”。

### Phase 4：按 sessionId 建立 Client Controller registry

**Owner：** Client runtime。

1. 将当前单个可变 `SessionStore.sessionId` 拆成稳定的 `RuntimeConnection` + `SessionControllerRegistry`。
2. 每个 controller 独立持有 attach cursor、epoch、snapshot、pending operations、optimistic transaction。
3. 页面选择只切换 selected controller；不能用 B 的 attach 覆盖 A 的 transaction。
4. 仍限制每个 WS/浏览器的实际 attach 数量时，限制必须显式进入 capability/UX；后台 Worker 的 liveness watch 不得被误当成 attached。
5. AppShell 只负责 selected URL/navigation；Composer 只调用当前 controller；SessionStore 不再同时成为全局运行态与所有会话的事务 owner。
6. 对快速 A→B→A、旧 attach response、旧 prompt response、reload/reconnect、页面卸载补 deterministic tests。

**验收：** 任一 session 的 late frame 不会改变当前选中 session；A 的发送不会清理 B 的 optimistic/UI state；所有 pending slot 恰一次 settle。

### Phase 4A.0：Client create 基线修正 + Host turn 订阅键硬化（前置小切片）

**Owner：** Client SessionStore + Host runtime-gateway。

**精确语义（纠正 Phase 3/4 的零 Worker 过度声称）**：Client `create` 是 **浏览器身份分配**——解析后立即返回 session identity，**不发送任何 attach frame**，不修改 model/thinking/name，也不 detach/替换当前已附着会话。但 **`runtime.create` 仍然是 sessiond 生命周期权威**：它启动该 session 的 Worker 并返回权威 `{sessionId, epoch, snapshot,...}`。**本切片不引入真正的零 Worker create**——那是 Phase 4 controller 提取后的独立事项，不得把 Phase 4A.0 描述成零 Worker。

1. `createSession` 公开参数仅 `{cwd, projectRoot}`；create 响应立即以 session identity 解析，零 attach。
2. 创建结果权威通过**有界 exact-session seed facade**（`createdSessionSeeds`，bound 32，按 sessionId 精确键控）保留 epoch + sessiond 返回的精确 `lastEventId` + 权威 snapshot；该 cursor **只在 create 完成时精确，不是 journal reservation**，后续全局 `running_sessions_changed` 兼容事件仍可推进未附着目标的 journal。首个协商 `submitTurn` 使用 authority-issued fence，不得猜 cursor 为 0；若 create 后 fence 已被同 epoch 全局事件推进，则由 Phase 4A.0.1 的有界 same-operation repair 收敛。旧 Protocol-v2 daemon 缺失 additive `lastEventId` 时，Client 明确先 attach 取得 cursor，再 submit；该 **old-daemon omission/mixed-build shim** 由 Phase 7 build fence 删除。temporary seed facade 本身则在 registry 拥有 create authority 时删除。seed 按 createRequest/envelope/generation 关联，晚到 create 结果不得 seed 一个重建的 controller/其他 session；只驱逐无 pending turn/attach 的安全 unused seed（确定性 oldest）；优先在 accepted submit / stop / dispose 时删除。
3. `submitTurn` 的 fence 优先级修正为：显式 caller fence → 当前 attached target → 精确 created seed；revision-without-epoch 在任何投机状态前拒绝；seed 绝不用于其他 session。
4. 功能关闭的 legacy 路径保持显式：create 零 attach 解析；`sendPromptToSession` 经 `legacySubmitTurnV2()` 获取唯一附着再做 staged settings→prompt。删除条件同 Phase 3（Protocol v3 最低 + Phase 7 build contract）。
5. Host `activeTurns` 从仅按 `operationId` 改为精确复合键 `(sessionId, operationId)`（碰撞安全 length-prefix 编码）；`ActiveTurnSubmission` 存 sessionId + operationId/key；关闭/移除只用精确 owner。

**临时 seed facade 的移除条件**：当 Phase 4 SessionControllerRegistry 拥有 create 注册后，新创建 session 的权威 epoch/cursor 必须从目标 controller 读取，届时删除 `createdSessionSeeds` 与本切片记录的兼容测试；在此之前不得把它当作永久架构。

**验收：** create 在 A 附着时零 detach/零 attach/不改动 A；create 解析的 snapshot 只进 seed 不作为 selected；协商新会话首个 send 携带 create 结果 epoch/revision + activationOverrides，admission 后才附着；legacy 新会话 send 在 settings/prompt 前附着精确新会话；Host 同 operationId 跨 A/B 共存、A 关闭不关 B、browser close 全关、wrong-session status 不跨路由。

### Phase 4A.0.1：created-seed 同 operation revision repair（前置硬化）

**Owner：** Client SessionStore；sessiond/Protocol 仅补确定性契约覆盖，无生产语义或 wire capability 变化。

1. `TurnPending` 记录 fence source（`explicit | attached | created_seed | none`）、当前提交的 epoch/revision identity 与最多一次 repair count。
2. 仅当精确关联的 rejected admission 同时满足 `delivery:not_delivered`、`error.code:conflict`、原 fence 来自 exact created seed、authority 携带同 epoch 且严格更新 revision 时，单调推进该 exact seed；第一次冲突用 fresh Browser envelope/current generation 自动重发**同一 logical operation**，只替换 `expectedRevision`，不 mint operationId、不 attach/detach、不复制 optimistic transaction。
3. repair 上限为一次。第二次同类更新冲突仍推进 exact seed 到最新 revision，但不再重发，按普通 definite non-delivery 清 bubble/恢复 draft；之后手动提交使用最新 seed 并 mint 新 operationId。
4. missing/wrong epoch、missing/equal/older revision、explicit/attached/none source、non-conflict、uncertain delivery 均不得自动重试或更新 seed；判断只用结构字段，不读 free-text message。
5. `advanceCreatedSessionSeed(sessionId, expectedEpoch, authorityRevision)` 只允许 exact session/epoch + monotonic revision，保留 bound/order/snapshot/安全驱逐语义。

**Phase 4A.1 relocation 与最终删除分离：** Phase 4A.1 **允许且预期**把 connection-global identity-only create、temporary seed storage 与 monotonic `advanceCreatedSessionSeed` helper 移入单一 `RuntimeConnection` owner；`SessionStore`/后续 per-session controller 继续拥有 logical `PendingTurn`、fence source、repair count 与是否重发的决定。跨 seam 必须保持 exact session/epoch、单调更新、fresh envelope、same operation、一次上限与 optimistic/promise 语义，不能因移动就把 repair 当成永久架构或提前删除。

**最终删除条件：** registry 拥有 create registration，并由目标 controller authority 直接提供 epoch/cursor 后，删除 temporary seed facade/monotonic helper 及其 compatibility repair。Phase 7 只负责删除旧 daemon 缺失 `lastEventId` 的 omission/mixed-build attach shim；它不是 seed facade 删除的前置条件。不得把本修复扩成 Phase 5 revision redesign。

**验收：** create A rev1 → B 的 global running change 推进 A → A stale submit 返回 authority rev2、零 Worker dispatch → Client 同 operation/payload 仅一次 rev2 resend → accepted 且 Worker submit 恰一次；连续两次 newer conflict 总帧数仍为 2，seed 留在最新 revision，手动 retry 使用新 operationId。若当前 attached A、pending turn 目标为 B，则显式 fresh `openSession(B)` 只切换观察 attach、不得按 A→B 表象清理 B 的 turn；fresh `openSession(C)` 才按 pending owner B≠target C 恰一次 definite settle B。若 B frame 可能已投递后 transport loss、`intendedSession` 仍为 A，则 reconnect `resumeAttach(A)` 不得在 snapshot 前 definite settle B；A snapshot 落地后由 `resyncAfterAttach` 按 lane mismatch 收敛为 `epoch_changed`/uncertain，绝不在 A 上 resend B，并保留 B optimistic bubble。

### Phase 4A.1：单一 RuntimeConnection ownership extraction（DONE，Fresh independent verifier final PASS）

**Owner：** Client runtime；无 Protocol/Host/sessiond/Worker/Adapter 生产改动。

1. `RuntimeConnection` 是唯一生产 `RuntimeSocketHandler`、唯一生产 `RuntimeSocket` 构造/owner；连接 view 只暴露 transport state/generation/host/features/error/fatal/global running，绝不声称 attached/attaching。
2. connection 拥有 handshake/feature/readiness、running watch + legacy list arbitration、identity-only create/reconnect same createRequestId、bounded exact seed（32）/pin-aware eviction/monotonic advance/consume，以及默认 256 的 non-evicting outbound-attempt registry。
3. 所有 correlated frame 先由 registry 按 envelope + socket generation + binding token + permitted discriminant + strict identity/result matcher 路由；错误 envelope/generation/type/session/commandId/result type 不消费合法 attempt。transport loss 删除旧 generation attempts：one-shot/read 恰一次 reject，logical retry object 留在 controller 并在 exact resync 后 fresh attempt 重注册。
4. `SessionStore` 只保留单 controller/facade：exact attach/epoch/cursor/snapshot/reducer/history、logical commands/reads/interrupts/turn resend decision、optimistic/staged state，以及 Phase 4A.0.1 `PendingTurn` repair 决策；public React `RuntimeApi` 不变。connection 只允许一个 binding；第二次 bind 立即抛错，unbind token 使旧 callback/send inert。
5. legacy `running_sessions_changed` 必须先由 controller cursor/reducer 接受，再通知 connection；watch mode忽略 state payload 但 cursor继续推进，legacy mode才更新 global running。
6. Phase 4A.0.1 语义原样保留：exact completion cursor、same-operation 一次 repair、第二 conflict 无第三帧、uncertain 不 retry、old attempt inert、send throw 后 seed保留、same-generation exact attach 保留 pending、fresh/resume A/B/C 分类不变。old-daemon missing `lastEventId` attach-first shim 仍等 Phase 7 删除。

**验收：** 新 connection direct tests 覆盖 single binding/stale token、attempt bound/pre-send reject/no overwrite、严格 adversarial matcher、duplicate inert/send throw、disconnect one-shot vs logical retry、watch reconnect revision、identity-only create/reconnect/seeds；现有 rapid attach/late snapshot/extension FIFO/turn 27 tests、Provider one connection + stable methods 全绿。Phase 4A.1 不创建 registry/多 controller/multi-attach；下一阶段才是 Phase 4A.2 mechanical extraction。

### Phase 4A.2：exact-session SessionController mechanical extraction（DONE；Fresh independent verifier final PASS）

**Owner：** Client runtime；无 React API、AppShell/Composer、Protocol/Host/sessiond/Worker/Adapter 生产语义变化。

1. 新 `SessionController` 以 constructor-fixed readonly `sessionId` 拥有 exact-session projection/cursor/history、attach state、commands/reads/interrupt/extension FIFO、atomic turn/optimism/staged overrides、stop/reconnect/reconciliation与 terminal listeners；snapshot/event/result identity mismatch fail closed，controller-local dispose never stop/never close shared connection。
2. `SessionStore` 缩为 one-public-store compatibility coordinator：保留 connection/global create/running delegation、既有 RuntimeApi/RuntimeView、one Browser attach、destructive switch、global single-flight；仅暂存 attached、attach-intent 与至多一个 cross-session atomic target，不是 registry/LRU/max32。
3. `RuntimeConnection` 建立 exact multi-binding routing：`bindingsBySessionId`、collision-safe `(sessionId,operationId)` turn owner、binding-target pre-send fence、token-stale inert/unbind isolation；id-less snapshot/event 仅走 coordinator 安装的单一 attachment route，turn status与 session-specific unavailable 精确路由。
4. 既有 Phase 4A.0.1 seed repair/reconnect A/B/C 语义和 27 tests 原样保留。temporary seed STORAGE 仍留在 connection；未来注册 authority 可移除 storage，但 bounded same-operation stale-create repair decision 仍须 controller-local 保留，直到 Phase 5/backend 语义消除 global-event cursor race。Phase 7 仅移除 old-daemon missing-cursor shim。

**验收：** exact controller identity/state/local-dispose tests；A/B binding/同 operationId/attachment route/unavailable direct tests；现有 Client facade/destructive-switch/turn/extension suites全绿。Phase 4A.3 才引入产品 registry/LRU/max32/retained inactive behavior/attachment lease/React API migration与 AppShell takeover removal。

### Phase 4A.3.1：bounded SessionControllerRegistry + one attachment lease（DONE；Fresh independent verifier final PASS）

产品级 `SessionControllerRegistry` 已成为 exact controller admission/lookup/create registration、默认 max32、monotonic-ordinal deterministic LRU、create slot reservation 与 one semantic Browser attachment lease owner。仅驱逐 detached + quiescent + 非 lease source/target/desired 的 controller；eviction 只 local dispose/unbind，容量全受保护时在任何 wire/backend side effect 前固定 `session_busy/retryable:true`。A→B→A 保留 exact snapshot/cursor/history/pending/optimism；detach/release observation-only，correlated exact result/status仍可在 detached 状态落到 owner，transport loss只立即恢复 holder，detached lanes等待其 exact lease。

`RuntimeConnection` 已删除 temporary created-seed storage/helpers；create 成功由 registry 在 public Promise resolve 前同步构造/bind controller，并将完整 `{sessionId,epoch,lastEventId?,snapshot?}` authority 安装到 controller。controller-local create-completion fence继续保留 Phase 4A.0.1 同 operation 一次 repair、第二 conflict no-third、uncertain no retry、send-throw/old-envelope inert；旧 daemon missing `lastEventId` 仍显式 attach-first，等 Phase 7 build fence 删除。

`SessionStore` 现仅为 public compatibility facade，delegates exact controller/registry/global connection；不再拥有 controller set、attached/attach-intent/atomic target 或 destructive switch coordinator。AppShell/Composer/Provider public behavior与 one socket保持；**本切片仍保留 AppShell selected-live `openSession()` takeover**，selection UI-only 与新 React exact hooks留给下一切片。

### Phase 4A.3.2a：React exact runtime API + provider ownership（DONE；Fresh DeepSeek verifier final PASS）

新增 exact React APIs + provider ownership + 纯 exact registry 订阅 + 有界 composer staging owner + NON-OWNING compatibility adapter。现有生产消费者与 AppShell live takeover 仍走旧 API/行为。

**Ownership（硬不变量）**：RuntimeProvider 直接构造**唯一** `RuntimeConnection` 与**唯一** `SessionControllerRegistry`，`SessionStore` 接受注入 owners 且 NON-OWNING（dispose 只 unsubscribe，绝不 dispose registry/socket/settle controllers）；provider teardown `registry.dispose()` 恰一次（one socket/lease）；harness 显式构造/一次 dispose registry。`SessionStore` 成为 non-owning facade，仅投影/委托同一 owners；删除条件=4A.3.2b 生产 `useRuntime()` 导入归零。

**Registry 纯观察**：新增 `peek(sessionId)`（纯 no touch/publish/admit，绝不 LRU）与 exact-ID membership 订阅 `subscribeSession(sessionId, listener)`（register/evict/re-register + exact controller view 通知，no LRU/protection，mounted observer 可被驱逐；eviction 后 hook 回退 `available:false`，action 调用时才重新 admit）。`getOrCreate` 保持 operation-only。

**Exact hooks**：`useRuntimeConnection()`（connection cached snapshot/useSyncExternalStore，稳定 `connect` + registry-backed `createSession`，仅 global 字段 state/generation/host/features/error/fatal/running+live/known，无 exact/lease 动作）；exact `useRuntime(sessionId:string|null): ExactRuntimeApi|null`（旧零参 `useRuntime()` 以 safe overload 保留；nonempty absent 返回稳定 wrapper `available:false`+exact id+null authority；null 返回 null；hook 渲染/订阅绝不 admit/attach/touch；action 仅 invocation 时 admit 且 ID-bound，跨 admission/eviction/rebind/reconnect 稳定；含 acquire/stop/snapshot/commands/prompt/turn terminal/extension/controls/reads/model/thinking/name/tools/reload/compact/navigate 全 exact action surface，caller 不传 session id；保留 lease 语义与 registry-backed create）。`SelectedSessionProvider({sessionId})`+`useSelectedRuntime()`（route-agnostic，无 router import，无 holder/foreground fallback，未接生产 router/AppShell）。

**Public split**：`ExactRuntimeView` 只含 exact 字段（available/sessionId/attached/stopped/epoch/snapshot/streaming/partial/promptPending/attach+history generation+anchor/committed liveEntries/optimisticEntries/exact error/queued+extension pending/capabilities/turn active+delivery），无 global host/running/fatal/optimisticRunningSessionId。`SessionController.liveEntries` 修正为 committed only（optimism 只进 `optimisticEntries`）；compatibility facade recompose 旧合并投影（store `liveEntries` 保持 authority+speculative tail），全部现有生产测试/行为不变。

**Composer staging owner**：`features/composer/session-staging-store.ts`（+provider/hook），bounded（默认 max32/injectable），typed keys `session:<id>`/`new:<transactionId>`，严格 model/thinking 校验，空记录自动移除，A/B 独立，无 silent eviction（容量满→结构化 `session_busy retryable:true`），provisional→exact 同步 promote（碰撞 fail-closed + 失败保留 source），accepted clear、definite/activation failure 与 uncertain 保留，成功 live model/thinking 只清匹配字段；useSyncExternalStore 稳定快照；provider unmount clear。无 localStorage/Query/UI 字符串。**未接入 Composer**（4A.3.2b 迁移）。

**非目标（本切片不做）**：不迁移生产 consumer/router/AppShell/Composer/Transcript/Extension 行为（仅行为中立 type wiring）；不删除 facade/useRuntimeStore；无 backend/Protocol/Phase5/deps/package-lock/new UI/polling/second socket/localStorage staging。**4A.3.2b 待办**：迁移 consumers 到 exact hooks、移除 AppShell live takeover、把 staging 移入 Composer、删除 facade/harness 暴露、删除零参 `useRuntime()` overload。

**§82.1 首轮 verifier FAIL 修复（F1 关键 + F2 中等；Fresh DeepSeek verifier final PASS）**：F1 —— `main.tsx` 的 `<StrictMode>` 初始 mount 会执行 provider effect cleanup，首版同步 dispose 永久销毁唯一 registry/connection。修复为 `useStrictModeSafeOwnerDispose`：per-owner 身份版本化 + `queueMicrotask` 延迟 dispose，同 owner 第二次 setup（StrictMode）在 microtask 前递增版本取消模拟 cleanup；真实 unmount flush 才 dispose 恰一次；provider owner 由 useState 构造故**故意不可变**（deps/options 仅首渲染读取，已注释+测试）。F2 —— exact `stop` 从直接 `controller.stop` 改为 `registry.stop(sessionId, reason)`，确认 `stopped:true` 清 exact lease，`stopped:false` 留 lease/pending，absent no-op。Verifier 独立复跑原 FAIL probes，并补 multi-provider/nested/rapid-cycle、detached/wrong/late/duplicate stop 对抗用例，全部 PASS；Client `787/787`、focused `294/294`、root gates/E2E/diff/PID/package-lock hygiene均独立确认。详见 migration-ledger §82.1。

### Phase 4A.3.2b：迁移 consumers + 移除 takeover + 删除 facade（DONE；Fresh GLM verifier final PASS）

### Phase 4A.3.2b1a：NARROW 架构 wiring（只接 exact consumers；DONE，Fresh DeepSeek verifier final PASS）

**范围**：仅 5 个生产文件 + 对应测试/文档；**无 UI 行为变化**。

**接入**（上下文 wiring，只改架构不改变可见行为）：
- `routes/router.tsx`：在 validated router boundary（IndexPage，`validateWorkspaceSearch` 之后）挂载 route-agnostic `SelectedSessionProvider sessionId={search.session ?? null}` 包住 AppShell；file（validated search 已丢弃 session）/home/new ⇒ null；`RuntimeProvider` 仍在 `AppProviders`，router-free。该 selection provider 本身只注入 context，**绝不 attach/admit/lease**（隔离测试证明零 frames）；AppShell 独立保留的 selected-live takeover 在本切片仍可能对 live session 发 attach，下一切片才移除。
- `runtime/use-resume-refetch.ts`：由零参 facade 迁移到 `useRuntimeConnection()`（只读 provider-owned connection 的 transport state；`runtime.connection` → `connection.state`，canSend 语义不变）。
- `features/session-history/use-session-transcript.ts`：迁移到 exact `useRuntime(sessionId)` —— 无 facade current/foreground/session filter；committed exact `liveEntries` + exact `optimisticEntries`（不再按 sessionId 过滤，exact controller 已 ID-bound）直接进既有 `mergeTranscriptEntries`（persisted → committed live → optimistic，无 duplicate optimism）；unadmitted selected session 返回 `available:false` ⇒ HTTP-only、零 controller/admission/attach；retained detached exact controller 数据允许。无 Phase5 merge redesign、无 cross-session optimism。
- `components/transcript/TranscriptList.tsx`：已有 sessionId prop ⇒ `useRuntime(sessionId ?? null)`（`?? null` 使 undefined⇒null，绝不落入零参 facade）。`isLive = liveProp ?? exact.attached ?? false`（exact `attached` 是 per-session，消除旧 facade-current mismatch：不再因“其他会话 attached”误判本列表 live）；`snapshot/partial(→exact.partial)/sessionId` 全部来自 exact view。Props/render/DOM/strings/virtualization 零改动。
- `features/extension-request/ExtensionRequests.tsx`：无 sessionId prop ⇒ `useSelectedRuntime()`（null-safe；无 selection ⇒ 渲染 null，绝不 admit/attach/发明 transport state）。existing `live`/capability gating、error describer、copy、DOM、action（respondExtensionUi/sendExtensionUiInput）全部不变。

**硬不变量（保持）**：AppShell selected-live takeover 不变；Composer 仍走零参 facade、`SessionStagingProvider` 仍未挂载；AppShell/Sidebar/Composer/ChatInput/styles/i18n 未编辑；SessionStore facade 保留、无测试 harness 迁移；仍恰一个 provider-owned connection/registry/socket/lease。

**验证**：Fresh DeepSeek verifier 最终 `PASS`。独立确认生产改动恰 5 文件、AppShell/Composer/Sidebar/ChatInput/styles/i18n 未触碰，provider context 零 frames 与 AppShell takeover 的独立语义文档诚实；focused `31/31`、AppShell/Composer parity `66/66`、Client `793/793`、typecheck/build/boundary（222 files）、root architecture/typecheck/test/build、Runtime/Startup/Sessions E2E、diff/PID/package-lock hygiene 全 PASS。

### Phase 4 final Client runtime architecture（历史实现 DONE；观察行为验收重新评估）

> 本段保留旧实现与测试来源。将 page/sidebar/tab 选择一律要求零 attach 的规则，与“点进 busy 会话继续看流”的目标冲突；本轮应保留零隐式 Worker 启动、状态隔离和迟到事件防护，按新的观察契约替换错误断言，不删除这些有效覆盖。

**状态**：DONE。Fresh GLM verifier 经 FAIL→F1–F6 窄修复后最终 `PASS`。本切片完成剩余 Phase 4 Client runtime architecture：provider-owned one `RuntimeConnection` + one `SessionControllerRegistry` + immutable exact `SessionController`s + one attachment lease。URL selection is UI-only。Every production consumer uses global/exact APIs。No production `SessionStore` facade, zero-arg `useRuntime()`, `useRuntimeStore`, `RuntimeApi`/`RuntimeView` compatibility types, or store-based harness remains。

**Ownership / files**
- `packages/client/src/runtime/runtime-provider.tsx` — context is `{connection, registry}` only; StrictMode-safe owner-version microtask disposal still disposes once; no store construction/cleanup.
- `packages/client/src/app/AppProviders.tsx` — mounts `SessionStagingProvider` at app level with the same StrictMode-safe owner-version disposal.
- `packages/client/src/components/shell/AppShell.tsx` — `useRuntimeConnection()` + `useSelectedRuntime()`; selected-live takeover/retry/loading gate removed; selection/page/tab/sidebar navigation emit zero attach/detach/stop/admission.
- `packages/client/src/components/shell/Sidebar.tsx` — destructive actions gated by ANY id in global `liveSessionIds` (including background live holder); public UI unchanged.
- `packages/client/src/components/shell/Composer.tsx` — exact selected + connection + `useExactActionCoordinator`; bounded staging via `session:<id>` / `new:<transactionId>`; new-session first-send is one coordinator state machine over the same registry.
- Deleted production `packages/client/src/runtime/session-store.ts` and all production SessionStore/RuntimeApi/RuntimeView/useRuntimeStore/zero-arg overload exports.
- Test-only helper lives under `packages/client/src/runtime/testing/` (`test-runtime-store.ts`, `capture-test-runtime.ts`); it composes operations but is not a production facade or lifecycle owner.

**Test parity mapping (no behavior deletion)**
- Former AppShell selected-live takeover / retry / loading-gate tests → stronger zero-frame page-load and A→B→A selection parity (zero attach/detach/stop; holder/reconnect independent from URL).
- Former "automatic live takeover never hides staged model" → A/B independent staging across selection; live A never hides B's staged model; selection still zero frames.
- Sidebar background live action gating added; AppShell DOM/project-selector tests retained.
- Composer A/B staging, provisional promotion, accepted clear / failure+uncertain preserve, exact dynamic create/send, draft/image/terminal parity retained in Composer + provider suites.
- Exact transcript/extension isolation retained.
- Relocated `session-store*.test.ts` suites keep describe names as the documented mapping and now drive TestRuntimeStore over the same connection/registry/controllers (controller/registry/exact API parity, including turn 27+).
- Static architecture gate now enforces zero production facade imports/references and no liveTakeoverRef/open-on-selection.

**Phase 4 non-goals kept**: no UI redesign/layout/style/copy/i18n/project-selector/branding; ChatInput/SessionInfoBar remain prop-only. 后续 Phase 5A/6/7A 已分别按 owner package 落地并独立验证；它们不改变本段 Phase 4 的边界与验收证据。

### Phase 5：统一 session revision 与历史/实时合并

**Owner：** sessiond projection + Protocol + Client history layer。

1. 为 JSONL read model、runtime snapshot、live event 定义可比较的 `sessionRevision`/leaf fence。
2. snapshot/event 只有在 sessionId+epoch+revision 可证明连续时才增量合并；gap/epoch_changed 明确 rebase。
3. history query、liveEntries、optimistic entries 通过 authority identity 对账；禁止只按文本/FIFO 匹配已提供 identity 的消息。
4. 新会话 provisional row 只作为 UI transaction，必须以 authority sessionId/revision commit 或 definite failure 清理。
5. branch/navigate/compact/fork 后明确 invalidate 的对象：history anchor、live tail、metadata、optimistic transaction。

**状态：Phase 5A DONE / independent verifier + Runtime E2E PASS；Phase 5B DONE / Fresh DeepSeek verifier PASS。** 5A same-epoch revision、persisted leaf fence、identity optimistic commit、`session_changed`链路已落地。5B 以 `runtime.epoch-rollover.v1` 在严格 quiescence 下执行Worker不重启的whole-epoch rotation；触发请求零dispatch并返回`epoch_changed`，old/missing epoch fail-closed，ack不确定时record关闭防split-brain。详见 migration-ledger §88。

**验收：** page reload、same-epoch replay、journal gap、epoch change、compaction、branch navigation、fork 后 transcript 不重复、不丢、不跨会话。

### Phase 6：workspace authorization 与 session catalog 对齐

**Owner：** runtime-core/Protocol session read model + Host AllowedRoots + Client。

1. Host 仍是路径安全权威，不把“session 可见”当成授权。
2. 在 session list/detail 投影 `workspaceAccess`：`authorized | history_only | unavailable`，来源是 Host 的 AllowedRoots 结果。
3. history-only 会话可以读取 JSONL（若 session catalog 能读取），但不能展示 models/files/skills/write/send 能力。
4. out-of-root cwd 不得自动扩根；动态授权必须走显式 trust/roots mutation 并受 LAN/认证策略保护。
5. catalog query 的错误不能被组件 `.catch(() => empty)` 转成假成功；固定错误文案集中在 `describe*Error`。
6. 加入根目录边界、symlink、删除/重命名 root、LAN degraded、历史会话跨 root 的测试。

**状态：** Phase 6A backend + Phase 6B Client degradation **DONE / Fresh GLM verifier PASS**。Client `806/806`，root architecture/typecheck/test/build 与 Startup/Runtime/Sessions E2E 全绿；Phase 5A/7A 后续 port 后再次保持全绿。

**验收：** 项目列表不会把 history-only 项目伪装成完全可操作项目；模型目录失败显示结构化不可用原因，不再出现选择成功但发送必失败。

### Phase 7：daemon/Worker 版本栅栏与发布生命周期

**Owner：** protocol hello + CLI composition + sessiond/Worker。

1. `system.hello` 返回并验证 product version、protocol version、sessiond build、Worker/adapter contract、capability fingerprint。
2. `pix start` 复用 daemon 前必须通过明确兼容矩阵；同 protocol major 不代表实现兼容。
3. 不兼容时执行有序 drain/restart 或返回固定 operator action；绝不静默复用旧 daemon。
4. Worker init 记录 adapter contract；sessiond 拒绝未知/不兼容 Worker。
5. Host restart 只释放 Host socket/attach；sessiond/Worker 存活必须可验证。
6. `pix down` 继续使用认证 RPC，不回到 PID/SIGTERM 旁路。

**状态：Phase 7A DONE / Fresh DeepSeek verifier PASS。** Protocol `193/193`、Worker build/controller/mapper `34/34`、sessiond build/process `44/44`、CLI build/supervise `25/25`，root gates 与三条 E2E 全绿；同 protocol major 的 stale build不再静默复用。

**验收：** 分别更新 Client、Adapter、Host、sessiond、Worker 的 dist 后，启动行为可预测；旧 epoch response 不会被新 build 接受为当前操作。

## 5. 实施顺序与回滚边界

1. 先做 Phase 1 read model：它不改变 Worker 生命周期，风险最小，却直接消除 model/thinking drift。
2. 再做 Phase 2 read/mutation 分域：先加测试和统计，再切换 Client 调用，避免直接修改 dedupe 语义。
3. Phase 3 与 Phase 4 必须先冻结协议状态机再改 UI；不得继续在 Composer 增加新的 competing effect/ref。
4. Phase 5 在删除旧 optimistic/history 兼容逻辑前完成 parity tests。
5. Phase 6、7 与 runtime 改造并行但分别验收；安全权限和版本生命周期不能作为 runtime bug 的 fallback。
6. 每个阶段都必须能独立通过：`check:architecture`、`typecheck`、相关包测试、`build`、`git diff --check`；跨 Runtime Core/Protocol/sessiond/Host/Client 改动需要独立对抗验证。

## 6. 当前执行项

**Phase 1 已完成首个贯通切片**：0 Worker 的 SessionContext 已补齐 branch-resolved model/thinking metadata，并贯通 adapter → Protocol/Host → Client transcript → Composer；旧 additive v2 缺字段显示 unknown，不再猜测。**Phase 2B 独立 read RPC 已贯通**：协商特性 `runtime.read-rpc.v1` 连接 Browser `read/read_result`、Host `runtime.read`、sessiond bounded per-session read queue、Worker `worker.read/worker.readResult` 与 Adapter `port.read()`；`get_tools` 由 authoritative snapshot 满足，`get_state/stats/commands` 走 Worker read（避免 signal-only projection 返回 stale context/state），所有层独立于 mutation command slot/accepted-id ledger。Worker ready feature fence 阻止 sessiond 对旧 Worker 错误广告 seam。旧 Protocol v2 command-envelope read 仍作为明确有限 shim，移除条件为 Protocol v3 最低版本 + Phase 7 daemon/Worker build contract；mutation accepted-id 的最终有界 replay-safe 方案仍待继续。

**Phase 3 原子 submitTurn 已贯通**：协商特性 `runtime.submit-turn.v1` 连接 Browser `submit_turn/submit_turn_result/turn_status`、Host 专用 bounded turn lane/subscription、sessiond 权威 submitTurn（cold activation + epoch/revision fence + operation ledger + 快速 admission + terminal status subscribers）、Worker `worker.submitTurn/submitTurnResult/turnStatus`（当前 epoch dedup + 即时结果 + terminal 状态 + feature 广告）与 Adapter `port.submitTurn()`（模型→思考→恰一次 prompt，快速 truthful admission，terminal 之后；`execute(prompt)` 复用同一实现并等待完成）。Client 端单 PendingTurn + `not_delivered/in_flight/accepted/uncertain` 交付状态、same-epoch reconnect 以新 transport identity 重发同 operation/payload、epoch change 后可能已投递绝不重发、严格 generation/session/epoch/operation/turn 匹配、长 turn 不占用 `pendingCommand`、冲突普通命令 `session_busy`；私有的 `legacySubmitTurnV2()` 作为有限 v2 shim。`sessiond` 的 accepted-turn ledger 不做 per-ID eviction/replay；Phase 5B 已以严格 quiescent whole-epoch rollover替代永久容量耗尽（实现/验证见 §88）。旧 v2 prompt command-envelope 在协商连接上 fail-closed 拒绝，移除条件同为 Protocol v3 最低版本 + Phase 7 build contract。Post-fix 独立 verifier 已对 forged turn/session/snapshot identity、admission-snapshot 零 prompt、same-operation Worker dedup、Host lane 隔离、新会话 create 解析（身份 + 零 attach）、sessiond 重复稳定性与三条 E2E 给出最终 `PASS`；root test clean exit，不再保留 open-handle blocker。

**Phase 4A.0 Client create 基线修正 + Host turn 订阅键硬化已贯通，Phase 4A.0.1 bounded created-seed revision repair 已完成并获 Fresh independent verifier 最终 `PASS`（详见 migration-ledger §76/§78）**：`createSession` 公开参数仅 `{cwd, projectRoot}`，create 响应立即以 session identity 解析、零 attach、不 detach/替换当前附着 session；`runtime.create` 仍是 sessiond 生命周期权威（可启动 Worker），**不宣称零 Worker**。有界 exact-session seed facade（bound 32）保留 create-completion epoch/cursor；该 cursor 不是 reservation。后续全局兼容事件令其 stale 时，Client 只对 same-epoch/newer-revision 的 exact `not_delivered conflict` 自动执行一次 same-operation repair，第二次仅推进 seed 后正常 definite-failure；explicit/attached/none、uncertain 或 malformed/stale authority 均不修复。旧 v2 daemon 缺字段时仍 attach 一次取得 exact cursor。Host `activeTurns` 保持精确复合键 `(sessionId, operationId)`。

**Phase 4A.1 单一 `RuntimeConnection` ownership extraction 已实现并获 Fresh independent verifier 最终 `PASS`（详见 migration-ledger §79）**：connection 现为唯一生产 socket/handler owner，拥有 handshake/features/readiness/global running/create/seeds 与默认 256 bounded attempt registry；严格 result matching、one-shot vs logical-retry disconnect policy、Provider one connection/socket 与 public API stable refs 已有 deterministic coverage。

**Phase 4A.2 mechanical extraction 已实现并获 Fresh independent verifier 最终 `PASS`**：constructor-fixed exact `SessionController` 已接管全部 session-local state/business logic；其冻结的 destructive-switch facade parity与验证记录保留在 migration-ledger §80。

**Phase 4A.3.1 bounded registry + one lease 已实现并获 Fresh independent verifier 最终 `PASS`**：`SessionControllerRegistry` 已接管 max32 exact admission、monotonic LRU、create reservation/registration、retained inactive controllers与唯一 semantic attachment lease；`SessionStore` 仅为 compatibility facade。temporary seed storage已从 connection删除，完整 create authority同步安装到目标 controller；bounded same-operation repair仍 controller-local，old-daemon missing-cursor attach-first shim仍待Phase7。retained/independent parity将原 destructive assertions替换为 exact detached settlement与A/B lane coexist覆盖。Verifier 独立运行 19 个 deterministic adversarial probes，覆盖 protection/LRU/create collision+reservation/repair provenance/lease supersession+disconnect/detached turn settlement/optimism retention，全部 PASS；focused `319/319`、Client `746/746`、root gates、三条E2E、diff/PID/package-lock hygiene均独立确认。下一切片仅为4A.3.2 React exact APIs + selection/staging migration + AppShell takeover/facade removal。

**Phase 4A.3.2a 已实现并获 Fresh DeepSeek verifier 最终 `PASS`**：exact React APIs + provider ownership + 纯 exact registry 订阅 + bounded composer staging owner + NON-OWNING compatibility adapter 已贯通；首轮 verifier 的 F1 StrictMode 永久 dispose 与 F2 exact stop lease divergence 已修复并独立复验关闭（详见上方 Phase 4A.3.2a 小节与 migration-ledger §82/§82.1）。

**Phase 4 final Client runtime architecture 已完成并获 Fresh GLM verifier 最终 `PASS`**：AppShell selected-live takeover 已移除；Composer 使用 exact/connection/staging + 动态 exact coordinator；生产 facade/`useRuntimeStore`/零参 `useRuntime()`/`RuntimeApi`/`RuntimeView` 已删除；测试 harness 迁到 `runtime/testing/`。最终 Client `796/796`、Client typecheck/build/boundary 223 files、root architecture 14 gates/typecheck/test/build、Runtime/Startup/Sessions E2E、diff/PID/package-lock hygiene 全 PASS。

**Phase 5A/5B/6/7A 已全部落地 current root 并独立验证 PASS**：5B strict quiescent whole-epoch rollover不evict ID、不提高上限、不重启Worker；Protocol `195/195`、Worker `119/119`、sessiond `368+1skip`、Host `526/526`、Client `837/837`，root architecture/typecheck/test/build与三条E2E全绿。这些是当时阶段的验证证据；用户报告的长会话发送及运行中切换续流仍未解决，当前生命周期产品验收重新打开。
