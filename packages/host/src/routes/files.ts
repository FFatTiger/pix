import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { Context, Hono } from "hono";
import type { HostEnv } from "../env.js";
import { HttpError } from "../errors.js";
import type { AllowedRootService } from "../resources/allowed-roots.js";
import { KeyedMutex } from "../resources/mutex.js";
import { readBoundedBody, readJsonObject } from "../resources/request-body.js";
import type { DefaultCwdFactory, ResourceLimits } from "../resources/types.js";

const IGNORED_NAMES = new Set([
  "node_modules", ".git", ".next", "dist", "build", "__pycache__", ".turbo", ".cache",
  "coverage", ".pytest_cache", ".mypy_cache", "target", "vendor", ".DS_Store",
]);
const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".mdx", ".json", ".jsonl", ".yaml", ".yml", ".toml", ".xml", ".html",
  ".css", ".scss", ".less", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rb",
  ".go", ".rs", ".java", ".kt", ".swift", ".c", ".cpp", ".h", ".hpp", ".cs", ".sh",
  ".bash", ".zsh", ".fish", ".sql", ".graphql", ".gql", ".tf", ".hcl", ".env", ".gitignore",
]);

/** DOCX preview input cap (10 MiB), ported from the source route's DOCX_PREVIEW_MAX_BYTES. */
const DOCX_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;
/** Sandboxed preview CSP: no origins, images only as inline data: URIs. */
const DOCX_PREVIEW_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

interface FileRouteDeps {
  roots: AllowedRootService;
  limits?: ResourceLimits;
  defaultCwd?: string;
  defaultCwdFactory?: DefaultCwdFactory;
}

/**
 * Per-directory serialization for upload transactions. A batch commit mutates
 * several directory entries and journals every step so it can roll back on a
 * later failure; two batches targeting the same directory must never interleave
 * their journals. Keying by the canonical parent path serializes only uploads
 * that touch the same directory, so parallel uploads to unrelated directories
 * proceed concurrently (the KeyedMutex removes idle keys automatically). Each
 * request acquires exactly one lock (its own target directory) and never nests
 * locks, so no lock ordering / deadlock is possible.
 */
const uploadMutations = new KeyedMutex();

/**
 * Test-only fault-injection seam. Not part of the package public surface; used
 * by host tests to deterministically fail staging / commit / restore without
 * chmod or timing hacks. Call {@link setUploadFaultHooks} with null to reset.
 */
export interface UploadFaultHooks {
  beforeStage?: (index: number, name: string) => void | Promise<void>;
  beforeCommit?: (index: number, name: string) => void | Promise<void>;
  beforeRestore?: (index: number, name: string) => void | Promise<void>;
}
const faultState: { hooks: UploadFaultHooks | null } = { hooks: null };
export function setUploadFaultHooks(hooks: UploadFaultHooks | null): void {
  faultState.hooks = hooks;
}

/** One accepted (non-skip) file through its preflight → stage → commit lifecycle. */
interface PlannedUpload {
  name: string;
  file: UploadFile;
  /** Unique private temp under the target directory once staged. */
  stagedPath?: string;
}
/** Reversible step recorded in the commit journal, restored in reverse order. */
interface UploadJournalEntry {
  kind: "create" | "overwrite";
  target: string;
  /** For overwrite: hard-link backup holding the original inode. */
  backup?: string;
}

/**
 * Minimal structural shape of an uploaded multipart file. Deliberately not the
 * nominal global `File`: Node's `buffer.File` and undici's `File` disagree on
 * `[Symbol.toStringTag]`, which makes `value instanceof File` an invalid type
 * predicate under Node v24 / @types/node. Only the members the upload path
 * needs are declared (the `type` field is not required).
 */
interface UploadFile {
  name: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Actual union type yielded by `FormData#getAll` (string | File). */
type UploadFormEntry = ReturnType<FormData["getAll"]>[number];

/**
 * Fail-closed guard: excludes string and accepts only objects that structurally
 * satisfy the minimal UploadFile shape. The multipart parser only ever yields
 * string | File, but an arbitrary object is never trusted. `instanceof File` is
 * deliberately avoided because it is nominal per-realm and breaks cross-realm
 * uploads.
 */
function isUploadFile(value: UploadFormEntry): value is UploadFormEntry & UploadFile {
  if (typeof value === "string") return false;
  if (typeof value.name !== "string") return false;
  if (typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 0) return false;
  if (typeof value.arrayBuffer !== "function") return false;
  return true;
}

function requiredPath(c: Context<HostEnv>): string {
  const value = c.req.query("path");
  if (!value) throw new HttpError(400, "PATH_REQUIRED", "path query parameter is required");
  return value;
}

function mimeFor(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const mimes: Record<string, string> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".webp": "image/webp", ".svg": "image/svg+xml", ".pdf": "application/pdf", ".mp3": "audio/mpeg",
    ".wav": "audio/wav", ".ogg": "audio/ogg", ".mp4": "video/mp4", ".webm": "video/webm",
  };
  return mimes[ext] ?? (TEXT_EXTENSIONS.has(ext) ? "text/plain; charset=utf-8" : "application/octet-stream");
}

function languageFor(filePath: string): string {
  const ext = extname(filePath).slice(1).toLowerCase();
  const map: Record<string, string> = { ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", py: "python", md: "markdown", json: "json", yml: "yaml", yaml: "yaml", sh: "bash" };
  return map[ext] ?? "text";
}

function disposition(filePath: string, download: boolean): string {
  const raw = basename(filePath);
  const fallback = raw.replace(/[^\x20-\x7e]|["\\;\r\n]/g, "_") || "download";
  return `${download ? "attachment" : "inline"}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(raw)}`;
}

export function parseSingleRange(header: string | null, size: number): { start: number; end: number } | null | "invalid" {
  if (!header) return null;
  if (size < 1) return "invalid";
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return "invalid";
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return "invalid";
    if (start < 0 || start >= size || end < start) return "invalid";
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

async function streamAuthorizedFile(
  c: Context<HostEnv>, roots: AllowedRootService, target: string, download: boolean,
): Promise<Response> {
  const authorized = await roots.authorizeExisting(target, "file");
  const handle = await open(authorized.canonicalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const info = await handle.stat();
  const range = parseSingleRange(c.req.header("range") ?? null, info.size);
  const baseHeaders: Record<string, string> = {
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-cache",
    "Content-Type": mimeFor(authorized.canonicalPath),
    "Content-Disposition": disposition(authorized.canonicalPath, download),
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
    "Referrer-Policy": "no-referrer",
  };
  if (range === "invalid") {
    await handle.close();
    return new Response(null, { status: 416, headers: { ...baseHeaders, "Content-Range": `bytes */${info.size}` } });
  }
  // encoding: null keeps ReadStream emitting Buffers (the default) and is the
  // type-safe option under the Node24 declarations. The "data" event is still
  // typed as string | Buffer, so accept both: strings are UTF-8 encoded with
  // TextEncoder (never via the UTF-16 numeric path), Buffers are copied with
  // new Uint8Array(chunk) so the enqueued bytes never expose the Buffer's
  // underlying (possibly pooled) ArrayBuffer beyond byteLength.
  const stream = handle.createReadStream(range ? { start: range.start, end: range.end, encoding: null } : { encoding: null });
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      stream.on("data", (chunk: string | Buffer) => {
        const bytes = typeof chunk === "string" ? encoder.encode(chunk) : new Uint8Array(chunk);
        controller.enqueue(bytes);
      });
      stream.once("end", () => controller.close());
      stream.once("error", (error) => controller.error(error));
    },
    cancel() { stream.destroy(); void handle.close(); },
  });
  if (range) {
    return new Response(body, { status: 206, headers: { ...baseHeaders, "Content-Length": String(range.end - range.start + 1), "Content-Range": `bytes ${range.start}-${range.end}/${info.size}` } });
  }
  return new Response(body, { headers: { ...baseHeaders, "Content-Length": String(info.size) } });
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Read-only preview wrapper (ported verbatim from the source route): inline
 * styles only, no scripts, no external resources. Document content is inserted
 * as mammoth-produced HTML between the escaped file title and </main>. */
function wrapDocxPreviewHtml(bodyHtml: string, fileName: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light; }
  html, body { margin: 0; min-height: 100%; background: #eef1f5; color: #171717; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 28px; }
  main {
    box-sizing: border-box;
    max-width: 840px;
    min-height: calc(100vh - 56px);
    margin: 0 auto;
    padding: 56px 64px;
    background: #fff;
    box-shadow: 0 8px 28px rgba(15, 23, 42, 0.14);
  }
  .file-title {
    margin: 0 0 28px;
    padding-bottom: 10px;
    border-bottom: 1px solid #e5e7eb;
    color: #6b7280;
    font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    word-break: break-word;
  }
  h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 1.1em 0 0.45em; color: #111827; }
  p { margin: 0.65em 0; line-height: 1.7; }
  table { border-collapse: collapse; max-width: 100%; margin: 1em 0; }
  th, td { border: 1px solid #d1d5db; padding: 6px 9px; vertical-align: top; }
  img { max-width: 100%; height: auto; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; }
  a { color: #2563eb; }
  @media (max-width: 720px) {
    body { padding: 0; background: #fff; }
    main { min-height: 100vh; padding: 28px 22px; box-shadow: none; }
  }
</style>
</head>
<body>
<main>
<div class="file-title">${escapeHtml(fileName)}</div>
${bodyHtml}
</main>
</body>
</html>`;
}

/**
 * GET /v1/files?op=docx-preview — sandboxed HTML rendering of a .docx file.
 * Port of the upstream desktop repo's `app/api/files/[...path]/route.ts` (type=preview):
 * .docx only (case-insensitive extension), 10 MiB cap, lazy mammoth import,
 * `externalFileAccess: false` and `convertImage: mammoth.images.dataUri`,
 * wrapped in an inline-styled HTML shell. Unlike the source, which hands
 * mammoth a `{ path }` to re-open itself, pix keeps the AllowedRoot
 * `authorizeExisting` + regular-file + O_NOFOLLOW/identity read semantics:
 * the bytes handed to mammoth (`{ buffer }`) come from the same pinned handle
 * raw streaming uses, so conversion can never follow a swapped symlink or
 * read outside the authorized regular file. Conversion failures map to a
 * fixed sanitized error (never the path, mammoth's raw message or document
 * content); the wrapper itself allows no scripts or external resources.
 */
async function renderDocxPreview(roots: AllowedRootService, target: string): Promise<Response> {
  const authorized = await roots.authorizeExisting(target, "file");
  if (extname(authorized.canonicalPath).toLowerCase() !== ".docx") {
    throw new HttpError(400, "DOCX_ONLY", "DOCX preview is only available for .docx files");
  }
  const handle = await open(authorized.canonicalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let bytes: Buffer;
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new HttpError(400, "NOT_FILE", "Path is not a file");
    if (info.size > DOCX_PREVIEW_MAX_BYTES) throw new HttpError(413, "DOCX_TOO_LARGE", "DOCX preview is limited to 10 MiB");
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  const mammoth = await import("mammoth");
  let bodyHtml: string;
  try {
    const result = await mammoth.convertToHtml(
      { buffer: bytes },
      { externalFileAccess: false, convertImage: mammoth.images.dataUri },
    );
    bodyHtml = result.value;
  } catch {
    throw new HttpError(422, "DOCX_PREVIEW_FAILED", "Unable to render this DOCX document");
  }
  const html = wrapDocxPreviewHtml(bodyHtml, basename(authorized.canonicalPath));
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": DOCX_PREVIEW_CSP,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new HttpError(499, "UPLOAD_ABORTED", "Upload request aborted");
}

async function pathExists(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return false; }
}

/** Stage one accepted file to a unique private temp (0600) under the parent. */
async function stageUploadedFile(parent: string, file: UploadFile): Promise<string> {
  const temp = join(parent, `.pix-upload-${randomUUID()}.tmp`);
  const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { await handle.writeFile(new Uint8Array(await file.arrayBuffer())); }
  finally { await handle.close(); }
  return temp;
}

/** Best-effort reverse journal rollback: restore originals, remove creates. */
async function rollbackUploadBatch(journal: UploadJournalEntry[]): Promise<void> {
  for (let index = journal.length - 1; index >= 0; index -= 1) {
    const entry = journal[index]!;
    await faultState.hooks?.beforeRestore?.(index, entry.target);
    try {
      if (entry.kind === "overwrite") await rename(entry.backup!, entry.target);
      else await rm(entry.target, { force: true });
    } catch { /* best-effort; caller surfaces the original failure */ }
  }
}

/**
 * Commit a fully staged batch with a rollback journal, holding the
 * per-directory mutex. Re-verifies the target directory identity and every
 * child target (root / symlink / type re-checks via AllowedRoot semantics)
 * before mutating finals, so a target whose identity changed between preflight
 * and commit is refused instead of followed or overwritten.
 */
async function commitUploadBatch(
  roots: AllowedRootService,
  requestedDirectory: string,
  preflightParent: string,
  parentIdentity: { dev: number; ino: number },
  plan: PlannedUpload[],
  overwrite: boolean,
  skip: boolean,
  signal?: AbortSignal,
): Promise<{ uploaded: string[]; skipped: string[] }> {
  return uploadMutations.runExclusive(preflightParent, async () => {
    // Re-verify the target directory at the commit boundary and again before
    // each final mutation, using the same AllowedRoot semantics: if the allowed
    // root or the target directory was replaced (identity or canonical path
    // changed) since preflight, refuse instead of mutating a foreign directory.
    const verifyDirectory = async (): Promise<void> => {
      const current = await roots.authorizeExisting(requestedDirectory, "directory");
      if (current.canonicalPath !== preflightParent) throw new HttpError(403, "PATH_FORBIDDEN", "Upload directory changed");
      const info = await lstat(current.canonicalPath);
      if (info.dev !== parentIdentity.dev || info.ino !== parentIdentity.ino) throw new HttpError(409, "DIRECTORY_REPLACED", "Upload directory was replaced during the transaction");
    };
    await verifyDirectory();
    const journal: UploadJournalEntry[] = [];
    const uploaded: string[] = [];
    const skipped: string[] = [];
    try {
      for (let index = 0; index < plan.length; index += 1) {
        throwIfAborted(signal);
        const item = plan[index]!;
        await faultState.hooks?.beforeCommit?.(index, item.name);
        await verifyDirectory();
        const authorized = await roots.authorizeChild(requestedDirectory, item.name);
        const target = authorized.requestedPath;
        const exists = await pathExists(target);
        if (exists && skip) { skipped.push(item.name); continue; }
        if (exists && !overwrite) throw new HttpError(409, "FILE_EXISTS", `File already exists: ${item.name}`);
        if (exists) {
          // Overwrite: preserve the original as a hard-link backup in the same
          // directory (same filesystem), then swap the directory entry. The
          // backup is dropped on success and restored on rollback, so the
          // original is never absent while the request is in flight.
          const info = await lstat(target);
          if (info.isSymbolicLink() || !info.isFile()) throw new HttpError(409, "UNSAFE_TARGET", "Only regular file targets can be replaced");
          const backup = join(dirname(target), `.pix-upload-${randomUUID()}.bak`);
          await link(target, backup);
          journal.push({ kind: "overwrite", target, backup });
          // rename replaces the directory entry itself, never follows a symlink.
          await rename(item.stagedPath!, target);
        } else {
          // Create: atomic create-if-absent (link fails with EEXIST if the
          // target appeared since preflight; rename would silently replace it).
          await link(item.stagedPath!, target);
          journal.push({ kind: "create", target });
          await rm(item.stagedPath!, { force: true });
          delete item.stagedPath;
        }
        uploaded.push(item.name);
      }
      throwIfAborted(signal);
      for (const entry of journal) {
        if (entry.kind === "overwrite") await rm(entry.backup!, { force: true }).catch(() => undefined);
      }
      return { uploaded, skipped };
    } catch (error) {
      await rollbackUploadBatch(journal);
      throw error;
    } finally {
      for (const item of plan) if (item.stagedPath) await rm(item.stagedPath, { force: true }).catch(() => undefined);
    }
  }, signal);
}

export function registerFileRoutes(app: Hono<HostEnv>, deps: FileRouteDeps): void {
  const maxText = deps.limits?.maxTextPreviewBytes ?? 256 * 1024;
  const maxBinary = deps.limits?.maxBinaryPreviewBytes ?? 10 * 1024 * 1024;
  const maxFile = deps.limits?.maxUploadFileBytes ?? 25 * 1024 * 1024;
  const maxTotal = deps.limits?.maxUploadTotalBytes ?? 100 * 1024 * 1024;

  app.get("/v1/files", async (c) => {
    const target = requiredPath(c);
    const operation = c.req.query("op") ?? "list";
    if (operation === "download") return streamAuthorizedFile(c, deps.roots, target, true);
    if (operation === "raw") return streamAuthorizedFile(c, deps.roots, target, false);
    // Distinct op on purpose: never fold DOCX rendering into text/binary
    // `preview`, so the response kind is never ambiguous.
    if (operation === "docx-preview") return renderDocxPreview(deps.roots, target);
    const authorized = await deps.roots.authorizeExisting(target);
    const info = await stat(authorized.canonicalPath);
    if (operation === "meta") return c.json({ path: authorized.canonicalPath, size: info.size, modified: info.mtime.toISOString(), isDirectory: info.isDirectory(), mime: info.isFile() ? mimeFor(authorized.canonicalPath) : null });
    if (operation === "read" || operation === "preview") {
      if (!info.isFile()) throw new HttpError(400, "NOT_FILE", "Path is not a file");
      const mime = mimeFor(authorized.canonicalPath);
      if (!mime.startsWith("text/") && mime !== "application/octet-stream") {
        if (info.size > maxBinary) throw new HttpError(413, "PREVIEW_TOO_LARGE", "Binary preview is too large");
        return streamAuthorizedFile(c, deps.roots, target, false);
      }
      if (info.size > maxText) throw new HttpError(413, "PREVIEW_TOO_LARGE", "Text preview is too large");
      const handle = await open(authorized.canonicalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const bytes = await handle.readFile();
        if (bytes.includes(0)) throw new HttpError(415, "BINARY_FILE", "Binary files require raw preview");
        return c.json({ content: bytes.toString("utf8"), language: languageFor(authorized.canonicalPath), size: info.size });
      } finally { await handle.close(); }
    }
    if (operation !== "list") throw new HttpError(400, "INVALID_OPERATION", "Unsupported files operation");
    if (!info.isDirectory()) throw new HttpError(400, "NOT_DIRECTORY", "Path is not a directory");
    const dirents = await readdir(authorized.canonicalPath, { withFileTypes: true });
    const entries = dirents.filter((entry) => !IGNORED_NAMES.has(entry.name)).map((entry) => ({ name: entry.name, isDir: entry.isDirectory(), isSymlink: entry.isSymbolicLink() })).sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
    return c.json({ path: authorized.canonicalPath, entries });
  });

  app.post("/v1/files", async (c) => {
    // File uploads are pure filesystem writes: the resource layer is mounted on
    // the Host and stays usable while sessiond (the runtime authority) is down,
    // so files.write/files.upload remain honestly advertised in degraded
    // capabilities. No mutation guard here — only sessiond-dependent worktree
    // writes are runtime-guarded (see routes/worktrees.ts).
    const target = requiredPath(c);
    // Fail-fast path authorization before buffering the bounded multipart body.
    await deps.roots.authorizeExisting(target, "directory");
    const type = c.req.header("content-type") ?? "";
    if (!type.toLowerCase().startsWith("multipart/form-data;")) throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "multipart/form-data is required");
    const bytes = await readBoundedBody(c.req.raw, maxTotal + 1024 * 1024);
    const parsed = await new Request(c.req.url, { method: "POST", headers: { "content-type": type }, body: bytes }).formData();
    const files = parsed.getAll("files").filter(isUploadFile);
    if (files.length === 0) throw new HttpError(400, "NO_FILES", "No files selected");
    const overwrite = c.req.query("conflict") === "overwrite";
    const skip = c.req.query("conflict") === "skip";
    if (!overwrite && !skip && c.req.query("conflict") && c.req.query("conflict") !== "error") throw new HttpError(400, "INVALID_CONFLICT", "conflict must be error, overwrite, or skip");
    const authorizedParent = await deps.roots.authorizeExisting(target, "directory");
    const parent = authorizedParent.canonicalPath;
    const parentInfo = await lstat(parent);

    // Phase 1 — Preflight the full batch before any write. Keep the existing
    // validation order (name / duplicate / per-file size, then total) so error
    // precedence is unchanged, then resolve conflicts for the whole batch.
    const names = new Set<string>();
    let total = 0;
    for (const file of files) {
      await deps.roots.authorizeChild(target, file.name);
      if (names.has(file.name)) throw new HttpError(400, "DUPLICATE_FILE", `Duplicate file name: ${file.name}`);
      names.add(file.name); total += file.size;
      if (file.size > maxFile) throw new HttpError(413, "FILE_TOO_LARGE", `File is too large: ${file.name}`);
    }
    if (total > maxTotal) throw new HttpError(413, "UPLOAD_TOO_LARGE", "Upload total is too large");
    const plan: PlannedUpload[] = [];
    const skipped: string[] = [];
    for (const file of files) {
      if (await pathExists(join(parent, file.name))) {
        if (skip) { skipped.push(file.name); continue; }
        if (!overwrite) throw new HttpError(409, "FILE_EXISTS", `File already exists: ${file.name}`);
      }
      plan.push({ name: file.name, file });
    }

    const signal = c.req.raw.signal;
    // Phase 2 — Stage every accepted file to a unique private temp under the
    // target directory (0600, O_NOFOLLOW). Any staging failure cleans every
    // temp already staged and commits nothing.
    try {
      for (let index = 0; index < plan.length; index += 1) {
        throwIfAborted(signal);
        await faultState.hooks?.beforeStage?.(index, plan[index]!.name);
        plan[index]!.stagedPath = await stageUploadedFile(parent, plan[index]!.file);
      }
      // Phase 3 — Commit under a per-directory lock with a rollback journal.
      const result = await commitUploadBatch(deps.roots, target, parent, { dev: parentInfo.dev, ino: parentInfo.ino }, plan, overwrite, skip, signal);
      return c.json({ uploaded: result.uploaded, skipped: [...skipped, ...result.skipped] }, 201);
    } finally {
      for (const item of plan) if (item.stagedPath) await rm(item.stagedPath, { force: true }).catch(() => undefined);
    }
  });

  app.post("/v1/cwd/validate", async (c) => {
    const body = await readJsonObject(c);
    if (typeof body.cwd !== "string") throw new HttpError(400, "CWD_REQUIRED", "cwd is required");
    const existing = await deps.roots.authorizeExisting(body.cwd, "directory").catch(async (error: unknown) => {
      if (error instanceof HttpError && error.status === 403) {
        const expansion = await deps.roots.expandRoots([body.cwd as string], c.get("hostMode"));
        return deps.roots.authorizeExisting(expansion.paths[0]!, "directory");
      }
      throw error;
    });
    return c.json({ success: true, cwd: existing.canonicalPath });
  });

  app.get("/v1/cwd/browse", async (c) => {
    const requested = c.req.query("path");
    const target = requested || deps.defaultCwd || deps.roots.roots()[0];
    if (!target) throw new HttpError(404, "NO_ALLOWED_ROOTS", "No allowed roots are configured");
    const authorized = await deps.roots.authorizeExisting(target, "directory");
    const dirents = await readdir(authorized.canonicalPath, { withFileTypes: true });
    const directories = dirents.filter((entry) => entry.isDirectory() && !IGNORED_NAMES.has(entry.name)).map((entry) => entry.name).sort();
    return c.json({ path: authorized.canonicalPath, parentPath: authorized.canonicalPath === authorized.root ? null : dirname(authorized.canonicalPath), directories });
  });

  app.get("/v1/cwd/roots", (c) => c.json({ roots: deps.roots.roots(), defaultCwd: deps.defaultCwd ?? null }));

  app.post("/v1/cwd/default", async (c) => {
    if (!deps.defaultCwdFactory) throw new HttpError(503, "DEFAULT_CWD_UNAVAILABLE", "Default cwd creation is not configured");
    const created = await deps.defaultCwdFactory.create();
    const expansion = await deps.roots.expandRoots([created.projectRoot, created.cwd], c.get("hostMode"));
    return c.json({ cwd: expansion.paths[1]!, projectRoot: expansion.paths[0]! }, 201);
  });
}
