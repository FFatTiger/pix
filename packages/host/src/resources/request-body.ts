import type { Context } from "hono";
import type { HostEnv } from "../env.js";
import { HttpError } from "../errors.js";

export async function readBoundedBody(request: Request, limit: number): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared) {
    const value = Number(declared);
    if (!Number.isSafeInteger(value) || value < 0) throw new HttpError(400, "INVALID_CONTENT_LENGTH", "Invalid Content-Length");
    if (value > limit) throw new HttpError(413, "BODY_TOO_LARGE", "Request body is too large");
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new HttpError(413, "BODY_TOO_LARGE", "Request body is too large");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

export async function readJsonObject(c: Context<HostEnv>, limit = 64 * 1024): Promise<Record<string, unknown>> {
  const type = c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (type !== "application/json") throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "application/json is required");
  const bytes = await readBoundedBody(c.req.raw, limit);
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new HttpError(400, "INVALID_JSON", "Invalid JSON body"); }
}
