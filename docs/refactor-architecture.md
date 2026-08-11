# pi-web 重构方案

> 状态：定稿（架构；2026-08-11 增补 Pi 防腐层）
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

**Vite + React + TanStack（Client） + Hono 薄 Web/API + 独立 `pi-sessiond` + 每会话 Worker + Agent Runtime Port + Pi 防腐层 + WebSocket + SQLite 索引**

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
agent-worker × N（每会话一个进程，承载应用运行时）
        │  AgentRuntimePort（pi-web 自有语义）
        ▼
Pi 防腐层（ACL）
  ├─ PiSdkAdapter（当前：@earendil-works/pi-*）
  └─ PiRpcAdapter（未来：pi --mode rpc）
```

| 进程/模块 | 职责 | 重启影响 |
|------|------|----------|
| **Web** | UI、HTTP、WS 网关、门禁、文件/git | 可重启；客户端重连即可 |
| **pi-sessiond** | Runtime/Worker 的唯一生命周期权威 | **不**随 Web 退出 |
| **agent-worker** | 单会话应用运行时、Protocol ↔ Runtime Core 映射、承载后端 Adapter | 仅会话结束 / 空闲回收 / 显式停止时退出 |
| **Pi ACL** | 将 pi-web 自有 Port 翻译为 Pi SDK 或 Pi RPC；归一化事件、错误、工具与资源 | Adapter 可替换；上层协议和业务保持稳定 |

### 硬规则

1. UI、Host、sessiond 和 Worker Controller **永不**直接 import pi SDK，也不解析 Pi RPC 原始帧
2. `packages/runtime-core` 定义 pi-web 自有的 Runtime/Resource Ports 和规范化模型；它不依赖 Protocol、Pi SDK 或 Pi RPC
3. `packages/pi-sdk-adapter` 是当前 Pi SDK 防腐层，也是唯一可 import `@earendil-works/pi-*` 的包
4. 未来的 `packages/pi-rpc-adapter` 是 Pi RPC 防腐层，也是唯一可启动/解析 `pi --mode rpc` 的包
5. Protocol 是进程/网络边界；Runtime Port 是进程内应用边界；两者通过显式 Mapper 转换，不共享同一个类型作为捷径
6. `pi-sessiond` 是 Session **唯一权威**；Web 只做代理与附着（attach）
7. 只读浏览历史 → **0 Worker**
8. 实时状态只走 **WebSocket + snapshot/resume**，不用轮询冒充
9. `jsonl` / `~/.pi` 仍是真相源
10. 对外 Client/Host 只认 Protocol；进程内应用服务只认 Runtime/Resource Ports；按 **capabilities** 降级
11. Web 退出/崩溃：**不**终止 sessiond，不杀 worker

### Pi 防腐层（ACL）

Pi ACL 使用 Port/Adapter 结构隔离 Pi 的接入方式：

```text
pi-web Runtime Protocol（跨进程/网络 DTO）
      │  Protocol Mapper
      ▼
agent-worker application controller
      │
      ▼
Runtime Core：AgentRuntimeFactory / AgentRuntimePort
      │
      ├─ PiSdkAdapter ──▶ AgentSession / Pi SDK events
      └─ PiRpcAdapter ──▶ pi --mode rpc / JSONL frames（未来）
```

防腐层对上层暴露以下窄 Port（命名在实现前通过 `ACL0` 最终冻结）：

```text
AgentRuntimeFactory / AgentRuntimePort   # 单会话命令、事件、状态、停止
SessionCatalogPort / SessionLocatorPort  # list/resolve/read/context 和激活定位
ModelCatalogPort                         # 模型、默认值、thinking 能力
CredentialStorePort                      # provider auth，不暴露原始 credential
ResourceCatalogPort                      # skills/plugins/commands
ProjectTrustPort                         # 项目信任与资源 reload 边界
```

各进程只注入自己需要的 Port：

- Worker：`AgentRuntimeFactory`
- sessiond：`SessionLocatorPort`
- Host：`SessionCatalogPort`、`ModelCatalogPort`、`CredentialStorePort`、`ResourceCatalogPort`、`ProjectTrustPort`

防腐层负责：

- SDK/RPC 命令、事件、错误、模型、工具名和参数到 pi-web 规范模型的双向翻译
- `AgentSession`、SDK `Model`、SDK Event、Pi RPC method/frame 等外部类型的封装
- SDK/RPC 能力差异的 capability 投影；上层只处理规范化的 `UNSUPPORTED_CAPABILITY`
- session id/file、extension UI、tool result、usage、thinking、compaction、fork 等语义归一化
- 为 Runtime、历史会话、模型/认证、插件/技能提供窄 Port，避免 Host/sessiond 直接依赖 Pi 类

Adapter 选择只发生在各进程的 composition root。当前所有 Port 默认由 SDK/文件系统 Adapter 实现；未来可以只把 Agent Runtime 切到 RPC，其他 Port 继续使用现有实现：

```text
PI_WEB_AGENT_BACKEND=sdk   # 当前默认：PiSdkAgentRuntimeAdapter
PI_WEB_AGENT_BACKEND=rpc   # 未来：PiRpcAgentRuntimeAdapter
```

sessiond、Host、Client、pi-web Runtime Protocol 和应用服务不得出现 `if (backend === "sdk")` 之类的供应商分支。Adapter 的 capability 决定可用功能。

### Port 形态（伪代码）

`runtime-core` 中的接口表达 pi-web 需要什么，不表达 Pi SDK/RPC 怎么提供：

```ts
interface AgentRuntimeFactory {
  create(input: RuntimeStartInput): Promise<AgentRuntimePort>;
  open(input: RuntimeOpenInput): Promise<AgentRuntimePort>;
}

interface AgentRuntimePort {
  readonly identity: RuntimeIdentity;
  getCapabilities(): RuntimeCapabilitySet;
  getSnapshot(): Promise<RuntimeState>;
  subscribe(listener: (event: RuntimeEvent) => void): () => void;
  execute(command: RuntimeCommand): Promise<RuntimeCommandResult>;
  interrupt(command: RuntimeInterrupt): Promise<void>;
  close(reason: RuntimeCloseReason): Promise<void>;
}
```

设计约束：

- `RuntimeCommand`、`RuntimeEvent`、`RuntimeState` 是 Runtime Core Model，与 Protocol DTO 分开
- `interrupt` 是独立控制通道，保证 abort 类操作不被 prompt/bash/compact 长操作阻塞
- `close` 使用规范化 reason；Adapter 负责映射 SDK shutdown 或 RPC process termination
- Port 只承诺规范语义；后端能力差异通过 capability 和规范错误返回
- SDK/RPC 原始对象只在 Adapter 内存活，不能存入 sessiond registry、Protocol event journal 或 Host cache

`pi-sdk-adapter` 使用子路径导出隔离不同进程的依赖：

```text
@fffattiger/pi-web-pi-sdk-adapter/agent      # Worker composition root
@fffattiger/pi-web-pi-sdk-adapter/sessions   # Host/session locator/catalog
@fffattiger/pi-web-pi-sdk-adapter/models     # Host model application service
@fffattiger/pi-web-pi-sdk-adapter/resources  # Host skills/plugins/trust service
```

各子路径不得通过聚合 barrel 提前加载其它 Adapter。未来 `pi-rpc-adapter` 可以先只实现 `/agent`，其余 Port 继续注入现有 SDK/文件系统实现，实现按 Port 渐进替换。

## 4. 技术选型

| 层 | 选型 | 说明 |
|----|------|------|
| 当前交付 | **PWA 跨端** | 本机 loopback + 局域网连 Host |
| 页面 | **Vite + React 19** | 无 SSR |
| 前端工程 | **TanStack Router / Query / Virtual** | 路由、HTTP 资源缓存、长列表 |
| 客户端运行时状态 | **SessionStore（事件投影）** | 只消费 WS，不走 Query 轮询 |
| Web/API | **Hono（Node 22）** | 薄网关，不持有会话权威状态 |
| 会话管理 | **独立 `pi-sessiond`** | 与 Web 进程解耦，保证会话保活 |
| Agent 运行时 | **每会话 child_process Worker** | 崩溃隔离、可回收、并发上限可配 |
| Runtime 应用边界 | **`AgentRuntimePort`** | pi-web 自有命令、状态、事件和错误语义 |
| Pi 接入 | **防腐层 + Adapter** | 当前 `PiSdkAdapter`；未来可加 `PiRpcAdapter`，上层不变 |
| Runtime 线协议 | **pi-web Runtime Protocol v1** | 产品级命令、事件、snapshot/resume；不表达 SDK/RPC 类型 |
| 实时通道 | **WebSocket 主通道** | 承载 pi-web Runtime Protocol 命令、事件和 resume |
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
| UI/Host/sessiond 直连 Pi SDK 或原始 RPC | Pi 接入细节向全栈扩散，后续无法低成本切换 |
| Runtime Protocol 直接镜像 SDK/RPC 类型 | 外部依赖升级会破坏客户端和跨进程契约 |
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

## 6. 协议：pi-web Runtime Protocol v1

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
  UI → WS command → Web 网关 → pi-sessiond → worker application controller
     → AgentRuntimePort → PiSdkAdapter（当前）/ PiRpcAdapter（未来） → Pi
  UI ← SessionStore ← WS events/snapshot ← sessiond ← normalized runtime events ← Pi ACL
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
  protocol/        # 网络/进程线协议：zod schema、版本、共享 DTO
  runtime-core/    # pi-web 自有 Ports、规范化模型和应用错误；零 Pi 依赖
  pi-sdk-adapter/  # 当前 Pi SDK 防腐层；唯一可 import @earendil-works/pi-* 的包
  pi-rpc-adapter/  # 未来 Pi RPC 防腐层；当前只保留架构位置，不交付
  runtime-contract-tests/ # Adapter 共享行为契约测试（测试包，不进入生产产物）
  sessiond/        # 守护进程：会话权威、Worker 调度、事件总线
  agent-worker/    # 单会话进程壳：Protocol mapper + application controller + Adapter composition
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
| **A 会话拆出** | `runtime-core` + Pi ACL + `pi-sessiond` + attach/resume + 每会话 Worker | Web 重启不杀运行中会话；浏览历史 0 worker；SDK Adapter contract tests 通过 |
| **B 新 Web 骨架** | Hono 薄网关 + Vite Client + pi-web Runtime Protocol v1 | 单端口可用；WS 为主通道 |
| **C 体验** | SQLite 索引、TanStack Virtual、Query 管资源、去轮询 | 千级会话 list 快；长会话可滚动 |
| **D PWA 跨端** | LAN、gate/配对、capability 降级、断线 resume | 手机可看/轻控；桌面跑 Agent |
| **E 以后** | 桌面原生壳（Tauri）等 | 同协议换壳，不改 sessiond |

建议优先顺序：**A → B → C → D**。  
A 是现网最大痛点（重启杀会话）；D 是当前产品主线（PWA 跨端）。

## 12. 验收指标

- Web 进程重启后，运行中会话仍存活，客户端可 attach 恢复
- 只读打开历史：**0** agent worker
- `@earendil-works/pi-*` import 只存在于 `pi-sdk-adapter`
- Worker Controller 使用 fake Runtime Port 的测试可运行，不需要加载 Pi SDK
- `PiSdkAdapter` 通过共享 Adapter contract suite；未来 `PiRpcAdapter` 复用同一 suite
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
| Agent 生命周期 | `lib/rpc-manager.ts` 进 Web 进程并直接调用 SDK | `pi-sessiond` 常驻；Worker 只认 Runtime Port；Pi ACL 负责 SDK/RPC |
| 实时 | SSE + POST + 轮询对账 | WebSocket + snapshot |
| 会话列表 | `SessionManager.listAll` + 短缓存 | Host SQLite 投影 + `SessionCatalogPort` 回源 |
| 跨端 | 偏桌面浏览器；PWA 基础存在 | PWA 为第一跨端形态 |
| 重启 | 杀会话 | 不杀会话 |

## 14. 最终判断

| 问题 | 答案 |
|------|------|
| 页面用什么？ | Vite + React + TanStack Router/Query/Virtual |
| Web 后端用什么？ | Hono（薄，可重启） |
| 会话跑哪？ | **独立 pi-sessiond** 管生命周期；具体 Pi runtime 存在于 Worker Adapter 内 |
| Agent 跑哪？ | sessiond 调度的每会话 Node Worker；Worker 通过 `AgentRuntimePort` 调用 Pi ACL |
| 当前怎么接 Pi？ | `PiSdkAgentRuntimeAdapter`；Pi SDK 类型只存在于 `pi-sdk-adapter` |
| 以后改 Pi RPC？ | 增加 `PiRpcAgentRuntimeAdapter` 并通过同一 Adapter contract suite；上层协议和业务无需改造 |
| 实时怎么做？ | WebSocket + resume |
| 当前跨端？ | **PWA**（本机完整能力，手机连 Host） |
| 桌面客户端？ | 架构预留，**现在不做** |
| Next？ | 过渡可留，**不作终局** |

切换接入方式只影响 Pi ACL Adapter 和各进程 composition root，不改变 pi-web Runtime Protocol、Runtime Core、sessiond 调度、Host 网关或 Client 状态模型。
