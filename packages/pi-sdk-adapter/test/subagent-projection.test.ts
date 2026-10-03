import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isSubagentRefreshEvent,
  nextSubagentProjection,
  readSubagentProjection,
} from "../src/internal/subagent-projection.js";

const parentSessionId = "parent-session-1";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pix-subagent-proj-"));
  const agentDir = join(root, "agent");
  const parentSessionFile = join(agentDir, "sessions", "proj", `2026-01-01T00-00-00-000Z_${parentSessionId}.jsonl`);
  await mkdir(join(agentDir, "sessions", "proj"), { recursive: true, mode: 0o700 });
  await writeFile(parentSessionFile, `${JSON.stringify({ type: "session", version: 3, id: parentSessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/ws" })}\n`);
  return { root, agentDir, parentSessionFile };
}

async function writeTask(agentDir: string, taskId: string, body: Record<string, unknown>) {
  const dir = join(agentDir, "pi-claude-subagents", parentSessionId, taskId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, "task.json"), `${JSON.stringify(body)}\n`, { mode: 0o600 });
  return dir;
}

describe("subagent projection seed and live refresh", () => {
  it("cold-seeds from bounded task.json without a transcript Agent call and resolves a validated child session", async () => {
    const { root, agentDir, parentSessionFile } = await fixture();
    try {
      const childId = "child-session-1";
      const childFile = join(agentDir, "sessions", "proj", `2026-01-01T00-00-01-000Z_${childId}.jsonl`);
      await writeFile(childFile, `${JSON.stringify({
        type: "session",
        version: 3,
        id: childId,
        timestamp: "2026-01-01T00:00:01.000Z",
        cwd: "/ws",
        parentSession: parentSessionFile,
      })}\n`);
      await writeTask(agentDir, "bbbbbbbb", {
        id: "bbbbbbbb",
        parentSessionId,
        agent: "explore",
        description: "later task",
        prompt: "RAW PROMPT MUST NOT LEAK",
        status: "running",
        background: true,
        startedAt: "2026-01-01T00:00:02.000Z",
        sessionFile: childFile,
        preview: "reading",
        usage: { turns: 2, toolCalls: 3, input: 10, output: 4, cacheRead: 0, cacheWrite: 0 },
      });
      await writeTask(agentDir, "aaaaaaaa", {
        id: "aaaaaaaa",
        parentSessionId,
        agent: "general",
        description: "earlier task",
        prompt: "also secret",
        status: "completed",
        startedAt: "2026-01-01T00:00:01.000Z",
        completedAt: "2026-01-01T00:00:09.000Z",
      });
      const tasks = readSubagentProjection({ agentDir, parentSessionId, parentSessionFile });
      assert.deepEqual(tasks.map((task) => task.taskId), ["aaaaaaaa", "bbbbbbbb"]);
      assert.equal(tasks[1]?.childSessionId, childId);
      assert.equal(JSON.stringify(tasks).includes("RAW"), false);
      assert.equal(JSON.stringify(tasks).includes("prompt"), false);
      assert.equal(JSON.stringify(tasks).includes(childFile), false);
      const seeded = nextSubagentProjection(undefined, tasks);
      assert.equal(seeded.projection.revision, 1);
      const same = nextSubagentProjection(seeded.projection, tasks);
      assert.equal(same.changed, false);
      assert.equal(same.projection.revision, 1);
      const appended = nextSubagentProjection(same.projection, tasks, { contentChanged: true });
      assert.equal(appended.changed, true);
      assert.equal(appended.projection.revision, 2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves child identity via a bounded header read even for grown transcripts and rejects bad headers individually", async () => {
    const { root, agentDir, parentSessionFile } = await fixture();
    try {
      const sessionsDir = join(agentDir, "sessions", "proj");
      const headerFor = (id: string, parentSession?: string) => `${JSON.stringify({
        type: "session",
        version: 3,
        id,
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/ws",
        ...(parentSession === undefined ? {} : { parentSession }),
      })}\n`;
      // Grown child transcript: header resolves with a bounded read; the whole
      // file is far larger than the header bound.
      const bigChild = join(sessionsDir, "2026-01-01T00-00-10-000Z_big-child.jsonl");
      await writeFile(bigChild, `${headerFor("big-child", parentSessionFile)}${"x".repeat(256 * 1024)}`);
      // Oversized header line (no newline within the bound).
      const hugeHeader = join(sessionsDir, "2026-01-01T00-00-11-000Z_huge-header.jsonl");
      await writeFile(hugeHeader, `${"h".repeat(65 * 1024)}\n`);
      // Header id fails the session-id vocabulary.
      const badId = join(sessionsDir, "2026-01-01T00-00-12-000Z_bad.jsonl");
      await writeFile(badId, headerFor("../escape/attempt", parentSessionFile));
      // Header parentSession points at a different parent file.
      const wrongParent = join(sessionsDir, "2026-01-01T00-00-13-000Z-wrong.jsonl");
      await writeFile(wrongParent, headerFor("wrong-parent-child", join(sessionsDir, "other.jsonl")));
      // Non-session header.
      const notSession = join(sessionsDir, "2026-01-01T00-00-14-000Z-meta.jsonl");
      await writeFile(notSession, `${JSON.stringify({ type: "meta", id: "meta-child" })}\n`);
      // Symlinked child transcript.
      const linkChild = join(sessionsDir, "2026-01-01T00-00-15-000Z_link.jsonl");
      await symlink(bigChild, linkChild);

      const task = async (taskId: string, sessionFile: string | undefined) => writeTask(agentDir, taskId, {
        id: taskId,
        parentSessionId,
        agent: "explore",
        description: `task ${taskId}`,
        status: "running",
        ...(sessionFile === undefined ? {} : { sessionFile }),
      });
      await task("big", bigChild);
      await task("huge", hugeHeader);
      await task("bad-id", badId);
      await task("wrong-parent", wrongParent);
      await task("meta", notSession);
      await task("link", linkChild);
      await task("none", undefined);

      const tasks = readSubagentProjection({ agentDir, parentSessionId, parentSessionFile });
      const childOf = (taskId: string) => tasks.find((item) => item.taskId === taskId)?.childSessionId;
      assert.equal(tasks.length, 7);
      assert.equal(childOf("big"), "big-child");
      assert.equal(childOf("huge"), undefined);
      assert.equal(childOf("bad-id"), undefined);
      assert.equal(childOf("wrong-parent"), undefined);
      assert.equal(childOf("meta"), undefined);
      assert.equal(childOf("link"), undefined);
      assert.equal(childOf("none"), undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores hostile/malformed/foreign/symlink/oversize entries individually", async () => {
    const { root, agentDir, parentSessionFile } = await fixture();
    try {
      await writeTask(agentDir, "good", {
        id: "good-task",
        parentSessionId,
        agent: "explore",
        description: "keep",
        status: "running",
        startedAt: "2026-01-01T00:00:01.000Z",
        error: "/private/secret/backend-error",
      });
      await writeTask(agentDir, "zz-duplicate", {
        id: "good-task",
        parentSessionId,
        agent: "explore",
        description: "duplicate must be ignored",
        status: "failed",
      });
      await writeTask(agentDir, "foreign", {
        id: "foreign-task",
        parentSessionId: "someone-else",
        agent: "explore",
        description: "nope",
        status: "running",
      });
      await writeTask(agentDir, "bad-status", {
        id: "bad-status",
        parentSessionId,
        agent: "explore",
        description: "nope",
        status: "queued",
      });
      const oversizeDir = join(agentDir, "pi-claude-subagents", parentSessionId, "huge");
      await mkdir(oversizeDir, { recursive: true });
      await writeFile(join(oversizeDir, "task.json"), "x".repeat(65 * 1024));
      const linkDir = join(agentDir, "pi-claude-subagents", parentSessionId, "linky");
      await mkdir(linkDir, { recursive: true });
      await symlink(join(agentDir, "pi-claude-subagents", parentSessionId, "good", "task.json"), join(linkDir, "task.json"));
      const outside = join(root, "outside.jsonl");
      await writeFile(outside, `${JSON.stringify({ type: "session", version: 3, id: "escaped", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/ws", parentSession: parentSessionFile })}\n`);
      await writeTask(agentDir, "escape", {
        id: "escape-task",
        parentSessionId,
        agent: "explore",
        description: "path traversal",
        status: "running",
        sessionFile: join(agentDir, "sessions", "proj", "..", "..", "outside.jsonl"),
      });
      const outsideSessions = join(root, "outside-sessions");
      await mkdir(outsideSessions);
      const ancestorEscape = join(outsideSessions, "ancestor-escape.jsonl");
      await writeFile(ancestorEscape, `${JSON.stringify({ type: "session", version: 3, id: "ancestor-escaped", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/ws", parentSession: parentSessionFile })}\n`);
      await symlink(outsideSessions, join(agentDir, "sessions", "linked-outside"));
      await writeTask(agentDir, "ancestor-escape", {
        id: "ancestor-escape-task",
        parentSessionId,
        agent: "explore",
        description: "symlink ancestor escape",
        status: "running",
        sessionFile: join(agentDir, "sessions", "linked-outside", "ancestor-escape.jsonl"),
      });
      const tasks = readSubagentProjection({ agentDir, parentSessionId, parentSessionFile });
      assert.deepEqual(tasks.map((task) => task.taskId).sort(), ["ancestor-escape-task", "escape-task", "good-task"]);
      assert.equal(tasks.find((task) => task.taskId === "good-task")?.preview, undefined);
      assert.equal(tasks.find((task) => task.taskId === "escape-task")?.childSessionId, undefined);
      assert.equal(tasks.find((task) => task.taskId === "ancestor-escape-task")?.childSessionId, undefined);
      assert.equal(JSON.stringify(tasks).includes("outside"), false);
      assert.equal(JSON.stringify(tasks).includes("private/secret"), false);
      assert.deepEqual(readSubagentProjection({
        agentDir,
        parentSessionId: "../escape",
        parentSessionFile,
      }), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refreshes on every exact subagent tool lifecycle signal so running tasks publish immediately", () => {
    assert.equal(isSubagentRefreshEvent({ type: "tool_execution_start", toolName: "Agent" }), true);
    assert.equal(isSubagentRefreshEvent({ type: "tool_execution_update", toolName: "Agent", partialResult: "working" }), true);
    assert.equal(isSubagentRefreshEvent({ type: "tool_execution_end", toolName: "Agent", isError: true }), true);
    assert.equal(isSubagentRefreshEvent({ type: "tool_execution_update", toolName: "agent" }), false);
  });

  it("refreshes only on exact plugin signals and ignores lookalikes", () => {
    assert.equal(isSubagentRefreshEvent({ type: "tool_execution_end", toolName: "Agent", isError: false }), true);
    assert.equal(isSubagentRefreshEvent({ type: "tool_execution_end", toolName: "TaskOutput", isError: false }), true);
    assert.equal(isSubagentRefreshEvent({ type: "tool_execution_end", toolName: "SendMessage", isError: true }), true);
    assert.equal(isSubagentRefreshEvent({ type: "tool_execution_end", toolName: "agent", isError: false }), false);
    assert.equal(isSubagentRefreshEvent({
      type: "message_start",
      message: { role: "custom", customType: "pi-subagent-started" },
    }), false);
    assert.equal(isSubagentRefreshEvent({
      type: "message_end",
      message: { role: "custom", customType: "pi-subagent-notification" },
    }), true);
    assert.equal(isSubagentRefreshEvent({
      type: "message_end",
      message: { role: "custom", customType: "pi-subagent-notification-batch", details: { items: [] } },
    }), true);
    assert.equal(isSubagentRefreshEvent({
      type: "message_end",
      message: { role: "custom", customType: "pi-subagent-notification-batch-untrusted" },
    }), false);
    assert.equal(isSubagentRefreshEvent({
      type: "message_end",
      message: { role: "custom", customType: "pi-subagent-agent-listing" },
    }), false);
    assert.equal(isSubagentRefreshEvent({ type: "custom_message", customType: "pi-subagent-notification" }), false);
  });
});
