// Public sessions surface of the pix Pi SDK Adapter (D1A-1).
//
// Session catalog + locator backed by read-only Pi SDK JSONL access. This
// module satisfies runtime-core SessionCatalogPort / SessionLocatorPort
// WITHOUT importing the Pi SDK: the SDK-coupled store lives in
// src/internal/session-store.ts. No model runtime, live agent, network,
// credentials, resources or trust are involved; list / read / context /
// locate / resolveLeafId run with zero Workers.
import type {
  SessionCatalogPort,
  SessionContext,
  SessionDetail,
  SessionHeader,
  SessionListFilter,
  SessionLocation,
  SessionLocatorPort,
} from "@fffattiger/pix-runtime-core";
import { createPiSdkSessionStore } from "../internal/session-store.js";

/**
 * Injectable read-only session store contract. The default implementation
 * (created by the internal store factory) reads Pi SDK JSONL; tests and
 * composition may supply their own to exercise the catalog/locator in
 * isolation. Every method is pure read-only JSONL access (deleteSession removes
 * the session file).
 */
export interface PiSdkSessionStore {
  listSessions(): Promise<readonly SessionHeader[]>;
  readSession(sessionId: string): Promise<SessionDetail>;
  readSessionContext(sessionId: string, leafId?: string): Promise<SessionContext>;
  deleteSession(sessionId: string): Promise<void>;
  locate(sessionId: string): Promise<SessionLocation>;
  resolveLeafId(sessionId: string, targetId?: string): Promise<string>;
}

class PiSdkSessionCatalog implements SessionCatalogPort {
  constructor(private readonly store: PiSdkSessionStore) {}

  async listSessions(filter?: SessionListFilter): Promise<readonly SessionHeader[]> {
    let sessions = [...await this.store.listSessions()];
    if (filter?.cwd) sessions = sessions.filter((session) => session.cwd === filter.cwd);
    if (filter?.offset !== undefined) sessions = sessions.slice(filter.offset);
    if (filter?.limit !== undefined) sessions = sessions.slice(0, filter.limit);
    return sessions;
  }

  readSession(sessionId: string): Promise<SessionDetail> {
    return this.store.readSession(sessionId);
  }

  readSessionContext(sessionId: string, options?: { leafId?: string }): Promise<SessionContext> {
    return this.store.readSessionContext(sessionId, options?.leafId);
  }

  deleteSession(sessionId: string): Promise<void> {
    return this.store.deleteSession(sessionId);
  }
}

class PiSdkSessionLocator implements SessionLocatorPort {
  constructor(private readonly store: PiSdkSessionStore) {}

  locate(sessionId: string): Promise<SessionLocation> {
    return this.store.locate(sessionId);
  }

  resolveLeafId(sessionId: string, targetId?: string): Promise<string> {
    return this.store.resolveLeafId(sessionId, targetId);
  }
}

/**
 * Create a SessionCatalogPort backed by read-only Pi SDK JSONL. An optional
 * store may be injected for tests/composition; the default store reads from the
 * SDK's configured session directories. list / read / context run with zero
 * Workers.
 */
export function createPiSdkSessionCatalog(store: PiSdkSessionStore = createPiSdkSessionStore()): SessionCatalogPort {
  return new PiSdkSessionCatalog(store);
}

/**
 * Create a SessionLocatorPort backed by read-only Pi SDK JSONL. An optional
 * store may be injected for tests/composition; the default store reads from the
 * SDK's configured session directories. locate / resolveLeafId run with zero
 * Workers.
 */
export function createPiSdkSessionLocator(store: PiSdkSessionStore = createPiSdkSessionStore()): SessionLocatorPort {
  return new PiSdkSessionLocator(store);
}
