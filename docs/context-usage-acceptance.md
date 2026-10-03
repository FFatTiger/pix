# 上下文占用一致性：上线验收

2026-09-12。用户明确授权维护上线后，修复已发布到 https://m.huu.im:30145 。生产实现为 `4e81f5c`，HTTP 字段透传补修为 `f2ec9aa`；以下记录区分候选检查与实际线上证据。

## 最终行为

- 默认历史页从同一次 selected JSONL branch 读取模型、leaf 和 `contextTokens`，结合 exact provider/id 的目录窗口显示估算，不读取同 ID 后台 Worker 的另一条分支统计。
- 实时模型、leaf、占用由已有状态事件一起更新。旧 stats 不覆盖新状态或压缩后的 null；未应用的模型选择与运行模型不一致时不显示另一模型占用。
- 历史估算显示 `≈`，说明文字为“所选模型的上下文估算”。统计读取不会重载 Worker 或改变执行分支。

## 维护与产物

1. 备份旧产物、启动环境、登录与目录配置到权限 0700 的 `~/.local/state/pix/deploy-backups/context-20260912T105342Z`。其中启动环境与配置文件不公开。
2. 确认旧 contract 4/3/2、两个 ready Worker 后，通过 Host 既有正常关闭处理器停止入口，并执行官方 CLI `down --all`（认证、instance-fenced sessiond shutdown），退出 0。没有通过 PID 信号关闭 sessiond，也没有向用户会话发送测试消息或覆盖/回滚 JSONL。
3. 正式目录完整构建退出 0，官方 CLI 恢复 `127.0.0.1:30145`。新 sessiond instance 为 `57ed0025-6436-4afe-8368-26581d3d0488`，contract 5/4/3；旧 instance 为 `4cad5eff-ceef-4975-adba-54a15572cba7`。
4. 首次真实浏览器验收发现 Host 手工组装 HTTP context 响应时漏掉 `contextTokens`。`f2ec9aa` 补齐该 owner 的投影，增加 number/0/null/undefined 四个 Hono 回归及实际 RPC→HTTP E2E 断言。旧 dist 可复现失败，补修后通过。只更新并重启 Host，sessiond PID 7267 和 instance 均未变化。
5. 登录/偏好配置、允许目录配置与维护前备份逐字节一致；端口 30141 服务、nginx/TLS 配置未修改。

公网实际加载的 JS 为 `/assets/index-BtBsRW9x.js`，2,642,216 字节，SHA-256：

```text
155b3d17097c6da89c3cedc7f81d597f148a66d2b845edb58a1943584040b4f5
```

本地、公网、磁盘 dist 三者一致。Host context route JS 与验收候选一致，其 SHA-256 为 `8a552d73dbeafdf2d7c6c3f45c9767e2933e33abe12e7eb5fbd188d95c8da7ab`。

## 实际公网浏览器结果

目标 session：`01a083ea-6acc-7092-86c0-fd0d46ddf28f`，cwd：`/Users/proxy/Documents/program/yueli`。

19:19 CST 验收时，目标文件已有用户的新消息，故期望值以浏览器实际收到的同份 context 与 exact models 响应计算，不固定使用早先的 26%：

| 项目 | 初次打开 | 刷新后 |
|---|---|---|
| URL/侧栏选中目标 session | 一致 | 一致 |
| 模型 | `huu-gpt/gpt-6-astra` / GPT-6 Astra | 相同 |
| leaf | `286b462b` | 相同 |
| tokens / window | 467,262 / 1,050,000 | 相同 |
| tooltip / footer | 44.5% / `≈45%` | 相同 |
| WS attach/activate/command/submit | 全部 0 | 全部 0 |

浏览前后 Worker 数均为 0，目标未被激活。验证 Chrome 已关闭。此前近同步 HTTP/RPC 样本 leaf `2d323b97`、tokens 466,968 在 local/public/RPC 三面一致；与浏览器后续采样的差别来自文件继续推进，并非跨响应拼接。local/public health 均 200、sessiond up；未认证历史请求 401，原有密码登录成功。

## 验证记录

- 最终隔离候选 root architecture/typecheck/test/build、client boundaries、adapter commands、Startup/Runtime/Sessions E2E 九步全部 exit 0：`/tmp/context-host-final-gates/status.json`。
- Client 1006、Adapter 420、Protocol 219、Host 588 项通过；sessiond 374 通过，1 项 Windows 专用用例在 macOS 跳过，零失败。
- 独立实现复验：Client 134、Adapter 14、Protocol 12 全部通过；HTTP 补修另获独立 Host 路由测试 60/60 通过。
- 独立代理实际完成公网 Chrome 首次打开及刷新并写入 `postverify/final-browser.json`（PASS），以及 `postverify/final-http.json`。父级核对字段、计算、资源 hash、零激活与清理标记后生成 `acceptance.json`（PASS）。所有线上证据位于上述受保护备份目录，未记录密码/cookie。

此记录不承诺外部运行中会话无缝接管；外部 JSONL 写入与 live 分支不同的原因为独立议题，修复没有通过读取统计强制改变执行分支。
