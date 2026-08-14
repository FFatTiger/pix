import { dirname, isAbsolute, join, resolve } from "node:path";
import { lstat, mkdir, realpath, rmdir, stat } from "node:fs/promises";
import type { Context, Hono } from "hono";
import type { HostEnv } from "../env.js";
import { HttpError } from "../errors.js";
import { unregisterTrustedCreatedRoot, type AllowedRootService } from "../resources/allowed-roots.js";
import type { ManagedWorktreesService } from "../resources/managed-worktrees.js";
import { ManagedWorktreesLedgerError } from "../resources/managed-worktrees-ledger.js";
import { createProcessRunner, type ProcessRunner } from "../resources/process-runner.js";
import type { ResourceLimits, MutationGuard, WorktreeBusyPreflight } from "../resources/types.js";
import { readJsonObject } from "../resources/request-body.js";
import { KeyedMutex } from "../resources/mutex.js";

import type { HostLogger } from "../types.js";

const repositoryMutations = new KeyedMutex();

/**
 * Worktree route deps (D3A managed-worktree route integration).
 *
 * `managedWorktrees` is the ONLY delete authority and is REQUIRED for POST/DELETE
 * in production. When absent, POST/DELETE fail closed BEFORE any Git/filesystem
 * effect (a generic composition must never accidentally mount unsafe writes);
 * GET stays read-only with `managedByPix: false`. The production composition
 * always wires the managed service over the shared host-state lease.
 */
interface WorktreeDeps {
  roots: AllowedRootService;
  runner?: ProcessRunner;
  busyPreflight?: WorktreeBusyPreflight;
  mutationGuard?: MutationGuard;
  managedWorktrees?: ManagedWorktreesService;
  limits?: ResourceLimits;
  logger?: HostLogger;
}
interface Worktree { path: string; branch: string | null; isMain: boolean }
interface CreateLedger {
  createdBase: boolean;
  createdBranch: boolean;
  addedWorktree: boolean;
}

async function json(c: Context<HostEnv>): Promise<Record<string, unknown>> { return readJsonObject(c); }

function safeBranch(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 255 || value.trim() !== value || value.startsWith("-") || /[\0\s~^:?*[\\]/.test(value) || value.includes("..") || value.endsWith(".") || value.endsWith("/") || value.includes("//") || value.includes("@{")) {
    throw new HttpError(400, "INVALID_BRANCH", "Invalid branch name");
  }
  return value;
}

/**
 * Run a git command with sanitized failure semantics. HttpError outcomes
 * (abort/timeout/output-limit) keep their fixed sanitized codes; any other
 * runner failure maps to a fixed sanitized code. Raw stderr/paths/branches
 * NEVER leak into error messages.
 */
async function runGit(
  runner: ProcessRunner,
  args: readonly string[],
  max: number,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number; truncated: boolean }> {
  try {
    return await runner.run({ command: "git", args, maxOutputBytes: max, ...(signal ? { signal } : {}) });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "WORKTREE_COMMAND_FAILED", "Git command failed");
  }
}

async function repoRoot(runner: ProcessRunner, cwd: string, max: number, signal?: AbortSignal): Promise<string> {
  const result = await runGit(runner, ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], max, signal);
  if (result.exitCode !== 0) throw new HttpError(400, "WORKTREE_REPO_UNAVAILABLE", "Unable to resolve repository");
  return realpath(dirname(result.stdout.trim()));
}

async function repoIdentity(runner: ProcessRunner, cwd: string, max: number, signal?: AbortSignal): Promise<{ root: string; key: string }> {
  const root = await repoRoot(runner, cwd, max, signal);
  const info = await stat(root);
  return { root, key: `${root}\0${info.dev}:${info.ino}` };
}

async function list(runner: ProcessRunner, cwd: string, max: number, signal?: AbortSignal): Promise<Worktree[]> {
  const result = await runGit(runner, ["-C", cwd, "worktree", "list", "--porcelain", "-z"], max, signal);
  if (result.exitCode !== 0) throw new HttpError(400, "WORKTREE_LIST_FAILED", "Unable to list worktrees");
  const worktrees: Worktree[] = [];
  let current: { path?: string; branch?: string | null; prunable?: boolean } = {};
  const flush = () => { if (current.path && !current.prunable) worktrees.push({ path: current.path, branch: current.branch ?? null, isMain: worktrees.length === 0 }); current = {}; };
  for (const record of result.stdout.split("\0").filter(Boolean)) {
    for (const line of record.split("\n")) {
      if (line.startsWith("worktree ")) { flush(); current.path = line.slice(9); }
      else if (line.startsWith("branch ")) current.branch = line.slice(7).replace(/^refs\/heads\//, "");
      else if (line === "detached") current.branch = null;
      else if (line.startsWith("prunable")) current.prunable = true;
    }
  }
  flush();
  const existing: Worktree[] = [];
  for (const item of worktrees) {
    try {
      const info = await lstat(item.path);
      if (info.isDirectory() && !info.isSymbolicLink()) existing.push({ ...item, path: await realpath(item.path) });
    } catch { /* stale */ }
  }
  return existing;
}

function dirName(branch: string): string {
  const value = branch.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!value) throw new HttpError(400, "INVALID_BRANCH", "Branch cannot form a safe directory name");
  return value.slice(0, 120);
}

async function branchExists(runner: ProcessRunner, root: string, branch: string, max: number, signal?: AbortSignal): Promise<boolean> {
  const result = await runGit(runner, ["-C", root, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`], max, signal);
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw new HttpError(400, "BRANCH_PROBE_FAILED", "Failed to inspect branch");
}

/** Fixed code for rollback logs — never raw HttpError messages or git stderr. */
function rollbackTriggerCode(error: unknown): string {
  if (error instanceof HttpError) return error.code;
  return "WORKTREE_CREATE_FAILED";
}

/**
 * Map a managed-service/ledger failure into a fixed sanitized HttpError.
 * Non-HttpError outcomes (e.g. a managed ledger write failure) become a fixed
 * 500 with the ledger's own sanitized code; raw paths/payloads never leak.
 */
function toManagedHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof ManagedWorktreesLedgerError) {
    return new HttpError(500, error.code, "Managed worktree operation failed");
  }
  return new HttpError(500, "WORKTREE_MANAGED_FAILED", "Managed worktree operation failed");
}

/**
 * Best-effort create rollback. Returns only a failure count — never raw git
 * stderr, paths, or original error messages. Only transaction-owned resources
 * (new branch, added worktree, empty created base) are rolled back; ambiguous
 * or foreign state is never touched.
 */
async function rollbackCreate(
  runner: ProcessRunner,
  root: string,
  base: string | undefined,
  target: string | undefined,
  branch: string,
  ledger: CreateLedger,
  max: number,
): Promise<number> {
  let failureCount = 0;
  const cleanup = async (args: readonly string[]) => {
    try {
      const result = await runner.run({ command: "git", args, maxOutputBytes: max });
      if (result.exitCode !== 0) failureCount += 1;
    } catch {
      failureCount += 1;
    }
  };
  if (ledger.addedWorktree && target) await cleanup(["-C", root, "worktree", "remove", "--force", "--", target]);
  await cleanup(["-C", root, "worktree", "prune"]);
  if (ledger.createdBranch) await cleanup(["-C", root, "branch", "-D", "--", branch]);
  if (ledger.createdBase && base) {
    try { await rmdir(base); }
    catch { failureCount += 1; }
  }
  return failureCount;
}

export function registerWorktreeRoutes(app: Hono<HostEnv>, deps: WorktreeDeps): void {
  const runner = deps.runner ?? createProcessRunner();
  const max = deps.limits?.processOutputBytes ?? 8 * 1024 * 1024;

  app.get("/v1/worktrees", async (c) => {
    const cwd = c.req.query("cwd"); if (!cwd) throw new HttpError(400, "CWD_REQUIRED", "cwd is required");
    const authorized = await deps.roots.authorizeExisting(cwd, "directory");
    const root = await repoRoot(runner, authorized.canonicalPath, max, c.req.raw.signal).catch(() => null);
    if (!root) return c.json({ projectRoot: authorized.canonicalPath, isGit: false, isTopLevel: false, worktrees: [] });
    await deps.roots.authorizeExisting(root, "directory");
    const worktrees = await list(runner, authorized.canonicalPath, max, c.req.raw.signal);
    // `managedByPix` is a live managed-ownership marker (exact record + identity
    // + topology corroboration). External/planted/manual/legacy-claim-only
    // entries are always false. `authorized` is retained as the memory
    // authorization projection. No cached `safeToDelete` promise.
    const projected = await Promise.all(worktrees.map(async (worktree) => {
      const authorizedFlag = await deps.roots.isAuthorized(worktree.path, "directory");
      let managedByPix = false;
      if (deps.managedWorktrees) {
        const cls = await deps.managedWorktrees.classify(worktree.path);
        managedByPix = cls.kind === "managed" && cls.live;
      }
      return { ...worktree, authorized: authorizedFlag, managedByPix };
    }));
    return c.json({ projectRoot: root, isGit: true, isTopLevel: worktrees.some((item) => item.path === authorized.canonicalPath), worktrees: projected });
  });

  app.post("/v1/worktrees", async (c) => {
    // Production mutation guard first: worktree creation is a git write and the
    // managed service is required. Both run before any Git/filesystem effect.
    await deps.mutationGuard?.assertAvailable();
    const body = await json(c); if (typeof body.cwd !== "string") throw new HttpError(400, "CWD_REQUIRED", "cwd is required");
    // Branch validation runs before the managed-service check so malicious
    // branches are rejected with a fixed 400 even when no managed service is
    // wired (a generic composition must never reach git argv with them).
    const branch = safeBranch(body.branch);
    const managed = deps.managedWorktrees;
    if (!managed) throw new HttpError(503, "WORKTREE_MANAGED_UNAVAILABLE", "Managed worktree service unavailable");
    const authorized = await deps.roots.authorizeExisting(body.cwd, "directory");
    const initial = await repoIdentity(runner, authorized.canonicalPath, max, c.req.raw.signal);
    return repositoryMutations.runExclusive(initial.key, async () => {
      const identity = await repoIdentity(runner, authorized.canonicalPath, max, c.req.raw.signal);
      if (identity.key !== initial.key) throw new HttpError(409, "REPOSITORY_REPLACED", "Repository changed while waiting for mutation lock");
      const root = identity.root;
      await deps.roots.authorizeExisting(root, "directory");
      const base = `${resolve(root)}-worktrees`;
      let baseCanonical: string | undefined;
      let target: string | undefined;
      let managedRecordId: string | undefined;
      let managedRecordPath: string | undefined;
      const ledger: CreateLedger = { createdBase: false, createdBranch: false, addedWorktree: false };
      // All pre-state is read under the repository lock.
      const preBranch = await branchExists(runner, root, branch, max, c.req.raw.signal);
      const preWorktrees = await list(runner, root, max, c.req.raw.signal);
      const prePaths = new Set(preWorktrees.map((item) => item.path));
      try {
        try {
          const baseInfo = await lstat(base);
          if (!baseInfo.isDirectory() || baseInfo.isSymbolicLink()) throw new HttpError(409, "UNSAFE_WORKTREE_BASE", "Worktree base must be a real directory, not a symlink");
          baseCanonical = await realpath(base);
          if (baseCanonical !== resolve(base)) throw new HttpError(409, "UNSAFE_WORKTREE_BASE", "Worktree base changed identity");
        } catch (error) {
          if (error instanceof HttpError) throw error;
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await mkdir(base, { recursive: false });
          ledger.createdBase = true;
          baseCanonical = await realpath(base);
        }
        target = join(baseCanonical, dirName(branch));
        try { await lstat(target); throw new HttpError(409, "WORKTREE_EXISTS", "Worktree directory already exists"); }
        catch (error) { if (error instanceof HttpError) throw error; if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }

        const addResult = await runGit(runner, ["-C", root, "worktree", "add", ...(preBranch ? [] : ["-b", branch]), "--", target, ...(preBranch ? [branch] : [])], max, c.req.raw.signal);
        if (addResult.exitCode !== 0) {
          // Non-zero/ambiguous completion is not ownership proof. Leave any
          // observed post-state untouched rather than risking another actor's resources.
          throw new HttpError(400, "WORKTREE_CREATE_FAILED", "Failed to create worktree");
        }
        // An explicit successful git add is ownership proof for the requested
        // target and, when -b was used, the new branch. Later validation
        // failures must roll these transaction-owned resources back.
        ledger.createdBranch = !preBranch;
        ledger.addedWorktree = true;
        const postBranch = await branchExists(runner, root, branch, max, c.req.raw.signal);
        const postWorktrees = await list(runner, root, max, c.req.raw.signal);
        const postTarget = postWorktrees.find((item) => item.path === resolve(target!));
        if (!postBranch || !postTarget || prePaths.has(postTarget.path)) throw new HttpError(409, "WORKTREE_VERIFY_FAILED", "Git did not report a transaction-owned worktree");

        const targetInfo = await lstat(target);
        if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink()) throw new HttpError(409, "UNSAFE_WORKTREE_TARGET", "Git created an unsafe worktree target");
        if (await realpath(base) !== baseCanonical) throw new HttpError(409, "UNSAFE_WORKTREE_BASE", "Worktree base was replaced during creation");
        const canonical = await realpath(target);
        if (dirname(canonical) !== baseCanonical) throw new HttpError(409, "UNSAFE_WORKTREE_TARGET", "Worktree target escaped its verified base");
        // Capture exact managed evidence, persist the managed record (disk
        // FIRST), then publish memory authorization. NO trusted-root claim is
        // created for a new managed worktree — the managed record is the only
        // ownership. Only 201 after memory+ledger commit.
        const record = await managed.recordCreated({
          path: canonical,
          branchAtCreate: branch,
          branchCreatedByPix: !preBranch,
        });
        managedRecordId = record.worktreeId;
        managedRecordPath = record.path;
        // Final topology/auth check while both repo lock and roots mutation are held in order.
        const committed = await list(runner, root, max, c.req.raw.signal);
        if (!committed.some((item) => item.path === canonical) || !(await deps.roots.isAuthorized(canonical, "directory"))) {
          throw new HttpError(409, "WORKTREE_COMMIT_UNSTABLE", "Worktree transaction did not reach a stable commit");
        }
        return c.json({ path: canonical, branch, managedByPix: true }, 201);
      } catch (error) {
        // If the managed record persisted but later publication/final check
        // failed, remove the EXACT record (disk + memory) BEFORE git rollback.
        // Incomplete cleanup must report a fixed failure, never a false 201.
        if (managedRecordId && managedRecordPath) {
          try {
            await managed.commitRemoved(managedRecordId, managedRecordPath);
          } catch {
            deps.logger?.error?.("worktree managed cleanup incomplete", { code: rollbackTriggerCode(error) });
          }
        }
        // Rejected/timeout/output-limit commands are ambiguous and therefore
        // never grant ownership beyond operations that returned explicit success.
        const rollbackFailures = await rollbackCreate(runner, root, baseCanonical, target, branch, ledger, max);
        if (rollbackFailures > 0) {
          deps.logger?.error?.("worktree create rollback incomplete", {
            code: rollbackTriggerCode(error),
            rollbackFailureCount: rollbackFailures,
          });
        }
        throw toManagedHttpError(error);
      }
    }, c.req.raw.signal);
  });

  app.delete("/v1/worktrees", async (c) => {
    // Production mutation guard first: worktree removal is a git write and the
    // managed service is required. The busy preflight below still runs (force
    // cannot bypass either), so a down authority 503s before touching the repo.
    await deps.mutationGuard?.assertAvailable();
    const managed = deps.managedWorktrees;
    if (!managed) throw new HttpError(503, "WORKTREE_MANAGED_UNAVAILABLE", "Managed worktree service unavailable");
    const body = await json(c); if (typeof body.cwd !== "string" || typeof body.path !== "string") throw new HttpError(400, "WORKTREE_INPUT_REQUIRED", "cwd and path are required");
    // DELETE requires an absolute canonical target path.
    if (!isAbsolute(body.path)) throw new HttpError(400, "WORKTREE_PATH_ABSOLUTE", "path must be absolute");
    const authorized = await deps.roots.authorizeExisting(body.cwd, "directory");
    const initial = await repoIdentity(runner, authorized.canonicalPath, max, c.req.raw.signal);
    return repositoryMutations.runExclusive(initial.key, async () => {
      const identity = await repoIdentity(runner, authorized.canonicalPath, max, c.req.raw.signal);
      if (identity.key !== initial.key) throw new HttpError(409, "REPOSITORY_REPLACED", "Repository changed while waiting for mutation lock");
      await deps.roots.authorizeExisting(identity.root, "directory");
      const target = await realpath(body.path as string).catch(() => { throw new HttpError(404, "WORKTREE_NOT_FOUND", "Worktree not found"); });
      const worktrees = await list(runner, identity.root, max, c.req.raw.signal);
      const candidate = worktrees.find((item) => item.path === target);
      if (!candidate) throw new HttpError(403, "NOT_PROJECT_WORKTREE", "Path is not a worktree of this repository");
      if (candidate.isMain) throw new HttpError(409, "MAIN_WORKTREE", "Cannot remove the main worktree");
      const mainWorktree = worktrees.find((item) => item.isMain);
      // Managed ownership is the ONLY delete authority: an exact live record
      // whose repo/path/common/admin/base identities corroborate. `authorized`
      // or a legacy trusted claim alone never suffices.
      const authority = await managed.findLiveAuthority(target);
      if (!authority || !authority.live || authority.record.repoRoot !== identity.root) {
        throw new HttpError(403, "WORKTREE_NOT_MANAGED", "Only Pix-managed worktrees can be removed");
      }
      if (!deps.busyPreflight) throw new HttpError(503, "BUSY_PREFLIGHT_UNAVAILABLE", "Cannot safely remove a worktree while busy preflight is unavailable");
      // Busy preflight: rejects the exact cwd OR any active session cwd
      // contained beneath the target (strengthened sessiond hasBusyCwd).
      const busy = await deps.busyPreflight.check(target); if (busy.busy) throw new HttpError(409, "WORKTREE_BUSY", busy.reason ?? "Worktree has an active Agent session");
      const force = body.force === true;
      // force only bypasses dirty/untracked; it never bypasses authority,
      // identity, main, sessiond unavailable, busy, auth, or topology.
      if (!force) {
        const status = await runGit(runner, ["-C", target, "status", "--porcelain=v1", "--untracked-files=all"], max, c.req.raw.signal);
        if (status.exitCode !== 0) throw new HttpError(409, "WORKTREE_STATUS_FAILED", "Failed to inspect worktree state");
        if (status.stdout.length > 0) throw new HttpError(409, "WORKTREE_DIRTY", "Worktree contains modified or untracked files");
      }
      // Revalidate immediately before git remove: authority + topology must
      // still hold (defense against identity/ownership change between checks).
      const revalidated = await managed.findLiveAuthority(target);
      if (!revalidated || !revalidated.live || revalidated.record.repoRoot !== identity.root) {
        throw new HttpError(403, "WORKTREE_NOT_MANAGED", "Only Pix-managed worktrees can be removed");
      }
      const recheck = await list(runner, identity.root, max, c.req.raw.signal);
      const stillThere = recheck.find((item) => item.path === target);
      if (!stillThere || stillThere.isMain) throw new HttpError(409, "WORKTREE_CHANGED", "Worktree changed before removal");

      const removeResult = await runGit(runner, ["-C", identity.root, "worktree", "remove", ...(force ? ["--force"] : []), "--", target], max, c.req.raw.signal);
      if (removeResult.exitCode !== 0) throw new HttpError(400, "WORKTREE_DELETE_FAILED", "Failed to remove worktree");
      // Verify path/topology absent before durable ownership cleanup.
      let pathGone = false;
      try { await lstat(target); } catch { pathGone = true; }
      const after = await list(runner, identity.root, max, c.req.raw.signal);
      const topologyGone = !after.some((item) => item.path === target);
      if (!pathGone || !topologyGone) throw new HttpError(500, "WORKTREE_DELETE_VERIFY_FAILED", "Worktree removal could not be verified");
      // Durable ownership cleanup: remove the EXACT managed record (disk) then
      // memory authorization, and drop any stale legacy trusted claim for this
      // path. Branch and base are always preserved.
      try {
        await managed.commitRemoved(revalidated.record.worktreeId, target);
      } catch {
        // Git succeeded but durable ownership cleanup failed: fixed sanitized
        // 500, never a false success. Restart reconcile drops the stale row.
        throw new HttpError(500, "WORKTREE_DELETE_COMMIT_INCOMPLETE", "Worktree removed but ownership cleanup incomplete");
      }
      await unregisterTrustedCreatedRoot(deps.roots, target);
      const fallbackCwd = mainWorktree?.path ?? identity.root;
      return c.json({ success: true, fallbackCwd, branchRetained: true });
    }, c.req.raw.signal);
  });
}
