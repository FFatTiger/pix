# 记忆（长期记忆）能力

Pix 的长期记忆是一个全局设置（settings.json 的 `pixMemoryProvider` 键），三选一：**本地记忆（默认）**、**Lore**、**关闭**。两个记忆后端都是 Pix 捆绑的固定版本插件（见 AGENTS.md §7a），绝不同时加载，切换不需要安装任何东西。

| 选择 | 加载的插件 | 说明 |
|---|---|---|
| 本地记忆 | `pi-memory` 0.4.2（vendor tgz） | 纯本地，所有会话共用 `~/.pi/agent/memory`（MEMORY.md、daily/、SCRATCHPAD.md）。强制 `PI_MEMORY_EXIT_SUMMARY=0`（Pix 频繁回收闲置 worker，退出总结只会浪费模型调用）；不附带 qmd，`memory_search` 在注册前即被移除（模型看不到一个只会报错的工具）。 |
| Lore | `@local/lore-pi-extension` 1.5.0（GitHub Release `FFatTiger/lore` 的 `lore-pi.zip`，vendor tgz） | 使用 Lore 记忆服务。连接配置写在 `~/.lore/config.json`（`base_url` + `api_token`，权限 0600），与用户其他 Lore 客户端共用；也识别 `LORE_BASE_URL` / `LORE_API_TOKEN` / `LORE_HOME` 环境变量（sessiond 会把它们转发给 worker）。 |
| 关闭 | 无 | 助手提示词里不出现「记忆」一节。 |

设置入口：设置 → Agent 分组 → 记忆。能力（Capabilities）页**没有** pi-memory 或 Lore 的独立开关——记忆的选择只归这一页。

## 各场景行为

- **默认（从未设置且没有 Lore）**：本地记忆。
- **已配置过 Lore 再升级到本版本**（`~/.lore/config.json` 或环境变量里已有服务地址 + token）：`pixMemoryProvider` 缺省时自动解析为 **Lore（已连接）**，用户不用重新填写，也不会被切到本地记忆。设置页直接显示服务地址与连接状态。
- **未配置 Lore 时选择 Lore**：页面给出三个入口——注册 SaaS（中文 https://loremem.com/zh-cn ，英文 https://loremem.com ）、自己部署（安装文档中文 https://loremem.com/zh-cn/documents/installation/install-lore ，英文 https://loremem.com/documents/installation/install-lore ）、连接已有服务器（https://loremem.com/zh-cn/documents/installation/manual-configuration ）。填「服务地址」（默认 `https://api.loremem.com`）和「API Token」（密码框，已保存的值不回显），点「测试连接」（`GET <base>/api/health` + Bearer）通过后才能保存启用。启用时不安装任何东西——扩展已捆绑。
- **Lore 连不上 / Token 失效**：测试给出明确原因（地址无效 / 非本机 http / 缺 Token / Token 被拒 / 连不上），可「重新测试」或改选本地记忆。**绝不静默回退到本地记忆**——那会造成记忆分裂。已选 Lore 的机器上，服务端保存（`PUT /v1/settings/memory`）也要求连接已配置（fail-closed）。
- **Lore → 本地记忆**：`~/.lore/config.json` 原样保留，方便以后切回；Lore 扩展（包括用户自己在 `~/.pi/agent/extensions/` 装的那份）在 Pix 会话里不再加载。Lore 里的记忆不会迁移到本地文件。
- **本地记忆 → Lore**：`~/.pi/agent/memory` 里的本地记忆文件原样保留，不会上传。
- **切换生效时机**：新会话立即生效；已运行的会话保持当前已加载的后端，`/reload` 或重启后跟上（与其他全局设置一致）。设置页不展示这些说明。助手提示词的「记忆」一节按当前提供者逐回合解析。
- **Token 安全**：只存 `~/.lore/config.json`（0600，原子写）；Pix 的任何接口不返回明文（GET 只报 `tokenConfigured`），日志不打印。换服务地址而不换 Token 时，旧行为与官方 CLI 一致：旧 Token 被清除。

## 助手提示词的「记忆」一节

按当前提供者生成（`assistant-system-prompt.ts`）：

- 本地记忆：
  > ## 记忆
  > 你和用户是长期合作。涉及过去的偏好、决定和约定时，先用 memory_read 查看记忆；遇到值得长期记住的新事实，用 memory_write 记下来。记忆要精炼，过时的内容及时更新或删除。
- Lore：
  > ## 记忆
  > 你和用户是长期合作。涉及过去的偏好、决定和约定时，先在 Lore 里查；遇到值得长期记住的新事实，记进 Lore。
- 关闭：不输出这一节。

（pi-memory 0.4.2 的实际工具名就是 `memory_read` / `memory_write`，另有 scratchpad / memory_forget / memory_restore / memory_status；`memory_search` 被 Pix 过滤。）

## 重复加载防护

用户自己在 `~/.pi/agent/extensions/`（例如 Lore 官方安装器的软链 `~/.pi/agent/extensions/lore` → `~/.lore/pi`）或 Pi settings `packages` 里装了同一个插件时：Pix 会话里只加载捆绑的那份，用户那份被识别并排除（按安装路径或注册面识别，不删除、不修改用户文件，`pi` 命令行里照常可用）。`curated-plugins.ts` 的互斥断言保证 pi-memory 与 Lore 绝不同时加载。

## API 面（Host，`settings.configure`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/settings/memory` | `{ revision, provider, providerExplicit, lore: { configured, baseUrl, source, tokenConfigured } }` |
| PUT | `/v1/settings/memory` | CAS 写 `pixMemoryProvider`；选 Lore 要求连接已配置 |
| PUT | `/v1/settings/memory/lore` | 写 `~/.lore/config.json`（token 只写不读；URL 不变时可省略保留） |
| POST | `/v1/settings/memory/lore-test` | 健康探测；失败也是 200 结果（`ok:false` + reason），不回显 token |
