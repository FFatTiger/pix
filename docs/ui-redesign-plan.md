# pix UI/UX 对齐实施计划

> 状态：`ACTIVE`  
> 最后更新：2026-08-13  
> 产品决策：只迁移 pix 当前已有功能；参考项目独有功能不进入本轮  
> 参考：`/tmp/pi-web-desktop`（只读，Next.js/Electron）  
> 目标：`packages/client`（Vite + React + PWA）  
> 差异台账：[`ui-ux-gap-analysis.md`](./ui-ux-gap-analysis.md)

---

## 1. 冻结范围

本轮将 pix 当前已经存在、用户现在可以操作的功能，全部迁移到 `pi-web-desktop` 的 UI 与 UX 语言。

### 迁移

- App shell、topbar、三栏布局和移动端 overlay；
- Project/Session Sidebar；
- Session rename/delete；
- live/history session 选择和 Continue live；
- SessionActions 已有 State/Commands/Last text/Stats/Thinking/Model；
- Transcript 已有 user/assistant/tool/system/thinking/bash 展示；
- Composer 已有 prompt/abort/steer/follow-up/queue/clear queue；
- Extension UI 已有 confirm/select/input/editor/custom；
- Workspace Dock 已有 Files/Git/Worktrees；
- Files 已有浏览、搜索、文本预览；
- Git 已有 status/diff；
- Worktree 已有 list/create/open/delete/force confirm；
- Catalog 已有 Models/Providers/Skills/Plugins/Commands/Trust 只读视图；
- Login/Gate、PWA、离线页和现有 responsive 行为；
- capability、错误、空态、loading、focus 和 aria 状态的视觉表达。

### 不进入本轮

- Draft Session；
- 图片/文件附件；
- `@file` composer 补全；
- Slash 菜单；
- 输入历史；
- Bash 发起 UI；
- Compact 发起 UI；
- Tools/Reload UI；
- Fork/Navigate/Branch Navigator；
- Auto Name UI；
- Rich Markdown、KaTeX、Mermaid、syntax highlighting；
- Chat Minimap、ProcessGroup、Turn Written Files；
- 文件多 Tab、图片/PDF/DOCX/HTML preview；
- Settings、主题选择器、壁纸选择器、i18n、通知、声音；
- Trust 写入；
- Models/Auth/Skills/Plugins mutation；
- 任何 Host/Protocol/sessiond/Worker 新能力。

这些项目保留在差异台账，后续另行立项。

---

## 2. 技术决策

1. 保持 Vite + React + TanStack Router/Query；
2. 不迁 Next.js route、`next/navigation`、SSE 或 Electron bridge；
3. 不以 Tailwind 为迁移前提；
4. 旧 `app.css` 不保留视觉兼容，可以整体替换；
5. 保留现有 JSX 行为、RuntimeProvider、SessionStore 和 capability hooks；
6. 组件可以重排 DOM，但不得改变已有命令、请求、焦点恢复和 fail-closed 语义；
7. Session/Transcript 虚拟化定位契约必须保留；
8. 使用参考项目的 IA Writer Quattro、Lilex 和 Phosphor 图标；
9. 颜色、字体、密度、边框、圆角、消息角色和 panel 层次以参考项目为准；
10. 高频操作不增加入场动画，只保留短促 press/hover feedback；
11. 不新增 UI 单测、截图测试或人工验证记录；完整实现后由用户手工验收；
12. 实施过程中不得修改 backend、Protocol、Runtime 或 release 工程。

---

## 3. CSS 边界

旧单文件 CSS 替换为：

```text
packages/client/src/styles/
├── app.css
├── tokens.css
├── base.css
├── shell.css
├── sidebar.css
├── chat.css
├── composer.css
├── panels.css
└── responsive.css
```

`app.css` 只负责 import 顺序。并行 writer 文件所有权固定：

| Track | CSS 所有权 | 组件所有权 |
|---|---|---|
| Foundation | `app.css`, `tokens.css`, `base.css` | font/icon bootstrap |
| Shell | `shell.css`, `responsive.css` | `AppShell`, `LoginPage` |
| Sidebar | `sidebar.css` | `Sidebar`, `TrustBadge` sidebar variant |
| Chat | `chat.css`, `composer.css` | Transcript、Composer、SessionActions、ExtensionRequests |
| Panels | `panels.css` | Workspace/Catalog/Files/Git/Worktree/Trust panel variant |

共享 token 只由 Foundation/Integration 修改。

---

## 4. 目标视觉

### 4.1 Token

- `--bg`, `--bg-panel`, `--bg-card`, `--bg-subtle`；
- `--bg-hover`, `--bg-selected`；
- `--text`, `--text-muted`, `--text-dim`, `--thinking-text`；
- `--border`, `--border-muted`, `--border-accent`；
- `--accent`, `--accent-hover`；
- `--success`, `--warning`, `--danger`；
- `--user-bg`, `--assistant-bg`, `--tool-bg`, `--system-bg`；
- compact controls 30–32px；
- radius 4–8px，pill 999px；
- UI 字号 11–15px；
- IA Writer Quattro 为正文/UI，Lilex 为 code/id/path。

### 4.2 Shell

- slim topbar；
- 左 Sidebar + 中 Chat + 右 Dock；
- panel 与 chat 之间 1px border；
- desktop 紧凑，mobile overlay；
- 不迁 Electron window controls；
- connection/capability 状态保留 aria-live。

### 4.3 Sidebar

- `PROJECT` / `SESSIONS` section；
- 当前 session accent rail；
- title 主层、id/cwd/time/count 次层；
- hover/focus-within 显示 actions；
- rename/delete editor 使用参考 compact form；
- virtual row transform 不做 transition。

### 4.4 Chat

- user message 使用 tinted bubble；
- assistant message使用开放式内容流；
- tool/system/bash 使用独立 surface；
- thinking 使用 dim/accent 折叠块；
- metadata 10–12px；
- streaming 与 empty/loading/error 状态统一；
- 保留 `role="log"` 与 virtual measurement。

### 4.5 Composer

- centered max-width composer；
- reference-style outline/material；
- queue chips 与状态条；
- compact toolbar；
- Abort/Steer/Send 明确主次；
- Extension UI 与 composer 使用同一表面语言；
- 不改变当前键盘和发送语义。

### 4.6 Panels

- reference TabBar grammar；
- Files/Git/Worktree/Catalog 统一 header、tab、list、preview、form；
- code/path/diff 使用 Lilex；
- fixed sanitized errors 不变；
- worktree force confirm 保持现有安全默认。

---

## 5. 实施顺序

### `UX2-F` Foundation

- 新字体、图标依赖；
- CSS 文件边界；
- reference token；
- reset、focus、scrollbar、buttons、forms、badges；
- 不修改业务行为。

### 并行阶段

- `UX2-SHELL`：AppShell/Login/responsive；
- `UX2-SIDEBAR`：Sidebar/session rows/editors；
- `UX2-CHAT`：Transcript/Composer/SessionActions/Extension UI；
- `UX2-PANELS`：Workspace/Catalog/Files/Git/Worktree。

四个 writer 使用独立 worktree，禁止跨所有权修改。

### `UX2-I` Integration

- 合并并解决 token/DOM/class 冲突；
- 清除旧 selector 和未使用 CSS；
- 统一图标、spacing、focus 和 mobile；
- 更新第三方许可说明；
- 不新增 UI 测试。

---

## 6. 完成定义

1. pix 当前所有用户可见功能仍存在；
2. 现有功能表面与参考项目保持统一的视觉和交互语言；
3. 旧 CSS 视觉不再作为兼容约束；
4. 无 Next/Electron/Tailwind 运行时依赖；
5. 无 backend/Protocol/sessiond/Worker 改动；
6. capability、RuntimeStore、虚拟化、焦点恢复和错误消毒实现未被替换；
7. 用户完成最终手工验收后再处理 UI 差异和功能增量。
