import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, readFile, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { SessiondError } from "./errors.js";

export interface SessiondPaths {
  directory: string;
  endpoint: string;
  lockFile: string;
  secretFile: string;
}

export interface InstanceLock {
  instanceId: string;
  release(): Promise<void>;
}

/** Persisted contents of `sessiond.lock`; the pid lets B4 reach a live daemon. */
export interface InstanceLockRecord {
  pid: number;
  instanceId: string;
  createdAt: number;
}

/**
 * Read the on-disk instance lock without claiming it. Returns `undefined` when
 * no lock exists or the payload is unreadable/corrupt — a narrow, side-effect
 * free view for B4 supervision (ensure / reuse / down-all).
 */
export async function readInstanceLock(paths: SessiondPaths): Promise<InstanceLockRecord | undefined> {
  let text: string;
  try {
    text = await readFile(paths.lockFile, "utf8");
  } catch {
    /* No lock (ENOENT) or unreadable: treat as absent. */
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as Partial<InstanceLockRecord>;
    if (typeof parsed.pid !== "number" || typeof parsed.instanceId !== "string") return undefined;
    return { pid: parsed.pid, instanceId: parsed.instanceId, createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : 0 };
  } catch {
    return undefined;
  }
}

/** True when the lock names a process that is still alive (pid 0 probe). */
export async function instanceAlive(paths: SessiondPaths): Promise<boolean> {
  const lock = await readInstanceLock(paths);
  return lock !== undefined && pidAlive(lock.pid);
}

export function sessiondPaths(directory: string): SessiondPaths {
  return {
    directory,
    endpoint: process.platform === "win32" ? `\\\\.\\pipe\\pix-sessiond-${Buffer.from(directory).toString("hex").slice(0, 24)}` : join(directory, "sessiond.sock"),
    lockFile: join(directory, "sessiond.lock"),
    secretFile: join(directory, "sessiond.secret"),
  };
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new SessiondError("forbidden", "sessiond directory is not a private directory");
}

function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export async function acquireInstanceLock(paths: SessiondPaths): Promise<InstanceLock> {
  await ensurePrivateDirectory(paths.directory);
  const instanceId = randomUUID();
  const payload = JSON.stringify({ pid: process.pid, instanceId, createdAt: Date.now() });
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(paths.lockFile, flags, 0o600);
      try { await handle.writeFile(payload); await handle.sync(); }
      finally { await handle.close(); }
      await chmod(paths.lockFile, 0o600);
      let released = false;
      return {
        instanceId,
        async release() {
          if (released) return;
          released = true;
          try {
            const current = JSON.parse(await readFile(paths.lockFile, "utf8")) as { instanceId?: string };
            if (current.instanceId === instanceId) await rm(paths.lockFile, { force: true });
          } catch { /* lock already gone or replaced */ }
        },
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" || attempt > 0) throw new SessiondError("conflict", "another sessiond instance is running");
      try {
        const info = await lstat(paths.lockFile);
        if (!info.isFile() || info.isSymbolicLink()) throw new SessiondError("forbidden", "unsafe sessiond lock file");
        const current = JSON.parse(await readFile(paths.lockFile, "utf8")) as { pid?: number };
        if (typeof current.pid === "number" && pidAlive(current.pid)) throw new SessiondError("conflict", "another sessiond instance is running");
        await rm(paths.lockFile, { force: true });
      } catch (staleError) {
        if (staleError instanceof SessiondError) throw staleError;
        await rm(paths.lockFile, { force: true });
      }
    }
  }
  throw new SessiondError("conflict", "could not acquire sessiond lock");
}

/** Minimum secret entropy, in bytes, before base64url encoding. */
const SECRET_MIN_BYTES = 32;
/** Suffix (and naming pattern) for in-progress publish temps. */
const SECRET_TEMP_SUFFIX = ".tmp";

/**
 * Test-only hooks for {@link loadOrCreateLocalSecret}. `beforePublish` fires
 * after the temp is fully written and fsynced, immediately before the atomic
 * link publish — throw from it to deterministically simulate a crash between
 * write and publish.
 */
export interface LocalSecretTestHooks {
  beforePublish?: () => void | Promise<void>;
}

/**
 * Load the local sessiond secret, creating it atomically on first use.
 *
 * Crash-safety / race-safety guarantees:
 *   - `final` is published only via `link(temp, final)`, which is atomic and
 *     refuses to replace an existing file (EEXIST). So `final` is always either
 *     absent or complete — never a 0-byte / partial file. (The legacy code
 *     opened `final` with O_CREAT|O_EXCL and then wrote into it, which left a
 *     0-byte `final` on interruption and permanently bricked the daemon.)
 *   - The full secret is written to a unique temp (`wx`, 0o600) and fsynced for
 *     durability before publishing.
 *   - Concurrent creators converge: the loser of the `link` race adopts the
 *     winner's already-published secret instead of overwriting it.
 *   - On entry, stale temps from dead processes (this naming pattern only) are
 *     swept; a live owner's temp is left untouched.
 *   - Self-heal: a 0-byte `final` can only be legacy-publish debris (this code
 *     never writes `final` directly). When the daemon holds the instance lock it
 *     is sole owner, so a 0-byte regular non-symlink `final` is removed and
 *     rebuilt. Any other malformed `final` (non-zero, unreadable) is fail-closed.
 */
export async function loadOrCreateLocalSecret(paths: SessiondPaths, hooks: LocalSecretTestHooks = {}): Promise<string> {
  await ensurePrivateDirectory(dirname(paths.secretFile));
  await sweepStaleSecretTemps(paths);
  for (let attempt = 0; ; attempt += 1) {
    const existing = await readExistingSecret(paths);
    if (existing !== undefined) return existing;
    if (attempt > 8) throw new SessiondError("conflict", "sessiond secret publish did not converge");
    const secret = randomBytes(SECRET_MIN_BYTES).toString("base64url");
    const temp = `${paths.secretFile}.${process.pid}.${randomUUID()}${SECRET_TEMP_SUFFIX}`;
    try {
      const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        await handle.writeFile(`${secret}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await hooks.beforePublish?.();
      try {
        await link(temp, paths.secretFile);
        return secret; // published; temp removed in finally (hard link → final keeps the inode)
      } catch (error) {
        // Lost the race: another process published a complete secret first.
        // Loop and adopt theirs rather than overwriting.
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } finally {
      // Temp removal must never disrupt a successful publish (or mask its error);
      // force:true already ignores ENOENT, so this only swallows exotic failures.
      await rm(temp, { force: true }).catch(() => {});
    }
  }
}

/**
 * Read and validate an existing `final`. Returns the secret, or `undefined`
 * when no secret exists yet (caller should create). Self-heals a 0-byte
 * legacy-debris `final`; fails closed on symlinks, non-regular files, and
 * non-zero malformed content.
 */
async function readExistingSecret(paths: SessiondPaths): Promise<string | undefined> {
  const info = await lstat(paths.secretFile).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (info === undefined) return undefined;
  if (info.isSymbolicLink() || !info.isFile()) throw new SessiondError("forbidden", "unsafe sessiond secret file");
  if (info.size === 0) {
    // Legacy non-atomic publish debris; safe to rebuild under the instance lock.
    await rm(paths.secretFile, { force: true });
    return undefined;
  }
  const secret = (await readFile(paths.secretFile, "utf8")).trim();
  if (secret.length < SECRET_MIN_BYTES) throw new SessiondError("internal", "invalid sessiond secret");
  await chmod(paths.secretFile, 0o600);
  return secret;
}

/**
 * Best-effort sweep of in-progress publish temps that match this module's
 * naming pattern (`<secretFile>.<pid>.<uuid>.tmp`) and whose owning pid is no
 * longer alive. A live owner's temp (same or recycled pid) is always left in
 * place, so concurrent publishers never disrupt each other.
 */
async function sweepStaleSecretTemps(paths: SessiondPaths): Promise<void> {
  const dir = dirname(paths.secretFile);
  const prefix = `${basename(paths.secretFile)}.`;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith(SECRET_TEMP_SUFFIX)) continue;
    const middle = entry.slice(prefix.length, entry.length - SECRET_TEMP_SUFFIX.length);
    const pid = Number(middle.split(".")[0]);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue; // not our pattern
    if (pidAlive(pid)) continue; // owner may still be writing/publishing
    const candidate = join(dir, entry);
    try {
      const info = await lstat(candidate);
      if (!info.isFile() || info.isSymbolicLink()) continue; // only sweep regular files
      await rm(candidate, { force: true });
    } catch {
      /* best-effort; a concurrent sweeper may have removed it */
    }
  }
}

/**
 * Remove a stale Unix domain socket before listen. Safe only after the
 * instance lock is held, because the lock guarantees no other daemon can be
 * listening — so any leftover socket file is debris from a crashed instance.
 * Windows named pipes do not leave files behind and are left untouched.
 */
export async function clearStaleSocket(paths: SessiondPaths): Promise<void> {
  if (process.platform === "win32") return;
  let info;
  try {
    info = await lstat(paths.endpoint);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!info.isSocket()) return;
  await rm(paths.endpoint, { force: true });
}
