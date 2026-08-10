# pi-web 重构方案

> 状态：定稿（架构）
> 主线：PWA 跨端
> 桌面原生壳：仅预留，当前不交付
> 任务认领、进度看板、文件所有权和协作规则：[`refactor-execution-plan.md`](./refactor-execution-plan.md)

## 1. 目标

将 pi-web 从「Next.js 进程内嵌 AgentSession」重构为「协议中心的本机 Agent 工作站」：

- Web 进程可随时重启，**不杀死**正在运行的会话
- 一份 Client，支持浏览器 / 安装式 PWA（电脑 + 手机）
- 与 pi CLI 共存：`jsonl` / `~/.pi` 仍是真相源
- 为以后桌面客户端（Tauri sidecar）预留同一 Host/协议，但现阶段不做壳

## 2. 一句话定案

**Vite + React + TanStack（Client） + Hono 薄 Web/API + 独立 `pi-sessiond` + 每会话 Worker + WebSocket + SQLite 索引**

## 3. 目标架构

```
Browser / 安装式 PWA（桌面 + 手机主入口）
        │
Web 进程（可随时重启）
  Vite 静态资源
  Hono：门禁 · HTTP API · WS 网关 · 文件/git
        │  本机 IPC / localhost RPC
        ▼
pi-sessiond（常驻守护进程，会话权威）
  会话注册表 · Worker 调度 · 事件总线 · 空闲回收
        │
agent-worker × N（每会话一个进程，只跑 pi SDK）
```

| 进程 | 职责 | 重启影响 |
|------|------|----------|
| **Web** | UI、HTTP、WS 网关、门禁、文件/git | 可重启；客户端重连即可 |
| **pi-sessiond** | 所有 AgentSession / Worker 的唯一所有者 | **不**随 Web 退出 |
| **agent-worker** | 实际执行 `@earendil-works/pi-*` | 仅会话结束 / 空闲回收 / 显式停止时退出 |

### 硬规则

1. UI **永不**直接 import pi SDK  
2. `pi-sessiond` 是 Session **唯一权威**；Web 只做代理与附着（attach）  
3. 只读浏览历史 → **0 Worker**  
4. 实时状态只走 **WebSocket + snapshot/resume**，不用轮询冒充  
5. `jsonl` / `~/.pi` 仍是真相源  
6. 所有端只认 Protocol；按 **capabilities** 降级，不按「是不是 App」写死业务  
7. Web 退出/崩溃：**不**终止 sessiond，不杀 worker  

## 4. 技术选型

| 层 | 选型 | 说明 |
|----|------|------|
| 当前交付 | **PWA 跨端** | 本机 loopback + 局域网连 Host |
| 页面 | **Vite + React 19** | 无 SSR |
| 前端工程 | **TanStack Router / Query / Virtual** | 路由、HTTP 资源缓存、长列表 |
| 客户端运行时状态 | **SessionStore（事件投影）** | 只消费 WS，不走 Query 轮询 |
| Web/API | **Hono（Node 22）** | 薄网关，不持有会话权威状态 |
| 会话管理 | **独立 `pi-sessiond`** | 与 Web 进程解耦，保证会话保活 |
| Agent 执行 | **每会话 child_process Worker** | 崩溃隔离、可回收、并发上限可配 |
| 实时通道 | **WebSocket 主通道** | 命令 + 事件 + resume |
| 会话列表 | **SQLite 投影索引** | 加速 list；jsonl 仍是源 |
| 运行时 | **Node 22 LTS** | 对齐 pi SDK |
| 桌面原生壳 | **仅架构预留** | 协议/Host 可被 Tauri 挂载；当前不交付 |

### 明确不选

| 项 | 原因 |
|----|------|
| Next.js 长期底座 | 请求模型不适合长生命周期 Agent；Web 重启会带走进程内会话 |
| TanStack Start | 仍是全栈页面框架，不解决 Agent 宿主与会话保活 |
| Go 主后端 | Agent 内核是 Node SDK，最终仍要 Node Worker，双运行时过重 |
| Electron 同进程塞 SDK | 与 PWA/Web 协议分叉；崩溃面大 |
| 手机端跑 Agent | 无完整本机 dev 环境；手机只连电脑上的 Host |
| 用 DB 取代 jsonl | 破坏与 pi CLI 互通 |
| UI 直连 pi SDK | 无法跨进程/跨端 |
| 用 TanStack Query 轮询冒充 streaming | 破坏 resume 与跨端一致性 |

## 5. 会话保活（相对现状的关键修复）

### 现状问题

AgentSession 活在 Web/Next 进程内。重启 Web（或热更新拖垮进程）会杀掉所有运行中会话。

### 目标行为

| 事件 | 期望 |
|------|------|
| 重启 Web / 发版切换 Web 进程 | 会话与 Worker 继续跑 |
| 浏览器刷新 / PWA 重建 | `attach + lastEventId` 恢复 UI |
| 手机切后台再回来 | 同一 resume 路径 |
| 显式 stop / 空闲超时 | 才回收 Worker |
| sessiond 自身退出 | 会话结束（接受）；需单独升级 sessiond 时处理 |

### 单实例约定

- sessiond 使用锁文件 + 固定本机 endpoint  
  例如：`~/.pi/web/sessiond.sock` 或 `127.0.0.1:<固定/协商端口>` + `~/.pi/web/sessiond.lock`
- Web 启动：
  1. 发现已有 sessiond → 接入  
  2. 否则拉起 sessiond 再接入  
- Web 关闭：只断连接，**不** SIGTERM sessiond（可用显式 CLI/`pi-web down --all` 收全套）

## 6. 协议：Pi Runtime Protocol v1

### 传输

| 通道 | 用途 |
|------|------|
| `WS /v1/runtime` | prompt / steer / follow_up / abort / set_model / compact / fork… + 事件流 |
| `HTTP /v1/*` | sessions、files、git、models、skills、plugins、gate、export |
| Web ↔ sessiond | 本机 IPC/RPC（实现细节可演进；对外仍表现为上述协议） |

### 握手

Client → Host：

```json
{
  "protocolVersion": 1,
  "client": { "shell": "web|pwa", "platform": "win|mac|linux|ios|android" },
  "features": ["virtual-scroll", "notifications"],
  "auth": "<gate-token-if-any>"
}
```

Host → Client：

```json
{
  "protocolVersion": 1,
  "host": {
    "mode": "local|lan",
    "capabilities": ["agent", "files", "files.write", "git", "worktree"]
  },
  "limits": { "maxUpload": 0, "maxOpenSessions": 0 },
  "sessionSnapshotSupport": true
}
```

### Resume

- 连接携带 `sessionId` + `lastEventId` / `epoch`
- Host/sessiond 推送 `state_snapshot`，再续后续事件
- 禁止依赖「轮询 `/running` 猜是否结束」作为主路径

### 能力协商

Client 按 `capabilities` 显隐功能：

| 能力 | 无此能力时 |
|------|------------|
| `agent` | 只读浏览 |
| `files.write` | 禁用写入 |
| `worktree` | 隐藏 worktree 切换 |

## 7. 数据流

```
只读资源:
  UI → TanStack Query → HTTP /v1 → Web(Hono) → SQLite / FS / git

跑 Agent:
  UI → WS command → Web 网关 → pi-sessiond → worker → pi SDK
  UI ← SessionStore ← WS events/snapshot ← sessiond（经 Web 转发）
```

| 现状 | 目标 |
|------|------|
| SSE + POST + 多路轮询 | 一条 WS 运行时通道 |
| `startRpcSession` 进 Web 进程 | sessiond 持有；Web 只 attach |
| 每次 `listAll` 扫盘 | SQLite 索引 + watch |
| Web 重启杀会话 | Web 重启会话仍在 |

## 8. 包结构

```
packages/
  protocol/        # zod schema、版本、共享类型
  sessiond/        # 守护进程：会话权威、Worker 调度、事件总线
  agent-worker/    # pi SDK 进程入口
  host/            # Hono 薄 Web/API + WS 网关 + 静态资源
  client/          # Vite React + TanStack
  cli/             # pi-web / pi-host / sessiond 启停入口
  shell-tauri/     # 预留，当前不交付
```

### 产物（当前）

| 产物 | 内容 |
|------|------|
| `pi-web` | CLI：确保 sessiond + 启 Web（兼容现有 npx 心智） |
| `pi-sessiond` | 可独立运行的会话守护进程 |
| Web UI | `client` 构建的静态资源，由 host 托管 |
| PWA | manifest + service worker，挂在 host 静态资源上 |

## 9. 跨端策略（当前主线：PWA）

| 端 | 连接 | 能力 |
|----|------|------|
| 电脑浏览器 / 桌面 PWA | 本机 Web → sessiond | 完整 |
| 手机 / 平板 PWA | 电脑局域网 Web → 同一 sessiond | 看会话、轻操作、steer/follow-up；**不在手机跑 Agent** |

### 安全分级

| 场景 | 策略 |
|------|------|
| `127.0.0.1` | Host/Origin 防护；gate 可配 |
| **LAN** | **强制 gate / 配对**；禁止裸奔 |
| 文件 | allow-root；worker 只能碰授权路径 |
| sessiond | 默认只监听本机；不随 LAN 暴露；由 Web 网关统一对外 |

手机连电脑 = 高权限 agent 入口，按远程控制台做鉴权，不是「顺便打开局域网」。

## 10. 与桌面客户端的关系（仅设计预留）

```
未来（不在当前交付）:
  Tauri Shell → 同一 Client dist → 本机 Web/host 或直连协议
                     │
                     └── 仍附着同一 pi-sessiond
```

当前约束：

- **不**实现 Tauri/Electron 安装包  
- **不**为桌面壳单独分叉业务协议  
- 保持：Client 静态化、Session 在 sessiond、单协议  

这样以后上桌面壳是加 Shell，不是翻架构。

## 11. 落地阶段

| 阶段 | 交付 | 完成标准 |
|------|------|----------|
| **A 会话拆出** | `pi-sessiond` + attach/resume + 每会话 Worker | Web 重启不杀运行中会话；浏览历史 0 worker |
| **B 新 Web 骨架** | Hono 薄网关 + Vite Client + Protocol v1 | 单端口可用；WS 为主通道 |
| **C 体验** | SQLite 索引、TanStack Virtual、Query 管资源、去轮询 | 千级会话 list 快；长会话可滚动 |
| **D PWA 跨端** | LAN、gate/配对、capability 降级、断线 resume | 手机可看/轻控；桌面跑 Agent |
| **E 以后** | 桌面原生壳（Tauri）等 | 同协议换壳，不改 sessiond |

建议优先顺序：**A → B → C → D**。  
A 是现网最大痛点（重启杀会话）；D 是当前产品主线（PWA 跨端）。

## 12. 验收指标

- Web 进程重启后，运行中会话仍存活，客户端可 attach 恢复  
- 只读打开历史：**0** agent worker  
- 会话列表 P95：千级会话 **\< 50ms**（索引命中时）  
- 单 worker 崩溃：不影响其他会话与 UI  
- 约 1 万条消息：主线程可交互（Virtual）  
- 手机断线重连：靠 snapshot，不靠猜 `ended`  
- 默认对外仍是 **一个端口**（Web）；sessiond 仅本机  

## 13. 现状对照（摘要）

| 领域 | 现状（Next 单体） | 目标 |
|------|-------------------|------|
| 页面框架 | Next App Router | Vite + React + TanStack |
| API | `app/api/*` Route Handlers | Hono `/v1/*` |
| Agent 生命周期 | `lib/rpc-manager.ts` 进 Web 进程 | `pi-sessiond` 常驻 |
| 实时 | SSE + POST + 轮询对账 | WebSocket + snapshot |
| 会话列表 | `SessionManager.listAll` + 短缓存 | SQLite 投影 |
| 跨端 | 偏桌面浏览器；PWA 基础存在 | PWA 为第一跨端形态 |
| 重启 | 杀会话 | 不杀会话 |

## 14. 最终判断

| 问题 | 答案 |
|------|------|
| 页面用什么？ | Vite + React + TanStack Router/Query/Virtual |
| Web 后端用什么？ | Hono（薄，可重启） |
| 会话跑哪？ | **独立 pi-sessiond**，不是 Web 进程 |
| Agent 跑哪？ | sessiond 调度的每会话 Node Worker |
| 实时怎么做？ | WebSocket + resume |
| 当前跨端？ | **PWA**（本机完整能力，手机连 Host） |
| 桌面客户端？ | 架构预留，**现在不做** |
| Next？ | 过渡可留，**不作终局** |

**终局（当前交付范围）：可重启的 Web + 常驻 sessiond + PWA 跨端 Client，而不是「又一个绑死会话的全栈 Web 应用」。**
