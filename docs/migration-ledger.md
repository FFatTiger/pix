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
验证：定向27/27覆盖true→false撤回(同QueryClient缓存立即隐藏+unavailable+无新fetch)、pending撤回晚到成功不显示、初始无cap零context fetch+unavailable非No messages、有cap+empty No messages、live=true无sessions cap live消息正常且不fetch context、现有history回归；Client373/373、typecheck/build/boundary/architecture/diff-check PASS。环境说明：worktree交付缺node_modules，`tsc -p packages/protocol`在基线b6bea16即复现`Cannot find module 'zod'`/`structuredClone`/implicit-any(环境阻塞，非代码)；symlink同commit main的node_modules后基线与with-changes的typecheck/build均PASS。仅Client两文件、低风险Client-only只读节点，按协作规则未单独启动verifier。
边界：testing子路径仅E2E使用；SDK import仍限adapter internal；D1B-3不是archive、all branches或raw JSONL导出。
独立验证 verdict：D1A PASS；D1B-1/2/3为低风险Client-only节点，由父审查与门禁验收
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
