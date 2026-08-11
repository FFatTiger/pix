import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { Hono } from "hono";
import type { HostEnv } from "../env.js";
import { HttpError } from "../errors.js";
import type { AllowedRootService } from "../resources/allowed-roots.js";
import { createProcessRunner, type ProcessRunner } from "../resources/process-runner.js";
import type { ResourceLimits } from "../resources/types.js";

const IGNORED = new Set(["node_modules", ".git", ".next", "dist", "build", "coverage", ".cache", ".turbo", "target", "vendor"]);

interface FileIndexDeps {
  roots: AllowedRootService;
  runner?: ProcessRunner;
  limits?: ResourceLimits;
}

function normalizeRelative(value: string): string {
  return value.split(sep).join("/");
}

function rank(file: string, query: string): number {
  const haystack = file.toLowerCase();
  const needle = query.toLowerCase();
  if (haystack === needle) return 10_000;
  if (haystack.startsWith(needle)) return 8_000 - file.length;
  const base = haystack.slice(haystack.lastIndexOf("/") + 1);
  if (base.startsWith(needle)) return 7_000 - file.length;
  const index = haystack.indexOf(needle);
  return index >= 0 ? 5_000 - index - file.length : -1;
}

async function walk(root: string, maxFiles: number, maxDepth: number, signal?: AbortSignal, deadline = Date.now() + 10_000): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  const queue = [{ path: root, depth: 0 }];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    if (signal?.aborted) throw new HttpError(499, "INDEX_ABORTED", "File index request aborted");
    if (Date.now() > deadline) throw new HttpError(504, "INDEX_TIMEOUT", "File indexing timed out");
    const current = queue[cursor]!;
    let entries;
    try { entries = await readdir(current.path, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (signal?.aborted) throw new HttpError(499, "INDEX_ABORTED", "File index request aborted");
      if (Date.now() > deadline) throw new HttpError(504, "INDEX_TIMEOUT", "File indexing timed out");
      if (IGNORED.has(entry.name) || entry.isSymbolicLink()) continue;
      const full = join(current.path, entry.name);
      if (entry.isDirectory() && current.depth < maxDepth) queue.push({ path: full, depth: current.depth + 1 });
      else if (entry.isFile()) {
        files.push(normalizeRelative(relative(root, full)));
        if (files.length >= maxFiles) return { files, truncated: true };
      }
    }
  }
  return { files, truncated: false };
}

async function gitFiles(runner: ProcessRunner, cwd: string, maxFiles: number, maxOutputBytes: number, signal?: AbortSignal): Promise<{ files: string[]; truncated: boolean } | null> {
  const result = await runner.run({ command: "git", args: ["-C", cwd, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], maxOutputBytes, ...(signal ? { signal } : {}) }).catch(() => null);
  if (!result || result.exitCode !== 0) return null;
  const all = result.stdout.split("\0").filter(Boolean);
  return { files: all.slice(0, maxFiles), truncated: all.length > maxFiles };
}

export function registerFileIndexRoutes(app: Hono<HostEnv>, deps: FileIndexDeps): void {
  const runner = deps.runner ?? createProcessRunner();
  const maxFiles = deps.limits?.maxIndexFiles ?? 50_000;
  const maxDepth = deps.limits?.maxIndexDepth ?? 8;
  const maxOutputBytes = deps.limits?.processOutputBytes ?? 16 * 1024 * 1024;
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || !Number.isInteger(maxDepth) || maxDepth < 0) {
    throw new Error("Invalid file-index limits");
  }
  app.get("/v1/file-index", async (c) => {
    const cwd = c.req.query("cwd");
    if (!cwd) throw new HttpError(400, "CWD_REQUIRED", "cwd is required");
    const authorized = await deps.roots.authorizeExisting(cwd, "directory");
    const listing = await gitFiles(runner, authorized.canonicalPath, maxFiles, maxOutputBytes, c.req.raw.signal) ?? await walk(authorized.canonicalPath, maxFiles, maxDepth, c.req.raw.signal, Date.now() + (deps.limits?.processTimeoutMs ?? 10_000));
    const query = (c.req.query("q") ?? "").slice(0, 500);
    if (query) {
      const matches = listing.files.map((path) => ({ path, score: rank(path, query) })).filter((item) => item.score >= 0).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, 200).map(({ path }) => ({ path, isDir: false }));
      return c.json({ matches, truncated: listing.truncated });
    }
    return c.json({ files: listing.files.slice(0, 5_000), truncated: listing.truncated || listing.files.length > 5_000 });
  });
}
