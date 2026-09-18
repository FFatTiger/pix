// Test/E2E-only Pi SDK JSONL seeding helpers (D1A-2 phase 2).
//
// This is the SINGLE place outside the read-only sessions surface that touches
// the Pi SDK SessionManager write path. It lives under src/internal (the only
// dir allowed to import the Pi SDK) so E2E/integration tests can seed real JSONL
// into a temp PI_CODING_AGENT_DIR WITHOUT importing @earendil-works/pi-coding-
// agent directly (which the architecture gate forbids outside this package).
// Exposed via the `@fffattiger/pix-pi-sdk-adapter/testing` subpath; never
// imported by production runtime code.
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { statSync } from "node:fs";

export interface SeedSessionOptions {
  /** Canonical working directory recorded for the session (must exist). */
  cwd: string;
  userText?: string;
  assistantText?: string;
  /** Optional persisted thinking block used by deferred-history integration tests. */
  assistantThinking?: string;
  /** Optional base64 tool-result image used by bounded-history integration tests. */
  toolResultImage?: { data: string; mimeType: string };
}

export interface SeededSession {
  sessionId: string;
  assistantEntryId: string;
}

/**
 * Create a session with a user + assistant turn and flush it to JSONL on disk.
 * The session lands in the SDK default session directory (respecting
 * PI_CODING_AGENT_DIR), so the read-only catalog/locator can list/read/locate it.
 */
export function seedSessionForTests(options: SeedSessionOptions): SeededSession {
  const manager = SessionManager.create(options.cwd);
  const now = Date.now();
  manager.appendMessage({ role: "user", content: options.userText ?? "hello history", timestamp: now });
  const assistantEntryId = manager.appendMessage({
    role: "assistant",
    content: [
      ...(options.assistantThinking === undefined
        ? []
        : [{ type: "thinking" as const, thinking: options.assistantThinking }]),
      { type: "text", text: options.assistantText ?? "history reply" },
    ],
    api: "anthropic",
    provider: "anthropic",
    model: "e2e-model",
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 } },
    stopReason: options.toolResultImage === undefined ? "stop" : "toolUse",
    timestamp: now + 1,
  });
  if (options.toolResultImage !== undefined) {
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "history-test-tool-call",
      toolName: "screenshot",
      content: [{ type: "image", data: options.toolResultImage.data, mimeType: options.toolResultImage.mimeType }],
      isError: false,
      timestamp: now + 2,
    });
  }
  return { sessionId: manager.getSessionId(), assistantEntryId };
}

/** List session ids visible to the default read-only catalog (for sanity checks). */
export async function listSeededSessionIdsForTests(): Promise<string[]> {
  const sessions = await SessionManager.listAll();
  return sessions.map((session) => session.id);
}

// ---------------------------------------------------------------------------
// Configurable history seeding (lifecycle-reassessment LC-00 layer 2).
//
// Grows a REAL SDK JSONL session to a caller-chosen shape (short, ~1k-message,
// tool-dense, compacted) so real-SDK lifecycle E2Es can drive long-history
// admission/model-request/terminal behavior without touching user sessions.
// Same write-path authority as seedSessionForTests (SessionManager only).
// ---------------------------------------------------------------------------

export interface SeedHistoryModel {
  /** Provider id recorded on assistant messages (must exist in models.json for restore). */
  provider: string;
  /** Model id recorded on assistant messages. */
  modelId: string;
}

export interface SeedHistoryOptions {
  /** Canonical working directory recorded for the session (must exist). */
  cwd: string;
  /** user→assistant turns appended to the trunk (default 1). */
  turns?: number;
  /** Add a toolCall (stopReason toolUse) + toolResult + final assistant text in every turn. */
  toolDense?: boolean;
  /** After the bulk, append a compaction entry keeping only the last `keptTurns` turns. */
  compact?: { summary: string; keptTurns?: number };
  /** Provider/model stamped on assistant messages (continuation restore target). */
  model?: SeedHistoryModel;
  /** Text prefix so suites can recognize their own corpus (never user content). */
  label?: string;
  /** Repeat synthetic user/tool text to grow JSONL bytes independently of turn count. */
  padBytes?: number;
}

export interface SeededHistory {
  sessionId: string;
  /** Total SessionManager entries persisted on the trunk branch. */
  entryCount: number;
  /** Total messages appended (user + assistant + toolResult). */
  messageCount: number;
  /** File size of the persisted JSONL in bytes. */
  jsonlBytes: number;
  /** Id of the user entry that starts the post-compaction kept window (if compacted). */
  firstKeptEntryId?: string;
  /** True when the trunk branch contains ≥1 message entry (SDK "continuation"). */
  hasContinuation: boolean;
  /** Exact first/last user texts (for provider hash checks; never user content). */
  firstUserText: string;
  lastUserText: string;
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

/**
 * Seed one session whose trunk carries `turns` user→assistant turns, optional
 * tool-dense blocks, and an optional SDK compaction entry, all flushed to disk.
 * Timestamps strictly increase so ordering is deterministic.
 */
export function seedSessionHistoryForTests(options: SeedHistoryOptions): SeededHistory {
  const manager = SessionManager.create(options.cwd);
  const provider = options.model?.provider ?? "anthropic";
  const modelId = options.model?.modelId ?? "e2e-model";
  const label = options.label ?? "seed-history";
  const turns = Math.max(1, options.turns ?? 1);
  const padBytes = Math.max(0, options.padBytes ?? 0);
  const padChunk = padBytes > 0 ? "x".repeat(Math.ceil(padBytes / turns)) : "";
  let messageCount = 0;
  let timestamp = Date.now() - turns * 1_000;
  const userEntryIds: string[] = [];
  const usage = (output: number) => ({
    input: 12,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 12 + output,
    cost: ZERO_COST,
  });
  for (let index = 1; index <= turns; index += 1) {
    const turn = String(index).padStart(4, "0");
    userEntryIds.push(manager.appendMessage({
      role: "user",
      content: `${label} q${turn}${padChunk}`,
      timestamp: (timestamp += 1),
    }));
    messageCount += 1;
    if (options.toolDense) {
      manager.appendMessage({
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: `${label}-call-${turn}`,
            name: "read",
            arguments: { path: `/tmp/${label}/${turn}.txt` },
          },
        ],
        api: "openai-completions",
        provider,
        model: modelId,
        usage: usage(4),
        stopReason: "toolUse",
        timestamp: (timestamp += 1),
      });
      manager.appendMessage({
        role: "toolResult",
        toolCallId: `${label}-call-${turn}`,
        toolName: "read",
        content: [{ type: "text", text: `${label} tool output ${turn}${padChunk}` }],
        isError: false,
        timestamp: (timestamp += 1),
      });
      messageCount += 2;
    }
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: `${label} a${turn}` }],
      api: "openai-completions",
      provider,
      model: modelId,
      usage: usage(8),
      stopReason: "stop",
      timestamp: (timestamp += 1),
    });
    messageCount += 1;
  }
  let firstKeptEntryId: string | undefined;
  if (options.compact) {
    const keptTurns = Math.max(1, Math.min(options.compact.keptTurns ?? 1, turns));
    const kept = userEntryIds[userEntryIds.length - keptTurns];
    if (kept === undefined) throw new Error("compaction seeding requires at least one user entry");
    firstKeptEntryId = kept;
    manager.appendCompaction(options.compact.summary, firstKeptEntryId, turns * 24, undefined, false, usage(6));
  }
  const sessionFile = manager.getSessionFile();
  const firstUserText = `${label} q0001${padChunk}`;
  const lastUserText = `${label} q${String(turns).padStart(4, "0")}${padChunk}`;
  return {
    sessionId: manager.getSessionId(),
    entryCount: manager.getBranch().length,
    messageCount,
    jsonlBytes: existsSyncSize(sessionFile),
    ...(firstKeptEntryId === undefined ? {} : { firstKeptEntryId }),
    hasContinuation: manager.getBranch().some((entry) => entry.type === "message"),
    firstUserText,
    lastUserText,
  };
}

function existsSyncSize(file: string | undefined): number {
  if (file === undefined) return 0;
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}
