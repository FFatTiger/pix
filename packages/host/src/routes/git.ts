import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Hono } from "hono";
import type { HostEnv } from "../env.js";
import { HttpError } from "../errors.js";
import type { AllowedRootService } from "../resources/allowed-roots.js";
import { createProcessRunner, runChecked, type ProcessRunner } from "../resources/process-runner.js";
import type { ResourceLimits } from "../resources/types.js";

interface GitDeps { roots: AllowedRootService; runner?: ProcessRunner; limits?: ResourceLimits }
interface PorcelainEntry { path: string; originalPath?: string; indexStatus: string; worktreeStatus: string }

function parsePorcelain(output: string): PorcelainEntry[] {
  const records = output.split("\0");
  const entries: PorcelainEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4 || record[2] !== " ") continue;
    const entry: PorcelainEntry = { indexStatus: record[0]!, worktreeStatus: record[1]!, path: record.slice(3) };
    if (/[RC]/.test(`${entry.indexStatus}${entry.worktreeStatus}`)) {
      const original = records[index + 1];
      if (original) entry.originalPath = original;
      index += 1;
    }
    entries.push(entry);
  }
  return entries;
}

function classify(entry: PorcelainEntry): { status: string; code: string } {
  const pair = `${entry.indexStatus}${entry.worktreeStatus}`;
  if (pair === "??") return { status: "untracked", code: "U" };
  if (["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(pair) || pair.includes("U")) return { status: "conflict", code: "C" };
  if (pair.includes("D")) return { status: "deleted", code: "D" };
  if (/[RC]/.test(pair)) return { status: "renamed", code: "R" };
  if (pair.includes("A")) return { status: "added", code: "A" };
  return { status: "modified", code: "M" };
}

function within(parent: string, target: string): boolean {
  const child = relative(parent, target);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}
function gitPath(value: string): string { return value.split(sep).join("/"); }

async function repositoryRoot(runner: ProcessRunner, cwd: string, max: number): Promise<string | null> {
  const result = await runner.run({ command: "git", args: ["-C", cwd, "rev-parse", "--show-toplevel"], maxOutputBytes: max }).catch(() => null);
  return result?.exitCode === 0 ? result.stdout.trim() || null : null;
}

async function statusEntries(runner: ProcessRunner, root: string, max: number): Promise<PorcelainEntry[]> {
  return parsePorcelain(await runChecked(runner, { command: "git", args: ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all"], maxOutputBytes: max }));
}

async function untrackedLines(file: string, limit: number): Promise<number> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > limit) return 0;
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try { const bytes = await handle.readFile(); if (bytes.includes(0)) return 0; const text = bytes.toString("utf8"); return text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0; }
    finally { await handle.close(); }
  } catch { return 0; }
}

export function registerGitRoutes(app: Hono<HostEnv>, deps: GitDeps): void {
  const runner = deps.runner ?? createProcessRunner();
  const maxOutput = deps.limits?.processOutputBytes ?? 8 * 1024 * 1024;
  const previewLimit = deps.limits?.maxTextPreviewBytes ?? 256 * 1024;

  app.get("/v1/git/status", async (c) => {
    const cwd = c.req.query("cwd");
    if (!cwd) throw new HttpError(400, "CWD_REQUIRED", "cwd is required");
    const authorized = await deps.roots.authorizeExisting(cwd, "directory");
    const root = await repositoryRoot(runner, authorized.canonicalPath, maxOutput);
    if (!root) return c.json({ isGitRepository: false, repositoryRoot: null, files: [], additions: 0, deletions: 0 });
    await deps.roots.authorizeExisting(root, "directory");
    const entries = await statusEntries(runner, root, maxOutput);
    const files = entries.flatMap((entry) => {
      const absolute = resolve(root, entry.path);
      return within(authorized.canonicalPath, absolute) ? [{ filePath: absolute, ...classify(entry), indexStatus: entry.indexStatus, worktreeStatus: entry.worktreeStatus }] : [];
    });
    const numstat = await runner.run({ command: "git", args: ["-C", root, "diff", "--no-color", "--no-ext-diff", "--numstat", "HEAD", "--", gitPath(relative(root, authorized.canonicalPath)) || "."], maxOutputBytes: maxOutput }).catch(() => null);
    let additions = 0; let deletions = 0;
    if (numstat?.exitCode === 0) for (const line of numstat.stdout.split("\n")) { const [a, d] = line.split("\t"); if (/^\d+$/.test(a ?? "")) additions += Number(a); if (/^\d+$/.test(d ?? "")) deletions += Number(d); }
    for (const file of files) if (file.status === "untracked") additions += await untrackedLines(file.filePath, previewLimit);
    return c.json({ isGitRepository: true, repositoryRoot: root, files, additions, deletions });
  });

  app.get("/v1/git/diff", async (c) => {
    const cwd = c.req.query("cwd"); const requested = c.req.query("path");
    if (!cwd || !requested) throw new HttpError(400, "GIT_INPUT_REQUIRED", "cwd and path are required");
    const authorized = await deps.roots.authorizeExisting(cwd, "directory");
    const root = await repositoryRoot(runner, authorized.canonicalPath, maxOutput);
    if (!root) return c.json({ supported: false });
    let file: string;
    const existingFile = await deps.roots.authorizeExisting(requested, "file").catch(() => null);
    if (existingFile) {
      file = existingFile.canonicalPath;
    } else {
      // Deleted files cannot be realpathed. Resolve them relative to the canonical cwd
      // only when the caller supplied a path lexically inside the requested cwd.
      const requestedAbsolute = resolve(requested);
      const requestedCwd = resolve(cwd);
      if (!within(requestedCwd, requestedAbsolute)) throw new HttpError(403, "PATH_FORBIDDEN", "File is outside the repository");
      file = resolve(authorized.canonicalPath, relative(requestedCwd, requestedAbsolute));
    }
    if (!within(root, file)) throw new HttpError(403, "PATH_FORBIDDEN", "File is outside the repository");
    const relativePath = gitPath(relative(root, file));
    const entries = await statusEntries(runner, root, maxOutput);
    const entry = entries.find((candidate) => candidate.path === relativePath);
    if (!entry) return c.json({ supported: false });
    const statusValue = classify(entry).status;
    if (statusValue === "untracked") {
      const access = await deps.roots.authorizeExisting(file, "file").catch(() => null);
      if (!access) return c.json({ supported: false });
      const info = await stat(access.canonicalPath); if (info.size > previewLimit) return c.json({ supported: false });
      const handle = await open(access.canonicalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try { const bytes = await handle.readFile(); if (bytes.includes(0)) return c.json({ supported: false }); const text = bytes.toString("utf8"); const lines = text.split("\n"); if (text.endsWith("\n")) lines.pop(); const patch = [`diff --git a/${relativePath} b/${relativePath}`, "new file mode 100644", "--- /dev/null", `+++ b/${relativePath}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join("\n"); return c.json({ supported: true, status: statusValue, patch }); }
      finally { await handle.close(); }
    }
    const paths = entry.originalPath && entry.originalPath !== relativePath ? [entry.originalPath, relativePath] : [relativePath];
    const patch = await runChecked(runner, { command: "git", args: ["-C", root, "diff", "--no-color", "--no-ext-diff", "--unified=3", "HEAD", "--", ...paths], maxOutputBytes: previewLimit * 4 });
    return c.json(patch.includes("\n@@ ") ? { supported: true, status: statusValue, patch } : { supported: false });
  });
}
