/**
 * Canonical session DTOs for the read-side catalog and the activation-side
 * locator. No backend session objects ever cross these ports — only
 * serializable headers, contexts and locations.
 */
import type { AgentMessage, ContextUsage } from "./messages.js";

export interface SessionListFilter {
  limit?: number;
  offset?: number;
  cwd?: string;
}

export interface SessionHeader {
  sessionId: string;
  sessionFile?: string;
  /** Canonical working directory recorded by the session. */
  cwd: string;
  /** Canonical project root used for grouping and trust policy. */
  projectRoot: string;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
  lastMessageAt?: number;
  messageCount?: number;
  /** Session this one was forked from (fork provenance). */
  parentSessionId?: string;
  /** Entry id the fork was created at. */
  forkPointEntryId?: string;
}

export interface SessionDetail extends SessionHeader {
  /** Complete entry list of the session (truth source projection). */
  entries?: readonly SessionEntry[];
}

export interface SessionEntry {
  entryId: string;
  parentEntryId?: string;
  message: AgentMessage;
}

export interface SessionContext {
  sessionId: string;
  leafId?: string;
  entries: readonly SessionEntry[];
}

/** Activation location for a session (used by the sessiond / worker shell). */
export interface SessionLocation {
  sessionId: string;
  sessionFile: string;
  exists: boolean;
}

export interface SessionStats {
  messageCount: number;
  pendingMessageCount?: number;
  tokenCount?: number;
  contextUsage?: ContextUsage;
}
