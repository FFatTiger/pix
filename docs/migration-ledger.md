# 旧重构成果迁移台账

> 本文件记录旧 `pi-web` 工作区中的新架构成果如何迁入独立 `pix` 仓库。
>
> 旧 commit、旧测试结果和旧任务状态只能证明来源存在；只有迁入 `pix`、重新验证并集成后，任务才能标记为 `DONE`。

- 建立日期：2026-08-11
- 目标仓库：`/Users/proxy/Documents/program/pix`
- 旧仓库：`/Users/proxy/Documents/program/pi-web`
- 旧 worktree 根：`/Users/proxy/Documents/program/pi-web-worktrees`

## 1. 全局排除项

以下旧产品路径不迁入 `pix`：

```text
app/**
components/**
hooks/**
lib/**
public/**（旧 Next 产品资源）
next.config.*
proxy.ts
instrumentation.ts
bin/pi-web.js
.next/**
旧根 package.json
旧根 package-lock.json
旧根 bun.lock
旧根 tsconfig.json
旧产品发布、sync/upstream、v0.8.x 分支
```

必要的图标或 PWA 资源必须由 Client 工作包逐项选择并记录来源，不能整体复制旧 `public/**`。

## 2. 来源快照

| 来源 | 分支 | HEAD / 状态 | 用途 |
|---|---|---|---|
| `pi-web-worktrees/integration-v1` | `refactor/architecture-v1` | `e3508e2`，clean | Runtime Core、Contract Tests、Protocol、Host、Client/H1B 候选来源 |
| `pi-web-worktrees/client-data` | `refactor/client-data` | `d9f0be7`，clean | 最新 Client Protocol + HTTP data 候选来源 |
| `pi-web-worktrees/pi-sdk-adapter` | `refactor/pi-sdk-adapter` | `ed34415`，clean | Pi SDK Adapter 候选来源 |
| `pi-web-worktrees/sessiond-core/packages/sessiond` | `refactor/sessiond-core` | branch HEAD `4a47a05`；目录全部未跟踪 | sessiond 候选源码，风险最高 |

旧 worktree 在迁移与校验完成前保持只读，不删除。

## 3. 包迁移表

| 目标包 | 来源 | 来源状态 | 迁移范围 | 排除项 | pix 状态 |
|---|---|---|---|---|---|
| `packages/runtime-core` | `integration-v1@e3508e2`，tree `1debd7e020d0495a27f4e044a27bb72c2fcf45a4` | 旧验证通过 | 整包源码、测试、manifest、tsconfig | `dist`, `dist-test`, `node_modules` | `DONE`：`ea7e207`；源码字节一致；Core 3/3；GPT PASS |
| `packages/runtime-contract-tests` | `integration-v1@e3508e2`，tree `899aa8a188979867336f75985a0fb56eaa408a69` | 旧验证通过 | 整包源码、测试、manifest、tsconfig | `dist`, `dist-test`, `node_modules` | `DONE`：`ea7e207`；源码字节一致；Contract 75/75；GPT PASS |
| `packages/protocol` | `integration-v1@e3508e2`，tree `16c9144c085111c4d947f969b75fe5161a2554b8` | 旧验证通过 | 整包源码、测试、manifest、tsconfig | `dist`, `dist-test`, `node_modules` | `DONE`：`ea7e207`；源码字节一致；Protocol 109/109；GPT PASS |
| `packages/host` boot surface | `integration-v1@e3508e2`，source tree `207e9446378a0e8586ae17659b905d3310d05875` | H0A/H1B 旧验证通过 | Hono app/server、gate/security/static、health、WS guard 基础 | 未使用的旧兼容装配；M1 可暂不挂 files/git/worktree | B2 `DONE`：`c65d2df`；H1 `DONE`：`e9e7d49` + `f960390` + `976c4c6` + `a6eb571`，Host172/172，GPT PASS |
| `packages/client` boot surface | `client-data@d9f0be7`，source tree `bb2bc86d6c9890d4a35f30b44f1b278e8397e796` | 实现已提交、旧独立验证未完成 | Vite shell、正式 Protocol、HTTP/gate/health/capability 基础 | demo sessions、Runtime no-op 作为产品实现、未挂 Host API 的资源 UI | `DONE`：`c65d2df`；Client 82/82、demo已删除、bootstrap真实消费；M1 GPT PASS |
| `packages/sessiond` | 未提交目录 | 候选代码，不能视为 DONE | `package.json`, `scripts/**`, `src/**`, `test/**`, `tsconfig*.json` | `dist`, `dist-test`, `*.tsbuildinfo`, `node_modules` | `DONE`：`5dc9469` + `44529c3`；GPT复验PASS；38/38 |
| `packages/pi-sdk-adapter` Agent 路径 | `ed34415`，tree `2b7eae40cf731ac338380941b2822485e5866f95` | 候选实现；4项问题已在A1处置 | Agent Factory、Runtime、message mapper、sanitizer、必要internal | sessions/models/credentials/resources/trust延后 | `DONE`：`526b19e` + `fd4612b`；GPT PASS；92/92、真实SDK 0.84 create/open smoke |
| `packages/agent-worker` | 无 | 不存在 | 新实现 | — | `NEW_M2` |
| `packages/cli` | 无新架构实现 | 不存在 | 新实现 | 旧 Next bin | `DONE`：`8f918a9`；pix lifecycle CLI与production composition；CLI 29/29；M1 GPT PASS |

## 4. 已完成迁移记录

### B1 — Core + Protocol Migration

```text
来源绝对路径：/Users/proxy/Documents/program/pi-web-worktrees/integration-v1
来源 commit：e3508e28f3099987780c1f8e95636fbc98284705
来源 tree hash：
- runtime-core: 1debd7e020d0495a27f4e044a27bb72c2fcf45a4
- runtime-contract-tests: 899aa8a188979867336f75985a0fb56eaa408a69
- protocol: 16c9144c085111c4d947f969b75fe5161a2554b8
迁移方式：git archive 精确抽取来源 commit 中三个 package tree
有意修改文件：无 package 源码修改
仓库适配：新增根 .npmrc include=dev，抵消执行环境 NODE_ENV=production 对源码构建 devDependencies 的省略
排除文件：dist/**, dist-test/**, node_modules/**, *.tsbuildinfo
本地验证：
- npm ci: PASS
- npm run check:architecture: PASS
- npm run typecheck: PASS
- 根 scripts tests: 40/40
- Protocol: 109/109
- Runtime Contract Tests: 75/75
- Runtime Core: 3/3
- npm run build: PASS
- git diff --check: PASS
独立验证 verdict：PASS（GPT；允许 B1 标 DONE 并启动 B2/B3）
迁移 commit：ea7e207
验证说明：验证器在临时目录 fresh build/typecheck/test；tree hash、lockfile、架构边界、实际测试数量和对抗 consumer probe 全部通过。唯一非阻塞观察是 `.npmrc include=dev` 会影响未来 production-only install，留到 REL1 定义发布安装策略。
```

## 5. B3 — sessiond Daemon Bootstrap 记录

```text
来源绝对路径：/Users/proxy/Documents/program/pi-web-worktrees/sessiond-core/packages/sessiond
来源状态：refactor/sessiond-core@4a47a05 下未跟踪目录
迁移方式：source-only，排除 dist/dist-test/node_modules/tsbuildinfo
迁移 commit：5dc9469
来源修复：service.ts 未定义 closeReason 改为 Protocol RuntimeCloseReasonSchema 规范化
新增：daemon composition、M1 unavailable worker、locator/context stubs、control API、stale socket清理、signal shutdown、daemon tests
本地验证：
- npm ci: PASS
- npm run check:architecture: PASS
- npm run typecheck: PASS
- npm test: PASS（sessiond 29/29；其余公共包全绿）
- npm run build: PASS
- git diff --check: PASS
独立验证 verdict：PASS（GPT复验）
修复 commit：44529c3
复验证据：原启动窗口探针40/40；0-byte legacy secret自愈；SIGKILL secret窗口12/12恢复；原回归探针118/118；新专项探针24/24；并发发布收敛且不覆盖；live-owner temp不删除；signal handler无泄漏；sessiond 38/38。B3可DONE，B4可启动。
残余非阻塞边界：不支持硬链接的特殊文件系统会fail closed；Windows权限/信号语义仍按既有平台限制；低概率PID复用风险保留。
残余平台风险：Windows named-pipe/socket权限覆盖有限；PID复用探测为低概率已知限制；down --all 属B4
```

## 6. B2 — Host + Client Boot Surface 记录

```text
Host来源：/Users/proxy/Documents/program/pi-web-worktrees/integration-v1@e3508e2，tree 207e9446378a0e8586ae17659b905d3310d05875
Client来源：/Users/proxy/Documents/program/pi-web-worktrees/client-data@d9f0be7，tree bb2bc86d6c9890d4a35f30b44f1b278e8397e796
迁移 commit：c65d2df
有意修改：
- Host新增 /v1/bootstrap、no-store、gate/mode/sessiond/capability投影
- capability在未挂资源/runtime时默认为空，不误报agent/files
- Client消费真实bootstrap，删除demo transcript，未连sessiond时不请求sessions/context
- Client clean build显式先构建Protocol
- 新增bootstrap与真实静态托管集成测试
本地验证：
- Client 82/82
- Host 132/132
- 根scripts 40/40、Protocol 109/109、Contract 75/75、Core 3/3、sessiond 29/29
- typecheck/build/architecture/host+client boundaries/git diff-check PASS
- Host指向真实Client dist：index/hash asset/bootstrap/health/SPA fallback PASS
独立验证 verdict：PASS（随B4/B5完整M1启动链统一GPT验证）
依赖审计：2 moderate，来自 @hono/node-server <2.0.5 的Windows encoded-backslash serve-static公告；当前无fixAvailable。本项目不使用其serve-static，使用自有static实现且已有路径遍历/符号链接测试；记录但不阻塞M1。
```

## 7. B4/B5 — Production Composition 与 Startup E2E 记录

```text
实现 commit：8f918a9（packages/cli + root product dispatcher）
CLI：pix、pix-host、pix-sessiond
生命周期：ensure/reuse detached pix-sessiond、真实RPC probe、Host只关闭自身、status、down --all
能力：M1 full/readonly capabilities 均为空，不误报agent/files
包级验证：CLI 29/29；shutdown超时明确返回failed，不伪造成功
真实生命周期：
- root product dispatcher启动Host与pix-sessiond
- /v1/health、capabilities、bootstrap、Client index与Vite JS均200
- Host停止后pix-sessiond PID不变且RPC健康
- pix-host重启复用同一PID
- down --all停止daemon并清理lock/socket
B5自动化：tests/e2e/startup.mjs；npm run test:e2e:startup PASS
B5 commit：a7e9e29
全仓门禁：fresh npm ci、architecture/build/typecheck/tests/boundaries/diff-check PASS；测试精确为scripts44、CLI29、Client82、Host132、Protocol109、Contract75、Core3、sessiond38
独立验证 verdict：PASS（GPT最终M1对抗验证；B5独立4/4；occupied port、daemon复用、missing dist、host-only、stale/hung lock、LAN fail-closed均PASS）
M1 verdict：DONE；M2 UNLOCKED
非阻塞：Hono 2 moderate来自未使用的serve-static；本项目使用自有static实现并有路径/符号链接测试。
```

## 8. A1 — Pi SDK Agent Adapter 记录

```text
来源绝对路径：/Users/proxy/Documents/program/pi-web-worktrees/pi-sdk-adapter/packages/pi-sdk-adapter
来源 commit：ed34415
来源 tree：2b7eae40cf731ac338380941b2822485e5866f95
迁移方式：Agent-only source selection；排除dist/dist-test/node_modules/tsbuildinfo与data/resource/trust路径
实现 commit：526b19e
lock/build-order修正：fd4612b
目标包：@fffattiger/pix-pi-sdk-adapter@0.1.0；只导出`.`与`./agent`
能力：M2_AGENT_CAPABILITIES精确为runtime.prompt+runtime.abort；Factory必须显式传capabilities，无full默认泄漏
语义：Runtime Core message事件保持累计partial；bash_update事件发delta、snapshot保存权威累计；terminal prompt_done由Adapter拥有
安全：SDK import仅在packages/pi-sdk-adapter/src/internal/sdk-runtime.ts；sanitizer递归脱敏且不泄漏raw Error；无旧产品命名
真实SDK：@earendil-works/pi-*@0.84.0可安装；production create/close与composition-order离线smoke PASS
本地验证：fresh npm ci、architecture/build/typecheck/root tests PASS；A1 boundaries PASS、commands 26/26、tests 92/92
排除：sessions/models/credentials/resources/trust、sdk-data/oauth-flow及其生产端口，延后M3
残余：ExtensionUIContext与SDK内部ProjectTrustStore存在版本耦合，但M2不暴露extension_ui/trust capability。上游SDK仅在首条assistant entry后持久化session，因此open只保证已持久化session；空session由存活Worker持有。理论迟到bash chunk可追加已完成snapshot，但真实SdkRuntimeDriver在finally清空callback，不可达；列为后续防御硬化。
独立验证 verdict：PASS（GPT；fresh npm ci/build/typecheck/root tests/startup E2E、A1 92/92、26/26 commands、无网络真实SDK create/open、capability/bash/sanitize对抗均PASS）
```

## 9. R0 — Protocol Process Corrections 记录

```text
实现 commit：2672c5c
worker.init：必填mode=create|open；sessiond create/activate分别透传
worker.ready：移除epoch；epoch只由sessiond生成和拥有
interrupt：browser commandId贯穿sessiond RPC、worker IPC与correlated result；同ID同type去重，同ID异type非重试拒绝；wire ID/commandId/type严格匹配
streaming：Runtime Core message_update仍为累计partial；Protocol为delta；有状态转换明确归R1 Mapper
bash：bash_update.output冻结为delta；sessiond SnapshotProjection为唯一累加器
本地验证：architecture/build/typecheck/root tests/startup E2E/boundaries PASS；Protocol 110/110、sessiond 40/40、A1 92/92、Contract75、Core3
兼容：Protocol version仍为1；M2尚未发布，无旧消费者兼容alias
残余：Host WS需在H1将RPC correlated interrupt result翻译为WS interrupt_result
独立验证 verdict：PASS（GPT；17/17专项对抗，Protocol110、sessiond40及全仓回归PASS）
验证说明：同commandId同type仅一次worker send；异type非重试拒绝；错误commandId/type结果丢弃；capacity/send failure/stop/crash/timeout/late result均fail closed并保留commandId。interrupt result cache eviction分支因admission上限在当前设计不可达，但内存仍由interruptLimit有界，不构成风险。
```

## 10. H1 — Runtime WebSocket Gateway 记录

```text
实现 commit：e9e7d49
lockfile commit：f960390
资源上限 commit：976c4c6
非法limit hardening commit：a6eb571
Protocol：WS新增getSnapshot/stop；response严格结果union；attach result必填workerStatus；ProtocolVersion仍1
sessiond client：新增@fffattiger/pix-sessiond/client；attach subscription暴露closed Promise；initial failure与post-attach close严格区分
Host：SessiondRuntimeGateway完成handshake/create/cold-open attach/detach/command/interrupt/getSnapshot/stop；initial snapshot回显attach id，replay/live无id
安全与生命周期：原Host/Origin/Origin/LAN gate在upgrade前不变；browser close只detach不stop；unexpected stream close发送runtime_unavailable并1011；outbound 256 frames/4MiB + bufferedAmount fail closed；inbound普通队列256 frames/4MiB、interrupt并发16，overflow分别1009/1008；非法limit回退安全默认
CLI：只读secret，缺失/unsafe fail closed；注入gateway；保留36e81d4 trusted host合并；agent capability继续[]直到R2/X1
本地验证：architecture/build/typecheck/root tests/startup E2E/boundaries PASS；Host172/172、Protocol114/114、sessiond42/42、CLI32/32、Adapter92、Client82、Contract75、Core3、scripts44
残余：真实Worker尚未由R2接通，故gateway已可用但create/activate仍会诚实返回worker_unavailable；getSnapshot/stop当前在长command后串行，C1必须先interrupt再stop，并遵守每socket最多16个in-flight interrupt与256个pending普通帧。
独立验证 verdict：PASS（GPT最终复验；原165MB普通队列与50k interrupt并发耗尽均关闭；NaN/Infinity/0/负数/unsafe integer无法再禁用inbound/outbound bound；Host172/172、全仓tests、build/typecheck/architecture/boundaries/startup E2E全部PASS；无剩余H1 finding。）
```

## 11. R1 — Agent Worker Controller + Stateful Mapper 记录

```text
实现 commits：f7388b1 + 710ab1c
lockfile commit：43d5b53
包：@fffattiger/pix-agent-worker；公开worker-main export解析到dist/composition/worker-main.js
Controller：worker.init create/open；prompt/abort/snapshot/shutdown；correlated result exactly-once；不生成epoch/eventId
Mapper：累计partial按前缀diff为Protocol delta；非前缀/role变化开新stream；bash delta原样；sessiond projection作为逆向oracle
Transport：2MiB NDJSON；严格schema；stdout串行背压；stdin EOF有序退出；malformed/oversize发送worker.fatal并exit(1)
Composition：仅通过@fffattiger/pix-pi-sdk-adapter/agent接真实SDK；M2 capability严格prompt+abort；production stdout仅协议帧
本地验证：Agent Worker90/90、boundary 12 src/12 declarations、architecture/build/typecheck/root tests/startup E2E PASS
残余：sessiond侧Child Process Worker Factory由R2接通；真实Browser→Host→sessiond→child→SDK链路留待X1
独立验证 verdict：PASS（GPT；Agent Worker90/90 + 约90项独立对抗检查，真实worker-main/SDK无网络create与prompt、Controller correlation、Mapper projection oracle、2MiB NDJSON、stderr/stdout、stdin EOF及R2 wire contract全部PASS。P3观察：fast shutdown的5s timer未清、seen command/interrupt sets按Worker lifetime增长；均不阻塞R1/R2，留后续hardening。）
```

## 12. R2 — Child Process Worker Factory 记录

```text
实现 commits：536b776 + ee05c09
StderrRing hardening commit：e4335a7
lockfile commit：03edc9a
Factory：每session一个non-detached Node child；绝对解析@fffattiger/pix-agent-worker/worker-main；spawn前安装listener并buffer early message/exit
Wire：2MiB UTF-8 NDJSON；split/coalesced/CRLF；严格Protocol schema；bounded serial stdin writer；stderr持续drain到bounded redacted ring
Close：stdin.end→SIGTERM→SIGKILL三段有界deadline；仅等待OS child exit；PID reuse guard；幂等；不forge worker.shutdown
Env：不spread process.env；强制PIX_AGENT_BACKEND=sdk；仅PATH/HOME/PI_CODING_AGENT_DIR/provider allowlist；拒绝sessiond secrets与任意PIX_透传
Daemon：默认ProductionWorkerProcessFactory；显式workerFactory override优先；Host agent capability继续[]直到X1
主线发现并修复：单个stderr chunk大于ring上限时旧whole-chunk eviction会清空snapshot；改为保留UTF-8安全最新tail、再次redact；失败测试finally关闭child
本地验证：sessiond71/71；stderr flood Grok40/40 + main10/10；Agent Worker90；全仓architecture/build/typecheck/tests/startup E2E/boundaries PASS
残余：真实Browser→Host→sessiond→SDK prompt/stream/abort与restart/resume留待X1；独立R2对抗验证进行中
首轮独立验证 verdict：FAIL（GPT；异常parent death orphan + stderr跨chunk credential suffix leak）
修复 commits：9b59801 + 0a7d21e + GLM c593070；测试自足修复cb2d2c7
修复语义：auto-run同步ppid death watchdog、early stdin EOF latch、transport terminal-state guard；broken stdio有界exit；StderrRing按完整line跨chunk redaction并限制8KiB pending raw；snapshot/exit diagnostic无secret fragment
修复验证：从rm -rf dist/dist-test开始Agent Worker105/105；sessiond76/76；root713/713；typecheck/architecture/startup PASS；无遗留Worker PID。原GPT验证器复验中
独立验证 verdict：PASS（GPT复验；parent exit/crash/SIGKILL × factory/direct × delay0/50/150及death-before-startup共36/36无orphan/zombie；daemon SIGKILL Worker死亡；redaction matrix308/308及真实WorkerExit.error无泄漏；clean-dist Agent Worker105/105、sessiond76/76、root713/713。）
```

## 13. C1 — Client RuntimeSocket + SessionStore 记录

```text
实现 commit：08f0362
测试清理 commit：d06db38
Protocol：新增共享纯projection reducer；sessiond SnapshotProjection委托共享实现，避免Client/sessiond语义漂移
Client Runtime：RuntimeSocket + SessionStore + correlation/lifecycle/protocol-wire；严格handshake/attach generation关联；连续eventId应用，gap/epoch/session不匹配触发reattach
恢复与去重：同epoch仅重发未确认commandId；epoch改变拒绝旧command歧义重发；getSnapshot只替换projection、不推进cursor
H1约束：运行中stop先发送并等待correlated interrupt（带有界超时）再stop；abort合并为最多1个in-flight；无大容量出站队列
UI：RuntimeProvider、连接状态、真实create/open入口、Composer send/abort、Transcript committed+partial；删除runtime stubs；无agent capability时诚实禁用
边界：Client生产代码只允许兄弟包@fffattiger/pix-protocol；新增可测试boundary rules
本地验证：architecture/build/typecheck/root tests/startup E2E/client+sessiond boundaries PASS；Client140/140、Host172/172、Protocol114/114、sessiond42/42、Adapter92、Contract75、Core3
残余：真实Browser→Host→Worker prompt/stream/abort留待R2与X1；stop帧当前optimistic fire-and-forget；createSession暂以projectRoot作为cwd
修复 commit：2368938（attach逻辑deferred跨generation稳定；attach failure恢复ready；one-shot断线明确reject并清理；stop先interrupt再等待可发送与ack，settle prompt；并发create busy reject；并发stop合并；pre-ack fail closed；WS URL根路径固定）
修复验证：Client149/149；client boundary、architecture、root typecheck、startup E2E PASS；Grok全仓tests PASS
独立验证 verdict：PASS（GPT复验；29/29对抗探针通过。首轮6项blocker全部关闭：attach failure可恢复、create跨reconnect原promise settle、one-shot无泄漏、prompt stop明确reject、stop发送/ack诚实且有界、并发create/stop去重；新增double-settle/deadlock/timer-Map leak/wrong-id stop ack探针均PASS。C1可标记DONE。）
```

## 14. X1 — Minimal Runtime E2E 记录

```text
实现 commits：34d2a3a + f711ab2
真实链路：Browser-like WS → Hono Host → sessiond RPC → R2 OS child → R1 worker-main/controller/mapper → test-only deterministic RuntimeFactory
场景：create→attach→prompt cumulative stream/delta projection；abort independent interrupt；Host restart/resume；epoch change；command/interrupt dedup与type conflict；双session隔离；cold attach；detach/stop/daemon orphan cleanup
压力：PIX_E2E_ROUNDS=5，5/5 PASS；最终projection严格Hello world；abort约1–2ms；每轮Worker PID清理
Capability：production full仅["agent"]，readonly=[]；sessiond up时health/bootstrap/handshake为agent，down时[]；不声明files/sessions/models
主线验证：runtime E2E5/5；完整build后startup E2E PASS且capabilities=["agent"]；Node tests718/718、Client149/149、Worker105、sessiond76、Host177、typecheck/architecture/boundaries PASS
残余：真实provider网络prompt不由确定性X1覆盖（A1/R1已有无网络SDK create与correlated failure smoke）；该项属于部署/provider验证，不阻塞M2
X1唯一GPT blocker 修复 commit：f87dea4（WS /v1/runtime handshake capability与HTTP动态投影一致：sessiond healthy=>["agent"]；down/unknown/probe error=>[]。SessiondRuntimeGateway增加可选异步capability resolver（静态capabilities作默认），每连接在合法hello后解析一次并烘焙连接专属handshakeResponse，resolver throw/reject时固定sanitized warn且fail-closed []；host-runner只创建一个createSessiondProbe同时驱动HTTP投影与gateway resolver。Host单测5项（healthy=>agent / down=>[] / throw=>[]+warn无泄漏 / 每连接一次+重复handshake不漂移 / 无resolver静态不变）；startup E2E真实回归PASS：sessiond up时WS ack [agent]，Host运行中down --all后HTTP health/bootstrap/capabilities全[]，新WS握手[]；fix后Runtime E2E3/3、全仓Node718+Client149、typecheck/architecture/boundaries PASS）。唯一blocker closed；X1保持IN_REVIEW待GPT最终验证
独立验证 verdict：PASS（GPT对修复HEAD `6746a51` fresh clone复验；原真实产品probe由sessiond-down WS `["agent"]`修正为`[]`；throw/reject无日志或ack泄漏；per-connection once、重复handshake稳定、多连接agent→[]、production 2s bound、startup/runtime E2E、LAN gate、全仓Node718+Client149全部PASS。X1 DONE；M2 DONE。）
```

## 15. M3 Wave 1 Checkpoint 记录

```text
First-run UX：94e6b81；首页增加绝对Project path入口与Open project，解除必须手写?cwd=的死路；Client149/149、typecheck/build PASS。
D1A-1：a38c3c8（来源pi-sdk-adapter旧sessions/sdk-data的只读子集，重建为领域独立模块）；公开@fffattiger/pix-pi-sdk-adapter/sessions；list/read/context/locate/resolveLeafId；仅SessionManager/getAgentDir + mapMessage；不含ModelRuntime/Agent/network/credentials/resources/trust；只识别pix-fork-provenance，旧custom generic；Adapter105/105、boundary/architecture/typecheck PASS。D1A-2 phase1：6acd4f5（原branch commit44e5b99）+ E2E fix3f75dc0；Protocol新增只读sessions token、list offset/limit bounds与context leafId；sessiond production默认真实Catalog/Locator且override优先；Runtime E2E显式注入ephemeral fixture locator，不再依赖production JSONL语义；Protocol114/sessiond81、startup/runtime E2E3轮、typecheck/architecture PASS。phase2剩Host/Client/0 Worker UI E2E。
D2-P0：c4a2f76 + fix 5a96fd4；worker.ready/rekey后sessiond主动worker.getSnapshot，以完整snapshot作为初始projection唯一权威，失败rollback；Client暴露runtime capability set/hasRuntimeCapability/typed sendCommand；未开放新command能力。GPT首轮PARTIAL复现两项：并发sendCommand覆盖pending导致首Promise挂起、inner snapshot.sessionId未校验；已修为第二条command明确session_busy且只发送一帧、inner/outer mismatch拒绝并rollback，并补rekey catch。GPT复验PASS：原F1/F2探针关闭、F3 catch确认、sessiond80、Client157、Runtime E2E3轮、startup E2E、build/typecheck/architecture/boundaries均PASS；D2-P0 DONE。
D3A-1：main commit 95ee707（原branch 1c7a848）；PIX_ALLOWED_ROOTS（unset=>cwd，bad config listen前失败）、local-only expansion、fixed-secret shared resolver、sessiond-backed worktree mutation/busy fail-closed、up/degraded四面capability、25MiB upload与真实startup E2E已完成。GPT独立安全验证PASS：roots/NUL/symlink/default、secret rotation degraded、write-before-mutation 503/force不可绕过、LAN deny、capability四面一致、Files/upload/watch/Git degraded可用、worktree正反控制、H1B回归均PASS；Host204、CLI32、全仓tests、runtime/startup E2E、typecheck/architecture/boundaries PASS；已集成main并删除远端功能分支。
协作规则：main checkpoint可供新任务基线；进行中分支不得假定已包含main后续commit，合并前必须rebase或由主会话解决冲突。
```

## 16. D2-P1 — Light Runtime Commands 记录

```text
实现：ed1b867（原branch577a1dd）+ hardening9bfaf68；生产capability精确prompt/abort/stats/session.rename，旧M2常量删除；Client typed helpers state/commands/last-text/stats/rename；SessionActions按runtime snapshot能力门控；rename command成功后fetchSnapshot，不写history catalog。
验证：GPT独立PASS；真实SDK exact-cap/no-network/未开放命令unsupported；Client correlation/singleflight/epoch/stop/wrong-result；UI rapid click/fetch失败/zero-cap/XSS；Runtime E2E5轮五命令链、restart/epoch/no orphan；集成main后全仓tests、build/typecheck/startup E2E/runtime E2E3轮、architecture/boundaries PASS。
Hardening：adapter非字符串/空rename返回invalid_input；UI rename maxLength=200；过时M2注释修正。
残余：历史catalog标题持久化/auto_name不在P1范围；thinking/model/tools/bash等仍关闭。
独立验证 verdict：PASS
```

## 17. D3A-2 — Files/Git 只读工作区记录

```text
实现：6972479 + canonical修复bb5aba2；集成merge9c71bcc。Client增加Files/Git辅助工作区，严格按negotiated files/git能力门控；无能力零请求，撤回能力隐藏旧内容；Files list/read/meta只读，Git status/diff只读，无上传/写入/shell/worktree mutation UI。
Canonical修复：root独立cwd list取得Host canonical path；目录进入和文件选择全部从canonicalCurrent构造；meta canonicalSelected用于范围检查；/tmp→/private/tmp根/子目录无误报；query key隔离stale response。
Host follow-up：a983cfd支持100% pure staged rename metadata（无@@ hunk也supported=true）。
独立验证：fresh clone真实npm ci；latest main+a983cfd与bb5aba2 clean merge；Client207/207、Host210/210、全仓tests、typecheck/build/boundaries PASS；真实Host canonical root/nested 9探针、stale A/B race、cap revocation、pure rename API均PASS。VERDICT: PASS。
集成验证：全仓build/typecheck/tests；startup E2E；runtime E2E3轮；architecture；Client/Host boundaries均PASS。一次startup 401来自主会话为公网临时创建~/.pi/pix.json密码，清理临时dev/sessiond/config后复测PASS，不是代码回归。
Worktrees只读列表：b79b54c。production full/degraded均广告`worktree`作为GET/list token；Workspace Dock增加Worktrees Tab，展示main/linked、branch/detached和AllowedRoot authorized状态。无create/delete/force/open/switch/promotion/session控件，不调用Client已有mutation helper。sessiond down时真实GET仍返回授权main worktree，POST仍在Git副作用前固定503。
验证：Client297/297、Host260/260、CLI46/46；Client/Host typecheck/build/boundaries、architecture与使用当前分支生产产物的Startup E2E PASS。隔离worktree依赖overlay仅用于验证并在提交前删除；30144未触碰。该只读节点按协作规则未单独启动verifier。
边界：`authorized`不等于pix-owned/managed/deletable；创建/删除、cwd切换、projectRoot协调和Host重启后trusted claim恢复仍后置，开放这些能力前需要重要节点verification。
产品优先级：当前UI仅要求可用、能力诚实、错误清晰；后续重心回到基础架构重构，不在本阶段投入视觉精修。
D3A Client error sanitization：39c07db。仅改四文件`packages/client/src/features/workspace/{GitPanel,FilesPanel}.tsx`与对应`.test.tsx`。GitPanel/FilesPanel此前在status/diff/list/read错误位直接渲染Host自由文本`error.message`（可能含绝对路径/secret/stack）。新增co-located固定文案helper并完全替换raw渲染：GitPanel`describeGitError(error,operation)`按code(CWD_REQUIRED/GIT_INPUT_REQUIRED/INVALID_PATH/INVALID_INPUT→invalid project path；PATH_FORBIDDEN/ROOT_REPLACED→outside allowed roots；PATH_NOT_FOUND)再按kind(network/timeout)，默认按operation区分`Unable to load git status.`/`Unable to load diff.`；FilesPanel`describeReadError`保留PREVIEW_TOO_LARGE/BINARY_FILE/NOT_FILE/PATH_NOT_FOUND固定文案但默认改固定`Unable to read file.`且不再拼`${error.message}`、补network/timeout，新增`describeListError`(CWD_REQUIRED/INVALID_PATH/INVALID_INPUT、PATH_NOT_FOUND、NO_ALLOWED_ROOTS、PATH_FORBIDDEN/ROOT_REPLACED、network/timeout、default)。文案与既有WorktreePanel/Catalog helper同构（code-first→kind→固定fallback）。无新公共模块，不改请求/capability/cache/mutation/CSS/API/protocol。
验证：定向GitPanel27/27+FilesPanel16/16、Client全量401/401、typecheck/build/boundaries(82 files)/architecture PASS、`git diff 35950f5..HEAD --check`与`rg 'error\.message|error\.body|error\.cause'`两生产文件均零命中。新增参数化code/kind矩阵与含绝对路径+secret的no-leak集成用例（status/diff/list/read），保留既有retry/selection/navigation测试。仅Client四文件、低风险Client-only只读copy hardening，按协作规则未单独启动verifier。
```

## 18. D1A-2 — 只读历史会话链记录

```text
实现：5570d69；合入最新main13499e4；error hardening429274f；最终merge43d390a。Host GET /v1/sessions、/:id、/:id/context；sessions capability仅sessiond healthy时存在；Client deep-link只读历史不自动attach，显式Continue live才启动Worker。
0 Worker：真实JSONL list/read/context/deep-link/missing404前后runtime.listRunning为空且无子Worker；Continue live唯一启动路径；sessiond down后四端capability撤回且route固定503。
Error边界：Adapter plain RuntimeError在sessiond RPC由toBoundaryProtocolError受控映射；known code固定消息/retryable，raw message/cause/details丢弃；unknown/malformed/raw Error固定internal。真实missing read/context为404 SESSION_NOT_FOUND，不回显id/path/endpoint/secret/stack。分页仅canonical unsigned decimal，拒绝1e3/0x10/sign/decimal/whitespace/leading-zero。
验证：GPT首轮除真实404映射外全部PASS；修复后fresh re-verification PASS。集成后全仓build/typecheck/tests、startup、runtime E2E3轮、sessions E2E、architecture、sessiond/host/client/adapter boundaries均PASS。sessiond90、Host225。
D1B-1 Thinking展示：723fac4。Session JSONL已有assistant thinking block，Client将History、live completed与streaming partial统一投影为稳定顶级row内的有序parts；Thinking使用原生details/summary纯文本展示，streaming默认展开且允许手动折叠，completed默认收起；空thinking省略，HTML按文本转义；不调用未挂载`/thinking` endpoint，selected B不显示attached A的live thinking。
验证：Client281/281、定向37/37、typecheck/build/boundary/architecture PASS；无Protocol/Adapter/sessiond/Host改动，无新capability、写入或Worker激活，按协作规则未单独启动verifier。
D1B-2 Bash展示：83a3859。History bashExecution与live `snapshot.state.bash`统一投影为专用bash row，显示command/output/exit/cancelled/truncated；空输出固定`(no output)`，live状态行固定`row:state:bash`，snapshot替换后稳定恢复。`fullOutputPath`从view-model和DOM隔离，`excludeFromContext`不隐藏用户可见记录；不新增bash output API，不发runtime.bash/abort命令。message与state无共享execution ID，因此冻结为绝不猜测去重：可能重复显示，但不吞掉不同执行。
验证：父审查修复危险位置去重后，定向71/71、Client314/314、typecheck/build/boundary/architecture PASS；仅改Client六文件，无新capability/Host路由/执行能力，按协作规则未单独启动verifier。
D1B-3 visible-branch export：665e31a。仅selected history且sessions capability可用、selection不匹配attached live时显示；复用SessionContext query，在Client本地导出`pix.visible-branch` v1 normalized JSON，不调用export/raw/thinking/bash-output endpoint，不启动Worker或发送Runtime命令。输出只含当前可见branch；entry顺序和parent关系保留，image变placeholder，Bash role固定`bashExecution`，`fullOutputPath`和非白名单字段省略。JSON边界仅接受primitive/array/plain或null-prototype object；cycle、accessor、Date/Map/Set/RegExp/class instance及Proxy trap均固定失败且不泄漏raw error；共享引用允许独立复制，own `__proto__`/`constructor`安全保留且零原型污染。Object URL remove/revoke/schedule清理never-throw；busyRef跨macrotask；A→B晚到context不改变B导出。
验证：父会话复核实现与race/security tests；Client354/354、typecheck/build/boundary/architecture、architecture gate tests19/19、diff-check PASS。仅Client七文件，无新capability、Host route、持久化、权限或执行边界，按协作规则未单独启动verifier。
D1B-4 Sidebar 只读会话元数据：1a5d28f。仅改`packages/client/src/components/shell/Sidebar.tsx`并新增`Sidebar.test.tsx`。Sidebar行在保留title(`Untitled session` fallback)与完整`sessionId`之外，补齐`formatCwdLabel(session.cwd)`短标签、活动`<time dateTime>`(fallback updatedAt→lastMessageAt→createdAt，undefined/不可表示候选跳过、绝不渲染Invalid Date)、`messageCount`(含`0 messages`与单数`1 message`)，以及仅在`parentSessionId`存在时显示`Fork`(只有forkPointEntryId不推断、不标注root)。Honesty修复：`canBrowseSessions===false`时可见列表、loading、error、empty提示全部依capability fail-closed，缓存/陈旧loading/晚到in-flight响应均隐藏；query仍`enabled:canBrowseSessions`故不发请求。继续用`createQueryOptions(http).sessions.list(search.cwd)`/`canBrowseSessions`/`formatCwdLabel`，服务端顺序与Link search语义不变，不新增API/schema/capability/query/mutation/Worker/WebSocket/runtime，不改CSS（复用`.session-row*`/`.sidebar-hint`）。
验证：定向14/14覆盖无cap零fetch、加载后撤回缓存隐藏无新fetch、pending撤回晚到不可见、完整元数据、0/1 messages、缺省/untitled/无undefined|null|Invalid Date、三层时间fallback与不可表示跳过/省略、Fork条件、cwd query编码与Link search语义、A→B cwd晚到不覆盖、只读仅GET /v1/sessions list；Client368/368、typecheck/build/boundary/architecture/diff-check PASS。仅Client两文件、低风险Client-only只读节点，按协作规则未单独启动verifier。
D1B-5 Transcript history capability fail-closed：5244e44。仅改`packages/client/src/components/transcript/TranscriptList.tsx`并补`TranscriptList.test.tsx`。history/non-live路径在`!isLive && !canBrowseSessions`时fail-closed：rows useMemo不再从`context.data`/缓存派生任何rows（返回空数组），晚到的in-flight成功响应也不恢复历史；空状态改用诚实文案`Session history unavailable until the runtime connects.`（与Sidebar.tsx完全一致），复用`.transcript-empty`，不显示陈旧loading/error/No messages。fetch沿用既有`enabled`(rowsProp===undefined && Boolean(sessionId) && canBrowseSessions && !isLive)，无cap时零`/context`请求；capability恢复保持既有React Query行为，无手动清cache/removeQueries或新增请求链。live路径完全不受影响（isLive分支在`!canBrowseSessions`判定之前）：sessions cap缺失时live仍按live state显示且不出现history-unavailable文案。有cap+empty仍显示`No messages`，有cap+error/loading保持既有语义；readonly banner仅在with-cap history路径保留。不改history/live去重、thinking/bash投影、row model、排序或selected-session语义。
Hardening 65c33c0：empty-state capability分支仅在`rowsProp===undefined`时生效（保持live优先），显式prebuilt rows不是sessions history，故无cap时只显示rows、不叠加history-unavailable/No messages也不fetch。
验证：定向29/29覆盖true→false撤回(同QueryClient缓存立即隐藏+unavailable+无新fetch)、pending撤回晚到成功不显示、初始无cap零context fetch+unavailable非No messages、有cap+empty No messages、live=true无sessions cap live消息正常且不fetch context、explicit rows无cap只显示rows无overlay不fetch、现有history回归；Client375/375、typecheck/build/boundary/architecture/diff-check PASS。环境说明：worktree交付缺node_modules，`tsc -p packages/protocol`在基线b6bea16即复现`Cannot find module 'zod'`/`structuredClone`/implicit-any(环境阻塞，非代码)；symlink同commit main的node_modules后基线与with-changes的typecheck/build均PASS。仅Client两文件、低风险Client-only只读节点，按协作规则未单独启动verifier。
边界：testing子路径仅E2E使用；SDK import仍限adapter internal；D1B-3不是archive、all branches或raw JSONL导出。
独立验证 verdict：D1A PASS；D1B-1/2/3/4/5为低风险Client-only节点，由父审查与门禁验收
```

## 19. D3B-R1A/R1B — 只读 Domain Catalog 与 Host API 记录

```text
D3B-R1A main：773d3f2
范围：Runtime Core Model/Credential/Resource/Trust read ports与mutation ports分离；Protocol只读capability tokens；pi-sdk-adapter独立models/credentials/resources/trust子路径。
安全不变量：显式canonical cwd/agentDir；离线零网络；读操作零写入；不返回credential material；不执行Extension；unknown/denied Trust隐藏项目资源；禁止聚合sdk-data。
关键修复：modelsPath绑定注入agentDir；clean env确定性；损坏trust fail closed；null credential不阻断后续provider；Skill file与skills根目录同时做lexical+realpath containment，阻断项目/全局符号链接逃逸。
验证：Runtime Core 7/7；Protocol 116/116；Contract 75/75；Adapter 164/164（正常与clean env）；全仓门禁和Startup/Runtime/Sessions E2E PASS；独立安全验证PASS。

D3B-R1B main：4668658
范围：Host-mounted只读GET API：models、auth providers/status、skills、plugins、commands、trust；CLI生产composition挂载四个Adapter子路径；Catalog capability在sessiond full/degraded状态下诚实保留。
边界：Host foundation只接protocol-independent unknown seams；只有Host composition允许精确导入adapter/models、credentials、resources、trust；无adapter root、runtime-core或Pi SDK直接依赖；缺Port不注册路由也不广告token。
路径：所有项目级API强制?cwd=，通过AllowedRootService authorizeExisting(directory)后仅把canonical path传给Port；relative、out-of-root、symlink escape与ROOT_REPLACED均fail closed。
安全修复：Trust isTrusted/forCwd/list/projection统一固定503边界；Host严格字段投影，移除apiKey/token/path/stack/sourceInfo与额外字段；Trust reason固定；Proxy/getter/cyclic/toJSON异常不进入通用500日志；Capability override按实际挂载校正；显式空PI_CODING_AGENT_DIR拒绝；稀疏Catalog数组拒绝而非wire null。
验证：Host 256/256；CLI 46/46；Host boundary/architecture/typecheck PASS；Startup/Runtime/Sessions E2E使用当前生产CLI dist全部PASS；独立对抗套件28/28 PASS；30144未触碰且保持健康。
D3B-Client main：f9151b7 + 4b1e9d9 + 9603aa8 + 8001fa4
范围：Client严格只读Catalog API与query options；独立右侧Catalog Dock；Models/Providers/Skills/Plugins/Commands capability-gated Tabs；Sidebar与Dock内只读Trust状态；与Files/Git Dock双向互斥。
读取语义：项目Catalog必须有cwd；无capability、Dock关闭或无cwd时零隐藏请求；Provider列表为全局读取并按provider并行status；query key按cwd/providerId隔离，A→B迟到响应不覆盖当前项目；capability撤销关闭Dock，恢复后不自动重开。
安全边界：删除旧Catalog Mutation/OAuth Client调用面与UI控件；Host body/path/secret/stack只映射为固定错误文案；Provider单行失败隔离；Trust响应自由文本reason不渲染；越界expiresAt不显示Invalid Date；严格schema拒绝旧Next shape和额外字段。
验证：独立验证PASS；Client268/268、Host260/260；Client typecheck/build/boundary、root architecture、production CLI/Client build及Startup/Runtime/Sessions E2E全部PASS。E2E使用随机端口与临时PI_CODING_AGENT_DIR，未触碰30144或真实Agent配置。
D3B结论：端到端只读链DONE。OAuth、配置写入、安装、reload、Trust设置和Extension执行不在本切片范围。
```

## 20. 后续迁移时必须记录的校验

每个包迁移时补充：

```text
来源绝对路径：
来源 commit：
来源 tree hash：
迁移后 pix tree hash：
有意修改文件：
排除文件：
验证命令及结果：
迁移 commit：
独立验证 verdict：
```

若迁移后 tree hash 不同，必须逐项说明差异，不能只写“适配新仓库”。

## 21. sessiond 特别保护

`packages/sessiond` 是唯一没有提交保护的重构成果。迁移前不得清理旧 worktree。

允许迁移：

```text
packages/sessiond/package.json
packages/sessiond/scripts/**
packages/sessiond/src/**
packages/sessiond/test/**
packages/sessiond/tsconfig.json
packages/sessiond/tsconfig.test.json
```

禁止迁移：

```text
packages/sessiond/dist/**
packages/sessiond/dist-test/**
packages/sessiond/node_modules/**
packages/sessiond/**/*.tsbuildinfo
```

迁入 `pix` 后视为候选实现，重新进行：

- 代码审查
- typecheck
- unit/integration tests
- RPC 安全检查
- single-instance/lock/socket 生命周期验证
- 独立 verification

## 22. 旧结果可用性摘要

### 可复用

- Runtime Core Ports 与规范模型
- Runtime contract test harness
- Protocol v1 schema 与 fixture
- Hono security/gate/static/server 基础
- Vite Client shell 和 typed HTTP 基础
- sessiond service/RPC/journal/attach 候选实现
- Pi SDK Agent Adapter 候选实现

### 不能直接宣称可用

- 整个旧 `refactor/architecture-v1` 产品树
- 旧根 workspace/lockfile
- 旧 Next CLI
- Host Runtime WS seam
- Client Runtime stub
- sessiond daemon/composition
- 真实 Worker process factory
- Agent Worker
- 完整产品启动链

## 23. 完成条件

迁移阶段完成必须同时满足：

1. 所有活动代码在 `pix`。
2. 旧 worktree 不再承载新的功能开发。
3. `pix` 根无 Next 产品路径。
4. 每个迁入包有来源记录和重验结果。
5. M1 Startup E2E 通过。
6. 旧 worktree 在确认备份策略前仍不删除。

## 24. 命名决策（历史证据说明）

产品命名已一次性统一为 `pix`（决策 `N-009`）：npm 包 `@fffattiger/pix-*`、CLI `pix`/`pix-host`/`pix-sessiond`、env `PIX_*`、运行目录 `~/.pi/pix/sessiond`。生产代码、manifest、CLI、服务字段、env、PWA/UI、测试与当前文档均不再使用旧品牌名，也不提供兼容 alias。上游 Pi SDK 概念保持原名：`@earendil-works/pi-*`、`PI_CODING_AGENT_DIR`、`~/.pi`、`packages/pi-sdk-adapter`。

本台账上方出现的旧名（如仓库路径 `/Users/proxy/Documents/program/pi-web`、worktree 根 `pi-web-worktrees`、来源子路径 `bin/pi-web.js`、旧包名 `@fffattiger/pi-web-*`、来源 commit 与 tree hash）属于迁移来源的**历史证据**，按要求原样保留，用于追溯来源与审计；它们不代表当前产品命名。架构门禁 `no legacy product name` 明确排除本文件，使这些历史路径可作为证据留存。

## 25. sessiond production cold-open activation cwd fix 记录

```text
实现：8086770（branch fix/sessiond-activation-cwd，base b9374e6）
范围：仅 packages/sessiond/src/composition/daemon.ts + packages/sessiond/test/daemon.test.ts。不新增 Adapter API、不改 Protocol/Host/Client/sessiond service/application/rpc/worker-process/e2e/package-lock。

缺陷：production composition buildDependencies 的默认 catalog/locator 已用 Pi SDK 只读 JSONL（createPiSdkSessionCatalog/createPiSdkSessionLocator），但 activationContext 仍默认 createStubActivationContext()，无 requestedCwd 时返回 /workspace。Client Continue live cold-open 不传 cwd，导致 Worker 在错误项目启动。

修复：新增私有 createCatalogActivationContext(catalog)，复用 buildDependencies 里同一个 SessionCatalogPort 实例作为默认 activation resolver——
- 显式 requestedCwd：仅 undefined 表示缺失（RPC NonEmptyStringSchema.optional 已在 schema 层拒绝 blank/空串，无 truthiness 误判），保持 cwd=projectRoot=requestedCwd 既有语义，不扩大验证边界。
- 无 requestedCwd：catalog 必须存在（null/missing 抛固定 SessiondError(unavailable, "session catalog is unavailable") fail closed，绝不回退 /workspace 或 process.cwd）；catalog.readSession(sessionId) 返回的 cwd/projectRoot 必须为非空绝对路径（node path.isAbsolute，拒绝空/NUL），否则抛固定 SessiondError(internal, "session catalog returned an invalid cwd|projectRoot") 且不回显值；不 realpath（历史 cwd 可能当前不存在，Worker/SDK 负责 open 语义）。
- catalog 抛出的 structured RuntimeError not_found 由既有 toBoundaryProtocolError 映射为固定 "session not found"，不泄漏 id/path/secret，worker 零启动。
- options.activationContext override 优先级不变；options.sessionCatalog（含 null）同时控制默认 resolver：注入 fake catalog 可测试，null+无 activation override 时 activation fail closed，显式 activation override 时 null catalog 仍可工作。
- sessions.resolve 与 runtime.activate 共用同一 resolver 语义（sessions.resolve 零 worker）。
- 移除 daemon.ts 对 stubs 的 import（production 不再默认 stub）；createStubActivationContext 仍从 composition 导出作为测试 stub。

验证（worktree 临时 symlink main node_modules，已删除）：
- sessiond typecheck：PASS（tsc tsconfig + tsconfig.test --noEmit）
- sessiond tests：134 total：133 pass + 1 Windows skip，0 fail（基线 126 + 新增 7 个 daemon 级 RPC 用例）；daemon.test.js 15/15
- sessiond build：PASS；sessiond check:boundaries：PASS；root check:architecture：PASS
- git diff b9374e6..HEAD --check：PASS
- test:e2e:startup：本机未能复跑——根 build 在 packages/host/src/routes/files.ts 存在 base b9374e6 即复现的预存编译失败（Node v24.18.0 与 @types/node/lib 类型不匹配；父会话用同样 Node v24.18.0 + main node_modules 复现相同 host files.ts TS errors，确认 base/environment blocker）。host 不在本任务范围，无法补齐 CLI 产物，属环境/基线阻塞，非本次改动引入。

残余风险：catalog 是 runtime-core port，其具体实现（Pi SDK JSONL store）返回的 cwd 假定为绝对路径，composition 已防御验证。root build/Startup E2E 在当前 Node v24.18.0 + @types/node 组合下被未修改的 Host `files.ts` 类型错误阻塞；Grok 独立确认 candidate/base Host blob 相同，属于基线覆盖缺口。
独立验证 verdict：PARTIAL（Grok；候选范围无 F1/F2并明确建议合入。独立复验 daemon 15/15、sessiond 134 total=133 pass+1 Windows skip、真实 Pi SDK catalog production probe、并发cold-open 1 read/1 worker、null/malformed/not_found零worker与错误净化、typecheck/build/boundary/architecture/diff-check均PASS；唯一缺口为上述base Host构建阻塞导致Startup E2E不可运行。）
```

## 26. 实现模型说明

本分支实现模型按用户要求使用 DeepSeek，全部实现、测试与文档更新在独立 worktree `fix/sessiond-activation-cwd` 完成，未改 main、未新建其他 worktree、未 merge/push。

`fix/host-node24-file-types` 分支同样按用户要求使用 DeepSeek 实现，全部实现、测试与文档更新在独立 worktree 完成，未改 main、未新建其他 worktree、未 merge/push。

## 27. Host files route Node v24 / @types-node 类型兼容 fix 记录

```text
实现：785c88a（branch fix/host-node24-file-types，base 2cfa98a）
范围：仅 packages/host/src/routes/files.ts + packages/host/test/resources.test.mjs。不改 package.json/package-lock/tsconfig/依赖、AllowedRoot、Host middleware/security、Protocol/Client/sessiond/Adapter/E2E 源码。未用 any / as unknown as File / 未关 strict。运行时与安全语义不变。

缺陷（base 2cfa98a 即复现，Node v24.18.0 + @types/node 22.20.1，此前阻塞 root build 与 Startup E2E）：
- files.ts ~line103：fs.ReadStream `data` 回调显式 `Buffer` 过窄，@types/node 现声明 `string | Buffer<ArrayBufferLike>`，TS2345。
- files.ts ~line191：global/Node/undici `File` 名义类型冲突（buffer.File 与 undici File 的 `[Symbol.toStringTag]` 不一致），`value is File` 谓词非法（TS2677），后续 name/size/arrayBuffer 无法收窄（TS2339）。

修复：
- Stream：`createReadStream({ ..., encoding: null })` 明确 Buffer 模式（类型安全，兼容 Node24 声明，运行时为默认行为）；`data` 回调类型改为 `string | Buffer`，string 用 TextEncoder 按 UTF-8 编码（绝不走 UTF-16 数值路径），Buffer/Uint8Array 用 `new Uint8Array(chunk)` 拷贝入队——只覆盖逻辑字节，不暴露底层（可能池化）ArrayBuffer 的 byteOffset/byteLength 之外。end/error/cancel、fd close、range content-length 语义不变。
- Upload：不依赖冲突的名义 global File。定义最小结构接口 UploadFile（name:string, size:number, arrayBuffer():Promise<ArrayBuffer>，type 字段不需要）；guard 入参类型直接用 FormData#getAll 的实际 union（`ReturnType<FormData["getAll"]>[number]`），谓词类型为 `UploadFormEntry & UploadFile`（可赋值于入参 union，规避 TS2677）。fail-closed 结构校验：排除 string、name 为 string、size 为 finite 非负 safe integer（Number.isSafeInteger 且 >=0）、arrayBuffer 为 function。不用 instanceof File（名义、跨 realm 更脆弱）；恶意任意对象被拒绝（parser 只给 string/File，guard 仍 fail closed）。writeUploadedFile 改收 UploadFile，authorizeChild/duplicate/size/total/conflict/skip/O_NOFOLLOW/O_EXCL/0600/atomic temp+rename 语义不变；total 加法安全（既有 max 限制足够，未扩展功能）。错误文案未改动。

验证（worktree 临时 symlink main node_modules，已删除）：
- Host build/typecheck：PASS；Host check:boundaries：PASS（38 files）
- Host tests：263 total，0 fail（基线 260 + 新增 3：同名 non-file text 字段被忽略且真实 File 成功字节级一致、仅 text field => NO_FILES、raw/range 流式非 ASCII/multibyte 二进制字节一致）
- root build：PASS（全 workspace）；root typecheck：PASS；root check:architecture：PASS
- git diff 2cfa98a..HEAD --check：PASS
- test:e2e:startup：候选构建后本机可跑。raw 环境 3/3 复现 401（/v1/capabilities，gate enabled）——根因是本机 `~/.pi/pix.json`（2026-08-12 写入，仓库外）配置 auth.password+disabled:false，属基线/环境阻塞，与本次改动无关（gate/auth/security 源码与 base 逐字节一致；E2E 失败路径在首个非公开路径 fetch 即停，files.ts 未执行；直连探针：health/bootstrap 200、capabilities 无 cookie 401、gate/status 报 enabled、真实密码登录后 capabilities 200）。按文档化 env override 使环境回到 E2E 假定的无 gate 状态：`PIX_AUTH_DISABLED=true npm run test:e2e:startup` PASS 2/2（{"ok":true,...,"wsMaxUpload":26214400}）。未绕过认证、未改 E2E/gate/security 源码。

残余风险：本机 `~/.pi/pix.json` 存在已启用 Gate，raw Startup E2E 需在干净（无 gate）环境才能直接 PASS；实现层对 ReadStream 的 string 分支为防御性（encoding:null 下运行时恒为 Buffer），Buffer路径已由字节级用例覆盖。
独立验证 verdict：PASS（Grok；无 F1/F2，建议合入。独立复现base在@types/node 22.20.1的TS2345/TS2677/TS2339，candidate在22/25均编译；Host263/263、boundary/architecture/diff-check、二进制70KiB raw/range/suffix/416、multipart string/File/duplicate/overflow/arrayBuffer rejection/symlink/0600/temp cleanup/no-leak对抗均PASS；`PIX_AUTH_DISABLED=true` Startup E2E 2/2 PASS。父会话另以官方worktree依赖完成root build、9 workspace官方tsconfig等价typecheck与Startup E2E 2/2。）状态 DONE。
```

## 28. D2-P2 — Runtime Thinking Control 记录

```text
实现：source 79e2e1a1b578930709e9487992e651bc7deffbbb（branch integrate/d2p2-thinking-control，base 4b316b18ea1272336109613d658c9355fc4b2390，cherry-pick 后 integration HEAD 76f7c1b）+ hardening 940610a（仅 tests/e2e/runtime.mjs）。实现模型：DeepSeek。
范围：原则上仅 source commit 15 文件 + docs。source 15 文件与 base ef246e9..main 最近 16 提交零文件重叠（实测 comm -12 为空），cherry-pick 无文本冲突；语义审查与验证如下。未改 Host files/daemon、Sidebar/Transcript/Files/Git、trusted roots、package-lock/Protocol/runtime-core；未新增 Protocol command（set_thinking_level 已存在，runtime-core 已映射 runtime.thinking.set）。

能力面（Adapter）：PRODUCTION_AGENT_CAPABILITIES 精确新增 `runtime.thinking.set`（保持 prompt/abort/stats/session.rename，model/tools/bash/fork/extension-UI/queue/reload/auto_name 仍关闭）；adapter `set_thinking_level` 实现：level 白名单与 Protocol ThinkingLevelSchema 一致（off/minimal/low/medium/high/xhigh/max，adapter 侧硬编码不引入 SDK 类型），未知 level 返回 invalid_input，成功置 thinkingPinned=true/pinnedThinkingLevel，错误不泄漏 SDK raw；`requiredCapabilityForCommand`（runtime-core）门控 set_thinking_level→runtime.thinking.set，production 面允许执行。

sessiond（service.ts）：set_thinking_level 走普通 command admission（acceptedCommands 同 commandId 去重/type 冲突、commandResultLimit 容量、commandTimeoutMs 超时、worker crash/stop 时 rejectPending）。成功帧不直接缓存/返回——经 per-commandId singleflight ensureThinkingAuthorityFinalized 先执行有界 worker.getSnapshot 刷新，投影收敛后才发布终态成功（sessiond projection 是 attach/resume 权威，wire runtime_state_changed 仅为 signal）；refresh 失败 fail-closed：所有 observer 收到同一固定 ok:false unavailable（type 仍 set_thinking_level、同 commandId、固定文案无 raw transport），并缓存避免重发/伪成功。worker.commandResult 新增三重匹配（wire id + 内层 commandId + result.type 全部一致才接受），malformed/late/wrong-id 帧被丢弃且不清 timer/pending/缓存、不触发 finalization；post-await 缓存增加 record/epoch 所有权守卫（rekey/stop 期间不跨 epoch 写）；rekey 清 thinkingAuthorityFinalizations；isBusy 计入 finalization 使 cwd busy 临时为真。非 thinking 命令不额外发 getSnapshot（普通 rename 用例验证零多余刷新）。

Client（session-store/runtime-provider）：setThinkingLevel 走 runTypedCommand→sendCommand 单 inflight 通道（sessionId+generation 绑定，session_busy 诚实、unsupported_capability 诚实、late/stop 不污染）；success 后 UI fetchSnapshot 观察权威 thinkingLevel/thinkingLevelPinned。

UI（SessionActions）：仅 selection 匹配 attached live（live!==false）且 runtime snapshot 广告 runtime.thinking.set 时显示；level 选项来自 Protocol ThinkingLevelSchema.options（非硬编码假支持）；current/pinned 元数据来自 authoritative snapshot；错误固定文案 `Failed to update thinking level.` 不渲染 raw ProtocolError.message；aria-label/role/aria-live；busy 单飞禁用、mounted/selection/requestGen 三守卫使 unmount/A→B/live true→false 的晚到 settle fail-closed（不发 getSnapshot、不写旧状态）；render 时零命令。fake-worker/e2e fixture 仅测试注入，不影响 production capability 来源。

验证（本机 Node v24.18.0，PIX_AUTH_DISABLED=true 运行 E2E）：
- 定向：Adapter production-smoke+public-surface、sessiond 新增 9 thinking/malformed/late 用例、Client SessionActions 15 + session-store 43 全 PASS。
- 分包全量（root `npm test` runner 在此机 stall，见 §29）：protocol 116/116、runtime-core 7/7、runtime-contract-tests 75/75、adapter 164/164、sessiond 146/146（1 Windows-only skip）、agent-worker 105/105、host 263/263、cli 46/46、client 411/411（基线 401 + 新增 10）。
- root build EXIT 0；root typecheck（run-workspaces typecheck）EXIT 0；check:architecture PASS；check:boundaries：client 82 files / sessiond / adapter / agent-worker 全 PASS。
- test:e2e:runtime（真实进程链，注入 no-network fixture）：2/2 轮 PASS，含 create→attach→prompt、abort、host restart/resume、epoch change（stop→cold attach 经 catalog）、commandId at-most-once、isolation、cold attach、D2-P1/D2-P2 light commands（get_state/commands/last-text/stats/rename + set_thinking_level→snapshot 权威→detach/reattach pin 持久→closed caps：set_model/set_tools/reload/set_auto_retry unsupported_capability）、shutdown 无孤儿。
- test:e2e:startup PASS；test:e2e:sessions PASS。
- git diff 4b316b1..HEAD --check：PASS。

base/candidate 对照与 pre-existing blocker：Runtime E2E scenarioEpochChangeNoAutoResend 在 base 4b316b1 与 candidate 均一致失败（stop 后 cold attach `not_found`）——非 D2-P2 回归。根因：主线 8086770 将 production cold-open activation 改为从 catalog.readSession 派生 cwd/projectRoot，而 E2E fixture 会话仅存内存不持久化 Pi JSONL，startDaemon 又未覆盖 sessionCatalog（沿用 production Pi SDK JSONL catalog）→ readSession not_found。按协作规则仅修复 D2 source 范围内的 tests/e2e/runtime.mjs（hardening 940610a）：注入与既有 fixtureLocator 同一内存注册表的 fixture sessionCatalog 覆盖（RuntimeWsClient.create 记录每会话 cwd/projectRoot，readSession 返回；未知会话抛 canonical RuntimeError 形 not_found 由边界净化）。未改 sessiond daemon/gateway/resolver、未放宽 not_found、未回退 /workspace。resolver 语义不变（仍读 catalog.readSession）。

残余风险：root `npm test` 单命令 runner 本机 stall（~20 分钟 0% CPU，日志停在 pi-sdk-adapter build:deps），以分包顺序等价覆盖替代并记录（§29）。E2E fixture catalog 为内存合成（与既有 fixtureLocator 同构），仅测试路径；生产 catalog 仍为 Pi SDK 只读 JSONL。set_thinking_level 的模型档位上限（真实 SDK 对模型 clamp）由 Adapter production-smoke 以 minimal 档覆盖，未在 E2E 断言具体绝对档位。

独立验证 verdict：PASS（DeepSeek；无 F1/F2，建议合入）。独立确认 scope/architecture/Adapter/sessiond/Client/UI/E2E hardening 均符合契约；root `npm test` 本次完整 EXIT 0（1377 workspace tests + Client 411），root build/typecheck、architecture/boundaries、Runtime E2E 2轮、Startup E2E、Sessions E2E 全 PASS。另设计三组实现测试之外的对抗 probe：post-command snapshot sessionId mismatch 固定 unavailable 且不伪 pin；rekey during finalization 不跨 epoch 写且可在新 epoch 重新 admission；finalization 持有期间并发 get_commands 1ms 完成、前后投影诚实且无死锁——全部 PASS。确认 hardening `940610a` 真实经过 daemon `catalog.readSession`，unknown session 仍 canonical not_found，registry 每轮清空且仅测试使用。实现阶段 root runner stall 属非确定性环境/并发争用，不是稳定 runner 缺陷。状态 DONE。
```

## 29. D2-P2 实现模型与集成验证说明

本分支实现按用户要求使用 DeepSeek，全部实现、测试与文档更新在独立 worktree `d2p2-thinking-integration` 完成（branch `integrate/d2p2-thinking-control`），未改 main、未新建其他 worktree、未 merge/push。

root `npm test` runner 本机实测 stall：`npm run test` 触发的 `node scripts/run-workspaces.mjs test` 进程链在约 20 分钟内 0% CPU、无进展（/tmp/root-test.log 与 runtime-contract dist mtime 停在同一时间点），已按协作规则终止该任务启动的进程树（未触碰其他 worktree / 30144）。为获得等价覆盖，改为按 workspace 顺序逐一运行官方 `npm run test --workspace <pkg>`（protocol/runtime-core/runtime-contract-tests/adapter/sessiond/agent-worker/host/cli/client 均各自 prebuild→build:test→官方 node --test/vitest），结果见 §28。typecheck 经官方 `run-workspaces.mjs typecheck` 单跑 EXIT 0（等价 9 workspace 官方 tsconfig）。该 stall 与本次改动无关（包测试、build、typecheck、E2E 全部独立 PASS），但已诚实记录，避免误报 root 全量通过。

## 30. D3A-Files-Search-UI — Client 文件搜索 记录

```text
实现：DeepSeek；独立 worktree d3a-files-search-ui，branch feat/d3a-files-search-ui，base main@4f508b1a52c014fa060be17f7381fa364c77849f。纯 Client 只读切片，未改 Host/Protocol/runtime/sessiond/adapter/package-lock/D3A-P0；实现阶段未改 main、未 merge/push、未另建 worktree。状态 DONE（Fresh DeepSeek 独立验证 PASS）。

背景/勘察：Host `GET /v1/file-index?cwd&q` 已 production 挂载，files capability 覆盖；带 q 返回 `{matches:[{path,isDir:false}],truncated}` cap 200（`node_modules`/`.git`/dist 等忽略，git ls-files 优先），q 空返回 legacy `{files}` 全量 shape（Client 永不带 q 请求）。Client 的 schema/resources/urls/queryKeys/options 均已存在（`FileIndexResponseSchema` union、`urls.files.index`、`queryKeys.files.index(cwd,q)`、`options.files.index` 已透传 signal）。真正缺口只在 Client FilesPanel 与安全 relative path helper。

新增 `joinRelative(root, rel)`（paths.ts，纯函数）：接受 Host 相对 POSIX file path（如 `sub/a.ts`），逐段拒绝空/`.`/`..`/NUL/反斜杠/绝对/重复/尾斜线，结果用既有 normalize（stripTrailing+normalizeSeparators）与 isWithinRoot 复核保证落在 canonical root 内；不用 URL/path 库避免平台差异。Host `isDir:false`，只处理文件。

FilesPanel 搜索集成（冻结交互）：
1) breadcrumbs/内容上方 compact search form：`<form role=search>` + `<input type=search aria-label="Search files">`；无动画/transition:all，仅复用现有 focus/hover 语言（focus-visible outline var(--accent)、hover bg-hover），touch 目标 min-height 30px。
2) raw 本地 state；trim 后 ≥2 字符才可能请求；250ms debounce（`window.setTimeout` + effect cleanup）。空 → 目录浏览；1 字符 → 固定提示 `Type at least 2 characters to search.` 进入 search mode；清空恢复目录浏览且 currentDir 保留（当前目录 query 不因搜索变化）。
3) query 只用 `options.files.index(cwd, debouncedQuery)`，额外 `enabled: canFiles && Boolean(root) && debouncedQuery.length>=2`；queryFn signal 保留（TanStack key `[pix,files,index,cwd,q]` 隔离 cwd/q）。cwd 切换立即清 raw/debounced/selected/current（既有 reset 扩展），debounce timer 由 effect cleanup 拆除。capability 撤回整面板早退（零请求/结果不可见）+ 单独 effect 清 raw/debounced/selected，恢复不闪旧结果。
4) 渲染只引用当前 debounced query：`querySettled = raw.trim() === debouncedQuery`；raw 变化时立即隐藏旧结果（显示 Searching…）避免 250ms 旧 q。迟到 q1 结果靠 key + data 隔离，绝不显示为 q2。
5) 结果列表 `ul`+buttons（非伪 listbox，无箭头键声称，原生 Tab/Enter/Space），每个 button 显示 relative path、title 同 relative path（不暴露绝对 root）；`aria-live=polite` 状态区报告 Searching…/No matches found./N matches found./Results truncated。点击先 `joinRelative(root, match.path)`，null → 固定 `Invalid search result.`（role=alert，不发 meta/read）；valid → `setSelectedFile(joined)` 复用 meta/read preview。capability 撤回零请求。
6) loading/empty/error 固定文案；新增 code-first `describeIndexError`（CWD_REQUIRED/INVALID_PATH/INVALID_INPUT/NOT_DIRECTORY→invalid project path for search；PATH_NOT_FOUND→not found；NO_ALLOWED_ROOTS；PATH_FORBIDDEN/ROOT_REPLACED→outside allowed roots；INDEX_TIMEOUT/TIMEOUT→timed out；INDEX_ABORTED/ABORTED→Search cancelled；kind network/timeout；default→Unable to search files.），不渲染 error.message/body/cause/stack/path。truncated 明确提示。
7) 不做 content grep/fuzzy/ranking/worker/mutation/upload/搜索结果目录联动/D3A-P0。

允许文件（仅这些生产文件改动）：`packages/client/src/features/workspace/paths.ts` + `paths.test.ts`、`FilesPanel.tsx` + `FilesPanel.test.tsx`、`packages/client/src/styles/app.css`、`packages/client/src/api/resources.test.ts` + `query-options.test.ts`（仅补 API 覆盖）、`docs/refactor-execution-plan.md` + `migration-ledger.md`。其余生产文件零改动。

验证（本机 Node v24.18.0）：
- 定向：paths 18/18（新增 joinRelative 4）、FilesPanel 27/27（新增搜索 11，保留既有 16）、resources 6/6（新增 index URL encode/strict matches shape/signal）、query-options 8/8（新增 index key cwd-q isolation/enabled/signal）。
- Client 全量：33 文件 428/428 PASS（基线 411 + 新增 17）。
- root `npm run build` EXIT 0（9 workspace 全 build）；root `npm run typecheck` EXIT 0。
- `npm run check:architecture` PASS；client `npm run check:boundaries` 82 files OK；`git diff --check` OK。
- `rg 'error\.(message|body|cause)|\.stack' packages/client/src/features/workspace/FilesPanel.tsx` 零命中（helper 内部 code/kind 可读，不渲染 raw）。
- 测试模式说明：debounce/搜索 UI 用例用 vitest fake timers，分步 `act`（debounce 推进 → 微任务冲刷 fetch 链 → 非零 timer tick 触发 TanStack notifyManager `setTimeout(0)` → 再次冲刷），单 act 会推迟 query 创建导致假失败（已注释）。
- 无浏览器视觉验收（DeepSeek 无视觉能力），仅 DOM/a11y 测试（aria-label/aria-live/role=alert/原生键盘语义）覆盖并诚实记录。

独立验证 verdict：PASS（Fresh DeepSeek；无 F1/F2，建议合入）。独立使用 worktree candidate source 完成定向 59/59 与 Client 428/428、strict changed-files typecheck、architecture/client boundary/diff-check；额外 `joinRelative` 恶意路径探针 57/57，无任何输入可逃出 canonical root；DOM/race 对抗 9/9 覆盖 StrictMode单请求、capability pending撤回/恢复无闪旧、cwd A→B pending/timer隔离、root未就绪零请求、trim+2字符边界、401固定copy、form submit preventDefault、带q却返回legacy `{files}` union时fail closed。raw error/secret scan与动画diff均零问题，scope精确9文件、工作区clean。独立验证 worktree 无 node_modules，故以 `/tmp` 只读工具链 harness 运行并未改repo；实现者此前已在同一candidate完成官方root build/typecheck/root tests全PASS。

残余风险：搜索词最小长度 2、cap 200、Host 侧排序（精确→前缀→basename 前缀→包含）为既有行为，本切片不改变。UI 仅要求可用、能力诚实、错误清晰、搜索立即响应；后续 D3A Mutation（创建/删除/上传）或搜索结果目录联动仍后置。DeepSeek无视觉能力，本节点无浏览器视觉观感验收，只完成DOM/a11y验证；不夸大视觉质量。
```
## 31. D2-P3 — Runtime Model Control 记录（DONE）

```text
实现：DeepSeek；独立 worktree d2p3-model-control，branch feat/d2p3-model-control，base main@27cf29890fac429f9605c37f4d554fdfd83f217b，候选 `79c84ac3cb4e38c533faedc4d166c709f6eb038a`。仅解锁真实 `set_model` vertical slice；未做 queue/tools/reload/steer/follow_up/bash/compact/fork，未碰 D3A-P0/Files Search/D1B/package-lock/Protocol/runtime-core/daemon/gateway。实现阶段未改 main、未 merge/push、未另建 worktree。状态 DONE（Fresh DeepSeek 独立验证 PASS）。

范围（生产 6 文件 + 测试/fixture 7 + docs 1）：
- Adapter：PRODUCTION_AGENT_CAPABILITIES 精确追加 `runtime.model.set`（保持 prompt/abort/stats/session.rename/thinking.set 顺序与 version 稳定）；真实 adapter internal `set_model` 未重写（sdk-runtime.ts 原实现：catalog resolveModel 后 session.setModel，随后 reapplyPinnedThinking）。未知模型经既有 mapDriverError/sanitizer → 结构化 `invalid_input`（实测 `{code:"invalid_input",message:"unknown model: …",retryable:false,cause:{kind:"model"},details:{sanitized:true}}`，无 raw secret）。无网络生产路径实测：set_model 到有效模型（openai/gpt-5）ok:true 且模型改变、thinkingLevelPinned 保持 true（SDK re-clamp + adapter 重应用 pinned thinking）。
- sessiond（service.ts）：把 D2-P2 硬编码 thinking authority finalization 泛化为仅 `{set_thinking_level, set_model}`：`thinkingAuthorityFinalizations`→`authorityFinalizations`、`ensureThinkingAuthorityFinalized`→`ensureAuthorityFinalized`、新增 `AUTHORITY_COMMAND_TYPES`（未留下 misleading thinking-only 名）。failClosed result 保留原 command type+id；success 有界 worker.getSnapshot 刷新并投影后才 resolve/cache；刷新失败固定 unavailable 无 raw；同 commandId singleflight；malformed/late/wrong-id triple-match；rekey/stop/epoch ownership；cleanup/isBusy/memory bound。未给 clear_queue/get_tools/rename 等刷新。fake-worker 补 set_model 权威快照 mutation。
- Client：SessionStore 新增 `setModel(provider, modelId)`（走 runTypedCommand/sendCommand 单 inflight、session/generation 绑定、非空校验 invalid_input、unsupported/session_busy 诚实）；RuntimeProvider 暴露 setModel。
- UI（SessionActions）：仅 selected 匹配 attached live（live!==false）且 runtime snapshot 广告 `runtime.model.set` 时显示 Model control；Models 数据来自既有 `createQueryOptions(http).models.list(cwd)` 对 **runtime snapshot.cwd** 查询（非 selected history cwd、不硬编码）。Host `models` capability（CapabilityProvider `can("models")`）+ runtime set token + live 才 fetch；set capability 有但 models capability 无 → 固定 "Model catalog is unavailable."/disabled 且零 models 请求。只有模型列表成功且非空才可选；当前 model 在列表显示 selected，不在列表显示只读 `current: provider/id` 占位、不伪造 option。选项 value 用 index key（碰撞安全，不用 `provider:model` 拼接），提交时按 key 读回精确 provider/modelId。成功后 fetchSnapshot 观察权威 state.model 与 thinking clamp/pin（不乐观显示新模型）；固定错误文案：默认 `Failed to change model.`、code invalid_input/not_found/unavailable→`Model is unavailable.`、code/kind auth→`Provider is not authenticated.`，绝不渲染 raw message/body/cause。busy 禁用；same current model disabled/no-op；mounted/selection/requestGen/cwd/cap revoke 守卫（modelGateRef 在 cwd/cap 变更后 fail-closed）；late settle 不 fetch/write；render 零 runtime command。样式复用 thinking select（.session-actions-model*，无装饰动画/无 motion）。
- E2E：fixture CAPABILITIES 加 `runtime.model.set`，维护 model 状态，set_model 严格非空+未知 invalid_input+更新快照（保持 pinned thinking）；tests/e2e/runtime.mjs 全部硬编码 capability 列表加 runtime.model.set；light-commands 增 set→get_state→getSnapshot→detach/reattach model 保持 + thinking high/pinned 仍保持；closed caps 移除 set_model（set_tools/reload/set_auto_retry 仍 unsupported）。

验证（本机 Node v24.18.0，PIX_AUTH_DISABLED=true 运行 E2E）：
- 定向：Adapter production-smoke（cap list 精确、set_model 无网络 success+pin 保持、unknown model sanitized）、public-surface（精确 6 cap 无泄漏）、sessiond 新增 6 set_model 用例（success 快照刷新/same-id singleflight/cleanup+缓存不重复刷新/refresh failure fail-closed+缓存/wrong-type 不 finalize/rekey 不跨 epoch）、SessionActions 新增 15 Model control 用例（live+both caps only、runtime cwd 查询、无 models cap 零请求+unavailable、unknown current 只读占位、collision-safe colon、成功 fetchSnapshot 观察 model+thinking clamp/pin、固定错误无泄漏、same current disabled、rapid 单飞、cap revoke/live→false/session switch/unmount 三守卫+late 无 getSnapshot、thinking 共存）全 PASS。
- 分包：protocol 116/116、runtime-core 7/7、runtime-contract-tests 75/75、adapter 165/165（+1）、sessiond 152/153（1 Windows-only skip，+7）、agent-worker 105/105、host 263/263、cli 46/46、client 449/449（基线 428 + 21：session-store +5、provider +1、SessionActions +15）。
- build：root parallel runner 本机 stall（同 §29 既有环境问题，父已终止 candidate-only 构建组），改按 workspace 官方 `npm run build` 逐一执行全部 EXIT 0（protocol/runtime-core/runtime-contract-tests/adapter/sessiond/agent-worker/host/cli/client，client 含 vite build）。
- typecheck：root runner 同样 stall；改 direct `node_modules/.bin/tsc -p <pkg>/tsconfig*.json --noEmit` 全 9 包 PASS（sessiond/adapter 含 test tsconfig；client 官方 `tsc -b` PASS）。
- check:architecture PASS；check:boundaries client 82 files / sessiond / adapter / agent-worker / host PASS；`git diff --check` PASS。
- test:e2e:runtime（真实进程链）：2/2 轮 PASS（含 create→attach→prompt、abort、host restart/resume、epoch change、commandId at-most-once、isolation、cold attach、D2-P1/P2/P3 light commands：set_thinking_level→snapshot 权威→detach/reattach pin 持久 + set_model→state→getSnapshot→detach/reattach model 保持且 thinking high/pinned 保持→closed caps set_tools/reload/set_auto_retry unsupported、shutdown 无孤儿）。test:e2e:startup PASS、test:e2e:sessions PASS。

关键环境根因记录：最初 Runtime E2E 失败（set_thinking_level 后 getSnapshot 仍显示 thinking off，`'off' !== 'high'`）根因不是代码回归——worktree 的 node_modules 是指向主仓 node_modules 的 symlink，E2E 通过 `@fffattiger/pix-*` 解析到主仓 packages/sessiond 的 **陈旧 dist（D2-P2 之前的构建，无 post-success snapshot authority finalization）**，故 set_thinking_level 返回 ok 但 sessiond projection 从不刷新。修复：将 symlink 替换为真实 node_modules（d2p2 worktree 的 known-good 完整安装 hardlink 复制，@fffattiger/* 相对符号链接自动指向本 worktree 的 packages），使 E2E 使用本 worktree 的 fresh dist（含 D2-P3 sessiond 泛化 + set_model finalization）；临时 debug 证实 set_thinking_level 与 set_model 均完成 `finalize ok snapshotThinking=high pinned=true` 后移除。另移除 blank-provider E2E 断言（wire Protocol schema 要求 provider/modelId 为 NonEmptyString，空值在 WS 边界被拒连接，到不了 fixture；fixture 非空校验仅 defense-in-depth）。

独立验证 verdict：PASS（Fresh DeepSeek；无 F1/F2，建议合入）。独立构建 candidate-local `node_modules` 解析层并以 realpath/import.meta.resolve 证明 sessiond/adapter/protocol/runtime-core/worker 全部加载 candidate dist，排除 stale-main-dist 假验证。Adapter165、sessiond152 pass/1 Windows skip、Client449、Worker105、Protocol116、Core7、Contract75、Host263、CLI46 全 PASS；Runtime E2E 2轮、Startup、Sessions全PASS。另设计9组sessiond对抗probe：snapshot sessionId mismatch、timeout、不同commandId并发、same-id不同payload、wrong/malformed/inner-id帧、finalization期间get_state、非authority命令0刷新、stop during finalization、连续21次cleanup/busy，全部PASS。确认AUTHORITY_COMMAND_TYPES严格仅thinking/model，错误固定且缓存，epoch/ownership/cleanup无跨写或deadlock。Client 85项定向+449全量覆盖live+双cap/runtime cwd查询、catalog缺失零请求、collision-safe value、无乐观更新、固定错误、cap/cwd/A→B/unmount晚到守卫、Thinking共存。工作区clean、无依赖/进程残留。

残余风险：root `npm run build`/`typecheck` 并行 runner 本机 stall（同 §29），以分包等价覆盖替代并记录。UI 无浏览器视觉验收（DeepSeek 无视觉能力），仅 DOM/a11y 测试（aria-label/aria-live/role=alert、select 原生语义）覆盖并诚实记录。Models 查询仅当 Host `models` capability 存在才发；真实生产 no-network set_model 不需要 auth（SDK setModel 仅模型指针），故 auth 错误 sanitize 由 mapper/UI 层覆盖而非 SDK no-network 路径实测。set_model 的 thinking 绝对档位由 SDK clamp（production-smoke 用 gpt-5 实测 pinned 保持，未断言绝对档位）。独立验证另有一个非阻塞F3：SessionActions测试fetch mock使用test-only `as unknown as typeof fetch`，生产代码不受影响；模型option使用位置index，目录若在选择后、提交前重排可能改变目标，当前目录稳定且select会显示实际待提交项，后续若catalog mutation成为真实场景可改稳定key。
```
## 32. D2-P4 — Runtime Queue Control 记录（DONE）

```text
实现：DeepSeek；独立 worktree d2p4-queue-control，branch feat/d2p4-queue-control，base main@9209105655a52ee51290138e87d8c6346803c4d2，implementation commit `291cf40`，已 cherry-pick 至 main `e005a42`。目标：真实贯通 prompt 运行中 steer/follow_up、snapshot queue 显示、clear_queue interrupt；production capability 精确加 runtime.steer / runtime.follow_up / runtime.queue；sessiond AUTHORITY_COMMAND_TYPES 扩为 thinking/model/set_auto_retry。未改 Protocol/runtime-core/daemon/package-lock/D3A。状态 DONE（Fresh GPT 独立验证 PASS）。

范围（生产文件）：adapter `agent/index.ts`（9-token capability surface）、sessiond `service.ts`（AUTHORITY_COMMAND_TYPES 加 set_auto_retry）、client `session-store.ts`（双槽 pendingQueuedTurn + typed interrupt admission + steer/followUp/clearQueue）、client `runtime-provider.tsx`（暴露 API）、client `Composer.tsx` + `app.css`（queue 展示 + Steer/Follow-up 行为）、**Host `runtime-gateway.ts`（双 lane 最小修复，父会话正式扩 scope）**。

关键架构冻结与实现：
- Client SessionStore 保留单 pendingCommand 原语义，新增独立 pendingQueuedTurn 槽仅限 steer|follow_up，最多 1 条在飞（第二条 session_busy，绝不覆盖 prompt promise）；独立 commandId/envelopeId/generation/sessionId/promise。完整接线 send failure、handleResponse correlation、resync same commandId new envelope on snapshot/gap、epoch_changed reject no resend、stop/detach/dispose/session-switch 清理。clearQueue 走独立 interrupt 信封 + typed admission：同一时刻只允许一种 interrupt，同 type 同 action 沿用 coalesce，different type 返回 session_busy；interrupt result 三重匹配（response id / commandId / interrupt type），abort 回归。
- Store/Provider API：`steer(message,images?)`/`followUp(message,images?)`（严格 trim/nonempty invalid_input，images 透传但本 UI 仅文本）、`clearQueue()`；capability 诚实 unsupported（UI 按 capability 门控，helper 不前置判断）。
- Composer：仅在 attached-live + snapshot 权威 isStreaming/isPromptRunning 时改变行为。runtime.follow_up → streaming 中 textarea+Send 保持可用，Enter/Send 发 follow_up（安全默认，成功才清草稿）；runtime.steer → 紧凑 Steer 按钮同草稿发 steer（成功清/失败保留）；pending queued-turn 期间 Send/Steer disabled；idle Send 仍 prompt 且无 Steer/Follow-up 标识。queue 从 snapshot.state.queuedMessages 读，steering/followUp 各条 text + image 仅固定 count placeholder（不泄漏 data）；queue 非空 + runtime.queue 显示 Clear queue，cap 撤回立即隐藏。无动画/无 transition:all，复用现有 composer 样式语言。
- sessiond：AUTHORITY_COMMAND_TYPES 精确 `{set_thinking_level, set_model, set_auto_retry}`；set_auto_retry 成功有界 worker.getSnapshot 刷新投影后才 resolve/cache，refresh 失败固定 unavailable 同 type+id，同 commandId singleflight，三重匹配。steer/follow_up/clear_queue 不触发 authority refresh（queue_update 事件已权威收敛）。Client 不新增 setAutoRetry helper/UI（明确排除），由 E2E/adapter/sessiond 测试证明直接 wire set_auto_retry → snapshot.autoRetryEnabled true、detach/reattach 保持。
- Adapter：PRODUCTION_AGENT_CAPABILITIES 在现 6 token 后稳定追加 steer/follow_up/queue（共 9 token）；internal adapter 的 steer/follow_up/clear_queue/set_auto_retry 原本已实现，仅 capability 门打开。production-smoke 无网络实测：steer idle→snapshot queue、clear_queue→empty、set_auto_retry→state true。
- **Host 双 lane（父会话正式扩 scope）**：根因确认真实 prod blocker——Host `SessiondRuntimeGateway` 每连接 BoundedSerialQueue（976c4c6 DoS 加固）严格串行，same WS 长 prompt command HOL 阻塞 steer/follow_up。实现最小修复：保留 serial lane；新增独立 bounded FIFO `queuedTurnSerial` 仅路由 command.type steer|follow_up；onFrame 解析后按类型分流（interrupt 仍独立 fire-and-forget）；两 lane 复用同 inbound limits（maxSerialFrames/maxSerialBytes，无新配置/API）；lane overflow 固定 close 1009 并记 lane-safe count/bytes 无 raw；browser close/closeBrowser 同时关两 lane、queued task short-circuit；create/attach/detach/getSnapshot/stop 等仍留 serial lane 不并发。
- E2E fixture：CAPABILITIES 加 steer/follow_up/queue；base state queuedMessages empty/autoRetryEnabled false；steer/follow_up 入队并 emit queue_update；clear_queue interrupt 清空 emit；set_auto_retry 更新 state（sessiond refresh）；__block__ prompt 保持运行支持 queue 观察/clear；closed caps 仅剩 set_tools/reload。
- E2E runtime.mjs：**单一 RuntimeWsClient（同一 WS 连接）**——block prompt 运行中同连接发 steer/follow_up（Host 双 lane 现在真实支持），queue_update 事件在运行中收敛，abort 后 getSnapshot 显示两类 queue，clear_queue 清空，set_auto_retry 权威 true，detach/reattach 保持，abort prompt，closed tools/reload 仍 unsupported；2 轮无孤儿。注：getSnapshot/set_auto_retry 走 serial lane，故 block 运行中 HOL（设计如此），E2E 先 abort 再 snapshot；steer/follow_up 在 block 运行中即返回 ok（双 lane 贯通）。

验证（本机 Node v24.18.0，PIX_AUTH_DISABLED=true）：
- 定向/分包：client 481（基线 449 + 32：session-store +19、provider +2、Composer +11）、sessiond 158 pass/1 skip（基线 152 + 6 set_auto_retry + 1 非refresh）、adapter 166（基线 165 + 1 queue smoke）、host 269（基线 263 + 6 双lane）、agent-worker 105、protocol 116、runtime-core 7、runtime-contract-tests 75、cli 46。
- typecheck：direct tsc 官方 tsconfigs（含 sessiond test tsconfig、client tsc -b）全 PASS；root 并行 runner 本机 stall（同 §29 环境问题，按分包等价覆盖）。
- check:architecture PASS；client boundaries 83 files OK；host boundaries 38 files OK；`git diff --check` OK。
- test:e2e:runtime（真实进程链，单连接双 lane）：2/2 轮 PASS——create→attach→prompt、abort、host restart/resume、epoch change、commandId at-most-once、isolation、cold attach、D2-P1/P2/P3 light commands、**D2-P4 queue control（block prompt + 同连接 steer/follow_up + queue_update 事件 + abort 后 snapshot 两类 queue + clear_queue + set_auto_retry 权威 + detach/reattach + closed tools/reload）**、shutdown 无孤儿。test:e2e:startup PASS、test:e2e:sessions PASS。
- candidate-local module resolution：import.meta.resolve 证明 sessiond/daemon、adapter/agent、protocol、runtime-core、agent-worker、host 全部指向本 worktree packages/dist（排除 stale-main-dist 假验证）。

独立验证 verdict：PASS（Fresh GPT，review commit `291cf40`）。在不修改候选 worktree 的 `/tmp/pix-d2p4-verify` 镜像中复验 Host 269/269、sessiond 158 pass/1 skip、adapter 166/166、protocol 116/116、agent-worker 105/105、CLI 46/46、contract 75/75、Sessions E2E PASS；Runtime E2E 2/2 轮 PASS，确认 D2-P4 仅使用单一 RuntimeWsClient/WS，长 prompt 运行中同连接 steer/follow_up 均成功。另做 10 组 Host 对抗 probe，覆盖 queued-turn byte overflow、serial 满载时 steer 并发、clear_queue bypass、浏览器关闭时晚响应丢弃、FIFO、overflow 后不再 dispatch、attach 前/stop 后安全拒绝、detach 并发等，全部 PASS。Client D2-P4 定向测试 session-store 67/67、Composer 11/11、provider 2/2 PASS；全量中 12 项失败在 base 镜像完全复现，判定为 React/testing-library fake-timer harness 既有伪影。Fresh protocol build 后 Client/sessiond strict typecheck 0 errors。未发现实现缺陷；main 合并后 architecture PASS、Host 269/269、diff-check PASS、工作区 clean。

残余风险：① Host 单连接 serial lane 仍 HOL getSnapshot/set_auto_retry 于运行中 prompt 之后（文档化 LOW，非本 slice 目标）；② Composer queue 展示仅 DOM/a11y 测试覆盖，无浏览器视觉验收；③ 双 lane 上限复用 maxSerialFrames/maxSerialBytes 未新增独立配额（按父指令不新增 API）；④ root `npm run build`/`typecheck` 并行 runner 本机 stall（同 §29）；⑤ 候选 worktree 的未重建 protocol dist `.d.ts` 陈旧，但 pipeline fresh build 会消除，Protocol 源码未由 D2-P4 修改。
```

## 33. session-list-piweb-parity — 全量会话列表性能 hotfix 记录

```text
实现：95f72a3（branch fix/session-list-piweb-parity，base 57ec4619becb1647ba672e51b46d1fcd7152c09c），已 cherry-pick 至 main `b5d6a4c`，文档跟进 `5f10352`。
实现模型：本任务执行体（Fresh session）
范围：packages/pi-sdk-adapter/src/internal/session-store.ts、packages/pi-sdk-adapter/test/sessions.test.ts、packages/client/src/api/query-keys.ts、packages/client/src/api/query-options.test.ts、docs/refactor-execution-plan.md、docs/migration-ledger.md。未改 Protocol/runtime-core/sessiond service/daemon/Host/package-lock，未加 Host RPC 超时，未引入 SQLite/Next，未改 allowed-root/项目总览/无关 UI。

缺陷（既有）：pix 的 Pi SDK session store `listSessions()` 对每个 list 结果调用 `toSessionHeader` → `forkProvenance(info.path)` → `SessionManager.open(path).getEntries()`，对每条会话做第二次全量同步读取，且经常再 open 父会话；单会话 read/context/locate/resolveLeafId/delete 每次都重新跑全局 `SessionManager.listAll()`。listAll 冷 ~3.25s（本机实测 616 条会话冷 2.92s），旧 list 路径每会话二次读 + 完全阻塞 event loop（本机实测隔离同步 open 阶段 2.53s 内 1ms 心跳 0 tick）。

修复（对齐旧 pi-web `lib/session-reader.ts` 算法，只迁算法不迁框架）：
- list 路径：每次冷刷新一次 `SessionManager.listAll()`；构建 normalized path→sessionId map（`sessionPathKey` 逐字节对齐旧 pi-web：posix.normalize / win32.normalize+toLowerCase）；`parentSessionId` 由每条 info 的 `parentSessionPath` 经该 map 解析（相对路径不匹配绝对路径键 → undefined，与旧产品一致）；**list 绝不调用 `SessionManager.open`/getEntries 二次读**；保留 title/messageCount/lastActivity/cwd/sessionFile 元数据；`forkPointEntryId` 不在 list 头出现（读 entries 才可得），detail/context 保留完整 provenance（pix-fork-provenance custom entry，否则 SDK-native parentSession header 经 warm path→id index 解析、兜底 open 父会话）。
- 缓存：per-store 实例缓存（非 process-global），30s TTL（默认）+ 单一 in-flight promise 按 generation 合并并发 list；timing 可注入（`now`/`listTtlMs`）。失败时 in-flight 清除且可重试，绝不为失败/畸形结果写缓存。
- 单会话索引：warm list 后用 sessionId→path/info index，read/context/locate/resolveLeafId/delete 不再重跑全局 listAll；对齐旧 resolveSessionPath：warm 命中→零扫描；warm 未命中→恰一次 fresh scan；cold 未命中→listInfos 那次扫描即最新。open 时校验 `manager.getSessionId()===sessionId`（SDK open 对已删文件会生成新随机 id），stale/reused 路径 invalidate + rebuild 恰一次后 not_found，绝不返回错误会话。
- 失效：delete 立即 invalidateList。create/discovery/rename 无现成窄 seam（catalog port 无 invalidate 方法，加方法属接口/协议变更），按 hotfix 约定记录最长 30s 陈旧：单会话 read 经 rebuild-once 自愈，list 标题/成员最迟 30s 后刷新。
- Client：sessions list query 加 `staleTime: 30_000`（对齐服务端 TTL），mount/window focus 不再重复触发重型全量 list 请求；保留无 cwd 全项目冷启动请求。

验证（本机 Node v24.18.0，PIX_AUTH_DISABLED=true 跑 E2E）：
- root npm run build EXIT 0（9 workspace 全 build）；root npm run typecheck EXIT 0；check:architecture PASS（含 no legacy product name）；adapter check:boundaries PASS（21 source/10 public declarations）；client check:boundaries PASS（83 files）。
- adapter 171/171（基线含既有 166 + 新增 5：list 不 open、parent 归一化 parity、30s TTL/coalesce/failure-retry、path-reuse 绝不错会话、real-JSONL warm 不再扫描+stale rebuild once+恢复）；sessions.test.js 18/18。
- client 482/482（新增 1：sessions list staleTime=30s + 无 cwd 冷请求保留）。
- sessiond 158 pass/1 Windows skip；runtime-core 7/7；protocol 116/116；runtime-contract-tests 75/75；agent-worker 105/105；host 269/269；cli 46/46。
- test:e2e:sessions PASS（真实 JSONL 全链路零 worker）；test:e2e:startup PASS；test:e2e:runtime PASS（round 1 全场景）。
- git diff --check PASS（见下）。

真实语料性能（本机，`~/.pi` 616 条会话，warm page cache，1ms 心跳）：
- A. `SessionManager.listAll()` 冷：2.92s，event loop 响应（2019 ticks，maxGap 3.9ms）。
- B. 旧 list 路径（listAll + 每会话 open().getEntries()）：~5.5s 总量；隔离同步 open 阶段 2.53s 内 1ms 心跳 0 tick（event loop 完全阻塞 ~2.5s）。
- C. 新 store `listSessions()` 冷：2.97s ≈ listAll-only（2027 ticks，maxGap 7.5ms，无额外阻塞）。
- D. 新 store `listSessions()` 热：1ms（30s TTL 命中）。
- 结论：本机冷 list 从 ~5.5s 降到 ~2.97s（≈纯 listAll，无二次读），重复 list 从 ~5.5s/次降到 ~1ms/次，且不再阻塞 sessiond event loop。根因描述中的 53.7s 为更大语料/冷缓存条件下测得，相对改善与阻塞证据在本机一致。

残余风险：
- create/discovery/rename 后 store 缓存最长 30s 陈旧（已文档化；单会话读取自愈；Client rename/delete mutation 已 invalidate client query）。
- `locate` 现在经 openSession 校验 id（activate 属冷启动低频路径，一次全读可接受）；`readSession`/`deleteSession` 同样校验 id 以绝不错会话。
- root npm run build/typecheck 本机可跑（本次 EXIT 0），未复现 §29 stall；已合入 main 并部署至 `test-pi.huu.im`。公网实测 616 条会话冷请求 3.63s、热请求 0.58s（含公网转发），sessiond 健康且空闲 CPU 约 0.1%。

独立验证 verdict：PASS（Fresh GPT，review main `b5d6a4c` + `5f10352`）。复验 adapter 171/171、Client 482/482、双方 typecheck/boundary、diff-check 全 PASS；另以临时真实 SDK 语料和对抗探针覆盖缓存失效期间并发、旧请求不得覆盖新 generation、失败重试、TTL 边界、畸形结果不缓存、并发冷请求合并、调用方修改返回数组不污染缓存、每 store 独立缓存、列表零 `SessionManager.open`、parentSessionId 路径映射、detail provenance、已删/复用路径绝不返回错误会话、stale rebuild 恰一次等，全部 PASS。无 blocker。非阻塞风险：① warm index miss 的 `scanOnce` 未合并，多个并发 miss 可各跑一次全量扫描；② production catalog 与 locator 使用两个 store，冷 activation 不复用已热 catalog cache；③ 外部已删文件导致 delete 的 rm 返回 ENOENT 时，list 最长保留 30s；④ 连续查询不存在 session 会每次 fresh scan。以上不影响主列表热路径与正确性，后续索引阶段处理。
```

## 34. session-list-piweb-parity 实现模型说明

本 hotfix 在独立 worktree `fix-session-list-piweb-parity` 完成（base 57ec461），随后以 `b5d6a4c` + `5f10352` 合入 main，并部署至当前测试服务。实现、测试、文档更新与真实语料探针均先在独立 worktree 完成；机器相关探针脚本 `.perf-probe.mjs` 未提交（提交前已删除）。

## 35. D3A-Upload-Transaction — 事务性多文件上传 C1 记录（DONE）

```text
实现：Fresh DeepSeek；独立 worktree d3a-upload-transaction，branch feat/d3a-upload-transaction，base main 811c94e，source `5b4d1c7`，已 cherry-pick 至 main `18da293`。目标：POST /v1/files 一次请求接受的文件创建/覆盖全量原子（all-or-nothing）。仅改 packages/host/src/routes/files.ts（生产）+ 新增 packages/host/test/uploads-transaction.test.mjs（12 用例）+ docs 两份。未改 UI/API schema/capability/依赖/package-lock/Client/CLI/protocol/sessiond/trusted-roots-ledger 相关文件。状态 DONE（Fresh GPT 独立验证 PASS，未重启 live dev）。

语义（相对旧行为）：旧实现逐个文件原子写，后失败时先前文件/覆盖已提交（部分可见最终态）。新实现三段式：
- Preflight（零写入）：保留授权、name/duplicate、每文件 size、总 size、symlink 与 conflict 校验并规划全批 create/overwrite/skip；conflict=error 对已存在目标在 preflight 即 409 FILE_EXISTS（整批拒绝，无 staging）。独立验证确认一个可观察变化：`INVALID_CONFLICT` 现在早于逐文件 name/duplicate/size 错误返回；均为零写入 4xx，无安全影响，但不再声称错误优先级逐字保持旧版。
- Stage：每个接受文件写入目标 canonical 目录内唯一 `.pix-upload-<uuid>.tmp`（O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW，0600）；任一步失败 best-effort 清理已 stage temp、零 final 变更。若外部进程把整个目录改名，temp 会随 inode 移动而无法用旧路径清理，此例外明确记入残余风险。
- Commit（per-directory KeyedMutex 下，rollback journal）：create 用 `link(staged,target)`+`rm(staged)` 原子 create-if-absent（link 对已存在 target 返回 EEXIST，绝不覆盖/跟随）；overwrite 先 `link(target,backup)` 硬链接备份原 inode 于同目录（同 fs、字节/元数据精确、target 从不缺位）再 `rename(staged,target)`，成功统一 `rm(backup)`，失败 `rename(backup,target)` 精确还原；journal 记录每步，失败按逆序回滚（overwrite→rename backup 还原、create→rm target）。abort（c.req.raw.signal）在 stage/commit 每步检查，观察到的 abort→499（按阶段为 UPLOAD_ABORTED 或 MUTATION_ABORTED）+ 回滚已提交项 + best-effort 清理 temp。

commit 边界重验（Existing AllowedRoot 语义）：
- 目录 canonical 路径不变 + dev/ino 身份不变（否则 403 PATH_FORBIDDEN / 409 DIRECTORY_REPLACED）；根身份由 authorizeExisting 现有 ROOT_REPLACED 保护。
- 每目标再次 authorizeChild（symlink/目录→409 UNSAFE_TARGET）；每次 beforeCommit seam 后重验目录身份，堵住 preflight→commit 间目录替换/root 替换/symlink 交换被误提交的窗口。

并发：模块级 `uploadMutations = new KeyedMutex()`（复用既有 resources/mutex.ts 模式，同 worktrees.ts），key = canonical 父目录；同目录上传 FIFO 串行（两批 journal 不交错），异目录并行（keyed 自动回收 idle key）。每请求仅取一把锁、无嵌套，无 lock ordering/deadlock 可能。

安全/错误：所有既有 path 授权、root identity、traversal/NUL/name 校验、25MiB/100MiB、multipart、conflict 语义、symlink 拒绝、O_NOFOLLOW/0600/temp+rename、精确字节、sanitized 错误全部保留；新增 code 仅 `DIRECTORY_REPLACED`(409)/`UPLOAD_ABORTED`(499)，无路径无内容。临时/备份名 `.pix-upload-<uuid>.tmp/.bak` 随机不可预测、成功/失败 best-effort 清理、绝不进入响应或日志。

测试 seam：`setUploadFaultHooks(hooks)`/`UploadFaultHooks`（beforeStage/beforeCommit/beforeRestore）从 `dist/routes/files.js` 导出供测试确定性注败（chmod/timing 不用），未从 index.ts 导出、非 public surface；afterEach 复位。

新增 12 用例全 PASS（5 轮无 flake）：
1. 两个新文件、第二 commit 失败→第一个也移除；2. overwrite 原文件+后失败→原字节精确还原（含二进制）；3. 混合 create/overwrite（独立 root）与 skip 条目不参与回滚（独立 root）；4. staging 失败→零 final 变更/temp 残留；5. 重复文件名 preflight 400 零写入；6. symlink 交换于 preflight→commit→409 UNSAFE_TARGET、外部文件未被写、target 保持 symlink（lstat 验证）；7. 根替换→403 ROOT_REPLACED、子目录替换→409 DIRECTORY_REPLACED；8. 同目录并发 commit 串行（beforeCommit 阻塞证明）+异目录并行；9. error 模式批内目标中途出现→整批 409 回滚且外部文件保留；10. skip 模式批内目标中途出现→skip 不回滚、temp 清理；11. 成功上传无 temp/backup 残留且响应不泄漏 pix-upload/.tmp/.bak；12. abort 清理 temp+回滚已提交 overwrite。

验证（候选 worktree 本地，Node v24.18.0）：
- 定向 uploads-transaction 12/12（5 轮全过，无顺序依赖）；Host 全量 281/281（基线 269 + 12）；Host build/typecheck EXIT 0；check:boundaries PASS（38 files）；check:architecture PASS；git diff --check PASS。
- 独立验证：Fresh GPT 以全新 `/tmp` build 复跑 Host 281/281、focused 12用例多轮，并做约70项对抗探针，覆盖未授权零body写入、重复/越界/体积限制、硬链接/目录/symlink、回滚恢复失败、同目录别名锁、等待锁时abort、目录替换、各 conflict race、错误响应无路径/temp泄漏、fault hook非public等；verdict PASS。

残余风险（诚实记录）：
- 请求级回滚是强制的；进程在 commit 中段崩溃时无 durable journal，无法自动恢复（部分批可能已提交）——不承诺进程崩溃耐久；崩溃窗口内可能遗留 `.pix-upload-*.bak/.tmp`（best-effort 清理，不保证）。
- overwrite 用硬链接备份，依赖文件系统支持硬链接（APFS/ext4 等目标平台支持）；不支持的文件系统会使 overwrite 失败（安全失败，非静默降级）。
- overwrite 的 `link(target,backup)` 与 `rename` 之间 target 缺位窗口极小（硬链接方案下 target 从不缺位；rename backup 还原为原子单步）。
- 并发锁仅串行化 Host 上传请求；外部进程（shell/git）对同目录的并发修改仍依赖 commit 边界重验兜底（TOCTOU 不可完全消除）。外部重命名整个目标目录时 final 写入会拒绝，但移动后的目录中可能遗留0600 temp；大型上传时 temp 也可能短暂出现在 GET 文件列表。
```

## 36. D2-P5 — Bash Runtime Control 记录（DONE）

```text
实现：本任务执行体（Fresh session）；独立 worktree d2p5-bash-control，branch feat/d2p5-bash-control，base main 811c94e，implementation `3ce5d2d`，已 cherry-pick 至 main `28f6b8e`。目标：真实贯通 bash 命令 + abort_bash 控制（独立 interrupt 路径，长 bash 不 HOL 阻塞 abort）；production capability 精确加 runtime.bash / runtime.bash.abort（9→11 token）；Client SessionStore 暴露 typed runBash / abortBash helper。与 D3A host 并行 slice 并行进行，未触碰 host 文件/资源、D1 会话、trusted-roots ledger、upload transaction、package-lock、无关 UI。状态 DONE（Fresh GPT 独立验证 PASS）。

范围（生产文件）：adapter `agent/index.ts`（11-token capability surface）、client `session-store.ts`（runBash / abortBash + bash 生命周期清理）、client `runtime-provider.tsx`（暴露 API）。未改 Protocol/runtime-core/sessiond/Host/daemon/package-lock；未新增 wire 类型；Bash 未进入 AUTHORITY_COMMAND_TYPES（bash_update delta 投影即权威，无 sessiond 快照终态化）。

关键架构冻结与实现：
- Adapter：PRODUCTION_AGENT_CAPABILITIES 在 9 token 后稳定追加 runtime.bash / runtime.bash.abort（共 11 token）；internal adapter 的 bash / abort_bash 原已实现，仅 capability 门打开。production-smoke 无网络实测：真实 `echo` 命令 → snapshot.state.bash.output 精确投影 + exitCode 0；idle abort_bash no-op ok；`sleep` + 立即 abort_bash 不阻塞（<500ms）且命令 settle（ok 或 interrupted）。
- Client SessionStore `runBash(command, options?)`：ORDINARY 命令，走既有单 inflight pendingCommand 槽 —— prompt/bash 任一在飞时第二条普通命令诚实 session_busy（绝不覆盖第一条 waiter）；严格 trim/nonempty invalid_input；bash_update.output delta 经共享 Protocol projection 累积到 snapshot.state.bash（无需客户端额外权威刷新），helper 仅解包相关 ack。`abortBash()`：独立 interrupt 信封 + typed admission（同 type coalesce、different type session_busy、三重匹配），绝不在长 bash 后排队。
- Client bash 生命周期清理：stop/dispose 沿用通用 settlePendingCommand（bash 与 prompt 一样恰一次 settle）；detach 与 session-switch（startAttach 到不同 session）新增类型感知 `settlePendingBashCommand`——bash 是长跑控制资源，detach/switch 必须恰一次 reject（slot 释放、晚到 result/event 不能 settle 新 session），而 prompt promise 语义保持不变（detach 不 overwrite prompt）。
- E2E fixture：CAPABILITIES 加 bash 对；execute bash 确定性 start(空 delta)/delta 流/end，`__block__` 长 bash 持锁直到 abort_bash（或超时兜底），中断后 cancelled projection；interrupt abort_bash 解析持锁；baseState 暴露 isBashRunning + bash projection；close 也释放 bash 持锁。closed caps 仍为 set_tools/reload。
- E2E runtime.mjs：单一 RuntimeWsClient（同一 WS 连接）真实贯通 Host→sessiond→R2→R1→fixture：PRODUCTION_CAPS 常量统一 11 token 断言；新 scenarioD2P5BashControl——普通 bash 的 delta 拼接精确输出 + getSnapshot state.bash 精确/exitCode0/completed、`__block__` 长 bash + abort_bash interrupt 非阻塞（<5s 断言）+ interrupted + cancelled bash_update + snapshot cancelled/completed + detach/reattach 后 bash 投影持久（worker snapshot）+ closed tools/reload。注：普通命令 getSnapshot/set_tools 走 serial lane，长 bash 运行中会 HOL（设计如此，文档化 LOW）；abort_bash 走 interrupt 旁路不 HOL；bash 运行中事件（bash_update）不阻塞。

验证（本机 Node v24.18.0，PIX_AUTH_DISABLED=true 跑 E2E）：
- 定向/分包：adapter 172/172（基线 171 + 1 bash smoke）、client 496/496（基线 482 + 14：session-store +12、provider +2）、sessiond 158 pass/1 skip、protocol 116、runtime-core 7、runtime-contract-tests 75、agent-worker 105、host 269、cli 46。
- typecheck：adapter/client/sessiond 官方 tsconfig 全 PASS；root build EXIT 0。
- check:architecture PASS；client boundaries 83 files OK；host boundaries 38 files OK；`git diff --check` OK。
- test:e2e:runtime（真实进程链，单连接）：2/2 轮 PASS——既有 10 场景 + 新 D2-P5 bash control（普通 bash 精确投影 + block 长 bash + abort_bash 非阻塞 interrupt + cancelled + detach/reattach 持久 + closed tools/reload）全 PASS，shutdown 无孤儿。test:e2e:startup / test:e2e:sessions 未受本 slice 影响。
- candidate-local module resolution：import.meta.resolve 证明 sessiond/daemon、adapter/agent、protocol、runtime-core、agent-worker、host 全部指向本 worktree packages/dist。

独立验证：Fresh GPT 复验 root build/typecheck、Client 496/496、Adapter 172/172、其余 workspace 全绿、Runtime E2E 1轮+2轮、Startup/Sessions E2E、architecture/boundaries 全 PASS；另检查 capability 精确门控、bash/prompt pending 互斥、detach/switch/stop/dispose/epoch/reconnect、abort typed admission与竞态、delta不重复累积、same-WS真实链与无孤儿，verdict PASS。

残余风险：① Host 单连接 serial lane 仍 HOL 普通命令（getSnapshot 等）于长 bash 之后（文档化 LOW，本 slice 不重设计 Host lane，abort_bash 走既有独立 interrupt 旁路已验证非阻塞）；② Bash 命令/abort 仅 capability 门控，UI（Composer 等）未在本 slice 暴露 bash 控件（显式排除，minimal API only）；③ Bash command text 沿用既有 Protocol 合约，无额外长度上限且允许 shell 控制字符；④ `fullOutputPath` 沿用既有 bash projection，可能包含服务端本地路径；⑤ interrupt ack 沿用既有 abort/clearQueue 设计，无独立客户端超时，依靠重连同步收敛。
```

## 37. D1 Sessions Read Path — backend hardening checkpoint（DONE）

```text
合入 main：WP3真实E2E `dfd552e`；WP2 shared session ports `8621383`；WP1 cache hardening `3fae308` + GPT FAIL修复 `faa0fe0`。

WP1：pi-sdk-adapter session store 的 warm-index-miss rebuild 现在合并并发扫描；listInfos/scanOnce 共用单调 revision fence，旧扫描晚完成不能覆盖新缓存；resolveInfo 在记 not_found 前重查当前index。负结果按记录时刻固定30s过期，其他扫描不能延期，默认最多1024条并按最旧淘汰；invalidate/成功发现该id会清除。delete 在id校验后遇到ENOENT按已删除幂等成功并失效缓存，其他文件错误固定sanitize，路径复用时绝不删除别的session文件。Fresh GPT 首轮复现同generation覆盖、负期限可无限延期和容量无界并判FAIL；`faa0fe0` 修复后以原探针复验：F1从5/5失败降为0/5、F2超过100s场景恢复、F3容量有界；Adapter main复查189/189，verdict PASS。

WP2：新增窄 `createPiSdkSessionPorts()`，production daemon 默认catalog与locator共享一个store；sessions.resolve定位后activation context读取复用同一cache，从两次listAll降为一次。显式catalog/locator/activationContext/null覆盖优先级不变，构造lazy且不同daemon不共享global cache。Fresh GPT以真实SDK临时语料、并发调用和daemon RPC复验，Adapter175/175、sessiond159 pass/1 skip，verdict PASS。

WP3：仅扩 `tests/e2e/sessions-history.mjs`，覆盖limit/offset严格十进制分页、leafId可见分支上下文、sessiond delete后文件/list/read 404一致、非live rename固定unavailable、重复list零Worker；连续3轮Sessions E2E PASS。未新增Host mutation route，live rename仍留D4。

残余：create/discovery/rename list头最长30s陈旧仍按既有hotfix约定；Host rename/delete/auto-name mutation route属于D4；SQLite JSONL投影和客户端虚拟列表属于Wave4 SCALE1/UX1，不作为D1当前底层正确性阻塞。

## 38. D3A-P0 — 可持久化 Trusted-Roots Ledger 记录

```text
实现：`dfb1759`（branch feat/d3a-p0-ledger-final，base main 811c94e），已 cherry-pick 至 main `f7c9a80`；Fresh GPT 独立验证 PASS。本项为 D3A-P0「可持久化受信根」最终实现：把原先仅存于内存的 Host 创建 worktree 受信根 claim 持久化为 host 目录下的受信根账本，Host 重启后恢复文件授权；绝不扫描/导入任意既有 Git worktree。

父架构/安全决策（必须实现）：
1) 严格单 Host per PIX_HOST_DIR：openTrustedRootsLedger 在 listen 前获取排它「生命周期」host-dir 锁（O_EXCL 0600，{pid,instanceId,createdAt}），持有至优雅关闭 close()。任何既有锁（存活 OR stale）都以固定 sanitized 错误拒绝启动，绝无自动 stale 回收；SIGKILL 遗留 stale 锁时下次启动 fail closed 且不动账本，operator/test 可在证明旧 pid 已死后显式删除 fixture 锁；close() 只删除自身精确锁身份（dev/ino + instanceId），错误 instance 无法解锁他人目录。
2) 安全专用 PIX_HOST_DIR：默认 `~/.pi/pix/host`，显式值必须非空绝对路径无 NUL。新建专用 leaf：安全创建并以 fd 设 0700；既有目录绝不被 chmod：要求当前用户所有权（平台支持时）、mode 0700、真实非 symlink、且只含已识别 Pix ledger/lock/temp 布局；在任一变更前拒绝文件系统根、home 本身、共享 tmp 本身、repository/source tree、以及被无关文件占用的目录。测试只用 fixture，绝不对真实 `/`、home、/tmp、repo 做 chmod。
3) 损坏账本是不可变证据：缺失 ⇒ 空；corrupt/unknown-version/wrong-kind/duplicate/sparse/wrong-permission/hardlink/unsafe 使启动与一切 mutation fail closed 并给出固定 sanitized 错误；绝不被改写/截断/重命名/删除；测试断言 bytes+inode 不变。
4) 持久性契约：temp 同目录 O_EXCL|O_NOFOLLOW 0600 → write+fsync → 身份校验 → 原子 rename → 目录 fsync。目录 fsync 错误 FATAL（除窄枚举真正不支持平台集 EINVAL/ENOTSUP/EISDIR，附测试/注释），任意错误绝不吞掉；返回成功/201 即代表按本契约完成发布。
5) 启动锁竞争：listen 前以固定 sanitized 错误失败，无静默降级启动；Host runner 负责正常 SIGINT/SIGTERM 与启动失败的清理。
6) LAN 策略：已认证 LAN worktree create/delete 允许并可写持久 claim；未认证请求由既有 gate 在任何 Git/fs 变更前阻止。无 capability/UI 变更。
7) 最小公开面：index.ts 只导出窄 Host-dir/location/options/error facade（resolvePixHostDir / TrustedRootsLedgerError / 类型），不导出 raw ledger 内部（open/parse/serialize/lock 名）；ProductionResources 保留 trustedRootsLedger（Host runner 优雅关闭需 close() 释放生命周期锁），不保留候选多余输出。

保留的正确性（来自候选，重新加固）：
- 精确 claim schema v1 + 有界最大 claim 数（默认 128，硬上限 1024，确定性 JSON）。
- rehydrate 门禁：canonical path/dev/ino + repo 身份 + worktree base 包含 + `git worktree list` 佐证；local rehydrate 保留 foreign peer claims（并发 Host 被禁，但旧 claim 可能带其它 instance id）；磁盘先于内存授权/提升提交。
- 碰撞与身份替换 fail closed；create 回滚只删精确 owner claim；delete 在 git 删除成功后才移除 claim；restart 绝不复活已删 claim；容量下调/foreign 行为保留磁盘证据并失败，而非破坏性清空。

来源迁移：只迁代码/测试（旧候选 commit db7ebaf / hardening 38c39ae / instance-id 4ba5f5b 从 integrate/d3a-p0-final-gpt-candidate），绝不迁旧文档；不 cherry-pick 文档 commit 6ac977b；当前 main 版本/语义在范围外保持原样。

修改范围：
- packages/host/src/resources/trusted-roots-ledger.ts（新增；生命周期锁、host-dir 安全、损坏账本 fail closed、持久性注入 hook）
- packages/host/src/resources/allowed-roots.ts（ledger 接入：register 磁盘先于内存、unregister、rehydrate 佐证/foreign 保留/容量失败、durable 吸收）
- packages/host/src/composition/production-resources.ts（PIX_HOST_DIR 接线、启动失败释放锁、rehydrate）
- packages/host/src/routes/worktrees.ts（register 传 durable 元数据；回滚日志固定 code/count 不泄路径）
- packages/host/src/index.ts（窄 facade 导出）
- packages/cli/src/commands/host-runner.ts（PIX_HOST_DIR、生命周期锁优雅释放、sanitized 错误）
- packages/host/test/trusted-roots-ledger.test.mjs（新增 28 项聚焦测试）、packages/host/test/production-resources.test.mjs
- tests/e2e/startup.mjs、tests/e2e/sessions-history.mjs（fixture PIX_HOST_DIR）
- docs/refactor-execution-plan.md、docs/migration-ledger.md
- 未改 Protocol/runtime-core/sessiond/adapter/client/package-lock/UI；未触碰/重启 live test-pi.huu.im、端口 30144、默认 live host/sessiond state。

验证（本机 Node v24.18.0）：
- root npm run build EXIT 0；root npm run typecheck EXIT 0；check:architecture PASS；host check:boundaries PASS（39 files）。
- host 297/297（基线 269 + 新增 28 聚焦 ledger 测试）；cli 46/46；adapter 171/171；sessiond 159（158 pass + 1 Windows skip）；runtime-core 7/7；protocol 116/116；runtime-contract-tests 75/75；agent-worker 105/105；client 482/482；scripts 44/44。
- test:e2e:startup PASS（临时 PIX_HOST_DIR/PIX_SESSIOND_DIR/PI_CODING_AGENT_DIR、PIX_ALLOWED_ROOTS 指向一次性 repo、随机端口）：create→ledger→201、graceful Host-only 重启复用 sessiond PID 并恢复文件授权、删除→claim 移除→重启不复活、第二 Host 同目录 LEDGER_LOCK_BUSY 启动前失败、SIGKILL→stale 锁→重启 LEDGER_LOCK_STALE fail closed 且账本字节/inode 不变、显式删除 fixture 锁后重启恢复授权、sessiond down 时 GET 仍在且 POST 在 Git 前 503、无孤儿。
- test:e2e:sessions PASS；test:e2e:runtime PASS。
- git diff --check PASS；工作树 clean。

独立验证：Fresh GPT 以全临时目录/端口复验 Host 297/297、CLI46、Adapter171、sessiond159（1 skip）、Core7、Protocol116、Contract75、Worker105、Client482、Scripts44、Startup/Sessions E2E、architecture/boundaries 全 PASS；另对锁替换/移除、恶意ledger字段、host-dir no-touch、live/stale/PID复用锁、并发register/route create、rehydrate/unregister、启动与bind失败清锁、最小public surface做独立探针，verdict PASS。

残余风险：
- 生命周期锁是「单 Host」的证据性机制而非 OS 强排它：同用户下若外部进程删除/替换锁文件（需同目录写权），严格单 Host 依赖目录权限与操作纪律；发布前每次写都会重验锁 dev/ino，丢失即 fail closed。
- SIGKILL 后必须人工确认旧 pid 已死并显式删除 stale 锁；本切片不提供自动修复命令（父决策明确不做）。
- 目录 fsync 在 EINVAL/ENOTSUP/EISDIR 平台被容忍（文档化）；其余 fsync 错误视为 FATAL，返回失败不报成功。
- Windows 不支持 getuid → 所有权检查跳过（模式/布局检查仍生效）；未在 Windows 真机验证。
- ledger `branch` 元数据当前只拒绝NUL，手工构造的其他C0控制字符可被接受；branch不参与路径、命令或rehydrate判定，属非阻塞输入收紧项。
- production fresh boot会写出合法空ledger，而非等首个claim才创建；无安全影响。
- macOS含symlink路径组件（如`/var`）的PIX_HOST_DIR会严格拒绝，部署应使用realpath。
- 既有 `WORKTREE_CREATE_FAILED` 仍可能携带raw git stderr，这是base既有问题，本分支只收紧rollback日志，后续单独sanitize。
- 已合入 main `f7c9a80`；未部署，当前 `test-pi.huu.im` 与 live host/sessiond 状态未触碰。
```

## 39. D3A Managed-Worktree Foundation — 后端所有权基础（安全发现，UI/路由未接线）

```text
实现：branch feat/d3a-managed-worktree-foundation，base main 1d3ad63。两个聚焦 commit（A 提取共享租约，B 托管账本/域基础）。纯后端 Host 基础，未接线路由、未改 UI/能力/会话/sessiond/Protocol/package-lock；并行 D2 tools/reload 工作树与 live 服务未触碰。UI 必须保持禁用。

安全发现：当前 DELETE /v1/worktrees 把 Git 拓扑成员身份当作删除授权，可删除外部/未授权 worktree。TrustedRootClaimRecord 仅为授权凭据，不能被改作所有权（claim 在 durable root 下可能永不存在或在 promotion 时被吸收；v1 契约明确）。需要一个独立的持久化托管所有权基础，本项只做基础，路由接线留待下一步。

Commit A（9668689）行为保持提取：
- 新内部 packages/host/src/resources/host-state-directory.ts：HostStateDirectoryLease 提取 PIX_HOST_DIR 安全校验/创建、生命周期锁（精确 owner 释放、无 stale 回收）、锁身份校验、有界文档读、原子替换（temp+fsync+rename+dir-fsync）、单进程 mutation 互斥、recognized-entry 布局策略。布局已认可未来 managed-worktrees.json 及 temp pattern，当前 trusted ledger 打开含该 sidecar 的目录不会判 unsafe（回滚兼容）；未知条目仍 fail closed。
- trusted-roots-ledger.ts 改为 lease 之上的薄 adapter：外部窄 facade/schema/error codes/语义/字节输出不变；resolvePixHostDir 仍抛 TrustedRootsLedgerError。仅 2 处静态源码守卫测试改指向共享 lease（其余 27 项 ledger 测试原样通过）。
- lease 不导出 package index。

Commit B（1a1ebd6，合入 main 7a890ca）：托管 worktree 账本/域基础，未 mount 路由：
- managed-worktrees-ledger.ts：独立 sidecar managed-worktrees.json，kind pix.host.managed-worktrees version1，确定性严格 schema；缺失即空，corrupt/unknown/duplicate/sparse/unsafe fail-closed，0600 常规文件无 symlink/hardlink，有界。记录精确管理证据（非 safeToDelete）：worktreeId、path dev/ino、repoRoot repoDev/repoIno、commonDir、adminDir、base 各 dev/ino、createdAt、source=worktree.create、branchAtCreate、branchCreatedByPix。校验绝对 canonical 路径、包含关系（path 严格在 `${repoRoot}-worktrees` 内、dirname(commonDir)==repoRoot、adminDir 在 commonDir 内）、worktreeId/path 去重、safe-int 身份、有界字符串 + 全部 C0/DEL 控制字符拒绝、max records。与 trusted ledger 共用同一 lease（同一锁、同一 mutex，无第二锁），缺省不写。
- managed-worktrees.ts 域服务：recordCreated（磁盘先于内存授权）、findLiveAuthority/classify、commitRemoved（精确 record/path，无 branch/base 删除权）、rehydrate/reconcile（身份+git 拓扑佐证；stale 才精确删；foreign 保留不授权；corrupt 证据不动）。注入窄 runner 佐证拓扑，绝不自动导入 Git worktree 或迁移 trusted-root v1 claim。
- allowed-roots.ts 内部 seam registerManagedAuthorizedRoot（托管 record owner id 为凭据，磁盘提交后内存-only 发布，无 trusted ledger 双写）；durable root promotion 不清除托管所有权。公开 AllowedRootService 接口不变。
- 提供窄内部 factory/types 供未来 production 组合；生产 boot 不实例化/不写 managed sidecar（缺失保持缺失直到首个托管 record）。当前路由/能力不变。

冻结语义（测试覆盖）：legacy trusted claim 永不授予托管/删除权；已 durable AllowedRoot 下创建仍写托管 record + 内存授权、无 trusted claim；外部/planted worktree 判 unmanaged；同一路径 remove/readd 经 inode/admin 身份失效；repo/common/base 替换失败；branch switch/detach 仍 managed；外部删除得 stale record，reconcile 仅按证据安全精确删除；corrupt 证据不动；foreign 保留不授权；无 branch/base 自动删除权；不同 lease/host dir 独立；同一 lease 串行化两文档防 lost update。

验证（本机 Node v24.18.0，worktree 通过 node_modules 符号链接复用 main 依赖）：
- host 348/348（main 基线 309 + 新 13 lease + 11 managed ledger + 15 managed 域）；typecheck/build EXIT 0；check:architecture PASS；host check:boundaries PASS（42 files）；git diff --check PASS。
- Startup E2E PASS（cli 以 worktree host 覆写运行）：trustedRootsLedger/hostDirIsolated/secondHostFailsBeforeListen/deleteNoResurrection/sigkillStaleLockFailsClosed/explicitStaleLockRemovalRestores 全绿；能力面不变。
- Sessions E2E PASS。生产 boot 探针：managed sidecar 缺失保持缺失。
- 未改 main；未 merge/push/deploy；live 未触碰。

残余：
- 当前 DELETE /v1/worktrees 漏洞仍在，直到下一步路由集成 consult 托管账本；UI 必须保持禁用。
- 生产 boot 仍会写出合法空 trusted-roots.json（§38 既有残余，行为保持）。
- 托管 sidecar 未接线 production 组合（未来 createProductionResources 需改为 open 一个共享 lease 再建两 ledger）。
```

## 40. D2-P6 — Runtime Tools + Reload 生产切片记录

```text
实现：本分支（branch feat/d2p6-tools-reload，base main 1d3ad63），backend-first，
未合入/未部署。生产 capability 面从 11 精确扩到 14 token：精确新增
`runtime.tools.read`（get_tools）、`runtime.tools.write`（set_tools）、
`runtime.reload`（reload）；compact/fork/navigate/extension_ui/auto_name 仍关闭。
UI polish 后置（无可见 UI/CSS）。

正确性决策（必须实现）：
1) get_tools 是查询：直接以 correlated result 返回 typed tool 列表，绝不触发
   sessiond authority snapshot refresh（与 get_state/get_commands 同级）。
2) set_tools 加入 sessiond `AUTHORITY_COMMAND_TYPES`：成功结果在 bounded
   worker.getSnapshot 刷新并更新 state.tools + 相关 systemPrompt 之前不得
   release/cache；复用 set_model/set_auto_retry 的同一
   singleflight/triple-match/epoch/rekey/fail-closed 模式（authorityFinalizations /
   ensureAuthorityFinalized）。refresh 失败固定 unavailable（同 type+commandId，
   无 raw transport 文本）并缓存，重试不重入 worker。
3) reload 也必须 authority-finalized：capability 事件（runtime_capabilities_changed）
   只是部分信号，snapshot 必须在成功前收敛 tools、systemPrompt、thinking pin/state
   与最终 capability set（version 递增）。生产 reloadCapabilities 未设置，driver
   reload() 返回构造时的 PRODUCTION_AGENT_CAPABILITIES，绝不拓宽 production 允许集，
   adapter capability gate（requiredCapabilityForCommand）保持精确。
4) `AUTHORITY_COMMAND_TYPES` 精确为既有三个 + set_tools + reload 共五个，仅此而已；
   bash/steer/follow_up/clear_queue/rename/get_tools 均不 refresh。

修改范围：
- packages/pi-sdk-adapter/src/agent/index.ts（PRODUCTION_AGENT_CAPABILITIES 11→14）
- packages/sessiond/src/service.ts（AUTHORITY_COMMAND_TYPES + set_tools/reload；注释）
- packages/sessiond/src/testing/fake-worker.ts（set_tools/reload 权威快照 mutation）
- packages/client/src/runtime/session-store.ts（typed getTools()/setTools(names)/reload()；
  setTools 严格 trim/dedupe/nonempty，all-off 允许 []；走单 inflight sendCommand 槽，
  诚实 session_busy/unsupported_capability，无乐观 state 写入）
- packages/client/src/runtime/runtime-provider.tsx（RuntimeApi 暴露 getTools/setTools/reload）
- tests/e2e/runtime.mjs（PRODUCTION_CAPS 14 token；新增 scenarioD2P6ToolsReload 真实链路：
  initial tools + get_tools typed → set subset/all-off 权威快照 → reload 重应用
  tools/systemPrompt/thinking pin + 最终 capabilities → detach/reattach 持久 →
  unknown-tool invalid_input 结构化失败 → closed compact/fork/auto_name 仍关闭；
  既有 D2-P1/P4/P5 closed-cap 断言从 tools/reload 改为 compact/fork/auto_name）
- packages/agent-worker/test/fixtures/e2e-runtime-factory.mjs（CAPABILITIES 14 token、
  TOOLS 目录、get_tools/set_tools/reload 状态、命令→capability 门禁镜像生产）
- packages/pi-sdk-adapter/test/public-surface.test.ts + production-smoke.test.ts（14 token、
  tools+reload 真实无网络 smoke）
- packages/sessiond/test/sessiond.test.ts（set_tools/reload authority 单测：成功 refresh、
  same-id singleflight、fail-closed 缓存、set_tools vs reload 不同 id、get_tools 无 refresh）
- packages/client/src/runtime/session-store.test.ts + runtime-provider.test.tsx（D2-P6 typed
  helpers + RuntimeApi 暴露）
- docs/refactor-execution-plan.md、docs/migration-ledger.md
- 未改 Protocol/runtime-core/worker 映射/Host/daemon/package-lock/UI；未触碰
  D3A host 资源/ledger/files/worktrees、D1 sessions store。

验证：root test（scripts 44 + cli 46 + agent-worker 105 + client 309 + adapter 190 +
protocol 116 + contract 75 + runtime-core 7 + sessiond 169(1 skip)）全 PASS；
per-workspace typecheck PASS；architecture + 各包 boundaries PASS；
Runtime E2E 2 轮 PASS（单连接真实 Host→sessiond→worker→fixture 贯通 D2-P6 切片，
无孤儿 worker）；Startup/Sessions E2E PASS。

GPT 验证修复（follow-up，本分支追加 commit）：真实 PiSdkAgentRuntimeFactory 的
`set_tools` 曾把名字直接交给 SDK `setActiveToolsByName`，后者静默丢弃未知工具并返回
ok:true（与 canonical fake / E2E fixture 的 invalid_input 不一致）。修复：adapter
`set_tools` case 在 mutation 前用 `driver.getState().tools`（源自真实 `session.getAllTools()`，
含 builtin + 已加载 extension/resource 工具）严格 trim/dedupe 并校验每个名字；首个 blank/
control 名 → `invalid_input` "tool names must be non-empty"，首个未知名 →
`invalid_input` "unknown tool: <sanitized>"（redactText 脱敏、200 字符截断）；失败不调 driver、
不发 runtime_state_changed（无部分 mutation，state/get_tools 不变）；all-off [] 与 trim/dedupe
语义保持。sdk-runtime.ts setTools 同步加防御性校验（对 `session.getAllTools()` 校验并抛结构化
invalid_input），直接 driver 调用或 reload 重应用也绝不静默丢弃；两处规则/目录源一致（非不一致重复
校验），adapter 为权威边界。未改 Protocol wire types/未拓宽 capability。新增真实 factory smoke
回归（unknown/blank/control 失败 invalid_input + 状态不变 + 合法 builtin set + all-off）+ scripted
driver 低层回归；adapter 192/192、command coverage 26/26、root test 1063(1 skip)、typecheck/
architecture/boundaries、Runtime E2E 2 轮、Startup/Sessions E2E 全 PASS。

残余/风险：
- E2E 偶发 all-off 断言失败根因已定位为既有测试助手缺陷，非生产 authority/order bug：
  tests/e2e/runtime.mjs 的 RuntimeWsClient.getSnapshot 使用仅 `Date.now()` 的 wire id，
  同一毫秒内连续两次 getSnapshot 会 id 碰撞，client.waitFor 命中旧的（subset）响应返回
  陈旧投影。D2-P6 场景连续快速 getSnapshot（subset→all-off→reload）暴露了该碰撞。
  修复：getSnapshot wire id 加单调递增 seq（根因修复，无 sleep/无 debug 日志/无超时放宽）；
  修复后 20+12 轮 1-round Runtime E2E 全 PASS，且保留原始单次 getSnapshot 断言形态。
  该碰撞是 pre-existing helper 弱点（未改生产代码）。sessiond 单测（FakeWorker 确定性
  snapshot 响应）证明 set_tools/reload authority 最终化（singleflight/triple-match/
  fail-closed/rekey/epoch）确定性正确；fixture+sessiond 双 trace 亦确认 worker.snapshot
  按 FIFO 有序应用（subset 先、all-off 后），非新引入的 ordering 缺陷。
- 既有 D2-P4 queue 场景在机器高负载连续多轮时仍有 pre-existing flake（clear_queue 后
  getSnapshot 与 queue_update 事件投影传播竞态），与本分支无关，单独记录不混淆。
- reload 通过真实 Pi SDK session.reload() 无网络执行（production smoke 已证明 headless
  PASS）；资源/插件/技能实际重载语义由 SDK 负责，本切片只收敛 snapshot 权威。
- UI/能力面板展示、compact/extension UI/fork 后续。
```

## 41. D3A Managed-Worktree Routes — 路由/组合接线（安全修复，UI 保持只读）

```text
实现：branch feat/d3a-managed-worktree-routes，base main 7a890ca（rebase 到 main dfbd8ee，未动 D2-P6 内容）。在 §39 托管账本/域基础上接线生产组合与 /v1/worktrees 路由，关闭「DELETE 按 Git 拓扑成员身份授权」漏洞。UI 保持只读（无 create/remove/force 控件）；未触碰 package-lock、D2 tools/reload、adapter/client 运行时、live 服务。

安全目标：托管所有权（managed-worktrees ledger）是唯一删除授权；trusted-root/authorized 仅授权、绝不授予删除权。外部/planted/manual/legacy-claim-only 一律 403 WORKTREE_NOT_MANAGED。

生产组合（createProductionResources 重写）：
- PIX_HOST_DIR 只开 ONE HostStateDirectoryLease；用 createTrustedRootsLedgerFromLease + createManagedWorktreesLedgerFromLease 从同一共享 lease 建两 ledger（同 hostDir、同 lockPath、同一进程内 mutation 互斥，无第二锁/无双重打开）。
- validateBeforeLock 同时校验 trusted + managed 两侧车；corrupt/unsafe managed sidecar 启动前 MANAGED_CORRUPT fail closed 且字节/inode 不变（不建锁文件）。缺失 managed sidecar 保持缺失直到首个托管 record（rehydrate 对缺失 sidecar 不再写空文件）。
- 独立 rehydrate：trusted 授权与 managed 所有权各自恢复；legacy trusted v1 claim 只授权、永不迁移/收养为托管。live managed record 才发布内存授权。
- 优雅关闭只 close 一次共享 lease（trustedRootsLedger.close 释放；managed close 为 no-op）；第二 Host 同目录仍 LEDGER_LOCK_BUSY、SIGKILL stale 锁仍 LEDGER_LOCK_STALE fail closed。

路由契约（worktrees.ts 重写）：
- WorktreeDeps 新增 managedWorktrees。POST/DELETE 缺 managed 服务时 503 WORKTREE_MANAGED_UNAVAILABLE（在 Git/fs 前）；GET 只读照常（managedByPix:false）。
- GET 每项加 managedByPix（live record 佐证才 true）并保留 authorized；无缓存 safeToDelete。
- POST：mutation guard → 校验 → safeBranch（含内部空白）→ repo mutex → 现有事务性 git add + post 验证 → recordCreated（capture→disk→memory，无 trusted claim）→ 终局拓扑/授权检查 → 201 {path,branch,managedByPix:true}。持久化失败只回滚事务自有 worktree/新 branch/新建空 base；record 已持久但后续失败先 commitRemoved 精确 record 再 git 回滚；绝不假 201。
- DELETE：mutation guard → 绝对路径校验 → 授权 cwd/repo → repo mutex → 非 main Git 成员 AND findLiveAuthority live:true 且 repo/path/common/admin/base 身份匹配 → busy 预检（exact+descendant）→ 非 force 需干净 → git remove 前立即重验 → git worktree remove（传请求 AbortSignal）→ 验证 path/topology 消失 → commitRemoved 精确 record + 按路径清除 stale legacy trusted claim → 200 {success:true,fallbackCwd:<canonical main>,branchRetained:true}。Git 成功但持久清理失败 → 固定 500 WORKTREE_DELETE_COMMIT_INCOMPLETE（重启 reconcile 丢 stale 行）。
- force 只跳过 dirty/untracked 并恰传一个 --force；不绕过 authority/identity/main/sessiond-down/busy/auth/topology。
- 全部 Git/process 错误 sanitize：固定 code，不泄 raw stderr/path/branch/JSON（含既有 WORKTREE_CREATE_FAILED 泄漏收口）。ManagedWorktreesLedgerError 映射为固定 500 code。

能力/客户端 HTTP 契约（无 UI）：
- 新增能力 token worktree.write（full/sessiond-up only；degraded/down 不含；worktree 仍是只读 list token）。同步 Host types、protocol HostCapabilitySchema、production caps、host-runner、Startup E2E caps。token 仅 discovery 非授权。
- Client：WorktreeInfoSchema 严格加 managedByPix；create 响应解析 managedByPix(literal true)；delete 响应解析 fallbackCwd/branchRetained（新 WorktreeDeleteResponseSchema）。resources.ts 保留 dormant mutation helpers，无 WorktreePanel 控件/import/CSS。

Busy 修正（isolated commit 8260b75）：
- 仅强化 safety 查询 hasBusyCwd：normalized absolute runtime cwd 等于 target 或是 descendant 才 busy（path.relative 包含；/a/bc 对 /a/b 非 descendant）；stopByCwd 保持 exact 语义不变。非绝对 cwd 回退 exact 字符串相等（symlink-text caveat 文档化）。与 D2 tools 对 service.ts 的并行修改隔离。

验证（本机 Node v24.18.0，worktree 通过 symlink 覆盖复用 main 第三方依赖）：
- host 372/372（新 worktrees.test.mjs 20 + resources 43 + trusted-ledger 28 + production-resources 27 + managed-worktrees 16 + managed-ledger 11 + lease 13 等）；client 499/499（新增 worktrees.test.ts 3）；sessiond 160 pass/1 Windows skip；protocol 构建通过。
- root build/typecheck EXIT 0；check:architecture PASS；host check:boundaries 42 files PASS；client boundaries PASS；git diff --check 通过。
- test:e2e:startup PASS（重写）：create→managed sidecar→restart rehydrate（managedByPix+authorized）、external/planted DELETE 403 保留标记、dirty 无 force 409→force 200 且 branch 保留、record 移除→restart 不复活、第二 Host LEDGER_LOCK_BUSY、corrupt managed sidecar MANAGED_CORRUPT 启动前失败且不可变、SIGKILL stale LEDGER_LOCK_STALE、显式删锁恢复、degraded 不含 worktree.write 且 POST/DELETE 503 在 Git/fs 前。
- Sessions E2E 通过；Runtime E2E 通过（scenarioAbort 忙窗口内新增 runtime.hasBusyCwd exact/ancestor/sibling/unrelated 探针）。

残余风险（跨进程 TOCTOU）：busy 预检与 git remove 之间会话可能新起；重新验证在 git remove 前瞬间完成，非原子（无 OS 级跨进程锁）。ledger 生命周期锁是单 Host 证据机制而非 OS 强排它（同用户可删/换锁文件则需目录权限纪律）。本分支未 merge/push/deploy；UI 保持禁用；DELETE 现由托管记录 + 双重活体佐证门控，提交给独立 GPT review 复核。
```

## 42. D3A Managed-Worktree Client UI — 垂直切片记录

```text
实现：独立 worktree d3a-worktree-ui，branch feat/d3a-worktree-ui，base main 13859b1。纯 Client 产品 UI + 测试 + 文档；未改 Host/Protocol/sessiond/adapter/backend 契约、package-lock、live 服务、无关 Runtime UI。实现阶段未改 main、未 merge/push/deploy、未另建 worktree。状态：实现完成，待独立验证（不自行判定 PASS）。

后端契约已在 §39/§41 冻结于 main：GET 严格 `{path,branch,isMain,authorized,managedByPix}`（managedByPix 为 live authority）；POST `{cwd,branch}`→201 `{path,branch,managedByPix:true}`；DELETE `{cwd,path,force}`→200 `{success:true,fallbackCwd,branchRetained:true}`；unmanaged/identity 403、busy/dirty 409、service down 503。Client 既有 dormant mutation helper（resources.worktrees.create/remove）+ createMutationOptions.worktrees.create/remove（onSuccess invalidate worktrees.list(cwd)+cwd.roots）+ 严格 schema 全部原样复用，无后端改动。

冻结产品决策（全部实现）：
1) Open/Switch = Client URL cwd navigation 仅；绝不 Git checkout、绝不 create/attach/stop/move Session、绝不新增 server endpoint。
2) AppShell 保持唯一导航 owner：navigate({to:'/',search:{cwd:path}}) 并显式清掉旧 session search（新工作区不显示旧 session；既有 runtime session 保持存活不触碰）。
3) 整个新工作流（create/open/delete）门控 `worktree.write`；仅 `worktree` 时 panel 字节/行为等价 list-only，既有 no-actions 测试语义不变；cap 撤回立即隐藏控件。
4) create 从任意当前 authorized cwd 开始；仅 free-text branch；新增纯 client validator worktree-branch.ts 逐字节镜像 Host safeBranch（空/长>255/trim≠原值/前导- /NUL+空白+~^:?*[\ /.. /尾. /尾/ /// /@{）；不 auto-trim/reinterpret；input maxLength=255；固定 inline error；发送精确 raw 接受值。
5) Open 仅 authorized:true 且非当前行；unmanaged-but-authorized 可 open 不可 delete；unauthorized external 永不 Open/Delete。
6) Delete 仅 `!isMain && managedByPix`（external/manual/planted/legacy/unmanaged/main 永不渲染）；initial delete force:false；仅精确 409 WORKTREE_DIRTY 揭示 row-local 二次确认（不可逆警告 + 显式「Delete anyway」(force:true) + Cancel）；WORKTREE_BUSY 永不提供 force；无 modal/window.confirm；默认/回返焦点倾向 Cancel（safe escape），cancel 后尽力回焦点原 Delete 控件。
7) create 成功→既有 mutation invalidation + navigate 返回 path（清 session）；delete 成功→若删除 path == 当前 cwd 则 navigate fallbackCwd（清 session），否则保持 cwd；错误/cap 撤回/cwd 变化/stale/late/cancelled 确认永不 navigate。
8) 一次诚实操作跨 create/delete/force：busy 禁用相关控件 + aria-busy，防 double submit（busy guard + mutation.isPending 双保险）；SessionActions 风格 generation/current-capability/current-cwd refs——mid-flight cap 撤回/cwd 变化绝不 navigate 或把 late error 泄漏进新上下文；网络不可取消但 stale completion 对 UI/navigation 忽略；cwd 变化或 cap 撤回重置 confirmation/error。
9) 错误文案 code-first + transport-kind fallback，固定且 sanitize，绝不渲染 Host raw message/path/branch/JSON；映射 INVALID_BRANCH/WORKTREE_EXISTS/WORKTREE_DIRTY/WORKTREE_BUSY/WORKTREE_NOT_MANAGED/MAIN_WORKTREE/WORKTREE_NOT_FOUND/NOT_PROJECT_WORKTREE/REPOSITORY_REPLACED/WORKTREE_CREATE_FAILED/WORKTREE_COMMIT_UNSTABLE/WORKTREE_DELETE_FAILED/WORKTREE_DELETE_COMMIT_INCOMPLETE/MUTATION_UNAVAILABLE+BUSY_PREFLIGHT_UNAVAILABLE+WORKTREE_MANAGED_UNAVAILABLE/MUTATION_ABORTED+PROCESS_ABORTED/auth/network/timeout/unknown 固定 fallback。
10) A11y：label、role=status(polite) vs role=alert、按钮名含 branch/path basename、键盘 form submit、disabled 控件、确认非纯色（文字警告+role=alert）、mobile overlay 不溢出（action flex-wrap + min-width:0 + overflow-wrap）；无新增动画（沿用既有 button active/focus 约定）。

文件：
- 新增 packages/client/src/features/workspace/worktree-branch.ts + worktree-branch.test.ts（纯 validator，13 用例全表）
- 重写 packages/client/src/features/workspace/WorktreePanel.tsx（create/open/delete 单飞行、identity-gated、固定错误映射；保留 describeWorktreeError 列表错误）
- WorktreePanel.test.tsx（新增 mutation 测试，保留既有 list-only 测试；32 用例）
- WorkspacePanel.tsx（传递 canWorktreeWrite + onOpenWorktree）+ WorkspacePanel.test.tsx（write cap 揭示 create 表单等；10 用例）
- AppShell.tsx（handleOpenWorktree 唯一导航 owner，navigate 清 session）+ AppShell.test.tsx（Open→navigate {to:'/',search:{cwd}} 且无 session、当前行无 Open；20 用例）
- packages/client/src/styles/app.css（create/open/delete/confirm/status/error 样式，沿用既有 token 视觉语言，无新动画）
- docs/migration-ledger.md（本 §42）+ docs/refactor-execution-plan.md（D3A 行/当前 checkpoint 刷新）

验证（本机 Node v24.18.0；worktree 经 node_modules 符号链接复用 main 第三方依赖，@fffattiger/pix-protocol 符号链接指向本 worktree packages/protocol 的 fresh dist）：
- Client 全量 549/549（基线 510 + 新增 39：worktree-branch 13 + WorktreePanel 22 + WorkspacePanel 2 + AppShell 2）；typecheck（tsc -b --pretty false）EXIT 0。
- 定向覆盖：no write cap→list-only/无动作 + write cap→create 表单/动作；validator 全表含 255 边界接受/无 auto-trim；create 成功→navigate 返回 path；pending/double submit 恰一次；cap 撤回/cwd 变化 stale 不 navigate 不报错；Open 仅 authorized 非当前且仅 navigation 无 mutation；Delete 仅 managed 非 main（unmanaged/unauthorized/main 无 destructive 控件）；dirty 409→inline confirm；Cancel 无 force 且焦点回 Delete；force 恰一次；busy/无 authority/service down 无 force 固定文案；selected delete→fallback navigate / 非 selected 不 navigate / late 忽略；create/delete 成功均经既有 mutation options invalidate（list refetch）；a11y 查询/焦点/mobile-safe 类结构与 raw malicious marker 不渲染；AppShell Open→navigate 清 session 且零 socket。
- check:architecture PASS、client check:boundaries PASS、git diff --check PASS；Host/Protocol/sessiond/adapter/runtime 零 diff（纯 Client）。

残余/风险：
- 本分支未 merge/push/deploy；待独立验证后合入 main。
- 网络不可取消：stale completion 由 generation 忽略，但网络请求本身仍会到达 Host（documented，决策 8）。
- 焦点恢复经 post-commit effect（确认打开时 Delete 按钮卸载，无法同步 focus），jsdom 已验证。
- 无浏览器视觉验收（仅 DOM/a11y）；create 仍可能因 Git ref 深层限制在服务端失败（客户端按 parity 接受 255 边界，服务端可安全失败）。
- Files/Git 其他 mutation 范围（Files write UI 等）仍不在本切片，不宣称 D3A 全 DONE。
- 后续聚焦 defense-in-depth 提交：`isWorktreeDirty` 强化为要求真实 HttpError **同时** `status === 409` 且 `code === 'WORKTREE_DIRTY'`（冻结 spec 的 exact 409），而非仅 code。新增回归（it.each 400/500）：非 409 却携带 WORKTREE_DIRTY 的 HttpError 绝不出 row-local force 确认、绝不提供 force（仅 initial force:false 一次，固定错误文案）；既有 exact 409 仍揭示确认。

## 43. D2-P7 — Manual Compact + Abort Compaction 生产切片记录

```text
实现：本分支（branch feat/d2p7-compact-control，base main 13859b1），backend-first，
未合入/未部署。Rebase：7230f75 → 185b2de（onto main 4663691，D3A Worktree UI + exact
409 hardening；本记录由 §42 重编号为 §43，main 的 §42 D3A UI 记录与其 hardening note
完整保留；代码文件与 rebase 前逐字节一致，仅 docs 编号/测试数更新）。
生产 capability 面从 14 精确扩到 16 token：精确新增
`runtime.compact`（compact）、`runtime.compact.abort`（abort_compaction）。
fork/navigate/extension_ui/auto_name 仍关闭。无 UI/CSS，无
Host/Protocol/runtime-core 生产改动，无 D3A workspace 文件、package-lock、live
服务、部署。既有 Protocol/runtime-core/worker/adapter 机制已实现；本切片开放生产
门并加 Client API/E2E。`set_auto_compaction` 在既有语义映射下 wire-open（归
`runtime.compact`），这是诚实的（实现存在），但本切片不新增 Client helper/UI。

正确性决策（父级明确覆盖最小探索建议，必须实现）：
1) 成功的 `compact` 必须加入 sessiond `AUTHORITY_COMMAND_TYPES`（既有 5 + compact
   = 精确 6）。`compaction_end` 只清活动状态，不携带 post-compaction 的
   messages/messageCount/contextUsage，所以成功 compact 必须在有界
   worker.getSnapshot 权威刷新应用完整 post-compaction snapshot 之后才
   return/cache。复用 set_tools/reload 的同一 singleflight/triple-match/epoch/
   rekey/fail-closed 路径（authorityFinalizations / ensureAuthorityFinalized）。
   断言 messages/history 数、contextUsage、isCompacting/compaction/streaming 与
   capabilities 收敛。刷新失败 return/cache 固定 unavailable；同 commandId 重试
   永不重执行。失败/中断的 compact 绝不触发 authority refresh 或缓存假成功。
2) getSnapshot 等其余命令不变；AUTHORITY 精确 6。set_auto_compaction 不加入
   authority（既有语义未要求）。
3) Adapter compact busy guard：在状态 mutation / SDK 调用之前防御性拒绝结构化
   `session_busy`——当前真实 driver 状态为 streaming、bash running 或 already
   compacting（及 adapter 本地 promptRunning/bash/compaction 在途）时拒绝；绝不让
   真实 SDK 直接 wire 覆盖 prompt 或叠 bash。拒绝不留任何部分 compaction
   state/event。manual compact customInstructions 严格跟随 Protocol（Client
   helper 校验非空/边界，绝不静默 trim/reinterpret——原值直传）。
4) abort_compaction 是独立 RuntimeInterrupt，经既有 Host/sessiond 路径非 HOL；
   同 id 同 type 合并，异 interrupt type session_busy/rejected，idle 幂等 ok。
   真实 SDK 行为：abort ack 可为 ok:true 而 in-flight compact command 落
   ok:false interrupted；fixture/E2E 镜像此语义，发 compaction_end{aborted:true}，
   清 compaction 状态，无孤儿 hold。
5) Client（无 UI）：SessionStore 加 typed `compact(customInstructions?)` 走普通单
   pendingCommand 槽（prompt/bash/tools/reload/compact 冲突诚实 session_busy，无
   乐观 state）；`abortCompaction()` 走 typed sendInterrupt admission。两者都暴露到
   RuntimeProvider RuntimeApi。detach/session switch/stop/dispose/reconnect/epoch
   清理：in-flight compact 恰好一次 reject 并释放槽（genericize Bash 的
   settlePendingBashCommand → settlePendingControlCommand，覆盖 bash+compact，不
   改 prompt 语义）；迟到 result/event 不能 settle 新 session。

修改范围：
- packages/pi-sdk-adapter/src/agent/index.ts（PRODUCTION_AGENT_CAPABILITIES 14→16；
  注释注明 set_auto_compaction wire-open 但无 Client helper/UI）
- packages/pi-sdk-adapter/src/internal/adapter.ts（compact 前置 busy guard：
  isStreaming/isBashRunning/isCompacting/promptRunning/bash/compaction 在途 →
  session_busy{retryable:true}，mutation/SDK 前；try/finally 清 running marker，
  失败后快照 isCompacting:false 无 pending compaction）
- packages/sessiond/src/service.ts（AUTHORITY_COMMAND_TYPES + compact 精确 6；
  注释更新 authority/ensureAuthorityFinalized 语义）
- packages/sessiond/src/testing/fake-worker.ts（compact 权威快照 mutation：确定性
  trim messages 至后 2 条、messageCount、contextUsage percent-40/tokens-400、
  isCompacting:false）
- packages/client/src/runtime/session-store.ts（typed compact()/abortCompaction()；
  settlePendingControlCommand genericize；customInstructions 严格校验非空、原值直传）
- packages/client/src/runtime/runtime-provider.tsx（RuntimeApi 暴露 compact/abortCompaction）
- tests/e2e/runtime.mjs（PRODUCTION_CAPS 16 token；新增 scenarioD2P7CompactControl
  真实链路；旧 closed 数组只移除 compact，fork/navigate/auto_name 保持关闭）
- packages/agent-worker/test/fixtures/e2e-runtime-factory.mjs（CAPABILITIES 16、
  INTERRUPT_REQUIRED_CAP 门禁、compact/abort_compaction/set_auto_compaction 状态、
  确定性 compact trim + __block__ hold（≤30s 硬 failsafe，非验收超时）+
  abort_compaction 释放）
- packages/pi-sdk-adapter/test/public-surface.test.ts + production-smoke.test.ts +
  新增 compact-busy.test.ts（16 token、真实无网络 compact 失败/幂等 abort/
  set_auto_compaction 离线、busy guard 定向）
- packages/sessiond/test/sessiond.test.ts（compact authority 单测 10 个：
  成功 refresh 全字段收敛、same-id singleflight、fail-closed 缓存、vs
  set_tools/reload 不同 id、wrong result type、失败/中断不 refresh 不缓存假成功、
  rekey 不跨 epoch、early crash 清 singleflight、compaction_end 先于 snapshot 仍
  收敛、事件/能力收敛）
- packages/client/src/runtime/session-store.test.ts + runtime-provider.test.tsx
  （D2-P7 typed helpers + RuntimeApi 暴露 + 投影）
- docs/refactor-execution-plan.md、docs/migration-ledger.md（本 §43）
- 未改 Protocol/runtime-core/Host/daemon/package-lock/UI；未触碰 D3A 资源/ledger/
  worktrees、D1 sessions store。

验证（本机 Node v24.18.0）：
- root `npm test`：scripts 44 + cli 46 + agent-worker 105 + client 566（36 files，含
  D3A Worktree UI 与 compact 测试）
  + host 372 + adapter 206 + protocol 116 + contract 75 + runtime-core 7 +
  sessiond 178 pass/1 skip = 1715 pass/1 skip/0 fail。
- per-workspace typecheck（含 sessiond tsconfig.test）PASS；root typecheck EXIT 0；
  root build EXIT 0；check:architecture PASS；adapter/sessiond/agent-worker/client/
  host boundaries PASS；`git diff --check` 通过。
- Runtime E2E 2 轮 PASS：单连接真实 Host→sessiond→worker→fixture 贯通 D2-P7
  切片（初始 history→成功 compact 事件序列+权威 post-snapshot
  messageCount/contextUsage/history 收敛→detach/reattach 持久→blocking compact +
  abort_compaction 非 HOL + interrupted result + aborted projection→idle abort→
  第二连接 second ordinary compact session_busy→closed fork/navigate/auto_name→
  无孤儿）。Startup E2E、Sessions E2E PASS。
- 真实 PiSdkAgentRuntimeFactory 无网络 smoke（production-smoke）：tiny/fresh
  session compact 结构化失败（无 raw SDK/secret），快照 isCompacting:false 无
  pending compaction；idle abort_compaction 幂等 ok；set_auto_compaction 离线设置
  生效；capability 精确 16。不宣称离线成功真实 compact，不联网。

设计说明：
- E2E 中 `runtime.getSnapshot` 返回 sessiond projection（无 worker fetch），所以
  compact 前 contextUsage（无事件携带）需经 get_state 读 fixture 实时值；compact
  后 authority refresh 已把 projection 替换为 post-compact snapshot，getSnapshot
  直接证明投影收敛。Host gateway serial lane 保证普通命令不并发，因此「第二普通
  命令 session_busy」在 E2E 用第二浏览器连接（独立 serial lane 立即 dispatch、
  fixture isCompacting guard 命中）诚实验证；单连接第二命令会被 Host 串行排队。
- fixture/E2E 镜像真实 SDK：abort ack ok:true + in-flight compact 落 interrupted +
  compaction_end{aborted:true} + 清状态 + 无孤儿 hold（abort 后 fresh compact 立即成功）。

GPT 独立验证 FAIL → 修复（follow-up 提交，同 worktree，未 merge/push/deploy）：

F1 HIGH（真实生产复现）：任意已完成 bash 之后 compact 永久 session_busy —— adapter compact
busy guard 曾用 `this.bash !== null` 判 busy，但终态 bash projection（completed:true）永久
保留。修复：guard 只在 ACTIVE bash 时拒绝——真实 driver `isBashRunning` 或 adapter 本地
非终态 projection（`this.bash.completed === false`，覆盖 SDK state 尚未翻转的并发窗口）；
终态 completed:true 不再阻塞。保留直接并发 bash-vs-compact 保护。
- 真实 PiSdkAgentRuntimeFactory smoke：完整 `bash echo`（isBashRunning:false,
  bash.completed:true 保留）后 compact 必须到达 SDK，tiny-session 返回结构化非 busy 失败
  （实测 code=external "Nothing to compact (session too small)"，绝无 session_busy）；状态
  干净（isCompacting:false、无 compaction）。
- 确定性 adapter 并发测试：active（非终态）bash 仍 session_busy/零 compact SDK 调用；终态
  bash 不再阻塞（compact 到达 SDK 恰一次）。
- Runtime E2E D2-P7 会话在成功 fixture compact 前先完成一个 bash，钉住该产品序列（未削弱
  既有 D2-P5）。

F2 MEDIUM：start compact → abort_compaction 把 projection 翻为 `aborting` → driver.compact
throw 且无 SDK compaction_end → 原 finally 只清 `running`，遗留 adapter 快照
isCompacting:true/status aborting。修复：exact-owner 清理（startedAt 为所有权键，abort
flip 保留、canonical end 置空、不可能的新 compaction 不同 startedAt 绝不清掉）对 running 与
aborting 一并清理；若该 lineage 的 manual compaction_start 已转发（sessiond 见过 start）而
无 end，则补发一条合成 compaction_end（aborted 依状态），sessiond/client projection 清除；
SDK 已发 end 时 this.compaction 已 null，绝不重复发。compact 结果保留 interrupted、abort
ack 保留 ok:true。
- 回归（mock driver 发 start → abort → throw 无 end）：adapter 快照干净、恰一次合成 end
  清投影；SDK 正常 start+end 不 double-emit。

复验：adapter 206/206（compact 定向 32）、sessiond 178/1skip（compact authority 18，
失败仍无 authority refresh/假成功）、client 566/566 不受影响、Runtime E2E 2 轮（含 D2-P7
bash→compact pin 与 D3A busy probes）、root test 1715/1skip、typecheck/build/architecture/
boundaries、Startup/Sessions E2E、diff-check 全 PASS。不自行判定 PASS，交同一 verifier 复检。

残余/风险：
- 未做视觉/UI 验收（本切片无 UI）；compact/extension UI/fork 后续。
- 本分支未 merge/push/deploy；提交前工作树 clean。独立验证按 multi-layer backend
  state change 规则另行执行（不自我宣称最终 PASS）。
(feat(adapter,sessiond,client,e2e): D2-P7 manual compact + abort compaction slice)
```

## 44. D4 Session-Rename Adapter Foundation — 离线重命名 adapter/runtime-core 地基记录

```text
实现：source branch feat/d4-session-rename-adapter（base main 125d0a6，source a266b01），
backend-first FOUNDATION ONLY；Fresh GPT 独立持久化/并发审查 PASS，已合入 main
`953640b`，未部署。后续 sessiond 切片负责选择 live vs offline 并加
activation fence；本切片不开放任何 Host 路由/capability，不接 sessiond production
（其 SessionMutationPort stub 未动），不改 live `set_session_name`，无 Client API/UI。

范围（允许文件，全部在既有 domain 内，不重叠 session-delete Host/UI 分支或 extension UI
adapter.ts/index 分支）：
- packages/runtime-core/src/ports.ts：新增 `SessionMutationPort`——仅
  `renameSession(sessionId, name): Promise<void>`，与只读 `SessionCatalogPort` 分离；
  catalog 保留既有 deleteSession（向后兼容，不污染只读接口）。无 Pi SDK 类型。
- packages/pi-sdk-adapter/src/sessions/index.ts：`PiSdkSessionStore` 增加
  `renameSession`；新增 `PiSdkSessionMutation implements SessionMutationPort` 与
  `createPiSdkSessionMutation()`；`createPiSdkSessionPorts()` 返回
  catalog+locator+mutation 共享 ONE PiSdkSessionStore（既有 `{catalog,locator}`
  destructure 向后兼容）。默认 store 私有、lazy、零网络/零 Worker，public d.ts 无 SDK 泄漏。
- packages/pi-sdk-adapter/src/internal/session-store.ts：`PiSdkSessionManager` 增
  `appendSessionInfo(name)`；`renameSession` 实现 + 名字规范化 + 错误 sanitize +
  即时 invalidate；per-session 串行化队列（rename+delete 共享）。

冻结契约实现：
1) runtime-core `SessionMutationPort.renameSession` 仅此一法；read-only catalog 保持原样。
2) `createPiSdkSessionPorts()` 三端口共享一 store；`createPiSdkSessionMutation` 提供。
3) `PiSdkSessionStore.renameSession`：
   - 用既有 exact open/index path + `manager.getSessionId` 身份校验；missing/stale/wrong
     id → not_found，绝不新建 session、绝不 append 到复用路径（fail closed）。
   - 名字规范化与 live rename UX 一致：trim 外层空白；空白拒绝；≤200 Unicode JS code
     units（UTF-16 length，freeze 常量 MAX_SESSION_NAME_LENGTH=200 并测试 200/201/emoji
     计数）；拒绝 NUL 与 C0(\u0000-\u001f)/DEL(\u007f) 控制字符而非静默存隐形控制文本；
     内部空格与 Unicode/emoji 允许。canonical name 直传 SDK `appendSessionInfo`；不改
     header/file。
   - append 失败映射为结构化 sanitized external/retryable file-kind 错误（cause.kind=
     "file"，无 path/raw SDK message/name 泄漏）；not_found 保持 canonical。
   - 成功 append 后立即 invalidate 同一共享 store 的 list/index：next
     listSessions/readSession 立即看到新标题（无 30s 陈旧窗口）。标题真相源 = JSONL 文件
     最新 session_info entry（SDK listAll `name` 与 getSessionName 同源；detail 复用
     listAll 的 info.name，故 list 与 detail 一致）。
4) per-session mutation 串行化共享 rename 与 delete：同 id FIFO（rename/rename 最后提交
   append 胜；rename/delete 两顺序确定性——delete 先则 rename not_found 且绝不重建/
   append；rename 先则 delete 移除已改名文件）；不同 id 各自队列并行（无全局锁）；
   每 mutation 只取一个 per-session slot（无嵌套→无死锁），空队列移除（bounded cleanup，
   存储 tail 恒 resolve 无 unhandled rejection）；delete ENOENT 幂等语义与全部
   revision/negative-cache fence 原样保留。
5) 外部 path/file 身份竞争仍在既有 openSession 校验下 fail closed；不扩大到 filesystem
   事务 redesign；绝不 delete/rename 一个被复用的不同 session path。
6) live `set_session_name`（agent adapter）未动；无 capability 开放。

验证（本机 Node v24.18.0）：
- runtime-core 9/9（新增 2：mutation port 仅 renameSession 的 compile-time 精确断言 +
  runtime 断言；read-only catalog 无 renameSession）；runtime-core typecheck/build PASS。
- adapter 223/223（基线 206 + 新增 17 定向）：
  - 真实 JSONL：rename append session_info、file/sessionId/history/context 不变、list 标题
    即时可见（无 TTL wait）、全新独立 store 重开持久。
  - 名字：trim、空白/201/NUL/全部 C0+DEL/非字符串拒绝且零 append、Unicode/emoji/内部空格
    接受、恶意名绝不进入 error/log。
  - 身份：missing/wrong id/stale path/path reuse 绝不改另一文件（append 计数 0）；
    append 失败 sanitize（无 path/raw message/name）；共享缓存即时刷新且 bounded 单次
    rescan（warm rename 零额外 scan）。
  - 并发：同 id rename FIFO 最后提交者胜；delete→rename not_found 且文件保持删除；
    rename→delete 移除；重复 delete not_found；不同 id 并行（一个 rename 在另一 session
    mutation in-flight 时完成——无全局锁；被 supersede 的 in-flight rename fail closed
    not_found 且零 append）。
  - public surface：mutation factory 方法面恰 renameSession、无 SDK 名、lazy/零 Worker；
    createPiSdkSessionPorts 三端口共享 store + 向后兼容 destructure；separately created
    pair 独立（rename 不跨 pair 泄漏）。
- adapter boundaries PASS（21 source / 10 public declarations 无 SDK/internal 泄漏）；
  command coverage 26/26 PASS；`git diff --check` PASS；工作树 clean 后提交。
- 未改 Protocol/runtime-core 生产行为（ports.ts 仅新增接口）、sessiond/Host/Client/
  package-lock/daemon；未触碰 D3A 资源/ledger/worktrees。

设计说明：
- SDK `appendSessionInfo` 内部会 trim 并把 \r\n 替换为空格；本切片在 SDK 前已拒绝全部
  C0/DEL，故传入 canonical name 时 SDK 的再清洗是无操作，绝不会引入隐形控制文本。
- per-session 串行化不锁读路径（list/read 仍可并发），与既有 read 并发语义一致；
  成功 mutation 的 invalidate 是保守的共享缓存失效，被 supersede 的 in-flight 扫描
  fail closed（与既有 delete/read 行为一致，非数据损坏）。

残余/风险：
- 未做 Host/sessiond/Client 接线与 UI 验收（本切片无 UI/无路由）；sessiond 后续选择
  live vs offline + activation fence。
- source 分支提交前工作树 clean；Fresh GPT 已完成持久化、身份、缓存与并发对抗审查并判定
  PASS；main 集成后 runtime-core 9/9、adapter 223/223、两包 typecheck、architecture 与
  diff-check 再次 PASS。未 push/deploy。

## 45. D2-P8 — Extension UI Backend 生产切片记录

```text
实现：source branch feat/d2p8-extension-ui-backend（base main 125d0a6，source
`f568eeb`），backend-first；Fresh GPT 独立 multi-layer 审查 PASS，已集成 main，未部署。
生产 capability 面从 16 精确扩到 17 token：精确新增
`runtime.extension_ui`（extension_ui_response / extension_ui_input）。fork/navigate/
auto_name 仍关闭。无 Client UI/CSS，无 Client SessionStore helper；E2E 浏览器 helper 直接
发原始 extension 命令。sessiond `AUTHORITY_COMMAND_TYPES` 未改（extension 命令不进
authority——不携带需权威快照收敛的 state，close 事件本身收敛投影）。未触碰 D4 session
delete 文件、side chat、fork/navigate、package-lock、live 服务、部署。

根因：既有多层机制已实现 extension_ui_response/input（Protocol schema、runtime-core 模型、
worker mapper、adapter settle、sessiond/client 共享 projection），但生产 capability 关闭且
projection 从不删除已 settle 的 pending UI 请求（settle 后 pendingExtensionUi 永久残留，
detach/reattach/replay 会复活幽灵弹窗）。本切片安全打开并做投影收敛硬化。

冻结设计（父级明确覆盖，必须实现）：
1) capability 精确 16→17，单 token 诚实覆盖 extension_ui_response 与 extension_ui_input。
2) 投影收敛使用既有 canonical `ExtensionUiRequest.closed?: boolean` 概念（非 sessiond
   authority snapshot）：
   - Protocol ExtensionUiRequest schema/event shape 加 strict optional `closed`
     （z.literal(true).optional()，仅 true 合法；runtime-core 已建模，align 所有 DTO）。
   - Adapter `finishUiRequest` 是唯一 settle 漏斗：任何原因 settle（成功响应、cancelled、
     abort/prompt interruption、SDK timeout/signal/onSettled）都对该请求发出恰一次
     canonical `extension_ui_request` close tombstone（closed:true），然后 race-safe
     顺序删除 pending map / emit state。registerUiRequest 先 publish 再注册 onSettled
     （同步 settle 不会在发布前发 close；close 顺序确定 request→close）。
   - Protocol 纯 reducer：普通请求按 requestId upsert；closed:true 删除该 requestId 且
     永存 tombstone；未知 close 幂等 no-op；保留无关请求/顺序。sessiond/client 都委托
     此 reducer，detach/reattach/replay 不能复活。
   - subscribe/replay 只回放 active pending（closed 已从 map 删除）。
3) 方法相关性硬化：
   - Protocol wire 命令已带 requestId+method；runtime-core response/input 命令必须保留
     `method`（worker mapper 不再丢弃）；adapter 对 response 与 input 都校验 pending
     请求精确 method，错 method ⇒ 结构化 invalid_input、请求保持 pending/usable、不
     settle/不 input/不 close；unknown id ⇒ not_found；cancelled 按 schema 对交互方法允许。
   - 保持既有 result-method shape 校验，无 value coercion/trim/logging；用户文本永不
     入日志、错误只含 request id 已 sanitize。
4) 无 sessiond AUTHORITY_COMMAND_TYPES 变更。response/input 必须与占用普通 client 命令槽的
   prompt 交错。探索假设被父级纠正：`runtime.command(prompt)` 经 sessiond 一直 await 到
   turn 恢复，所以单连接 Host serial lane 被 prompt HOL 阻塞——extension_ui_response/input
   走普通 serial 会死锁。最小修复在 `packages/host/src/composition/runtime-gateway.ts`：
   把既有 queuedTurnSerial 泛化为 interleaving lane（isQueuedTurnCommand →
   isInterleavingCommand），容纳 steer/follow_up + extension_ui_response/input 四类；
   复用同 count/byte limits、overflow close1009、lane-safe 记数/raw-frame redaction、
   browser-close 双 lane short-circuit、FIFO 确定序、close 后无额外 RPC；create/getSnapshot/
   普通命令仍留 serial lane；不新增 Host lane。真实链 E2E 钉住单连接 prompt→request→response
   交错。
5) 本 backend 切片无 Client SessionStore helper/UI；UI 是下一依赖切片。
6) 交互方法覆盖 select/confirm/input/editor/custom（按既有 schema/driver 行为）；notify/
   status/widget/title 是事件/state 非用户响应请求；SDK unsupported stub 仍 unsupported，
   不发明行为。

修改范围：
- packages/protocol/src/extension.ts（ExtensionUiRequestSchema 全 10 variant 加 strict
  closed marker；新增 ExtensionUiInteractiveMethodSchema/type）
- packages/protocol/src/projection.ts（reducer：closed:true 删除且永存 tombstone；未知
  close 幂等；保序）
- packages/protocol/src/type-contract.test.ts + 新增 test/extension.test.mjs（16 用例：
  closed schema、reducer add/close/unknown-close/replay/multi-id、交互方法精确、response/
  input method correlation、wrong result variant schema 拒绝）
- packages/runtime-core/src/commands.ts（response/input 命令加 method 字段；
  ExtensionUiRequest.closed 已建模）+ 新增 src/extension-commands.test.ts（3 用例：
  method 精确 type、closed marker、JSON 序列化）
- packages/agent-worker/src/mapper/command-mapper.ts（response/input 保留 method）
- packages/agent-worker/src/mapper/core-to-protocol.ts（mapExtensionUiRequest 保留 closed
  marker——否则 close tombstone 经 worker 被丢弃、投影永不删除；关键修复）
- packages/agent-worker/test/mapper/command-mapper.test.ts（method 保留断言）
- packages/agent-worker/test/fixtures/e2e-runtime-factory.mjs（CAPABILITIES 17；
  __confirm__/__input__/__select__/__editor__/__custom__ emit pending request 并 block
  至正确 response；__status__/__widget__/__title__/__notify__ 事件；恰一次 close
  tombstone；exact-method 校验；≤30s 硬 failsafe 仅防挂死、不把失败转 pass；abort/close
  cancel 全部 pending 并发 close）
- packages/pi-sdk-adapter/src/agent/index.ts（PRODUCTION_AGENT_CAPABILITIES 16→17 +
  runtime.extension_ui）
- packages/pi-sdk-adapter/src/internal/adapter.ts（resolveUi/inputUi exact-method 校验
  invalid_input；finishUiRequest 恰一次 close tombstone + race-safe delete/emitState；
  registerUiRequest 先 publish 后 onSettled；cancelPendingUi/close 经 finishUiRequest
  兜底清理；inputUi 签名改收 command）
- packages/pi-sdk-adapter/test/extension-ui.test.ts（新增 12 用例：capability 17、
  add→response→close、wrong-method invalid_input 保持 pending 后正确 method 可用、
  unknown not_found、cancelled 恰一次、input exact-method/不 close、settle+cancel race
  恰一次、late response not_found、abort 每请求一 close、subscribe replay 只 active、
  错误只含 id 不泄用户文本）+ public-surface.test.ts/production-smoke.test.ts（17 token、
  extension_ui open 真实到达 adapter 非 unsupported）
- packages/host/src/composition/runtime-gateway.ts（isInterleavingCommand 泛化 queued-turn
  lane 容纳 extension_ui_response/input；interleavingSerial 重命名；注释/日志 lane 名更新）
- packages/host/test/runtime-gateway.test.mjs（D2-P8 定向 5 用例：prompt HOL 时
  response/input 在 interleaving lane 立即 dispatch FIFO；getSnapshot 仍 HOL；lane
  overflow close1009 无额外 RPC；extension flood 不能绕过 limits 且不泄 raw；browser
  close short-circuit）
- packages/sessiond/test/sessiond.test.ts（+2：close tombstone 删除 + unknown close
  no-op；attach convergence add→detach→reattach 见 pending、close 后 replay 不复活、
  多 pending 只删精确 id）；service.ts 未改
- packages/client/src/runtime/projection.test.ts（+1 close tombstone 删除/不复活）
- packages/runtime-contract-tests/src/suite.ts + fake/runtime.ts（response/input 调用加
  method；reference runtime exact-method 校验；+1 wrong-method 用例）
- tests/e2e/runtime.mjs（PRODUCTION_CAPS 17；新增 scenarioD2P8ExtensionUiControl 单连接
  真实链：confirm wrong-method invalid_input 保持 pending + 正确 response 经 interleaving
  lane 恢复 prompt + unknown/late not_found + same-commandId at-most-once 无重复 close +
  detach 前 response→reattach 见 pending（第二连接 detach 因 serial HOL）+ response 后
  detach/reattach 见 none（replay 不复活）+ input/editor incremental exact-method + select
  cancel + custom lines + abort 清 pending + status/widget/title/notify 事件 + closed
  fork/navigate/auto_name + reload 不能 broaden）
- docs/refactor-execution-plan.md、docs/migration-ledger.md（本 §45）

验证（本机 Node v24.18.0）：
- 独立复验 root `npm test`：scripts 44 + cli 46 + agent-worker 105 + client 567 + host
  377 + adapter 219 + protocol 132 + contract 76 + runtime-core 10 + sessiond 180 =
  1756 pass/1 skip/0 fail；source 记录的 1755/adapter 218 为提交前计数漂移，已以 verifier
  实测修正。
- per-workspace typecheck PASS；root typecheck EXIT 0；root build EXIT 0；
  check:architecture PASS；boundaries（runtime-core/client/sessiond boundary tests）PASS；
  `git diff --check` 通过。
- Runtime E2E 2 轮 PASS：单连接真实 Host→sessiond→worker→fixture 贯通 D2-P8 切片
  （confirm wrong-method→correct resume 同 socket；detach/reattach 持久与 close 后不复活；
  input/editor incremental；select cancel；custom；abort 清 pending；status/widget/title/
  notify 事件；closed fork/navigate/auto_name；reload 不 broaden；shutdown 无孤儿）。
  Startup E2E、Sessions E2E PASS。
- 关键路径：`runtime.command(prompt)` 一直 await 到 turn 恢复 ⇒ 单连接 serial lane 被
  prompt HOL；extension response/input 走泛化 interleaving lane 立即 dispatch，同 socket
  不 session_busy、prompt 恢复。E2E 用同一 RuntimeWsClient（同一 WS）验证 prompt→request→
  response/input；detach/reattach 持久性检查用第二连接（detach 是普通 serial 命令，单连接
  会被 prompt HOL——文档化设计）。

设计说明：
- close tombstone 走 adapter `finishUiRequest`（Core event）→ worker mapper
  `mapExtensionUiRequest`（必须保留 closed）→ Protocol `extension_ui_request` 事件 →
  sessiond/browser 共享 reducer 删除。replay/attach 都以 reducer 收敛，无法复活。
- `mapExtensionUiRequest` 保留 closed 是 E2E 能通过的关键（否则 tombstone 被 mapper 丢弃，
  投影把请求当 upsert 重新加入）。
- Adapter/参考 runtime/fixture 三层都镜像 exact-method 校验；Protocol schema 拒绝 wrong
  result variant（select+value、input+confirmed、confirm+selected 等）fail-closed。

残余/风险：
- 未做视觉/UI 验收（本切片无 UI）；Client SessionStore helper/UI 是下一依赖切片。
- Host interleaving lane 现在容纳 steer/follow_up + extension_ui_response/input 四类
  （D2-P4 语义未变，仅 lane 名/log 从 queued-turn 改 interleaving；既有 D2-P4 Host 测试
  相应更新 lane 名断言）。单连接 serial lane 仍 HOL getSnapshot 等普通命令于运行中 prompt
  之后（文档化 LOW，非本 slice 目标）。
- 真实 SDK 的 input/editor 增量行为以 fixture 建模（input 收集增量、final response settle）；
  未对真实 SDK 发起无网络 UI 交互 smoke（无 extension 可在无网络环境触发 select/input）。
- source 分支提交前工作树 clean；Fresh GPT 已完成 Protocol/Reducer/Mapper/Adapter settle/
  Host lane/epoch-replay 与 97+ 对抗探针审查并判定 PASS；已集成 main，未 push/deploy。
(feat(protocol,runtime-core,worker,adapter,host,sessiond,e2e): D2-P8 extension UI backend slice)

## 46. 跨平台安全工具子集 — run-node-test / remove-paths / tool-invocation 记录

```text
实现：source branch feat/cross-platform-tooling（base main 125d0a6，source `ac16a44` +
hardening `e06a052`），安全子集 reimplementation，灵感来自 closed PR #3 但按最终
评审决定适配当前 main，未整体 merge/cherry-pick PR commit。Fresh GPT 第二轮独立验证
PASS；已合入 main `417f1c9` + `776fbe5`，未部署。保留 main 的 scripts/run-workspaces.mjs
及其测试（不替换为 raw npm workspaces）；只移植 test-glob、clean/remove、JS CLI
invocation 三个跨平台概念；未复制 PR 的 E2E 改动（原 PR E2E 非 hermetic，401 泄漏
daemon）。无 daemon/Named Pipe/PowerShell/lifecycle/Host ledger/git route 改动，无
live 服务，无 package-lock 依赖变化。

新增三个 Node 内置脚本（全部 shell:false、无 .cmd、无 PATH shim 依赖）：

1) scripts/run-node-test.mjs + run-node-test.test.mjs —— 确定性跨平台测试运行器。
   接受一个或多个 glob/path pattern + node --test flags 透传（`--` 分隔符可转义以
   `-` 开头的 pattern；以 `-` 开头者为 flag）。用 Node 内置 globSync 在 Node 内展开
   （无 shell/cmd glob），归一 `/` 与 `\`，排序去重（按 realpath），仅 regular file，
   排除 realpath 逃逸 cwd 的 symlink。任一 pattern 匹配零个 → exit 1 + 固定消息
   （Node24 裸 `node --test 'glob'` 匹配零可 exit 0，故 fail-closed）；字面量缺失
   路径用不同固定消息（test path not found）。spawn `process.execPath --test
   <flags> <files>`，shell:false，继承 stdio，转发子进程 exit code 与 termination
   signal（re-raise）。Windows 安全的 argv（空格/Unicode/CRLF/反斜杠 glob/盘符路径）
   以 macOS 上的字符串级单元探测覆盖。CLI 包测试保留 `--test-concurrency=1`
   （CLI 测试变更 process-global env / machine endpoint 状态）。

2) scripts/remove-paths.mjs + remove-paths.test.mjs —— 安全跨平台 `rm -rf` 替代。
   只删除显式给定的相对 cwd 路径；拒绝空串/NUL/根/盘符根/UNC 根/cwd 本身/父级
   逃逸/经逃逸 symlink 组件到达的路径（按 realpath 比较，macOS /var→/private/var
   不误报）；顶层 symlink 作为链接删除、绝不跟随其 target（fs.rm 语义 + 前置
   realpath 祖先守卫，防止 link/sub 型穿透删除）。fs.rmSync recursive force +
   有界 Windows 瞬态 EPERM/EBUSY/ENOTEMPTY 重试（maxRetries:5/retryDelay:100）；
   持久失败诚实 nonzero（exit 1）+ sanitized 消息（无堆栈）。空格/Unicode/只读文件/
   symlink fixture 在当前 OS（macOS）可移植范围内覆盖。无 `rm -rf` shell。

3) scripts/tool-invocation.mjs + tool-invocation.test.mjs —— tsc 与 npm 的 JS CLI
   安全解析。resolveTscInvocation(workspaceRoot)：createRequire 锚定 workspaceRoot，
   require.resolve("typescript/package.json") 取包元数据 bin.tsc 得到 JS CLI 路径
   （不依赖 node_modules/.bin 布局），返回 {command:process.execPath,args:[cli],
   shell:false}；缺 typescript/无 tsc bin/CLI 文件缺失 → 固定错误。resolveNpmInvocation：
   只用 npm 生命周期契约的 npm_execpath（须为存在的 npm-cli.js），返回
   {command:process.execPath,args:[cli],shell:false}；无 PATH npm/npm.cmd 回退、
   无用户可控包任意执行。失败固定消息（run this script through npm / npm ci）。

集成：
- 五个依赖构建脚本改用上述 helper：agent-worker/pi-sdk-adapter/sessiond 的
  build-deps.mjs 用 resolveTscInvocation，cli/host 的 prebuild-deps.mjs 用
  resolveNpmInvocation；删除各自 `.bin/tsc`/`npm.cmd`/`shell:true` 的本地回退逻辑，
  保留 workspace cwd/env/stdio/错误语义（prebuild-deps 增加 result.error 诚实处理）。
- 全部 workspace package.json（agent-worker/cli/host/pi-sdk-adapter/protocol/
  runtime-contract-tests/runtime-core/sessiond）把 POSIX `rm -rf` 替换为
  remove-paths.mjs，把 quoted raw `node --test 'glob'` 替换为 run-node-test.mjs。
  root build/typecheck/test 继续经 run-workspaces.mjs 编排；root test 的 scripts glob
  走 run-node-test.mjs。browser/client Vitest 脚本保持不变（不强制 node --test）。
- check-architecture.mjs 新增三把精确门禁（+ 测试）：(a) 任何 package.json script
  值不得含 `rm -rf`/`rm -r`（建议 remove-paths.mjs）；(b) 任何 script 值不得对
  raw `node --test` 传 shell 依赖 glob（建议 run-node-test.mjs；显式文件列表不拦）；
  (c) 仅对 build-deps.mjs/prebuild-deps.mjs 的可执行代码（先 strip 注释，注释提及
  不误报）检查 `npm.cmd`/`.bin/tsc`/`shell:true`（建议 tool-invocation.mjs）。
  不禁止与构建无关的合法 shell 使用。
- 动态 ESM import 加载文件系统路径一律 pathToFileURL（本切片新增代码无此类裸动态
  import；既有 worker-main.ts 已合规）。

验证（本机 Node v24.18.0 / npm 11.16.0）：
- scripts 全量 91 pass/0 fail（run-node-test 18 + remove-paths 16 + tool-invocation 7 +
  check-architecture 25 + run-workspaces 25）；run-node-test 对
  `scripts/**/*.test.mjs` 发现 5 个文件正常展开，零匹配 exit 1。
- 新增脚本单元探针含注入 fs/spawn 故障（remove-paths rmImpl 抛 EPERM → exit 1；
  run-node-test spawnSync 抛 error/signal → exit 1）与 Windows 路径字符串
  （盘符根 C:\、盘符路径 C:\foo、UNC 根 \\server\share、反斜杠 glob）在 macOS 上
  的确定性结果。
- root check:architecture PASS（含新增三门禁）；root typecheck/build/test PASS；
  各 workspace 每包 test script 实际发现 ≥1 文件（agent-worker 105 / cli 46 /
  host 372 / adapter 206 / protocol 116 / contract 75 / runtime-core 7 /
  sessiond 178 / client 566 基线，见下）。
- Startup/Sessions/Runtime E2E 从隔离临时配置回归 PASS（随机端口 + 临时
  PI_CODING_AGENT_DIR，不触碰 30144/真实 Agent 配置；有限 watchdog，无 grep/head；
  无孤儿进程残留）。

边界与残余风险：
- 本切片只做“跨平台安全工具子集”，不建立原生 Windows 产品支持。Host state
  directory / Named Pipe / DACL / process-tree 生命周期仍属独立工作包（未触碰）。
- 未在 Windows 实机运行；Node24/npm11 已验证，Node22.19/npm10 按 API 兼容性
  （fs.globSync、fs.rmSync maxRetries/retryDelay、createRequire、spawnSync）推理
  兼容，未在 Node25 或 Windows native CI 宣称支持。
- npm_execpath 契约依赖“经 npm 运行”的前置；直接 node 运行 prebuild-deps.mjs 会
  固定失败（诚实消息），这是有意 fail-closed。
- run-workspaces.mjs 内部自带的 resolveNpmInvocation（含 npm 兄弟/PATH 回退）未改，
  与 tool-invocation.mjs 的 fail-closed 版并存；两者职责不同（root 编排 vs 包内依赖
  构建），后续可统一，非本切片范围。
- source 分支提交前工作树 clean；独立验证首轮 FAIL 后由 `e06a052` 修复，第二轮已对
  F1–F4 原复现、Node22.19/24、npm10/11、root tests 与三条 E2E 判定 PASS；main 已合入，
  未 push/deploy。
```

### 46.1 独立验证 FAIL → 硬化修复（follow-up `e06a052`，已合入 main，未部署）

独立 verifier 复现失败并给出精确复现清单；以下为针对逐项的硬化修复（提交 atop
§44，见 commit message）：

F1（false-green，HIGH）：`node run-node-test.mjs "sub/*.test.mjs" --test-name-pattern
"sub/*.test.mjs"` 旧解析器把分离的 flag value 当作另一个 pattern 展开，Node 再把首个
显式测试文件当 flag value 消费，失败测试被跳过且 exit 0。修复：解析器 fail-closed ——
已知取值型 node test flag（test-name-pattern / test-skip-pattern / test-concurrency /
test-reporter / test-reporter-destination / test-shard / test-timeout / test-isolation /
test-coverage-{include,exclude,branches,functions,lines} / test-global-setup /
test-random-seed / test-rerun-failures / experimental-test-isolation，Node22.19/24 并集）
必须用 `--flag=value`，分离形式在 discovery/spawn 之前以固定 usage 消息 + exit 2 拒绝；
布尔 flag（test-only/test-force-exit/test-randomize/test-update-snapshots/
experimental-test-coverage/experimental-test-module-mocks 等）可与后续 pattern 共存；
未知 flag fail-closed；`--watch*` 在本有限 runner 拒绝。`--` 分隔符语义改为如实描述
（其后的所有参数都是 flag），删除“允许 dash 开头 pattern”的虚假声明（未实现）。
另修复嵌套调用 false-green：父 test runner 注入 `NODE_TEST_CONTEXT`，子进程继承后
node --test 会“recursively within a test file”静默跳过文件列表并 exit 0 —— spawn 子
进程前删除该 env。新增 REAL fixture 回归：一个 pass + 一个 fail 测试 + glob 值分离
flag，证明 nonzero / 无 false-green；`--flag=value` 等价形式照常工作。

F2（rm gate 覆盖面）：现在命中 `rm -rf` / `rm -fr` / `rm -r` / `rm -r -f` / `rm -f -r` /
大写 `-RF` / 长形式 `--recursive --force`，且覆盖 `&&`/`;` 后续命令段；命令位置要求 +
shell 注释剥离（引号感知）使 echo 文本 / `#` 注释不误报。文档明确为精确 normal-form
回归门禁，不是穷尽式 shell 解析器/安全沙箱。

F3（raw node-test gate）：改为检查脚本中**所有** `node --test` 出现点（不止第一处），
fixture `node --test a.test.mjs && node --test 'b/**/*.test.js'` 必须 FAIL。

F4（注释剥离）：替换为词法/记号感知剥离器——保留单/双引号与模板字符串内容及换行、
转义字符、模板插值，处理块注释换行，并在正则允许上下文消费正则字面量，避免 `//` 在
字符串/正则内被当注释截断而漏报同行可执行违规。import/legacy 既有门禁行为不变。新增
探针：URL 字符串 + 同行违规、纯注释、块注释、转义引号/模板、正则 `\/\/`。

安全小偏差：remove-paths 只接受相对路径——拒绝绝对 POSIX 路径（即使位于 cwd 之下）
与纯空白路径，保留顶层 symlink 删除语义与 realpath 约束；resolveNpmInvocation 要求
npm_execpath 是 regular file 且校验真实 npm 包元数据（package.json `name:"npm"` +
bin.npm 精确映射到该文件），任意名为 npm-cli.js 的 env 文件不可执行；resolveTscInvocation
要求 tsc bin 是 regular file 且被约束在解析出的 typescript 包根内（恶意 `../` bin
元数据不逃逸）。

验证（Node v24.18.0 与 v22.19.0 双跑）：scripts 全量 106 pass/0 fail；architecture
PASS；F1/F2/F3/F4 定向对抗 PASS；root build/typecheck/test 与受影响 workspace
（agent-worker/cli/host/pi-sdk-adapter/sessiond）测试通过；Startup/Sessions/Runtime
E2E 从隔离临时配置 PASS，无孤儿。

## 47. D4 — Session-History Delete 垂直切片记录

```text
实现：source branch feat/d4-session-delete（base main 125d0a6，source `1d05532`），
backend-first：sessiond → Host → Client → E2E/docs。Fresh GPT 首轮发现 activate mutex
跨 worker-start 自锁与 Query 契约缺口，修复后二轮独立验证 PASS；已集成 main，未部署。
只删除；offline rename
明确独立。未触碰 live 服务、package-lock、D2 extension/fork 工作、side chat 或无关
UI。能力 token `session.delete`（协议 schema 已含）与 sessiond `sessions.delete`
RPC/dispatch/Adapter SessionCatalogPort.deleteSession 均已存在；Client
`sessions.remove` API + mutation option 已存在（本次开始使用）。

冻结安全/产品决策（父级明确，必须实现）：
1) DELETE 仅限 stopped/history session。`records.has(sessionId)` 即 fail closed
   `session_busy`（retryable false，结构化固定），绝不 stop/interrupt/close/delete；
   无 force、无 “stop then delete”、无 busy bypass。delete 与 activate 用同一
   session-scoped fence 串行化，session 不可能在检查与 catalog 删除之间变 live。
   并发 delete/delete 串行化 → 恰一次成功 + 固定 not_found（adapter ENOENT
   open/rm 之间仍幂等），无 wrong-file。activation/delete 竞态二选一：delete 先提交
   → activation not_found 且零 worker；activation 先赢 → delete conflict 且不删文件。
2) Adapter delete 安全（id/path 校验、ENOENT 幂等、缓存失效、其他 fs 错误
   sanitize）不动。
3) Host `DELETE /v1/sessions/:id`：生产 mutation guard（system.ping）在 RPC/效果
   之前；仅挂 mutation seam 时挂载路由；共享 auth/LAN gate 在最前。无 body/force。
   返回严格 `{success:true}`。映射：invalid id/body→400；not_found→404
   SESSION_NOT_FOUND；live/busy→409 SESSION_IN_USE（固定）；unavailable/timeout/
   down→503 固定；unknown→503；不泄漏 id/path/SDK/sessiond message/log。
4) 能力 `session.delete`：仅 sessiond up 且 mutation seam 挂载时，加入 Host
   types/ALL/production FULL/CLI bootstrap/health/WS；degraded/down 排除；
   `sessions` 读保留。能力是发现层，服务端授权仍强制。
5) 生产 sessiond client 增加窄 delete method/RPC；read client 语义不变；只有真实
   mutation guard 时 composition 才挂 delete 路由。启动/bind/shutdown 不变。
6) Client Sidebar 行删除 UI 仅在 `session.delete`；attached/live 选中会话不显示
   （AppShell 告知）；其他 live 会话可被服务端权威 409。行内两步不可逆确认
   （Cancel 安全默认聚焦 + Delete session），无 window.confirm/modal。一次一个删除；
   阻止 Link 导航/传播。固定错误文案；不泄漏 Host message/title/path。能力撤销/
   cwd/session 选择/unmount 期间：generation/ref guard，late result inert。成功时经
   既有 mutation options 失效 sessions list/detail。若删除行 == URL 选中会话，
   AppShell 导航只清 `session` 保留 `cwd`（不 detach/stop Runtime——live 本就删
   不成）；非选中删除不改 URL。Cancel/失败后焦点安全返回（行仍在时）。
7) Sidebar 仅 `sessions` 时仍 list/read，无 action 控件；移动端/窄行不溢出；标签含
   安全显示 title/short id，role=alert/status，disabled/aria-busy。无新动效。
8) 本切片不做 rename/auto-name/session.write、trash/undo、bulk delete、cwd
   scoping、side-chat filtering。

sessiond（packages/sessiond/src/service.ts）：
- `deleteSession` 重写：`records.has(sessionId)` → `SessiondError("session_busy",
  "session is running", false)`；`activations.has` → `session_busy`（starting）。
  整个 admission + catalog.deleteSession 在 `this.mutex`（类级 AsyncMutex）内执行，
  与 activate admission 共用同一 fence。
- `activate` 重构（含独立验证 FAIL 后的回归修复）：admission（records/activations
  复检 + 注册进 `activations`）移入 `this.mutex.runExclusive`，但 mutex 只用于同步
  admission——`AsyncMutex.runExclusive` 会 await 回调结果，所以回调必须返回 void，
  异步 worker-start operation 在锁外 await。否则全局 mutex 会跨整个 worker start 持
  有：worker ready/sessionDiscovered 的 rekey（自身也要取同一 mutex）自锁到
  workerStartTimeout，不同 id 的 start 被串行化，delete 阻塞在慢 start 后面。修复后
  mutex 仅持同步 admission，rekey 可正常取锁；同 id delete 在注册后立即
  session_busy（不等待 worker），不同 id delete 不被阻塞；cleanup 身份安全：只有
  精确 admitted owner 在短 mutex 段 `if (this.activations.get(sessionId) ===
  operation) delete`，join 者永不误删。
- 竞态结果：activate 先注册 → delete 见 activations → conflict 不删文件；delete 先
  持锁删 catalog → activate admission 随后 locate not_found 且零 worker。
- 测试：7 个 delete service 测试（非 live 成功并失效；missing not_found；无 catalog
  unavailable；live idle/prompt/bash/compact 全 session_busy 且 no-stop/no-delete/
  no-worker-shutdown；activation 赢 → delete conflict 不删文件；delete 赢 →
  activation not_found 且零 worker；并发 delete/delete 恰一成功 + 一 not_found）+
  5 个 fence 回归测试（rekey 在 workerStartTimeout 前完成且无 orphan；不同 id
  activate 并发重叠不串行；慢 activate 期间同 id delete 立即 session_busy 且不同
  id delete 不阻塞；join 同 id 共享 op 且仅 admitted owner 清 map；被拒 activate 清
  map 且 retry 重新准入）+
  2 个 RPC boundary round-trip（missing not_found、live session_busy 到客户端）。
  5 个 fence 测试对旧（broken）代码确定性失败：rekey → `worker start timed out`
  (508ms)、overlap → starts=1（串行化）、同 id delete → 303ms（等待 worker）。

Host（packages/host）：
- types.ts：HostCapability + ALL_HOST_CAPABILITIES 加入 `session.delete`；新增
  `SessionDeleteClient`、`SessionDeleteSeam`（client + mutationGuard），挂到
  `HostDeps.sessions.delete`。
- routes/sessions.ts：`DELETE /v1/sessions/:id` 仅在 `deps.sessions.delete` 时挂载；
  mutationGuard（system.ping）→ 任意非空 query string（含裸 `?`，force/override/
  任意/重复/encoded）固定 400 INVALID_QUERY → id 校验 → body 校验（400
  REQUEST_BODY_NOT_ALLOWED）→ 窄 delete RPC → `{success:true}`。无 force 面。
  `mapSessionDeleteError`：not_found→404 SESSION_NOT_FOUND；session_busy/conflict→409
  SESSION_IN_USE；其余→503 SESSIONS_UNAVAILABLE（固定 sanitize）。
- composition/sessions-client.ts：`createSessiondSessionDeleteClient`（包
  `sessions.delete` RPC）。
- production-resources.ts：PRODUCTION_FULL_CAPABILITIES 加 `session.delete`
  （sessiond-up 才广告）；RESOURCE_DEGRADED_CAPABILITIES 排除。
- app.ts + CLI host-runner.ts：production 挂 delete seam（delete client +
  production.adapter 作 mutation guard）。
- 测试：11 个 delete 路由测试（成功、无 seam 不挂、guard-first、down 503 先于 RPC、
  404、409 双码、503 固定、空 id 404、body 400、LAN auth gate 最前、任意 query 400
  且零 delete RPC）+ production-resources/health 能力断言。

Client（packages/client）：
- CapabilityProvider：`canDeleteSessions`。
- Sidebar.tsx：行内两步确认（Delete → Confirm：Cancel 安全默认聚焦 + Delete
  session），`session.delete` 门控，attached/live 隐藏（AppShell 传 liveSessionId），
  同步 busyRef 单飞行，generation/cap/cwd/selection refs 使 late settle inert，
  固定错误文案（describeSessionDeleteError），复用既有 `sessions.remove` mutation
  options（list+byId 失效）。Delete 按钮为 row Link 的 sibling（不导航）。
- AppShell.tsx：`onSessionDeleted` → 只清 `session` 保留 `cwd`；不 detach/stop。
- CSS：.session-delete-*（克制内联，无 modal/动效）。
- 测试：12 个 Sidebar 测试 + 1 个 AppShell 导航测试 + 1 个 describeSessionDeleteError
  单测。

E2E + docs：
- sessions-history.mjs：bootStack 挂 delete seam + 共享 daemon + LAN bind；D4 HTTP
  delete 全流程（live 409 worker/file 保留；显式 stop 后 delete 成功；stopped JSONL
  delete 后 file/list/read 404；body 400；LAN auth 401 且文件保留；down 后能力撤销 +
  delete 503 且不碰文件）。
- startup.mjs：FULL_CAPS 含 session.delete；DEGRADED 排除；断言。
- 验证：root tests/build/typecheck/architecture/boundaries、Startup/Sessions/Runtime
  E2E 全 PASS；真实 Host→sessiond→adapter 删除闭环。Fresh GPT 二轮以相同 F1 探针确认
  rekey 14ms、不同 id activate 251ms 并行、同/异 id delete 0ms、全部 Query/auth/cap/UI
  竞态与无孤儿门禁 PASS；source 提交干净，已集成 main，未 push/deploy。

## 48. (provisional) secure-Windows-state Slice 1 — `@fffattiger/pix-local-authority` POSIX 基础（平台中立 contracts + POSIX backend + Host 委托 + macOS `/var` 别名规范化）

```text
状态：DONE（source hardening 与 current-main 集成均已独立 persistence/security 验证 PASS；已合入 main，未 push/deploy，无 live service）
来源分支：feat/local-authority-posix-host（`1dd6e7d` + hardening `1d2caf2`）
集成分支：integrate/local-authority-posix（base main `e1249f4`；`c2af2b9` + `6b3047d` + tooling adaptation `4951ac3`）
验证者：原 persistence/security verifier 确认 `1d2caf2` security PASS，并确认 current-main 集成 HEAD `5f96df8` integration-ready PASS
```

目标：为 secure-Windows-state 计划铺设「平台中立 secure-state contracts + 当前高保真 POSIX 实现」的依赖无关基础设施工作区，并让 Host 内部 `HostStateDirectoryLease` 委托底层操作——不改 Host 公共/API/错误/布局/字节语义；同时修复 canonical alias 处理，使 macOS `/var/...` 可经「最近已存在祖先 realpath」安全规范化到 `/private/var/...` 而非误拒。

范围（只动本切片；不 touch sessiond / Protocol / CLI 行为 / Windows 原生代码 / Client & runtime / package engines / persisted schema；不宣称原生 Windows 支持）：

- 新增 dependency-free workspace `packages/local-authority`（`@fffattiger/pix-local-authority`，0.1.0，零 runtime deps，engine node>=22.19.0）：
  - `src/state/contracts.ts`：平台中立 contracts（零 node: import）：`LocalAuthorityCode/LocalAuthorityError`、`PosixFileIdentity`、`PosixPrincipal`、`StateDocumentReadResult`、`LifetimeLockRecord/Ownership/ReadResult`、`SecureStateBackend` 接口，以及纯谓词 `isRecord/isSafeInteger/isIsoTimestamp/hasControlChar/isValidInstanceId/isAbsoluteCanonicalShape`（Host ledgers 继续经 host-state-directory 转发这些谓词）。
  - `src/state/posix.ts`：从 Host `host-state-directory.ts` 抽取/适配的高保真 POSIX backend：`canonicalizeAbsolutePath`（最近已存在祖先 realpath + 校验缺失尾 + canonical 组件回走；拒绝根/父级逃逸/网络/Windows 声明，结果永不含符号链接中间组件）、`posixFileIdentity/currentPrincipal/isOwnedByCurrentUser`、`ensurePrivateDirectory`（逐组件回走、新 leaf fd 设 0700、既有 leaf 绝不 chmod——owner/精确 0700/validateExistingLeaf 钩子）、`readStateDocument`（bounded + symlink/非 regular/oversize/permissions/hardlink 全 fail-closed）、`writeStateDocument`（temp 同目录 O_EXCL|O_NOFOLLOW 0600→write+fsync→身份→原子 rename→目录 fsync，支持 lockCheck LOCK_LOST 与 test-only inject seam）、`acquireLifetimeLock/readLifetimeLock/releaseLifetimeLock`（O_EXCL、busy/stale/unsafe/ambiguous 分类、精确 dev/ino+instanceId 释放）、`isPidAlive`、`createPosixSecureStateBackend`。
  - `src/state/index.ts` + `src/index.ts` 顶层导出；`test/*.test.mjs`（canonical-path/secure-directory/lifetime-lock/document/package-surface 33 用例）；`scripts/check-boundaries.mjs`。
- Host `host-state-directory.ts` 重构为委托：recognized 布局策略、共享 in-process mutex、validate-before-lock 顺序、固定 Host 错误码/消息（`LOCAL_TO_HOST_CODES/LOCAL_TO_HOST_MESSAGES`，LocalAuthorityError→HostStateDirectoryError，绝不泄漏 raw path/os error）保留；低层 fs 操作（canonicalize/private-dir/doc read/write/lifetime lock）委托 `@fffattiger/pix-local-authority/state`。公共 API/error/layout/byte 语义不变：仍 `trusted-roots.json` / `managed-worktrees.json` / `trusted-roots.lock`（既有 lock 名，非 host.lock——若计划要求改名需独立切片，本切片不得改布局语义）、单一 lease/单一 mutex/单一 lifetime lock 由两账本共享。
- canonical alias 修复：`ensurePixHostDir` 先 canonicalize（`/var/foo`→`/private/var/foo` 不再误拒），再按原始路径回走拒绝「除 canonical root alias（macOS /var→/private/var、/tmp、/etc）之外的符号链接中间组件」（既有「中间符号链接拒绝、外部树绝不突变」测试保持通过）；拒绝 lexical 父级逃逸、根、网络/Windows 声明。
- Host dependency：`@fffattiger/pix-local-authority@0.1.0`；prebuild-deps 增 `packages/local-authority`；Host check-boundaries 只放行 `@fffattiger/pix-local-authority/state`（非 root/非其他 subpath）；check:architecture 新增 `local-authority boundary` 检查（禁 Protocol/Runtime Core/Pi SDK/Hono/React import 或依赖）+ 自测；package-lock 仅新增本新 workspace（未改其他依赖版本）。

当前 main 集成候选不变式验证（Host 既有测试未改即过 + 新增）：Host 394/394；安全重点子集 84/84；local-authority 43/43（含 raw EACCES/path 脱敏、broken-symlink/parent-is-file 分类兼容）；check:architecture PASS（全部 14 gates，含 local-authority boundary 与跨平台 tooling gates）；scripts 自测 31/31；Host boundary 42 files PASS；local-authority boundary 4 files PASS；root 1345 pass + 1 skip；Startup/Sessions/Runtime E2E 有限 watchdog 全 PASS；Node 22.19、24.12、24.18 均有 focused 证据；`git diff --check` 与两包 npm pack dry-run 通过。

语义增量（相对旧 lease 行为）：
- `PIX_HOST_DIR`（或 resolve 后）含 macOS 根级 canonical alias（/var、/tmp、/etc）时，hostDir 返回 canonical（/private/var/...）且不再误拒——这正是本切片目标；非根级用户符号链接中间组件仍 fail-closed（HOST_DIR_UNSAFE），外部树绝不突变。
- 其余错误码/消息/字节/锁名/布局不变（见上）。

残余风险 / 待办：
- 未做原生 Windows backend（contracts 是平台中立接口；POSIX 为当前唯一实现）；原生 Windows 仍需：native backend + secure named pipe + CI 门禁（含 Windows 专用测试矩阵）后才可声明支持，本切片不宣称。
- 同 UID 残余 TOCTOU（Node 无 openat）保持既有文档化处理；不削弱跨用户边界。
- 本切片为 source-only 抽取/委托，无任何 persisted schema 迁移（lock/ledger 文件格式不变），无数据迁移脚本。
- source hardening `1d2caf2` 与 current-main 集成 HEAD `5f96df8` 均已独立验证 PASS；当前已合入 main，未 push/deploy。
```

## 49. (provisional) secure-Windows-state Slice 1 — 验证证据

```text
- Host 全量 test：当前 main 集成候选 → 394 pass / 0 fail；安全重点子集 → 84/84
- local-authority：当前跨平台 wrapper → 43 pass / 0 fail
- `node scripts/check-architecture.mjs` → PASS（14 gates，含 local-authority boundary 与 tooling gates 11–13）
- `node --test scripts/check-architecture.test.mjs` → 31 pass / 0 fail
- `node packages/host/scripts/check-boundaries.mjs` → PASS（42 files）
- `node packages/local-authority/scripts/check-boundaries.mjs` → PASS（4 files）
- 逐包 typecheck / build → PASS；root build / typecheck / test → 1345 pass + 1 skip / 0 fail
- Startup / Sessions / Runtime E2E（有限 watchdog、temp dirs）→ PASS；无本 worktree 孤儿进程
- Node 22.19：local-authority 43/43、Host security 84/84、architecture PASS；Node 24.12：local-authority 43/43；Node 24.18 为全量主验证环境
- package-lock 仅新增 workspace/link/Host dependency（无依赖版本漂移）；跨平台 clean/test wrapper 与 Host prebuild npm resolver 均保留
- `git diff --check` → PASS；`npm pack --dry-run`（local-authority + host）→ 内容核对通过
```

## 50. D2-P8 — Extension UI Client 垂直切片记录

```text
实现：branch feat/d2p8-extension-ui-client，base main e1249f4（D4 已集成），
Client-only 公共 UI/并发切片。只改 packages/client（runtime + features + shell +
styles）+ 两份 docs；未触碰 backend/Protocol/Host/sessiond/adapter/fixture/E2E 源/
package-lock/live/deploy。提交干净，无 merge/push/deploy。

后端契约已冻结于 main（§45）：capability `runtime.extension_ui`；快照
`state.pendingExtensionUi`；共享 reducer 移除 closed tombstone；交互方法精确
select/confirm/input/editor/custom；noninteractive notify/setStatus/setWidget/
setTitle/set_editor_text 是事件/state 永无 response form；response 命令要求精确
request id+method 与 selected/confirmed/value/cancelled shape；wrong method
invalid_input 保持 pending、late unknown not_found；Host interleaving lane 已支持
extension response/input 在 prompt HOL 时交错。

关键 Client 传输实现（packages/client/src/runtime/session-store.ts）：
1) 不用 `sendCommand`（触发 UI 的 prompt 仍是 pendingCommand → session_busy）。新增
   专用有界单飞行 `pendingExtensionUiCommand` 槽（类比 D2-P4 pendingQueuedTurn），
   独立于 prompt 与 queued-turn 槽；含 envelopeId/commandId/generation/sessionId/
   requestId/method/command/promise。全局恰一个 extension reply 在飞；第二个固定
   session_busy。无槽泄漏/无 double settle。
2) 仅新增 typed `respondExtensionUi(request, reply): Promise<void>`（本切片不发
   extension_ui_input）。构造精确 `extension_ui_response` 命令（commandId 内部铸造、
   id/method 绑定自权威 pending request），检查 attached + `runtime.extension_ui`
   能力 + request method/reply 兼容（cancelled 全交互方法；selected/confirmed/value
   方法绑定；noninteractive 永不可答），解包 correlated ack；无 value coercion/trim。
3) handleResponse 按 envelopeId+generation+commandId+result type 关联（wrong
   commandId/wrong type 丢弃不 settle；late/duplicate 丢弃）；同 epoch snapshot/gap
   重发 SAME commandId 新 envelope；epoch_changed 拒绝永不重发；routeSendFailure
   拒绝清槽；detach/stop/dispose/session switch（detach-then-open 真实路径 + startAttach
   防御分支）/capability loss（快照/事件权威撤销 → settle）恰一次 settle。prompt 在飞
   不阻塞 extension reply；extension reply 在飞不阻塞 prompt。
4) RuntimeView 暴露 `extensionUiReplyPending`（首可操作请求 aria-busy/disable）。

UI 组件（packages/client/src/features/extension-request/）：
- extension-request.ts 纯 helpers：交互/非交互分类（交互=select/confirm/input/editor/
  custom；其余含未知 method 防御性被动）、activeInteractiveRequests 确定性投影序、
  hasPendingInteractiveRequest（Composer 共享）、ExtensionUiReply 类型 +
  isExtensionReplyCompatible、固定 describeExtensionUiError（code-first，永不上屏
  Host/Protocol raw message/request 文本/用户输入/id/path）。
- ExtensionRequests.tsx：AppShell 在 main.workspace 内 TranscriptList 与 Composer 之间
  挂载，仅 selectionMatchesLive（组件另自检 capability）。渲染 pending 交互请求为
  确定性数组序卡片；多请求堆叠但仅第一个可操作/聚焦目标，后续 disabled + 固定
  waiting 文案。confirm（title+message、Cancel 安全默认聚焦、Confirm、Escape 取消、
  永不自动确认）；select（options 为原生按钮列表、无预选自动提交、显式选项选择或
  Cancel、原生键盘、Escape 取消）；input（单行、placeholder、显式 Submit、Enter
  提交、IME 组合 Enter 不提交、空串仅显式 Submit 允许、Cancel）；editor（prefill 按
  request identity 只 seed 一次、多行、Enter 换行、Cmd/Ctrl+Enter 提交、IME guard、
  显式按钮、Cancel）；custom（lines 严格 React 文本节点无 HTML/dangerouslySetInnerHTML、
  空时中性占位、安全文本输入+显式 Submit/Cancel，默认聚焦 Cancel）。仅最终
  response，零 extension_ui_input 帧。noninteractive/未知防御变体：被动固定 notice，
  无 response 命令。
- 焦点：请求到达时安全/主要控件（Cancel）可预测聚焦，不反复抢焦（仅在 operable
  request identity 变化时）；最终 close/cancel 后若仍同 session/live/capability 恢复
  焦点到 Composer textarea（显式 textareaRef prop，无 document 查询）；跨多请求与
  unmount 存活。
- 竞态/安全/无障碍：同步 busyRef 挡同 tick 双击；mounted/generation/session/live/
  capability refs（SessionActions/D4 Sidebar 模式）+ error 按 request CONTENT 键控
  （request id 复用不能写入新 form 状态）→ detach/reconnect/session/cwd/cap loss/
  request close 后 late success/error 惰性；固定错误文案；无 modal/window.confirm；
  内联 region 保持 transcript 可读；role=region、polite arrival/status、表单 label、
  aria-busy/disabled、≥40px 触控目标（移动 44px）、可见 focus；无入场动画，`:active`
  scale 0.98（120ms transform only）、hover 仅 pointer-fine、reduced-motion 移除
  transform transition；无 transition:all/keyframes/ease-in/scale(0)。

Composer（packages/client/src/components/shell/Composer.tsx）：
- 新增 textareaRef prop（显式 ref 传 ExtensionRequests 作聚焦返回目标）。
- 至少一个交互请求 pending（live + capability）时 Composer disabled，状态区固定文案
  “Extension is waiting for input.”；保留既有更严重 disable 优先级（stopped/无 agent/
  非 live 优先），extension waiting 优先于 streamingBlocksSend。

AppShell（packages/client/src/components/shell/AppShell.tsx）：
- composerTextareaRef 持有一个显式 ref；`{selectionMatchesLive ? <ExtensionRequests
  live composerTextareaRef={...} /> : null}` 挂在 TranscriptList 与 Composer 之间；
  Composer 收 textareaRef。D4 session-delete 导航/卸载逻辑未改。

CSS（packages/client/src/styles/app.css）：.extension-request-* 克制内联（复用
token/radius/type），无渐变/玻璃/弹跳。

测试：
- SessionStore 定向 12 用例（session-store-extension-ui.test.ts）：全 reply 变体/方法
  精确命令 shape + 零 extension_ui_input；prompt pending 时 reply 不 session_busy +
  第二 reply busy + correlated ack 精确；wrong-method/noninteractive 发送前拒绝；
  not attached/无 capability 拒绝；server invalid_input/not_found 固定拒绝；
  same-epoch resync 同 commandId 重发、epoch_changed 不重发拒绝、detach/stop/dispose/
  session switch/send failure 恰一次 settle、wrong envelope/commandId/type 丢弃 +
  legit 帧一次 settle + 槽恢复、capability loss settle。
- DOM 23 用例（ExtensionRequests.test.tsx）：5 表单渲染 + defensive noninteractive
  被动 notice、capability/live 门、确定性多请求仅首可操作、默认聚焦、第二请求不抢焦、
  Escape、Enter/CmdEnter、IME、空串显式提交、custom 文本不渲染 HTML、双击单发、
  request close 后 late inert、capability revoke 惰性、固定错误文案、零 incremental 帧、
  Composer disable/焦点恢复、无 composer ref 不崩。
- 纯 helper 7 用例（extension-request.test.ts）。
- AppShell 集成 +4（mount placement：region 在 Composer 前、history 不挂、无 capability
  不挂、session switch fail-close 卸载且 D4 detach 路径不受影响）；既有 D4 delete 导航
  测试原样通过（无回归）。

验证（本机 Node v24.18.0）：
- Client 全量 627/627（基线 581 + 新增 46：store 12 + helper 7 + DOM 23 + AppShell 4）；AppShell
  25/25（既有 21 + 新增 4）。
- Client typecheck PASS；client build（vite）PASS；check-boundaries PASS。
- 根 check:architecture PASS；root typecheck PASS；root build PASS；`git diff --check`
  通过。
- 根 test（scripts 44 + 9 workspace 分包）全绿；Runtime E2E + Startup E2E + Sessions
  E2E（backend 回归）PASS；shutdown 无孤儿；watchdog/temp config 有限。
- 无 Playwright 依赖，不声明浏览器视觉 PASS；真实 Store/DOM 并发、IME、request-id 复用、不同/相同 id 的 in-flight reply 焦点恢复与 no-steal 已由独立 verifier 对 integration `4e09278` + focus fix `46db2b4` 复验 PASS。浏览器视觉观感仍是非阻塞 manual gap。
```

## 51. D4 — Session-Rename Upper-Layer（sessiond 身份 lane 切片）记录

```text
实现：source `f575b82` + same-kind fix `a6cdedd`（branch feat/d4-session-rename-service，base main e1249f4）；current-main 集成 `1cb32e3` + `66e7e4c`。backend-first，仅 sessiond 上层 + docs + E2E 断言更新；无 Host route/Client UI/package-lock/live service；已合入 main，未 push/deploy。依赖地基 §44（adapter `SessionMutationPort.renameSession` +
共享 store 即时失效，main 953640b）与 §47（stopped-only delete + activate 同步 admission
fence，main e1249f4）。本切片把 sessiond 的身份变更（activate / sessions.rename /
public runtime.command(set_session_name) / 显式 stop / delete）收敛到服务持有的
per-session FIFO identity lane 协调器，并接通生产默认 adapter mutation、标题 overlay。

冻结架构决策（父级明确，必须实现）：
1) 全局 `SessiondService.mutex` 只用于短同步 records/activations/rekey/alias 迁移；
   绝不在全局锁下 await adapter/catalog/locator/Worker command/start/close/另一 lane。
   长身份工作全部在 per-session FIFO lane 内进行；同 id 串行、不同 id 独立并行。
2) lane 覆盖 activate、sessions.rename、runtime.command(set_session_name)（命令类型
   set_session_name 时）、显式 stop、delete。runtime.command(set_session_name) 与
   sessions.rename 共享同一 lane（Client SessionActions 不能绕过 Host/API rename
   顺序）；抽取私有非重入 commandOnRecord，绝不在 lane 内递归 admit。
3) activate 先同步注册 reservation（lane pending kind + activations map）再做长工作；
   exact-promise singleflight 保留；两个不同 id 的 activation 并发不串行。
4) delete 的 catalog I/O 移入 lane；保留 stopped-only、prompt session_busy、no-stop/
   no-force 与全部固定错误。delete 准入（enqueue 前）即时检查 records/activations/
   lane activate reservation → 固定 session_busy，绝不等待 worker。
5) 显式 stop 走 lane（内部非重入 stopRecord）；全局 shutdown 用 lane-free 内部 bypass
   （调用者已拥有/排空整服务，绝不递归取 lane）。
6) rekey 在短全局锁下把 authoritative id 原子绑定到同一 startup reservation lane；
   目标已被独立 lane/reservation/record 占用 → 固定 conflict fail-closed（不等待/
   合并/抢占）；rekey 前对旧 id 排队的请求变 stale（generation 失配）固定
   conflict/unavailable，绝不对被复用的旧 id 做 offline mutation；rekey 后对
   authoritative id 的请求排到 startup 之后并在 ready 记录上运行。
7) 标题收敛用服务持有的 revisioned overlay（sessionId -> {canonicalName,revision}）：
   仅在确认 live/offline rename 成功后才 publish；sessions.list/read 经服务 wrapper
   应用；stop 保留；delete 成功移除；rekey 安全移动；与 rename 重叠的旧读不得清除
   新 revision；成功返回之后开始的读必须看到新标题；绝不改 id/path/timestamps/context。
8) 名字只 canonicalize 一次（trim、非空、≤200 Unicode JS code units、拒 NUL/C0/DEL），
   RPC 返回 canonical 名；live 命令结果必须匹配 wire id/commandId/type/捕获 ownership，
   `{ok:false}` 一律视为失败，绝不报成功；任何 raw name/session/path/worker/adapter
   error 不得跨 boundary。

实现（packages/sessiond）：
- 新增 internal/session-operation-coordinator.ts：`SessionOperationCoordinator`（per-session
  FIFO lane：唯一 owner token、canonical id、绑定 aliases、单调 identity generation、
  拒毒 tail、pending kinds 同步可见、exact-owner 清理；admit/bindRekey/hasPendingKind/
  hasLane/resolveCanonical/diagnostics）与 `SessionTitleOverlay`（revisioned 标题 overlay，
  publish/remove/move/capture/apply）。
- service.ts：
  * `SessiondDependencies.sessionMutation?: SessionMutationPort | null` 改用 runtime-core
    `SessionMutationPort`（renameSession）；undefined=生产默认、null=显式禁用。
  * activate：records 快路径 → lane admit（pending activate）→ op 内复检 records/
    activations（join）→ stale 检查 → 同步注册 reservation → locate/context/start 在
    lane 内但全局锁外；exact-owner 清理用当前 canonical（rekey 会搬 reservation）。
  * rekey：短全局锁内做 records 迁移 + coordinator.bindRekey（含目标占用检测）+ activations
    reservation 迁移 + overlay.move；conflict 时 Worker close 在锁外。
  * command 拆出私有 `commandOnRecord`；set_session_name 走 lane（commandRename），
    offline/无 record 返回固定 unavailableCommand（不做 offline mutation）；其余命令原路径。
  * executeLiveRename：命令准入前与成功发布前双重捕获 record+epoch ownership 检查；
    ok:false 或 ownership 丢失绝不 publish/绝不 false success。
  * renameSession：canonicalize → lane admit → live（crashed/stopping 固定 unavailable，
    绝不 offline 回退）或 offline mutation；失败映射为固定 sanitized SessiondError。
  * deleteSession：enqueue 前 prompt busy（records/activations/lane activate）→ lane 内
    catalog.deleteSession（防御性 records 复检）→ overlay.remove。
  * stop 走 lane（内部 stopRecord 非重入）；shutdown 用 lane-free stopInternalBypass；
    touch 的 idle 路径仍直接 stopRecord。
  * listSessions/readSession 服务 wrapper 应用 overlay；diagnostics 增 lanes/aliases/
    overlay。
- application.ts：sessions.list/read 走服务 wrapper；sessions.rename 返回 canonical 名。
- composition/daemon.ts：生产默认 catalog/locator/mutation 同来自一个
  `createPiSdkSessionPorts()` 结果；sessionMutation override 语义 undefined/null。
- testing/fake-worker.ts：新增 primeSnapshotDelayMs（rekey 绑定后可确定性地把请求排在
  startup 之后）。

语义（竞态/product，父级冻结）：
- offline rename 先准入 → activation 排队等待、append 提交后才 locate/open 改名 JSONL
  （零 worker 先于 append）；activation 先准入 → rename 等待，startup 成功后成为 live
  set_session_name（绝不因 startup 返回 busy）。
- delete 在 live/crashed record 或更早 activation reservation 存在时 prompt 固定
  session_busy；delete 先准入 → activation 排队、删除后 not_found 且零 worker；rename 在
  delete 之后 not_found 且绝不重建文件；rename→delete 双成功；同 id rename FIFO、异 id 并发。
- 显式 stop 共享 lane：rename-first 先 settle live 命令再 stop；stop-first 先移除 record
  再 offline rename；crashed record 仍是 reservation：rename 固定 unavailable，绝不 offline
  回退，直到显式 stop/移除。
- 旧 record/epoch 的晚到结果（stop/reactivate/crash）不能 publish 标题或影响新 Worker。
- 无 coordinator/lane/alias/generation/activation/overlay 泄漏；失败任务不毒化 lane tail。

测试：新增 packages/sessiond/test/session-rename.test.ts（28 用例，确定性 deferred gate/
有限 watchdog，无 timing 断言）：offline-first 阻塞 activation 至 append；activation-first
→ live path 且零 mutation 调用；同 id rename FIFO（sessions.rename × runtime.command）；
异 id 并发；delete→rename/activate not_found 且零 worker；rename→delete 成功；activation
→delete prompt busy；stop→rename offline；rename→stop live；crash 防 offline 回退；
live {ok:false} / thrown failure / timeout 传播 sanitized 非 false success；crash+reactivate
旧结果 inert；rekey 旧 id stale conflict、authoritative id 排队 live、目标占用 fail-closed、
alias/promise 精确清理；失败无泄漏且失败 tail 不毒化后续；list/read 即时 overlay、旧 catalog
响应不清新 revision、delete 移除 overlay、stop 保留；shutdown 在 lane op 在飞时 lane-free
排空不死锁；boundary RPC（missing not_found、invalid name invalid_input、null mutation
unavailable，无 raw 泄漏）。新增 packages/sessiond/test/session-operation-coordinator.test.ts
（4 用例，coordinator 直测：same-kind A+B+C FIFO 带 gated sibling、拒绝路径不毒化/不减
兄弟 reservation、四种 kind 表驱动、异 id 独立 lane）。daemon.test.ts 新增 2 用例：真实默认
adapter JSONL offline rename（零 worker、同 path/id/history/context、即时 read/list、文件
含 session_info 标题）与 sessionMutation:null 固定 unavailable。既有 D4 delete/fence 回归
全部保留。E2E sessions-history.mjs 把过时的 "non-live rename unavailable" 断言改为真实
离线 rename 成功（canonical 名、零 worker、同 path、即时 read/list）。

独立验证首轮 FAIL 修复（sessiond 身份 lane 同 kind 去重缺陷，verifier poison-kind/
kind-race2/kind-race3）：`Lane.pending` 原为 `Set<IdentityOperationKind>`，同 id 同 kind
的 A+B 共享一个 set 条目——A 先 settle 时 `delete(kind)` 把 set 清空并移除 lane，而 B 仍在
排队/运行；随后准入的 C/delete 拿到全新 lane，绕过 B，产生 FIFO/顺序反转。修复：pending
改为 `Map<IdentityOperationKind, number>` per-kind 正引用计数——admit 在 tail 链前同步自增；
finally 精确减一、归零才删 kind、整个 map 为空才 maybeRemoveLane（不可能下溢，防御性
fail-closed 不提前移除 lane）；`hasPendingKind` 判 count>0。bindRekey/generation/aliases
不变。新增 coordinator 直测（4）+ service 级 verifier race 复现（2：B gated 时 delete 不
可 bypass、第三个 rename C 不可先于 B 进入 mutation）全部对旧 Set 实现确定性 FAIL、对修复
实现 PASS（旧实现 5/6 同 kind 测试失败）。

验证：sessiond typecheck/build/boundary PASS、sessiond 全量 229 pass/0 fail/1 skip 多轮
（含两轮并发 stress）；runtime-core 12/12、adapter 236/236、root typecheck/build PASS、
check:architecture PASS、root tests 全 workspace 绿；Sessions/Runtime/Startup 三条 E2E
PASS；git diff --check 与工作树 clean。独立 verifier 首轮复现 same-kind 缺陷并判 FAIL，修复后重放 poison-kind/kind-race2/kind-race3、release/rekey/overlay/delete 与多轮 Sessiond/E2E，最终对 `a6cdedd` 给出 PASS；current-main 正确 workspace 解析下 root build/typecheck/test 与三条 E2E 再次全绿。

残余/后续：Host PATCH rename route、Client rename UI、live set_session_name 的 catalog
持久化收敛（worker 侧）、auto-name/trash/undo、side chat 仍后置。编号已在 current-main
集成时顺延为 §51（Local Authority 占 §48/§49，Extension UI Client 占 §50）。

## 52. D4 — Host Session Rename API（PATCH /v1/sessions/:id）记录

```text
实现：source `33f0fea` + capability honesty fix `ed733f5`（branch `feat/d4-host-session-rename-api`，base main `ef564b7`）；已快进合入 main。Host-only：只改 packages/host、packages/cli、tests/e2e、docs；无 Client source、无 package-lock、无 sessiond 改动、无 push/deploy/live service。独立 verifier 首轮发现 token-without-route 并判 FAIL，修复后重放 seam 矩阵、Host/CLI/E2E，最终对 `ed733f5` 给出 PASS。依赖 §51（sessiond 已支持
live/offline `sessions.rename` 身份 lane）与 §47（Host DELETE 删除 seam 先例）。

冻结契约（父级明确，必须实现）：
1) 能力：Host 新增 `session.write`（Protocol token 早已存在）到 HostCapability/
   ALL_HOST_CAPABILITIES 与 production `PRODUCTION_FULL_CAPABILITIES`（session.delete
   之后、files 之前，顺序冻结），仅 sessiond-up + rename seam 挂载时广告；degraded/down
   排除（RESOURCE_DEGRADED_CAPABILITIES 不含）。能力只是 discovery，既有 auth/gate 仍是
   授权权威。默认 full 资源组合（CLI host-runner / E2E bootStack）暴露 rename seam；
   null（seam 缺失→路由不挂载 404）与 unavailable（guard/RPC 失败→503）测试 fail closed。
   `session.delete` 现有一切行为不受影响（类型/ALL/FULL/路由/测试同存）。
2) 窄 seam：新增 `SessionRenameClient`（`rename(sessionId,name):Promise<unknown>`）与
   `SessionRenameSeam`（client + mutationGuard），与 D4 delete 平行；production sessiond
   窄 client `createSessiondSessionRenameClient` 只包 `sessions.rename` RPC 恰一次（无
   runtime lifecycle）。read/delete seam 全部保持兼容（HostDeps.sessions 扩为
   {client, delete?, rename?}）。
3) 路由 `PATCH /v1/sessions/:id` 仅当 rename seam 存在才挂载；成功固定严格
   `{success:true}`，仅在 sessiond 确认 live/offline rename 后返回。冻结顺序：
   a) 既有全局 Host auth/LAN gate（最前）；
   b) production mutation guard `system.ping` 先于解析任何 attacker 控制的 query/body
      （同 delete authority-first 先例；down→固定 503 且零 RPC/零 body 读）；
   c) 任何 query 字符串（含裸 `?`）→ 固定 400 INVALID_QUERY（同 delete 文案）；
   d) session id 用既有 canonical rule（requireSessionId，空段不匹配 404）；
   e) 要求 application/json（既有 415 UNSUPPORTED_MEDIA_TYPE）；
   f) bounded body max 4 KiB（既有 readBoundedBody 语义，overlimit 413 BODY_TOO_LARGE）；
   g) 严格对象恰一个 own 字段 `name`：无数组/prototype/未知字段（malformed JSON 走既有
      400 INVALID_JSON）；`__proto__`/constructor/toString 等多余或非 name 键→400；
   h) 名字 canonicalize 恰一次：string（无 coercion）、trim 外层空白、非空、≤200 JS
      UTF-16 code units、拒 NUL/全部 C0/DEL；允许 Unicode/emoji/内部普通空格；
      canonical 名传给 RPC（sessiond 返回同名）；任何违规固定 400 INVALID_SESSION_NAME
      `Session name is invalid`（repo 一致固定文案，不 echo 原始名）；
   i) 调 seam 恰一次，返回 success 前 sessiond 已确认 rename。
4) 固定错误映射：bad query 400 INVALID_QUERY；invalid body/name 400 INVALID_SESSION_NAME；
   not_found 404 SESSION_NOT_FOUND `Session not found`；conflict/epoch_changed（身份已变）
   409 SESSION_CHANGED `Session changed during rename`；unavailable/timeout/unsupported/
   internal/session_busy/worker_unavailable/未知/raw socket error 一律 503
   SESSION_RENAME_UNAVAILABLE `Session rename is unavailable`；auth 既有 401/403 不变。
   live rename 绝不映射到 busy（sessiond 支持 live set_session_name，session_busy 也落到
   固定 503）。Wrong media/invalid JSON/too large 沿用既有共享固定错误
   （415/400 INVALID_JSON/413）。Body/name/session/raw adapter/worker 错误永不 log/返回
   （无 raw id/name/path/secret/endpoint/stack 泄漏）。
5) 无 stop/force 行为：PATCH 只做 rename，无 force 面（任何 force/override query 是
   400），绝不 stop-then-rename。

实现（packages/host + packages/cli + tests）：
- types.ts：HostCapability/ALL 加 `session.write`；新增 SessionRenameClient/SessionRenameSeam；
  HostDeps.sessions 扩 rename?。doc 注释同步。
- routes/sessions.ts：`mapSessionRenameError`（固定 404/409/503）、`parseRenameBody`
  （严格单 own 字段 name）、`canonicalizeSessionName`（trim/非空/≤200/拒 C0/DEL）；
  PATCH 路由仅在 deps.rename 时挂载，按冻结顺序实现（guard→query→id→415→4KiB→
  严格对象→canonical→rename 恰一次→{success:true}）。
- app.ts：registerSessionRoutes 透传 rename seam。
- composition/sessions-client.ts：新增 `createSessiondSessionRenameClient`（只包
  sessions.rename）。
- composition/production-resources.ts：PRODUCTION_FULL_CAPABILITIES 加 `session.write`
  （session.delete 后）；degraded 不变；doc 注释同步。
- index.ts：导出 mapSessionRenameError、createSessiondSessionRenameClient、
  SessionRenameClient/SessionRenameSeam 类型。
- cli/commands/host-runner.ts：production boot 接线 rename seam（client +
  production.adapter 共享 mutation guard）；log 文案更新（read-only + delete + rename）。
- tests/e2e/startup.mjs：FULL_CAPS 加 `session.write`；full 含/degraded 不含断言。
- tests/e2e/sessions-history.mjs：bootStack 接 rename seam；新增 live attached HTTP PATCH
  rename（200 {success:true}、canonical trim、即时 GET/list 标题、同 sessionFile、worker
  保持运行/身份诚实）、offline P4 HTTP PATCH rename（同 id/path/history、零 worker、即时
  标题）、invalid name/blank/control/201/extra/nonstring/malformed 400、query（?/?x/
  ?force=false）400、POST 404、LAN auth gate 先于 guard（rename 401/403）、down 时
  `session.write` 收回 + rename 从 guard 503（零 body/RPC/文件不变）。
- tests/e2e/startup.mjs 已在上文。Host test 新增 18 个 rename 用例（见下）。

Host 单元测试（packages/host/test/sessions.test.mjs，新增 17）：
route 缺失（无 seam→404）与存在；guard 先于 query/body 且 down→503（带非法 query+超大
body 也先 503、零 rename RPC、零 body 读）；LAN auth gate 先于 guard/RPC；query 全系列
（?、?x、?force=false、?name=、encoded）→400 INVALID_QUERY 且零 RPC；仅 PATCH 挂载
（POST/PUT 404）；content-type 415（含 charset 接受）；body 4KiB 413（declared+streamed）；
malformed/array/null→400 INVALID_JSON；strict 单字段（missing/extra/unknown/__proto__/
constructor/toString）→400；非 string/blank/201/control（NUL/C0/DEL）→400 INVALID_SESSION_
NAME 固定文案；Unicode/emoji/200 边界成功（100 emoji=200 code units、中文+emoji、200 ASCII）
canonical trim 且 seam 恰一次、内部空格保留；空 id 404 零 RPC；not_found 404 SESSION_NOT_
FOUND 固定文案无 id/name 泄漏；conflict/epoch_changed 409 SESSION_CHANGED 固定文案；
unavailable/timeout/unsupported/internal/worker_unavailable/session_busy/invalid_input/
unknown→503 SESSION_RENAME_UNAVAILABLE 固定文案无泄漏；raw socket/unknown error→503
sanitized。production-resources.test.mjs 更新：FULL 精确含 `session.write`（列表断言）+
full 含/degraded 不含断言。既有 `session.delete` 全部断言/行为不变（同文件同存）。

验证（全部实际执行）：host typecheck/build/check:boundaries（42 files）PASS；
host 全量 412/412（新增 18 rename，sessions.test.mjs 44/44）；CLI typecheck/test
46/46（客户端 dist 需先 build）；root typecheck/build/test 全绿（sessiond 229 含 1 既有
skip）、check:architecture PASS；Sessions/Runtime/Startup 三条 E2E PASS（Startup 验证
upCaps 含 session.write、degraded 不含；Sessions 验证 live+offline HTTP PATCH、down
收回+503、LAN auth、fail-closed 面）；git diff --check 干净。残余/后续：Client Sidebar
rename UI 为独立切片（见 §53，本记录不含 Windows claim；未触碰 Client source）。

独立验证 F1 修复（follow-up `ed733f5`，verifier 复播 PASS）：verifier 发现 createHostApp 在
sessiond up + capabilities.full 含 session.write + sessions.rename 缺失时 /v1/capabilities
仍返回 session.write 而 PATCH 路由 404 —— 能力 token 与路由挂载不同源。修复：health.ts 新增
`normalizeSessionMutationCapabilities`（能力过滤与路由挂载同一 source of truth：仅当
sessions.rename 存在才保留 session.write、仅当 sessions.delete 存在才保留 session.delete；
只移除不可能 token、绝不添加；read sessions 与其余 token 不变），resolveCapabilities 对
full 投影应用该 seam 过滤，对 readonly/down 投影无条件剥离两个 mutation token（down 无论
seam 与否都排除；自定义 readonly 列表含 mutation token 也在 down 时剥离）。custom 列表满足
“只删不增”：token 不在输入则绝不发明。生产默认（CLI host-runner / E2E bootStack 双 seam 常挂）
行为不变，Startup/Sessions/Runtime E2E 与 delete 语义不受影响。Host 新增 8 用例（health.test.mjs
真实 createHostApp /v1/capabilities 矩阵：up+无 seam/仅 rename/仅 delete/双 seam、down+双 seam
（含自定义 readonly 剥离）、production FULL 默认仍双、normalizeSessionMutationCapabilities
单元“只删不增”），Host 全量 412→420/420；CLI 46、root typecheck/build/test/architecture、
三条 E2E 全 PASS。
```

## 54. PR#3 — sessiond 进程内 Worker 诊断手动 port 切片（DONE）

```text
实现：source `db74383`（branch feat/sessiond-worker-diagnostics，base main `ef564b7`），current-main 集成 `49e6918`；Fresh verifier 独立 PASS，已准备合入 main，未 push/deploy/live service。编号：Host rename §52、Client rename §53 为并行保留号，本切片占用 §54。backend 仅 sessiond + docs + E2E 断言；无 Host /health、无 Protocol DTO、无 RPC method、无 CLI JSON、无 capability、无 package-lock。

目标：为测试/operator 内部提供权威的进程内 Worker 生命周期诊断，替代 E2E 中基于 pgrep
的进程扫描，同时绝不在任何公开面暴露标识符（session id/name/path/PID）。

冻结架构决策（父级明确，必须实现）：
1) `SessiondService.workerPids(): readonly number[]`：仅由权威 records 推导，绝不扫描
   进程；只包含 worker.pid 的有限安全正整数 PID（Number.isSafeInteger 且 >0），去重、
   数值升序；不携带 session id/name/path。starting/live/busy/stopping/crashed 且带真实
   子 PID 的 record 在精确 record 清理前都计入：stop 立即删 record；crashed record 保留
   至显式 stop/rekey/替换。rekey 只搬同一 record（不复制 PID），alias 不影响计数。
2) `diagnostics()` 扩展 `workersByStatus: Record<WorkerStatus, number>`：用
   `satisfies Record<WorkerStatus, number>` 字面量覆盖冻结 WorkerStatus 枚举全部 key
   精确 zero-fill（协议枚举新增 key 会编译失败）；按 records on demand 计算，sum 恒等于
   records 数。既有 sessions/creates/activations/subscribers/lanes/aliases/overlay
   语义不变。无持久化高基数历史、无 stderr、无 error message/path/PID 进 snapshot。
3) `DaemonHandle.diagnostics: DaemonDiagnostics`（@internal 句柄面，仅进程内）：方法
   `workerPids()` 与 `snapshot()`（仅有界计数 + 当前 PID），委托 live service；不做为
   Protocol DTO/RPC method/Host /health/CLI JSON/capability 导出；类型仅从 daemon
   composition 类型位置导出。关闭/shutdown 后返回空、无泄漏。
4) `packages/sessiond/src/rpc.ts` 删除手写重复 method set，改用 Protocol
   `SESSIOND_RPC_METHODS`（含 sessions.rename/delete），行为字节等价；新增 static/
   contract 测试防 drift（constant == request schema；server predicate 恰等于 constant；
   params/results key 1:1 与 constant 的编译期断言）。
5) Runtime/Sessions E2E：daemon 进程内运行时用 `daemon.diagnostics.workerPids()` 替换
   pgrep/`ps`/PID file/进程扫描与 fail-open `[]`；无进程名扫描、无 Windows 分支。Startup
   E2E 保持进程级（无安全进程内句柄，不强制扩面）。

安全/边界：
- 新诊断不含 raw stderr（含红acted 都不进新面）；StderrRing 不变。
- 无 secrets/env/endpoint/instanceId/session id/title/path/raw error；PID 仅经内部/
  测试句柄。
- 无新 timer/handle/retention；snapshot O(records)+固定枚举。
- 不宣称 Windows 支持；observer 本身跨平台，测试只按当前证据声明。
- 既存 child-stdio/worker-process redaction 与 session rename/delete 测试不变。

实现（packages/sessiond）：
- service.ts：新增导出 `SessiondDiagnostics` 接口；`workerPids()`；`diagnostics()` 增
  `workersByStatus`（satisfies 字面量 zero-fill + hasOwnProperty 防御计数）。
- composition/daemon.ts：新增 `@internal DaemonDiagnostics` 接口与 `DaemonHandle.diagnostics`
  字段；startDaemon 内建闭包委托 live service（workerPids/snapshot）。
- composition/index.ts：导出 `DaemonDiagnostics` 类型。
- rpc.ts：`isSessiondRpcMethod` 直接基于 `SESSIOND_RPC_METHODS`（删除 19 项硬编码 set）。

测试：
- 新增 packages/sessiond/test/worker-diagnostics.test.ts（13 用例，确定性 gated fake/
  bounded waitUntil，无 timing 断言）：workerPids 空/undefined 排除/starting 无 pid 排除/
  有效 pid 计入/重复 pid 去重/NaN/0/负/小数/非安全整数排除/rekey 不复制 PID/crash 保留至
  清理/stop 精确清理；workersByStatus 全 key 精确 + zero-fill + sum==sessions/starting→
  ready→busy 转换/多会话多状态/stopping 精确清理/stringified snapshot 无标识符无 PID。
- 新增 packages/sessiond/test/rpc-methods.test.ts（3 用例 + 编译期断言）：predicate 恰等于
  constant、constant==request schema、公开面无 diagnostics/PID。
- daemon.test.ts 新增 2 用例：daemon.diagnostics 委托 live service（权威 PID + 有界计数 +
  无标识符 + stop 清理）；handle-only（无 RPC/hello 增益、shutdown 后空且可调用）。
- E2E runtime.mjs / sessions-history.mjs：删除 pgrep/listChildPids/collectWorkerPids，
  改用 daemon.diagnostics.workerPids()（可断言真实 spawn/清理，pgrep 缺失时不再 false-green
  到 []）；Startup E2E 未改。

验证：sessiond typecheck/build/boundary PASS；sessiond 全量多轮 246-247 pass/0 fail/1 skip
（唯一偶发失败为既存 `RPC authenticates locally` 的 socket-close 时序 flake，与本切片无关，
单测隔离 3/3 PASS，baseline 229/229 PASS）；Runtime/Sessions E2E 各 2 轮 PASS；Startup
E2E 回归 PASS；root typecheck/build/test PASS；check:architecture PASS；git diff-check 与工作树 clean。Fresh verifier 重放 workerPids/workersByStatus/daemon.diagnostics、RPC wire、Runtime 两轮、Sessions 两轮、Startup 与 current-main merge-tree，确认 no-false-green、无 orphan、无公开面增益并给出 PASS。current-main 仅 ledger 追加冲突，Sessions E2E 自动合并同时保留 Host PATCH rename 与 handle diagnostics。

残余/后续：诊断面仅进程内句柄，未接任何 CLI/Host/Protocol 公开输出；Windows 支持不宣称；Host rename §52 已完成，Client rename §53 仍为并行切片。

## 55. Local Authority — `ensurePrivateDirectory` EEXIST/created 分类安全缺陷修复（二轮 Fresh verifier PASS）

```text
状态：DONE。source `14e7ca2`（EEXIST/created 分类修复）+ `772269d`（fd identity 钉住，修复首轮
verifier CRITICAL）+ `56fa417`（二轮 verifier 要求的残余窗口枚举）；首轮 verifier 对 14e7ca2 FAIL
（open 前替换真实目录被 fchmod），二轮 Fresh verifier 独立重放原注入对 772269d 给出 PASS 并要求
枚举第二个同 UID 残余窗口（mkdir→identity 捕获 lstat 之间）；合并 main（merge commit aef1a50，
仅 ledger 追加冲突），合并后 local-authority 53/53、Host 420/420、architecture、Startup E2E
（全量重建后）全 PASS；未 push/deploy/live。
范围：仅 packages/local-authority（src/state/posix.ts、src/state/index.ts、新增
test/secure-directory-race.test.mjs）+ docs；不碰 Host 策略/API、sessiond 私有目录、
package-lock/deps、merge/push/deploy/live service。不编辑 refactor-execution-plan。

确认缺陷（base ef564b7 src/state/posix.ts）：
首次 ENOENT 后置 creating=true；每个组件 mkdir 捕获并吞掉 EEXIST；随后
`if (current === normalized) leafCreated = true` 只按路径名相等判定，与本次 mkdir 是否成功无关。
因此一个被竞态/预植的既有 leaf（先观察到 ENOENT，再被他人 planted）会进入"新建"分支并被
fd-fchmod(0700)——破坏"既有 leaf 只读校验（validate-only）绝不 chmod"冻结契约，并可能跳过
validateExistingLeaf（Host 条目 allowlist）。

修复语义：
1) 逐组件按 mkdir 精确结果追踪创建：`mkdir(recursive:false, 0700)` 成功 fulfilled 才算
   createdByThisCall；EEXIST = 预植/竞态，绝不视为 created、绝不 fchmod。
2) ENOENT 之后出现 EEXIST：先做 lstat 类型检查（symlink/non-dir 仍 SYMLINK/NOT_DIRECTORY）；
   最终 leaf 走既有-leaf 路径（requireOwnedByCurrentUser、精确 requireMode、validateExistingLeaf
   钩子）并返回 created:false；竞态缺失尾 INTERMEDIATE 不强建后代——最强兼容策略：仅当真实非
   symlink 目录 + 当前用户拥有（按需）+ 精确私有 mode 才继续，并把其 dev/ino 记为 racedParent，
   在每次创建后代前重新校验（任何 swap fail-closed），否则 NOT_OWNED/NOT_PRIVATE 拒绝、零后代、
   零 chmod（保留同 UID 并发建目录的合法场景）。
3) 本次实际创建的组件照旧：leaf 仍走 fd fchmod + 身份校验，全缺失嵌套路径可用；leaf mkdir 成功
   返回 created:true。
4) mkdir EEXIST leaf symlink/non-dir → 固定 SYMLINK/NOT_DIRECTORY；lax 0755 → NOT_PRIVATE 且
   mode 保持 0755；validateExistingLeaf 钩子拒绝原样保留；外部/内部零突变；EACCES/raw 全部消毒为
   固定 LocalAuthorityError。
5) EEXIST lstat 与校验/open 之间的路径交换按当前 API 能力处理（Node 无 openat）：保留最终
   realpath/identity fail-closed；不夸大同 UID TOCTOU 的消除。

可测性（确定性，无概率循环）：
- 把 ensurePrivateDirectory 重构为内部 `ensurePrivateDirectoryWithFs(path, options, fs)`（注入窄
   fs ops：lstat/mkdir/realpath/open/isOwnedByCurrentUser），生产入口用真实 fs 委托同一实现。
- `ensurePrivateDirectoryWithFs` 是 TEST-ONLY 导出：只从直接模块路径 `dist/state/posix.js` 可达；
  `state/index.ts` 改为显式具名重导出（不再 `export *`），公共导出集保持精确（package-surface 测试
  仍 exact：dist/state/index.js 19 项，不含该 seam）。
- 新增 test/secure-directory-race.test.mjs（8 用例）：注入 lstat 首查 ENOENT、mkdir 强制 EEXIST、
  后续 lstat 用真实 fs，确定性复现竞态序列。

测试（旧实现必失败——已用 base 旧算法 + 相同注入逐条复现）：
- EEXIST raced final leaf 0755 → NOT_PRIVATE、mode 保持 0755、created 永不为 true（旧实现返回
  created:true 并 fchmod 0700）。
- EEXIST raced final 0700 + marker → validateExistingLeaf 运行且可拒绝、marker/文件不变、created:false
  （旧实现 created:true 且钩子 0 次调用）。
- EEXIST raced symlink → 外部 0755 目录 → SYMLINK、外部 mode/content 不变（回归守卫）。
- EEXIST raced intermediate 0755 → NOT_PRIVATE、零后代；非当前用户（注入 ownerCheck=false）→
  NOT_OWNED、零后代；0700 当前用户 → 强策略放行、后代 0700、created:true、raced 中间目录不被 chmod。
- 成功 mkdir leaf 经内部走查 → created:true + fd fchmod 0700；既有普通行为测试全过。
- 静态源码审计：leafCreated=true 只能出现在 mkdirFulfilled 成功分支，禁止
  `if (current === normalized) leafCreated = true`（旧缺陷模式）——对旧实现确定性 FAIL。

验证（本地实测）：
- local-authority：build/typecheck/boundary PASS；全量 51/51（原 43 + 新增 8）。
- Host：全量 394/394；安全子集（host-state-directory/production-resources/trusted-roots/
  managed-worktrees/security）113/113；typecheck/build/boundary PASS。
- root：build/typecheck PASS；check:architecture PASS（含 local-authority boundary）；
  check-architecture 自测 31/31；root test 全 workspace 绿（CLI 46/46、sessiond 228/1skip）；
  Startup E2E PASS。
- 旧实现失败证明：一次性脚本按 base 旧算法 + 同一注入 fs 复现——raced 0755 leaf 被报 created:true
  且 fchmod 0700；raced 0700 leaf 报 created:true 且钩子 0 次调用（确认缺陷）。
- 公共导出集精确（dist/state/index.js 19 项，不含 ensurePrivateDirectoryWithFs）；git diff --check 与
  提交后工作树 clean。

残余/不越界：
- 同 UID TOCTOU（Node 无 openat）按既有文档化方式保留；最终 realpath/identity fail-closed；不宣称
  消除同 UID 交换。
- sessiond 私有目录（agent 工作区等）属独立策略/加固，本切片不动，需另行独立评审/hardening。
- Host 策略/API、sessiond 私有目录、package-lock/deps、merge/push/deploy/live service 全部未动。

独立 verifier 必验：8 个 race 用例对旧实现确定性 FAIL、对修复 PASS；public 导出集精确；Host 状态
lease/open、trusted roots、managed worktrees、production resources 安全子集回归；既有目录绝不
chmod、macOS 别名、raw leak 测试；root/架构 + Startup E2E。
```

## 55.1 Local Authority — 独立 verifier CRITICAL 复现修复（14e7ca2 → follow-up；fd identity 校验）

```text
独立 verifier 对 14e7ca2 确定性 CRITICAL 复现并判 FAIL，本小节记录修复。范围不变（仅
packages/local-authority + docs；不动 Host 策略/API、sessiond 私有目录、package-lock/deps、
merge/push/deploy/live service；不编辑 refactor-execution-plan）。

verifier 发现（复现要点）：成功 mkdir 后、初始 lstat 已捕获本次创建的 inode，但随后注入的 fs.open
把路径名换成另一个真实 0755 目录再 open；14e7ca2 只靠 O_NOFOLLOW——它只能拒绝符号链接，拦不住真实
目录替换——于是对替换目录执行 fd fchmod(0700)，篡改攻击者目录，并返回 created:true/陈旧 identity、
跳过 Host validateExistingLeaf（posix.ts fchmod 分支无 fd 身份比对）。

修复（具体）：
1) 窄 opened-handle 接口扩为 OpenedDirectoryHandle{stat,chmod,close}（真实 FileHandle 结构兼容）；
   `mkdir(recursive:false,0700)` fulfilled 后立即从紧随的 lstat 捕获 createdIdentity{dev,ino}
   （本次调用创建的 inode）。
2) open 之后、fchmod 之前：fstat（dirHandle.stat()）必须为真实目录且 dev/ino 与 createdIdentity
   完全一致，否则固定 LocalAuthorityError UNSAFE_COMPONENT、零 fchmod；O_NOFOLLOW 单独不够。
   另在 open 前校验 createdIdentity 仍等于最后一次 open 前 lstat（finalInfo），open 前被替换也 fail-closed。
3) 身份校验通过才 chmod(requireMode)；随后再次 fstat：同 identity/类型且 (mode&0777)===requireMode，
   否则 NOT_PRIVATE。
4) 成功返回前：re-lstat 路径名，要求仍为同一已校验 inode（created 路径=创建句柄身份；existing 路径=
   已校验身份），替换在返回前发生即 fail-closed；保留 final realpath/canonical 检查。最终检查之后
   （句柄已关闭、无 openat 可重新钉住）的替换属文档化残余竞态，诚实声明，不宣称 fail-closed。
5) 所有 mismatch/error 路径 finally 关闭句柄（close 失败吞掉以免遮蔽主错误/raw 泄漏）；raw 错误
   全部消毒为固定 LocalAuthorityError。
6) 修正 posix.ts 模块头与本节措辞：准确表述为「fchmod 前 fd identity 校验 + fchmod 后复验 + 返回前
   pathname re-lstat」，残余为「最终检查之后的竞态」，不再用 blanket 同 UID fail-closed 表述。

新增确定性测试（test/secure-directory-race.test.mjs，10 用例；全部注入真实 fs、非概率）：
- created leaf 在 open 时被替换为真实 0755 标记目录并返回替换句柄 → UNSAFE_COMPONENT；替换目录
  mode/content 不变（绝不被 chmod）；本次创建的原始 inode 不变（0700、空）；created 永不为 true；
  validateExistingLeaf 不绕过。
- created leaf 在 open 时被替换为普通文件 → UNSAFE_COMPONENT；文件不变；原始 inode 不变。
两测试对 14e7ca2 确定性 FAIL（14e7ca2 直接成功返回、chmod 替换目录/文件并报 created:true，报
"Missing expected rejection: expected reject with UNSAFE_COMPONENT"），对修复 PASS；原 8 个 race
用例在 14e7ca2 与修复上均 PASS。

验证（本地实测，follow-up）：
- local-authority：build/typecheck/boundary PASS；全量 53/53（14e7ca2 的 51 + 新增 2）。
- Host：全量 394/394；安全子集 113/113；typecheck/build/boundary PASS。
- root：build/typecheck PASS；check:architecture PASS + 自测 31/31；root test 全 workspace 绿；
  Startup E2E PASS。
- 14e7ca2 编译实现 + 新测试实测：2 个 swap 测试 FAIL（直接成功返回并 chmod 替换对象）→ 证明缺陷；
  修复实现 10/10 PASS。
- public 导出集精确（dist/state/index.js 19 项，不含 ensurePrivateDirectoryWithFs）；
  git diff --check 与提交后工作树 clean。

残余（诚实声明，两个窗口）：Node 无 openat，同 UID 替换存在两个无法钉住的窗口，均不宣称
fail-closed：(1) fulfilled mkdir 与紧随的 identity 捕获 lstat 之间的替换——createdIdentity 会
捕获到替换对象身份，后续 walk 会 chmod 替换目录并返回 created:true（Node 无法原子 fd-pin
新建 inode；亚微秒窗口；14e7ca2 严格更弱，非 follow-up 引入）；(2) 最终 pathname re-lstat/
realpath 检查之后的替换（句柄已关闭、无 openat 可重新钉住）。跨用户边界不变弱。sessiond
私有目录仍需独立策略/加固。
二轮 Fresh verifier（772269d）独立重放原 CRITICAL 注入（替换目录/替换文件均 UNSAFE_COMPONENT、
零 chmod、替换对象 mode/content/inode 不变、句柄恰关闭一次）、原 8 race 用例、public 精确 19
导出、Host 394/394 + 安全子集 119/119、typecheck/boundary/architecture、current-main
merge-tree（仅 ledger 追加冲突），对 772269d 给出 PASS，并要求本节与 posix.ts 模块头枚举窗口
(1)——本修订即该要求。

## 56. authenticated-shutdown — sessiond 认证控制平面关闭 + ACK-before-close + CLI RPC-only down（PENDING 独立验证）

```text
实现：source `dfabec2` + follow-up `bad2e0c`（branch feat/authenticated-shutdown，base main `5b8a7c9`），
合并 main merge commit `5c29085`；未 push/deploy/live service。Fresh verifier 对 dfabec2 七门全 PASS（含
120+ 真实 socket 探针、外部 daemon exit 0、CLI 静态无杀回退扫描、三条 E2E 重放），非阻塞 robustness
建议（write callback 忽略 error 参数）由 bad2e0c 防御性修复，同 verifier 聚焦复验 PASS（聚焦套件
11/12/6、sessiond 269/1skip、真实 socket fail-closed 探针 30/30 行为不变）。仅 sessiond + protocol +
cli + docs + 测试 + E2E 断言，无 Host HTTP/capability/health/WS 变更、无 Client source、无 package-lock。
编号：§52/§53/§54/§55 已占用，本切片占 §56。手动 port 仅取 PR#3 有价值的
lifecycle 语义（认证 instance-fenced 关闭 + 交付屏障），不复制 PID/SIGTERM/PowerShell kill fallback。

目标/不变量：
1) 内部认证 sessiond RPC 方法 `system.shutdown`：strict params 携带 expected `instanceId`
   （NonEmptyStringSchema），strict result 冻结为 `{ accepted: true }`（`SystemShutdownResultSchema`）。
   AUTH secret 先于一切强制；与当前 daemon instance-lock identity 精确 fence。错 secret/instance、
   malformed、unsupported、timeout 全部 fail closed 且绝不能触发关闭；响应/日志不含 secret/
   endpoint/path/raw OS error。
2) ACK-before-close 为硬契约，无 sleep/delay hack：serial-writer 新增 `enqueueFlushed(data, timeoutMs)`
   有界交付屏障——真实 socket write callback +（write() 返回 false 时）drain，跨
   callback/drain/error/close/timeout 恰一次 settle；既有 ordering/backpressure/overflow 语义
   与无未处理 promise/无 listener 泄漏全部保留；daemon 关闭只在屏障成功后才发起。
3) RPC/application/daemon 组合：daemon-owned shutdown transition（shutdownPromise/closed lifecycle
   notification）仅由认证 + instance-fenced 响应交付后触发；并发合法请求至多一次 accepted 转换，
   全部确定性。RPC 连接 ACK 先 flush 再 server/socket close，无自死锁。普通 RPC 行为不变。
4) CLI `down` 变 RPC-only 生产 authority：经既有 secure local state/probe 路径读 endpoint+secret+
   instance identity，authenticate，ping 已由 inspectSessiond 完成，调 `system.shutdown`（exact
   instanceId）并有限等待 daemon lifecycle exit/state 消失。移除生产 SIGTERM/PID authority fallback
   全部；PID 仅作最后观察（实例确已退出），绝不 signal/kill。错 secret/instance/unsupported/
   timeout/connection failure 返回 sanitized 非零且进程不被触碰；旧 daemon 不被 fallback 杀掉。
5) 诊断保持内部：无 Host HTTP/capability/health/WS 变化；`system.shutdown` 仅 sessiond 控制 RPC，
   非产品 capability；CLI JSON/text 无 secret/instance 泄漏。

冻结架构决策（父级明确，必须实现）：
1) Protocol：`SystemShutdownParamsSchema`（strict {instanceId: NonEmptyStringSchema}）、
   `SystemShutdownResultSchema`（strict {accepted: literal(true)}）、request/success/failure union、
   `SESSIOND_RPC_METHODS`（含 "system.shutdown"）、SessiondMethodParams/Result/ResultSchemas 1:1。
2) SerialSocketWriter（packages/sessiond/src/internal/serial-writer.ts）：`enqueueFlushed(data,
   timeoutMs)` 复用同一有界队列（ordering/overflow/backpressure 不变）；屏障 settle 条件 =
   write callback fired AND（write()=false 时 drain fired）；超时从 enqueue 起算，超时/close/error
   走 `fail` 恰一次 reject；late callback/drain/error/close 全 no-op；timer 无泄漏（settle 或
   reject 时 clearTimeout）。
3) SessiondRpcServer（rpc.ts）：可选 `shutdownAuthority: { instanceId, initiate }`（无 authority 时
   `system.shutdown` → unsupported_capability，fail closed）；`handleShutdown` 先 fence instanceId
   （错配 → forbidden 固定文案，不 echo 任一侧 id），再 `writeAcked`（enqueueFlushed 屏障），屏障
   成功才调 `authority.initiate()`（至多一次/请求）；屏障失败/超时绝不 initiate。application 对
   `system.shutdown` 仅编译期穷尽性兜底（内嵌 throw，RPC server 拦截后永不达）。
4) Daemon（composition/daemon.ts）：shutdown/closed/shutdownPromise 定义提前到 server 构造前；
   `initiateShutdown` 一次性 guard 转 `shutdown()`（idempotent）；server options 注入
   shutdownAuthority{instanceId: lock.instanceId, initiate}；`runDaemon`/`main`（bin）已 await
   handle.closed，RPC 关闭后外部进程以 exitCode 0 退出，无孤儿。
5) CLI（supervise.ts）：`shutdownSessiond` 移除 process.kill(SIGTERM)；inspectSessiond 读锁 +
   secret + ping 确认可达 → RPC `system.shutdown`（client timeoutMs 有界）→ 轮询 lock+socket 消失
   （pid 仅观察）；失败原因固定 sanitized（unauthorized/forbidden/unsupported/timeout/…），绝不含
   secret/endpoint/instance/stack。down.ts 失败分支改 `sessiond: failed to stop (pid X): reason`。

安全/边界：
- 无 secret/endpoint/path/instanceId/raw error/stack 进入 RPC 响应、CLI 输出或日志；instanceId
  错配响应为固定 "sessiond shutdown refused"。
- 交付失败（write=false 无 drain / timeout / close / error）绝不触发 daemon 关闭——不因请求到达
  而关闭 authority。
- 不宣称 Windows 支持；进程 kill 仅保留 liveness probe（process.kill(pid,0)），无信号名 kill。
- 无 Host/capability/health/WS 公开面增益；`system.shutdown` 为 sessiond 控制 RPC 而非产品能力。

实现（文件）：
- packages/protocol/src/sessiond.ts：system.shutdown params/result/method-constant/schema 1:1。
- packages/protocol/test/contract.test.mjs：结果 fixture 增 {system.shutdown:{accepted:true}}。
- packages/sessiond/src/internal/serial-writer.ts：enqueueFlushed + FrameBarrier 屏障。
- packages/sessiond/src/rpc.ts：SessiondShutdownAuthority、handleShutdown、writeAcked、
  shutdownAckTimeoutMs（默认 2s）。
- packages/sessiond/src/application.ts：system.shutdown 穷尽性兜底 throw。
- packages/sessiond/src/composition/daemon.ts：initiateShutdown + shutdownAuthority 注入。
- packages/cli/src/supervise.ts：RPC-only shutdownSessiond + sanitizeShutdownFailure。
- packages/cli/src/commands/down.ts：失败分支 sanitized reason。

测试（新增）：
- packages/sessiond/test/serial-writer-ack.test.ts（11 用例：10 基线 + 1 follow-up 写回调报错 fail-closed）：write-callback 恰一次 settle、
  write=false 下 callback-before-drain / drain-before-callback、callback-without-drain 悬置、
  drain-before-callback + close reject、bounded timeout fail closed、error→close→late 全 no-op、
  close→error 幂等、ordering 保持、close 后 enqueue reject；follow-up：socket write callback 携
  error 时经既有 fail 路径 reject（绝不定成 success、late 事件 no-op、无 unhandled rejection）。
- packages/sessiond/test/shutdown-rpc.test.ts（12 用例）：错/missing AUTH 连接销毁无关闭；
  错 instanceId forbidden 无关闭；blank/malformed/unknown method invalid_request 无关闭；无
  authority unsupported 无关闭；合法请求 {accepted:true} 恰一次 initiate；backpressure 永不
  drain + 短 ack timeout → initiate 0；daemon 端合法 ACK 字节先于 close 再关闭、两并发至多一次
  转换、retry/进行中不双触发、错 instanceId daemon 保持 pingable。
- packages/cli/test/down-rpc.test.ts（6 用例）：错 secret 拒绝(obstructed) 非零目标存活；instance
  错配 forbidden 非零目标存活；hung response 超时非零目标存活；unsupported 非零目标存活；happy
  path 外部队列 daemon 退出并清锁/socket；static 源检查禁止 process.kill(SIGTERM/SIGKILL)/
  taskkill/powershell/unix kill fallback。
- 既有 supervise.test.ts 改造：SIGTERM stubborn 用例改为 legacy/unsupported 拒绝语义；"SIGTERM a
  running daemon" 改 RPC happy-path 命名与断言。

验证（实现者已执行，PENDING 独立 PASS）：
- protocol 132/132、cli 52/52、sessiond 269/1 skip（多轮稳定）；root build/typecheck/test 全绿；
  check:architecture PASS；sessiond/host boundary PASS；Startup（含 CLI `down --all` 经 RPC 退出
  daemon 并清 lock/socket）+ Runtime + Sessions E2E 全 PASS；git diff --check 干净；worktree 未
  push/deploy，未触碰 live service。

残余/后续：本切片为 RPC-only 关闭，不宣称 Windows；旧 daemon（无 shutdownAuthority）只能被
unsupported 拒绝，绝不 fallback kill；Local Authority race 仍在 §55 在飞；Fresh verifier 独立 PASS
待补。
```

## 58. sessiond POSIX private-directory hardening slice（DONE，Fresh verifier PASS）

```text
实现：source `4e74bd2` + docs `9ea55ad` + verifier 轮次措辞/计数修正 `12ebb25`（branch
feat/sessiond-private-dir，base main `d817a32`），合并 main merge commit `a299c19`（merge-tree
零冲突）；Fresh verifier 对 `9ea55ad` 全门 PASS（40 项独立对抗断言、独立重导 0755/raced-
EEXIST/open-swap、行为保全、material-risk 逐项裁定、残余窗口四项代码匹配）。§57 并行在飞，
本切片不触碰 §57 范围。编号：§53/§55/§55.1/§56 已占用，本切片占 §58；§57 由并行 agent 独立推进，合并
main 时若 ledger 尾段冲突按 append 解决，不覆盖对方小节。未 push/deploy/live service，未改
package-lock/deps（sessiond 未在 package.json 声明 local-authority，靠 npm workspace 顶层 symlink +
sessiond build-deps.mjs 新增 local-authority 构建顺序提供 dist；package-lock 零变更）。

目标（父级冻结的 HYBRID 架构）：sessiond 不整体委托本地状态给 local-authority，只复用其
canonical/error/identity 原语（canonicalizeAbsolutePath / posixFileIdentity / isOwnedByCurrentUser /
currentPrincipal / LocalAuthorityError 固定消毒码），sessiond 保留自有策略（secret 0600 不覆盖原子发布、
dead-pid stale lock 可回收、私有 socket alias/发布规则、实例锁语义）。

新增模块 packages/sessiond/src/local-posix.ts（仅 node 内建 + `@fffattiger/pix-local-authority/state`，
不含 Protocol/Runtime Core/Pi SDK/Hono/React，sessiond 边界检查保持通过）：
1) 私有目录 preflight `ensureSessiondPrivateDirectory`：先拒绝 operational LEAF 符号链接（固定
   SYMLINK，目标零触碰）；`canonicalizeAbsolutePath` 解析 macOS `/var`→`/private/var` 系统别名与既有
   符号链接后，对 canonical 路径做逐组件 walk——缺失则逐组件 mkdir(recursive:false,0700)（created leaf
   用 fd 身份钉住：open(O_RDONLY|O_NOFOLLOW) 后 fstat dev/ino 必须等于本次创建的 inode 才 fchmod 0700，
   fchmod 后再次 fstat 复验身份+精确 mode，最后 pathname re-lstat + realpath）；既有 leaf 只读校验
   （当前用户拥有 where supported、精确 0700、真实非符号链接目录）绝不 chmod。0755 既有布局 → 固定
   NOT_PRIVATE + operator 修复提示（sessiond 绝不静默 chmod）；竞态 EEXIST leaf → 既有-leaf 校验路径
   （created 永不为 true）；竞态缺失尾 INTERMEDIATE → 强策略（真实非 symlink + 当前用户拥有 + 精确
   0700）才继续，其 dev/ino 在创建后代前复验，否则零后代零 chmod。所有错误固定 LocalAuthorityError
   消毒码，无 raw path/errno。
2) 有界 re-verify `reverifySessiondPrivateDirectory`：每次关键变异（实例锁 O_EXCL、secret temp/sweep/
   发布、socket bind、public 发布、debris 回收）前，lstat operational 路径并钉住与 preflight 相同的
   dev/ino/真实目录（任何 swap/缺失/symlink → 固定 UNSAFE_COMPONENT）。
3) daemon 边界映射 `toSessiondPrivateDirError`（daemon.ts 内，local-posix 不 import Protocol）：仅
   LocalAuthorityError → 固定 SessiondError forbidden + 固定消息（复用 SESSIOND_PRIVATE_DIR_MESSAGES，
   永不回显 thrown message/path）；既有 SessiondError 与 raw 原样透传（保留既有 lock/socket 语义）。

local.ts 适配：移除旧 lax `ensurePrivateDirectory`（mkdir recursive + 无条件 chmod 0700，无条件 chmod
违反"既有目录绝不 chmod"）；`acquireInstanceLock`/`loadOrCreateLocalSecret`/`publishPublicEndpoint`
新增可选 `privateDir` 上下文（提供则 re-verify，缺省则自行完整 preflight 保持自足与既有直调语义）；
`recoverStalePublicSocket`/`recoverStalePrivateAliases` 仅在提供上下文时 re-verify（回收绝不自行创建
目录，直调行为不变）；public socket "not a socket" 消息移除内嵌 endpoint 路径（raw 泄漏修复，无测试
断言旧消息）。daemon.ts：startDaemon 首个动作即 preflight（.catch 映射），锁/恢复/secret/listen/发布
全部透传 privateDir 并在 listen 后（发布 public endpoint 前）再 re-verify（private socket 绑定由 loadOrCreateLocalSecret 内的更早 reverify 守护；窗口内 swap 由本次 reverify 检出并 fail-closed 回滚）；catch 统一映射 LocalAuthorityError。

残余窗口（诚实声明，均不宣称 fail-closed）：
- 与 Local Authority §55.1 相同的两个 created-leaf 窗口：(1) fulfilled leaf mkdir 与紧随 identity 捕获
  lstat 之间的替换会捕获替换者身份；(2) 最终 pathname re-lstat/realpath 之后（句柄已关、无 openat 可
  重新钉住）的替换。
- 有界 re-verify lstat 与随后实际变异非原子：re-verify 与 open 之间被同 UID 并发 actor 替换 → 变异落
  入替换目录（Node 无 openat，无法消除）。
- 既有 operational 中间符号链接（含 macOS `/var` 系统别名）由 canonicalize 解析而非拒绝；preflight
  walk 只拒绝 canonical 路径上的符号链接（missing-tail 中或竞态被 planted）。op re-verify 钉住
  operational 路径解析到的同一 inode，跨用户边界不变弱。

既有测试语义保持：stale dead-pid lock 回收、并发单实例、public 替换保护、sun_path 限制、symlink/
文件 debris fail-closed、Windows skip 全部不变。唯一既有测试适配（非期望变更，仅为与冻结策略对齐的
setup 修正，已在 handoff 诚实记录）：socket-publish.test.ts 的 sun_path 限制测试与并发启动测试原本用
`mkdir(dir,{recursive:true})`（0755）创建 runtime 目录，而冻结策略要求既有目录精确 0700 否则 fail
closed——两处 mkdir 改为 `{recursive:true, mode:0o700}`，测试真实意图（socket 长度 / 并发单实例）
与断言完全保留。新增 25 个对抗用例（local-posix 单测 16 + daemon 集成 9）：0755 既有 → NOT_PRIVATE
mode 不变零变异；0700 错主（owner 注入）→ NOT_OWNED；symlink leaf/中间 → SYMLINK 目标零触碰；
竞态 EEXIST leaf（0755 planted）→ validate-only 绝不 chmod 绝不为 created:true；全缺失嵌套 → 0700
created:true fd 身份 fchmod；created leaf open 换真实 0755 目录 → UNSAFE_COMPONENT 零 chmod；preflight
后目录 swap/missing/symlink → reverify UNSAFE_COMPONENT；lock/secret 换目录 ctx → UNSAFE_COMPONENT 且
替换目录零变异；secret marker 探针无 raw path/errno 泄漏；静态源码审计 leafCreated 仅由 fulfilled
mkdir 置位。

验证（实现者已执行，PENDING 独立 PASS）：sessiond 295 tests（294 pass + 1 Windows skip，多轮稳定无
flake；基线 270 → 新增 25）；root build/typecheck/check:architecture（14 gates）PASS；root test 全
workspace 绿（scripts 107 / agent-worker 105 / cli 52 / client 627 / host 420 / local-authority 53 / pi-sdk-adapter
236 / protocol 132 / runtime-contract-tests 76 / runtime-core 12 / sessiond 295）；sessiond/host
boundary PASS；Startup + Sessions + Runtime E2E 全 PASS（Startup 确认 daemon 在缺失 runtime 目录时创建
0700 并正常启动、CLI down 清 lock/socket）；git diff --check 干净；package-lock 零变更；工作树
未 push/deploy/live。

残余/后续：Windows 支持不变（getuid 不可用时 ownership 校验按需关闭，仅此改动，不宣称原生 Windows）；
本地 authority 未整体委托；Fresh verifier 独立 PASS 待补。
```
