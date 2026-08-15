# pi-web-desktop → pix UI/UX 功能差异与范围对齐

> 状态：`DECISIONS_FROZEN`  
> 最后更新：2026-08-13  
> 决策：只迁移 pix 当前已有的用户功能；不补参考项目独有功能；其余技术选择采用推荐方案  
> 验证约束：实施阶段不新增 UI 单测或视觉验证，由用户在完整实现后手工验收  
> 参考项目：`/tmp/pi-web-desktop`（Next.js + Electron，只读）  
> 目标项目：`packages/client`（Vite + React + PWA）及 pix Host/Protocol/sessiond/Worker 架构

---

## 1. 范围修正

目标不是只迁移视觉，而是：

1. 迁移参考项目的 **UI 设计系统**；
2. 迁移参考项目有价值的 **UX 与用户功能**；
3. 保留 pix 已验证的运行时、安全、能力门控、PWA 和长列表能力；
4. Electron/Next.js 专用实现不得直接进入 pix；
5. 数据源、生命周期和命令执行必须重新接到 pix 的 Host、RuntimeStore、WebSocket Protocol 和 capability；
6. 现已冻结：迁移范围仅覆盖 pix 当前已经存在的功能与流程；参考项目独有功能留在差异台账，不进入本轮实现。
7. 旧样式不构成兼容约束，现有 CSS 可以整体废弃；进入迁移范围的界面必须优先对齐参考项目。

---

## 2. 分类图例

| 标记 | 含义 |
|---|---|
| `C` | 纯 Client，可按 pix 技术栈重写，无后端新增能力 |
| `E` | pix 后端/Runtime 能力已存在，主要缺 Client UI/UX |
| `H` | 需要新增或扩展 Host/Protocol/Adapter capability |
| `S` | 涉及凭据、执行外部代码、文件写入等安全边界，必须独立设计和验证 |
| `X` | Electron/Next.js 专用或不适合 pix，不迁移实现 |
| `KEEP` | pix 已有且优于参考项目，迁移时必须保留 |

---

## 3. 总体结论

### 3.1 参考项目明显更完整的领域

- 多主题、壁纸、材质、字体、语言和设置；
- Draft Session、工作区/会话恢复、未读状态；
- ChatInput：附件、`@file`、Slash、历史、模型/Thinking/Tools、队列；
- Rich Markdown、ProcessGroup、工具 diff、Minimap、Branch Navigator；
- 文件树、多文件 Tab、多媒体/文档预览、文件 watch/live diff；
- 模型配置和认证；
- Skills/Plugins 搜索、安装、更新、启停；
- 全局快捷键、右键菜单、声音和完成通知。

### 3.2 pix 已有但 UI 尚未暴露的能力

- Bash / Abort Bash；
- Compact / Abort Compaction；
- Tools read/write 与 Reload；
- Fork；
- Navigate Tree 命令；
- Auto Name；
- Auto Compaction / Auto Retry 命令；
- 文件事务上传；
- Files Watch；
- 文件 raw/download；
- Gate logout；
- Runtime 快照中的 context usage、written files、system prompt、compaction 等状态。

### 3.3 pix 必须保留的优势

- 独立 sessiond 与 Worker，不把 Agent 生命周期放回 Web 进程；
- WebSocket snapshot/resume、epoch 和 event cursor；
- capability fail-closed；
- Runtime command lane、interrupt lane 和身份操作串行化；
- 事务性多文件上传与 AllowedRoot 安全边界；
- managed worktree 权威与 dirty-force 契约；
- 1000+ Session/Transcript 虚拟化；
- PWA、LAN Gate、后台恢复；
- Extension UI 五类交互、焦点恢复和 stale-result 防护；
- 固定错误文案和 raw error 消毒；
- session rename/delete 的并发与 late-settle 保护。

---

## 4. 功能差异矩阵

## 4.1 应用壳、工作区与会话

| 功能 | 参考项目 | pix 当前 | 分类 | 建议 |
|---|---|---|---|---|
| 启动 Splash | Electron splash + Web CSS splash，内容就绪后淡出 | 无同级产品 Splash | `C` | 迁 Web splash；不迁 Electron 轮询 splash |
| 三栏可调整布局 | 左右 splitter、键盘调宽、宽度持久化 | 固定 275/360px | `C` | 迁移 |
| 移动侧栏/Dock | 侧栏抽屉、右面板全屏 | 已有 overlay 基础 | `C` | 合并两者优点，强化互斥与焦点 |
| Draft Session | 点击 New 先建本地 draft，首次发送才建立真实会话 | New session 直接走现有流程，无 Sidebar draft | `C/E` | 需产品确认，见 D1 |
| 按会话草稿恢复 | 文本+图片，按 session/draft/cwd 隔离 | 无持久草稿 | `C` | 建议迁移 |
| 上次工作区/会话恢复 | localStorage 恢复 workspace、session、draft | URL cwd/session 为主，无完整 last-open | `C` | 建议迁移，但 URL 显式选择优先 |
| 未读会话 | 后台完成后 unread 标记 | 无 | `C` | 建议迁移 |
| 时间分组/标记过滤 | 会话时间组、折叠、mark filter | 简单列表 | `C/H` | 时间组可直接做；mark 需确认数据来源 |
| Session 右键菜单 | rename、auto-name、history、marks、delete | 行内 rename/delete | `C/E` | 保留行内可达性，同时增加右键菜单 |
| Session 统计面板 | 消息、token、cost、context、文件/id | SessionActions 以文本输出部分统计 | `E` | 迁成结构化面板 |
| System Prompt 面板 | 顶栏查看完整 system prompt | 快照有 systemPrompt，无 UI | `E` | 建议迁移 |
| 项目信任确认 | 可查看并写入 trust，成功后 reload | 只读 TrustBadge/Catalog | `H/S` | 需独立 capability，见 D8 |

## 4.2 ChatInput / Composer

| 功能 | 参考项目 | pix 当前 | 分类 | 建议 |
|---|---|---|---|---|
| 自动增高+手动缩放 | 自动 200px、拖拽、最大化、高度记忆 | 固定 2 行基础 composer | `C` | 迁移 |
| 完整 IME 保护 | composition + 100ms Enter grace + keyCode 229 | 有基础 IME guard | `C/KEEP` | 合并，不能回退 |
| Enter/Ctrl+Enter 模式 | 设置可切换 | 固定 Enter/Shift+Enter | `C` | 建议迁移 |
| Markdown 列表续行 | 支持 checklist/ordered/list | 无 | `C` | 建议迁移 |
| 图片附件 | 选择、粘贴、拖放、预览、删除、模型能力门控 | Protocol 支持 images，但无附件 UI | `C/E` | 建议迁移 |
| 非图片拖放 | 浏览器上传项目后插入 `@file` | 无 | `E` | 使用 pix 事务上传，不复制 Electron path bridge |
| `@file` 补全 | 文件/目录模糊搜索、目录下钻、键盘补全 | Files 搜索存在，Composer 无 `@` | `C/E` | 建议迁移，复用 `/v1/file-index` |
| Slash 菜单 | builtin/extension/prompt/skill 分组、搜索、Dormant | Runtime `get_commands` 已有，Composer 无菜单 | `E/H` | 先接真实 command；Skill 元数据按 capability |
| 输入历史 | 空输入按 ↑ 召回最近消息 | 无 | `C` | 建议迁移 |
| 模型选择器 | 搜索、收藏、Provider 分组、图标 | SessionActions 简单 select | `C/E` | 建议迁入 Composer |
| Thinking 选择器 | 模型支持档位、记忆、next turn 提示 | SessionActions 简单 select | `E/H` | 先迁真实 runtime 档位；持久记忆需确认 |
| Tools 预设 | off/default/full，next turn 提示 | Runtime helper 已有，无 UI | `E` | 建议迁移 |
| Steer / Follow-up | 两个明确动作，队列展示和 Recall | pix 已有 Steer/Follow-up/Clear queue | `KEEP/C` | 保留 pix 显式动作；不照抄运行中 Enter 默认 steer |
| Bash 输入模式 | `!`/`!!` 提示及命令 | helper 已有，无 UI | `E` | 建议迁移，但明确输出是否进入模型 |
| Compact / Stop | 状态、按钮、结果 token 横幅 | helper 已有，无 UI | `E` | 建议迁移 |
| Auto retry/compaction | 事件和状态反馈 | 命令开放，无 UI | `E/H` | 建议迁移控制，但先冻结持久化语义 |

## 4.3 消息与运行过程

| 功能 | 参考项目 | pix 当前 | 分类 | 建议 |
|---|---|---|---|---|
| Rich Markdown | GFM、frontmatter、raw sanitize、表格 | 纯文本/简单卡片 | `C` | 迁移 |
| 数学 | KaTeX | 无 | `C` | lazy/按需，见 D5 |
| Mermaid | 用户点击 Preview 后动态加载 | 无 | `C` | lazy/按需，见 D5 |
| 代码高亮 | Prism；流式尾部不高亮；完成后高亮 | 无 | `C` | 迁移 light build，按语言注册 |
| 超长消息保护 | >100k 字符切纯文本 | 无同级保护 | `C` | 必须迁移 |
| 流式合帧 | rAF + 30 updates/s | RuntimeStore 投影，无同级 UI scheduler | `C` | 在渲染层增加，不能改 WS 语义 |
| User/Assistant metadata | copy、时间、model、TPS、usage、cost | 基础 role card | `C/E` | 迁移真实有数据的字段 |
| ProcessGroup | Timeline/Tabs、步骤分类、自动跟随 | tool/bash 分卡 | `C` | 建议迁移，见 D4 |
| 工具分类与摘要 | Edit/Search/Run 等人类可读 label | JSON/文本卡 | `C` | 建议迁移，保留 raw 数据消毒 |
| 工具 diff | patch 解析、split result、截断 | Git diff 独立面板，tool result 无 rich diff | `C/E` | 有 patch 时迁移，无数据时降级文本 |
| Thinking | 时长、折叠、deferred load | 已有折叠，无 deferred API | `C/H` | 先做时长/样式；deferred 后置 |
| Bash full output | 截断、查看/下载全部 | 显示投影；Host 无同路由 | `H/S` | 需要安全引用式 API，不能信任任意 path |
| Turn Written Files | 回合末文件 chips + +/- | 快照有 writtenFiles，未显示 | `E` | 建议迁移 |
| Compaction Summary | 折叠 summary + 读/改文件上下文 | 状态存在，无展示 | `E/H` | 先显示 Runtime 数据，缺字段再扩 Protocol |
| Chat Minimap | marker、拖动、预览、viewport | 无 | `C` | 桌面建议迁移，移动隐藏 |
| Branch Navigator | 树、压缩线性链、navigate | 命令已开放，但缺完整树数据/UI | `H/E` | 需要树 DTO，见 D7 |
| Fork from message | 用户消息操作 | runtime fork 已开放，无 helper/UI | `E/H` | 需冻结 entry/fork-point DTO |
| 编辑并从这里重来 | navigate + 回填 composer | 无 | `E/H` | 建议随 Branch Navigator 一起做 |
| 消息复制 | 有 | 无统一入口 | `C` | 建议迁移 |
| 手动 Retry/Delete message | 参考项目也没有 | 无 | — | 不纳入 parity |

## 4.4 Files / Git / Worktree

| 功能 | 参考项目 | pix 当前 | 分类 | 建议 |
|---|---|---|---|---|
| 文件树 | 懒加载、Catppuccin icons、Git 状态继承 | 目录列表+搜索 | `C/E` | 建议迁移树形体验 |
| 文件树操作 | mention、download、上传；无新建/rename/delete | 浏览/搜索/preview；上传后端无 UI | `E` | 补上传、mention、download；不伪造编辑 |
| 上传冲突 UX | Replace/Skip/Cancel + progress | Host 已有事务上传，Client 无 UI | `E/KEEP` | 用 pix 原子事务语义重写 |
| 多文件 Tab | 多开、切换、关闭、viewer state；不跨刷新 | 无 | `C` | 建议迁移，是否持久见 D3 |
| 代码预览 | 行号、wrap、language、size | text `<pre>` | `C/E` | 建议迁移 |
| 图片/音频/PDF | 支持 | 无完整 Viewer | `C/E` | 图片/音频/PDF 可做；PDF 注意 CSP |
| DOCX | Host mammoth 转 HTML | 无 | `H` | 默认后置，见 D6 |
| Markdown/HTML Preview | Markdown rich preview；HTML sandbox iframe | 无 | `C/E/S` | Markdown 建议；HTML 默认关闭或严格 sandbox |
| Files Watch | SSE 变化刷新/live diff | Host 能力已存在，Client 无代码 | `E` | 建议迁移 |
| Quick Changes | M/A/D、+/-、点击开 diff | GitPanel 有状态和 diff | `C/E` | 合并到 Sidebar 或 Dock |
| Diff | unified/live diff，无 copy/apply patch | GitPanel patch preview | `C/E` | 先视觉与 navigation；不新增 apply patch |
| Worktree | create/switch/delete/force | pix 已有更安全完整 UI | `KEEP` | 只重设计外观，不替换语义 |
| 本地文件链接 | Markdown link 打开 Viewer tab | 无统一 link→viewer flow | `C/E` | 建议迁移；行定位后置 |

## 4.5 设置、主题与本地偏好

| 功能 | 参考项目 | pix 当前 | 分类 | 建议 |
|---|---|---|---|---|
| Settings Modal | Display/Chat/Models/Skills/Plugins | 无设置页 | `C/H/S` | 先建壳，只展示真实可用项 |
| 10 套主题 | 5 base × dark/light | light/dark 两套 | `C` | 迁移 |
| system/light/dark | 默认 dark，可选 system | prepaint 支持系统但无 UI | `C` | 迁移 |
| 边框深度 | 25/50/75/100 | 无 | `C` | 迁移 |
| 壁纸 | Monet、自定义图片、scrim、三区材质 | 无 | `C` | 需确认默认，见 D2 |
| 字体 | IA Writer Quattro + Lilex | 系统字体 | `C` | 建议迁移 |
| UI 缩放 | 0.8–1.5 CSS zoom | 无 | `C` | 建议迁移，但必须验证虚拟列表测量 |
| i18n | en/zh-CN，610 keys | 仅英文 UI | `C` | 建议迁移，见 D9 |
| 输入设置 | Enter 模式、列表续行 | 无 | `C` | 建议迁移 |
| 标题自动生成 | 开关+标题模型 | auto_name 后端已开放，无 UI | `E/H` | 迁移开关；标题模型语义需设计 |
| 音效 | WebAudio，任务完成 | 无 | `C` | 建议迁移 |
| 完成通知 | Electron-only | PWA 已有 SW，无 Web Notification UI | `C/H` | 以 Web Notification/SW 重写 |

## 4.6 Models / Auth / Skills / Plugins

| 功能 | 参考项目 | pix 当前 | 分类 | 建议 |
|---|---|---|---|---|
| Models Catalog | 可读 | 已有只读 Catalog | `KEEP` | 重设计外观 |
| Models Config | provider/model 全量编辑、导入、测试、成本、headers | 无写 API/UI | `H/S` | 独立安全项目，见 D10 |
| 默认模型 | 参考项目也无 UI，读 settings.json | 无全局设置 UI | — | 不误抄不存在的功能 |
| OAuth | SSE 登录、device code、callback | 仅 provider status 只读 | `H/S` | 独立 capability 与 secret boundary |
| API Key | 写入/删除 auth.json；参考 UI 可读明文 models.json key | 只读 status | `H/S` | 禁止向浏览器回传完整 key |
| Skills 列表 | 已有 | pix 已有只读 Catalog | `KEEP` | 重设计外观 |
| Skills search/install/update | skills.sh、npx、git/GitHub | 无 | `H/S` | 需用户确认，见 D11 |
| Skills disable | 修改 SKILL.md frontmatter，仍可手动调用 | 无 | `H/S` | 需精确 capability 和 trust |
| Plugins 列表 | 已有 | pix 已有只读 Catalog | `KEEP` | 重设计外观 |
| Plugins install/remove/update | npm/git/path，写 settings | 无 | `H/S` | 需用户确认，见 D11 |
| Plugins enable/disable/reload | 写资源过滤+reload session | runtime reload 已开放，但无 package mutation | `E/H/S` | reload UI 可先做；mutation 后置 |

## 4.7 快捷键、右键菜单、通知和移动端

| 功能 | 参考项目 | pix 当前 | 分类 | 建议 |
|---|---|---|---|---|
| 全局快捷键 | Esc abort、Ctrl+Alt+N | 仅局部快捷键 | `C` | 迁移并提供帮助页 |
| Context Menu | 键盘可达、submenu、feedback | 无全局系统 | `C` | 建议迁移，不能成为唯一入口 |
| Web Notification | 参考浏览器模式 no-op | pix 可用 PWA/SW | `C/H/KEEP` | 实现得比参考更完整 |
| Mobile | 640px 抽屉/全屏面板 | 768px overlay 基础 | `C/KEEP` | 统一断点和 44px 触控目标 |
| Electron 标题栏 | 有 | 无 | `X` | 不迁 |
| 原生窗口控制 | 有 | 无 | `X` | 不迁 |
| Reveal in Finder | Electron bridge | Web 无权限 | `X` | 不迁；可选 File System Access API 后置 |
| 拖放绝对路径 | Electron `getPathForFile` | Web 无权限 | `X` | 浏览器统一上传后 mention |

---

## 5. 双方都有但不应照抄的差异

### 5.1 Runtime transport

参考项目：Next route + SSE + Web 进程内 AgentSession。  
pix：Host + sessiond + Worker + WS snapshot/resume。

结论：只复制状态和交互，不复制 `useAgentSession`、`rpc-manager`、SSE route 或 `/api/agent/*`。

### 5.2 运行中 Enter

参考项目在运行中 Enter 默认发送 Steer，可能立即打断当前运行。pix 当前提供明确的 Steer 和 Follow-up 操作，风险更低。

建议：保留 pix 的显式模式；允许用户通过设置选择 Enter 的行为，但默认 Follow-up，不默认 Steer。

### 5.3 项目信任

参考项目 trust 成功后销毁该 cwd 的 Web 进程内会话。pix 有独立 sessiond/Worker，不能照抄“销毁会话重建”。应设计成：

- Host 写 trust ledger；
- capability 更新；
- 对指定 live session 发受控 reload；
- busy 时明确拒绝或排队；
- 不破坏 sessiond 生命周期权威。

### 5.4 模型凭据

参考项目的部分模型配置会把完整 `apiKey` 返回浏览器。pix 支持 LAN/PWA，这不可接受。

pix 必须采用：

- secret status/read-metadata；
- set/replace/clear；
- 永不返回完整 secret；
- 独立 capability；
- Gate、LAN auth、CSRF/mutation guard；
- 审计固定错误和零日志泄漏。

### 5.5 文件上传

参考项目逐文件覆盖。pix 已有请求级事务上传、rollback 和 managed root 权威。

结论：迁参考上传 UI，但底层必须继续使用 pix 的事务 API，不降级。

### 5.6 长列表

参考项目聊天按 50 条向上加载；pix 已有 Session/Transcript 动态虚拟化。

结论：迁参考视觉和加载提示，但不得撤销 pix 虚拟化。

---

## 6. 需要产品确认的决策

用户可以直接回复“按推荐方案”，或逐项修改。

### D1 — Draft Session

- `A`：完全复制参考行为：New 先生成 Sidebar draft，首次发送才创建真实 session；空 draft 自动清理。
- `B`：只保存当前真实 session 的未发送草稿，不在 Sidebar 生成 draft。
- **推荐：A**，但真实 session 创建仍使用 pix Runtime create/activate 流程。

### D2 — 默认主题与壁纸

- `A`：默认 dark + wallpaper on（接近参考项目）。
- `B`：默认 system + wallpaper off，用户在设置中开启。
- `C`：默认 system + 内置轻量 wallpaper on。
- **推荐：B**，降低首次加载、GPU 和可读性风险；保留完整设置。

### D3 — 文件 Tab 是否跨刷新持久化

- `A`：严格复制参考项目，只在当前页面内存中存在。
- `B`：改进为按 workspace 持久化，并在刷新后恢复。
- **推荐：B**，恢复时必须重新做 AllowedRoot/capability 校验。

### D4 — ProcessGroup 默认模式

- `A`：Tabs（参考默认）。
- `B`：Timeline。
- `C`：自动：窄屏 Tabs，宽屏 Timeline。
- **推荐：A**，并允许用户切换和持久化。

### D5 — Rich Markdown 首批范围

- `A`：GFM + syntax + KaTeX + Mermaid 全部首批。
- `B`：首批 GFM + syntax；KaTeX/Mermaid 作为 lazy 第二批。
- **推荐：B**，控制 bundle 和离线缓存复杂度。

### D6 — 文档预览

- `A`：首批图片、音频、PDF、DOCX、HTML、Markdown 全部。
- `B`：首批代码/文本、图片、Markdown、PDF；音频/DOCX/HTML 后置。
- **推荐：B**。HTML preview 默认禁用任意脚本；DOCX 需 Host 转换。

### D7 — Branch/Fork UX

- `A`：完整复制 Branch Navigator、Fork from here、编辑并从这里重来。
- `B`：先做当前 leaf 的 Fork/Navigate 基础按钮，树后置。
- **推荐：A**，但需先新增规范 branch-tree DTO；不读取 Pi SDK 原始树对象。

### D8 — Trust 写入

- `A`：加入项目 Trust/Untrust UI、Host mutation capability 和受控 reload。
- `B`：继续只读展示。
- **推荐：A**，独立高风险切片和 verifier。

### D9 — i18n

- `A`：首批完整 en/zh-CN。
- `B`：先英文，结构预留，中文后补。
- **推荐：A**，因为参考文案资产已完整，用户主要使用中文。

### D10 — Models/Auth 写配置

- `A`：完整加入 provider/model 编辑、API key/OAuth、import/test。
- `B`：只做安全的 API key/OAuth；复杂 models.json 编辑后置。
- `C`：保持只读。
- **推荐：B**。任何 secret API 都不得回传明文。

### D11 — Skills/Plugins 安装与更新

- `A`：完整迁移 search/install/update/enable/disable/remove/reload。
- `B`：先做 enable/disable/reload；安装和外部搜索后置。
- `C`：保持只读 Catalog。
- **推荐：B**，所有写操作需要 trust、独立 capability、网络/进程执行隔离和审计。

### D12 — 通知

- `A`：Web Notification + Service Worker，后台完成可点击回到 session；声音可独立关闭。
- `B`：只做声音。
- `C`：都不做。
- **推荐：A**，权限按用户手势请求，不在首屏强弹。

### D13 — 样式与组件迁移方式

- `A`：保留 pix 的 Vite + 手写语义 CSS/token；按参考行为重写组件，只迁纯逻辑、主题数据、无框架 hooks 和可独立验证的展示原语。
- `B`：给 pix 引入 Tailwind v4，尽可能保留参考组件 class 结构。
- **推荐：A**。参考组件同时耦合 Next Router、SSE/REST、Electron bridge 和 Tailwind class；即使引入 Tailwind，数据与生命周期仍必须重写，而 pix 现有 CSS token seam、虚拟列表和 681 个 Client 测试更适合渐进式重构。

---

## 7. 推荐范围包

若选择“按推荐方案”，冻结为：

### 第一阶段：不新增高风险后端

- 完整设计系统、主题、字体、壁纸设置；
- en/zh-CN；
- splitter、mobile shell、Draft Session、草稿/未读/last-open；
- Rich Composer：附件、`@file`、Slash、历史、模型、Thinking、Tools、Bash、Compact、Queue；
- GFM + syntax；
- ProcessGroup、tool diff、metadata、written files、Minimap；
- 文件树、上传 UI、多 Tab、代码/图片/Markdown/PDF preview、Files Watch；
- Context Menu、快捷键、声音、Web Notification；
- pix 已开放 Runtime 能力的全部 Client UI。

### 第二阶段：新增规范数据契约

- Branch tree DTO；
- Branch Navigator；
- Fork from message；
- Edit from here；
- 完整 Compaction Summary；
- 安全 Bash full-output 引用；
- deferred thinking；
- custom project themes。

### 第三阶段：高风险设置 Mutation

- Trust write/reload；
- OAuth/API key；
- Skills/Plugins enable/disable/reload；
- 安装/更新/搜索；
- 复杂 ModelsConfig；
- DOCX/HTML/音频等扩展预览。

---

## 8. 明确不迁

- Electron AppTitleBar、窗口按钮、drag region；
- Electron splash 轮询；
- Electron notification window；
- Electron reveal-in-folder；
- Electron absolute-path drag bridge；
- Next.js route handlers；
- Web 进程内 AgentSession registry；
- SSE runtime transport；
- Tailwind 作为迁移前提；
- 明文 API key 返回浏览器；
- 降级 pix 的事务上传、capability、sessiond 或虚拟化架构。

---

## 9. 对齐完成条件

只有用户确认 D1–D13 或直接接受推荐方案后，才：

1. 把 `docs/ui-redesign-plan.md` 改写为 UI+UX 实施计划；
2. 重排 UX2 工作包和依赖图；
3. 冻结新增依赖、Host/Protocol capability 和安全切片；
4. 开始 `UX2-0` CSS/组件边界准备；
5. 按 Client-only、existing-backend UI、new-contract、高风险 mutation 四条轨道实施与验证。

---

## 10. 本轮实施边界结果（UX2 集成，2026-08-16）

按第 1 节冻结范围完成的纯代码集成（foundation/shell/sidebar/chat/panels 五条并行实现合并后的 UX2-I pass）。边界结果：

### 已实现（只覆盖 pix 已有功能）

- 九文件 CSS 分层（tokens/base/shell/sidebar/chat/composer/panels/responsive）单一 owner 化：`.sidebar` 框架（宽度/收起滑出/1px 分隔线）只由 shell.css 声明；`.workspace-panel` 框架（固定 360px、1px 左边框）只由 panels.css 声明，不再有 double border / 重复 flex-basis；
- 桌面侧栏收起与移动端 overlay 由同一 `sidebar--collapsed`（Sidebar 组件自身 class，`open` prop 驱动）实现；桌面 dock 关闭即卸载（不占宽），移动端全宽 overlay 由 responsive.css 承担；
- 中心列固定 flex/滚动顺序（header → SessionActions → transcript 唯一滚动容器 → Extension → Composer），`.workspace` 补齐 `overflow:hidden`；
- 移动端统一 768px 断点 + safe-area + 44px 触控（topbar、rename 按钮、extension request 控件）；
- 集成修复：CatalogPanel `Puzzle` 图标不存在（换 `PuzzlePiece`）、TrustBadge sidebar 变体补齐 pill 样式、VisibleBranchExportButton 补回 hint/error 排版、Worktree 强删按钮补回 danger tint；
- 清理：base.css 中无组件组合的 primitives（badge/form-field/surface/error/loading/empty、text-btn tint 变体）、废弃 `--panel-width` token、重复 selector 与旧遗留 selector；
- Project/Session、rename/delete、live/history、Transcript、Composer queue/abort/steer/send、Extension UI、Files/Git/Worktree、Catalog/Trust、Login/Gate、responsive 全部保留，未替换任何 capability/虚拟化/焦点恢复/错误消毒实现。

### 未做（维持台账，不新增功能）

- 第 5 节全部差异项（Draft Session、附件/`@file`/Slash、Rich Markdown、文件多 Tab、Settings、Trust 写入、i18n、通知等）均未实现；
- 未新增任何 state/backdrop/产品功能；未修改 backend/Protocol/sessiond/Worker。

### 验证状态

- **未运行 UI tests、build、typecheck、lint、截图或浏览器验证**（与冻结约束一致）；Phosphor 图标与 JSX 用法仅通过读取已安装 `node_modules/@phosphor-icons/react` 类型导出静态核对（48/48 存在）；
- 待用户手工验收：桌面三栏/收起/dock、移动 overlay/触控、主题深浅色、各功能表面。
