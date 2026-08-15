// Read-only JSONL session store backed by the Pi SDK SessionManager.
//
// This is the ONLY module in the sessions domain that touches the Pi SDK. It
// performs pure read-only JSONL access — SessionManager.listAll / open /
// getEntries / getBranch / buildContextEntries / getLeafId / getEntry /
// appendSessionInfo — plus a single `rm` for deleteSession and an
// appendSessionInfo-based `renameSession` (offline rename appends a
// session_info entry; it never rewrites the session header/file). It reuses the
// migrated `mapMessage` to project SDK messages onto canonical runtime-core
// AgentMessages.
//
// Hard boundary: no ModelRuntime, Agent, AgentSession, network, credentials,
// resources or trust are imported or instantiated here. list / read / context /
// locate / resolveLeafId / renameSession / deleteSession run with zero Workers.
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
// - A warm index miss forces at most ONE fresh scan per cache generation,
//   coalesced across concurrent misses onto a single `listAll` (a session
//   created after the cached snapshot is recovered on that scan). All physical
//   scans (cold `listInfos` and `scanOnce`) share a monotonic refresh revision:
//   a scan replaces the cache only when its generation is current AND its
//   revision is newer than the last applied one, so a late-finishing older scan
//   can never overwrite a newer snapshot. Absence confirmed by a fresh scan is
//   remembered per generation with a fixed deadline measured from when it was
//   recorded and a bounded LRU capacity, so repeated reads of a persistently
//   missing session id never rescan, unrelated refreshes cannot extend a
//   negative, and TTL expiry or invalidation permits a retry. A scan
//   invalidated or superseded mid-flight can never repopulate the cache, clear
//   a newer in-flight scan, or record a negative (fail closed).
// - deleteSession treats a file that vanishes between the id-validated open
//   and the rm as already-deleted idempotent success and invalidates the list;
//   other filesystem failures are mapped to a sanitized RuntimeError that
//   never leaks the raw path.
// - renameSession validates the name (trim, non-blank, ≤200 Unicode JS code
//   units, no NUL/C0/DEL controls), appends a `session_info` entry via the
//   SDK (no header/file rewrite), maps any append failure to a sanitized
//   external/retryable file-kind error, and invalidates the list so the NEXT
//   listSessions/readSession observes the new title immediately (no 30s stale
//   window). The title source of truth is the latest `session_info` entry in
//   the JSONL file (SDK listAll `name` / getSessionName both read it).
// - rename AND delete for the SAME session id are serialized FIFO via a
//   per-session mutation queue (different session ids proceed concurrently):
//   rename/rename is deterministic (last committed append wins) and the
//   rename/delete race is deterministic (delete first → rename returns
//   not_found and never recreates/appends; rename first → delete removes the
//   renamed file). Each mutation holds exactly one per-session slot (no
//   nesting → no deadlock) and an emptied queue is removed (bounded cleanup).
//
// SCALE1 projection (see src/internal/session-projection.ts): the production
// composition point (`createPiSdkSessionPorts`) opts into a disposable SQLite
// projection index persisted in a Pix-owned directory. The projection caches
// the SDK list headers per file keyed by file identity (mtimeMs + size); every
// cold scan validates each row's checksum + backing file identity, re-reads
// only new/changed files, and falls back to the authoritative `sdk.listAll` on
// ANY index/scope inconsistency (never serves a wrong title/count/mtime). JSONL
// files stay authoritative; delete the index and everything still works via the
// store path. The existing invalidation seams (generation/revision fence,
// mutation-driven `invalidateList`) are reused unchanged: rename/delete/append
// change the file identity, so the next cold scan's per-file validation catches
// them exactly as before.
import { rm } from "node:fs/promises";
import { join, posix, win32 } from "node:path";
import { SessionManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  defaultProjectionDirectory,
  defaultProjectionIndexPath,
  ensureProjectionDirectory,
  projectInfo,
  reconcileProjection,
  SessionProjectionIndex,
  type ProjectedSession,
} from "./session-projection.js";
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
   * @internal Test-only: max entries in the per-generation negative cache
   * (default 1024). Bounds memory for long generations with many distinct
   * missing session ids; oldest entries are evicted (LRU by recording time).
   */
  maxNegatives?: number;
  /**
   * @internal Test-only: injectable SDK surface for deterministic tests.
   * Defaults to the real `SessionManager`.
   */
  sdk?: PiSdkSessionsSurface;
  /**
   * SCALE1 disposable SQLite projection index. Defaults to DISABLED so the
   * standalone store/catalog/mutation factories stay backend-neutral and
   * side-effect-free; the production composition point (`createPiSdkSessionPorts`
   * in `src/sessions/index.ts`) opts in explicitly. The index is persisted in a
   * Pix-owned directory (default: `<agentDir>/pix` for the global scope,
   * `<dirname(sessionDir)>/.pix` for an explicit sessionDir scope) and is fully
   * disposable: delete it and the store falls back to the authoritative
   * `listAll` path.
   */
  projection?: {
    /** Force-enable/disable regardless of the SDK-surface default. */
    enabled?: boolean;
    /** Explicit Pix-owned index directory (defaults to the scope default). */
    dir?: string;
  };
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
  /** Append a session_info entry carrying the display name; returns the entry id. */
  appendSessionInfo(name: string): string;
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
 * Map a persisted projection row back onto an SDK-shaped session info for the
 * store's internal list/index path. `allMessagesText` is reconstructed as
 * `firstMessage` — it is internal-only and never surfaced by the list path
 * (SessionHeader carries no such field); the projection persists only
 * `firstMessage` to keep the index bounded.
 */
function rowToInfo(row: ProjectedSession): SdkSessionInfo {
  return {
    path: row.path,
    id: row.id,
    cwd: row.cwd,
    ...(row.name === undefined ? {} : { name: row.name }),
    ...(row.parentSessionPath === undefined ? {} : { parentSessionPath: row.parentSessionPath }),
    created: new Date(row.createdMs === null ? Number.NaN : row.createdMs),
    modified: new Date(row.modifiedMs),
    messageCount: row.messageCount,
    firstMessage: row.firstMessage,
    allMessagesText: row.firstMessage,
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
 * Max session-name length in Unicode JS code units (UTF-16 `string.length`),
 * consistent with the live rename UX cap. Frozen: see the D4 adapter tests.
 */
const MAX_SESSION_NAME_LENGTH = 200;

/**
 * Normalize + validate a session display name for offline rename, consistent
 * with the live rename UX: outer whitespace trimmed, blank rejected, capped at
 * {@link MAX_SESSION_NAME_LENGTH} Unicode JS code units, and NUL/C0/DEL control
 * characters rejected outright rather than silently persisting invisible
 * control text. Ordinary internal spaces and Unicode (incl. emoji) are
 * allowed. Returns the canonical trimmed name on success or throws a
 * sanitized `invalid_input` RuntimeError that never echoes the raw name.
 */
function normalizeSessionName(name: unknown): string {
  if (typeof name !== "string") {
    throw makeRuntimeError("invalid_input", "session name must be a non-empty string");
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw makeRuntimeError("invalid_input", "session name must be a non-empty string");
  }
  if (trimmed.length > MAX_SESSION_NAME_LENGTH) {
    throw makeRuntimeError("invalid_input", "session name exceeds 200 characters");
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw makeRuntimeError("invalid_input", "session name contains control characters");
  }
  return trimmed;
}

/** True when `error` is a Node errno error carrying the given `code` (e.g. ENOENT). */
function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
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
  /**
   * Shared monotonic refresh revision. Every newly launched physical scan
   * (a `listInfos` cold scan OR a `scanOnce`) takes the next revision, and a
   * scan may only replace the cache when its generation is still current AND
   * its revision is newer than the last applied one. This fences both scan
   * paths together, so an earlier-launched scan that finishes late can never
   * overwrite a newer snapshot regardless of which slot launched it.
   */
  private revision = 0;
  /** Revision of the newest scan whose result is currently applied to `cache`. */
  private lastAppliedRevision = 0;
  private cache: { ts: number; infos: readonly SdkSessionInfo[]; revision: number } | undefined;
  private inFlight: { promise: Promise<readonly SdkSessionInfo[]>; generation: number } | undefined;
  /**
   * Coalesced in-flight slot for forced fresh scans (warm-index-miss rebuilds).
   * Mirrors `inFlight`'s identity-guarded finally so an old generation's scan
   * completion can never clear a newer in-flight scan.
   */
  private scanOnceInflight: { promise: Promise<readonly SdkSessionInfo[]>; generation: number } | undefined;
  /**
   * Per-generation negative results keyed by session id with a fixed expiry
   * measured from when the negative was RECORDED (not the moving cache
   * timestamp), so unrelated warm-miss refreshes can never extend a negative's
   * deadline. Expired entries are pruned lazily and capacity is bounded (LRU
   * eviction by recording time). Cleared on invalidation and on a TTL-expiry
   * cold full snapshot. Never populated by failed scans or by scans
   * invalidated/superseded mid-flight.
   */
  private negatives = new Map<string, number>();
  private readonly maxNegatives: number;
  /**
   * Per-session mutation serialization (D4 adapter foundation): rename AND
   * delete for the SAME session id share one FIFO queue so ordering is
   * deterministic (last committed append wins for rename/rename; delete-first
   * makes a later rename return not_found and never recreate/appends).
   * Different session ids never share a queue and proceed concurrently. Each
   * mutation acquires exactly one per-session slot (no nesting → no deadlock);
   * an emptied queue is removed so the map is bounded by the number of
   * sessions with in-flight mutations.
   */
  private readonly mutationQueues = new Map<string, Promise<void>>();
  /**
   * SCALE1 projection: defaults OFF so standalone store/catalog/mutation
   * factories stay backend-neutral and side-effect-free; the production
   * composition point (`createPiSdkSessionPorts`) opts in explicitly. Lazy:
   * the index directory is created only on the first cold scan, so
   * constructing the store stays side-effect-free.
   */
  private readonly projectionEnabled: boolean;
  private readonly projectionDirOverride: string | undefined;
  private projectionIndexPromise: Promise<SessionProjectionIndex | undefined> | undefined;

  constructor(options: PiSdkSessionStoreOptions = {}) {
    this.sessionDir = options.sessionDir;
    this.ttlMs = options.listTtlMs ?? 30_000;
    this.now = options.now ?? Date.now;
    this.maxNegatives = options.maxNegatives ?? 1024;
    this.sdk = options.sdk ?? realSdkSurface;
    // SCALE1 projection defaults OFF so standalone store/catalog/mutation
    // factories stay backend-neutral and side-effect-free (no writes to the
    // agent dir) unless explicitly enabled. The production composition point
    // (`createPiSdkSessionPorts`) opts in explicitly.
    this.projectionEnabled = options.projection?.enabled ?? false;
    this.projectionDirOverride = options.projection?.dir;
  }

  // -- list cache -----------------------------------------------------------

  private isWarm(): boolean {
    return Boolean(this.cache && this.now() - this.cache.ts < this.ttlMs);
  }

  private invalidateList(): void {
    this.generation += 1;
    this.cache = undefined;
    // A new generation starts fresh: the previous generation's negative
    // results must not block a retry.
    this.negatives.clear();
  }

  /** One cold scan. Never caches malformed/failed results. */
  private async scan(): Promise<readonly SdkSessionInfo[]> {
    if (this.projectionEnabled) {
      try {
        const projected = await this.scanProjected();
        if (projected !== undefined) return projected;
      } catch {
        // Projection path failed in an unexpected way: fall through to the
        // authoritative store path (fail-closed, never break listing).
      }
    }
    const infos = await this.sdk.listAll(this.sessionDir);
    if (!Array.isArray(infos)) {
      throw new Error("session list scan returned a malformed result");
    }
    return infos;
  }

  /**
   * SCALE1 projection-aware cold scan. Returns the projected list, or
   * `undefined` to signal a fallback to the authoritative `sdk.listAll` path
   * (index unavailable / scope unreliable / any non-regular session file). A
   * full rebuild (unusable index) runs `sdk.listAll` itself and serves that
   * result — parity by construction — while persisting the rows transactionally.
   */
  private async scanProjected(): Promise<readonly SdkSessionInfo[] | undefined> {
    const index = await this.projectionIndex();
    if (index === undefined) return undefined;
    const rows = index.load();
    if (rows === null) {
      // Unusable/corrupt/stale-schema index → authoritative full rebuild.
      const infos = await this.sdk.listAll(this.sessionDir);
      if (!Array.isArray(infos)) {
        throw new Error("session list scan returned a malformed result");
      }
      const projected: ProjectedSession[] = [];
      for (const info of infos) {
        const row = await projectInfo(info);
        if (row !== null) projected.push(row);
      }
      index.replaceAll(projected);
      return infos;
    }
    const reconciled = await reconcileProjection(index, this.sessionDir, rows);
    if (reconciled === null) return undefined;
    return reconciled.map(rowToInfo);
  }

  /**
   * Lazily create (and cache) the projection index: safe-create the Pix-owned
   * directory on first use, then build the index handle. Any failure (unsafe
   * dir layout, unwritable agent dir) caches `undefined` so later scans fall
   * back to the authoritative path. Construction of the store stays
   * side-effect-free; the directory is only touched on the first cold scan.
   */
  private projectionIndex(): Promise<SessionProjectionIndex | undefined> {
    if (this.projectionIndexPromise === undefined) {
      this.projectionIndexPromise = (async () => {
        const dir = this.projectionDirOverride ?? await defaultProjectionDirectory(this.sessionDir);
        await ensureProjectionDirectory(dir);
        return new SessionProjectionIndex(defaultProjectionIndexPath(dir));
      })().catch(() => undefined);
    }
    return this.projectionIndexPromise;
  }

  /**
   * Apply a completed scan under the shared revision fence: only when its
   * generation is still current AND its revision is newer than the last applied
   * one. A late-finished older scan is discarded so it can never overwrite a
   * newer snapshot. A full cold snapshot (listInfos) resets the negatives; any
   * id present in an applied scan has its negative dropped (it is no longer
   * missing).
   */
  private applyCache(
    infos: readonly SdkSessionInfo[],
    generation: number,
    revision: number,
    coldSnapshot: boolean,
  ): void {
    if (this.generation !== generation || revision <= this.lastAppliedRevision) return;
    this.cache = { ts: this.now(), infos, revision };
    this.lastAppliedRevision = revision;
    if (coldSnapshot) this.negatives.clear();
    for (const info of infos) this.negatives.delete(info.id);
  }

  /** Prune negatives whose recording-time deadline has passed. */
  private pruneNegatives(now = this.now()): void {
    for (const [id, at] of this.negatives) {
      if (now - at >= this.ttlMs) this.negatives.delete(id);
    }
  }

  /** True while a negative for `sessionId` is still within its fixed deadline. */
  private isNegative(sessionId: string): boolean {
    const at = this.negatives.get(sessionId);
    if (at === undefined) return false;
    if (this.now() - at >= this.ttlMs) {
      this.negatives.delete(sessionId);
      return false;
    }
    return true;
  }

  /** Record a negative with a fresh recording-time deadline; capacity bounded. */
  private recordNegative(sessionId: string): void {
    this.pruneNegatives();
    this.negatives.set(sessionId, this.now());
    if (this.negatives.size > this.maxNegatives) {
      // LRU by recording time: evict the oldest entries down to capacity.
      const ordered = [...this.negatives.entries()].sort((a, b) => a[1] - b[1]);
      const excess = this.negatives.size - this.maxNegatives;
      for (let index = 0; index < excess; index++) this.negatives.delete(ordered[index]![0]);
    }
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
    const revision = ++this.revision;
    const loadPromise = this.scan().then((infos) => {
      // A full cold snapshot (TTL expiry / first fill) resets the negatives so
      // the expired snapshot's misses are retryable.
      this.applyCache(infos, generation, revision, true);
      return infos;
    });
    const trackedPromise = loadPromise.finally(() => {
      if (this.inFlight?.promise === trackedPromise) this.inFlight = undefined;
    });
    this.inFlight = { promise: trackedPromise, generation };
    return trackedPromise;
  }

  /**
   * Force a fresh scan, bypassing the warm cache. Concurrent warm-index misses
   * coalesce onto ONE `listAll` per cache generation. A failed scan clears the
   * slot and is retryable (failures are never cached); a scan invalidated or
   * superseded mid-flight can neither repopulate the cache nor clear a newer
   * in-flight scan (identity-guarded finally + shared revision fence).
   */
  private async scanOnce(): Promise<readonly SdkSessionInfo[]> {
    const generation = this.generation;
    const inflight = this.scanOnceInflight;
    if (inflight && inflight.generation === generation) return inflight.promise;
    const revision = ++this.revision;
    const loadPromise = this.scan().then((infos) => {
      this.applyCache(infos, generation, revision, false);
      return infos;
    });
    const trackedPromise = loadPromise.finally(() => {
      if (this.scanOnceInflight?.promise === trackedPromise) this.scanOnceInflight = undefined;
    });
    this.scanOnceInflight = { promise: trackedPromise, generation };
    return trackedPromise;
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
   * `resolveSessionPath`, bounded by a per-generation negative cache:
   * - negative hit (within its fixed recording-time deadline) → not_found, no
   *   scan; unrelated refreshes can never extend the deadline;
   * - warm list → index hit → return (no scan);
   * - warm list → index miss → exactly one fresh, coalesced scan (a session
   *   created after the snapshot is recovered here), then re-check the CURRENT
   *   cache; if still absent and the scan is still the newest trusted snapshot,
   *   record a negative so repeated reads in this generation never scan;
   * - cold list → the `listInfos` scan just ran is fresh, so a miss is final
   *   and is recorded as a negative.
   * TTL expiry (cold full snapshot) and invalidation each clear the negatives,
   * so a retry is permitted. A scan invalidated or superseded mid-flight is
   * never trusted: it can not record a negative (fail closed against the newer
   * snapshot) and the caller re-reads the CURRENT cache before deciding.
   */
  private async resolveInfo(sessionId: string): Promise<SdkSessionInfo | undefined> {
    // A negative has its own fixed recording-time deadline, independent of cache
    // freshness, so unrelated warm-miss refreshes never extend it.
    if (this.isNegative(sessionId)) return undefined;
    const listWasWarm = this.isWarm();
    const generation = this.generation;
    await this.listInfos();
    // Re-read the CURRENT cache: the snapshot may have been superseded or
    // invalidated while we waited.
    const fromIndex = this.indexById().get(sessionId);
    if (fromIndex) return fromIndex;
    if (!listWasWarm) {
      // The cold `listInfos` scan that just ran is the freshest full snapshot.
      // A miss is final ONLY while it is still the newest applied snapshot (no
      // newer scan in flight); otherwise fail closed without recording.
      if (this.generation === generation && this.revision === this.cache?.revision) {
        this.recordNegative(sessionId);
      }
      return undefined;
    }
    // Warm miss: one fresh (coalesced) scan may recover a session created after
    // the cached snapshot.
    await this.scanOnce();
    // Re-check the CURRENT cache: this scan may have been discarded by a newer
    // refresh, or a newer scan may still be in flight. Only record a negative
    // against the current trusted snapshot (warm, current generation, newest).
    const current = this.indexById().get(sessionId);
    if (current) return current;
    if (
      this.generation === generation &&
      this.isWarm() &&
      this.revision === this.cache?.revision
    ) {
      this.recordNegative(sessionId);
    }
    return undefined;
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

  /**
   * Serialize a mutation for ONE session id behind a per-session FIFO queue.
   * `task` runs only after all earlier mutations for the same id settle (the
   * previous outcome is swallowed so a failure never blocks the next queued
   * mutation); different ids never share a queue. Each task holds exactly one
   * slot (no nesting → no deadlock) and an emptied queue is removed so the map
   * stays bounded. The stored tail always resolves (its handlers swallow), so
   * it can never become an unhandled rejection — the caller owns `run`'s
   * outcome.
   */
  private enqueueMutation(sessionId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.mutationQueues.get(sessionId) ?? Promise.resolve();
    const run = previous.then(task, task);
    let tail: Promise<void>;
    const release = () => {
      if (this.mutationQueues.get(sessionId) === tail) this.mutationQueues.delete(sessionId);
    };
    tail = run.then(release, release);
    this.mutationQueues.set(sessionId, tail);
    return run;
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
    // Serialized per-session so rename/delete ordering is deterministic while
    // different sessions proceed concurrently (see `enqueueMutation`).
    return this.enqueueMutation(sessionId, async () => {
      const opened = await this.openSession(sessionId);
      if (!opened) throw notFound(sessionId);
      try {
        await rm(opened.info.path);
      } catch (error) {
        if (isErrno(error, "ENOENT")) {
          // The file vanished between the id-validated open and the rm: the
          // session is already gone, so the delete is idempotent success. Drop
          // the stale warm index so it can never serve the deleted session.
          this.invalidateList();
          return;
        }
        // Map/sanitize any other filesystem failure; never leak the raw path.
        throw makeRuntimeError("external", `failed to delete session: ${sessionId}`, {
          retryable: true,
          cause: { kind: "file", detail: "session file removal failed" },
        });
      }
      // Invalidate immediately so a warm list can never serve a deleted session.
      this.invalidateList();
    });
  }

  async renameSession(sessionId: string, name: string): Promise<void> {
    // Validate eagerly (stateless, independent of queue order) so malformed
    // names fail immediately with a sanitized invalid_input and never reach
    // the SDK. Serialized per-session with delete for deterministic races.
    const canonical = normalizeSessionName(name);
    return this.enqueueMutation(sessionId, async () => {
      // Resolve via the existing exact open/index path + manager.getSessionId
      // identity check; a missing/stale/wrong id yields not_found and NEVER
      // creates a new session or appends to a reused path.
      const opened = await this.openSession(sessionId);
      if (!opened) throw notFound(sessionId);
      const { manager } = opened;
      try {
        manager.appendSessionInfo(canonical);
      } catch {
        // Map/sanitize any append failure; never leak the raw path or name.
        throw makeRuntimeError("external", `failed to rename session: ${sessionId}`, {
          retryable: true,
          cause: { kind: "file", detail: "session info append failed" },
        });
      }
      // Invalidate immediately so the SAME shared store's next
      // listSessions/readSession observes the new title (no 30s stale window).
      this.invalidateList();
    });
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
