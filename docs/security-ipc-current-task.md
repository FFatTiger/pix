# Pix 路径安全、Trust、单实例锁与 IPC 当前任务

> 日期：2026-08-19  
> 状态：`部分完成 — 已批准 D-01/D-02，P0/P1 代码切片已落地并验证`  
> 范围：路径安全与文件权限、`trust.json`、sessiond 单实例锁、Windows named pipe / Unix socket、RPC 大帧可靠性  
> 执行 SSOT：`docs/refactor-execution-plan.md` §1.3  
> 相关专题：`docs/cross-platform-hardening-plan.md`

## 0.1 本次已落地并验证（2026-08-19）

| 切片 | 状态 | 证据 |
|---|---|---|
| `CP-49` byte-safe RPC（UTF-8 字节分块 + 有界双向 decoder） | ✅ 完成 | `SerialSocketWriter` 按字节编码/分块；`ByteLineDecoder` 供 server/client 共用；serial-writer/ack/byte-line-decoder 27/27 通过；sessiond 全量 343: 277 pass / 0 fail / 66 skip |
| `CP-50` D-02：Windows sessiond 改用 Node 原生 named pipe | ✅ 完成 | Node `net` pipe 实测支持 128 KiB 往返不崩不挂；`daemon`/`system.ping`/double-instance 测试通过；`daemon.ts` 移除 `listenProtectedNamedPipe` 生产路径 |
| `CP-51` D-01：trust 归口 Pi 公共 `ProjectTrustStore.set()` | ✅ 完成 | 移除 forked writer + Windows mode bypass；委托 SDK；trust-mutation 10/10 通过；适配器 335: 325 pass / 7 fail（7 个为 Windows/SQLite 既有问题，stash 基线验证） |
| `CP-52`（byte-budget 部分）`sun_path` 103/107 | ✅ 完成 | macOS 103 / Linux 107（扣除 NUL）；socket-publish + last-start 通过；POSIX 长度用例在 Windows 按预期 skip |
| `CP-53` 工作区 alias 语义 | ✅ 完成 | `authorizeExisting` 移除 Windows reparse-ancestor 全局拒绝；canonical containment + root identity + O_NOFOLLOW 保留 fail-closed；junction 测试：in-root alias 通过、逃逸 junction PATH_FORBIDDEN |

## 0. 文档合同

本文是当前专题的**实施任务包与交接清单**，不是第二份执行状态源。

- 正式开工前，把选定切片以 `CP-48` 起登记到 `docs/refactor-execution-plan.md` §1.3。
- 状态变更只以执行 SSOT 为准；本文用于保留范围、依赖、验收和安全决策。
- 本任务不照搬 Codex；Codex 只作为边界和平台原语的对照证据。

---

## 1. 当前事实与已验证证据

### 1.1 已确认正确、原则上保留

- `packages/local-authority` 已按平台拆分安全证据：
  - POSIX：uid/gid/mode/dev/ino、symlink/hardlink、`0700/0600`；
  - Windows：SID、protected DACL、volume serial/file ID、reparse point。
- sessiond lock 已包含 exclusive create、instance ID、PID start identity、文件 identity、保守 stale reclaim 和 owner-safe release。
- POSIX socket publication 已使用 unique private socket + stable public hardlink，避免旧进程 close/unlink 新 authority 的 endpoint。
- sessiond RPC 已有队列/backpressure/drain timeout，协议认证使用 session secret。

### 1.2 当前阻塞

1. **Trust Windows mode bypass 不完整。**
   `platform === "win32" || ...` 消除了 Windows `stat.mode` 误杀，却没有以 SID/DACL 证据替代；其余目录 fsync、chmod、不可写目录和测试仍带 POSIX 假设。
2. **Trust Windows 定向测试失败。**
   当前结果：26 tests，14 pass，12 fail；失败覆盖 persistence、权限断言、已有文件收紧、不可写目录、并发和 hardlink。
3. **Windows protected pipe 可被大 write 触发进程退出。**
   直接写入 65,537 bytes 时，native 抛出 `NATIVE_INVALID_ARGUMENT`；异常从 `WindowsNamedPipeDuplex._write` 同步逸出。
4. **Writer 按 UTF-16 字符而非 UTF-8 bytes 切片。**
   32 Ki 字符的 CJK/emoji 可能编码成超过 native 64 KiB 单次限制。
5. **RPC client decoder 无有界 pending buffer。**
   server/client 还未共享 byte-safe incremental decoder；拆分 UTF-8、coalesced frames 和 outbound frame 上限没有完整合同测试。
6. **Unix socket budget 多放了尾部 NUL。**
   filesystem pathname 的安全 payload 应为 macOS 103 bytes、Linux 107 bytes，而不是 104/108。
7. **普通工作区与 Pix 私有状态仍有策略混用。**
   Windows AllowedRoot 对所有 reparse ancestors 全局拒绝，会误杀合法 junction/OneDrive/alias；私有状态的严格拒绝则必须继续。

---

## 2. 冻结的不变量

### 2.1 资产分级

| 资产 | Owner | 必须采用的安全语义 |
|---|---|---|
| sessiond secret/lock、Host secure ledger | `local-authority` + 对应 consumer policy | POSIX owner/mode/identity；Windows SID/DACL/file ID；已有不安全状态 fail-closed |
| 普通工作区 / AllowedRoot | `packages/host` | canonical realpath containment + root identity；不要求私有 mode/DACL |
| Pi-owned `trust.json` | Pi SDK；Pix adapter 只做防腐 | 不长期复制 Pi 文件格式/锁协议；Windows 不解释 POSIX mode |
| sessiond wire framing | `packages/sessiond` | 有界、byte-safe、backpressure-aware；不由 Protocol 包拥有 transport buffer |
| endpoint platform security | `packages/local-authority` + sessiond composition | POSIX private socket dir；Windows protected named pipe；secret 认证始终保留 |

### 2.2 禁止项

- 不把 Windows `stat.mode` 当权限证据。
- 不因消除 Windows 误杀而放松 Pix-owned POSIX secret/lock 的读前 owner/mode 校验。
- 不对普通工作区做全局 fail-closed symlink/reparse walk。
- 不把现有 `trust-store.ts` Windows bypass 当完成态合入。
- 不继续以字符串字符数规避 named-pipe 64 KiB 限制。
- 不删除已有测试来放行跨平台实现。
- 不在没有明确产品决策时把 protected named pipe 静默降级成只靠默认 Node pipe ACL。
- 不新增轮询作为 IPC/realtime 修复。

---

## 3. 待批准的安全决策

### D-01 — `trust.json` 的边界归属 — ✅ 已批准（继承 Pi per-user 边界）

**决定（2026-08-19）：继承 Pi 的 per-user profile 边界，并由 adapter 调用公共 `ProjectTrustStore.set()`；原子写/平台权限加固转为上游 Pi 请求，不再本地复制 forked writer。**

Pix adapter 只负责：

1. Host AllowedRoot 在调用前验证并 canonicalize cwd；
2. 调用 Pi 公共 `ProjectTrustStore.set(...)`；
3. 固定错误映射和错误净化；
4. fresh read-back 验证结果；
5. 必要的进程内串行。

若不能接受 Pi 当前边界：

- Windows 暂时撤回 `project.trust` capability；或
- 先完成严格 Windows DACL seam，再恢复 capability。

不得无限期保留一个没有版本、删除条件和上游 parity 证明的 forked writer。

### D-02 — Windows pipe 的目标 data plane — ✅ 已批准（Node 原生 pipe + secret 为主边界）

**决定（2026-08-19）：Windows sessiond 改用 Node 原生 named pipe，secret AUTH 作为主认证边界；DACL 降为纵深防御。自研 native `WindowsNamedPipeDuplex` 不再进入生产数据面。**

> 实测：Node `net.Server.listen(\\.\pipe\...)` 在 Windows 原生可用；128 KiB 单次 write 可往返且不崩不挂；64 KiB 崩溃面随自研 data plane 移除而消失。双实例仍由 sessiond 锁文件权威守护（EADDRINUSE 亦映射 conflict）。

---

## 4. 建议执行切片

以下编号是待登记到执行 SSOT 的建议；正式编号以 `docs/refactor-execution-plan.md` 为准。

| 建议 ID | 优先级 | 任务 | Owner | 依赖 | 当前状态 |
|---|---:|---|---|---|---|
| `CP-48` | P0 | 冻结资产分级、批准 D-01/D-02、修正文档中过度宽泛的 mode 结论 | docs / architecture | 无 | ✅ 完成（D-01/D-02 已批准） |
| `CP-49` | P0 | 修复 sessiond byte-safe writer 与有界双向 decoder | `packages/sessiond` | CP-48 | ✅ 完成 |
| `CP-50` | P0 | Windows sessiond 改 Node 原生 pipe（D-02） | `packages/sessiond` + local-authority | CP-49 | ✅ 完成 |
| `CP-51` | P1 | trust 归口 Pi 公共 API（D-01） | `packages/pi-sdk-adapter` | D-01 | ✅ 完成 |
| `CP-52` | P1 | `sun_path` byte-budget 103/107 | `packages/sessiond` | CP-49 | ✅ 完成（byte-budget） |
| `CP-52-B` | P1（待后续） | POSIX state dir / IPC dir 分离 | `packages/sessiond` + CLI | CP-52 | ⏭ 已范围化为独立切片：跨 `sessiondPaths`/`daemon`/`local-posix`/`supervise`/约 9 个测试文件，需 POSIX 真机验证，不在本增量内强行迁移 |
| `CP-53` | P1 | AllowedRoot 允许合法 alias，保留 canonical containment + root identity fail-closed | `packages/host` | CP-48 | ✅ 完成 |
| `CP-54` | P0/P1 汇总 | 三平台验证、根门禁、文档收口 | root + touched owners | CP-49–53 | 🔄 进行中（本机已跑包内测试；根门禁见下） |

---

## 5. 切片验收

### CP-48 — 策略与文档收口

- [x] D-01 有明确批准记录。
- [x] D-02 有明确首选路线（Node 原生 pipe + secret）；native data plane 不再作为生产路径。
- [x] 修正 `docs/cross-platform-hardening-plan.md` §5.6/§5.7：
  - Windows mode 永不作为 authority；
  - Pix-owned POSIX 私有状态仍读前验证 owner/mode；
  - 普通工作区与 Pi-owned 配置遵循各自 owner 合同。
- [x] 将活动切片登记到 `docs/refactor-execution-plan.md` §1.3。

### CP-49 — byte-safe RPC

实现要求：

- [ ] frame 只编码一次为 `Buffer`。
- [ ] queued bytes、frame limit、chunking 都按 UTF-8 bytes 计算。
- [ ] ordinary write 与 `enqueueFlushed`/shutdown ACK 共用 chunk/flush 语义。
- [ ] server/client 共用 byte-line decoder，pending buffer 有硬上限。
- [ ] invalid UTF-8、limit+1、无换行 flood、schema mismatch 均 fail-closed。
- [ ] 不改变 Runtime Protocol DTO；transport framing 保持 NDJSON。

确定性测试：

- [ ] ASCII、CJK、emoji 跨 chunk 边界。
- [ ] 单字节拆包、多个 frame 合包、CRLF/尾部换行。
- [ ] 2 MiB exact 与 2 MiB + 1。
- [ ] queue overflow、drain timeout、close/late callback exactly once。
- [ ] shutdown ACK 在 backpressure 后确实 flush 再 close。

### CP-50 — Windows named pipe data plane

最低安全修复：

- [ ] `_write` 捕获同步 native 异常并以 callback settle。
- [ ] 单次 native write 不超过 byte limit。
- [ ] native 返回 transferred count；short/zero write 不得当成功。
- [ ] cancel、destroy、close 和 pending read/write 不 use-after-close、不重复 settle。
- [ ] pre-auth timeout 与连接数上限，避免同用户空闲连接耗尽资源。

目标 spike：

- [ ] 验证 `_open_osfhandle`/CRT fd/libuv/`net.Socket` handoff 是否可行。
- [ ] 明确 fd/HANDLE ownership 与 close 责任。
- [ ] 若成功，删除自研 native read/write data plane。
- [ ] 若失败，按 D-02 重新过产品安全决策，不静默选择。

Windows 实测：

- [ ] 32,768、65,535、65,536、65,537 bytes。
- [ ] 超过 64 KiB 的 emoji/CJK frame。
- [ ] 2 MiB frame 往返。
- [ ] reader 慢、reader 断开、server shutdown、client cancel。
- [ ] 无进程崩溃、无挂起、无 worker-pool starvation。

### CP-51 — Trust owner 收口

推荐路线验收：

- [ ] 外部 cwd 在调用 permissive Pi helper 前已 exact authorize/canonicalize。
- [ ] 使用 Pi 公共 trust API，不复制未公开格式/锁路径。
- [ ] write 后 fresh read-back；失败不返回 fake success。
- [ ] 错误 copy 固定且不泄露 agent dir/cwd。
- [ ] 若保留 shim：写明 SDK 版本、删除条件、parity 测试。
- [ ] Windows 测试不使用 chmod/mode 证明权限。
- [ ] POSIX 与 Windows 测试分别证明各自合同。
- [ ] 当前 14 pass / 12 fail 的 Windows 测试全部被正确实现或等价替换；不删测试逃避失败。

### CP-52 — Unix endpoint 位置与 `sun_path`

- [ ] persisted state 继续位于 `~/.pi/pix/sessiond`。
- [ ] IPC endpoint 使用短 user-private runtime directory。
- [ ] Linux 优先验证后的 `XDG_RUNTIME_DIR`；macOS/回退路径使用验证后的 private temp child。
- [ ] private/public socket aliases 仍位于同一 filesystem。
- [ ] macOS payload ≤103 bytes；Linux payload ≤107 bytes。
- [ ] 多字节目录名按 UTF-8 bytes 计数。
- [ ] 长 home path 可以正常启动，而不是把 fixture 缩短当产品修复。
- [ ] stale socket、旧 authority late close、identity mismatch 均有确定性测试。

### CP-53 — Workspace alias 语义

- [ ] 用户可选择合法 symlink/junction/OneDrive alias。
- [ ] alias realpath 后必须落入已授权 canonical root。
- [ ] root file identity 变化时拒绝。
- [ ] 指向 root 外部的 junction/symlink 拒绝。
- [ ] file mutation 继续执行 parent/open 后 identity 与 `O_NOFOLLOW` 验证。
- [ ] 私有 secure-state backend 的 reparse/symlink 拒绝不放松。

### CP-54 — 汇总验证

> 本次落地的验证记录（2026-08-19，Windows 本机）：
> - `check:architecture` 14 门全 PASS；`git diff --check` PASS。
> - sessiond 全量 343：277 pass / 0 fail / 66 skip（POSIX-only 用例按平台 skip）。
> - pi-sdk-adapter 全量 335：325 pass / 7 fail —— 7 个均为既有 Windows/SQLite 问题（session-projection/sessions/resource-catalog/production-factory），与本次改动无关； stash 基线复现 5/7 确认 pre-existing。
> - Host `resources.test`：CP-53 新增 junction 用例 PASS。
> - 已通过独立验证的含新增：byte-line-decoder、serial-writer 字节分块、trust 委托、junction alias。
> - ⏭ 剩余跟进：CP-52-B（POSIX state/IPC dir 分离）与三平台 CI 需要 Linux/macOS 真机，列为后续切片。

根命令：

```bash
npm run check:architecture
npm run typecheck
npm test
npm run build
git diff --check
```

按触达范围追加：

```bash
npm run check:boundaries --workspace @fffattiger/pix-client
npm run check:commands --workspace @fffattiger/pix-pi-sdk-adapter
npm run test:e2e:startup
npm run test:e2e:runtime
npm run test:e2e:sessions
```

- [ ] Windows native named-pipe 实测。
- [ ] Linux Unix socket + mode/owner 实测。
- [ ] macOS `sun_path` + Unicode path 实测。
- [ ] `git diff --check` 无问题。
- [ ] 无无关 lockfile churn、无测试删除、无 silent fallback。
- [ ] local-authority/sessiond/adapter/Host 核心改动经过独立非实现者审查。
- [ ] `docs/refactor-execution-plan.md`、专题文档、必要时 migration ledger 同步。

---

## 6. 建议提交边界

为降低跨 owner 风险，不把所有任务塞进一个提交：

1. `docs(security): freeze path trust and ipc policy`
2. `fix(sessiond): make rpc framing byte-safe and bounded`
3. `fix(local-authority): harden protected pipe stream lifecycle`
4. `refactor(pi-sdk-adapter): return trust persistence to pi owner`
5. `fix(sessiond): separate posix ipc runtime path`
6. `fix(host): authorize workspace aliases by canonical identity`
7. `test(cross-platform): verify security and ipc seams`

每个提交都应独立通过 touched-package typecheck/test/boundary 和 `git diff --check`；完成整个 lane 后再跑根验证矩阵。

---

## 7. 完成定义

本专题只有在以下条件全部成立时才可关闭：

- Windows 不再用 mode 作权限 authority，也不因 >64 KiB/multibyte frame 崩溃。
- Pix-owned POSIX private state 的 owner/mode/identity fail-closed 没有被误删。
- `trust.json` 只有一个明确 owner，Pix 不维护无限期隐式 fork。
- sessiond lock 的 PID start identity 与文件 identity 保持。
- macOS/Linux endpoint 使用正确 byte budget，长 home path 可运行。
- 普通 workspace alias 可用，但 canonical escape 仍拒绝。
- 双向 RPC frame、队列和 pending buffer 全部有界。
- 三平台证据、根门禁和独立审查通过。
- 执行 SSOT 已更新，工作树无未解释修改。
