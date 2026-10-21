// Seeds two Pi sessions (git repo cwd + non-git cwd) covering every card state
// this verification needs, byte-shaped like what the SDK persists.
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

const agentDir = resolve(process.argv[2]);
const gitDir = resolve(process.argv[3]);
const plainDir = resolve(process.argv[4]);

const META = {
  api: "openai-completions",
  provider: "huu-gpt",
  model: "gpt-5.6-sol",
  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
};

const gitScope = [
  "# 迁移范围对照：同步中 / 未同步 / 已排除",
  "",
  "2026-10-21 23:5x。当前正在执行第一阶段（video → F/D 盘）。",
  "",
  "## 一、同步中（本次迁移目标）",
  "",
  "| 项目 | 来源 | 大小 | 目标 | 状态 |",
  "|---|---|---:|---|---|",
  "| `video` 全部内容 | NAS `/volume2/data/video` | 2.169TB | F 盘优先 | **26.9%** |",
  "| `iCloud` 照片 | NAS `/volume2/photo` | 812GB | D 盘 | 未开始 |",
  "| `immichUpload` | NAS `/volume2/docker/immich` | 96GB | D 盘 | 未开始 |",
  "",
  "## 二、未同步",
  "",
  "| 项目 | 原因 |",
  "|---|---|",
  "| `app-backup` | 等待数据库一致性快照 |",
  "| `monitor` | 依赖 app 恢复顺序 |",
  "",
  "## 三、已排除",
  "",
  "| 项目 | 排除原因 |",
  "|---|---|",
  "| `@eaDir` | 群晖缩略图缓存 |",
  "| `#recycle` | 回收站 |",
  "",
  "## 四、后续排队",
  "",
  "1. iCloud + immichUpload 并行",
  "2. 应用配置 / 数据库备份",
  "3. 校验与清理旧盘",
].join("\n") + "\n";

const plainScope = [
  "# 迁移范围对照（非 git 目录）",
  "",
  "| 项目 | 来源 | 大小 | 状态 |",
  "|---|---|---:|---|",
  "| `video` | NAS `/volume2/data/video` | 2.169TB | **26.9%** |",
  "| `iCloud` | NAS `/volume2/photo` | 812GB | 未开始 |",
  "",
  "## 未同步",
  "",
  "| 项目 | 原因 |",
  "|---|---|",
  "| `app-backup` | 等待数据库快照 |",
].join("\n") + "\n";

const report = Array.from({ length: 66 }, (_, i) => `第 ${i + 1} 行记录`).join("\n") + "\n";
const trackedBase = "# 已跟踪文件\n\n原始内容第一行\n第二行\n";
const trackedNext = `${trackedBase}\n追加的一行\n`;

function writeSession({ cwd, sessionId, ts, scope, turns }) {
  const encoded = `--${cwd.replace(/^[/\\]/, "").replace(/[/:\\]/g, "-")}--`;
  const dir = join(agentDir, "sessions", encoded);
  mkdirSync(dir, { recursive: true });
  let clock = Date.parse(ts);
  const entries = [];
  let parent = null;
  const push = (entry) => { entries.push({ ...entry, parentId: parent }); parent = entry.id; };
  const stamp = () => { clock += 1000; return new Date(clock).toISOString(); };
  const msg = (id, role, content, extra = {}) => {
    clock += 1000;
    return { type: "message", id, timestamp: new Date(clock).toISOString(), message: { role, content, timestamp: clock, ...extra } };
  };

  push({ type: "model_change", id: `${sessionId}-m`, timestamp: stamp(), provider: "huu-gpt", modelId: "gpt-5.6-sol" });
  for (const turn of turns) {
    push(msg(`${turn.id}-u`, "user", [{ type: "text", text: turn.prompt }]));
    for (const call of turn.calls) {
      push(msg(`${call.id}-a`, "assistant", [{ type: "toolCall", id: call.id, name: call.name, arguments: call.args }], { ...META, stopReason: "toolUse" }));
      push(msg(`${call.id}-r`, "toolResult", [{ type: "text", text: call.text }], {
        toolCallId: call.id,
        toolName: call.name,
        isError: false,
        ...(call.details === undefined ? {} : { details: call.details }),
      }));
    }
    push(msg(`${turn.id}-ans`, "assistant", [{ type: "text", text: turn.answer }], { ...META, stopReason: "stop" }));
  }
  const header = { type: "session", version: 3, id: sessionId, timestamp: ts, cwd };
  const file = join(dir, `${ts}_${sessionId}.jsonl`);
  writeFileSync(file, `${[header, ...entries].map((e) => JSON.stringify(e)).join("\n")}\n`);
  return file;
}

const shown = (p) => ({ files: [{ path: p, name: "SCOPE-STATUS.md", kind: "file" }], open: p });

// ---- git repo cwd ---------------------------------------------------------
mkdirSync(gitDir, { recursive: true });
writeFileSync(join(gitDir, "SCOPE-STATUS.md"), gitScope);
writeFileSync(join(gitDir, "REPORT.md"), report);
writeFileSync(join(gitDir, "tracked.md"), trackedBase);
execFileSync("git", ["-C", gitDir, "init", "-q"]);
execFileSync("git", ["-C", gitDir, "add", "tracked.md"]);
execFileSync("git", ["-C", gitDir, "-c", "user.email=e2e@example.test", "-c", "user.name=e2e", "commit", "-qm", "init"]);
writeFileSync(join(gitDir, "tracked.md"), trackedNext);

const gitSession = "01a20f00-0000-7000-8000-000000000001";
const gitFile = writeSession({
  cwd: gitDir,
  sessionId: gitSession,
  ts: "2026-10-21T16:30:00.000Z",
  turns: [
    {
      id: "t1", prompt: "写一份迁移范围对照并给我看", answer: "对照表已经写好，右侧打开给你看。",
      calls: [
        { id: "w1", name: "write", args: { file_path: join(gitDir, "SCOPE-STATUS.md"), content: gitScope }, text: `Successfully wrote to ${join(gitDir, "SCOPE-STATUS.md")}` },
        { id: "s1", name: "show_files", args: { files: [join(gitDir, "SCOPE-STATUS.md")], open: join(gitDir, "SCOPE-STATUS.md") }, text: "已展示 1 个文件给用户", details: shown(join(gitDir, "SCOPE-STATUS.md")) },
      ],
    },
    {
      id: "t2", prompt: "再打开一次对照表", answer: "已经在右侧打开了。",
      calls: [
        { id: "s2", name: "show_files", args: { files: [join(gitDir, "SCOPE-STATUS.md")], open: join(gitDir, "SCOPE-STATUS.md") }, text: "已展示 1 个文件给用户", details: shown(join(gitDir, "SCOPE-STATUS.md")) },
      ],
    },
    {
      id: "t3", prompt: "写一份新的报告文件", answer: "报告已写入 REPORT.md。",
      calls: [{ id: "w3", name: "write", args: { file_path: join(gitDir, "REPORT.md"), content: report }, text: `Successfully wrote to ${join(gitDir, "REPORT.md")}` }],
    },
    {
      id: "t4", prompt: "在已跟踪文件里补一行", answer: "已追加到 tracked.md。",
      calls: [{ id: "w4", name: "write", args: { file_path: join(gitDir, "tracked.md"), content: trackedNext }, text: `Successfully wrote to ${join(gitDir, "tracked.md")}` }],
    },
  ],
});

// ---- non-git cwd: the reported defect ------------------------------------
mkdirSync(plainDir, { recursive: true });
writeFileSync(join(plainDir, "SCOPE-STATUS.md"), plainScope);
const plainSession = "01a20f00-0000-7000-8000-000000000002";
const plainFile = writeSession({
  cwd: plainDir,
  sessionId: plainSession,
  ts: "2026-10-21T17:10:00.000Z",
  turns: [
    {
      id: "t1", prompt: "写一份范围对照并给我看", answer: "对照表已写好。",
      calls: [
        { id: "pw1", name: "write", args: { file_path: join(plainDir, "SCOPE-STATUS.md"), content: plainScope }, text: `Successfully wrote to ${join(plainDir, "SCOPE-STATUS.md")}` },
        { id: "ps1", name: "show_files", args: { files: [join(plainDir, "SCOPE-STATUS.md")], open: join(plainDir, "SCOPE-STATUS.md") }, text: "已展示 1 个文件给用户", details: shown(join(plainDir, "SCOPE-STATUS.md")) },
      ],
    },
  ],
});

console.log(JSON.stringify({ gitSession, gitFile, gitDir, plainSession, plainFile, plainDir }, null, 2));
