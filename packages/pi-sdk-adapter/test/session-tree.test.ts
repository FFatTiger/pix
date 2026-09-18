// Normalized session branch-tree projection tests (BranchNavigator slice).
//
// Real Pi SDK JSONL on disk (temp session dir) drives the happy paths —
// linear chains, forks, multi-level forks and the persisted current leaf —
// while malformed files (bad entries, unknown parents, duplicate ids, parent
// cycles) are written as raw JSONL exactly like the E2E fixtures, because the
// SDK write path refuses to produce them. Everything runs against the SAME
// read-only store (shared list cache / revision fence) with zero workers.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { isRuntimeError } from "@fffattiger/pix-runtime-core";
import {
  MAX_SESSION_TREE_DEPTH,
  MAX_SESSION_TREE_FRAME,
  MAX_SESSION_TREE_LABEL_LENGTH,
  MAX_SESSION_TREE_NODES,
  MAX_SESSION_TREE_SKIPPED_IDS,
  type SessionTree,
  type SessionTreeNode,
} from "@fffattiger/pix-runtime-core";
import { SessionTreeSchema, MAX_SESSION_TREE_LABEL_LENGTH as PROTOCOL_TREE_LABEL_LENGTH } from "@fffattiger/pix-protocol";
import { createPiSdkSessionStore } from "../src/internal/session-store.js";
import { MAX_PROJECTED_TREE_DEPTH, MAX_TREE_LABEL_LENGTH, projectSessionTree } from "../src/internal/session-tree.js";

const NOW = 1_700_000_000_000;
const TS = (index: number) => new Date(NOW + index).toISOString();

interface Fixture {
  root: string;
  sessionDir: string;
  cwd: string;
}

async function setup(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pix-session-tree-"));
  const sessionDir = join(root, "sessions");
  const cwd = join(root, "project");
  await mkdir(sessionDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  return { root, sessionDir, cwd };
}

function usage() {
  return { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 } };
}

function assistant(text: string, index: number) {
  return {
    role: "assistant" as const,
    stopReason: "stop" as const,
    content: [{ type: "text" as const, text }],
    api: "anthropic",
    provider: "anthropic",
    model: "tree-test",
    usage: usage(),
    timestamp: NOW + index,
  };
}

/** Write a raw JSONL fixture (header + arbitrary entry lines). */
async function writeRaw(fixture: Fixture, sessionId: string, lines: unknown[]): Promise<string> {
  const file = join(fixture.sessionDir, `2026-08-14T00-00-00-000Z_${sessionId}.jsonl`);
  const header = { type: "session", version: 3, id: sessionId, timestamp: TS(0), cwd: fixture.cwd };
  await writeFile(file, [JSON.stringify(header), ...lines.map((line) => JSON.stringify(line))].join("\n") + "\n");
  return file;
}

function messageLine(id: string, parentId: string | null, role: "user" | "assistant", text: string, index: number) {
  const message =
    role === "assistant"
      ? assistant(text, index)
      : { role, content: text, timestamp: NOW + index };
  return { type: "message" as const, id, parentId, timestamp: TS(index), message };
}

describe("session tree projection (real JSONL)", () => {
  it("linear chain: keeps only the branching/leaf node and contracts the chain", async () => {
    const f = await setup();
    try {
      const store = createPiSdkSessionStore({ sessionDir: f.sessionDir });
      const manager = SessionManager.create(f.cwd, f.sessionDir);
      const u1 = manager.appendMessage({ role: "user", content: "first question", timestamp: NOW });
      const a1 = manager.appendMessage(assistant("first answer", 1));
      const u2 = manager.appendMessage({ role: "user", content: "second question", timestamp: NOW + 2 });
      const a2 = manager.appendMessage(assistant("second answer", 3));
      const sessionId = manager.getSessionId();

      const tree = await store.readSessionTree(sessionId);
      assert.equal(tree.sessionId, sessionId);
      assert.equal(tree.entryCount, 4);
      // currentLeafId must equal the leaf a leaf-less context read resolves.
      const context = await store.readSessionContext(sessionId);
      assert.equal(tree.currentLeafId, context.leafId, "tree currentLeafId must converge with the default context leaf");
      // Single root (chain head) with the whole linear chain contracted into
      // the leaf node.
      assert.equal(tree.roots.length, 1);
      const root = tree.roots[0]!;
      assert.equal(root.entryId, u1);
      assert.equal(root.kind, "user");
      assert.equal(root.label, "first question");
      assert.equal(root.truncated, false);
      // The chain (a1, u2) contracts into the kept leaf a2.
      assert.deepEqual(root.children.map((child) => child.entryId), [a2]);
      const leaf = root.children[0]!;
      assert.deepEqual(leaf.skippedEntryIds, [a1, u2], "the whole linear chain contracts into the leaf");
      assert.equal(leaf.kind, "assistant");
      assert.equal(leaf.label, "second answer");
      assert.equal(leaf.children.length, 0);
      // No raw payloads cross the DTO.
      const json = JSON.stringify(tree);
      assert.ok(!json.includes("thinking"));
      assert.ok(!json.includes("toolCall"));
      assert.ok(!json.includes(".jsonl"));
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("fork: branch point carries both children, each branch keeps its own leaf", async () => {
    const f = await setup();
    try {
      const store = createPiSdkSessionStore({ sessionDir: f.sessionDir });
      const manager = SessionManager.create(f.cwd, f.sessionDir);
      const u1 = manager.appendMessage({ role: "user", content: "root question", timestamp: NOW });
      const a1 = manager.appendMessage(assistant("root answer", 1));
      // Branch back to the user entry and append a sibling assistant.
      manager.branch(u1);
      const side = manager.appendMessage(assistant("side answer", 2));
      const sessionId = manager.getSessionId();

      const tree = await store.readSessionTree(sessionId);
      assert.equal(tree.entryCount, 3);
      // The persisted head is the side branch (file-order last entry).
      assert.equal(tree.currentLeafId, side);
      const root = tree.roots[0]!;
      assert.equal(root.entryId, u1);
      assert.equal(root.children.length, 2, "the user entry is a branch point");
      assert.deepEqual(root.children.map((child) => child.entryId), [a1, side], "children render oldest-first");
      assert.deepEqual(root.children.map((child) => child.kind), ["assistant", "assistant"]);
      assert.deepEqual(root.children.map((child) => child.label), ["root answer", "side answer"]);
      // Both leaves resolve inside the tree (selectable without a worker).
      for (const leaf of [a1, side]) {
        const selected = await store.readSessionContext(sessionId, { leafId: leaf });
        assert.equal(selected.leafId, leaf);
      }
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("multi-level fork: nested branch points survive contraction", async () => {
    const f = await setup();
    try {
      const store = createPiSdkSessionStore({ sessionDir: f.sessionDir });
      const manager = SessionManager.create(f.cwd, f.sessionDir);
      const u1 = manager.appendMessage({ role: "user", content: "level0", timestamp: NOW });
      const a1 = manager.appendMessage(assistant("level0 answer", 1));
      const u2 = manager.appendMessage({ role: "user", content: "level1 main", timestamp: NOW + 2 });
      const a2 = manager.appendMessage(assistant("level1 main answer", 3));
      // Side branch at the first assistant entry.
      manager.branch(a1);
      const s1 = manager.appendMessage(assistant("level1 side", 4));
      // Second level: branch again inside the side branch.
      manager.branch(s1);
      const s2 = manager.appendMessage(assistant("level2 side", 5));
      const sessionId = manager.getSessionId();

      const tree = await store.readSessionTree(sessionId);
      assert.equal(tree.entryCount, 6);
      assert.equal(tree.currentLeafId, s2);
      const root = tree.roots[0]!;
      assert.equal(root.entryId, u1);
      // u1's only child a1 is the nested branch point (two children), so the
      // kept shape is root → a1 → [main leaf (u2+a2 contracted), side leaf
      // (s1 contracted under its own nested branch at s1 → s2)].
      assert.equal(root.children.length, 1, "u1 keeps its single chain child as a branch point");
      const branchPoint = root.children[0]!;
      assert.equal(branchPoint.entryId, a1);
      assert.equal(branchPoint.children.length, 2, "a1 is a two-way branch point");
      const mainLeaf = branchPoint.children[0]!;
      assert.equal(mainLeaf.entryId, a2);
      assert.deepEqual(mainLeaf.skippedEntryIds, [u2]);
      const sideLeaf = branchPoint.children[1]!;
      assert.equal(sideLeaf.entryId, s2);
      assert.deepEqual(sideLeaf.skippedEntryIds, [s1], "the nested side branch keeps its own contraction");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("labels: text-only previews are capped at 40 units, thinking/tool/secret never leak", async () => {
    const f = await setup();
    try {
      const store = createPiSdkSessionStore({ sessionDir: f.sessionDir });
      const long = "x".repeat(120);
      const manager = SessionManager.create(f.cwd, f.sessionDir);
      manager.appendMessage({ role: "user", content: long, timestamp: NOW });
      const assistantEntry = manager.appendMessage({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "secret internal reasoning sk-abcdef123456" },
          { type: "text", text: `public answer api_key=super-secret-value` },
          { type: "toolCall", id: "call-1", name: "search", arguments: { q: "raw tool input" } },
        ],
        api: "anthropic",
        provider: "anthropic",
        model: "tree-test",
        usage: usage(),
        stopReason: "toolUse",
        timestamp: NOW + 1,
      });
      manager.appendMessage({
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "search",
        content: [{ type: "text", text: "raw tool result output" }],
        isError: false,
        timestamp: NOW + 2,
      });
      // Branch at the assistant so it becomes a branch point with a bash leaf
      // sibling — the assistant, tool result and bash are ALL kept nodes.
      manager.branch(assistantEntry);
      manager.appendMessage({
        role: "bashExecution",
        command: "echo raw-bash-command",
        output: "raw bash output",
        exitCode: 0,
        cancelled: false,
        truncated: false,
        timestamp: NOW + 3,
      });
      const sessionId = manager.getSessionId();

      const tree = await store.readSessionTree(sessionId);
      const json = JSON.stringify(tree);
      // The user preview is capped and marked truncated.
      const userNode = tree.roots[0]!;
      assert.equal(userNode.label.length, MAX_TREE_LABEL_LENGTH);
      assert.equal(userNode.truncated, true);
      // The assistant is a branch point: its preview comes ONLY from the text
      // block (never thinking), with secret-looking values redacted.
      const assistantNode = userNode.children[0]!;
      assert.equal(assistantNode.children.length, 2, "assistant keeps tool + bash leaves");
      assert.ok(assistantNode.label.includes("public answer"), assistantNode.label);
      assert.ok(assistantNode.label.includes("[REDACTED]"), "secret-looking values must be redacted");
      assert.ok(!assistantNode.label.includes("sk-abcdef123456"));
      assert.ok(!assistantNode.label.includes("internal reasoning"));
      // Tool results and bash carry fixed placeholders, never raw payloads.
      const toolNode = assistantNode.children[0]!;
      assert.equal(toolNode.kind, "toolResult");
      assert.equal(toolNode.label, "[tool result]");
      const bashNode = assistantNode.children[1]!;
      assert.equal(bashNode.kind, "bashExecution");
      assert.equal(bashNode.label, "[bash]");
      // Global: no raw thinking/tool/bash payloads anywhere in the DTO.
      assert.ok(!json.includes("raw tool input"));
      assert.ok(!json.includes("raw tool result output"));
      assert.ok(!json.includes("raw-bash-command"));
      assert.ok(!json.includes("raw bash output"));
      assert.ok(!json.includes("secret internal reasoning"));
      assert.ok(!json.includes("super-secret-value"));
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("empty session (header-only JSONL): no roots, no currentLeafId, zero-entry count", async () => {
    const f = await setup();
    try {
      // The SDK writes no file until an assistant message exists, so a
      // header-only file is written raw (the same shape the E2E uses).
      const sessionId = "tree-empty";
      await writeRaw(f, sessionId, []);
      const store = createPiSdkSessionStore({ sessionDir: f.sessionDir });
      const tree = await store.readSessionTree(sessionId);
      assert.deepEqual(tree.roots, []);
      assert.equal(tree.currentLeafId, undefined);
      assert.equal(tree.entryCount, 0);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("missing session fails closed with not_found (no fabrication)", async () => {
    const f = await setup();
    try {
      const store = createPiSdkSessionStore({ sessionDir: f.sessionDir });
      await assert.rejects(() => store.readSessionTree("no-such-session-id"), (error: unknown) => {
        assert.ok(isRuntimeError(error));
        assert.equal((error as { code: string }).code, "not_found");
        return true;
      });
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});

describe("session tree projection (malformed raw JSONL)", () => {
  it("bad entries are skipped without breaking the rest of the tree", async () => {
    const f = await setup();
    try {
      const sessionId = "tree-bad-entries";
      await writeRaw(f, sessionId, [
        "not-json-object",
        messageLine("e1", null, "user", "good root", 1),
        { type: "message", id: "", parentId: null, timestamp: TS(2), message: { role: "user", content: "empty id", timestamp: NOW + 2 } },
        messageLine("e2", "e1", "assistant", "good child", 3),
      ]);
      const store = createPiSdkSessionStore({ sessionDir: f.sessionDir });
      const tree = await store.readSessionTree(sessionId);
      assert.equal(tree.entryCount, 2);
      assert.equal(tree.roots[0]!.entryId, "e1");
      assert.equal(tree.currentLeafId, "e2");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("unknown parent promotes the orphan to a root (never dropped)", async () => {
    const f = await setup();
    try {
      const sessionId = "tree-orphan";
      await writeRaw(f, sessionId, [
        messageLine("e1", null, "user", "root", 1),
        messageLine("orphan", "ghost-parent", "assistant", "orphaned", 2),
      ]);
      const store = createPiSdkSessionStore({ sessionDir: f.sessionDir });
      const tree = await store.readSessionTree(sessionId);
      assert.equal(tree.entryCount, 2);
      assert.deepEqual(tree.roots.map((node) => node.entryId), ["e1", "orphan"]);
      assert.equal(tree.currentLeafId, "orphan");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("duplicate ids keep the FIRST occurrence and re-parent later children deterministically", async () => {
    const f = await setup();
    try {
      const sessionId = "tree-duplicate";
      await writeRaw(f, sessionId, [
        messageLine("e1", null, "user", "first occurrence", 1),
        messageLine("e2", "e1", "assistant", "child of first", 2),
        messageLine("e1", null, "user", "duplicate occurrence", 3),
        messageLine("e3", "e1", "assistant", "child of deduped id", 4),
      ]);
      const store = createPiSdkSessionStore({ sessionDir: f.sessionDir });
      const tree = await store.readSessionTree(sessionId);
      // The duplicate entry is dropped; e1 keeps the first occurrence's label
      // and gains both children as a branch point.
      assert.equal(tree.entryCount, 3);
      assert.equal(tree.roots.length, 1);
      const root = tree.roots[0]!;
      assert.equal(root.label, "first occurrence");
      assert.deepEqual(root.children.map((child) => child.entryId), ["e2", "e3"]);
      // currentLeafId resolves to the last file entry (e3, appended after the dup).
      assert.equal(tree.currentLeafId, "e3");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("parent cycles are unreachable: they never appear and never hang the projection", async () => {
    const f = await setup();
    try {
      const sessionId = "tree-cycle";
      await writeRaw(f, sessionId, [
        messageLine("e1", null, "user", "root", 1),
        messageLine("c1", "c2", "assistant", "cycle a", 2),
        messageLine("c2", "c1", "assistant", "cycle b", 3),
      ]);
      const store = createPiSdkSessionStore({ sessionDir: f.sessionDir });
      const tree = await store.readSessionTree(sessionId);
      // The cycle component is not reachable from a root: excluded everywhere
      // (including currentLeafId — the leaf never resolves through a cycle).
      assert.equal(tree.entryCount, 1);
      assert.deepEqual(tree.roots.map((node) => node.entryId), ["e1"]);
      assert.equal(tree.currentLeafId, undefined);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("self-parent entries surface as roots (bounded, no self-cycle)", async () => {
    const f = await setup();
    try {
      const sessionId = "tree-self-parent";
      await writeRaw(f, sessionId, [
        messageLine("e1", null, "user", "root", 1),
        messageLine("self", "self", "assistant", "self parent", 2),
      ]);
      const store = createPiSdkSessionStore({ sessionDir: f.sessionDir });
      const tree = await store.readSessionTree(sessionId);
      assert.equal(tree.entryCount, 2);
      assert.deepEqual(tree.roots.map((node) => node.entryId), ["e1", "self"]);
      assert.equal(tree.currentLeafId, "self");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});

describe("session tree cache sharing (injected SDK)", () => {
  it("readSessionTree reuses the shared list cache — one listAll for list+tree+tree", async () => {
    const f = await setup();
    try {
      let listAllCalls = 0;
      let entriesReads = 0;
      const info = {
        path: join(f.sessionDir, "cached.jsonl"),
        id: "cached",
        cwd: f.cwd,
        created: new Date(NOW),
        modified: new Date(NOW + 1),
        messageCount: 2,
        firstMessage: "hi",
        allMessagesText: "hi",
      };
      const surface = {
        listAll: async () => {
          listAllCalls += 1;
          return [info];
        },
        open: () => ({
          getEntries: () => {
            entriesReads += 1;
            return [messageLine("e1", null, "user", "q", 1), messageLine("e2", "e1", "assistant", "a", 2)];
          },
          getBranch: () => [],
          buildContextEntries: () => [],
          getLeafId: () => "e2",
          getEntry: (id: string) => (id === "e2" ? ({ type: "message", id, parentId: "e1", timestamp: TS(2), message: { role: "assistant", content: "a", timestamp: NOW + 2 } } as never) : undefined),
          getSessionId: () => "cached",
          getHeader: () => undefined,
          appendSessionInfo: () => "",
        }),
      };
      const store = createPiSdkSessionStore({ sessionDir: f.sessionDir, sdk: surface });
      await store.listSessions();
      const tree1 = await store.readSessionTree("cached");
      const tree2 = await store.readSessionTree("cached");
      assert.equal(listAllCalls, 1, "tree reads must share the list cache (no second scan)");
      assert.equal(entriesReads, 2, "each tree read opens the manager once (same as read/context)");
      assert.deepEqual(tree1, tree2);
      assert.equal(tree1.currentLeafId, "e2");
      // Stale/reused path fails closed: a wrong session id never resolves.
      await assert.rejects(() => store.readSessionTree("other"), (error: unknown) => {
        assert.equal((error as { code: string }).code, "not_found");
        return true;
      });
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("currentLeafId that does not resolve to a reachable entry is omitted (never fabricated)", async () => {
    const tree = projectSessionTree("s", [messageLine("e1", null, "user", "q", 1)], "ghost-leaf");
    assert.equal(tree.currentLeafId, undefined);
    assert.equal(tree.entryCount, 1);
  });

  it("depth-cap flattening preserves canonical oldest-first DFS order", () => {
    const entries: unknown[] = [messageLine("n0", null, "user", "root", 0)];
    for (let index = 1; index <= MAX_PROJECTED_TREE_DEPTH + 2; index += 1) {
      entries.push(messageLine(`n${index}`, `n${index - 1}`, "assistant", `main ${index}`, index * 2));
      entries.push(messageLine(`s${index}`, `n${index - 1}`, "assistant", `side ${index}`, index * 2 + 1));
    }

    const tree = projectSessionTree("deep", entries, `n${MAX_PROJECTED_TREE_DEPTH + 2}`);
    let ancestor = tree.roots[0]!;
    for (let depth = 1; depth < MAX_PROJECTED_TREE_DEPTH; depth += 1) {
      ancestor = ancestor.children.find((child) => child.entryId === `n${depth}`)!;
    }
    assert.deepEqual(
      ancestor.children.map((child) => child.entryId),
      [
        `n${MAX_PROJECTED_TREE_DEPTH}`,
        `n${MAX_PROJECTED_TREE_DEPTH + 1}`,
        `n${MAX_PROJECTED_TREE_DEPTH + 2}`,
        `s${MAX_PROJECTED_TREE_DEPTH + 2}`,
        `s${MAX_PROJECTED_TREE_DEPTH + 1}`,
        `s${MAX_PROJECTED_TREE_DEPTH}`,
      ],
    );
  });

  it("structural entries map to the system kind with fixed labels", async () => {
    const f = await setup();
    try {
      // An assistant message must exist before the SDK persists the file
      // (no-assistant guard), then branch back so the model change becomes a
      // visible leaf with its own sibling.
      const manager = SessionManager.create(f.cwd, f.sessionDir);
      const u1 = manager.appendMessage({ role: "user", content: "q", timestamp: NOW });
      manager.appendMessage(assistant("a", 1));
      manager.branch(u1);
      const m1 = manager.appendModelChange("anthropic", "model-x");
      const sessionId = manager.getSessionId();
      const store = createPiSdkSessionStore({ sessionDir: f.sessionDir });
      const tree = await store.readSessionTree(sessionId);
      assert.equal(tree.entryCount, 3);
      const root = tree.roots[0]!;
      assert.equal(root.entryId, u1);
      assert.equal(root.children.length, 2, "assistant leaf + model-change leaf");
      const modelNode = root.children[1]!;
      assert.equal(modelNode.entryId, m1);
      assert.equal(modelNode.kind, "system");
      assert.equal(modelNode.label, "model change");
      // Fixed labels for other structural kinds never echo raw payloads.
      const structural = projectSessionTree("s", [
        messageLine("e1", null, "user", "q", 1),
        { type: "model_change", id: "m1", parentId: "e1", timestamp: TS(2), provider: "anthropic", modelId: "model-x" },
        { type: "compaction", id: "k1", parentId: "m1", timestamp: TS(3), summary: "secret summary", firstKeptEntryId: "e1", tokensBefore: 5 },
      ], "k1");
      // model_change is contracted into the kept compaction leaf; labels are
      // fixed and never echo the summary text.
      const compactionNode = structural.roots[0]!.children[0]!;
      assert.equal(compactionNode.label, "compaction");
      assert.deepEqual(compactionNode.skippedEntryIds, ["m1"]);
      assert.ok(!JSON.stringify(structural).includes("secret summary"));
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Persisted-history hardening + bounded tree wire contract
// ---------------------------------------------------------------------------

/** Assert the parent graph stays coherent: every parentEntryId resolves to a
 *  kept ancestor or the LAST element of the node's own skippedEntryIds. */
function assertParentCoherence(nodes: readonly SessionTreeNode[]): void {
  const visit = (list: readonly SessionTreeNode[], ancestors: readonly SessionTreeNode[]): void => {
    for (const node of list) {
      if (node.parentEntryId !== undefined) {
        const chain = node.skippedEntryIds ?? [];
        const keptAncestor = ancestors.some((a) => a.entryId === node.parentEntryId);
        const chainTail = chain.length > 0 && chain[chain.length - 1] === node.parentEntryId;
        assert.ok(
          keptAncestor || chainTail,
          `parentEntryId ${node.parentEntryId} of ${node.entryId} must be a kept ancestor or its own skipped-chain tail`,
        );
      }
      visit(node.children, [...ancestors, node]);
    }
  };
  visit(nodes, []);
}

/** Walk every node (entryId + skippedEntryIds) and assert the id resolves in the tree. */
function assertResolves(roots: readonly SessionTreeNode[], id: string): void {
  const stack = [...roots];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (seen.has(node.entryId)) continue;
    seen.add(node.entryId);
    if (node.entryId === id || node.skippedEntryIds?.includes(id)) return;
    stack.push(...node.children);
  }
  assert.fail(`id ${id} is not addressable in the projected tree`);
}

describe("persisted history leaf + cursor validation (real store)", () => {
  it("unknown/nonmember leafId fails closed with canonical invalid_input (no permissive SDK fallback)", async () => {
    const f = await setup();
    try {
      const store = createPiSdkSessionStore({ sessionDir: f.sessionDir });
      const manager = SessionManager.create(f.cwd, f.sessionDir);
      manager.appendMessage({ role: "user", content: "root", timestamp: NOW });
      const tail = manager.appendMessage(assistant("answer", 1));
      const sessionId = manager.getSessionId();

      // A member leaf still resolves (sanity) — the branch is the real one.
      const ok = await store.readSessionContext(sessionId, { leafId: tail });
      assert.equal(ok.leafId, tail);

      // A caller-supplied leaf that is not a member of THIS session must fail
      // closed with the SAME canonical invalid_input as an invalid cursor —
      // never the SDK's `leaf ??= last-entry` fallback (which would relabel
      // the head branch as the bogus leaf). The raw id is never echoed.
      for (const bogus of ["bogus-leaf", "ghost", "entry-from-another-session"]) {
        await assert.rejects(
          () => store.readSessionContext(sessionId, { leafId: bogus }),
          (error: unknown) => {
            assert.ok(isRuntimeError(error));
            if (!isRuntimeError(error)) return false;
            assert.equal(error.code, "invalid_input");
            assert.ok(!JSON.stringify(error).includes(bogus), "raw leaf id must never leak");
            return true;
          },
        );
      }
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("cross-branch before cursor fails closed with invalid_input (never paginates another branch)", async () => {
    const f = await setup();
    try {
      const store = createPiSdkSessionStore({ sessionDir: f.sessionDir });
      const manager = SessionManager.create(f.cwd, f.sessionDir);
      const u1 = manager.appendMessage({ role: "user", content: "root", timestamp: NOW });
      const main = manager.appendMessage(assistant("main answer", 1));
      manager.branch(u1);
      const side = manager.appendMessage(assistant("side answer", 2));
      const sessionId = manager.getSessionId();

      // Selecting the main branch and asking for a cursor that lives on the
      // SIDE branch is an invalid cursor for that selection — fail closed.
      await assert.rejects(
        () => store.readSessionContext(sessionId, { leafId: main, before: side }),
        (error: unknown) => isRuntimeError(error) && (error as { code: string }).code === "invalid_input",
      );
      // And the reverse selection.
      await assert.rejects(
        () => store.readSessionContext(sessionId, { leafId: side, before: main }),
        (error: unknown) => isRuntimeError(error) && (error as { code: string }).code === "invalid_input",
      );
      // A cursor on the SAME selected branch still paginates (never rejects).
      const ok = await store.readSessionContext(sessionId, { leafId: side, before: u1 });
      assert.equal(ok.leafId, side);
      assert.equal(ok.entries.some((entry) => entry.entryId === side), false, "cursor is exclusive");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});

describe("bounded session tree wire contract (very large sessions)", () => {
  /** Build a real 50k-entry linear JSONL session (written raw for speed). */
  async function writeLinear(f: Fixture, sessionId: string, count: number): Promise<void> {
    const header = { type: "session", version: 3, id: sessionId, timestamp: TS(0), cwd: f.cwd };
    const lines = [JSON.stringify(header)];
    for (let index = 1; index <= count; index += 1) {
      const role = index % 2 === 1 ? "user" : "assistant";
      const entry = role === "user"
        ? { type: "message" as const, id: `e${index}`, parentId: index === 1 ? null : `e${index - 1}`, timestamp: TS(index), message: { role, content: `q${index}`, timestamp: NOW + index } }
        : { type: "message" as const, id: `e${index}`, parentId: `e${index - 1}`, timestamp: TS(index), message: { role, stopReason: "stop", content: [{ type: "text", text: `a${index}` }], api: "anthropic", provider: "anthropic", model: "m", usage: usage(), timestamp: NOW + index } };
      lines.push(JSON.stringify(entry));
    }
    await writeFile(join(f.sessionDir, `2026-08-14T00-00-00-000Z_${sessionId}.jsonl`), lines.join("\n") + "\n");
  }

  it("50k linear tree: bounded with explicit truncation, leaf + parent graph coherent", async () => {
    const f = await setup();
    try {
      const sessionId = "linear-50k";
      await writeLinear(f, sessionId, 50_000);
      const store = createPiSdkSessionStore({ sessionDir: f.sessionDir });
      const tree = await store.readSessionTree(sessionId);

      // The FULL session is still counted; the projection is explicitly bounded.
      assert.equal(tree.entryCount, 50_000);
      assert.equal(tree.currentLeafId, "e50000", "current leaf stays addressable in the bounded tree");
      assert.ok(tree.pageInfo, "a bounded tree must carry explicit pageInfo (never silent omission)");
      assert.equal(tree.pageInfo!.truncated, true);
      assert.ok(tree.pageInfo!.nodeCount <= MAX_SESSION_TREE_NODES);
      assert.ok(tree.pageInfo!.skippedIdCount <= MAX_SESSION_TREE_SKIPPED_IDS);
      assert.equal(tree.pageInfo!.frameCount, tree.pageInfo!.nodeCount + tree.pageInfo!.skippedIdCount);
      assert.ok(tree.pageInfo!.frameCount <= MAX_SESSION_TREE_FRAME);

      // The leaf carrier keeps the TAIL of the contracted chain (ids nearest
      // the leaf), so parentEntryId stays inside its own skippedEntryIds.
      const root = tree.roots[0]!;
      const leaf = root.children[0]!;
      assert.equal(leaf.entryId, "e50000");
      assert.equal(leaf.skippedEntryIds!.length, MAX_SESSION_TREE_SKIPPED_IDS, "contracted chain is tail-truncated to the skipped-id budget");
      assert.equal(leaf.parentEntryId, leaf.skippedEntryIds![leaf.skippedEntryIds!.length - 1], "parentEntryId resolves to the chain tail");

      // Budgets + coherence + protocol wire validity.
      assertParentCoherence(tree.roots);
      assertResolves(tree.roots, tree.currentLeafId!);
      assert.doesNotThrow(() => SessionTreeSchema.parse(tree), "bounded tree must parse under the protocol SessionTreeSchema");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("wide tree over the node budget: leaf path reserved, truncation explicit, parents coherent", () => {
    // One root, 1300 branch children (each a linear chain to a leaf). The
    // node budget (1000) binds; the current leaf's path must survive.
    const entries: unknown[] = [messageLine("root", null, "user", "root", 0)];
    for (let index = 1; index <= 1300; index += 1) {
      entries.push(messageLine(`m${index}`, "root", "assistant", `mid ${index}`, index * 2));
      entries.push(messageLine(`l${index}`, `m${index}`, "user", `leaf ${index}`, index * 2 + 1));
    }
    const tree = projectSessionTree("wide", entries, "l1300");
    assert.equal(tree.entryCount, 2601);
    assert.ok(tree.pageInfo, "node budget hit → explicit truncation");
    assert.equal(tree.pageInfo!.truncated, true);
    assert.equal(tree.currentLeafId, "l1300", "current leaf (deepest file-order leaf) stays addressable");
    assert.ok(tree.pageInfo!.nodeCount <= MAX_SESSION_TREE_NODES);
    assert.ok(tree.pageInfo!.frameCount <= MAX_SESSION_TREE_FRAME);
    assertResolves(tree.roots, tree.currentLeafId!);
    assertParentCoherence(tree.roots);
    assert.doesNotThrow(() => SessionTreeSchema.parse(tree));
  });

  it("non-truncated trees carry no pageInfo and stay byte-stable", () => {
    const tree = projectSessionTree("small", [messageLine("e1", null, "user", "q", 1), messageLine("e2", "e1", "assistant", "a", 2)], "e2");
    assert.equal(tree.pageInfo, undefined);
    assert.equal(tree.entryCount, 2);
    assertParentCoherence(tree.roots);
    assert.doesNotThrow(() => SessionTreeSchema.parse(tree));
  });

  it("deep branch tree over the depth cap: leaf path reserved, tree shallow, parents coherent", () => {
    // One root, 220 sequential branch points on the current-leaf path (each
    // with a side leaf), then a short contracted chain to the leaf. The depth
    // cap (200 kept nodes) binds structurally; the reserved leaf path and the
    // flattened side branches must all keep a coherent parent graph.
    const entries: unknown[] = [messageLine("root", null, "user", "root", 0)];
    let parent = "root";
    let index = 1;
    for (let depth = 1; depth <= 220; depth += 1) {
      const id = `b${depth}`;
      entries.push(messageLine(id, parent, "assistant", `branch ${depth}`, index++));
      entries.push(messageLine(`s${depth}`, id, "user", `side ${depth}`, index++));
      parent = id;
    }
    entries.push(messageLine("n1", parent, "user", "chain n1", index++));
    entries.push(messageLine("n2", "n1", "assistant", "chain n2", index++));
    entries.push(messageLine("leaf", "n2", "user", "the leaf", index));

    const tree = projectSessionTree("deep", entries, "leaf");
    assert.equal(tree.currentLeafId, "leaf", "reserved leaf stays addressable beyond the depth cap");
    assert.equal(tree.pageInfo, undefined, "depth-cap flatten is structural, not a budget truncation");
    assertResolves(tree.roots, tree.currentLeafId!);
    assertParentCoherence(tree.roots);
    // The projection stays shallow for recursive renderers: the deepest NESTED
    // kept node is at the cap, and flattened descendants are its direct
    // children (one level deeper — the established depth-cap overlay, pinned
    // by the oldest-first order test above).
    const maxDepth = (() => {
      let max = 0;
      const walk = (list: readonly SessionTreeNode[], depth: number): void => {
        for (const node of list) {
          max = Math.max(max, depth);
          walk(node.children, depth + 1);
        }
      };
      walk(tree.roots, 1);
      return max;
    })();
    assert.ok(maxDepth <= MAX_SESSION_TREE_DEPTH + 1, `projected depth ${maxDepth} must stay within the cap overlay`);
    assert.doesNotThrow(() => SessionTreeSchema.parse(tree));
  });

  it("skipped-id budget exhausted with node budget room: no dangling parentEntryId", () => {
    // Reserve the current-leaf path first (9-id chain + leaf), then fill the
    // skipped-id budget with 833 side branches (6-deep chains each). The last
    // side branch's chain is entirely lost to the budget while its kept leaf
    // still fits the node budget — parentEntryId must be re-anchored, never
    // dangling.
    const entries: unknown[] = [messageLine("root", null, "user", "root", 0)];
    let index = 1;
    let parent = "root";
    for (let j = 0; j < 9; j += 1) {
      const id = `mc${j}`;
      entries.push(messageLine(id, parent, "user", `mc ${j}`, index++));
      parent = id;
    }
    entries.push(messageLine("X", parent, "assistant", "main leaf", index++));
    for (let i = 1; i <= 833; i += 1) {
      let side = "root";
      for (let j = 0; j < 6; j += 1) {
        const id = `s${i}c${j}`;
        entries.push(messageLine(id, side, "user", `s ${i}-${j}`, index++));
        side = id;
      }
      entries.push(messageLine(`s${i}`, side, "assistant", `side leaf ${i}`, index++));
    }

    const tree = projectSessionTree("budget-exhausted", entries, "X");
    assert.equal(tree.currentLeafId, "X");
    assert.ok(tree.pageInfo, "skipped-id budget exhausted → explicit truncation");
    assert.equal(tree.pageInfo!.truncated, true);
    assert.equal(tree.pageInfo!.skippedIdCount, MAX_SESSION_TREE_SKIPPED_IDS, "skipped-id budget is exactly exhausted");
    assert.ok(tree.pageInfo!.nodeCount <= MAX_SESSION_TREE_NODES);
    assert.ok(tree.pageInfo!.frameCount <= MAX_SESSION_TREE_FRAME);
    assertResolves(tree.roots, tree.currentLeafId!);
    assertParentCoherence(tree.roots);
    assert.doesNotThrow(() => SessionTreeSchema.parse(tree));
  });
});

describe("session tree vocabulary/limits parity (runtime-core authority ↔ protocol wire)", () => {
  it("protocol mirrors the runtime-core tree vocabulary exactly", () => {
    // The protocol wire schema must stay in lock-step with the single domain
    // authority in runtime-core. Protocol cannot import runtime-core, so this
    // adapter-side parity test pins both sides to the same numbers.
    assert.equal(PROTOCOL_TREE_LABEL_LENGTH, MAX_SESSION_TREE_LABEL_LENGTH);
    // The remaining wire mirrors are exported from protocol and pinned below
    // via the schema's acceptance behavior (the caps are enforced by this
    // projector against the runtime-core constants).
    assert.equal(MAX_TREE_LABEL_LENGTH, MAX_SESSION_TREE_LABEL_LENGTH, "adapter aliases resolve to the runtime-core authority");
    assert.equal(MAX_PROJECTED_TREE_DEPTH, MAX_SESSION_TREE_DEPTH, "depth cap is the runtime-core authority");
  });

  it("a fully-truncated real projection parses under the protocol SessionTreeSchema", async () => {
    const f = await setup();
    try {
      const sessionId = "parity-50k";
      await (async () => {
        const header = { type: "session", version: 3, id: sessionId, timestamp: TS(0), cwd: f.cwd };
        const lines = [JSON.stringify(header)];
        for (let index = 1; index <= 50_000; index += 1) {
          lines.push(JSON.stringify({ type: "message", id: `e${index}`, parentId: index === 1 ? null : `e${index - 1}`, timestamp: TS(index), message: { role: "user", content: `q${index}`, timestamp: NOW + index } }));
        }
        await writeFile(join(f.sessionDir, `2026-08-14T00-00-00-000Z_${sessionId}.jsonl`), lines.join("\n") + "\n");
      })();
      const store = createPiSdkSessionStore({ sessionDir: f.sessionDir });
      const tree = await store.readSessionTree(sessionId);
      assert.ok(tree.pageInfo?.truncated, "expected a truncated tree");
      // sessiond releases tree RPC results through SessionTreeSchema.parse;
      // the produced tree must satisfy the wire contract as-is.
      const parsed = SessionTreeSchema.parse(tree);
      assert.equal(parsed.sessionId, sessionId);
      assert.equal(parsed.pageInfo?.frameCount, parsed.pageInfo?.nodeCount! + parsed.pageInfo?.skippedIdCount!);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});
