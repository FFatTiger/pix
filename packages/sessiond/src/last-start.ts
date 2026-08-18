import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SessiondError } from "./errors.js";
import { LocalAuthorityError } from "@fffattiger/pix-local-authority/state";

export const LAST_START_KIND = "pix.sessiond.last-start" as const;
export const LAST_START_VERSION = 1 as const;
export const LAST_START_FILE_NAME = "sessiond.last-start.json";
export const LAST_START_MAX_BYTES = 1024;

export const LAST_START_CODES = [
  "ok",
  "private_directory",
  "lock_conflict",
  "socket_length",
  "listen_failed",
  "module",
  "protocol",
  "unknown",
] as const;

export type LastStartCode = (typeof LAST_START_CODES)[number];

export interface LastStartRecord {
  kind: typeof LAST_START_KIND;
  version: typeof LAST_START_VERSION;
  ok: boolean;
  code: LastStartCode;
  message: string;
  at: string;
}

export type LastStartRead =
  | { kind: "missing" }
  | { kind: "valid"; record: LastStartRecord }
  | { kind: "corrupt" };

const LAST_START_MESSAGES: Record<LastStartCode, string> = {
  ok: "sessiond started",
  private_directory: "sessiond private directory is unsafe",
  lock_conflict: "another sessiond instance is running",
  socket_length: "sessiond socket path is too long",
  listen_failed: "sessiond listener could not be published",
  module: "sessiond module could not be loaded",
  protocol: "sessiond protocol is incompatible",
  unknown: "sessiond failed to start",
};

export function lastStartPath(directory: string): string {
  return join(directory, LAST_START_FILE_NAME);
}

export function classifyLastStartError(error: unknown): LastStartCode {
  if (error instanceof LocalAuthorityError) return "private_directory";
  if (!(error instanceof SessiondError)) return "unknown";
  if (error.code === "conflict") return "lock_conflict";
  if (error.code === "forbidden" && /socket path too long/u.test(error.message)) return "socket_length";
  if (error.code === "forbidden") return "private_directory";
  if (error.code === "unavailable") return "listen_failed";
  if (error.code === "unsupported_capability") return "protocol";
  return "unknown";
}

export function lastStartRecordFromError(error: unknown, at = new Date().toISOString()): LastStartRecord {
  const code = classifyLastStartError(error);
  return {
    kind: LAST_START_KIND,
    version: LAST_START_VERSION,
    ok: false,
    code,
    message: LAST_START_MESSAGES[code],
    at,
  };
}

export function lastStartOkRecord(at = new Date().toISOString()): LastStartRecord {
  return {
    kind: LAST_START_KIND,
    version: LAST_START_VERSION,
    ok: true,
    code: "ok",
    message: LAST_START_MESSAGES.ok,
    at,
  };
}

export function parseLastStartRecord(raw: string): LastStartRecord | undefined {
  if (Buffer.byteLength(raw) > LAST_START_MAX_BYTES) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<LastStartRecord>;
  if (record.kind !== LAST_START_KIND || record.version !== LAST_START_VERSION) return undefined;
  if (typeof record.ok !== "boolean") return undefined;
  if (!LAST_START_CODES.includes(record.code as LastStartCode)) return undefined;
  if (typeof record.message !== "string" || record.message.length === 0 || record.message.length > 160) return undefined;
  if (typeof record.at !== "string" || !/^\d{4}-\d{2}-\d{2}T/u.test(record.at)) return undefined;
  return {
    kind: LAST_START_KIND,
    version: LAST_START_VERSION,
    ok: record.ok,
    code: record.code as LastStartCode,
    message: LAST_START_MESSAGES[record.code as LastStartCode],
    at: record.at,
  };
}

export async function writeLastStartRecord(directory: string, record: LastStartRecord): Promise<void> {
  const payload = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(payload) > LAST_START_MAX_BYTES) return;
  await writeFile(lastStartPath(directory), payload, { encoding: "utf8", mode: 0o600 });
}

export async function readLastStartRecord(directory: string): Promise<LastStartRead> {
  let raw: string;
  try {
    raw = await readFile(lastStartPath(directory), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "corrupt" };
  }
  const record = parseLastStartRecord(raw);
  return record ? { kind: "valid", record } : { kind: "corrupt" };
}

export async function writeLastStartFromError(directory: string, error: unknown): Promise<void> {
  try {
    await writeLastStartRecord(directory, lastStartRecordFromError(error));
  } catch {
    // Best-effort: a failed private directory may also reject this write.
  }
}

export async function writeLastStartOk(directory: string): Promise<void> {
  try {
    await writeLastStartRecord(directory, lastStartOkRecord());
  } catch {
    // Best-effort.
  }
}
