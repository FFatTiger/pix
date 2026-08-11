import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
    endpoint: process.platform === "win32" ? `\\\\.\\pipe\\pi-web-sessiond-${Buffer.from(directory).toString("hex").slice(0, 24)}` : join(directory, "sessiond.sock"),
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

export async function loadOrCreateLocalSecret(paths: SessiondPaths): Promise<string> {
  await ensurePrivateDirectory(dirname(paths.secretFile));
  try {
    const info = await lstat(paths.secretFile);
    if (!info.isFile() || info.isSymbolicLink()) throw new SessiondError("forbidden", "unsafe sessiond secret file");
    const secret = (await readFile(paths.secretFile, "utf8")).trim();
    if (secret.length < 32) throw new SessiondError("internal", "invalid sessiond secret");
    await chmod(paths.secretFile, 0o600);
    return secret;
  } catch (error) {
    if (error instanceof SessiondError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const secret = randomBytes(32).toString("base64url");
  const temporary = `${paths.secretFile}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${secret}\n`, { mode: 0o600, flag: "wx" });
  try {
    await open(paths.secretFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600).then(async (handle) => {
      try { await handle.writeFile(`${secret}\n`); await handle.sync(); }
      finally { await handle.close(); }
    });
    await chmod(paths.secretFile, 0o600);
    return secret;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return (await readFile(paths.secretFile, "utf8")).trim();
    throw error;
  } finally {
    await rm(temporary, { force: true });
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
