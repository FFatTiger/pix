# Pix 跨端完善计划（Windows / Linux / macOS）

> 基线：`main@bd3224860e7434df28ac2750490b2a77a98afb34`（2026-08-17）
> 调研时间：2026-08-17
> 进度同步：`feat/cross-platform-g0-baseline`（已 merge `origin/main@73fa042`）
> 范围：原生 Windows、原生 Linux、原生 macOS；同时覆盖浏览器/PWA、CLI、Host、sessiond、Worker、文件/Git、构建、安装与发布
> 非范围：不读取、不合并、不 cherry-pick `fix/cross-platform-dev`；不以 WSL、Docker 或虚拟机替代 Windows 原生产品支持；不在本计划中实现 Tauri/Electron 壳
> 状态：专题计划仍有效。活动任务与验收只写在 `docs/refactor-execution-plan.md` §1.3（CP-00–CP-35）。§0–§15 的 2026-08-17 审计是历史快照；当前事实以 §16 为准。

---

## 0. 执行摘要

2026-08-17 审计时，`main` 的跨端状态不是“Linux/macOS 已完成、只差 Windows”，而是：

| 平台 | 当时判断 | 当时主要阻塞 |
|---|---|---|
| Windows 原生 | **产品不可启动** | sessiond 和 Host 在 named-pipe 分支之前进入 POSIX 路径/权限实现；根脚本与 release verifier 也未通过 Windows 约束 |
| Linux | **主要产品路径按 POSIX 设计可工作，但没有持续证明** | 无 Linux CI；锁/secret/进程树/文件监听仍有现存风险；无发行 artifact 原生验证 |
| macOS | **主要产品路径按 POSIX 设计可工作，但没有持续证明** | 无 macOS CI；`sun_path`、APFS 大小写/Unicode、TCC、签名/公证和发行验证未关门 |

**2026-08-18 起该表已过时。** 当前诚实状态见 §16：Windows 原生 **Supported**（source-build 启动 + VS Code taskkill 子孙清理，不是 packaged 发行）；Linux/macOS 仍是 Unverified-native。

本次代码审计确认的最高优先级事实：

1. **Windows 的 named pipe 代码存在，但正常启动永远先失败。**
   `packages/sessiond/src/composition/daemon.ts:251-260` 无条件调用 `local-posix.ts`；`packages/local-authority/src/state/posix.ts:150-152` 明确拒绝盘符路径。Windows 实跑：
   - `node packages/cli/bin/pix-sessiond.mjs` → `sessiond private directory path is invalid`
   - Windows-only named-pipe 正向测试也在 preflight 处失败。
2. **Host 同样硬编码 POSIX secure-state backend。**
   `packages/host/src/resources/host-state-directory.ts:73-83,487-500` 直接创建 `createPosixSecureStateBackend()`，并在 `341-348` 从 `/` 手写路径 walk。
3. **所谓“平台中立”接口实际上仍是 POSIX 接口。**
   `SecureStateBackend.kind` 只能是 `"posix"`，identity/principal/ownership 是 `dev/ino/uid/gid/mode/nlink`。不能只新增一个 `windows.ts` 然后伪造这些字段。
4. **Linux/macOS 当前也有 sessiond 单实例与 secret 安全问题。**
   stale lock 删除和 release 只按路径/JSON 内容，不按文件 identity；已有 secret 读取后才 `chmod(0600)`，未先拒绝宽权限、错误 owner、hard-link、oversize。
5. **根跨平台工具本身在 Windows 失败。**
   本机 `node scripts/run-node-test.mjs "scripts/**/*.test.mjs"`：113 tests，106 pass，6 fail，1 skip；失败包括分隔符断言、`isWithin`、drive-root 错误分类。`check:architecture` 单独通过不等于 Windows 构建链通过。
6. **发布验证完全是 Unix 布局。**
   `scripts/release-verify.mjs` 依赖外部 `tar`、`prefix/bin`、`prefix/lib/node_modules`、`sessiond.sock`、仅设置 `HOME`，无法证明 Windows 安装/升级/卸载。
7. **Client 的 Windows 路径只是“换成正斜杠”，没有完整 drive-root/case 语义。**
   `packages/client/src/features/workspace/paths.ts` 用 POSIX parent/breadcrumb 逻辑处理 `C:/`，会把 drive root 压成 `C:`，且 containment 大小写敏感。
8. **LAN PWA 的产品承诺缺少 secure-context 合同。**
   HTTP 局域网地址可打开普通 Web UI，但浏览器通常不会允许 service worker、安装式 PWA 和部分 Clipboard API；当前注册失败只写 console 和隐藏 state。
9. **没有任何 `.github/workflows`。**
   因此仓库没有 Linux、macOS 或 Windows 的持续运行证据。
10. **Protocol/version 与 E2E 基线还有与跨端无关但会阻塞矩阵的漂移。**
   `packages/protocol/src/version.ts` 已冻结 Runtime Protocol v2，但三条 E2E 仍发送 `protocolVersion: 1`；`packages/host/src/types.ts` 的 HTTP bootstrap 常量仍是 `HOST_PROTOCOL_VERSION = 1`。在建立三端 required E2E 前必须先区分“Runtime Protocol v2”和“Host bootstrap schema version”，并消除 magic number，否则平台 job 会被预存量协议失败污染。

### 最终路线

按依赖拆成九个 Gate，但不是所有平台串行等待 Windows：

```text
共同前置：G0 基线诚实化/工具链 → G1 路径与 identity 合同

POSIX lane：  G2A POSIX hardening → G3-POSIX → G4-POSIX → G6-POSIX
Windows lane：G2B Windows backend → G3-Windows → G4-Windows → G6-Windows
Client/PWA：  G1 的 Protocol path-flavor 合同完成后进入 G5，可与两条 backend lane 并行
CI：          G0 起逐 seam 转为 required；G7 汇总完整矩阵
发布：        各 lane 达标后进入 G8，不让 Windows 未完成阻断 Linux/macOS 发布闭环
```

**Windows 原生 Supported 仅覆盖 source-build 启动与日常开发路径。** 不得在 G7 完成前宣称 packaged 安装/升级或 Linux/macOS 产品化验证。

---

## 1. 审计方法、边界与证据

### 1.1 本地代码审计

本次逐层检查了：

- `packages/local-authority`
- `packages/sessiond`
- `packages/cli`
- `packages/host`
- `packages/agent-worker`
- `packages/pi-sdk-adapter`
- `packages/client`
- 根 `scripts/*`
- `tests/e2e/*`
- 架构与执行文档

审计维度：路径、权限/ACL、symlink/junction/reparse、file identity、锁与 PID、Unix socket/named pipe、进程树、signal/stdio、Git 子进程、watch、错误净化、PWA secure context、包布局、安装/升级/卸载、签名、公证和 CI。

### 1.2 本机验证环境

- OS：Windows 原生
- Node：`v25.9.0`
- npm：`11.13.0`
- Git：`2.53.0.windows.3`
- PowerShell：`5.1.26100.9168`

仓库声明的最低 Node 是 `>=22.19.0`；按 semver，这也覆盖 Node 25。因此本机失败证明“Windows + 当前 engines 范围内 Node 25 存在未满足合同”。后续 CI 必须覆盖 22.19 和明确 pin 的 LTS；若项目只打算支持 LTS major，应在独立决策中收窄 engines/support policy，不能把已落在 `>=22.19.0` 内的版本简单称为“未声明支持”。

### 1.3 已执行的关键探针

| 探针 | 结果 |
|---|---|
| `git status --short --branch` | `main@bd322486`；仅本计划文档为预期新文件 |
| `npm run check:architecture` | PASS，14 gates |
| `git diff --check` | PASS |
| `node packages/cli/bin/pix-sessiond.mjs` | FAIL：`sessiond private directory path is invalid` |
| `node scripts/product-entry.mjs cli start --no-open` | FAIL：sessiond early exit |
| Windows named-pipe 定向 test | FAIL：仍死于 private-dir preflight |
| `npm test --workspace @fffattiger/pix-local-authority` | 53 tests：16 pass / 36 fail / 1 skip；大量 POSIX-only 断言在 Windows 失败 |
| `node scripts/run-node-test.mjs "scripts/**/*.test.mjs"` | 113 tests：106 pass / 6 fail / 1 skip |
| `npm audit --omit=dev` | 1 moderate direct issue：`mermaid 11.14.0`；与跨端主线不同，但发布前需升级/处置 |

### 1.4 外部调研原则

只采用 GitHub 主仓库源码和 workflow 作为主要证据，并固定到调研时 HEAD：

| 项目 | 调研 commit | 适用度 |
|---|---|---|
| VS Code | `03459a7e73daf894cc2cdd282d41b09d1517cb68` | TypeScript/Node IPC、路径、watch、OS CI；Windows ACL/服务实现是强参考 |
| OpenCode | `1c965451b537e1af4bff12c163200f762a6a0364` | 最接近的 TypeScript 本地 server/CLI；XDG 路径、Windows/Linux test、签名发布 |
| Continue | `5522c6f44ca0ac3528b37244818fbfa39b5af470` | TypeScript/React/本地 core；多 OS/arch packaging 和 platform binary 选择 |
| Goose | `3810898a7447ec3299be72e223d3570a7aabf0ab` | 原生三端产品；OS 分包、Windows Authenticode、macOS 签名/公证、平台 signal |
| Cline | `8bbdde2a5c1f972864fe1b954f639c21fac61a40` | TypeScript daemon/storage/shutdown；Windows SDK CI、macOS Unicode 路径处理 |

Rust/Electron/Tauri 部分只借鉴 OS 原语和发布流程，不把产品壳或运行时直接复制进 Pix。

---

## 2. 当前跨端架构地图

```text
Browser / PWA
    │ HTTP + WS
Hono Host
    │ local RPC
pix-sessiond
    │ stdio NDJSON
agent-worker × N
    │ Runtime Port
pi-sdk-adapter → ~/.pi JSONL
```

跨端敏感点及当前 owner：

| 领域 | 当前 owner | 现状 |
|---|---|---|
| Host durable state | `host-state-directory.ts` + `local-authority/posix.ts` | POSIX hard-coded |
| sessiond runtime dir/lock/secret | `sessiond/local-posix.ts` + `sessiond/local.ts` | 独立重复 POSIX 实现；named pipe 选择发生太晚 |
| IPC endpoint | `sessiond/local.ts` | Unix socket 与 named pipe 已分支，但 Windows 不可达 |
| Worker process | `sessiond/composition/worker-process.ts` | stdio-first；signal escalation 不具备 Windows 语义/最终失败证明 |
| Host subprocess | `host/resources/process-runner.ts` | 只杀直接 child；raw OS/Git 错误可进入 API |
| Allowed roots | `host/resources/allowed-roots.ts` | realpath + dev/ino；缺 Windows reparse/case/file-ID 合同 |
| Client path UI | `client/features/workspace/paths.ts` 等 | POSIX 归一为主；Windows drive-root 不完整 |
| Build orchestration | `scripts/run-*`, `remove-paths`, `tool-invocation` | 方向正确，但 Windows tests 仍红；root runner 尚有 `shell:true` fallback |
| Release verify | `scripts/release-verify.mjs` | Unix-only |
| PWA | `client/public/sw.js`, `PwaRegistration.tsx` | localhost/HTTPS 可行；HTTP LAN 降级未产品化 |
| CI | 无 | 三端都没有持续证明 |
| Protocol/E2E baseline | Protocol owner 为 v2；部分 Host/E2E 仍写 1 | 在跨端 required matrix 前先消除版本词义/fixture 漂移 |

---

## 3. 问题清单（按严重度）

## 3.1 P0：阻断原生 Windows 或单一 authority 安全

### CP-001 — Windows sessiond 的 named-pipe 分支不可达

**证据**

- `packages/sessiond/src/composition/daemon.ts:251-260`
- `packages/sessiond/src/local-posix.ts:184-215,437-459`
- `packages/local-authority/src/state/posix.ts:140-175`
- `packages/sessiond/src/local.ts:101-107`
- `packages/sessiond/test/socket-publish.test.ts:511-525`

**现象**

`sessiondPaths()` 正确生成 `\\.\pipe\pix-sessiond-*`，但 daemon 先做 POSIX private-dir preflight。普通 `C:\Users\...` 在 endpoint bind 前就被 `WINDOWS_PATH` 拒绝。

**要求**

- platform backend 选择必须发生在任何路径 walk、lock、secret 或 IPC mutation 之前。
- 禁止把 `C:\...` 加入 POSIX walk 的特殊分支。
- Windows 正向测试必须真实走完：private state → lock → secret → named pipe listen → authenticated ping → shutdown。

---

### CP-002 — Host durable state 同样无法在 Windows 安全启动

**证据**

- `packages/host/src/resources/host-state-directory.ts:73-83,341-383,401-450,487-500`
- `packages/local-authority/src/state/contracts.ts:63-180`

**问题**

Host 无条件构造 POSIX backend，并在 Host 内继续维护 `/` 根 walk。即使绕过 sessiond，Host state 也无法为 Windows 提供 owner-only ACL、reparse 拒绝、file ID、atomic publish 和 lifetime lock。

**要求**

Host 只能注入/调用 `SecureStateBackend`；不得自行 walk 平台路径。Windows backend 不完整时必须固定错误、fail closed，不能以 `chmod` 或“getuid 不存在则跳过”冒充安全。

---

### CP-003 — secure-state contract 仍是 POSIX 数据模型

**证据**

- `packages/local-authority/src/state/contracts.ts:63-180`

当前 contract 暴露：

- `PosixFileIdentity`
- `PosixPrincipal`
- `requireMode`
- `dev/ino`
- `kill(0)`
- `kind: "posix"`

**要求**

先改 contract，再写 Windows backend。建议改成操作语义 + opaque/discriminated evidence：

```ts
type SecureStateBackendKind = "posix" | "windows";

type FileIdentity =
  | { kind: "posix"; dev: number; ino: number }
  | { kind: "windows"; volumeSerial: string; fileId: string };

type Principal =
  | { kind: "posix"; uid: number; gid?: number }
  | { kind: "windows"; sid: string };
```

目录私密性应由 backend 解释为“满足 owner-only policy”，而非让上层传 `0700`。

---

### CP-004 — sessiond stale-lock recovery 存在 replacement race

**证据**

- `packages/sessiond/src/local.ts:135-178`

流程是：读 lock → PID dead → `rm(lockPath)`。没有 identity pin/recheck。另一个实例可在读和删之间替换 lock，旧实例会删掉新 lock，破坏 sessiond 唯一 authority。

**要求**

- strict read 返回 identity。
- stale reclaim 必须同时匹配 record + identity。
- 删除前再次验证；任一变化 → `conflict`/`unsafe`，绝不删。
- Windows 使用 volume serial + file ID 或等价 handle identity。
- 此项先修 Linux/macOS，再复用到 Windows；不能把 race 搬进新 backend。

---

### CP-005 — sessiond lock release 只看 instanceId，不看 identity

**证据**

- `packages/sessiond/src/local.ts:147-161`

**要求**

release 必须满足“记录 instanceId + 文件 identity + 类型”三重匹配；replacement、symlink/reparse、missing 均是 no-op/fail-closed，不能删别人的 lock。

---

### CP-006 — 原生 Windows 没有 private state DACL 合同

**要求**

Windows backend 至少验证：

- owner SID = 当前进程用户；
- DACL protected（禁继承）；
- 允许主体范围按产品决策冻结：当前用户 + SYSTEM；是否允许 Administrators 必须显式决策并测试；
- directory/file child ACL 可继承且创建后回读验证；
- 既有宽 ACL 不静默修复，默认 fail closed；如未来提供显式 repair command，必须是单独权限边界和人工确认；
- 中间层和 leaf 的 symlink/junction/mount point/其他 reparse point policy 明确。

VS Code 的 Windows 实现直接用当前用户 SID 和 Win32 security APIs，而不是 `whoami`/`icacls` 文本解析：

- https://github.com/microsoft/vscode/blob/03459a7e73daf894cc2cdd282d41b09d1517cb68/cli/src/tunnels/agent_host_registry_acl_windows.rs

Pix 的 `local-authority` 允许依赖 Node builtins + 自有模块；Node builtins 不足以完整提供 DACL/file ID 时，应采用**窄 native helper/sidecar**，而不是 shelling out 到 locale-sensitive 命令。新增依赖前需独立安全评审。

---

## 3.2 P1：三端安全、生命周期与数据正确性

### CP-007 — sessiond secret 的现有文件验证不 fail-closed

**证据**

- `packages/sessiond/src/local.ts:216-277`

已有 secret 只检查 regular/symlink 和最小字符串长度，读取后才 `chmod(0600)`；未检查 owner、mode/DACL、hard-link、大小上限、identity 变化。

**风险**

- POSIX：宽权限 secret 已经泄露，事后 chmod 无法收回。
- Windows：`chmod(0600)` 不等于 owner-only DACL。

**要求**

将 secret publication 建立在 secure document primitive 上：bounded read、owner/private policy、hard-link/reparse 拒绝、identity pin、atomic no-replace publish、固定错误。保留“0-byte legacy debris”策略时，必须 identity-pinned 且有有限移除条件/测试。

---

### CP-008 — PID-only liveness 无法抵抗 PID reuse

**证据**

- `packages/sessiond/src/local.ts:129-175,286-307`
- `packages/cli/src/supervise.ts:70-183`

**要求**

锁记录增加 process-start identity，不能只记 `pid`：

- Linux：`/proc/<pid>/stat` starttime 或等价；
- macOS：`proc_pidinfo`/native helper 或明确仅用 authenticated endpoint，不自动回收无法证明的 lock；
- Windows：process creation time + PID；
- authenticated `system.hello` 的 instanceId/协议版本仍是最终 authority 证据。

任何“无法验证”必须 obstructed，而不是自动 reclaim。

---

### CP-009 — Worker close 最后超时被忽略

**证据**

- `packages/sessiond/src/composition/worker-process.ts:362-406`

发送最后 kill 后，`waitForExit()` 返回值被忽略；即使 child 未退出，`close()` 也成功返回并清理 stream。

**要求**

- final wait=false 必须成为 typed lifecycle failure/diagnostic，不能报告已关闭。
- Windows 不把 `SIGTERM`/`SIGKILL` 名字解释成 POSIX 两级语义；至少冻结为：stdin EOF grace → direct termination → process-tree termination/Job Object。
- worker 和 Host Git runner 都需要 descendant cleanup 测试。

---

### CP-010 — Host Git runner 只杀直接 child

**证据**

- `packages/host/src/resources/process-runner.ts:56-80`

Git hook、credential helper、filter 或其他 descendant 可能在 timeout/abort/output-limit 后存活。

**要求**

建立 owner：`ProcessTreeController`。

- POSIX：仅对 Pix 创建的隔离 process group 做 TERM/KILL；
- Windows：Job Object 或窄 native helper；
- 每次启动保存 generation/start identity；
- direct child 和 grandchild 都必须在验收后死亡；
- 不使用 `taskkill`/PowerShell 作为生产 authority fallback。

---

### CP-011 — detached sessiond 丢失唯一可操作启动诊断

**证据**

- `packages/cli/src/supervise.ts:195-249`
- daemon fatal 只写 stderr；detached spawn 使用 `stdio: "ignore"`。

**要求**

- sessiond 在 private state 下维护 bounded/sanitized startup diagnostic record，或在 detach 前使用一次性 bootstrap pipe。
- CLI early-exit 输出固定 code + 建议；debug 模式可输出 private log 路径，但默认不得泄露 secret/raw payload。
- 覆盖 permission、socket-length、module resolution、ACL/reparse、protocol mismatch。

---

### CP-012 — Host/Worker 错误净化未覆盖 Windows 路径，Git 错误公开 raw text

**证据**

- `packages/agent-worker/src/mapper/protocol-error.ts:17-32`
- `packages/host/src/resources/process-runner.ts:96-136`

Worker redaction 只识别多段 `/foo/bar`；未覆盖：

- `C:\Users\name\...`
- `C:/Users/name/...`
- `\\server\share\...`
- `\\?\C:\...`
- `file:///C:/...`

Host 则直接返回 spawn `error.message` 和 Git stderr。

**要求**

- 公共错误文案 fixed by code；raw diagnostics 仅内部、且先 redaction。
- shared semantic contract 测 Windows/POSIX/UNC/file URL/credential URL。
- 不以英文 substring 作为长期错误分类；若保留 SDK message shim，必须注明版本、删除条件和 tests。

---

### CP-013 — 外部 sessionId open 缺少打开后 identity check

**证据**

- `packages/pi-sdk-adapter/src/internal/sdk-runtime.ts:406-412`

`listAll()` 找到 ID 后直接 `SessionManager.open(info.path)`，未检查 `manager.getSessionId() === requestedId`。

**要求**

建立 adapter-owned exact-open helper：index match → open → ID equality → revision/file identity fence。路径复用/错 ID 必须 `not_found` 或 `conflict`，绝不启动 Worker 到另一个 session。

此问题所有平台都存在，Windows case-insensitive/path reuse 使它更容易暴露。

---

### CP-014 — AllowedRoot/ledger/worktree 的 Windows identity 与 case 合同未冻结

**证据**

- `packages/host/src/resources/allowed-roots.ts:135-157`
- ledger 使用 POSIX-only `isAbsoluteCanonicalShape`
- worktree record 依赖 `dev/ino`

**要求**

定义统一 `PathAuthority` 语义：

- path display 与 comparison key 分离；
- Windows drive letter/case folding；
- macOS case-sensitive 与 case-insensitive volume 不以 `process.platform` 猜测；
- NFC/NFD 仅用于 display/search 辅助，不改变安全 identity；
- symlink、junction、mount point、firmlink、UNC、`\\?\`、SUBST 的 policy 明确；
- 不存在 leaf 的 create authorization 必须验证最近存在 parent；
- ledger schema 需要 platform identity/version，不能把 Windows file ID 填进 `dev/ino`。

如 persisted schema 改为 v2，必须提供**显式版本迁移**，旧 v1 在 POSIX 保持可读；Windows 首发可只写 v2。不得加无删除条件的兼容 shim。

---

### CP-015 — Files upload 的 hard-link 事务在跨文件系统能力上未抽象

**证据**

- `packages/host/src/routes/files.ts:402-499`

create/backup 依赖 hard link。同目录通常同 volume，但 FAT/exFAT、SMB、特殊挂载、权限策略可能不支持 hard link；Windows AV/OneDrive 还可能锁 rename/remove。

**要求**

- 在平台能力层定义 upload transaction strategy。
- hard-link 不可用时不能静默降级成非原子假成功；可返回 fixed `UNSUPPORTED_FILESYSTEM`，或实现有证明的同目录 rename-based strategy。
- Windows AV/EBUSY/EPERM 只允许**有界、特定 errno** 重试。
- 测试 NTFS、APFS、ext4；SMB/NFS/exFAT 写入列为非承诺，除非有 CI/实验室证据。

---

## 3.3 P1/P2：文件监听、Client 与 PWA

### CP-016 — `fs.watch(file)` 没有跨端 rename/recreate 状态机

**证据**

- `packages/host/src/resources/file-watch.ts:51-83`

当前 callback 忽略 eventType，async stat 可重叠/乱序；atomic save、delete+recreate 后 watcher 可能失效或继续指向错误 identity。

**要求**

选择并冻结一种语义：

1. rename/delete 后发送 terminal event 并关闭；或
2. watch parent directory，对 exact child 做 serialized reconciliation、AllowedRoot reauthorization 和 generation fencing。

建议 2，因为编辑器普遍采用 atomic replace。watch 事件只是 invalidation hint，最终状态来自 authoritative stat/reauthorize。

---

### CP-017 — Client workspace path helpers 不支持完整 Windows drive-root/case

**证据**

- `packages/client/src/features/workspace/paths.ts:21-162`
- `packages/client/src/features/workspace/paths.test.ts:12-28,50-89`
- `packages/client/src/lib/file-paths.ts:1-42`

**具体缺陷**

- `C:/` 去尾斜杠后变 `C:`；
- parent 使用 POSIX `/`；
- breadcrumbs root label/path 不稳定；
- containment 大小写敏感；
- `getRelativeFilePath` 大小写敏感；
- 多个独立 helper 各自实现 Windows 检测，可能漂移。

**要求**

Client 建立一个 browser-safe `PlatformPath` owner，输入同时携带 path flavor（由 Host bootstrap/DTO 提供，不能只靠 UA 猜）：

```ts
type PathFlavor = "posix" | "windows-drive" | "windows-unc";
```

必须覆盖：`C:\`、`C:/`、`c:\Repo`、不同 drive、UNC policy、root parent、breadcrumbs、relative、copy/mention、Git status key、Unicode。

---

### CP-018 — HTTP LAN 不等于可安装 PWA

**证据**

- `packages/client/src/components/pwa/PwaRegistration.tsx:12-44`
- `packages/client/public/manifest.webmanifest`
- `packages/client/public/sw.js`
- Host 默认明文 HTTP。

浏览器通常只在 HTTPS 或 localhost/loopback trusted context 开放 service worker。`http://192.168.x.x:30141` 即使有密码，仍不是 secure context。

**产品合同必须明确**

| 访问方式 | 普通 Web | Service Worker / 安装 PWA | Clipboard 等 secure APIs |
|---|---|---|---|
| `http://localhost` / loopback | 支持 | 支持（浏览器特例） | 浏览器依实现支持 |
| LAN HTTP IP/DNS | 支持但标记 degraded | **不承诺** | 不承诺 |
| LAN HTTPS / trusted reverse proxy | 支持 | 支持目标 | 支持目标 |

**要求**

- bootstrap 暴露 effective secure-context/forwarded-https 诊断，不新增伪 capability。
- UI 显示 PWA/Clipboard 降级，不只 console.warn/hidden span。
- 文档给 HTTPS reverse-proxy 配置和 trusted proxy boundary。
- Playwright 覆盖 localhost HTTP、LAN HTTP degraded、LAN HTTPS。

---

### CP-019 — Service Worker cache version 默认永久为 `1`

**证据**

- `PwaRegistration.tsx:25-26`
- `sw.js:8-18`
- 仓库没有注入 `VITE_SW_VERSION` 的 build step。

**要求**

使用 canonical package version + build commit/hash；build N → N+1 验证旧 cache 删除、offline shell 更新、API 永不 cache、rollback 不破坏启动。

---

### CP-020 — Client platform detection 顺序会把 iOS 识别为 macOS

**证据**

- `packages/client/src/runtime/runtime-provider.tsx:43-49`

先测 `/Mac/`，再测 `/iPhone|iPad|iPod/`。iPhone/iPad UA 通常含 `like Mac OS X`，因此会投影为 `mac` 而不是 `ios`。

**要求**

- 顺序先 mobile 后 desktop。
- 新 iPad desktop UA 结合 touch points；保持 `unknown` fail-closed。
- identity 只用于 UX/telemetry/capability request metadata，不得成为 Host 授权依据。

---

### CP-021 — macOS shortcut 文案与实际行为不一致

**证据**

- `ChatInput.tsx` 实际接受 `ctrlKey || metaKey`
- i18n 固定显示 `Ctrl+Enter`

**要求**

保持一个 semantic preference，但按 client platform 渲染 `⌘ Enter` / `Ctrl+Enter`；Windows 额外测 AltGr 不误触发，三端都测 IME composition。

---

## 3.4 P1/P2：工具链、发行与支持矩阵

### CP-022 — 根 script tests 在 Windows 是红的

**证据**

本机完整脚本 test：113 total，6 fail，1 skip。主要涉及：

- `scripts/remove-paths.test.mjs`
- `scripts/run-workspaces.test.mjs`
- `scripts/check-architecture.test.mjs` 的路径分隔符断言

**要求**

- production helper 与 tests 均使用 platform-neutral comparison。
- fixture 期望值不得硬编码 `/`。
- root `npm test` 必须进入 Windows required job，不只跑选定 package。
- `run-workspaces.mjs` 复用 `tool-invocation.mjs` 的 npm JS CLI，移除 Windows `shell:true` fallback。

---

### CP-023 — startup E2E 不是 Windows acceptance test

**证据**

- `tests/e2e/startup.mjs:206-219,278-286,631-647,801-815`

存在无条件 `SIGTERM`/`SIGKILL` signal 断言、inode、`sessiond.sock` 和 cleanup signal 假设。

**要求**

拆成：

- `startup.shared.mjs`：capability、Host restart、sessiond PID/instance continuity、RPC down、ledger behavior；
- `startup.posix.mjs`：signals、socket files、mode bits、inode；
- `startup.windows.mjs`：named pipe、DACL/file ID、console/process termination、no socket debris。

共享验收不能用平台特有实现细节。

---

### CP-024 — release verifier 是 Unix-only，且复制整个开发 `node_modules`

**证据**

- `scripts/release-verify.mjs:85-105,166-227`

**要求**

- 采用 `npm pack`/Node 归档，不依赖外部 tar。
- 从 installed package manifest/bin 解析 launcher；Windows 识别 `.cmd`/`.exe`。
- 从 npm prefix 查询实际 global root，不写死 `lib/node_modules`。
- 使用 `sessiondPaths()`/control API，不写死 socket。
- sandbox 同时设置 `HOME`, `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `TMPDIR`, `TEMP`, `TMP`, npm cache/prefix。
- artifact closure 从 package metadata 构建；禁止复制整个 root `node_modules`。
- 输出内容 manifest/SBOM/size；检查没有 dev-only、错误 OS native artifact、源码缓存和 secrets。
- 三端都做 packed artifact install → version → daemon/RPC → Host/client → upgrade → uninstall。

---

### CP-025 — 没有三平台 CI 与 target-native release lane

当前没有 `.github/workflows`。

**要求**

不能用 Linux cross-build 替代 macOS/Windows launch test。至少：

- Windows PR runner 上构建、安装、启动、named pipe、DACL、process tree 和 unsigned/ad-hoc artifact 内容验证；真实 Authenticode 仅 protected release job；
- macOS PR runner 上构建、socket safe payload 103 bytes（`sockaddr_un.sun_path` 总容量 104）、APFS/Unicode 和 unsigned/ad-hoc artifact smoke；Developer ID/公证仅 protected release job；
- Linux runner 上构建、socket safe payload 107 bytes（总容量 108）、mode/owner、systemd optional smoke、AppArmor/LSM 错误映射。

---

### CP-026 — Runtime Protocol v2、Host bootstrap version 与 E2E magic number 漂移

**证据**

- `packages/protocol/src/version.ts`：`PROTOCOL_VERSION = 2`
- `packages/host/src/types.ts:112-113`：`HOST_PROTOCOL_VERSION = 1`
- `tests/e2e/startup.mjs:133`
- `tests/e2e/runtime.mjs:282`
- `tests/e2e/sessions-history.mjs:192`

三条 E2E 的 WS handshake 发送 v1，而严格 Protocol schema 只接受 v2。Host HTTP bootstrap 的 `protocolVersion: 1` 又可能表达另一个版本体系，但名字宣称“mirrors the client's PROTOCOL_VERSION”。

**要求**

- 保留 Protocol owner 的 canonical 名称 `PROTOCOL_VERSION`；Runtime WS/E2E/importer 统一从 `packages/protocol/src/version.ts` 导入，不另造 runtime version 常量。
- 若 HTTP Host bootstrap 确有独立 schema version，只把它重命名为 `HOST_BOOTSTRAP_SCHEMA_VERSION` 并写明独立原因；否则直接投影 `PROTOCOL_VERSION`。
- 更新 `docs/refactor-architecture.md` 中仍写 “Runtime Protocol v1” 的目标描述，使其与当前 v2 owner 一致。
- 在 G0 CI 前跑通 Startup/Runtime/Sessions baseline；平台 lane 不承担预存量协议失败。
- 任何临时 v1/v2 bridge 都按 compatibility shim 登记版本、测试和精确删除条件。

---

## 4. 分平台专题

## 4.1 Windows 原生

### 必须支持

- PowerShell/cmd/Windows Terminal 直接运行 `pix start`。
- 默认 `%USERPROFILE%\.pi` truth source 保持与 Pi SDK 一致。
- Host/sessiond state 可仍放在 `.pi/pix`，但 ACL 和 runtime/data/log separation 要明确；不得要求用户迁移到 WSL。
- named pipe 只供本机，且具有明确的用户隔离/认证策略。
- `C:\...` workspace、大小写变体、Unicode/空格路径、junction 攻击、NTFS file ID。
- npm 全局安装 `.cmd` launcher；Windows Defender/Controlled Folder Access/OneDrive 锁错误可诊断。

### 首发拒绝项

在没有完整设计/测试前，建议先拒绝：

- UNC/network roots；
- `\\?\` extended-length paths；
- device namespace；
- ReFS/exFAT/SMB 上的 write/worktree mutation；
- Windows Service/system-wide daemon。

拒绝必须是固定 `invalid_input`/`unsupported_filesystem`，不是路径“看起来像能用”后半程失败。

### Windows security backend 验收

- current user SID 获取不依赖 locale 文本；
- DACL protected；
- existing lax state dir fail-closed；
- junction/reparse escape；
- file ID replacement race；
- same-path alternate-case；
- PID + creation time；
- named pipe 双启只有一个 authority；
- wrong user/secret/instance 不能 attach/shutdown。

---

## 4.2 Linux

### 当前优势

POSIX backend 设计最贴近 Linux：mode/uid、O_EXCL、O_NOFOLLOW、hard-link、dir fsync、Unix socket。

### 未闭环问题

- 无 native CI/发行 smoke；
- default runtime dir 未利用 `XDG_RUNTIME_DIR`；
- config/data/cache/log/runtime 混在 `~/.pi` 语义下；
- root/sudo policy 未冻结；
- SELinux/AppArmor/readonly home/rootless container 错误净化；
- NFS/SMB/inode instability；
- optional systemd user lifecycle/linger 文档。

### 方向

- **Pi truth source 不迁移**：`~/.pi`/`PI_CODING_AGENT_DIR` 保持。
- Pix 自有 ephemeral runtime 可优先 `XDG_RUNTIME_DIR/pix`，无安全 runtime dir 时回退 private `~/.pi/pix/runtime`；这是 persisted path change，必须有版本化 discovery/migration。
- systemd user unit 仅作为后续可选安装模式；当前 `pix start` detached 模式先保持，不能让 systemd 成为基本依赖。

---

## 4.3 macOS

### 当前已处理

- `/var` → `/private/var` root alias；
- `sun_path` 当前代码按 104-byte 总容量检查；目标实现应冻结为最多 103 bytes payload + NUL，并以 native bind test 证明；
- narrow dir-fsync unsupported errors。

### 未闭环问题

- 无 macOS CI；
- APFS volume 可能 case-insensitive 或 case-sensitive，不能按 OS 写死；
- HFS+/APFS Unicode decomposition、Screenshot 文件名特殊空格；
- TCC 对 Desktop/Documents/Downloads 的 EPERM；
- firmlink/Data volume；
- quarantine、Gatekeeper、签名、公证；
- Intel/Apple Silicon artifact；
- Keychain（后置，但 secret-at-rest owner 必须清晰）。

Cline 对 macOS Unicode whitespace/NFD 做了专门恢复逻辑，可借鉴为**用户输入/display 辅助**，但安全 authorization 仍必须依赖真实 filesystem identity：

- https://github.com/cline/cline/blob/8bbdde2a5c1f972864fe1b954f639c21fac61a40/sdk/packages/shared/src/storage/path-resolution.ts

---

## 5. 成熟产品的处理方式与 Pix 取舍

## 5.1 VS Code：平台 owner，而不是到处 `if (win32)`

### 证据

- IPC：Windows named pipe；Unix/macOS socket；Linux 优先 `XDG_RUNTIME_DIR`；显式处理 103/107 bytes。
  - https://github.com/microsoft/vscode/blob/03459a7e73daf894cc2cdd282d41b09d1517cb68/src/vs/base/parts/ipc/node/ipc.net.ts#L886-L950
- Windows ACL：当前用户 SID + protected DACL + Win32 API，回读验证。
  - https://github.com/microsoft/vscode/blob/03459a7e73daf894cc2cdd282d41b09d1517cb68/cli/src/tunnels/agent_host_registry_acl_windows.rs
- 后台服务：Windows、Linux、macOS 分别实现 Run registry/hidden process、systemd user、launchd。
  - https://github.com/microsoft/vscode/blob/03459a7e73daf894cc2cdd282d41b09d1517cb68/cli/src/tunnels/service_windows.rs
  - https://github.com/microsoft/vscode/blob/03459a7e73daf894cc2cdd282d41b09d1517cb68/cli/src/tunnels/service_linux.rs
  - https://github.com/microsoft/vscode/blob/03459a7e73daf894cc2cdd282d41b09d1517cb68/cli/src/tunnels/service_macos.rs
- 三端独立 test workflow。

### Pix 采用

- `LocalPlatform`/`SecureStateBackend`/`IpcEndpoint`/`ProcessTreeController` 四个 owner。
- Windows 使用 SID/ACL 原语，不解析 `icacls` 文本。
- Unix socket 位置和 path budget 属于 IPC owner。

### Pix 不采用

- 当前阶段不自动注册系统后台服务；先保证 CLI detached lifecycle，service install 后置。

---

## 5.2 OpenCode：XDG 路径分层、Windows/Linux 真机 test、发布签名

### 证据

- `data/cache/config/state/tmp/log/repos` 分离：
  - https://github.com/anomalyco/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/packages/core/src/global.ts
- Windows/Linux unit + E2E matrix；Windows watcher 暂时显式禁用，而不是假装 parity：
  - https://github.com/anomalyco/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/.github/workflows/test.yml
- Windows Authenticode 验签、macOS native target/build/signing jobs：
  - https://github.com/anomalyco/opencode/blob/1c965451b537e1af4bff12c163200f762a6a0364/.github/workflows/publish.yml

### Pix 采用

- 区分 truth/config 与 Pix runtime/cache/log。
- 未支持的 watcher/platform feature 诚实 disable/capability retract。
- 签名后必须回读验证，不以 action exit 0 为唯一证据。

### Pix 注意

OpenCode 在调研 commit 的主 test matrix 未包含 macOS，说明“有三端 artifact”不等于“三端同等 test”。Pix 应比它更严格。

---

## 5.3 Continue：每个 OS/arch 构建自己的 artifact 和 native assets

### 证据

- Windows x64/arm64、Linux x64/arm64/armhf/alpine、macOS x64/arm64 matrix：
  - https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/.github/workflows/main.yaml#L45-L105
- platform-specific native package/binary mapping：
  - https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/extensions/vscode/scripts/prepackage-cross-platform.js

### Pix 采用

- 发行物按 OS/arch 构建并在目标 OS smoke。
- 如引入 native helper，使用显式 target matrix、checksum 和 artifact presence validation。

### Pix 不采用

- Continue 的扩展 host 生命周期不能证明独立 daemon 的 single-instance、pipe ACL 或 orphan cleanup。

---

## 5.4 Goose：三端 signal、platform binaries、签名/公证分 lane

### 证据

- Unix 同时处理 Ctrl+C/SIGTERM；非 Unix 只处理平台可用的 Ctrl+C：
  - https://github.com/block/goose/blob/3810898a7447ec3299be72e223d3570a7aabf0ab/crates/goose-cli/src/signal.rs
- Windows build/package/sign workflow，复制 `platform/windows/bin`，Authenticode 回读：
  - https://github.com/block/goose/blob/3810898a7447ec3299be72e223d3570a7aabf0ab/.github/workflows/bundle-windows.yml
- macOS x64/arm64、codesign/notarization lane：
  - https://github.com/block/goose/blob/3810898a7447ec3299be72e223d3570a7aabf0ab/.github/workflows/bundle-macos.yml

### Pix 采用

- signal vocabulary 按平台定义，不假装同名 signal 等价。
- platform helper 独立目录/包，release 按 target 选择。
- Windows/macOS 签名必须 target-native。

---

## 5.5 Cline：数据路径 owner、daemon 单一 shutdown state machine、macOS Unicode 专项

### 证据

- HOME/USERPROFILE/HOMEDRIVE+HOMEPATH fallback 与集中 data path：
  - https://github.com/cline/cline/blob/8bbdde2a5c1f972864fe1b954f639c21fac61a40/sdk/packages/shared/src/storage/paths.ts
- daemon shutdown：startup 前装 handler、共享 cleanup promise、deadline watchdog、second signal force：
  - https://github.com/cline/cline/blob/8bbdde2a5c1f972864fe1b954f639c21fac61a40/sdk/packages/core/src/hub/daemon/entry.ts
  - https://github.com/cline/cline/blob/8bbdde2a5c1f972864fe1b954f639c21fac61a40/sdk/packages/core/src/hub/daemon/shutdown-coordinator.ts
- Windows SDK CI：
  - https://github.com/cline/cline/blob/8bbdde2a5c1f972864fe1b954f639c21fac61a40/.github/workflows/sdk-test.yml

### Pix 采用

- 单调 shutdown state machine + bounded watchdog。
- Path owner 支持 Windows home env，但 Pix 状态 override 必须严格绝对路径。
- macOS Unicode 辅助逻辑仅用于用户体验，不替代 security identity。

---

## 5.6 共同规律

成熟产品的共同做法：

1. 平台差异收口到 owner，而不是散落在 route/component。
2. Windows 用 ACL/SID/file ID/named pipe/process tree；不模拟 POSIX mode/signal。
3. Linux/macOS 可共享 POSIX 基础，但各自有 socket、filesystem、permission、service 和 release tests。
4. watch 不是可靠日志；需要 reconcile。
5. artifact 在目标 OS 构建/签名/启动。
6. “支持”由 required CI 和 packaged smoke 定义，不由 README 或编译成功定义。

---

## 6. 目标架构

```text
packages/local-authority
  contracts.ts             # 平台中立操作语义 + discriminated evidence
  platform.ts              # createSecureStateBackend / path policy selection
  posix.ts                 # Linux + macOS secure state
  windows.ts/native-helper # Windows SID/DACL/file ID/reparse/atomic state

packages/sessiond
  local-policy.ts          # sessiond 自有 stale-reclaim/no-replace policy
  ipc/
    endpoint.ts            # LocalEndpoint discriminated union
    unix.ts                # private bind + safe publication/recovery
    windows.ts             # named pipe bind/security/ownership
  process/
    worker-supervisor.ts   # monotonic state machine
    process-tree.ts        # platform controller

packages/host
  resources/path-authority.ts   # allowed-root authorization owner
  resources/process-runner.ts   # process-tree controller + fixed errors
  resources/file-watch.ts       # reconcile state machine
  host-state-directory.ts       # 只消费 backend，不碰平台 walk

packages/client
  lib/platform-path.ts          # browser-safe display/comparison/path flavor
  features/platform/            # keyboard/PWA/secure-context UX

scripts
  release-layout.mjs            # npm/package layout owner
  release-verify.mjs            # shared orchestration + OS adapters
```

### 6.1 核心类型

```ts
type LocalEndpoint =
  | { kind: "unix"; path: string; maxBytes: 103 | 107 }
  | { kind: "named-pipe"; path: string; scope: string };

type ProcessIdentity =
  | { kind: "posix"; pid: number; startTicks?: string }
  | { kind: "windows"; pid: number; creationTime: string };

type CanonicalPath = {
  display: string;
  comparisonKey: string;
  flavor: "posix" | "windows-drive" | "windows-unc";
};
```

### 6.2 不变量

1. `jsonl` / Pi agent dir 继续是真相源，不因 OS 改变。
2. Host/sessiond/Client 不共享 fake POSIX identity。
3. capability 与 authorization 分离；平台未接通的能力不广告。
4. 所有 wait 有界、所有 pending 恰一次 settle。
5. 外部 path/session ID 在 permissive helper 前 fail-closed。
6. Windows 不使用 `chmod` 作为 ACL 证明。
7. Unix 不因为修 Windows 而放松 mode/owner/symlink/hard-link/fsync 规则。
8. 不自动接受 UNC/extended path/network filesystem。
9. release artifact 必须由 target-native job 验证。

---

## 7. 分阶段执行计划

## G0 — 基线诚实化、诊断与 CI 骨架

**目标**：先让仓库准确显示“哪里支持、哪里失败”，并建立三端最小 required jobs。

### 交付

- README 支持矩阵：Windows unsupported、Linux/macOS unverified-native。
- `pix doctor --platform` 或等价只读诊断：OS/arch/Node/backend kind/state dir/endpoint kind/path byte budget/Git version/secure-context guidance；不泄 secret；同时提供稳定 JSON 输出供 CI 分类。
- 所有新增可见诊断/PWA/shortcut 文案通过 Client `t()` 或 owner 的集中 `describeXxxError` helper，不新增硬编码用户文案。
- sessiond 启动 diagnostic record/一次性 bootstrap channel。
- `G0-required`：install、architecture、当前可运行的 root script/package baseline，必须绿色；
- `G0-known-gap`：Windows product smoke 以非阻塞 job 证明**固定预期失败码**，不得把整个 Windows job `continue-on-error`；
- E2E protocol/version magic number 先收敛，保证三端 baseline failure 真的是平台问题；
- 每完成一个 seam，就把对应测试从 known-gap 移入 required；
- 固定 Node matrix：22.19.x + 一个明确 pin 的 active LTS major；Node Current/25 作为 scheduled compatibility job。若项目继续声明 `>=22.19.0`，Current 失败必须被视为 engines 合同缺口，而不能描述为“未声明支持”；否则应另行收窄 engines/support policy。
- 将本机已确认失败转成 issue/task IDs，禁止 README 写“跨平台完成”。

### 验收

- 三 runner 都能执行 dependency install 和 architecture gate。
- CI 输出按类别区分：tooling、secure-state、IPC、product smoke、release smoke。
- Windows 错误明确为 native backend missing，不推荐 WSL。

---

## G1 — Path/Identity Contract 平台化

**目标**：不做行为放宽，先让 contract 能诚实表达三端。

### 生产改动

- 重构 `local-authority/contracts.ts`：去除 Posix-only public contract；保留 POSIX adapter 内部 type。
- 新建 canonical path domain model；**wire DTO/path-flavor vocabulary 由 `packages/protocol` 持有**，local-authority 只拥有 filesystem canonicalization/identity，Client 只拥有 browser display/relative/breadcrumb 逻辑。
- ledger v2 设计：identity discriminant；v1 POSIX reader 保留有限兼容。引入 PR 必须登记 shim ID、bridge schema、首次版本、精确删除版本/commit 条件和 upgrade/downgrade/corrupt tests，不能只写“用户迁移完成后”。
- Protocol path-flavor DTO + Host mapper + Client strict decoder + `cross-package-contract-tests` parity；明确旧 Client/新 Host、新 Client/旧 Host 的 decode 行为，必要 shim 按 §10 登记。
- HTTP bootstrap/health/capabilities 与 WS handshake 中凡投影该词汇的表面必须来自同一 owner，不得独立镜像。
- 冻结路径政策：
  - POSIX absolute 支持；
  - Windows drive absolute 支持；
  - UNC/`\\?\` 初期拒绝；
  - generic symlink/reparse 中间层拒绝；
  - macOS root system alias 继续允许；
  - case sensitivity 由 filesystem evidence/identity，不仅 OS 字符串。

### 测试

- pure path corpus：POSIX、drive、UNC、extended、mixed separators、NUL/control、Unicode NFC/NFD、drive case。
- ledger v1/v2 parse/serialize/migration。
- Client drive-root breadcrumbs/parent/relative/copy/mention。

### Gate

POSIX golden tests 零语义退化；Windows path 不再被 contract 本身视为假 POSIX。

---

## G2 — Secure State：POSIX 修复 + Windows Native Backend

### G2A — POSIX 现存风险先修

- identity-pinned sessiond stale reclaim/release。
- secret bounded/private/owner/nlink validation；移除“读取后 chmod 修复”。
- root policy：默认拒绝 root，或显式 `--allow-root` 并降低保证；必须冻结。
- Host/sessiond 共用 secure primitives，但允许不同 policy 参数；不重复 filesystem race 实现。
- macOS alias policy 只有一个 owner。

### G2B — Windows backend

- 当前用户 SID、DACL、protected inheritance。
- file ID、volume serial、process creation time。
- reparse point classification。
- atomic document write/no-replace publish/flush/replace contract。
- lifetime lock acquire/read/release/reclaim identity。
- Host 与 sessiond composition root 使用 `createSecureStateBackend()`。

### Native helper 决策 gate

**已冻结（CP-07 / CP-07A）**：Node builtins 不能完整提供 SID/DACL、reparse tag、128-bit file ID、Job Object 或安全 Named Pipe 证据。采用 `packages/local-authority` 私有 raw C Node-API addon（N-API v8，首发 `win32-x64-msvc`），不引入 `node-addon-api`、Rust/napi-rs、额外生产 workspace 或 one-shot broker。

- 同步原语只返回 SID / handle-based path evidence；不把 HANDLE 交给 JS。
- Job Object 与 secure Named Pipe 后续必须是 retained 异步 Node-API resource，不能用一次性 helper 把权威交给 `node:net`。
- 构建只使用经验证的 npm-bundled node-gyp JS CLI，`process.execPath` + `shell:false`。
- helper/binding 失败必须 fail-closed；Host/sessiond 不得直接 import Win32 细节。
- 在 G2B backend 接通并验证前，不得宣称 Windows 产品支持；`createSecureStateBackend()` 在 Windows 仍返回 `UNSUPPORTED_PLATFORM`。

### 验收

- Windows default state dir 启动通过；ACL 被放宽/继承/reparse → fail closed。
- Linux/macOS 原 0700/0600/symlink/hardlink/fsync/race tests 全绿。
- Host 与 sessiond 源码中零直接 `createPosixSecureStateBackend()`；POSIX constructor 仅在 local-authority 的 platform factory 和专项测试可见，backend selection 在 state-dir walk/lock/secret/IPC mutation 前完成。

---

## G3 — sessiond IPC、单实例与进程生命周期

### IPC

- Windows pipe name 使用 stable per-user scope + bounded hash，避免直接泄露完整 home path。
- named pipe 必须具有可验证的当前用户隔离（DACL/等价 OS 证据）并继续使用 secret + instance fence；文档说明不能代替 pipe security acceptance。
- Unix socket path 使用 UTF-8 byte 预算，Linux 107、macOS 103（保留终止 NUL 余量）；测试长 ASCII/Unicode home。
- public/private publication 仅 Unix；Windows 不走 inode cleanup。

### 单实例

- lock + authenticated hello + process identity 三重证据。
- concurrent start 10+ rounds，每端只有一个 winner。
- stale/unsafe/unverifiable 分开；不在猜测下替换 authority。

### Worker/process

- monotonic supervisor：`starting → ready → stopping → terminating → exited|failed_to_terminate`。
- stdin EOF 是首选 grace。
- **低层 process identity/tree termination 由一个共享平台 primitives owner 持有**（需在实现前作架构决策：扩展 local-authority 或新增窄包）；sessiond 只拥有 Worker lifecycle policy，Host 只拥有 Git command policy，二者不得各写一套 Job Object/process-group 逻辑。
- POSIX process group / Windows Job Object descendant cleanup。
- final kill 未退出必须向 service 暴露失败，不 fake success。

### CLI lifecycle

- `pix status`/`down --all` 使用 endpoint owner，不检查 pipe 文件存在。
- detached startup 有诊断。
- Ctrl+C 只停 Host；sessiond 保活；RPC down 停 authority。

### 验收

- Windows named pipe 双启、wrong auth、shutdown。
- stale/release races 使用注入式 barrier 确定性覆盖：strict-read 后替换、identity recheck 前替换、同 PID 不同 creation time、late exit 对新 generation 无效；10+ rounds 只作为 native smoke，不能替代 deterministic tests。
- Host restart、daemon continuity、wrong-secret/wrong-instance、crash/restart、grandchild cleanup。

---

## G4 — Host Files/Git/Watch/Worktree/Error Boundary

### Path authority

- AllowedRoot 使用平台 identity；Windows junction/reparse native tests。
- Pi resource discovery 用 junction fixture，不因 symlink privilege 全 skip。
- exact external session ID helper完成。

### Git/process

- fixed public errors；raw Git stderr 仅内部 redacted log。
- process env 审计；保留 Git 必需 env，避免无意转发 credential-bearing变量。
- descendant tree kill。
- `git -z`/Unicode/newline path native tests。

### Watch

- parent-watch + serialized reconcile + generation。
- atomic save/delete/recreate/root replacement。
- uncertainty/overflow → rescan，不把 raw event 当 authority。

### Upload/worktree

- filesystem capability probe；hardlink strategy fail-closed。
- Windows base path、branch、file ID、case aliases。
- macOS APFS、Linux ext4 native smoke。

### Error contract

- Windows/POSIX/UNC/file URL redaction。
- adapter 行为契约（exact-open 等）放 `runtime-contract-tests` 或 adapter 自身 focused tests；跨 Host/Adapter/Worker 的 code/redaction parity 放 `cross-package-contract-tests`，不得混放。
- shared test contract 覆盖 Host → adapter → Worker code/message parity。

---

## G5 — Client/PWA/Browser 平台合同

### Client path owner

统一：workspace paths、file paths、file links、mentions、Git keys、breadcrumb、copy path；删除重复且漂移的判断。

### Platform identity

- 修 iOS-before-Mac detection。
- Host bootstrap/Protocol DTO 返回 workspace path flavor；UA 只做 UI hint。
- 任何 wire schema 变更都要覆盖 strict decode failure、HTTP/WS projection parity 和旧/新版本组合。
- shortcut 文案 `⌘`/`Ctrl`；AltGr/IME tests。

### PWA/secure context

- UI 显示 `installable | web-only | insecure-origin | registration-error`。
- LAN HTTP 明确 web-only；LAN HTTPS 为 PWA target。
- SW version 使用 build ID；更新/rollback tests。
- Clipboard fallback 失败必须可见，不能假成功。
- Safari/Chrome/Edge/Firefox support table；Firefox 若不支持 install prompt，也应普通 Web 可用。

---

## G6 — Build、Package、Install、Upgrade、Signing

### Root tooling

- 修 Windows 6 个 script test failures。
- root runner 全部 `process.execPath + npm-cli.js + shell:false`。
- package scripts 无平台 shell 依赖。
- tests 不以 missing `ps` 当“进程已死”。

### Artifact（G6 实现前必须冻结）

进入 release-verifier 实现前先作一项明确决策，并记录在 execution plan：

- 发布单元：npm package、自包含 per-target bundle，或二者；
- 哪个 manifest 是公开产品 manifest（当前 root `package.json` 为 private）；
- CLI bin、Client dist、workspace closure、native helper optional target package 的组装关系；
- OS/arch 首发矩阵、helper 缺失时的 fail-closed/capability 语义；
- dependency closure、upgrade/uninstall owner、checksum/provenance/SBOM 输出路径。

推荐目标矩阵：

- `win32-x64`（arm64 是否首发由真实依赖支持决定）；
- `darwin-arm64`, `darwin-x64`；
- `linux-x64`，arm64 后续或同批取决于 CI。

如果最终选择单一 JS 包，也必须在每个目标 OS 安装并 launch；native helper 采用显式 target package。

### release verifier

共享 orchestration + OS adapters，验证：

1. clean build；
2. package content manifest；
3. offline temp-prefix install；
4. `pix --version`；
5. sessiond RPC round-trip；
6. Host serves real Client；
7. upgrade preserves JSONL/ledger；
8. uninstall removes bins/runtime debris但保留用户 truth state；
9. no outside-sandbox writes。

### Signing

- Windows：仅当冻结 artifact 含原生 `.exe`、`.node` 或 native helper 时，对这些明确列出的二进制执行 Authenticode/Azure Trusted Signing，并用 `Get-AuthenticodeSignature` 回读；npm 自动生成的 `.cmd` shim 不被描述为已 Authenticode 签名。
- 若产品要求“签名 launcher”，artifact 决策必须选择并交付原生 executable launcher；纯 npm 发行则以 registry provenance、integrity、checksum/SBOM 为主，并只签 native helper（若有）。
- macOS：对实际交付的原生 app/binary/helper 执行 Developer ID codesign + notarization + staple + Gatekeeper verify；纯 JS/npm 内容使用 provenance/integrity gate。
- Linux：checksums + provenance/SBOM；可选签名。
- 密钥只在 environment-protected release jobs。

### 签名 gate 分层

- 普通 PR：构建 unsigned/ad-hoc artifact，验证 content manifest、helper load、install/start/upgrade/uninstall；不需要 release secrets。
- protected tag/release：Windows Authenticode、macOS Developer ID + notarization + staple + Gatekeeper。
- 签名后必须在目标 OS 重跑 install/start/RPC/Host smoke，release promotion 依赖回读结果而不是 action exit code。

### 依赖

- 升级 `mermaid` 至修复版本（调研时 fix available `11.16.1`），并回归 markdown security tests。
- native module/helper 必须 target matrix、checksum、load smoke、failure capability policy。

---

## G7 — Required CI 与实验室矩阵

### PR required jobs

| Job | Node | 必跑 |
|---|---:|---|
| `windows-node22` | 22.19 | architecture、typecheck、full test、build、startup-windows、runtime、sessions、release smoke |
| `windows-lts` | 明确 pin 的 LTS major | full test/build + focused lifecycle |
| `macos-node22` | 22.19 | full gates、startup-posix、APFS/alias/socket-byte tests、release smoke |
| `ubuntu-node22` | 22.19 | full gates、all E2E、release smoke |
| `browser-chromium` | pinned | localhost HTTP + LAN HTTP degraded + HTTPS |
| `browser-webkit` | pinned | macOS/PWA/clipboard/IME focused |

### Nightly/weekly

- Windows junction/ACL adversarial。
- macOS Intel + Apple Silicon packaged smoke。
- Linux arm64、Ubuntu/Fedora；AppArmor/SELinux diagnostics。
- long path/Unicode/space/CJK usernames。
- network filesystem marked observational，不升级支持等级，除非连续稳定并有明确 contract。
- Node 25/current smoke，发现未来 breakage。

### 禁止的 skip

Windows required job 中不得 skip：

- secure-state Windows tests；
- named pipe start/ping/shutdown；
- path drive-root/case/junction；
- process/grandchild cleanup；
- packaged install/upgrade。

平台不适用的 test 必须由对应平台等价 test 替代，而不是只删/skip。

---

## G8 — 支持等级升级与发布

### 支持等级

“连续两个 release cycle”定义为两个正式发布 tag 均完成对应平台 protected release gates，间隔至少一个正常发布周期，期间该平台没有未处置 P0/P1 回归；证据以 CI/release receipts 和 issue disposition 为准。

| 等级 | 含义 |
|---|---|
| Unsupported | 启动路径未完成或 required CI 不存在 |
| Experimental | source build + focused smoke；不承诺 release artifact |
| Preview | packaged artifact、required CI、已知限制公开 |
| Supported | full PR gates + release gates + upgrade/uninstall + security tests |

### 升级条件

- Linux/macOS：共同 G0/G1 + POSIX lane（G2A、G3-POSIX、G4-POSIX、G6-POSIX）+ 对应 G5/G7 全绿 → Supported。
- Windows：共同 G0/G1 + Windows lane（G2B、G3-Windows、G4-Windows、G6-Windows）+ 对应 G5/G7 全绿 → Preview；连续至少两个 release cycle、无 P0/P1 platform regression → Supported。
- LAN PWA：HTTPS browser matrix 绿才称 installable；HTTP LAN 永远叫 Web-only degraded。

---

## 8. 切片所有权与依赖

| Slice | 主 owner | 依赖 | 独立复核 |
|---|---|---|---|
| CP-A Contract/path identity | `local-authority`（filesystem）+ `protocol`（wire vocabulary） | 无 | 必须 |
| CP-B POSIX lock/secret hardening | `local-authority` + `sessiond` policy | A | 必须 |
| CP-C Windows native state | `local-authority` | A | 必须，Windows security |
| CP-D1 IPC/single instance POSIX | `sessiond` | B | 必须 |
| CP-D2 IPC/single instance Windows | `sessiond` | C | 必须 |
| CP-E Process tree primitives | 待架构冻结的单一共享低层 owner；`sessiond`/`host` 仅持 policy | A | 必须 |
| CP-F1 Host path/watch/Git POSIX | `host` | A/B/E | 必须 |
| CP-F2 Host path/watch/Git Windows | `host` | A/C/E | 必须 |
| CP-G Adapter ID/error | `pi-sdk-adapter` + `agent-worker`；parity 归 `cross-package-contract-tests` | A | 必须 |
| CP-H Client path/PWA | `client`，wire DTO 归 `protocol` | A/API path flavor | 多文件 runtime/UI 必须 |
| CP-I1 Tooling baseline | root `scripts/*` | G0 | 必须，且不得等待 Windows backend |
| CP-I2 Release tooling infrastructure | root `scripts/*` + `cli` | I1/E | 只建立共享 verifier/layout，不代表平台 G6 完成 |
| CP-I3 POSIX release gate | root `scripts/*` + `cli` | D1/F1/I2 | 必须 |
| CP-I4 Windows release gate | root `scripts/*` + `cli` | C/D2/F2/I2 | 必须 |
| CP-J CI/signing/docs | root workflows/docs | 各 lane | release reviewer |

同一 active worktree 同时只允许一个 writer；read-only reviewer 可并行。

---

## 9. 详细验收矩阵

## 9.1 Windows

- [ ] `pix start` 在普通用户 PowerShell/cmd 成功。
- [ ] `%USERPROFILE%` 含空格/CJK。
- [ ] private state DACL protected，错误 ACL fail-closed。
- [ ] junction/reparse 中间层和 leaf 攻击。
- [ ] named pipe 双启、wrong auth、shutdown。
- [ ] `C:\`, case variants, different drives；UNC/extended 明确拒绝。
- [ ] Worker/Git direct child + grandchild cleanup。
- [ ] Defender/locked-file fixed diagnostic。
- [ ] npm global `.cmd` install/upgrade/uninstall。
- [ ] Windows artifact integrity gate 与冻结格式一致：原生 `.exe`/helper 才要求 Authenticode 回读；纯 npm `.cmd` launcher 使用 provenance/integrity/checksum，不伪称已签名。

## 9.2 Linux

- [ ] Ubuntu required full gates。
- [ ] 107-byte Unix socket budget，Unicode bytes。
- [ ] owner/mode/hardlink/symlink/fsync/race。
- [ ] root policy。
- [ ] XDG_RUNTIME_DIR runtime endpoint policy。
- [ ] atomic-save watch。
- [ ] systemd user optional docs/smoke。
- [ ] packaged artifact install/upgrade。

## 9.3 macOS

- [ ] macOS required full gates。
- [ ] 103-byte safe path budget。
- [ ] `/var` root alias allow、generic symlink reject。
- [ ] APFS case-sensitive + default case-insensitive fixtures。
- [ ] Unicode NFC/NFD/display recovery。
- [ ] TCC denied error fixed/sanitized。
- [ ] Intel/arm64 package。
- [ ] codesign/notarize/staple/Gatekeeper verify。

## 9.4 Browser/PWA

- [ ] localhost HTTP install/update/offline。
- [ ] LAN HTTP 显示 Web-only degraded。
- [ ] LAN HTTPS SW/PWA/clipboard。
- [ ] Chrome/Edge/Safari；Firefox普通 Web。
- [ ] build N → N+1 cache upgrade。
- [ ] iOS/Android identity 正确。
- [ ] IME、AltGr、Command/Ctrl labels。

## 9.5 共同架构门

- [ ] `npm run check:architecture`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `git diff --check`
- [ ] touched package boundaries/command coverage
- [ ] Startup/Runtime/Sessions E2E relevant suites
- [ ] packaged artifact smoke
- [ ] independent non-implementer review
- [ ] no old branch merge/cherry-pick shortcut

---

## 10. 迁移与兼容策略

### 10.1 状态目录

Pi truth source 不迁移。Pix 自有 runtime/data/log 如果改位置：

1. 新版本只读 discovery 旧位置；
2. 仅在 old authority 确认停止、identity/owner 通过后迁移；
3. migration journal 有版本和 crash recovery；
4. 引入 PR 登记 shim ID、bridge path/version、首次版本、**精确删除 release/commit** 与 upgrade/downgrade/corrupt tests；
5. 旧位置 alias/shim 到期后按 migration ledger tally 删除；
6. 测 upgrade/downgrade，不能 create-on-stale。

### 10.2 Ledger schema

- v1 POSIX 文档保持可读。
- v2 加 platform/file identity。
- v1 reader 是显式 shim：引入时记录精确删除 release/commit，不能以“所有用户都迁移”为不可观测条件。
- rewrite 发生在持有 exact lifetime lock 后；corrupt evidence 不改写。
- Windows 不读取无法解释的 v1 `dev/ino` 并假装有效。

### 10.3 Endpoint

若 Linux runtime endpoint 从 `~/.pi` 改到 XDG runtime：

- CLI discovery 只探测明确版本列表；
- authenticated hello 决定复用；
- legacy location shim 在引入 PR 记录 shim ID、bridge endpoint version、精确删除 release/commit 与 tests；
- 不因“某个 path 存在”就删 socket/lock。

---

## 11. 风险登记

| 风险 | 等级 | 缓解 |
|---|---|---|
| Node builtins 不足以实现 Windows ACL/file ID/Job Object | 高 | 最小 native helper spike + 独立安全审查；不足则 Windows 保持 unsupported |
| 修 contract 触发 ledger/schema 广泛变更 | 高 | 先 type-only/discriminated contract，随后 serial migration slices |
| POSIX 共用重构造成 Linux/macOS security regression | 高 | golden/adversarial tests 先行，A/B diff，独立 reviewer |
| Windows AV/OneDrive 锁导致 flaky | 高 | private runtime 与 durable data 分离；bounded errno retry；诊断，不无限重试 |
| APFS case/Unicode 行为误归一 | 中高 | display/comparison/identity 分层；native fixtures |
| PWA LAN 被误宣传 | 中高 | secure-context support table + visible degraded UI |
| release bundle 引入错误 OS native artifact | 高 | target-native assembly、content manifest、load smoke |
| CI 仅编译不运行 | 高 | packaged install/start/RPC/Host E2E required |
| 网络文件系统 identity 不稳定 | 中 | 默认不承诺；detect/deny mutation；文档支持矩阵 |
| 旧 plan/执行计划漂移 | 中 | 本文作跨端专题；活动状态只在 execution plan；每 slice 回链 |

---

## 12. 明确禁止的修复方式

1. 不整支合并或参考 `fix/cross-platform-dev`。
2. 不用 WSL/Docker 替代 Windows 原生支持。
3. 不让 Windows 走 POSIX backend 并跳过 owner/mode 检查。
4. 不用 `chmod` 证明 Windows private state。
5. 不用 `taskkill`/PowerShell/`kill` 文本命令作为生产 authority。
6. 不把 named pipe 仅加一个 `process.platform` 分支后就宣布完成。
7. 不删除/skip POSIX tests 来刷 Windows CI。
8. 不返回 raw Git/OS path 错误。
9. 不默认接受 UNC、`\\?\`、network filesystem。
10. 不复制整个开发 `node_modules` 作为最终 release closure。
11. 不把 HTTP LAN 宣称为可安装 PWA。
12. 不加没有版本、删除条件和测试的 compatibility shim。

---

## 13. 建议的前六个实施 PR

### PR 1 — Baseline + diagnostics + CI skeleton

- README/support matrix
- 在 `docs/refactor-execution-plan.md` 建立 CP-A～CP-J/各平台 lane 的任务、依赖、owner、验收和优先级；migration ledger 建 shim tally
- sessiond startup diagnostic
- 修 Runtime Protocol/Host bootstrap/E2E version 词义与 magic number 漂移
- `windows-tooling-required` + 独立 `windows-product-known-gap`
- Node 22.19 + pin LTS；engines/Current policy 决策
- root Windows script test failures作为 required baseline

### PR 2 — Secure-state contract v2（无 Windows production enable）

- discriminated identity/principal/backend
- path flavor/schema tests
- POSIX adapter保持行为
- ledger v2 design/tests

### PR 3 — POSIX sessiond lock/secret hardening

- stale/release identity pin
- secure existing secret
- root policy
- Linux/macOS tests

### PR 4 — Windows secure-state backend spike → implementation

- SID/DACL/reparse/file ID/process identity
- helper decision
- Host private state first，不接 sessiond pipe 之前先完成 tests

### PR 5 — sessiond Windows native vertical slice

- backend selection
- named pipe
- lock/secret/single instance
- status/down/diagnostics
- Windows startup E2E

### PR 6 — Tooling/release verifier infrastructure

- root script green on Windows
- npm JS CLI shell:false
- target-aware package layout owner
- shared install/upgrade/uninstall verifier + OS adapter seams
- **本 PR 只建立 CP-I2 基础设施，不宣称 G6 完成**；POSIX/Windows release gates 分别等待 Host G4 lane（F1/F2）和 packaged product behavior 完成

随后推进 Host workspace/watch/process tree、Client/PWA；各平台 CP-I3/I4 release gate 在对应 F1/F2 后收口，最后按冻结 artifact 格式完成 signing/provenance。

---

## 14. 完成定义

跨端工作只有在以下全部成立时才算完成：

- 三端 source-tree full gates 绿。
- 三端 packaged artifact 安装、启动、RPC、Host、升级、卸载绿。
- Windows ACL/reparse/file ID/process tree tests 绿。
- Linux/macOS POSIX security 相对当前设计零退化。
- 对实际交付的原生 macOS artifact 完成签名/公证回读；对实际交付的 Windows 原生 binary/helper 完成 Authenticode 回读；纯 npm/JS artifact 完成 registry provenance、integrity、checksum/SBOM。
- PWA support table 与实际 secure-context behavior 一致。
- capability 只广告接通并验证的 seam。
- 所有 platform-specific skip 有等价 test 或明确“不适用”证明。
- 每个 PR 都执行 root DoD：architecture、typecheck、test、build、diff-check，加 touched package boundaries/commands/relevant E2E；不能只留到跨端项目末尾。
- docs/refactor-execution-plan.md 记录 slice 状态/验证；migration ledger 记录 schema/path 来源和 migration/shim tally。
- 独立 reviewer 无 blocker。
- 工作树只含预期文件，`git diff --check` 干净。

---

## 15. 当前结论

Pix 的协议中心、Host/sessiond/Worker 分层是适合跨端的；问题不在总体架构，而在**底层平台 authority 仍被 POSIX 实现占满，且发布/CI 没有形成闭环**。

正确方向不是在业务包继续堆 `process.platform`，而是：

1. 把路径、secure state、IPC、process tree、watch、release layout 收回各自 owner；
2. 先修现有 POSIX identity/secret/lock 漂移；
3. 用真实 Windows SID/DACL/file ID/named pipe/process tree 实现 native backend；
4. 用 target-native CI 和 packaged artifact smoke 决定“支持”字样；
5. 对 PWA 区分 localhost/HTTPS 与 HTTP LAN，保持产品承诺诚实。

在这些门槛完成前，最准确的对外表述曾是：

> Linux/macOS 是当前原生设计路径，但尚缺持续平台与发行验证；Windows 原生是明确目标，当前尚不可启动。Pix 不以 WSL 作为 Windows 产品方案。LAN HTTP 可作为受密码保护的普通 Web 访问，但安装式 PWA 目标需要 HTTPS 或浏览器认可的 loopback secure context。

**该表述已过时。** 当前对外矩阵与剩余缺口以 §16 为准。

---

## 16. 当前进度（相对 2026-08-17 审计）

活动任务 SSOT 仍是 `docs/refactor-execution-plan.md` §1.3。本节省略实现细节，只同步“审计时的阻塞现在怎样了”。

参考实现继续固定到已调研 commit，不另造轮子：VS Code `03459a7e73daf894cc2cdd282d41b09d1517cb68`、OpenCode `1c965451b537e1af4bff12c163200f762a6a0364`、Continue `5522c6f44ca0ac3528b37244818fbfa39b5af470`、Goose `3810898a7447ec3299be72e223d3570a7aabf0ab`、Cline `8bbdde2a5c1f972864fe1b954f639c21fac61a40`。

### 16.1 支持矩阵（诚实）

| 平台 | 等级 | 现在的事实 |
|---|---|---|
| Windows 原生 | **Supported** | 默认 `~/.pi/pix` 可原生启动：SID/DACL/file-ID backend、named pipe、AllowedRoot、required start/shutdown smoke。Worker/Git 子孙清理对齐 VS Code `taskkill /T`。不以 WSL 作为方案。仍未关门：Job Object、ledger v2、packaged install/upgrade、完整 Windows `npm test`。 |
| Linux | **Unverified-native** | PR tooling + required `npm test` 已存在。无发行 smoke / 签名。 |
| macOS | **Unverified-native** | 同上。无公证 / 发行 smoke。 |
| 浏览器 / PWA | **Partial** | localhost/HTTPS 普通 Web；HTTP LAN 明确 web-only / insecure-origin，可见降级。不承诺可安装 PWA。 |

### 16.2 Gate 进度

| Gate | 状态 | 已落地 | 仍缺 |
|---|---|---|---|
| G0 | 骨架完成 | README 矩阵、CI 三端 tooling、根脚本 Windows 绿、Protocol v2 / Host bootstrap 词义分离 | `pix doctor`、sessiond 启动诊断通道 |
| G1 | 半完成 | discriminated `posix \| windows` 合同；Client display 路径 owner | Protocol path-flavor DTO；ledger v2 |
| G2A | 基本完成 | lock/secret identity pin、禁事后 chmod、默认拒 root | macOS lock 仍无 start identity |
| G2B | 接通 | `createSecureStateBackend()` 在 walk 前选 Windows native；DACL = 当前用户+SYSTEM，宽 ACL 不自动修 | 中间目录宽 ACL 只查 reparse |
| G3 | 半完成 | pipe DACL（listen 后 protect+回读）、process-start identity、Worker/Git final-kill、共享 process-tree（Windows = VS Code taskkill /T） | Job Object；listen 前带 DACL 的 retained N-API pipe |
| G4 | 半完成 | AllowedRoot 平台身份、parent-watch + overflow rescan、Windows 路径脱敏、exact-open | hardlink 事务、worktree disk identity、junction 对抗 CI |
| G5 | 增量完成 | drive-root/case owner、iPadOS 先于 Mac、clipboard fail-closed 且可见、PWA 可见降级、打开项目/`cwd.validate`、未授权项目先确认 | Host 下发 path-flavor；mention 索引仍无条件小写；无 AllowedRoot 设置页 |
| G6–G8 | 未开始 | Windows `release-verify` 入口 fail-closed | packaged artifact、签名、G7 完整矩阵 |

执行切片 CP-00–CP-35 记为 DONE。后置：Job Object、ledger v2、Protocol path-flavor、packaged release。

### 16.3 审计条目对照

| 原条目 | 现在 |
|---|---|
| CP-001 named-pipe 不可达 | 已接通；factory 先于 walk |
| CP-002 Host POSIX backend 硬编码 | Host/sessiond 走 `createSecureStateBackend()` |
| CP-003 合同仍是 POSIX | 已分成 posix/windows identity/principal |
| CP-004/005 lock identity | 已 pin；release 三重匹配 |
| CP-006 Windows DACL | 已落地；已存在宽 ACL fail-closed |
| CP-007 secret 事后 chmod | 已改为读前校验 |
| CP-008 PID reuse | Windows creation time + Linux startticks；macOS 仍弱 |
| CP-009/010 final-kill 假成功 | 已 fail-closed；子孙进程仍杀不掉 |
| CP-012 Windows 路径脱敏 | 已覆盖 drive/UNC/extended/`file://` |
| CP-013 exact-open | 已校验 `getSessionId()` |
| CP-014/015 ledger identity | 内存用平台 identity；磁盘仍 v1，超精度 `ino` fail-closed |
| CP-016 watch | parent-watch + overflow rescan |
| CP-017 Client drive-root/case | `file-paths` owner；无 Protocol flavor |
| CP-018/019 PWA | 可见降级；SW version 用 package+commit |
| CP-020 iOS-before-Mac | 已修 |
| CP-022 根脚本 Windows 红 | 已绿 |
| CP-025 无 CI | `.github/workflows/cross-platform-baseline.yml` 存在，不是 G7 |
| CP-026 协议 magic number | E2E 正向握手用 `PROTOCOL_VERSION` |

### 16.4 当前产品缺口（不是跨端 backend 阻塞）

AllowedRoot **没有设置页**。启动根来自启动 cwd / `PIX_ALLOWED_ROOTS`。本机当前只有 `D:\src_test_env\pix`。Home 选择器、侧边栏“新会话”和点未覆盖会话都会先问是否允许，确认后再 `POST /v1/cwd/validate`。取消或失败留在当前 cwd。`~/.pi/agent` 只给 catalog 读模型/密钥，不加进 Files/Git 可浏览根。`POST /v1/trust` 是项目信任，不是 Files/Git 授权。

### 16.5 下一刀（对齐参考实现，不自造轮子）

1. Protocol path-flavor：Host bootstrap 下发，Client 不再靠路径长得像 `C:/` 猜。
2. named-pipe listen 前带 DACL（VS Code SID/ACL，而不是 `node:net` 默认 DACL 再补一层）。
3. 仍后置：Job Object（比 taskkill 更严的笼子）、ledger v2、packaged release、AllowedRoot 设置页。
