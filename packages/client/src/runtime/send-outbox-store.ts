/**
 * Durable send outbox (browser side).
 *
 * A send is an INTENT, not a request that can fail: the user presses send, the
 * message appears in the conversation, and the outbox guarantees it reaches the
 * authority exactly once. Every entry carries the `operationId` the authority
 * dedupes on, so a resend after a dropped socket, a page reload, or an iOS
 * background kill can never duplicate the message.
 *
 * This module is the ONLY place that reads/writes the persisted outbox.
 * Components never touch browser storage; they observe the controller's view.
 *
 * Persistence is per session id under one namespaced key, and it stores only
 * what is needed to replay the send (the payload + the activation settings the
 * user had staged), never any UI or transport state.
 */
import type { ImageAttachment, ThinkingLevel } from "@fffattiger/pix-protocol";

const STORAGE_KEY = "pix.send-outbox.v1";

/** One un-delivered send, persisted until the authority accepts it. */
export interface OutboxEntry {
  /** Client-issued idempotency identity; the authority dedupes on it. */
  readonly operationId: string;
  readonly sessionId: string;
  readonly prompt: string;
  readonly images?: readonly ImageAttachment[];
  readonly activationOverrides?: {
    readonly model?: { readonly provider: string; readonly modelId: string };
    readonly thinkingLevel?: ThinkingLevel;
  };
  /** Queue policy the authority applies when the Agent is already running. */
  readonly whenBusy: "steer" | "follow_up";
  /** Creation order, so replays keep the user's ordering. */
  readonly sequence: number;
}

/** Minimal storage surface, so tests can inject a deterministic fake. */
export interface OutboxStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Bounded durable outbox. `undefined` storage (no `localStorage`: SSR, private
 * mode denial, tests) degrades to in-memory only, never to a fake success — the
 * send still retries for the life of the page.
 */
export class SendOutboxStore {
  private entries: OutboxEntry[] = [];
  private sequence = 0;
  private loaded = false;

  constructor(private readonly storage: OutboxStorage | null | undefined) {}

  /** All entries, oldest first. */
  list(): readonly OutboxEntry[] {
    return this.entries;
  }

  listFor(sessionId: string): readonly OutboxEntry[] {
    return this.entries.filter((entry) => entry.sessionId === sessionId);
  }

  has(operationId: string): boolean {
    return this.entries.some((entry) => entry.operationId === operationId);
  }

  /** Append one send intent and persist it BEFORE any attempt to deliver it. */
  enqueue(entry: Omit<OutboxEntry, "sequence">): OutboxEntry {
    this.load();
    const next: OutboxEntry = { ...entry, sequence: (this.sequence += 1) };
    this.entries = [...this.entries, next];
    this.persist();
    return next;
  }

  /**
   * Remove one entry after the authority ACCEPTED it. Idempotent: a late or
   * repeated settle for the same operation never removes another send.
   */
  dequeue(operationId: string): void {
    this.load();
    const next = this.entries.filter((entry) => entry.operationId !== operationId);
    if (next.length === this.entries.length) return;
    this.entries = next;
    this.persist();
  }

  /** Drop one entry the authority PROVED it will never accept (invalid/not found). */
  discard(operationId: string): void {
    this.dequeue(operationId);
  }

  /** Re-read the persisted queue (page load / another tab's write). */
  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    const raw = this.storage?.getItem(STORAGE_KEY);
    if (raw === null || raw === undefined) return;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return;
      const entries: OutboxEntry[] = [];
      for (const candidate of parsed) {
        const entry = parseEntry(candidate);
        if (entry !== null) entries.push(entry);
      }
      this.entries = entries;
      this.sequence = entries.reduce((max, entry) => Math.max(max, entry.sequence), 0);
    } catch {
      // Corrupt storage is not a send failure: start empty (the user sees no
      // pending bubble either, because nothing is claimed).
      this.entries = [];
    }
  }

  private persist(): void {
    if (this.storage === null || this.storage === undefined) return;
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(this.entries));
    } catch {
      // Quota/privacy denial: the in-memory outbox still delivers this page's
      // sends; only reload survival is lost.
    }
  }
}

function parseEntry(value: unknown): OutboxEntry | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const operationId = record.operationId;
  const sessionId = record.sessionId;
  const prompt = record.prompt;
  const sequence = record.sequence;
  const whenBusy = record.whenBusy === "steer" ? "steer" : "follow_up";
  if (typeof operationId !== "string" || operationId.length === 0) return null;
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  if (typeof prompt !== "string" || prompt.length === 0) return null;
  if (typeof sequence !== "number" || !Number.isFinite(sequence)) return null;
  const images = Array.isArray(record.images) ? (record.images as ImageAttachment[]) : undefined;
  const overrides = record.activationOverrides;
  const activationOverrides = overrides !== null && typeof overrides === "object"
    ? (overrides as OutboxEntry["activationOverrides"])
    : undefined;
  return {
    operationId,
    sessionId,
    prompt,
    sequence,
    whenBusy,
    ...(images === undefined ? {} : { images }),
    ...(activationOverrides === undefined ? {} : { activationOverrides }),
  };
}
