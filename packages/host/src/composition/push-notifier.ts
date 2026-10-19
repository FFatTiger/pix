/**
 * Host-owned Web Push notifier (D-PUSH).
 *
 * ONE Host-level subscription to the sessiond running watch (the same
 * revisioned `RuntimeRunningState` source the runtime WS gateway forwards per
 * browser): never one judgement per WS connection. Set transitions become
 * notification candidates; every candidate passes per-device attention
 * suppression (only the endpoint(s) on a device currently being looked at are
 * skipped — other devices always receive), a fixed debounce window,
 * read-only session catalog lookups (zero Worker activation) and the durable
 * subscription list before a single push is sent.
 *
 * Honesty rules: a failed session lookup degrades to generic copy (never a
 * fabricated name/preview); an aborted turn is not notified; a sessiond watch
 * loss reconnects with a fresh baseline (no replay spam); send failures are
 * logged once and never retried except pruning 404/410 subscriptions.
 */
import { createHash } from "node:crypto";
import {
  ASSISTANT_SENT_MESSAGE_PREFIX,
  SessionContextSchema,
  SessionDetailSchema,
  type RuntimeRunningState,
  type SessiondRunningWatchPush,
} from "@fffattiger/pix-protocol";
import type { PushNotificationPayload } from "@fffattiger/pix-protocol/push";
import type { WebPushStore, WebPushSubscriptionRecord } from "../resources/web-push-store.js";
import type { WebPushSender } from "../resources/web-push-sender.js";
import type { HostLogger } from "../types.js";
import type { VisibilityTracker } from "./visibility-tracker.js";

/** Narrow sessiond running-watch seam (the real SessiondRpcClient satisfies it). */
export interface RunningWatchClient {
  watchRunning(
    onPush: (push: SessiondRunningWatchPush) => void | Promise<void>,
  ): Promise<{
    readonly response: RuntimeRunningState;
    close(): void;
    readonly closed: Promise<void>;
  }>;
}

/** Narrow read-only session catalog seam (never activates a Worker). */
export interface NotificationSessionLookup {
  read(sessionId: string): Promise<unknown>;
  context(sessionId: string, options?: { limit?: number }): Promise<unknown>;
}

export interface PushNotifierOptions {
  readonly watch: RunningWatchClient;
  readonly sessions: NotificationSessionLookup;
  readonly store: WebPushStore;
  readonly sender: WebPushSender;
  readonly visibility: VisibilityTracker;
  /** Current UI locale from the server preference map ("zh-CN" / "en"). */
  readonly locale: () => string;
  readonly now?: () => number;
  readonly setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  readonly clearTimeoutFn?: (handle: unknown) => void;
  readonly logger?: HostLogger;
  /** Same session + kind suppression window (default 10s). */
  readonly debounceMs?: number;
  /** Watch reconnect backoff base (default 5s, doubled per attempt, capped 60s). */
  readonly retryBaseMs?: number;
}

/** Normalized running sets used by the pure transition decision. */
export interface RunningSets {
  readonly running: ReadonlySet<string>;
  readonly waiting: ReadonlySet<string>;
}

export type NotificationKind = "waiting" | "done" | "error";

export interface NotificationCandidate {
  readonly sessionId: string;
  readonly kind: "waiting" | "ended";
}

export function toRunningSets(state: RuntimeRunningState): RunningSets {
  return {
    running: new Set(state.sessionIds),
    waiting: new Set(state.waitingSessionIds ?? []),
  };
}

/**
 * Pure transition decision. `previous === undefined` means "baseline only":
 * the first running state after (re)connect establishes the baseline and
 * never notifies. Waiting wins over ended for the same session in one
 * transition (a session cannot leave running INTO waiting in the same push,
 * but ordering keeps the outcome deterministic if it ever did).
 */
export function decideNotifications(
  previous: RunningSets | undefined,
  next: RunningSets,
): NotificationCandidate[] {
  if (previous === undefined) return [];
  const candidates: NotificationCandidate[] = [];
  for (const sessionId of next.waiting) {
    if (!previous.waiting.has(sessionId)) candidates.push({ sessionId, kind: "waiting" });
  }
  for (const sessionId of previous.running) {
    if (!next.running.has(sessionId) && !next.waiting.has(sessionId)) {
      candidates.push({ sessionId, kind: "ended" });
    }
  }
  return candidates;
}

/** Classify a finished turn from the final assistant message's stopReason. */
export function classifyEndedTurn(stopReason: string | undefined): NotificationKind | "aborted" {
  if (stopReason === "error") return "error";
  if (stopReason === "aborted") return "aborted";
  return "done";
}

const NAME_MAX_CHARS = 60;
const PREVIEW_MAX_CHARS = 80;

/** Session display name: explicit title, else first message (marker line stripped, bounded). */
export function sessionDisplayName(
  header: { title?: string; firstMessage?: string } | undefined,
  fallback: string,
): string {
  if (header?.title !== undefined && header.title.trim() !== "") return truncate(header.title.trim(), NAME_MAX_CHARS);
  const first = header?.firstMessage;
  if (first !== undefined) {
    const stripped = first.startsWith(ASSISTANT_SENT_MESSAGE_PREFIX)
      ? first.slice(ASSISTANT_SENT_MESSAGE_PREFIX.length)
      : first;
    const label = stripped.replace(/\s+/g, " ").trim();
    if (label !== "") return truncate(label, NAME_MAX_CHARS);
  }
  return fallback;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Deep-link into the app: assistant conversations land on the assistant view. */
export function notificationUrl(sessionId: string, cwd: string | undefined, assistant: boolean): string {
  if (assistant) return "/?assistant=1";
  if (cwd === undefined) return `/?session=${encodeURIComponent(sessionId)}`;
  return `/?session=${encodeURIComponent(sessionId)}&cwd=${encodeURIComponent(cwd)}`;
}

export interface PushCopy {
  readonly locale: "zh-CN" | "en";
  readonly waitingTitle: string;
  readonly doneTitle: string;
  readonly errorTitle: string;
  readonly testTitle: string;
  readonly testBody: string;
  readonly sessionFallbackName: string;
}

/** Fixed notification copy per supported locale (server-side, no t()). */
export function pickPushCopy(locale: string): PushCopy {
  if (locale === "zh-CN" || locale === "zh") {
    return {
      locale: "zh-CN",
      waitingTitle: "等你回答",
      doneTitle: "已完成",
      errorTitle: "出错了",
      testTitle: "测试通知",
      testBody: "这是一条测试通知，用于确认系统通知工作正常。",
      sessionFallbackName: "会话",
    };
  }
  return {
    locale: "en",
    waitingTitle: "Waiting for your answer",
    doneTitle: "Completed",
    errorTitle: "Something went wrong",
    testTitle: "Test notification",
    testBody: "This is a test notification confirming system notifications work.",
    sessionFallbackName: "Session",
  };
}

interface LastAssistantScan {
  /** stopReason of the FINAL assistant entry (classification authority). */
  readonly stopReason: string | undefined;
  /** Text of the last assistant entry that actually carried text. */
  readonly preview: string | undefined;
}

/** Extract classification + reply preview from a context page (bounded, pure). */
export function scanLastAssistant(entries: readonly unknown[]): LastAssistantScan | undefined {
  let stopReason: string | undefined;
  let preview: string | undefined;
  let sawAssistant = false;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === null || typeof entry !== "object") continue;
    const message = (entry as { message?: unknown }).message;
    if (message === null || typeof message !== "object") continue;
    if ((message as { role?: unknown }).role !== "assistant") continue;
    if (!sawAssistant) {
      sawAssistant = true;
      const reason = (message as { stopReason?: unknown }).stopReason;
      stopReason = typeof reason === "string" ? reason : undefined;
    }
    if (preview === undefined) {
      const content = (message as { content?: unknown }).content;
      if (Array.isArray(content)) {
        const text = content
          .filter((block): block is { type: "text"; text: string } =>
            block !== null && typeof block === "object" && (block as { type?: unknown }).type === "text")
          .map((block) => block.text)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        if (text !== "") preview = truncate(text, PREVIEW_MAX_CHARS);
      }
    }
    if (sawAssistant && preview !== undefined) break;
  }
  return sawAssistant ? { stopReason, preview } : undefined;
}

/**
 * Send a test notification to one endpoint (the settings page's button).
 * Prunes the subscription on 404/410 exactly like the trigger path. Honest
 * outcomes: `missing` (unknown endpoint / no keys), `sent`, `gone` (push
 * service reported the subscription dead); anything else rethrows so the
 * route can fail honestly instead of faking success.
 */
export async function sendTestNotification(
  deps: Pick<PushNotifierOptions, "store" | "sender" | "logger"> & { locale: () => string },
  endpoint: string,
): Promise<"sent" | "gone" | "missing"> {
  const document = await deps.store.read();
  const subscription = document.subscriptions.find((item) => item.endpoint === endpoint);
  if (subscription === undefined || document.vapid === undefined) return "missing";
  const copy = pickPushCopy(deps.locale());
  const payload: PushNotificationPayload = {
    title: copy.testTitle,
    body: copy.testBody,
    url: "/",
    tag: "pix-test",
  };
  const result = await deps.sender.send(subscription, document.vapid, payload);
  if (result === "gone") {
    await pruneSubscription(deps, subscription);
    return "gone";
  }
  return "sent";
}

async function pruneSubscription(
  deps: Pick<PushNotifierOptions, "store" | "logger">,
  subscription: WebPushSubscriptionRecord,
): Promise<void> {
  try {
    await deps.store.removeSubscription(subscription.endpoint);
    deps.logger?.info?.("pruned dead push subscription");
  } catch (error) {
    deps.logger?.warn?.("failed to prune dead push subscription", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Lowercase SHA-256 hex of a push endpoint — the exact digest a client
 * reports as `pushEndpointHash` in its `visibility` frames, so the Host can
 * match "device being looked at" to a subscription without ever storing or
 * receiving the endpoint itself.
 */
export function hashPushEndpoint(endpoint: string): string {
  return createHash("sha256").update(endpoint, "utf8").digest("hex");
}

const DEFAULT_DEBOUNCE_MS = 10_000;
const DEFAULT_RETRY_BASE_MS = 5_000;
const MAX_RETRY_MS = 60_000;

/**
 * The Host-level notifier. Owns exactly ONE running-watch subscription for
 * the whole process plus the debounce bookkeeping; everything else is
 * delegated to the injected seams.
 */
export class PushNotifier {
  private readonly options: PushNotifierOptions;
  private readonly debounce = new Map<string, number>();
  private readonly now: () => number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private readonly debounceMs: number;
  private readonly retryBaseMs: number;
  private readonly logger: HostLogger;
  private baseline: RunningSets | undefined;
  private assistantSessionId: string | null = null;
  private subscription: { close(): void; readonly closed: Promise<void> } | undefined;
  private retryTimer: unknown;
  private retryAttempt = 0;
  private queue: Promise<void> = Promise.resolve();
  private started = false;
  private stopped = false;

  constructor(options: PushNotifierOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.logger = options.logger ?? {};
  }

  /** Open the single running-watch subscription (idempotent until stop). */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    void this.openWatch();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.retryTimer !== undefined) this.clearTimeoutFn(this.retryTimer);
    this.retryTimer = undefined;
    this.subscription?.close();
    this.subscription = undefined;
  }

  private async openWatch(): Promise<void> {
    if (this.stopped) return;
    try {
      const subscription = await this.options.watch.watchRunning((push) => this.onPush(push));
      if (this.stopped) {
        subscription.close();
        return;
      }
      this.subscription = subscription;
      this.retryAttempt = 0;
      this.adoptBaseline(subscription.response);
      void subscription.closed.then(() => {
        this.subscription = undefined;
        if (!this.stopped) this.scheduleWatchRetry("running watch closed");
      });
    } catch {
      this.scheduleWatchRetry("running watch failed");
    }
  }

  private scheduleWatchRetry(reason: string): void {
    if (this.stopped || this.retryTimer !== undefined) return;
    const delay = Math.min(this.retryBaseMs * 2 ** this.retryAttempt, MAX_RETRY_MS);
    this.retryAttempt += 1;
    this.logger.warn?.(`push notifier: ${reason}; retrying watch`, { delayMs: delay });
    this.retryTimer = this.setTimeoutFn(() => {
      this.retryTimer = undefined;
      void this.openWatch();
    }, delay);
  }

  /** Host start (and every reconnect) begins with a silent baseline. */
  private adoptBaseline(state: RuntimeRunningState): void {
    this.baseline = toRunningSets(state);
    this.trackAssistant(state);
  }

  private trackAssistant(state: RuntimeRunningState): void {
    const assistant = state.assistant?.sessionId;
    if (assistant !== undefined) this.assistantSessionId = assistant;
  }

  private onPush(push: SessiondRunningWatchPush): void {
    if (push.type === "sessions_changed") return;
    const state = push.state;
    this.trackAssistant(state);
    const previous = this.baseline;
    this.baseline = toRunningSets(state);
    const candidates = decideNotifications(previous, this.baseline);
    if (candidates.length === 0) return;
    // Serialize candidate handling through one queue so debounce bookkeeping
    // can never interleave.
    for (const candidate of candidates) {
      this.queue = this.queue.then(() => this.handle(candidate)).catch(() => undefined);
    }
  }

  private async handle(candidate: NotificationCandidate): Promise<void> {
    if (this.stopped) return;
    const debounceKey = `${candidate.sessionId}:${candidate.kind}`;
    const last = this.debounce.get(debounceKey);
    const timestamp = this.now();
    if (last !== undefined && timestamp - last < this.debounceMs) return;

    const document = await this.options.store.read();
    if (document.subscriptions.length === 0 || document.vapid === undefined) return;

    // Per-device suppression: skip only the endpoint(s) whose device currently
    // has an attended (visible + focused) connection. Every other subscribed
    // device — and every subscription when no device is attended — still gets
    // the notification.
    const attended = this.options.visibility.attendedEndpointHashes();
    const targets = attended.size === 0
      ? document.subscriptions
      : document.subscriptions.filter((subscription) => !attended.has(hashPushEndpoint(subscription.endpoint)));
    if (targets.length === 0) return;

    const copy = pickPushCopy(this.options.locale());
    const assistant = candidate.sessionId === this.assistantSessionId;
    const payload = await this.buildPayload(candidate, copy, assistant);
    if (payload === undefined) return; // aborted / nothing to say

    this.debounce.set(debounceKey, this.now());
    await Promise.all(targets.map((subscription) => this.deliver(subscription, document.vapid!, payload)));
  }

  private async buildPayload(
    candidate: NotificationCandidate,
    copy: PushCopy,
    assistant: boolean,
  ): Promise<PushNotificationPayload | undefined> {
    let header: { title?: string; firstMessage?: string; cwd?: string } | undefined;
    try {
      const raw = await this.options.sessions.read(candidate.sessionId);
      const parsed = SessionDetailSchema.safeParse(raw);
      if (parsed.success) {
        header = {
          ...(parsed.data.title === undefined ? {} : { title: parsed.data.title }),
          ...(parsed.data.firstMessage === undefined ? {} : { firstMessage: parsed.data.firstMessage }),
          cwd: parsed.data.cwd,
        };
      }
    } catch (error) {
      this.logger.warn?.("push notifier: session read failed; using generic copy", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const name = assistant ? "Pixie" : sessionDisplayName(header, copy.sessionFallbackName);

    if (candidate.kind === "waiting") {
      return {
        title: copy.waitingTitle,
        body: name,
        url: notificationUrl(candidate.sessionId, header?.cwd, assistant),
        tag: candidate.sessionId,
      };
    }

    let kind: NotificationKind = "done";
    let preview: string | undefined;
    try {
      const raw = await this.options.sessions.context(candidate.sessionId, { limit: 30 });
      const parsed = SessionContextSchema.safeParse(raw);
      if (parsed.success) {
        const scan = scanLastAssistant(parsed.data.entries);
        if (scan !== undefined) {
          const classified = classifyEndedTurn(scan.stopReason);
          if (classified === "aborted") return undefined;
          kind = classified;
          preview = scan.preview;
        }
      }
    } catch (error) {
      this.logger.warn?.("push notifier: session context failed; using generic copy", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const title = kind === "error" ? copy.errorTitle : copy.doneTitle;
    // Preview text only on a normal completion — an error turn's last text is
    // not an answer and must never be presented as one.
    const body = kind === "done" && preview !== undefined
      ? `${name}${copy.locale === "zh-CN" ? "：" : ": "}${preview}`
      : name;
    return {
      title,
      body,
      url: notificationUrl(candidate.sessionId, header?.cwd, assistant),
      tag: candidate.sessionId,
    };
  }

  private async deliver(
    subscription: WebPushSubscriptionRecord,
    keys: { publicKey: string; privateKey: string },
    payload: PushNotificationPayload,
  ): Promise<void> {
    try {
      const result = await this.options.sender.send(subscription, keys, payload);
      if (result === "gone") {
        try {
          await this.options.store.removeSubscription(subscription.endpoint);
          this.logger.info?.("pruned dead push subscription");
        } catch (error) {
          this.logger.warn?.("failed to prune dead push subscription", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      // One sanitized log line; never a retry storm and never the endpoint.
      this.logger.warn?.("push send failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }
}
