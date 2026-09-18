// Public sessions surface of the pix Pi SDK Adapter (D1A-1 / D4 adapter
// foundation).
//
// Session catalog + locator backed by read-only Pi SDK JSONL access, plus a
// narrow backend-neutral offline rename mutation port. This module satisfies
// runtime-core SessionCatalogPort / SessionLocatorPort / SessionMutationPort
// WITHOUT importing the Pi SDK: the SDK-coupled store lives in
// src/internal/session-store.ts. No model runtime, live agent, network,
// credentials, resources or trust are involved; list / read / context /
// thinking / locate / resolveLeafId / renameSession run with zero Workers.
import type {
  CatalogPageRequest,
  ProjectCatalogPort,
  ProjectPage,
  SessionCatalogPort,
  SessionContext,
  SessionDetail,
  SessionHeader,
  SessionListFilter,
  SessionLocation,
  SessionLocatorPort,
  SessionMutationPort,
  SessionPage,
  SessionPageRequest,
  SessionThinkingBlock,
  SessionTree,
} from "@fffattiger/pix-runtime-core";
import { createPiSdkSessionStore } from "../internal/session-store.js";

/**
 * Injectable session store contract. The default implementation (created by
 * the internal store factory) reads Pi SDK JSONL; tests and composition may
 * supply their own to exercise the catalog/locator/mutation in isolation.
 * list / read / context / locate / resolveLeafId are pure read-only JSONL
 * access; deleteSession removes the session file; renameSession appends a
 * session_info entry (offline rename, never rewrites the header/file).
 */
export interface PiSdkSessionStore {
  prepare?(): Promise<void>;
  listSessionPage?(request: SessionPageRequest): Promise<SessionPage>;
  listProjectPage?(request: CatalogPageRequest): Promise<ProjectPage>;
  listSessions(): Promise<readonly SessionHeader[]>;
  readSession(sessionId: string): Promise<SessionDetail>;
  readSessionContext(
    sessionId: string,
    options?: {
      leafId?: string;
      before?: string;
      limit?: number;
      deferThinking?: boolean;
      deferMedia?: boolean;
    },
  ): Promise<SessionContext>;
  /**
   * Resolve one deferred thinking block by exact session/entry/block identity
   * (direct source-history parity). Fail-closed: unknown session/entry or a
   * non-thinking block → not_found; malformed index → invalid_input.
   */
  readSessionThinking(
    sessionId: string,
    entryId: string,
    blockIndex: number,
  ): Promise<SessionThinkingBlock>;
  /**
   * Normalized branch-tree projection over the SAME cached read-only JSONL
   * (list/read/context parity): roots + branch points + leaves with contracted
   * linear chains, safe length-capped labels, and the PERSISTED head as
   * `currentLeafId` (never a live worker leaf). Zero workers.
   */
  readSessionTree(sessionId: string): Promise<SessionTree>;
  deleteSession(sessionId: string): Promise<void>;
  renameSession(sessionId: string, name: string): Promise<void>;
  locate(sessionId: string): Promise<SessionLocation>;
  resolveLeafId(sessionId: string, targetId?: string): Promise<string>;
}

class PiSdkSessionCatalog implements SessionCatalogPort {
  constructor(private readonly store: PiSdkSessionStore) {}

  prepare(): Promise<void> { return this.store.prepare?.() ?? Promise.resolve(); }

  async listSessionPage(request: SessionPageRequest): Promise<SessionPage> {
    if (this.store.listSessionPage) return this.store.listSessionPage(request);
    let sessions = [...await this.store.listSessions()];
    if (request.cwd !== undefined) sessions = sessions.filter((item) => item.cwd === request.cwd);
    if (request.projectRoot !== undefined) sessions = sessions.filter((item) => item.projectRoot === request.projectRoot);
    const total = sessions.length;
    const offset = (request.page - 1) * request.pageSize;
    return { sessions: sessions.slice(offset, offset + request.pageSize), page: request.page, pageSize: request.pageSize, total, totalPages: total === 0 ? 0 : Math.ceil(total / request.pageSize), catalogRevision: 0 };
  }

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

  readSessionContext(sessionId: string, options?: { leafId?: string; before?: string; limit?: number; deferThinking?: boolean; deferMedia?: boolean }): Promise<SessionContext> {
    return this.store.readSessionContext(sessionId, { ...(options?.leafId === undefined ? {} : { leafId: options.leafId }), ...(options?.before === undefined ? {} : { before: options.before }), ...(options?.limit === undefined ? {} : { limit: options.limit }), ...(options?.deferThinking === undefined ? {} : { deferThinking: options.deferThinking }), ...(options?.deferMedia === undefined ? {} : { deferMedia: options.deferMedia }) });
  }

  readSessionThinking(sessionId: string, entryId: string, blockIndex: number): Promise<SessionThinkingBlock> {
    return this.store.readSessionThinking(sessionId, entryId, blockIndex);
  }

  readSessionTree(sessionId: string): Promise<SessionTree> {
    return this.store.readSessionTree(sessionId);
  }

  deleteSession(sessionId: string): Promise<void> {
    return this.store.deleteSession(sessionId);
  }
}

class PiSdkProjectCatalog implements ProjectCatalogPort {
  constructor(private readonly store: PiSdkSessionStore) {}
  prepare(): Promise<void> { return this.store.prepare?.() ?? Promise.resolve(); }
  async listProjectPage(request: CatalogPageRequest): Promise<ProjectPage> {
    if (this.store.listProjectPage) return this.store.listProjectPage(request);
    const grouped = new Map<string, { representativeCwd: string; sessionCount: number; latestActivity: number }>();
    for (const session of await this.store.listSessions()) {
      const current = grouped.get(session.projectRoot);
      const activity = session.updatedAt ?? session.lastMessageAt ?? session.createdAt ?? 0;
      if (!current) grouped.set(session.projectRoot, { representativeCwd: session.cwd, sessionCount: 1, latestActivity: activity });
      else { current.sessionCount += 1; current.latestActivity = Math.max(current.latestActivity, activity); }
    }
    const projects = [...grouped.entries()].map(([projectRoot, item]) => ({ projectRoot, ...item })).sort((a, b) => b.latestActivity - a.latestActivity || (a.projectRoot < b.projectRoot ? -1 : a.projectRoot > b.projectRoot ? 1 : 0));
    const total = projects.length;
    const offset = (request.page - 1) * request.pageSize;
    return { projects: projects.slice(offset, offset + request.pageSize), page: request.page, pageSize: request.pageSize, total, totalPages: total === 0 ? 0 : Math.ceil(total / request.pageSize), catalogRevision: 0 };
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

class PiSdkSessionMutation implements SessionMutationPort {
  constructor(private readonly store: PiSdkSessionStore) {}

  renameSession(sessionId: string, name: string): Promise<void> {
    return this.store.renameSession(sessionId, name);
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
export function createPiSdkProjectCatalog(store: PiSdkSessionStore = createPiSdkSessionStore()): ProjectCatalogPort {
  return new PiSdkProjectCatalog(store);
}

export function createPiSdkSessionLocator(store: PiSdkSessionStore = createPiSdkSessionStore()): SessionLocatorPort {
  return new PiSdkSessionLocator(store);
}

/**
 * Create a backend-neutral SessionMutationPort for OFFLINE session rename
 * backed by Pi SDK JSONL. An optional store may be injected for
 * tests/composition; the default store reads from the SDK's configured session
 * directories. renameSession appends a session_info entry (never rewrites the
 * header/file), runs with zero Workers, and exposes no Pi SDK types.
 */
export function createPiSdkSessionMutation(store: PiSdkSessionStore = createPiSdkSessionStore()): SessionMutationPort {
  return new PiSdkSessionMutation(store);
}

/** Production session triple: catalog + locator + mutation sharing ONE Pi SDK session store. */
export interface PiSdkSessionPorts {
  /** Read-side session catalog (list / read / context / delete). */
  readonly catalog: SessionCatalogPort;
  /** Independent project pages over the same materialized index. */
  readonly projectCatalog: ProjectCatalogPort;
  /** Activation-side session locator (locate / resolveLeafId). */
  readonly locator: SessionLocatorPort;
  /** Backend-neutral offline session mutation (renameSession). */
  readonly mutation: SessionMutationPort;
}

/**
 * Create the production session pair: a catalog, locator and mutation backed
 * by ONE shared Pi SDK session store, so a cold locate → catalog read (the
 * sessiond `sessions.resolve` → catalog-derived activation-context path) and a
 * rename → next catalog read all run against one shared cache instead of
 * independent stores; a rename invalidates the shared store so the next
 * listSessions/readSession observes the new title immediately. The default
 * store is private (created by the internal store factory); an optional store
 * may be injected for tests/composition, exactly like the injectable
 * catalog/locator factories above. This is the SCALE1 PRODUCTION composition
 * point: the default store opts into the disposable SQLite projection index
 * (`projection.enabled: true`), so the production cold-start list path reads
 * the persisted index (with per-file mtime/size validation + fail-closed
 * fallback) instead of re-parsing every JSONL. Backward-compatible: existing
 * destructuring of `{ catalog, locator }` keeps working. All methods run with
 * zero Workers.
 */
export function createPiSdkSessionPorts(store: PiSdkSessionStore = createPiSdkSessionStore({ projection: { enabled: true } })): PiSdkSessionPorts {
  return {
    catalog: createPiSdkSessionCatalog(store),
    projectCatalog: createPiSdkProjectCatalog(store),
    locator: createPiSdkSessionLocator(store),
    mutation: createPiSdkSessionMutation(store),
  };
}
