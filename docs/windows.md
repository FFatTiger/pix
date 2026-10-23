# Pix Windows 适配（feat/windows）

Pix 目前只在 macOS / Linux 上运行。本文是 Windows (win32) 适配的**审计清单与实施记录**：每项给出现状、win32 上的问题、改法、测试方式与当前状态。

验证策略（无真实 Windows 机器的开发环境）：

1. **macOS 单元测试**：所有跨平台逻辑通过可注入的 platform / fs 依赖测试（`path.win32` 模拟 win32 路径语义），不依赖 `process.platform` 真值。
2. **Wine 冒烟**：在 Linux 上用 Wine 跑 Windows 版 node.exe，验证 `process.platform === "win32"` 下的真实语义（命名管道、rename、kill(pid,0)、目录句柄 fsync 等）。见文末「Wine 冒烟指南」。
3. **GitHub Actions**：`.github/workflows/windows.yml` 在 windows-latest 上 npm ci → build → typecheck → 各包单测 → 启动冒烟。

状态标记：✅ 已改+单测覆盖 · 🔶 已改，需 Wine/真实 Windows 验证 · 📝 仅文档化（设计上不改）· ⬜ 未处理。

---

## 1. sessiond 端点（Unix socket → 命名管道）

| 项 | 现状 / 问题 | 改法 | 状态 |
|---|---|---|---|
| 公共端点 | `local.ts sessiondPaths()` win32 分支：`\\.\pipe\pix-sessiond-<sha256(规范化目录 + "\0" + 用户名)前 32 hex>`（`windowsSessiondPipeName`，win32.resolve 规范化，`os.userInfo().username` 兜底 env）；Unix 为 `<dir>/sessiond.sock` | 管道名对 (目录, 用户) 确定性稳定（128 bit hash）。两个本地账号即使派生出同一运行目录也各自命名空间；同名管道若被他人创建，listen 报 EADDRINUSE、connect 报 EACCES，可在 net 层检测。注意：目录字符串大小写不同仍会产生不同管道名——CLI/daemon 都经 `resolveRuntimeDir()`（`join(homedir(),…)`）派生，同一机器上拼写一致；从旧管道名升级需先停旧 daemon（实例锁会如实报 conflict） | ✅ |
| 管道与 `net.connect`/`server.listen` | `rpc.ts` 把 endpoint 直接传 `createConnection` / `server.listen`；Node 对 `\\.\pipe\` 前缀自动走命名管道 | 无需改 | ✅（已有）|
| 私有别名 socket / 硬链接发布 | Unix 用 `pixsd-<token>.sock` + `link()` 原子发布；win32 分支已全部 no-op（`needsUnixSocketPublication()` 等） | 保留。Windows 直接绑公共管道名；实例唯一性由实例锁保证 | ✅（已有）|
| `sun_path` 长度 / 残留 socket 清理 | 仅在 `needsUnixSocketPublication()` 时检查/清理，win32 跳过 | 无需改；管道随进程消失，无残留文件 | ✅（已有）|
| 管道 EADDRINUSE | 另一 daemon 持锁且活着时，`acquireInstanceLock` 先 fail-closed，不会走到 listen；锁已释放但旧进程仍监听的窗口由 `inspectSessiond` 的 live-probe 兜底 | 维持现状（fail-closed） | 📝 |
| 管道安全 | Unix socket 靠 0700 目录保护；命名管道默认 ACL 仅创建用户与管理员可连接（libuv 默认安全描述符），远程不可连 | 无代码改动；文档化 | 📝 |
| `existsSync(endpoint)` 当文件用 | `cli/supervise.ts shutdownSessiond()` 用 `!existsSync(paths.endpoint)` 判停机——管道名不是文件路径，且对管道做 stat 可能阻塞/报错 | win32 下改用 `probeSocket(endpoint) !== "live"`（主动连接探测） | ✅ |

## 2. local-authority / secure-state（最硬的阻塞点）

`packages/local-authority/src/state/posix.ts` 是 Host 目录、信任根账本、settings 文档与 sessiond 私有目录的安全基座，当前**整体假设 POSIX**：

| 项 | 现状 / 问题 | 改法 | 状态 |
|---|---|---|---|
| `canonicalizeAbsolutePath` | 显式拒绝 `C:\`（WINDOWS_PATH）与 UNC（NETWORK_PATH）；从 `/` 开始按 `/` 切段重走 | 增加 win32 平台模式（可注入）：接受盘符/UNC 绝对路径，用 `path.win32` 切段与重走；realpath 结果去 `\\?\` / `\\?\UNC\` 前缀再比较，比较用小写（NTFS 大小写不敏感）。POSIX 行为原样冻结 | ✅ |
| `ensurePrivateDirectoryWithFs` 安全目录走查 | `slice(1).split("/")`、从 `/` 拼接、`0o700` 精确校验、uid 归属校验 | 平台参数化根/分段（`C:\`、`\\srv\share`）；win32 下跳过 mode 精确校验与 uid 校验（NTFS 无 POSIX mode；隐私由用户 profile 默认 ACL 承担——文档化残留），保留 symlink/junction（lstat `isSymbolicLink()`）与 dev/ino 身份钉扎 | ✅ |
| 文档权限 `mode & 0o077` | `readStateDocument` / trust-store / builtins store 拒绝 group/other 可读写——win32 文件恒为 0o666，全部误拒 | win32 下跳过该位校验；保留 nlink>1 硬链接拒绝（NTFS 有效） | ✅ |
| `writeStateDocument` rename | POSIX `rename()` 覆盖既有文件；win32 libuv `MoveFileExW(REPLACE_EXISTING)` 通常可覆盖，但目标只读属性/被占用/AV 锁时 EPERM | win32 下 rename 遇 EPERM/EEXIST/EACCES/EBUSY 时：`rm(target,{force})` 后重试一次（有界、在持锁下；微小非原子窗口已文档化） | ✅ |
| 目录 fsync | 只容忍 EINVAL/ENOTSUP/EISDIR；win32 打开目录句柄/FlushFileBuffers 常见 EPERM/EACCES | win32 平台模式下把 EPERM/EACCES/EBUSY 一并视为「平台不支持」（NTFS 自身有元数据日志；文档化） | ✅ |
| `isPidAlive` | `kill(pid,0)` 只把 EPERM 当活着；win32 的 access-denied 是 **EACCES** | EPERM 与 EACCES 都按「存在但不可Signal」处理（两平台一致正确）。win32 下 signal 0 经 libuv OpenProcess 存在性检查，进程不存在抛 ESRCH——语义可用；「已退出但句柄未释放的僵尸 pid 短暂判活」是已知残留，方向 fail-closed | 🔶（Wine 验证 kill(pid,0) 行为） |
| chmod/O_NOFOLLOW/0600 | `O_NOFOLLOW` win32 下 undefined（`?? 0` 已兜）；chmod 只影响只读位，0600=可写→no-op 不报错 | 无需改 | 📝 |
| `isAbsoluteCanonicalShape` | 只认 `/` 开头形状——账本里的根路径在 win32 全部非法 | 增加 win32 形状：盘符 `X:\…` 与 UNC `\\srv\share\…`（无 `.`/`..`/尾斜杠/双斜杠段） | ✅ |

**Windows 下的安全语义等价说明**（文档化，不新造机制）：隐私 = 目录位于用户 profile 下继承 per-user ACL；symlink/junction 防护 = lstat 拒绝；硬链接防护 = nlink 检查；身份钉扎 = dev/ino（NTFS file index）；篡改窗口 = 与 POSIX 相同的 no-openat 残留 + win32 rename 回退的微小非原子窗口。

## 3. sessiond 私有目录（local-posix.ts，冻结的 sessiond 策略走查）

同 local-authority 的走查问题：`slice(1).split("/")` 从 `/` 拼接、`0o700` 精确校验、realpath 全等比较（win32 大小写/`\\?\` 会误拒）。→ 与 2 相同的平台参数化；`reverifySessiondPrivateDirectory` 的 dev/ino 钉扎在 NTFS 有效，保留。✅

其余 secret 发布（`link()` 原子发布在 NTFS 文件硬链接有效）、stale temp 清扫（pidAlive 修复后可用）、锁文件 O_EXCL/O_NOFOLLOW(`??0`) 均可在 win32 原样工作。✅

## 4. 进程与信号

| 项 | 现状 / 问题 | 改法 | 状态 |
|---|---|---|---|
| worker spawn | `worker-process.ts`：`spawn(process.execPath,[workerMain])`、`detached:false`、`windowsHide:true` | 无需改（Node→Node，无 shebang/shell 依赖） | ✅（已有）|
| worker 停止升级 | `stdin.end()` → `SIGTERM` → `SIGKILL`。win32 下 `child.kill("SIGTERM"/"SIGKILL")` 经 libuv 句柄映射 TerminateProcess，可用；优雅路径本就是 stdin EOF | 无需改（SIGTERM 在 win32=强制终止，升级语义不变） | 📝 |
| `isSameProcess` 的 `kill(pid,0)` 探针 | 见 2 的 isPidAlive；仅在第 3 方 kill 前做 pid 复用防护 | 保持（探针与实际 kill 用同一 libuv 语义，一致） | 📝 |
| daemon 信号处理 | `runDaemon(signals=["SIGINT","SIGTERM"])`；win32 下 Ctrl+Break=SIGBREAK、控制台关闭=SIGHUP 未接 → 默认处置直接退出，遗留锁 | win32 信号集扩为 `["SIGINT","SIGTERM","SIGBREAK","SIGHUP"]`（SIGHUP 在 win32 由 Node 于控制台关闭时合成） | ✅ |
| Host 信号处理 | `host-runner.ts` 同样只接 SIGINT/SIGTERM | 同上扩展 | ✅ |
| worker-main 信号 | 只接 SIGINT/SIGTERM；win32 下父进程不会送达 SIGTERM，靠 stdin EOF | 扩展信号集（保持行为不变：触发优雅退出） | ✅ |
| `pix start` 派生 daemon | `supervise.ts spawnSessiond`：`process.execPath` + bin 路径、`detached:true`、`stdio:"ignore"`、`windowsHide`、`unref()` | win32 可用（无控制台附着→关终端不杀进程）。限制：不 breakaway 父 Job（CI job 结束会带走它）——文档化 | ✅（已有）|
| pid 存活三处拷贝 | `sessiond/local.ts`、`cli/supervise.ts`、`local-authority` | 统一语义（EPERM+EACCES=alive），sessiond/CLI 复用 local-authority 的导出 | ✅ |
| `pix down` 停机等待 | 见 1 的 existsSync(endpoint)；pidAlive 修复后 `instanceAlive` 可正确回收崩溃锁 | ✅ | |
| nice/setsid/nohup/taskkill | 运行时代码无使用；shebang bin 均经 `process.execPath` 启动，npm 会生成 `.cmd` shim | 无需改 | 📝 |
| worker env 白名单 | 已转发 PATH/HOME/USERPROFILE/TEMP/TMP，但缺 `SystemRoot` 等 win32 Node/子进程（git、DNS、DLL 加载）所需变量 | 白名单追加 SystemRoot/SystemDrive/WINDIR/ComSpec/PATHEXT/APPDATA/LOCALAPPDATA | ✅ |
| worker 父进程死亡看门狗 | `agent-worker safe-stdio.ts` 轮询 `process.ppid` 变化——win32 无 reparent-to-1 语义，ppid 不变，看门狗失效 | win32 下改为对记录的父 pid 做真实存活探测（kill(pid,0)，ESRCH/退出即死）；stdin EOF 仍为主路径 | ✅ |

## 5. 路径

| 项 | 现状 / 问题 | 改法 | 状态 |
|---|---|---|---|
| `PIX_ALLOWED_ROOTS` 分隔符 | 已用 `path.delimiter`（win32=`;`）切分，`path.isAbsolute` 校验 | 无需改；文档写明 win32 用 `;` | ✅（已有）|
| AllowedRoots 包含判断 | 基于 `path.relative` 的 `isWithin`——win32 下 separator/盘符正确，且 `path.win32.relative` 自身大小写不敏感 | 无需改（两输入都先过规范化） | 📝 |
| realpath `\\?\` 前缀 | win32 下 realpath 可能返回 `\\?\C:\…`（native 变体），与 `path.resolve` 产出的根字符串永不相等 → 鉴权 403/根身份误判 | 新增 host 内 `canonicalPathKey()`：去 `\\?\`/`\\?\UNC\` 前缀 → 平台 normalize → win32 小写；所有根 Map 键、身份复查、等值比较走 key | ✅ |
| `production-resources isAllowedPath` | `path === root \|\| path.startsWith(root+"/")` 硬编码 `/` | 改用同一包含判断（isWithin 语义） | ✅ |
| workspace-flags 项目键 | `startsWith("/")` 拒绝 `C:\…`/UNC | 改 `path.isAbsolute`（平台正确）+ NUL 拒绝 | ✅ |
| `isAbsoluteCanonicalShape`（账本形状） | 见 2 | win32 形状支持 | ✅ |
| Host 目录中间 symlink 拒绝走查 | `host-state-directory assertNoUnsafeIntermediateSymlink` 从 `/` 切段拼接 | 平台参数化（复用 local-authority 导出的分解助手） | ✅ |
| 大小写不敏感 | `C:\Repo` vs `c:\repo` 在 Map 键/等值比较中不等 | `canonicalPathKey()` win32 小写 | ✅ |
| Pi 会话目录编码 | Pi SDK：`--${cwd.replace(/[/\\:]/g,"-")}--`，`C:\foo` → `--C--foo--`，合法 Windows 目录名 | 沿用 Pi 自己的规则（与 pi CLI 同机一致；与 POSIX 路径理论撞名是理论边缘） | 📝 |
| `sessionPathKey`（adapter） | 已有 win32 normalize+小写分支 | 无需改 | ✅（已有）|
| adapter 写入文件路径规范化 | `normalizeWrittenPath` 只认 `/` 开头绝对路径、输出 `/a/b`——win32 盘符路径被破坏 | 用运行平台的 `isAbsolute/resolve/normalize`，保留平台原生形状 | ✅ |
| subagent-projection 逃逸检查 | `rel.startsWith("..")` 未拒绝绝对 relative 结果 | 补 `!isAbsolute(rel)` | ✅ |
| homedir/tmpdir | 全部经 `os.homedir()`/`os.tmpdir()`，无硬编码 `/tmp`/`/Users` | 无需改 | ✅（已有）|
| 混合分隔符（assistant workspace 等） | `resolveAssistantWorkspaceDir` 产出 `C:\Users\x/.pi/...`，比较前都过 `normalizeAssistantWorkspacePath`（`\`→`/`+小写）；Windows API 接受混合分隔符 | 无需改（保持 runtime-core 零依赖） | 📝 |

## 6. 原子写（temp + rename）

POSIX `rename` 覆盖目标；win32 libuv 用 `MoveFileExW(REPLACE_EXISTING)` 多数情况可覆盖，但只读属性/句柄占用会 EPERM。统一处理：

| 项 | 改法 | 状态 |
|---|---|---|
| `local-authority writeStateDocument` | win32 rename 失败码回退 rm+rename 一次 | ✅ |
| `adapter trust-store`（trust.json） | 同回退；`(mode&0o077)` 校验 win32 跳过；自建 fsyncDir 容忍码补 win32 | ✅ |
| `sessiond workspace-state.ts persist` | 固定 `.tmp` 名 + `openSync("w")`；补 win32 回退（维持单写者假设，不引入随机名——锁内单写者） | ✅ |
| `sessiond service.ts persistIdleTimeoutMs` | 同回退 | ✅ |
| `host gate/config.ts publishPixDocument` | 同回退 | ✅ |
| `host routes/files.ts` 上传覆盖 | `link(target,backup)` + `rename(staged,target)`；NTFS 文件硬链接可用、rename 可替换；create 路径 `link()` EEXIST 防覆盖语义保留 | 无代码改动；上传覆盖大小写冲突（`Foo` vs `foo`）在 NTFS 上由后写者替换，接受 | 📝 |
| `~/.lore/config.json` 写入 | 无独立 rename 模式（见 lore-config-store：直接 writeFile 经用户目录） | 无需改 | 📝 |

## 7. Shell / 外部命令 / 监听 / 杂项

| 项 | 现状 | 状态 |
|---|---|---|
| git 调用 | argv 直传 `git -C <cwd>`，`shell:false`（win32 CreateFile/PATHEXT 自动解析 `git.exe`），pathspec 已转 `/` | ✅（已有）· `LC_ALL=C` 无害 |
| 运行时无 bash/sh/ps/lsof/which/rg/uname 依赖 | 用户会话 shell 选择由 Pi SDK 决定（win32 用 PowerShell），Pix 不包装 | 📝 |
| `openBrowser` | 已有 `cmd /c start` win32 分支 | ✅（已有） |
| file-watch（SSE） | 忽略事件类型、重 stat 比对 mtime/size；win32 rename 事件兼容 | ✅（已有） |
| session-store 目录监听 | `recursive` 在 win32 原生支持；filename 反斜杠已归一 | ✅（已有） |
| subagent-observer filename | win32 可能给全路径/null → `basename()` 归一后再查表 | ✅ |
| git diff/status 行切分 | `\n` 切分；win32 autocrlf 下 diff 可能带 `\r` → 改 `\r?\n` | ✅ |
| NDJSON/JSONL | 已容忍 CR（crlfDelay、去尾 CR） | ✅（已有） |
| 换行写入 | 全部 LF 写入（Node 不做文本翻译，Pi JSONL 读取端 crlf 容忍） | ✅（已有） |
| 临时目录 | 全走 `os.tmpdir()`/`mkdtemp` | ✅（已有） |
| 大小写重名（上传冲突预检） | NTFS 不会共存两个仅大小写不同的名字；冲突预检大小写敏感的差异只在 POSIX 卷有意义 | 📝 |

## 8. 客户端显示路径（浏览器端）

| 项 | 改法 | 状态 |
|---|---|---|
| `features/workspace/paths.ts` | `X:/` 视作根（保尾斜杠语义）、盘符/UNC 路径大小写折叠比较 | ✅ |
| `lib/workspace-paths.ts` 临时目录分类 | 增加 Windows 临时路径特征（`appdata/local/temp` 等，规范化后前缀匹配） | ✅ |
| `ChatInput` 路径切分仅 `/` | 盘符路径用既有 basename 助手 | ✅ |
| `file-mentions` UNC 大小写 | 折叠 | ✅ |

## 9. 安装与启动

| 项 | 现状 | 状态 |
|---|---|---|
| `npm install -g` + `pix start` | bin 均为 `.mjs`+shebang；npm 生成 `.cmd`/ps1 shim；进程内全部经 `process.execPath` 启动 | ✅（已有）· README 增加 Windows 说明 |
| release 打包脚本 | `scripts/release-package.mjs` 全部 Node API（无 POSIX 工具依赖） | ✅（已有） |
| CI | 新增 `.github/workflows/windows.yml`（不 push，由用户决定） | ✅ |

---

## Wine 冒烟指南（大哥操作）

在 Linux 机器上（安装 wine，例如 `wine-9.x`），下载 Windows 版 node（`node-v22.x-win-x64.zip` 解压出 `node.exe`）：

```bash
# 假设：
#   /opt/node-win/ 里有 node.exe + node_modules（npm 相关）
#   pix 仓库在 /srv/pix（npm ci && npm run build 已完成，或解包 release tarball）
export WINEDEBUG=-all
wine /opt/node-win/node.exe /srv/pix/packages/cli/bin/pix-sessiond.mjs &   # 直接起 daemon（前台）
# 另一终端：
wine /opt/node-win/node.exe /srv/pix/packages/cli/bin/pix.mjs status
wine /opt/node-win/node.exe /srv/pix/packages/cli/bin/pix.mjs start --no-open   # ensure+host
wine /opt/node-win/node.exe /srv/pix/packages/cli/bin/pix.mjs down --all
```

环境变量：`PIX_SESSIOND_DIR` 建议显式指向 wine 用户目录下的路径（默认走 `os.homedir()` = `C:\users\<user>`，Wine 下映射 `~/.wine/drive_c/users/<user>`）；`PIX_ALLOWED_ROOTS` 用 `;` 分隔的 wine 内路径（如 `Z:\srv\pix;Z:\tmp\demo`）。

**重点观察项**（按风险排序）：

1. `kill(pid,0)` 语义：daemon 正常退出后 `pix start` 能否立即重启（锁回收）；杀掉 daemon 进程后锁是否被判 stale。
2. `rename` 覆盖：设置页保存（settings.json / pix.json 密码）第二次写入是否成功。
3. 目录句柄 fsync：若报 DIR_FSYNC_FAILED 是否被容忍（EPERM/EACCES 分支）。
4. 命名管道：`pix status` 的 ping、`down --all` 的停机等待是否正常结束（不挂起）。
5. worker spawn：创建会话后任务管理器里有无 `node.exe` 子进程、会话停止后是否退出。
6. 崩溃恢复：`wine taskkill /f /pid <daemon>` 后 `pix start` 是否恢复。
7. 路径：`PIX_ALLOWED_ROOTS` 大小写变体、`\\?\` 前缀（realpath 返回值）下 files/git 路由是否 403。

**Windows CI 工作流**：`.github/workflows/windows.yml`。`build` job 做一次 npm ci、build、typecheck，把工作区打成 7z（保留 npm 的 junction）上传；每个 workspace 一个并行 `test` job，脚本测试和启动冒烟各自一个 job。任一失败则整体失败（`needs: build`）。每个 job 有 `timeout-minutes`；`scripts/run-node-test.mjs` 默认给 `node --test` 加 `--test-timeout=120000`，一个挂住的用例只失败自己的进程。冒烟脚本 `tests/windows-smoke.mjs`：起 sessiond、RPC ping、创建+停止一个会话（真实 worker spawn）、`pix down --all`、Host health 探测。

**8.3 短路径**：GitHub 的 `os.tmpdir()` 是 `C:\Users\RUNNER~1\…`，而 `fs.realpath` 展开成长名 `C:\Users\runneradmin\…`。local-authority 的最终比较和 canonical 前缀都先走 `realpath.native` 展开成长名再比较（大小写仍由 compare key 折叠）。Host 的 `canonicalizeRealpath` 只去 `\\?\` 前缀并 resolve，不再把存储路径转成小写；大小写折叠只发生在 `pathKey`。

**换行**：`.gitattributes` 固定 `* text=auto eol=lf`。客户端样式测试用 `cssRule()` 查找规则，选择器和 `{` 之间的 CRLF 不影响匹配。

## 已知残留（文档化，不改）

- **同用户攻击面**：win32 无 POSIX mode/O_NOFOLLOW；与 POSIX 相同的 no-openat 竞态残留 + chmod 不可用 → 隐私依赖用户 profile ACL（跨用户边界仍由 NTFS 保证）。
- **pid 复用/僵尸句柄**：win32 pid 复用快；已退出但句柄未释放的 pid 会被 `kill(pid,0)` 短暂判活（fail-closed 方向）。
- **detached daemon 与 Job**：`pix start` 的 daemon 不 breakaway 父 Job；在 CI/被托管进程树下可能随父进程树终止（正常终端使用无影响）。
- **后台 Host 的停止**：`pix start --detach` 把 Host 作为 detached 子进程放到后台（日志写到 `~/.pi/pix/cli/host.log`）。`pix stop` 先核对 Host-dir 锁里记录的 pid 再发信号；win32 上 `SIGTERM` 等同 TerminateProcess，Host 来不及释放锁，下次启动会按"持有者 pid 已退出"回收这把锁。服务托管或 CI 直接用前台的 `pix start`。
- **rename 回退的非原子窗口**（win32 仅在 EPERM 类失败时触发）：目标短暂不存在；发生在持锁单写者路径。
- **管道名大小写**：目录拼写大小写不同 → 不同管道名（默认派生路径稳定，理论边缘）。
