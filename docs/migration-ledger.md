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
| `packages/host` boot surface | `integration-v1@e3508e2`，source tree `207e9446378a0e8586ae17659b905d3310d05875` | H0A/H1B 旧验证通过 | Hono app/server、gate/security/static、health、WS guard 基础 | 未使用的旧兼容装配；M1 可暂不挂 files/git/worktree | B2 `DONE`：`c65d2df`；H1 `IN_REVIEW`：`e9e7d49` + `f960390`，Host163/163，等待GPT |
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
Protocol：WS新增getSnapshot/stop；response严格结果union；attach result必填workerStatus；ProtocolVersion仍1
sessiond client：新增@fffattiger/pix-sessiond/client；attach subscription暴露closed Promise；initial failure与post-attach close严格区分
Host：SessiondRuntimeGateway完成handshake/create/cold-open attach/detach/command/interrupt/getSnapshot/stop；initial snapshot回显attach id，replay/live无id
安全与生命周期：原Host/Origin/Origin/LAN gate在upgrade前不变；browser close只detach不stop；unexpected stream close发送runtime_unavailable并1011；outbound 256 frames/4MiB + bufferedAmount fail closed
CLI：只读secret，缺失/unsafe fail closed；注入gateway；保留36e81d4 trusted host合并；agent capability继续[]直到R2/X1
本地验证：architecture/build/typecheck/root tests/startup E2E/boundaries PASS；Host163/163、Protocol114/114、sessiond42/42、CLI32/32、A192、Client82、Contract75、Core3、scripts44
残余：真实Worker尚未由R2接通，故gateway已可用但create/activate仍会诚实返回worker_unavailable；getSnapshot/stop当前在长command后串行，C1需先interrupt再stop。
独立验证 verdict：IN_REVIEW（首次GPT为PARTIAL：功能/协议/gate/生命周期/真实RPC均PASS，但发现普通入站队列和interrupt并发耗尽。`976c4c6`加入每socket 256帧/4MiB与interrupt16上限；GPT复验确认原165MB/50k并发复现已关闭。其后发现NaN options可禁用bound，`a6eb571`将inbound/outbound非有限、非正、非safe integer统一回退安全默认；Host172/172，等待最终快速复验。）
```

## 11. 后续迁移时必须记录的校验

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

## 12. sessiond 特别保护

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

## 13. 旧结果可用性摘要

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

## 14. 完成条件

迁移阶段完成必须同时满足：

1. 所有活动代码在 `pix`。
2. 旧 worktree 不再承载新的功能开发。
3. `pix` 根无 Next 产品路径。
4. 每个迁入包有来源记录和重验结果。
5. M1 Startup E2E 通过。
6. 旧 worktree 在确认备份策略前仍不删除。

## 15. 命名决策（历史证据说明）

产品命名已一次性统一为 `pix`（决策 `N-009`）：npm 包 `@fffattiger/pix-*`、CLI `pix`/`pix-host`/`pix-sessiond`、env `PIX_*`、运行目录 `~/.pi/pix/sessiond`。生产代码、manifest、CLI、服务字段、env、PWA/UI、测试与当前文档均不再使用旧品牌名，也不提供兼容 alias。上游 Pi SDK 概念保持原名：`@earendil-works/pi-*`、`PI_CODING_AGENT_DIR`、`~/.pi`、`packages/pi-sdk-adapter`。

本台账上方出现的旧名（如仓库路径 `/Users/proxy/Documents/program/pi-web`、worktree 根 `pi-web-worktrees`、来源子路径 `bin/pi-web.js`、旧包名 `@fffattiger/pi-web-*`、来源 commit 与 tree hash）属于迁移来源的**历史证据**，按要求原样保留，用于追溯来源与审计；它们不代表当前产品命名。架构门禁 `no legacy product name` 明确排除本文件，使这些历史路径可作为证据留存。
