/**
 * In-memory session store backing the reference fake.
 *
 * Simulates the JSONL truth source with serializable entries, written-file
 * tracking, fork provenance and close records. Also implements the read-side
 * catalog/locator operations so the reference harness can provide every port.
 */
import type {
  AgentMessage,
  ModelRef,
  SideChatActivityItem,
  SideChatMainSnapshot,
  SessionContext,
  SessionDetail,
  SessionHeader,
  SessionLocation,
} from "@fffattiger/pi-web-runtime-core";

export interface StoredEntry {
  entryId: string;
  parentEntryId?: string;
  message: AgentMessage;
}

export interface StoredSession {
  sessionId: string;
  sessionFile: string;
  cwd: string;
  projectRoot: string;
  title?: string;
  createdAt: number;
  updatedAt: number;
  lastMessageAt?: number;
  parentSessionId?: string;
  forkPointEntryId?: string;
  leafId?: string;
  model?: ModelRef;
  closeReason?: string;
  closedAt?: number;
  deleted?: boolean;
  entries: StoredEntry[];
  writtenFiles: Set<string>;
}

export interface CreateSessionInput {
  sessionId?: string;
  cwd?: string;
  projectRoot?: string;
  title?: string;
  parentSessionId?: string;
  forkPointEntryId?: string;
  leafId?: string;
  model?: ModelRef;
  entries?: readonly StoredEntry[];
  writtenFiles?: readonly string[];
}

let globalSessionCounter = 0;

export class ReferenceSessionStore {
  readonly sessions = new Map<string, StoredSession>();
  readonly baseDir: string;
  private nextId = 1;
  private nextEntryId = 1;

  constructor(options?: { baseDir?: string }) {
    this.baseDir = options?.baseDir ?? "~/.pi/agent/sessions";
  }

  newSessionId(): string {
    // Globally unique across stores so harnesses sharing a registry (e.g.
    // the side-chat snapshot lookup) never collide on session ids.
    globalSessionCounter += 1;
    return `session-${globalSessionCounter}`;
  }

  newEntryId(): string {
    return `entry-${this.nextEntryId++}`;
  }

  createSession(input: CreateSessionInput = {}): StoredSession {
    const sessionId = input.sessionId ?? this.newSessionId();
    const now = Date.now();
    const session: StoredSession = {
      sessionId,
      sessionFile: `${this.baseDir}/${sessionId}.jsonl`,
      cwd: input.cwd ?? "/workspace",
      projectRoot: input.projectRoot ?? input.cwd ?? "/workspace",
      ...(input.title === undefined ? {} : { title: input.title }),
      createdAt: now,
      updatedAt: now,
      ...(input.parentSessionId === undefined
        ? {}
        : { parentSessionId: input.parentSessionId }),
      ...(input.forkPointEntryId === undefined
        ? {}
        : { forkPointEntryId: input.forkPointEntryId }),
      ...(input.leafId === undefined ? {} : { leafId: input.leafId }),
      ...(input.model === undefined ? {} : { model: input.model }),
      entries: input.entries ? [...input.entries] : [],
      writtenFiles: new Set(input.writtenFiles ?? []),
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  getSession(sessionId: string): StoredSession | undefined {
    const session = this.sessions.get(sessionId);
    return session && !session.deleted ? session : undefined;
  }

  appendEntry(sessionId: string, message: AgentMessage): StoredEntry {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`unknown session ${sessionId}`);
    const parentEntryId = session.entries.at(-1)?.entryId;
    const entry: StoredEntry = {
      entryId: this.newEntryId(),
      ...(parentEntryId === undefined ? {} : { parentEntryId }),
      message,
    };
    session.entries.push(entry);
    session.updatedAt = Date.now();
    session.lastMessageAt = Date.now();
    return entry;
  }

  setLeafId(sessionId: string, leafId: string): void {
    const session = this.getSession(sessionId);
    if (session) session.leafId = leafId;
  }

  addWrittenFiles(sessionId: string, paths: readonly string[]): void {
    const session = this.getSession(sessionId);
    if (!session) return;
    for (const path of paths) session.writtenFiles.add(path);
  }

  recordClose(sessionId: string, reason: string): void {
    const session = this.getSession(sessionId);
    if (!session) return;
    session.closeReason = reason;
    session.closedAt = Date.now();
  }

  trimEntries(sessionId: string, keep: number): number {
    const session = this.getSession(sessionId);
    if (!session) return 0;
    const removed = Math.max(0, session.entries.length - keep);
    if (removed > 0) {
      session.entries = session.entries.slice(-keep);
      session.updatedAt = Date.now();
    }
    return removed;
  }

  buildSideChatSnapshot(sessionId: string): SideChatMainSnapshot | null {
    const session = this.getSession(sessionId);
    if (!session) return null;
    const activity: SideChatActivityItem[] = session.entries.slice(-5).map((entry) => {
      const message = entry.message;
      const role =
        message.role === "user" || message.role === "assistant" || message.role === "toolResult"
          ? message.role
          : "toolResult";
      let text = "";
      if (message.role === "assistant") {
        text = message.content
          .filter((block) => block.type === "text")
          .map((block) => (block as { text: string }).text)
          .join("\n")
          .slice(0, 500);
      } else if (message.role === "user") {
        text = typeof message.content === "string" ? message.content.slice(0, 300) : "";
      } else if (message.role === "toolResult") {
        text = message.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n")
          .slice(0, 300);
      } else if (message.role === "bashExecution") {
        text = message.output.slice(0, 300);
      }
      const item: SideChatActivityItem = { entryId: entry.entryId, role, text };
      if (message.role === "toolResult" && message.toolName) {
        item.toolName = message.toolName;
      }
      return item;
    });
    const snapshot: SideChatMainSnapshot = {
      sessionId,
      systemPrompt: "You are a coding agent.",
      writtenFiles: [...session.writtenFiles],
      activity,
      version: session.entries.length,
    };
    if (session.forkPointEntryId) {
      snapshot.forkLeafId = session.forkPointEntryId;
    }
    return snapshot;
  }

  /* ---------------- catalog / locator operations ---------------- */

  listSessions(): SessionHeader[] {
    return [...this.sessions.values()]
      .filter((session) => !session.deleted)
      .map((session) => this.toHeader(session))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }

  readSession(sessionId: string): SessionDetail {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`session not found: ${sessionId}`);
    return {
      ...this.toHeader(session),
      entries: session.entries.map((entry) => ({ ...entry })),
    };
  }

  readSessionContext(sessionId: string, leafId?: string): SessionContext {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`session not found: ${sessionId}`);
    const entries = session.entries.map((entry) => ({ ...entry }));
    return {
      sessionId,
      ...(leafId ?? session.leafId
        ? { leafId: leafId ?? session.leafId }
        : {}),
      entries,
    };
  }

  deleteSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) session.deleted = true;
  }

  locate(sessionId: string): SessionLocation {
    const session = this.getSession(sessionId);
    return {
      sessionId,
      sessionFile: session ? session.sessionFile : `${this.baseDir}/${sessionId}.jsonl`,
      exists: Boolean(session),
    };
  }

  resolveLeafId(sessionId: string, targetId?: string): string {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`session not found: ${sessionId}`);
    if (targetId) {
      const exists = session.entries.some((entry) => entry.entryId === targetId);
      if (!exists) throw new Error(`entry not found: ${targetId}`);
      return targetId;
    }
    return session.leafId ?? session.entries.at(-1)?.entryId ?? sessionId;
  }

  private toHeader(session: StoredSession): SessionHeader {
    return {
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      cwd: session.cwd,
      projectRoot: session.projectRoot,
      ...(session.title === undefined ? {} : { title: session.title }),
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      ...(session.lastMessageAt === undefined
        ? {}
        : { lastMessageAt: session.lastMessageAt }),
      messageCount: session.entries.length,
      ...(session.parentSessionId === undefined
        ? {}
        : { parentSessionId: session.parentSessionId }),
      ...(session.forkPointEntryId === undefined
        ? {}
        : { forkPointEntryId: session.forkPointEntryId }),
    };
  }
}
