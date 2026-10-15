/**
 * @fffattiger/pix-local-authority — Pix attachments store primitives.
 *
 * Single owner of the on-disk shape of the Pix-managed attachments directory
 * (`<home>/.pi/pix/attachments` by default, overridable with
 * `PIX_ATTACHMENTS_DIR` for tests/embedded deployments). Two writers share
 * this store through the SAME primitives, never forked:
 *
 *   - sessiond persists inline message images content-addressed under
 *     `attachments/<sessionId>/<sha256-16>.<ext>` (reuse, never duplicate);
 *   - host `/v1/attachments` uploads user files under
 *     `attachments/<sessionId>/<timestamp>-<rand>-<name>` or, before a session
 *     id exists (new-session first send), under `attachments/unfiled/`.
 *
 * Scope directories are 0700 and files 0600 (POSIX; no-ops on win32).
 * Publication is atomic (unique same-dir temp written + fsynced, then linked;
 * `link` never replaces an existing entry, so a final path is always either
 * absent or complete). sessiond deletes `attachments/<sessionId>` when the
 * session is deleted and sweeps stale `unfiled` entries.
 *
 * This module deliberately imports only Node builtins (package boundary) and
 * knows nothing about the Protocol, sessions semantics, or HTTP.
 */
import { randomBytes } from "node:crypto";
import { chmod, link, lstat, mkdir, open, readdir, rm, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { LocalAuthorityError, hasControlChar } from "./contracts.js";

/** Environment variable overriding the attachments root (tests / embedded). */
export const ATTACHMENTS_DIR_ENV = "PIX_ATTACHMENTS_DIR";

/** Scope for uploads made before a session id exists (new-session first send). */
export const UNFILED_ATTACHMENTS_SCOPE = "unfiled";

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

/**
 * Resolve the attachments root. An explicit `PIX_ATTACHMENTS_DIR` must be an
 * absolute path (a relative override is an ambiguous, cwd-dependent store —
 * fail closed instead of guessing). Default: `~/.pi/pix/attachments`, a
 * sibling of the sessiond directory, outside every user project.
 */
export function resolveAttachmentsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[ATTACHMENTS_DIR_ENV];
  if (typeof override === "string" && override.length > 0) {
    if (!isAbsolute(override)) {
      throw new LocalAuthorityError("INVALID_PATH", `${ATTACHMENTS_DIR_ENV} must be an absolute path: ${override}`);
    }
    return override;
  }
  return join(homedir(), ".pi", "pix", "attachments");
}

/**
 * A scope token (session id or the fixed `unfiled` staging scope) is safe when
 * it is a single path component that can never traverse (`.` / `..`),
 * never contain separators, and is bounded in length.
 */
export function isSafeAttachmentScope(scope: string): boolean {
  if (scope.length === 0 || scope.length > 128) return false;
  if (scope === "." || scope === "..") return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(scope);
}

function requireSafeScope(scope: string): string {
  if (!isSafeAttachmentScope(scope)) {
    throw new LocalAuthorityError("INVALID_PATH", `unsafe attachments scope: ${JSON.stringify(scope)}`);
  }
  return scope;
}

/** Directory of a scope: `<root>/<scope>` (validated single component). */
export function attachmentScopePath(root: string, scope: string): string {
  return join(root, requireSafeScope(scope));
}

/**
 * Sanitize an original upload filename into a single safe path component:
 * strip any directory component, drop control and Windows-reserved characters,
 * collapse runs of separators/spaces, cap the length, and never return empty
 * (a name that sanitizes away entirely becomes `file`). Unicode letters are
 * preserved so the model can still recognize the original file name.
 */
export function sanitizeAttachmentFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 120)
    .trim();
  return cleaned.length > 0 ? cleaned : "file";
}

/**
 * Stored upload filename: `<yyyymmdd-hhmmss>-<6 hex>-<sanitized original>`.
 * The timestamp + random prefix makes collisions (and any need for conflict
 * resolution) practically impossible while the original name stays readable.
 */
export function formatAttachmentFileName(originalName: string, now: Date = new Date()): string {
  const pad = (value: number, width: number): string => String(value).padStart(width, "0");
  const stamp = `${pad(now.getUTCFullYear(), 4)}${pad(now.getUTCMonth() + 1, 2)}${pad(now.getUTCDate(), 2)}-${pad(now.getUTCHours(), 2)}${pad(now.getUTCMinutes(), 2)}${pad(now.getUTCSeconds(), 2)}`;
  return `${stamp}-${randomBytes(3).toString("hex")}-${sanitizeAttachmentFileName(originalName)}`;
}

function isSafeAttachmentFileName(name: string): boolean {
  if (name.length === 0 || name.length > 255) return false;
  if (name === "." || name === "..") return false;
  if (name.startsWith(".")) return false;
  if (name.includes("/") || name.includes("\\")) return false;
  return !hasControlChar(name);
}

/**
 * Ensure one store directory is a REAL directory, never a followed
 * symlink: `mkdir` silently succeeds when the path already exists as a
 * symlink (or another non-directory), so the post-create `lstat` is the
 * fail-closed gate. Every write would otherwise land outside the store while
 * the reported paths still look inside it. `chmod` stays best-effort.
 */
async function ensureRealPrivateDir(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true, mode: PRIVATE_DIR_MODE });
  } catch (error) {
    // EEXIST (e.g. a planted regular file) is classified by the lstat gate
    // below; every other failure propagates.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = await lstat(path);
  if (!info.isDirectory()) {
    throw new LocalAuthorityError("INVALID_PATH", `attachments path is not a real directory: ${path}`);
  }
  try {
    await chmod(path, PRIVATE_DIR_MODE);
  } catch {
    // chmod is a no-op on some platforms/filesystems; the mkdir mode already
    // pinned newly created directories. A real permission failure surfaces on
    // the subsequent write.
  }
}

/**
 * Create/verify the store ROOT first, then the scope directory under it, so a
 * symlinked root is rejected before any scope directory is created inside the
 * linked target.
 */
async function ensureScopeDir(root: string, scope: string): Promise<string> {
  await ensureRealPrivateDir(root);
  const dir = attachmentScopePath(root, scope);
  await ensureRealPrivateDir(dir);
  return dir;
}

export interface AttachmentFileWrite {
  /** Absolute path of the stored file. */
  path: string;
  /** True when a file already existed at the path and was NOT rewritten. */
  existed: boolean;
}

/**
 * Atomically write one attachment file into a scope directory. When the target
 * already exists as a regular file the write is skipped and `existed: true`
 * returned (content-addressed reuse); an existing non-regular entry (symlink,
 * directory) fails closed. The temp file is always removed.
 */
export async function writeAttachmentFile(options: {
  root: string;
  scope: string;
  name: string;
  data: Uint8Array;
}): Promise<AttachmentFileWrite> {
  if (!isSafeAttachmentFileName(options.name)) {
    throw new LocalAuthorityError("INVALID_PATH", `unsafe attachments file name: ${JSON.stringify(options.name)}`);
  }
  const dir = attachmentScopePath(options.root, options.scope);
  await ensureScopeDir(options.root, options.scope);
  const path = join(dir, options.name);
  const existing = await lstat(path).then(
    (info) => info,
    () => undefined,
  );
  if (existing !== undefined) {
    if (!existing.isFile()) throw new LocalAuthorityError("INVALID_PATH", `attachments target is not a regular file: ${path}`);
    return { path, existed: true };
  }
  const temp = join(dir, `.tmp-${process.pid}-${randomBytes(8).toString("hex")}`);
  try {
    const handle = await open(temp, "w", PRIVATE_FILE_MODE);
    try {
      await handle.writeFile(options.data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temp, path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "EPERM") {
        // Lost a concurrent create race: the winner's file is the same
        // content-addressed target. Fail closed on a non-regular entry.
        const winner = await lstat(path).then(
          (info) => info,
          () => undefined,
        );
        if (winner === undefined || !winner.isFile()) {
          throw new LocalAuthorityError("INVALID_PATH", `attachments target is not a regular file: ${path}`);
        }
        return { path, existed: true };
      }
      throw error;
    }
    return { path, existed: false };
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

/**
 * Verify the store ROOT is a real directory before any sweep/delete walks
 * under it: a planted (or misconfigured) symlink root would otherwise make
 * child `lstat`s look legitimate while every unlink lands outside the store.
 * Missing root → undefined (nothing to do); a non-real-directory root fails
 * closed. The write path enforces the same invariant via
 * {@link ensureRealPrivateDir}.
 */
async function realStoreRootInfo(root: string): Promise<import("node:fs").Stats | undefined> {
  const info = await lstat(root).then(
    (stats) => stats,
    () => undefined,
  );
  if (info === undefined) return undefined;
  if (!info.isDirectory()) {
    throw new LocalAuthorityError("INVALID_PATH", `attachments root is not a real directory: ${root}`);
  }
  return info;
}

/**
 * Remove an entire scope directory (session deletion cleanup). Returns false
 * when the scope has no directory. Fails closed when the store root is not a
 * real directory (the caller's cleanup treats it as best-effort). Errors
 * propagate to the caller.
 */
export async function removeAttachmentScope(root: string, scope: string): Promise<boolean> {
  if ((await realStoreRootInfo(root)) === undefined) return false;
  const dir = attachmentScopePath(root, scope);
  try {
    await rm(dir, { recursive: true, force: false });
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Sweep stale entries from the `unfiled` staging area (uploads made before a
 * session id existed whose session creation never completed). Only regular
 * files older than `maxAgeMs` are removed; subdirectories are left alone (the
 * writer never creates them). Returns the number of removed files.
 */
export async function sweepStaleUnfiledAttachments(root: string, maxAgeMs: number, now: number = Date.now()): Promise<number> {
  // The store root itself must be a real directory: a symlinked root would
  // make every child path below resolve outside the store while looking
  // legitimate. Missing root → nothing to sweep; a non-real root fails closed.
  if ((await realStoreRootInfo(root)) === undefined) return 0;
  const dir = attachmentScopePath(root, UNFILED_ATTACHMENTS_SCOPE);
  let entries: string[];
  // Never iterate a staging path that exists but is not a REAL directory: a
  // pre-planted symlink would make the sweep unlink regular files OUTSIDE the
  // store. Nothing is swept (0) — the write path fails loudly on the same
  // condition, so a planted link can never stay hidden behind a quiet sweep.
  const dirInfo = await lstat(dir).then(
    (info) => info,
    () => undefined,
  );
  if (dirInfo === undefined) return 0;
  if (!dirInfo.isDirectory()) return 0;
  try {
    entries = await readdir(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return 0;
    throw error;
  }
  const cutoff = now - maxAgeMs;
  let removed = 0;
  for (const entry of entries) {
    if (entry.startsWith(".tmp-")) continue;
    const path = join(dir, entry);
    const info = await lstat(path).then(
      (stats) => stats,
      () => undefined,
    );
    if (info === undefined || !info.isFile()) continue;
    if (info.mtimeMs >= cutoff) continue;
    await unlink(path).then(
      () => {
        removed += 1;
      },
      () => undefined,
    );
  }
  // Best-effort: drop the staging directory when the last entry is gone so a
  // long-lived daemon does not accumulate empty dirs.
  await rm(dir, { recursive: false }).catch(() => undefined);
  return removed;
}

/** Test/inspection helper: whether a scope currently has a directory. */
export async function attachmentScopeExists(root: string, scope: string): Promise<boolean> {
  return stat(attachmentScopePath(root, scope)).then(
    () => true,
    () => false,
  );
}
