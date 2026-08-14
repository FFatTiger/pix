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
//
// Performance contract (hotfix `fix/session-list-piweb-parity`, mirrors the
// legacy web frontend's `session-reader` algorithm):
//
// - The list path runs exactly ONE `SessionManager.listAll()` per cold refresh
//   and NEVER calls `SessionManager.open`/getEntries per listed session (no
//   second full read). `parentSessionId` is derived from each info's
//   `parentSessionPath` via a normalized path→sessionId map, matching old
//   `sessionPathKey` normalization exactly. `forkPointEntryId` is
//   intentionally absent from list headers because reading it requires opening
//   entries; the detail path (`readSession`) retains full provenance.
// - Each store instance owns a 30s TTL list cache plus one shared in-flight
//   promise that coalesces concurrent list requests (per cache generation).
//   No unsafe process-global cache. Timing is injectable for deterministic
//   tests.
// - Warm single-session operations (read/context/locate/resolveLeafId/delete)
//   resolve the sessionId → path/info index from the list result instead of
//   re-running a global listAll. Stale/deleted paths are validated, rebuilt
//   at most once, then reported not_found; a wrong session is never returned.
import { rm } from "node:fs/promises";
import { join, posix, win32 } from "node:path";
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
  /**
   * List cache TTL in ms (default 30_000), matching the legacy web
   * frontend's `SESSION_LIST_CACHE_TTL_MS`. Injectable for deterministic
   * tests.
   */
  listTtlMs?: number;
  /**
   * Injectable clock for deterministic cache-expiry tests. Defaults to
   * `Date.now`.
   */
  now?: () => number;
  /**
   * @internal Test-only: injectable SDK surface for deterministic tests.
   * Defaults to the real `SessionManager`.
   */
  sdk?: PiSdkSessionsSurface;
}

type SdkSessionInfo = Awaited<ReturnType<typeof SessionManager.listAll>>[number];
type SdkEntry = ReturnType<SessionManager["getEntries"]>[number];

/** The narrow SessionManager surface the store needs (real manager is structurally compatible). */
export interface PiSdkSessionManager {
  getEntries(): readonly SdkEntry[];
  getBranch(leafId: string): readonly SdkEntry[];
  buildContextEntries(): readonly SdkEntry[];
  getLeafId(): string | null;
  getEntry(targetId: string): SdkEntry | undefined;
  getSessionId(): string;
  getHeader(): { parentSession?: string } | null | undefined;
}

/** Injectable SDK read surface used by the store (real SessionManager is the default). */
export interface PiSdkSessionsSurface {
  listAll(sessionDir?: string): Promise<readonly SdkSessionInfo[]>;
  open(path: string): PiSdkSessionManager;
}

const realSdkSurface: PiSdkSessionsSurface = {
  listAll: (sessionDir?: string): Promise<readonly SdkSessionInfo[]> =>
    sessionDir === undefined ? SessionManager.listAll() : SessionManager.listAll(sessionDir),
  open: (path: string): PiSdkSessionManager => SessionManager.open(path),
};

/**
 * Normalize a session file path for map keys, mirroring the legacy web
 * frontend's `sessionPathKey` exactly: platform-specific normalize (posix on
 * macOS/Linux, win32 + lowercase on Windows). Parent paths are matched through
 * this same key, so a relative `parentSessionPath` that normalizes differently
 * from the absolute session paths simply does not resolve (same as the legacy
 * web frontend).
 */
function sessionPathKey(filePath: string, platform: NodeJS.Platform = process.platform): string {
  const normalized = platform === "win32" ? win32.normalize(filePath) : posix.normalize(filePath);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * Map a single SDK session info onto a canonical SessionHeader. `provenance`
 * supplies the fork linkage: the list path resolves `parentSessionId` from
 * `info.parentSessionPath` via the path map (no `forkPointEntryId`), while the
 * detail path passes full provenance read from the session's entries.
 */
function toHeader(info: SdkSessionInfo, provenance: { parentSessionId?: string; forkPointEntryId?: string }): SessionHeader {
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
 * Read-only JSONL session store with a per-instance list cache + in-flight
 * coalescing (see the module docstring for the performance contract).
 */
class PiSdkSessionStoreImpl implements PiSdkSessionStore {
  private readonly sessionDir: string | undefined;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly sdk: PiSdkSessionsSurface;
  /**
   * List-generation guard (per store, never process-global). Bumped on
   * invalidation so an in-flight scan from an older generation can never
   * repopulate the cache after a mutation, and new callers stop joining an
   * obsolete in-flight promise.
   */
  private generation = 0;
  private cache: { ts: number; infos: readonly SdkSessionInfo[] } | undefined;
  private inFlight: { promise: Promise<readonly SdkSessionInfo[]>; generation: number } | undefined;

  constructor(options: PiSdkSessionStoreOptions = {}) {
    this.sessionDir = options.sessionDir;
    this.ttlMs = options.listTtlMs ?? 30_000;
    this.now = options.now ?? Date.now;
    this.sdk = options.sdk ?? realSdkSurface;
  }

  // -- list cache -----------------------------------------------------------

  private isWarm(): boolean {
    return Boolean(this.cache && this.now() - this.cache.ts < this.ttlMs);
  }

  private invalidateList(): void {
    this.generation += 1;
    this.cache = undefined;
  }

  /** One cold scan. Never caches malformed/failed results. */
  private async scan(): Promise<readonly SdkSessionInfo[]> {
    const infos = await this.sdk.listAll(this.sessionDir);
    if (!Array.isArray(infos)) {
      throw new Error("session list scan returned a malformed result");
    }
    return infos;
  }

  /**
   * Warm-cache / coalesce / refresh. Exactly one `listAll` per cold refresh;
   * concurrent callers share one in-flight promise while it belongs to the
   * current generation. A failed scan clears the in-flight state and is
   * retryable; failures are never cached.
   */
  private async listInfos(): Promise<readonly SdkSessionInfo[]> {
    const generation = this.generation;
    if (this.isWarm()) return this.cache!.infos;
    const inflight = this.inFlight;
    if (inflight && inflight.generation === generation) return inflight.promise;
    const loadPromise = this.scan().then((infos) => {
      // Only repopulate the cache when no invalidation happened during the scan.
      if (this.generation === generation) this.cache = { ts: this.now(), infos };
      return infos;
    });
    const trackedPromise = loadPromise.finally(() => {
      if (this.inFlight?.promise === trackedPromise) this.inFlight = undefined;
    });
    this.inFlight = { promise: trackedPromise, generation };
    return trackedPromise;
  }

  /**
   * Force a fresh scan, bypassing the warm cache and in-flight coalescing.
   * Used as the single "rebuild" step for stale/missing warm-index lookups.
   */
  private async scanOnce(): Promise<readonly SdkSessionInfo[]> {
    const generation = this.generation;
    const infos = await this.scan();
    if (this.generation === generation) this.cache = { ts: this.now(), infos };
    return infos;
  }

  /** sessionId → info index built from the current (warm or freshly scanned) cache. */
  private indexById(): Map<string, SdkSessionInfo> {
    const byId = new Map<string, SdkSessionInfo>();
    for (const info of this.cache?.infos ?? []) byId.set(info.id, info);
    return byId;
  }

  /** normalized path → sessionId index built from the current cache. */
  private indexByPath(): Map<string, string> {
    const byPath = new Map<string, string>();
    for (const info of this.cache?.infos ?? []) byPath.set(sessionPathKey(info.path), info.id);
    return byPath;
  }

  /**
   * Resolve a session's info from the list index without re-running a global
   * scan after a warm list. Mirrors the legacy web frontend's
   * `resolveSessionPath`:
   * - warm list → index hit → return (no scan);
   * - warm list → index miss → exactly one fresh scan (session may have been
   *   created after the snapshot), then index again;
   * - cold list → the `listInfos` scan just ran is fresh, so a miss is final.
   */
  private async resolveInfo(sessionId: string): Promise<SdkSessionInfo | undefined> {
    const listWasWarm = this.isWarm();
    await this.listInfos();
    const fromIndex = this.indexById().get(sessionId);
    if (fromIndex) return fromIndex;
    if (!listWasWarm) return undefined;
    await this.scanOnce();
    return this.indexById().get(sessionId);
  }

  /**
   * Open a session's manager, validating the on-disk id so a stale/reused path
   * can never surface as the wrong session. On any open/id failure the list is
   * invalidated and rebuilt exactly once; if the session is then absent the
   * caller receives `undefined` (→ not_found).
   */
  private async openSession(sessionId: string): Promise<{ manager: PiSdkSessionManager; info: SdkSessionInfo } | undefined> {
    let info = await this.resolveInfo(sessionId);
    if (!info) return undefined;
    const manager = this.tryOpen(sessionId, info);
    if (manager) return { manager, info };
    // Index path is stale (deleted/moved/reused): rebuild exactly once below.
    this.invalidateList();
    info = await this.resolveInfo(sessionId);
    if (!info) return undefined;
    const rebuilt = this.tryOpen(sessionId, info);
    return rebuilt ? { manager: rebuilt, info } : undefined;
  }

  private tryOpen(sessionId: string, info: SdkSessionInfo): PiSdkSessionManager | undefined {
    try {
      const manager = this.sdk.open(info.path);
      return manager.getSessionId() === sessionId ? manager : undefined;
    } catch {
      return undefined;
    }
  }

  // -- list / detail / context ----------------------------------------------

  async listSessions(): Promise<readonly SessionHeader[]> {
    const infos = await this.listInfos();
    const byPath = this.indexByPath();
    return infos.map((info) => {
      const parentSessionId = info.parentSessionPath === undefined
        ? undefined
        : byPath.get(sessionPathKey(info.parentSessionPath));
      return toHeader(info, {
        ...(parentSessionId === undefined ? {} : { parentSessionId }),
      });
    });
  }

  /** Read fork provenance from an opened session's entries (detail path). */
  private provenanceFromEntries(manager: PiSdkSessionManager): { parentSessionId?: string; forkPointEntryId?: string } {
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
    return {};
  }

  /**
   * Full provenance for the detail path: the `pix-fork-provenance` custom entry
   * when present, otherwise the SDK-native `parentSession` header resolved to a
   * session id via the warm path→id index (falling back to opening the parent).
   */
  private async provenanceFor(manager: PiSdkSessionManager): Promise<{ parentSessionId?: string; forkPointEntryId?: string }> {
    const custom = this.provenanceFromEntries(manager);
    if (custom.parentSessionId !== undefined) return custom;
    const parentPath = manager.getHeader()?.parentSession;
    if (!parentPath) return custom;
    const parentId = this.indexByPath().get(sessionPathKey(parentPath));
    if (parentId !== undefined) return { ...custom, parentSessionId: parentId };
    try {
      return { ...custom, parentSessionId: this.sdk.open(parentPath).getSessionId() };
    } catch {
      return custom;
    }
  }

  async readSession(sessionId: string): Promise<SessionDetail> {
    const opened = await this.openSession(sessionId);
    if (!opened) throw notFound(sessionId);
    const { manager, info } = opened;
    return { ...toHeader(info, await this.provenanceFor(manager)), entries: manager.getEntries().flatMap(mapEntry) };
  }

  async readSessionContext(sessionId: string, leafId?: string): Promise<SessionContext> {
    const opened = await this.openSession(sessionId);
    if (!opened) throw notFound(sessionId);
    const { manager } = opened;
    const selected = leafId ? manager.getBranch(leafId) : manager.buildContextEntries();
    const selectedLeaf = leafId ?? manager.getLeafId();
    return {
      sessionId,
      ...(selectedLeaf === null || selectedLeaf === undefined ? {} : { leafId: selectedLeaf }),
      entries: selected.flatMap(mapEntry),
    };
  }

  async deleteSession(sessionId: string): Promise<void> {
    const opened = await this.openSession(sessionId);
    if (!opened) throw notFound(sessionId);
    await rm(opened.info.path);
    // Invalidate immediately so a warm list can never serve a deleted session.
    this.invalidateList();
  }

  async locate(sessionId: string): Promise<SessionLocation> {
    // Validate the resolved path actually opens as the requested session so a
    // stale/deleted warm-index path never reports a wrong session as present.
    const opened = await this.openSession(sessionId);
    return {
      sessionId,
      sessionFile: opened?.info.path ?? join(getAgentDir(), "sessions", `${sessionId}.jsonl`),
      exists: Boolean(opened),
    };
  }

  async resolveLeafId(sessionId: string, targetId?: string): Promise<string> {
    const opened = await this.openSession(sessionId);
    if (!opened) throw notFound(sessionId);
    const { manager } = opened;
    if (targetId && !manager.getEntry(targetId)) {
      throw makeRuntimeError("not_found", `entry not found: ${targetId}`);
    }
    return targetId ?? manager.getLeafId() ?? sessionId;
  }
}

/**
 * Create a read-only JSONL session store backed by the Pi SDK SessionManager.
 */
export function createPiSdkSessionStore(options?: PiSdkSessionStoreOptions): PiSdkSessionStore {
  return new PiSdkSessionStoreImpl(options);
}
