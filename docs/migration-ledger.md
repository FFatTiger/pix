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
实现：本任务执行体（Fresh session）；独立 worktree d2p5-bash-control，branch feat/d2p5-bash-control，base main 811c94e，implementation `3ce5d2d`，docs follow-up `ea95102`。目标：真实贯通 bash 命令 + abort_bash 控制（独立 interrupt 路径，长 bash 不 HOL 阻塞 abort）；production capability 精确加 runtime.bash / runtime.bash.abort（9→11 token）；Client SessionStore 暴露 typed runBash / abortBash helper。与 D3A host 并行 slice 并行进行，未触碰 host 文件/资源、D1 会话、trusted-roots ledger、upload transaction、package-lock、无关 UI。状态 DONE（Fresh GPT 独立验证 PASS）。

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
