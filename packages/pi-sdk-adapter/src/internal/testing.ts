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

export interface SeedSessionOptions {
  /** Canonical working directory recorded for the session (must exist). */
  cwd: string;
  userText?: string;
  assistantText?: string;
}

export interface SeededSession {
  sessionId: string;
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
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: options.assistantText ?? "history reply" }],
    api: "anthropic",
    provider: "anthropic",
    model: "e2e-model",
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 } },
    stopReason: "stop",
    timestamp: now + 1,
  });
  return { sessionId: manager.getSessionId() };
}

/** List session ids visible to the default read-only catalog (for sanity checks). */
export async function listSeededSessionIdsForTests(): Promise<string[]> {
  const sessions = await SessionManager.listAll();
  return sessions.map((session) => session.id);
}
