# Host 账本身份：对齐成熟软件，停造 ledger v2

> 日期：2026-08-20  
> 状态：`IMPLEMENTED — L-01..L-05 DONE，独立 reviewer/oracle 验证完成`  
> 执行 SSOT：`docs/refactor-execution-plan.md` §1.3  
> 相关：`docs/cross-platform-hardening-plan.md` §10.2 / §16.5  
> 原则：非必要不自研。能复用 Git porcelain、Node `realpath`/`lstat`、以及已有 `FileIdentity` 运行时针，就不新造 schema、不搬 VS Code/OpenCode 内部模块。

## 0. 决策

**ledger v2（把 Windows file ID / POSIX `{dev,ino}` 写成跨重启权威）won't do。**

成熟开源（VS Code、Git worktree、OpenCode、Codex）的分层是：

| 层 | 权威 | 成熟产品 | Pix 应对齐 |
|---|---|---|---|
| **持久身份** | canonical 路径 + git 拓扑 | VS Code workspace = URI；Git = `gitdir`/`worktree list`；OpenCode = canonical path + git root | 账本只把 path/repoRoot/base/worktreeId + `git worktree list` 当恢复权威 |
| **运行时防伪** | 打开后再核 identity | VS Code/Codex：realpath + 再 open；inode/file ID **不落盘当 workspace id** | `authorizeExisting` / commit 前继续用 `local-authority` `FileIdentity` |
| **损坏证据** | 不改写 | Pix 已 fail-closed | 保持 |

没有可复制粘贴的 “ledger v2” 实现：VS Code `IStat` 不暴露 ino/fileId；没有 npm 包做 NTFS file-ID JSON 账本；`simple-git` 也不存 file ID。Git porcelain 和 realpath **已经在本仓库里**。

## 1. 当前缺陷（必须改契约，不是加 schema）

磁盘 v1 仍写 POSIX `{dev,ino}`（trusted-roots 与 managed-worktrees 多组 path/repo/common/admin/base）。

重启恢复却用这些数字去对 **平台** `FileIdentity`：

- `allowed-roots.ts`：`posixLedgerIdentity(record.dev, record.ino)` → `identityStillMatches`
- `managed-worktrees.ts`：`isRealDirWithIdentity(path, dev, ino)` 比较 `lstat().dev/.ino`

在 Windows 上这等于把 v1 `dev/ino` 假装成 volume serial/file ID——正是 CP-14/§10.2 禁止的。POSIX 上 inode pin 比 VS Code/Git **更严**，也不是它们的持久合同。

运行时授权（内存 `FileIdentity`）已经正确，不要动。

## 2. 目标合同（对齐后）

### 2.1 落盘（v1 文件继续可读）

权威字段：

- trusted-roots：`claimId`, `path`, `repoRoot`, `base`, `createdAt`, `source`, 可选 `branch`
- managed-worktrees：`worktreeId`, `path`, `repoRoot`, `commonDir`, `adminDir`, `base`, `createdAt`, `source`, 分支审计字段

`dev`/`ino`（及 managed 的 `repoDev`/`commonDev`/…）**降为可选审计**：

- 新写入：可省略，或仍写但不作为恢复条件
- 读取：缺字段不失败；Windows **读了也不当权威**
- **不** bump schema version，**不**做 v1→v2 rewrite（避免自研迁移机）

损坏/未知 version/错 kind：继续 fail-closed，不改写。

### 2.2 重启恢复（rehydrate）

#### trusted / workspace access

一条记录恢复 **workspace access** 当且仅当：

1. `path` / `repoRoot` / `base` 仍是绝对 canonical 真实目录（非 symlink）
2. containment 仍成立（path 严格在 `${repoRoot}-worktrees` 内等，现有规则）
3. `git worktree list --porcelain -z`（已有 `listNonMainWorktreePaths`）包含该 path
4. `repoRoot` 仍被本次 Host 的 durable AllowedRoot 覆盖（trusted-roots）；managed 侧 `isRepoManaged` 仍真
5. 外机/外仓记录仍只保存在磁盘、不授权

**不再要求** 磁盘 `dev/ino` 与当前 `FileIdentity` 一致。

路径没了、git 不认、根不在 AllowedRoot → drop exact record（现有行为）。目录还在但 inode 因 copy/restore 变了、git 仍列出 → **恢复 workspace access**（对齐 Git/VS Code）。

#### managed destructive ownership

`managed-worktrees.json` 也是 DELETE authority 的历史证据，因此不能把成熟工具的 workspace reopen 语义直接扩大成删除权：

- canonical path + 非 prunable Git topology + checkout-side common/admin 精确核验，只能恢复 workspace access；
- `managedByPix` / DELETE authority 只来自**本次 Host 进程**成功 `recordCreated()` 后捕获的 runtime `FileIdentity` token；
- Host restart、remove/re-add 同路径、或其他 actor 重建 checkout，都**不**恢复 destructive ownership；
- Git / filesystem / repo-managed probe unavailable：不授权、不 drop、不改写证据；只有权威检查明确 negative 才 drop exact record；
- 若以后需要重启后删除，必须另行批准显式 reclaim / provenance 设计；本切片不新增 marker/schema。

### 2.3 运行时（保持，不自研第二套）

- `authorizeExisting`：realpath → canonical containment → **内存** root `FileIdentity`
- mutation/commit：AllowedRoot + `O_NOFOLLOW` / parent identity
- 私有状态（sessiond secret/lock、Host dir lock）：仍用 `local-authority` 的 POSIX mode / Windows DACL+file ID——那是机密文件，不是工作区账本

### 2.4 明确不做

- ledger schema v2 / discriminant JSON / Windows file ID 落盘
- 从 VS Code 复制 workspace hash 或 `UriIdentityService`
- 从 OpenCode 复制 SQLite project id
- 新 npm 依赖专门做 file-id ledger
- 把用户 Settings 扩根写成 `trusted-roots.json`（那是「持久 AllowedRoot」，另一后置切片）

## 3. 实施切片（已登记到执行 SSOT）

| ID | 工作 | Owner | 状态 | 不自研 |
|---|---|---|---|---|
| L-01 | 文档：§16.5 / N-014 旁路把 ledger v2 标为 **won't do**；本文件为合同 | docs | ✅ 完成 | — |
| L-02 | trusted-roots **rehydrate `gate()`**：路径+containment+git list+durable root；去掉 `posixLedgerIdentity` 作为恢复条件；恢复身份改从**实时文件系统**捕获 | `packages/host` `allowed-roots.ts` | ✅ 完成 | 复用已有 `listWorktrees` / `realpath` |
| L-03 | managed-worktrees **`corroborateRecord`**：真实目录 + 非 prunable repo list + checkout-side common/admin + pre/post runtime identity；path+Git 只恢复 access，delete token 不跨 restart/re-add | `packages/host` `managed-worktrees.ts` | ✅ 完成 | 复用 Git porcelain / `local-authority` |
| L-04 | 写入：新 record 可不写 / 宽松写 `dev`/`ino`；解析时字段成对可选。**不**改 `kind`/`version` | 两个 ledger parse/serialize | ✅ 完成 | 保持 v1 可读 |
| L-05 | 测试：ino 变化但 git 列出 → trusted/access 恢复；managed restart/re-add → 不恢复 delete；Git 不列 → drop；unavailable → preserve/no auth；路径逃出 base → drop | host tests | ✅ 完成 | 不引入新 identity 夹具格式 |

## 4. 已落地实现摘要

- **trusted-roots `gate()`**：删掉 `posixLedgerIdentity(dev,ino)` 匹配；改用 `isRealDirectory(path/repoRoot/base)` + containment + `durableAuthorizes(repoRoot)` + `git worktree list`。恢复的 claim 身份从 `captureDirectoryIdentity(live)` 取，供运行时 `ROOT_IDENTITY_CHANGED`。
- **managed `corroborateRecord`**：落盘 inode 退出恢复权威；使用真实目录、non-prunable repo list、checkout-side common/admin、前后 runtime `FileIdentity`。确认成功只恢复 workspace access；当前进程 `recordCreated()` 的 identity token 才是 destructive ownership。
- **unavailable honesty**：Git/list/rev-parse 或 policy probe 暂不可用时不授权、不 drop、不改写账本；明确 negative 才删 exact record。
- **ledger schema**：trusted 的 `dev/ino/repoDev/repoIno` 与 managed 的全部 `*Dev/*Ino` 改为**成对可选审计字段**；Windows writer 省略 pseudo-POSIX identity；parse 对整对缺失宽容、半对/非法数值 fail-closed，serialize 缺失时省略、半对拒写；`kind/version` 保持 v1。
- **测试**：trusted inode 变化 + Git 仍列出恢复 access；managed restart/re-add 保留 access/history 但 `live=false`，不继承删除权；escape/symlink/bad-base 仍 drop；unavailable 保留 bytes 且不授权；新增 L-04 无 identity / orphan-pair round-trip。
- 验证：`check:architecture`、root `typecheck`、root `build`、Host boundaries、`git diff --check` PASS；Host 全量相对 Windows 基线无新增失败，本轮安全定向用例全部 PASS。独立 reviewer 两轮 + oracle 裁决后完成 prunable/malformed/unavailable、delete-token、publication/DELETE recheck 修复。
- 原生证据（`baf35e2`）：WSL2/ext4/Node 22.19 Host `512/508/0/4`、macOS arm64/Node 24.19 Host `512/509/0/3`；两端 ledger/worktree 安全集合均 `82/82`。根全量仍有本切片外的 CLI/Client/local-authority/adapter 与 E2E 期望漂移，未伪报三端根全绿。

> ⛳ 安全敏感（AllowedRoot + managed/trusted rehydrate），按 §16 需独立（非实现者）审查后再合。

## 5. 验收

- Windows 重启 Host：trusted / managed 历史记录在 canonical path + Git topology 仍成立时恢复 workspace access（即使 Node `stat().ino` 变化）；managed destructive ownership 不跨 restart 恢复。
- POSIX/Windows：same-path re-add 不继承旧 `worktreeId` 的删除 authority；`managedByPix=false` / DELETE 拒绝。
- Git 不认、prunable 或明确 topology mismatch → drop；Git/filesystem unavailable → preserve evidence、no auth、no rewrite。
- 运行时换根仍由 runtime `FileIdentity` 拒绝；磁盘 inode 不参与 delete authority。
- 磁盘仍是 `version: 1`；无 migration rewrite；无新依赖。
- 不宣称：跨卷 file ID、UNC、持久用户 AllowedRoot 账本。

## 6. 与现有后置项的关系

| 项 | 关系 |
|---|---|
| Job Object | 已 won't do（`taskkill /T /F`） |
| **ledger v2** | **本文件起 won't do** |
| 持久 AllowedRoot | 仍后置（用户选的项目根写入账本）——不要和本重构绑在一起 |
| POSIX IPC dir 分离 CP-52-B | 无关 |
| packaged release | 无关 |
