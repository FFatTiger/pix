// SCALE1 — disposable SQLite session-list projection index (node:sqlite).
//
// The Pi SDK `SessionManager.listAll` is the authoritative JSONL session list
// source but re-reads + re-parses EVERY session file per cold scan (~3s on the
// real corpus). This module adds a DISPOSABLE, REBUILDABLE projection index
// behind the store's listing path: a single SQLite file (built-in `node:sqlite`,
// zero new dependencies) that caches the projected list headers per session
// file, keyed by the file's identity (mtimeMs + size). JSONL files remain the
// source of truth; the index is only a persisted cache. Delete the index file
// (or the whole Pix-owned directory) and the store falls back to the
// authoritative path unchanged.
//
// Fail-closed staleness contract (the ONLY served rows):
//   - a row is served only when (a) its per-row checksum verifies (any DB
//     tamper of a served field — title, counts, mtime, identity — is detected
//     on load and forces a full rebuild, so a tampered index never serves) and
//     (b) the backing JSONL file still has the EXACT mtimeMs+size recorded in
//     the row (checked per file against the filesystem on every scan);
//   - any row whose file is missing is dropped; any file that is new or whose
//     mtime/size changed is re-read and re-indexed; any file that is not a
//     regular file (symlink/dir) makes the whole scan fall back to the
//     authoritative store path;
//   - any load failure (corrupt file, wrong schema version, missing meta,
//     checksum mismatch) returns "unusable" → the store falls back to the
//     authoritative path and rebuilds the index transactionally.
//
// Residual bounds (documented, NOT claimed fail-closed):
//   - an in-place file rewrite that preserves exact mtimeMs+size is not
//     detected by the identity check (the SDK never rewrites session files in
//     place — it appends, which changes size);
//   - the per-row checksum detects accidental corruption and NAIVE tampering of
//     the index (any field edit without recomputing the checksum). It is a
//     corruption/tamper detector, NOT a security boundary: an actor who
//     recomputes the row checksum is out of the adversarial model.
//
// Reindex parity: the incremental reindex path re-derives a file's projected
// fields with {@link parseSessionFile}, which mirrors the PINNED SDK 0.84.0
// `buildSessionInfo` semantics exactly (latest trimmed `session_info` name,
// message-count, last-message-activity `modified` with the same fallback chain,
// header `created`, header cwd/parentSessionPath). A parity test cross-checks
// the projection against the real SDK on a mixed corpus. The full-rebuild path
// is built from the SDK's own `listAll` result (parity by construction).
//
// Private-dir discipline (mirrors §58): the index directory is ensured via
// `@fffattiger/pix-local-authority/state` `ensurePrivateDirectory` — an
// EXISTING directory is validate-only (current-user owned where supported,
// exact 0700, real non-symlink dir, never chmod'd), a missing directory is
// created component-by-component 0700 with fd-identity pinning, and every
// failure surfaces as a fixed sanitized `LocalAuthorityError` code (no raw
// path/errno). The adapter reuses the local-authority primitives manifest-less
// (workspace symlink + build-deps build order), exactly like sessiond's
// local-posix.ts. The adapter's `check:boundaries` allows this import in
// `src/internal/**` and no local-authority type leaks into public declarations.
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import type { Dirent } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { canonicalizeAbsolutePath, ensurePrivateDirectory } from "@fffattiger/pix-local-authority/state";

/** Bump when the persisted schema/checksum layout changes incompatibly. */
export const PROJECTION_SCHEMA_VERSION = 1;
const PROJECTION_FORMAT = "pix-scale1-session-projection";
/** Index file name inside the Pix-owned projection directory. */
export const PROJECTION_INDEX_FILENAME = "session-index.sqlite";
/** Default Pix-owned projection directory under the agent dir (global scope). */
export const DEFAULT_AGENT_PROJECTION_DIR_NAME = "pix";
/** Default Pix-owned projection directory name for an explicit sessionDir scope. */
export const DEFAULT_SESSION_DIR_PROJECTION_DIR_NAME = ".pix";

/** Bounded reindex concurrency (the SDK listAll uses 10). */
const REINDEX_CONCURRENCY = 8;

/**
 * One projected session row persisted in the index. `createdMs` is null when
 * the session header timestamp is invalid (mirrors the SDK's Invalid Date).
 * `mtimeMs`/`size` are the backing file identity at index time.
 */
export interface ProjectedSession {
  id: string;
  path: string;
  cwd: string;
  name?: string;
  parentSessionPath?: string;
  createdMs: number | null;
  modifiedMs: number;
  messageCount: number;
  firstMessage: string;
  mtimeMs: number;
  size: number;
}

/** Canonical per-row checksum over every served field (corruption/naive-tamper detector). */
function rowChecksum(row: ProjectedSession): string {
  const canonical = [
    row.path,
    row.id,
    row.cwd,
    row.name ?? "",
    row.parentSessionPath ?? "",
    String(row.createdMs),
    String(row.modifiedMs),
    String(row.messageCount),
    row.firstMessage,
    String(row.mtimeMs),
    String(row.size),
  ].join("\u0000");
  return createHash("sha256").update(canonical).digest("hex");
}

interface DbRow {
  path: string;
  id: string;
  cwd: string;
  name: string | null;
  parent_session_path: string | null;
  created_ms: number | null;
  modified_ms: number;
  message_count: number;
  first_message: string;
  file_mtime_ms: number;
  file_size: number;
  checksum: string;
}

function dbRowToProjected(row: DbRow): ProjectedSession {
  return {
    path: row.path,
    id: row.id,
    cwd: row.cwd,
    ...(row.name === null ? {} : { name: row.name }),
    ...(row.parent_session_path === null ? {} : { parentSessionPath: row.parent_session_path }),
    createdMs: row.created_ms,
    modifiedMs: row.modified_ms,
    messageCount: row.message_count,
    firstMessage: row.first_message,
    mtimeMs: row.file_mtime_ms,
    size: row.file_size,
  };
}

/**
 * SQLite-backed projection index. All methods are synchronous under the hood
 * (node:sqlite `DatabaseSync`) and open/close the file per operation, so
 * concurrent store scans interleave only at async boundaries and each DB
 * operation is atomic w.r.t. the event loop. Every operation opens the file
 * lazily and closes it, so a store instance holds no file handles between cold
 * scans and an externally deleted/recreated index self-heals on the next open.
 */
export class SessionProjectionIndex {
  private readonly indexPath: string;

  constructor(indexPath: string) {
    this.indexPath = indexPath;
  }

  /**
   * Load + verify every row. Returns `null` when the index is unusable
   * (corrupt file, missing/incompatible schema version, or ANY row checksum
   * mismatch) — the caller must fall back to the authoritative store path and
   * rebuild. Never throws: every failure is a `null`.
   */
  load(): ProjectedSession[] | null {
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(this.indexPath);
      const version = db.prepare("SELECT value FROM session_projection_meta WHERE key = ?").get("schema_version");
      const format = db.prepare("SELECT value FROM session_projection_meta WHERE key = ?").get("format");
      if (
        !version || typeof version.value !== "string" || version.value !== String(PROJECTION_SCHEMA_VERSION)
        || !format || typeof format.value !== "string" || format.value !== PROJECTION_FORMAT
      ) {
        return null;
      }
      const rows = db.prepare(
        "SELECT path, id, cwd, name, parent_session_path, created_ms, modified_ms, message_count, "
        + "first_message, file_mtime_ms, file_size, checksum FROM session_projection",
      ).all() as unknown as DbRow[];
      const out: ProjectedSession[] = [];
      for (const raw of rows) {
        const row = dbRowToProjected(raw);
        if (rowChecksum(row) !== raw.checksum) return null;
        out.push(row);
      }
      return out;
    } catch {
      return null;
    } finally {
      try { db?.close(); } catch { /* best-effort */ }
    }
  }

  /**
   * Full transactional rebuild: deletes any existing index file (including a
   * corrupt/truncated/symlinked one) and writes a fresh schema + all rows in a
   * single transaction. A crash mid-rebuild rolls back to the last committed
   * state (old valid-but-stale index, or no index) — a partial rebuild is never
   * loadable and therefore never served.
   */
  replaceAll(rows: readonly ProjectedSession[]): void {
    let db: DatabaseSync | null = null;
    try {
      // Dispose any open handle, then synchronously remove the existing file
      // (missing ok; removes a symlinked index safely without following it).
      // The deletion MUST complete before reopening, so a corrupt/truncated
      // file is never re-opened and re-written.
      try { new DatabaseSync(this.indexPath).close(); } catch { /* ignore */ }
      rmSync(this.indexPath, { force: true });
      db = new DatabaseSync(this.indexPath);
      db.exec("BEGIN");
      db.exec(
        "CREATE TABLE IF NOT EXISTS session_projection_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      );
      db.exec(
        "CREATE TABLE IF NOT EXISTS session_projection ("
        + "path TEXT PRIMARY KEY, id TEXT NOT NULL, cwd TEXT NOT NULL, name TEXT, "
        + "parent_session_path TEXT, created_ms INTEGER, modified_ms INTEGER NOT NULL, "
        + "message_count INTEGER NOT NULL, first_message TEXT NOT NULL, "
        + "file_mtime_ms REAL NOT NULL, file_size INTEGER NOT NULL, checksum TEXT NOT NULL)",
      );
      const insertMeta = db.prepare("INSERT OR REPLACE INTO session_projection_meta (key, value) VALUES (?, ?)");
      insertMeta.run("schema_version", String(PROJECTION_SCHEMA_VERSION));
      insertMeta.run("format", PROJECTION_FORMAT);
      const insert = db.prepare(
        "INSERT INTO session_projection (path, id, cwd, name, parent_session_path, created_ms, "
        + "modified_ms, message_count, first_message, file_mtime_ms, file_size, checksum) "
        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const row of rows) {
        insert.run(
          row.path,
          row.id,
          row.cwd,
          row.name ?? null,
          row.parentSessionPath ?? null,
          row.createdMs,
          row.modifiedMs,
          row.messageCount,
          row.firstMessage,
          row.mtimeMs,
          row.size,
          rowChecksum(row),
        );
      }
      db.exec("COMMIT");
    } catch {
      try { db?.exec("ROLLBACK"); } catch { /* ignore */ }
      // Persistence is best-effort: the caller still serves the (correct)
      // in-memory result and the next cold scan retries the rebuild.
    } finally {
      try { db?.close(); } catch { /* best-effort */ }
    }
  }

  /** Transactional incremental update: upsert changed/new rows, delete missing paths. */
  applyDelta(upserts: readonly ProjectedSession[], removals: readonly string[]): void {
    if (upserts.length === 0 && removals.length === 0) return;
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(this.indexPath);
      db.exec("BEGIN");
      const upsert = db.prepare(
        "INSERT OR REPLACE INTO session_projection (path, id, cwd, name, parent_session_path, created_ms, "
        + "modified_ms, message_count, first_message, file_mtime_ms, file_size, checksum) "
        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const row of upserts) {
        upsert.run(
          row.path,
          row.id,
          row.cwd,
          row.name ?? null,
          row.parentSessionPath ?? null,
          row.createdMs,
          row.modifiedMs,
          row.messageCount,
          row.firstMessage,
          row.mtimeMs,
          row.size,
          rowChecksum(row),
        );
      }
      const del = db.prepare("DELETE FROM session_projection WHERE path = ?");
      for (const path of removals) del.run(path);
      db.exec("COMMIT");
    } catch {
      try { db?.exec("ROLLBACK"); } catch { /* ignore */ }
      // Best-effort persist; the served in-memory result stays correct and the
      // next cold scan re-applies the same delta or rebuilds.
    } finally {
      try { db?.close(); } catch { /* best-effort */ }
    }
  }
}

/**
 * lstat-based identity of a session file. Returns null for a missing path or a
 * non-regular file (symlink/dir/other). For a regular file returns
 * `{ mtimeMs, size }` (sub-ms mtime precision via `mtimeMs`).
 */
export interface ProjectionFileIdentity {
  mtimeMs: number;
  size: number;
}

async function fileIdentity(path: string): Promise<ProjectionFileIdentity | null> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile()) return null;
    return { mtimeMs: stats.mtimeMs, size: stats.size };
  } catch {
    return null;
  }
}

/**
 * Parse one session JSONL file into a {@link ProjectedSession}, mirroring the
 * pinned SDK 0.84.0 `buildSessionInfo` field semantics EXACTLY (see the module
 * docstring). Returns null when the file is not a well-formed session (missing
 * header / non-regular / unreadable) — the same skip semantics as the SDK.
 */
export async function parseSessionFile(path: string): Promise<ProjectedSession | null> {
  let identity: ProjectionFileIdentity | null;
  let content: string;
  try {
    identity = await fileIdentity(path);
    if (identity === null) return null;
    content = await readFile(path, "utf8");
  } catch {
    return null;
  }
  let header: Record<string, unknown> | null = null;
  let messageCount = 0;
  let firstMessage = "";
  const allMessages: string[] = [];
  let name: string | undefined;
  let lastActivityTime: number | undefined;
  for (const rawLine of content.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(rawLine);
    } catch {
      continue; // skip malformed lines (SDK parseSessionEntryLine)
    }
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (header === null) {
      if (record.type !== "session") return null;
      header = record;
      continue;
    }
    if (record.type === "session_info") {
      // Latest session_info name, trimmed; blank clears (SDK buildSessionInfo).
      const rawName = record.name;
      const trimmed = typeof rawName === "string" ? rawName.trim() : "";
      name = trimmed.length > 0 ? trimmed : undefined;
    }
    if (record.type !== "message") continue;
    messageCount += 1;
    const activityTime = messageActivityTime(record);
    if (typeof activityTime === "number") {
      lastActivityTime = Math.max(lastActivityTime ?? 0, activityTime);
    }
    const message = record.message;
    if (!isMessageWithContent(message)) continue;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const textContent = extractTextContent(message);
    if (!textContent) continue;
    allMessages.push(textContent);
    if (!firstMessage && message.role === "user") firstMessage = textContent;
  }
  if (header === null) return null;
  const cwd = typeof header.cwd === "string" ? header.cwd : "";
  const parentSessionPath = typeof header.parentSession === "string" ? header.parentSession : undefined;
  const headerTime = typeof header.timestamp === "string" ? new Date(header.timestamp).getTime() : NaN;
  const createdMs = Number.isNaN(headerTime) ? null : headerTime;
  const modifiedMs = typeof lastActivityTime === "number" && lastActivityTime > 0
    ? lastActivityTime
    : !Number.isNaN(headerTime)
      ? headerTime
      : identity.mtimeMs;
  const id = typeof header.id === "string" ? header.id : "";
  if (id.length === 0) return null;
  return {
    id,
    path,
    cwd,
    ...(name === undefined ? {} : { name }),
    ...(parentSessionPath === undefined ? {} : { parentSessionPath }),
    createdMs,
    modifiedMs,
    messageCount,
    firstMessage: firstMessage || "(no messages)",
    mtimeMs: identity.mtimeMs,
    size: identity.size,
  };
}

/** Mirror of the SDK's `getMessageActivityTime`. */
function messageActivityTime(entry: Record<string, unknown>): number | undefined {
  const message = entry.message;
  if (!isMessageWithContent(message)) return undefined;
  if (message.role !== "user" && message.role !== "assistant") return undefined;
  if (typeof message.timestamp === "number") return message.timestamp;
  const timestamp = entry.timestamp;
  if (typeof timestamp !== "string") return undefined;
  const t = new Date(timestamp).getTime();
  return Number.isNaN(t) ? undefined : t;
}

/** Mirror of the SDK's `isMessageWithContent`. */
function isMessageWithContent(message: unknown): message is { role: string; content: unknown; timestamp?: unknown } {
  return (
    typeof message === "object"
    && message !== null
    && typeof (message as { role?: unknown }).role === "string"
    && "content" in (message as Record<string, unknown>)
  );
}

/** Mirror of the SDK's `extractTextContent`. */
function extractTextContent(message: { role: string; content: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => (
      typeof block === "object"
      && block !== null
      && (block as { type?: unknown }).type === "text"
      && typeof (block as { text?: unknown }).text === "string"
    ))
    .map((block) => block.text)
    .join(" ");
}

/**
 * Enumerate the session JSONL files for a store scope, mirroring the SDK's
 * `listAll` enumeration exactly:
 *   - explicit `sessionDir` → flat `<sessionDir>/*.jsonl` (mirror
 *     `listSessionsFromDir`);
 *   - global scope → `<agentDir>/sessions/<dir>/*.jsonl` over the immediate
 *     subdirectories/symlinks (mirror `listAll`).
 * Returns null when the scope cannot be reliably enumerated (any readdir error
 * other than a genuinely-missing top-level dir) so the caller falls back to the
 * authoritative store path (fail-closed: never serve a list the projection
 * could not fully enumerate).
 */
export async function enumerateSessionFiles(sessionDir?: string): Promise<string[] | null> {
  if (sessionDir !== undefined) {
    let entries: string[];
    try {
      entries = await readdir(sessionDir);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return [];
      return null;
    }
    return entries.filter((name) => name.endsWith(".jsonl")).map((name) => join(sessionDir, name));
  }
  const sessionsDir = join(getAgentDir(), "sessions");
  let top: Dirent[];
  try {
    top = await readdir(sessionsDir, { withFileTypes: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) return [];
    return null;
  }
  const files: string[] = [];
  for (const entry of top) {
    if (!(entry.isDirectory() || entry.isSymbolicLink())) continue;
    const dir = join(sessionsDir, entry.name);
    let sub: string[];
    try {
      sub = await readdir(dir);
    } catch {
      return null; // cannot reliably enumerate → fall back (fail-closed)
    }
    for (const name of sub) {
      if (name.endsWith(".jsonl")) files.push(join(dir, name));
    }
  }
  return files;
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === code
  );
}

/**
 * Reconcile a loaded projection against the current filesystem state:
 *   - keep rows whose file identity (mtimeMs+size) is unchanged;
 *   - re-read (parse) new/changed regular files with bounded concurrency;
 *   - drop rows whose file is gone and files the SDK would skip (parse null);
 *   - persist the delta transactionally (best-effort);
 *   - return the reconciled rows sorted by `modifiedMs` desc (SDK list order).
 * Returns null when the scan must fall back to the authoritative store path
 * (unreliable enumeration or any non-regular session file present).
 */
export async function reconcileProjection(
  index: SessionProjectionIndex,
  sessionDir: string | undefined,
  rows: readonly ProjectedSession[],
  parseFile: (path: string) => Promise<ProjectedSession | null> = parseSessionFile,
): Promise<readonly ProjectedSession[] | null> {
  const files = await enumerateSessionFiles(sessionDir);
  if (files === null) return null;
  const identities = await Promise.all(files.map(async (path) => ({ path, identity: await fileIdentity(path) })));

  const rowByPath = new Map(rows.map((row) => [row.path, row]));
  const upserts: ProjectedSession[] = [];
  const removals: string[] = [];
  const seen = new Set<string>();

  // Classify every enumerated file.
  for (const { path, identity } of identities) {
    if (identity === null) {
      // Missing or non-regular. Missing = legitimately removed (drop any stale
      // row below). Non-regular = cannot trust mtime/size projection → fall
      // back to the authoritative path (fail-closed).
      const exists = await fileExists(path);
      if (exists) return null;
      continue;
    }
    seen.add(path);
    const row = rowByPath.get(path);
    if (row && row.mtimeMs === identity.mtimeMs && row.size === identity.size) continue;
    const parsed = await parseFile(path);
    if (parsed === null) {
      removals.push(path); // SDK would skip this file → drop any stale row
      continue;
    }
    upserts.push(parsed);
  }
  for (const row of rows) {
    if (!seen.has(row.path)) removals.push(row.path);
  }

  if (upserts.length > 0 || removals.length > 0) {
    index.applyDelta(upserts, removals);
  }

  // Build the served set in memory: validated rows + fresh parses − removals.
  const fresh = new Map(rowByPath);
  for (const row of upserts) fresh.set(row.path, row);
  for (const path of removals) fresh.delete(path);
  const reconciled = [...fresh.values()];
  reconciled.sort((a, b) => b.modifiedMs - a.modifiedMs);
  return reconciled;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure the Pix-owned projection directory exists with §58 discipline, using
 * the local-authority primitives exactly like sessiond's local-posix.ts: first
 * canonicalize the absolute path (resolves the macOS `/var` → `/private/var`
 * system alias and rejects symlinked intermediates), then run the
 * `ensurePrivateDirectory` walk — an existing directory is validate-only
 * (current-user owned, exact 0700, real non-symlink dir, never chmod'd); a
 * missing directory is created component-by-component 0700 with fd-identity
 * pinning. Returns the canonical directory path. Throws a fixed
 * `LocalAuthorityError` (never a raw path/errno) on any unsafe layout.
 */
export async function ensureProjectionDirectory(dir: string): Promise<string> {
  const canonical = await canonicalizeAbsolutePath(dir);
  const result = await ensurePrivateDirectory(canonical);
  return result.path;
}

/**
 * Default Pix-owned projection directory for a store scope:
 *   - explicit `sessionDir` → `<dirname(sessionDir)>/.pix` (a hidden sibling,
 *     scoped to the session dir; tests' temp roots clean it up with the root);
 *   - global scope → `<agentDir>/pix` (under the SDK agent dir).
 */
export async function defaultProjectionDirectory(sessionDir?: string): Promise<string> {
  if (sessionDir !== undefined) {
    return join(dirname(sessionDir), DEFAULT_SESSION_DIR_PROJECTION_DIR_NAME);
  }
  return join(getAgentDir(), DEFAULT_AGENT_PROJECTION_DIR_NAME);
}

/** Build a persisted row from an SDK SessionInfo + its current file identity. */
export async function projectInfo(
  info: { id: string; path: string; cwd: string; name?: string; parentSessionPath?: string; created: Date; modified: Date; messageCount: number; firstMessage: string },
): Promise<ProjectedSession | null> {
  const identity = await fileIdentity(info.path);
  if (identity === null) return null; // missing/non-regular → cannot persist a row
  const createdMs = Number.isNaN(info.created.getTime()) ? null : info.created.getTime();
  return {
    id: info.id,
    path: info.path,
    cwd: info.cwd,
    ...(info.name === undefined ? {} : { name: info.name }),
    ...(info.parentSessionPath === undefined ? {} : { parentSessionPath: info.parentSessionPath }),
    createdMs,
    modifiedMs: info.modified.getTime(),
    messageCount: info.messageCount,
    firstMessage: info.firstMessage,
    mtimeMs: identity.mtimeMs,
    size: identity.size,
  };
}

export function defaultProjectionIndexPath(dir: string): string {
  return join(dir, PROJECTION_INDEX_FILENAME);
}
