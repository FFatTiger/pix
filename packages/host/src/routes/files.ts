import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { Context, Hono } from "hono";
import type { HostEnv } from "../env.js";
import { HttpError } from "../errors.js";
import type { AllowedRootService } from "../resources/allowed-roots.js";
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

interface FileRouteDeps {
  roots: AllowedRootService;
  limits?: ResourceLimits;
  defaultCwd?: string;
  defaultCwdFactory?: DefaultCwdFactory;
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
  const stream = handle.createReadStream(range ? { start: range.start, end: range.end } : {});
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      stream.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
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

async function writeUploadedFile(
  roots: AllowedRootService, directory: string, file: File, overwrite: boolean,
): Promise<void> {
  const target = await roots.authorizeChild(directory, file.name);
  const authorizedParent = await roots.authorizeExisting(directory, "directory");
  const parent = authorizedParent.canonicalPath;
  if (dirname(target.requestedPath) !== parent) throw new HttpError(403, "PATH_FORBIDDEN", "Upload target parent changed");
  const temp = join(parent, `.pi-web-upload-${randomUUID()}.tmp`);
  if (!overwrite) {
    const handle = await open(target.requestedPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") throw new HttpError(409, "FILE_EXISTS", `File already exists: ${file.name}`);
      throw error;
    });
    try { await handle.writeFile(new Uint8Array(await file.arrayBuffer())); }
    catch (error) { await handle.close(); await rm(target.requestedPath, { force: true }).catch(() => undefined); throw error; }
    await handle.close();
    return;
  }
  try {
    const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { await handle.writeFile(new Uint8Array(await file.arrayBuffer())); } finally { await handle.close(); }
    // rename replaces the directory entry itself, never follows a final symlink.
    await rename(temp, target.requestedPath);
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
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
    const target = requiredPath(c);
    await deps.roots.authorizeExisting(target, "directory");
    const type = c.req.header("content-type") ?? "";
    if (!type.toLowerCase().startsWith("multipart/form-data;")) throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "multipart/form-data is required");
    const bytes = await readBoundedBody(c.req.raw, maxTotal + 1024 * 1024);
    const parsed = await new Request(c.req.url, { method: "POST", headers: { "content-type": type }, body: bytes }).formData();
    const files = parsed.getAll("files").filter((value): value is File => value instanceof File);
    if (files.length === 0) throw new HttpError(400, "NO_FILES", "No files selected");
    const names = new Set<string>();
    let total = 0;
    for (const file of files) {
      await deps.roots.authorizeChild(target, file.name);
      if (names.has(file.name)) throw new HttpError(400, "DUPLICATE_FILE", `Duplicate file name: ${file.name}`);
      names.add(file.name); total += file.size;
      if (file.size > maxFile) throw new HttpError(413, "FILE_TOO_LARGE", `File is too large: ${file.name}`);
    }
    if (total > maxTotal) throw new HttpError(413, "UPLOAD_TOO_LARGE", "Upload total is too large");
    const overwrite = c.req.query("conflict") === "overwrite";
    const skip = c.req.query("conflict") === "skip";
    if (!overwrite && !skip && c.req.query("conflict") && c.req.query("conflict") !== "error") throw new HttpError(400, "INVALID_CONFLICT", "conflict must be error, overwrite, or skip");
    const uploaded: string[] = [];
    const skipped: string[] = [];
    for (const file of files) {
      if (skip) {
        const targetPath = await deps.roots.authorizeChild(target, file.name);
        try { await stat(targetPath.requestedPath); skipped.push(file.name); continue; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      await writeUploadedFile(deps.roots, target, file, overwrite); uploaded.push(file.name);
    }
    return c.json({ uploaded, skipped }, 201);
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
