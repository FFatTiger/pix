/**
 * Host-owned durable Web Push store (`web-push.json`, D-PUSH).
 *
 * Thin adapter over the shared {@link HostStateDirectoryLease} (same one-lock /
 * one-mutex mechanism as the trusted-roots and managed-worktrees ledgers).
 * Owns exactly two things:
 *   - the VAPID keypair (generated once on first use, then immutable);
 *   - the registered browser push subscriptions (deduped by endpoint).
 *
 * Corrupt/unsafe document ⇒ fail closed with a fixed sanitized error and the
 * file is never rewritten (immutable evidence), exactly like the other
 * sidecars. Missing document ⇒ empty store (keys are generated lazily on the
 * first send/subscribe). Rollback note: a Host build that predates this
 * document fails closed on a host dir that already contains `web-push.json`
 * (unrecognized layout entry); removing the file restores the old boot.
 *
 * Layout (default `~/.pi/pix/host`, override via absolute `PIX_HOST_DIR`):
 *   web-push.json — kind pix.host.web-push schema v1 (0600, regular file)
 */
import {
  isIsoTimestamp,
  isRecord,
  type HostStateDirectoryCode,
  type HostStateDirectoryIo,
  type HostStateDirectoryLease,
  type LeaseDocumentReadResult,
} from "./host-state-directory.js";
import { HostStateDirectoryError } from "./host-state-directory.js";
import {
  MAX_PUSH_DEVICE_NAME_LENGTH,
  MAX_PUSH_ENDPOINT_LENGTH,
  PUSH_VAPID_PUBLIC_KEY_PATTERN,
} from "@fffattiger/pix-protocol/push";

export const WEB_PUSH_KIND = "pix.host.web-push" as const;
export const WEB_PUSH_VERSION = 1 as const;

export const WEB_PUSH_FILE_NAME = "web-push.json";

/** Upper bound on stored subscriptions (a single-user product; generous). */
export const MAX_PUSH_SUBSCRIPTIONS = 32;

const MAX_DOCUMENT_BYTES = 262_144;
const VAPID_PRIVATE_KEY_PATTERN = /^[A-Za-z0-9_-]{80,240}$/;

/** Fixed warning / error codes — never embed endpoints or raw payloads. */
export type WebPushStoreCode =
  | "PUSH_DOC_CORRUPT"
  | "PUSH_DOC_UNKNOWN_VERSION"
  | "PUSH_DOC_WRONG_KIND"
  | "PUSH_DOC_OVERSIZE"
  | "PUSH_DOC_DUPLICATE"
  | "PUSH_DOC_SPARSE"
  | "PUSH_DOC_WRITE_FAILED"
  | "PUSH_SUBSCRIPTIONS_FULL"
  | "HOST_DIR_UNSAFE"
  | "HOST_DIR_INVALID";

export class WebPushStoreError extends Error {
  readonly code: WebPushStoreCode;
  constructor(code: WebPushStoreCode, message: string) {
    super(message);
    this.name = "WebPushStoreError";
    this.code = code;
  }
}

/** Stored VAPID keypair. Private key never leaves the Host process. */
export interface WebPushVapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface WebPushSubscriptionRecord {
  endpoint: string;
  p256dh: string;
  auth: string;
  /** Optional device label supplied at registration. */
  deviceName?: string;
  createdAt: string;
}

export interface WebPushDocument {
  kind: typeof WEB_PUSH_KIND;
  version: typeof WEB_PUSH_VERSION;
  vapid?: WebPushVapidKeys;
  subscriptions: WebPushSubscriptionRecord[];
}

export interface WebPushStore {
  /** Fail-closed read. Missing ⇒ empty document (no keys, no subscriptions). */
  read(): Promise<WebPushDocument>;
  /**
   * Return the persisted keypair, generating + atomically persisting one via
   * the injected generator when none exists yet. Deterministic single-writer
   * semantics come from the shared lease mutex.
   */
  getOrCreateVapidKeys(generate: () => WebPushVapidKeys): Promise<WebPushVapidKeys>;
  /** Upsert by exact endpoint (re-registration refreshes keys/label). */
  upsertSubscription(subscription: Omit<WebPushSubscriptionRecord, "createdAt"> & { createdAt?: string }): Promise<void>;
  /** Remove by exact endpoint; missing endpoint is a no-op. */
  removeSubscription(endpoint: string): Promise<void>;
}

const DOC_MESSAGE: Partial<Record<HostStateDirectoryCode, string>> = {
  DOC_SYMLINK: "Web Push store must not be a symbolic link",
  DOC_NOT_REGULAR: "Web Push store must be a regular file",
  DOC_UNREADABLE: "Web Push store is unreadable",
  DOC_OVERSIZE: "Web Push store exceeds the size bound",
  DOC_PERMISSIONS: "Web Push store permissions are unsafe",
  DOC_HARD_LINK: "Web Push store must not be hard-linked",
  DOC_WRITE_FAILED: "Web Push store write failed",
};

const CODE_MAP: Record<HostStateDirectoryCode, WebPushStoreCode> = {
  HOST_DIR_INVALID: "HOST_DIR_INVALID",
  HOST_DIR_UNSAFE: "HOST_DIR_UNSAFE",
  LOCK_UNSAFE: "HOST_DIR_UNSAFE",
  LOCK_BUSY: "HOST_DIR_UNSAFE",
  LOCK_STALE: "HOST_DIR_UNSAFE",
  DOC_UNKNOWN: "PUSH_DOC_CORRUPT",
  DOC_SYMLINK: "PUSH_DOC_CORRUPT",
  DOC_NOT_REGULAR: "PUSH_DOC_CORRUPT",
  DOC_UNREADABLE: "PUSH_DOC_CORRUPT",
  DOC_OVERSIZE: "PUSH_DOC_OVERSIZE",
  DOC_PERMISSIONS: "PUSH_DOC_CORRUPT",
  DOC_HARD_LINK: "PUSH_DOC_CORRUPT",
  DOC_WRITE_FAILED: "PUSH_DOC_WRITE_FAILED",
  DOC_LOCK_LOST: "PUSH_DOC_WRITE_FAILED",
};

function toStoreError(error: unknown): never {
  if (error instanceof WebPushStoreError) throw error;
  if (error instanceof HostStateDirectoryError) {
    throw new WebPushStoreError(CODE_MAP[error.code], DOC_MESSAGE[error.code] ?? error.message);
  }
  throw error;
}

function parseSubscription(raw: unknown): WebPushSubscriptionRecord | undefined {
  if (!isRecord(raw)) return undefined;
  const { endpoint, p256dh, auth, deviceName, createdAt } = raw;
  if (typeof endpoint !== "string" || endpoint.length === 0 || endpoint.length > MAX_PUSH_ENDPOINT_LENGTH) return undefined;
  let endpointUrl: URL;
  try {
    endpointUrl = new URL(endpoint);
  } catch {
    return undefined;
  }
  if (endpointUrl.protocol !== "https:" || endpointUrl.username !== "" || endpointUrl.password !== "") return undefined;
  if (typeof p256dh !== "string" || !PUSH_VAPID_PUBLIC_KEY_PATTERN.test(p256dh)) return undefined;
  if (typeof auth !== "string" || auth.length < 10 || auth.length > 60) return undefined;
  if (typeof createdAt !== "string" || !isIsoTimestamp(createdAt)) return undefined;
  if (deviceName !== undefined && (typeof deviceName !== "string" || deviceName.length === 0 || deviceName.length > MAX_PUSH_DEVICE_NAME_LENGTH)) return undefined;
  const allowed = new Set(["endpoint", "p256dh", "auth", "deviceName", "createdAt"]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) return undefined;
  }
  return deviceName === undefined
    ? { endpoint, p256dh, auth, createdAt }
    : { endpoint, p256dh, auth, deviceName, createdAt };
}

/**
 * Pure parse of the document (bounded). A `warning` code classifies every
 * rejected document; the read path converts it into a hard error.
 */
export function parseWebPushDocument(
  text: string,
  maxSubscriptions: number = MAX_PUSH_SUBSCRIPTIONS,
): { document?: WebPushDocument; warning?: WebPushStoreCode } {
  if (text.length > MAX_DOCUMENT_BYTES) return { warning: "PUSH_DOC_OVERSIZE" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { warning: "PUSH_DOC_CORRUPT" };
  }
  if (!isRecord(parsed)) return { warning: "PUSH_DOC_CORRUPT" };
  if (parsed.kind !== WEB_PUSH_KIND) return { warning: "PUSH_DOC_WRONG_KIND" };
  if (parsed.version !== WEB_PUSH_VERSION) return { warning: "PUSH_DOC_UNKNOWN_VERSION" };
  if (!Array.isArray(parsed.subscriptions)) return { warning: "PUSH_DOC_CORRUPT" };
  if (parsed.subscriptions.length > maxSubscriptions) return { warning: "PUSH_DOC_OVERSIZE" };
  for (const key of Object.keys(parsed)) {
    if (key !== "kind" && key !== "version" && key !== "vapid" && key !== "subscriptions") {
      return { warning: "PUSH_DOC_CORRUPT" };
    }
  }
  let vapid: WebPushVapidKeys | undefined;
  if (parsed.vapid !== undefined) {
    if (!isRecord(parsed.vapid)) return { warning: "PUSH_DOC_SPARSE" };
    const { publicKey, privateKey } = parsed.vapid;
    if (typeof publicKey !== "string" || !PUSH_VAPID_PUBLIC_KEY_PATTERN.test(publicKey)) return { warning: "PUSH_DOC_SPARSE" };
    if (typeof privateKey !== "string" || !VAPID_PRIVATE_KEY_PATTERN.test(privateKey)) return { warning: "PUSH_DOC_SPARSE" };
    vapid = { publicKey, privateKey };
  }
  const subscriptions: WebPushSubscriptionRecord[] = [];
  const seenEndpoints = new Set<string>();
  for (const entry of parsed.subscriptions) {
    const record = parseSubscription(entry);
    if (record === undefined) return { warning: "PUSH_DOC_SPARSE" };
    if (seenEndpoints.has(record.endpoint)) return { warning: "PUSH_DOC_DUPLICATE" };
    seenEndpoints.add(record.endpoint);
    subscriptions.push(record);
  }
  return { document: vapid === undefined ? { kind: WEB_PUSH_KIND, version: WEB_PUSH_VERSION, subscriptions } : { kind: WEB_PUSH_KIND, version: WEB_PUSH_VERSION, vapid, subscriptions } };
}

/** Deterministic serialization: subscriptions sorted by endpoint. */
export function serializeWebPushDocument(document: WebPushDocument): string {
  const subscriptions = [...document.subscriptions]
    .sort((a, b) => a.endpoint.localeCompare(b.endpoint))
    .map((sub) => ({
      endpoint: sub.endpoint,
      p256dh: sub.p256dh,
      auth: sub.auth,
      ...(sub.deviceName === undefined ? {} : { deviceName: sub.deviceName }),
      createdAt: sub.createdAt,
    }));
  const body = {
    kind: WEB_PUSH_KIND,
    version: WEB_PUSH_VERSION,
    ...(document.vapid === undefined ? {} : { vapid: document.vapid }),
    subscriptions,
  };
  return `${JSON.stringify(body)}\n`;
}

/**
 * Wrap an already-open shared lease as the Web Push store. The lease must be
 * the same single instance the other ledgers use (one lock, one mutex).
 */
export function createWebPushStoreFromLease(
  lease: HostStateDirectoryLease,
  options: { maxSubscriptions?: number } = {},
): WebPushStore {
  const maxSubscriptions = options.maxSubscriptions ?? MAX_PUSH_SUBSCRIPTIONS;

  function classify(result: LeaseDocumentReadResult): WebPushDocument {
    if ("missing" in result) return { kind: WEB_PUSH_KIND, version: WEB_PUSH_VERSION, subscriptions: [] };
    const parsed = parseWebPushDocument(result.content, maxSubscriptions);
    if (parsed.warning || parsed.document === undefined) {
      throw new WebPushStoreError(parsed.warning ?? "PUSH_DOC_CORRUPT", "Web Push store failed validation");
    }
    return parsed.document;
  }

  async function readWith(io: HostStateDirectoryIo): Promise<WebPushDocument> {
    let result: LeaseDocumentReadResult;
    try {
      result = await io.readDocument(WEB_PUSH_FILE_NAME);
    } catch (error) {
      toStoreError(error);
    }
    return classify(result);
  }

  async function writeWith(io: HostStateDirectoryIo, document: WebPushDocument): Promise<void> {
    if (document.subscriptions.length > maxSubscriptions) {
      throw new WebPushStoreError("PUSH_SUBSCRIPTIONS_FULL", "Subscription set exceeds the bound");
    }
    try {
      await io.writeDocument(WEB_PUSH_FILE_NAME, serializeWebPushDocument(document));
    } catch (error) {
      toStoreError(error);
    }
  }

  return {
    async read() {
      let result: LeaseDocumentReadResult;
      try {
        result = await lease.readDocument(WEB_PUSH_FILE_NAME);
      } catch (error) {
        toStoreError(error);
      }
      return classify(result);
    },
    async getOrCreateVapidKeys(generate) {
      return lease.withLock(async (io) => {
        const current = await readWith(io);
        if (current.vapid !== undefined) return current.vapid;
        const keys = generate();
        if (
          typeof keys.publicKey !== "string" || !PUSH_VAPID_PUBLIC_KEY_PATTERN.test(keys.publicKey) ||
          typeof keys.privateKey !== "string" || !VAPID_PRIVATE_KEY_PATTERN.test(keys.privateKey)
        ) {
          throw new WebPushStoreError("PUSH_DOC_SPARSE", "Generated VAPID keys are malformed");
        }
        await writeWith(io, { ...current, vapid: keys });
        return keys;
      });
    },
    async upsertSubscription(subscription) {
      await lease.withLock(async (io) => {
        const current = await readWith(io);
        const record: WebPushSubscriptionRecord = {
          endpoint: subscription.endpoint,
          p256dh: subscription.p256dh,
          auth: subscription.auth,
          ...(subscription.deviceName === undefined ? {} : { deviceName: subscription.deviceName }),
          createdAt: subscription.createdAt ?? new Date().toISOString(),
        };
        const next = current.subscriptions.filter((item) => item.endpoint !== record.endpoint);
        if (next.length === current.subscriptions.length && next.length >= maxSubscriptions) {
          throw new WebPushStoreError("PUSH_SUBSCRIPTIONS_FULL", "Subscription set exceeds the bound");
        }
        next.push(record);
        await writeWith(io, { ...current, subscriptions: next });
      });
    },
    async removeSubscription(endpoint) {
      await lease.withLock(async (io) => {
        const current = await readWith(io);
        const next = current.subscriptions.filter((item) => item.endpoint !== endpoint);
        if (next.length === current.subscriptions.length) return;
        await writeWith(io, { ...current, subscriptions: next });
      });
    },
  };
}

/**
 * Validate the Web Push document before the lifetime lock is created (used by
 * the production composition's `validateBeforeLock`): missing ⇒ fine; corrupt
 * ⇒ fail startup without touching anything.
 */
export async function validateWebPushDocumentBeforeLock(
  readDocument: (name: string) => Promise<LeaseDocumentReadResult>,
): Promise<void> {
  const result = await readDocument(WEB_PUSH_FILE_NAME);
  if ("missing" in result) return;
  const parsed = parseWebPushDocument(result.content);
  if (parsed.warning || parsed.document === undefined) {
    throw new WebPushStoreError(parsed.warning ?? "PUSH_DOC_CORRUPT", "Web Push store failed validation");
  }
}
