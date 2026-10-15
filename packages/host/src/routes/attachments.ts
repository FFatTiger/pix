import { basename } from "node:path";
import type { Hono } from "hono";
import {
  LocalAuthorityError,
  UNFILED_ATTACHMENTS_SCOPE,
  formatAttachmentFileName,
  isSafeAttachmentScope,
  resolveAttachmentsRoot,
  writeAttachmentFile,
} from "@fffattiger/pix-local-authority/state";
import type { HostEnv } from "../env.js";
import { HttpError } from "../errors.js";
import { readBoundedBody } from "../resources/request-body.js";
import type { ResourceLimits } from "../resources/types.js";

/**
 * Pix attachments store upload. Deliberately NOT an AllowedRoots write: the
 * store lives outside every project (`~/.pi/pix/attachments`, or an absolute
 * `PIX_ATTACHMENTS_DIR`) and this route can write only there, under one
 * validated scope. ExplorerPanel keeps using POST /v1/files unchanged.
 */
export interface AttachmentRouteDeps {
  limits?: ResourceLimits;
}

/**
 * Minimal structural shape of an uploaded multipart file. Deliberately not the
 * nominal global `File`: Node's `buffer.File` and undici's `File` disagree on
 * `[Symbol.toStringTag]`, which makes `value instanceof File` an invalid type
 * predicate under Node v24 / @types/node.
 */
interface UploadFile {
  name: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

type UploadFormEntry = ReturnType<FormData["getAll"]>[number];

function isUploadFile(value: UploadFormEntry): value is UploadFormEntry & UploadFile {
  if (typeof value === "string") return false;
  if (typeof value.name !== "string") return false;
  if (typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 0) return false;
  if (typeof value.arrayBuffer !== "function") return false;
  return true;
}

function attachmentScope(raw: string | undefined): string {
  if (raw === undefined || raw.length === 0) return UNFILED_ATTACHMENTS_SCOPE;
  if (!isSafeAttachmentScope(raw)) {
    throw new HttpError(400, "ATTACHMENT_SCOPE_INVALID", "Invalid sessionId for attachments");
  }
  return raw;
}

/**
 * Resolve the attachments root once, at route registration. A relative
 * `PIX_ATTACHMENTS_DIR` throws here (fail closed) instead of guessing a
 * cwd-dependent store at request time.
 */
export function resolveAttachmentRouteRoot(env: NodeJS.ProcessEnv = process.env): string {
  try {
    return resolveAttachmentsRoot(env);
  } catch (error) {
    if (error instanceof LocalAuthorityError) {
      throw new Error(`attachments store configuration failed: ${error.message}`);
    }
    throw error;
  }
}

export function registerAttachmentRoutes(app: Hono<HostEnv>, deps: AttachmentRouteDeps): void {
  const maxFile = deps.limits?.maxUploadFileBytes ?? 25 * 1024 * 1024;
  const root = resolveAttachmentRouteRoot(process.env);

  app.post("/v1/attachments", async (c) => {
    const scope = attachmentScope(c.req.query("sessionId"));
    const type = c.req.header("content-type") ?? "";
    if (!type.toLowerCase().startsWith("multipart/form-data;")) {
      throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "multipart/form-data is required");
    }
    // Bound the parse the same way POST /v1/files does: cap + 1 MiB of
    // multipart overhead. file.size is checked after parse; the bounded read
    // is what protects memory.
    const bytes = await readBoundedBody(c.req.raw, maxFile + 1024 * 1024);
    const parsed = await new Request(c.req.url, { method: "POST", headers: { "content-type": type }, body: bytes }).formData();
    const files = parsed.getAll("file").filter(isUploadFile);
    if (files.length !== 1) throw new HttpError(400, "NO_FILE", "No file uploaded");
    const file = files[0]!;
    if (file.size > maxFile) throw new HttpError(413, "ATTACHMENT_TOO_LARGE", "Attachment is too large");
    const name = formatAttachmentFileName(file.name);
    const data = new Uint8Array(await file.arrayBuffer());
    try {
      const stored = await writeAttachmentFile({ root, scope, name, data });
      return c.json({ path: stored.path, name: basename(stored.path), size: data.byteLength }, 201);
    } catch (error) {
      if (error instanceof LocalAuthorityError) {
        throw new HttpError(500, "ATTACHMENT_WRITE_FAILED", "Unable to store attachment");
      }
      throw error;
    }
  });
}
