// Read-only JSONL session store backed by the Pi SDK SessionManager.
//
// This is the ONLY module in the sessions domain that touches the Pi SDK. It
// performs pure read-only JSONL access — SessionManager.listAll / open /
// getEntries / getBranch / buildContextEntries / getLeafId / getEntry — plus a
// single `rm` for deleteSession. It reuses the migrated `mapMessage` to project
// SDK messages onto canonical runtime-core AgentMessages.
//
// Hard boundary: no ModelRuntime, Agent, AgentSession, network, credentials,
// resources or trust are imported or instantiated here. list / read / context /
// locate / resolveLeafId run with zero Workers.
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { SessionManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  AgentMessage,
  SessionContext,
  SessionDetail,
  SessionEntry,
  SessionHeader,
  SessionLocation,
} from "@fffattiger/pix-runtime-core";
import { makeRuntimeError } from "@fffattiger/pix-runtime-core";
import { mapMessage } from "../mappers/index.js";
import type { PiSdkSessionStore } from "../sessions/index.js";

/** Options for the SDK-backed session store. */
export interface PiSdkSessionStoreOptions {
  /**
   * Restrict session listing to a single session directory. When omitted, the
   * SDK lists sessions across all known project directories (its default).
   */
  sessionDir?: string;
}

type SdkSessionInfo = Awaited<ReturnType<typeof SessionManager.listAll>>[number];
type SdkEntry = ReturnType<SessionManager["getEntries"]>[number];

async function listSessionInfos(sessionDir?: string): Promise<readonly SdkSessionInfo[]> {
  return sessionDir === undefined ? SessionManager.listAll() : SessionManager.listAll(sessionDir);
}

async function findSessionInfo(sessionId: string, sessionDir?: string): Promise<SdkSessionInfo | undefined> {
  const sessions = await listSessionInfos(sessionDir);
  return sessions.find((session) => session.id === sessionId);
}

/**
 * Resolve fork provenance for a session. Recognizes the current
 * `pix-fork-provenance` custom entry (carrying parentSessionId +
 * forkPointEntryId) and falls back to the SDK-native session header
 * (`parentSession`) for the parent id. Historical fork entries written under
 * any other custom type are not special-cased — they flow through as ordinary
 * custom state. Read-only: no network or Worker.
 */
function forkProvenance(path: string): { parentSessionId?: string; forkPointEntryId?: string } {
  try {
    const manager = SessionManager.open(path);
    const entries = manager.getEntries();
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index];
      if (!entry || entry.type !== "custom" || entry.customType !== "pix-fork-provenance") continue;
      const data = entry.data && typeof entry.data === "object" ? entry.data as Record<string, unknown> : {};
      return {
        ...(typeof data.parentSessionId === "string" ? { parentSessionId: data.parentSessionId } : {}),
        ...(typeof data.forkPointEntryId === "string" ? { forkPointEntryId: data.forkPointEntryId } : {}),
      };
    }
    const parentPath = manager.getHeader()?.parentSession;
    if (!parentPath) return {};
    return { parentSessionId: SessionManager.open(parentPath).getSessionId() };
  } catch {
    return {};
  }
}

function toSessionHeader(info: SdkSessionInfo): SessionHeader {
  const provenance = forkProvenance(info.path);
  return {
    sessionId: info.id,
    sessionFile: info.path,
    cwd: info.cwd,
    projectRoot: info.cwd,
    ...(info.name === undefined ? {} : { title: info.name }),
    createdAt: info.created.getTime(),
    updatedAt: info.modified.getTime(),
    lastMessageAt: info.modified.getTime(),
    messageCount: info.messageCount,
    ...(provenance.parentSessionId === undefined ? {} : { parentSessionId: provenance.parentSessionId }),
    ...(provenance.forkPointEntryId === undefined ? {} : { forkPointEntryId: provenance.forkPointEntryId }),
  };
}

/**
 * Project a single SDK session entry onto zero or more canonical catalog
 * entries. Message entries are mapped via the shared `mapMessage`; custom
 * message, compaction and branch-summary entries are projected as canonical
 * custom messages; structural entries (model/thinking/label/session-info
 * changes, plain custom state) carry no context message and are dropped.
 */
function mapEntry(entry: SdkEntry): SessionEntry[] {
  if (entry.type === "message") {
    return [{
      entryId: entry.id,
      ...(entry.parentId === null ? {} : { parentEntryId: entry.parentId }),
      message: mapMessage(entry.message) as AgentMessage,
    }];
  }
  if (entry.type === "custom_message") {
    return [{
      entryId: entry.id,
      ...(entry.parentId === null ? {} : { parentEntryId: entry.parentId }),
      message: {
        role: "custom",
        customType: entry.customType,
        // SDK custom-message content uses the SDK image shape (data/mimeType);
        // runtime-core UserContent uses a `source` image shape. The shapes are
        // structurally divergent at the image variant, so cast across the
        // anti-corruption boundary (matches the message-mapper boundary).
        content: entry.content as never,
        display: entry.display,
        ...(entry.details === undefined ? {} : { details: entry.details }),
      },
    }];
  }
  if (entry.type === "compaction" || entry.type === "branch_summary") {
    return [{
      entryId: entry.id,
      ...(entry.parentId === null ? {} : { parentEntryId: entry.parentId }),
      message: {
        role: "custom",
        customType: entry.type,
        content: entry.summary,
        display: true,
        ...(entry.details === undefined ? {} : { details: entry.details }),
      },
    }];
  }
  return [];
}

function notFound(sessionId: string) {
  return makeRuntimeError("not_found", `session not found: ${sessionId}`);
}

/**
 * Create a read-only JSONL session store backed by the Pi SDK SessionManager.
 */
export function createPiSdkSessionStore(options?: PiSdkSessionStoreOptions): PiSdkSessionStore {
  const sessionDir = options?.sessionDir;
  return {
    async listSessions(): Promise<readonly SessionHeader[]> {
      return (await listSessionInfos(sessionDir)).map(toSessionHeader);
    },
    async readSession(sessionId): Promise<SessionDetail> {
      const info = await findSessionInfo(sessionId, sessionDir);
      if (!info) throw notFound(sessionId);
      const manager = SessionManager.open(info.path);
      return { ...toSessionHeader(info), entries: manager.getEntries().flatMap(mapEntry) };
    },
    async readSessionContext(sessionId, leafId): Promise<SessionContext> {
      const info = await findSessionInfo(sessionId, sessionDir);
      if (!info) throw notFound(sessionId);
      const manager = SessionManager.open(info.path);
      const selected = leafId ? manager.getBranch(leafId) : manager.buildContextEntries();
      const selectedLeaf = leafId ?? manager.getLeafId();
      return {
        sessionId,
        ...(selectedLeaf === null || selectedLeaf === undefined ? {} : { leafId: selectedLeaf }),
        entries: selected.flatMap(mapEntry),
      };
    },
    async deleteSession(sessionId): Promise<void> {
      const info = await findSessionInfo(sessionId, sessionDir);
      if (!info) throw notFound(sessionId);
      await rm(info.path);
    },
    async locate(sessionId): Promise<SessionLocation> {
      const info = await findSessionInfo(sessionId, sessionDir);
      return {
        sessionId,
        sessionFile: info?.path ?? join(getAgentDir(), "sessions", `${sessionId}.jsonl`),
        exists: Boolean(info),
      };
    },
    async resolveLeafId(sessionId, targetId): Promise<string> {
      const info = await findSessionInfo(sessionId, sessionDir);
      if (!info) throw notFound(sessionId);
      const manager = SessionManager.open(info.path);
      if (targetId && !manager.getEntry(targetId)) {
        throw makeRuntimeError("not_found", `entry not found: ${targetId}`);
      }
      return targetId ?? manager.getLeafId() ?? sessionId;
    },
  };
}
