/**
 * Assistant residency supervisor (always-on Pixie).
 *
 * sessiond owns the assistant worker lifecycle: at daemon start the supervisor
 * resolves the MOST RECENT assistant conversation (the same read-only catalog
 * lookup `GET /v1/assistant` uses — `findLatestSessionByCwd` on the fixed
 * assistant workspace directory) and keeps exactly ONE worker resident on it.
 * With no conversation yet it stays ARMED: the first user message creates the
 * session through the normal create path (the Pi SDK persists a session file
 * at Agent creation, so pre-starting a worker would fabricate an empty
 * conversation — never done), and the ready record is adopted here.
 *
 * The tracked record is exempt from idle reclamation and is restarted after
 * an unexpected exit (or an explicit stop outside shutdown) with exponential
 * backoff, capped, with bounded diagnostics. Residency never prompts the
 * model, never schedules work, and never touches the completion-notification
 * logic (assistant-ops): it only keeps the process ready. Reloads keep the
 * worker alive through the normal authority-refresh path.
 *
 * Presence (armed/starting/online/restarting + tracked session id) projects
 * onto the revisioned running watch so clients can render an honest status
 * dot; `undefined` (not started / seam not wired) means no projection at all.
 */
import { isAssistantWorkspacePath } from "@fffattiger/pix-runtime-core";
import type { AssistantPresence } from "@fffattiger/pix-protocol";
import { SessiondError } from "./errors.js";

/** First retry delay; doubles per consecutive failure. */
const DEFAULT_RETRY_BASE_MS = 1_000;
/** Retry delay ceiling (the ladder never grows past this). */
const DEFAULT_RETRY_CAP_MS = 60_000;
/** Online duration that counts as a stable run (resets the ladder on exit). */
const DEFAULT_STABLE_ONLINE_MS = 60_000;

/** Narrow service surface the supervisor drives. The service owns records. */
export interface AssistantResidencySurface {
  /**
   * Most recent assistant conversation, or null when none exists. Throws
   * `unavailable` when the catalog seam is not wired (residency stays off)
   * and other errors for transient lookup failures (bounded retry).
   */
  findLatestAssistantSession(): Promise<{ sessionId: string } | null>;
  /** Activate the tracked session through the normal sessiond lane. */
  activate(sessionId: string): Promise<unknown>;
  /** True when the session currently has a live (non-crashed/stopped) record. */
  isLiveSession(sessionId: string): boolean;
  isShuttingDown(): boolean;
  /** Republish the running-watch presence projection (bumps the revision). */
  publishPresenceChanged(): void;
  /** Bounded diagnostics line (fixed prefix; never secrets or raw payloads). */
  log(line: string): void;
}

export interface AssistantResidencyOptions {
  /** Process home, for the assistant-workspace identity guard. */
  homedir: string;
  retryBaseMs?: number;
  retryCapMs?: number;
  /** Clock injection for deterministic stability tests (default Date.now). */
  now?: () => number;
  /**
   * How long the tracked worker must stay online before a later crash resets
   * the backoff ladder (default 60s). A worker that crashes before this is a
   * crash loop: the ladder keeps climbing instead of resetting on every
   * short-lived "online" blip.
   */
  stableOnlineMs?: number;
}

type Phase = "off" | "armed" | "starting" | "online" | "restarting";

const errorLine = (error: unknown): string => {
  if (error instanceof SessiondError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
};

export class AssistantResidencySupervisor {
  private readonly surface: AssistantResidencySurface;
  private readonly homedir: string;
  private readonly retryBaseMs: number;
  private readonly retryCapMs: number;
  private readonly stableOnlineMs: number;
  private readonly now: () => number;
  private started = false;
  private phase: Phase = "off";
  private trackedId: string | null = null;
  /** Consecutive activation failures; resets only after a stable run. */
  private attempt = 0;
  /** When the tracked worker (re)entered online; undefined while not online. */
  private onlineSince: number | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(surface: AssistantResidencySurface, options: AssistantResidencyOptions) {
    this.surface = surface;
    this.homedir = options.homedir;
    this.retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.retryCapMs = options.retryCapMs ?? DEFAULT_RETRY_CAP_MS;
    this.stableOnlineMs = options.stableOnlineMs ?? DEFAULT_STABLE_ONLINE_MS;
    this.now = options.now ?? Date.now;
  }

  /** Idempotent daemon bootstrap. Never throws; failures retry with backoff. */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.resolveLatest();
  }

  /** Drop armed timers (service shutdown). Records drain through stopRecord. */
  dispose(): void {
    this.started = false;
    this.clearTimer();
  }

  /** Running-watch projection; undefined while residency is not running. */
  presence(): AssistantPresence | undefined {
    if (this.phase === "off") return undefined;
    return { sessionId: this.trackedId, status: this.phase };
  }

  /** True for the ONE tracked record (idle-reclamation exemption). */
  isResident(sessionId: string): boolean {
    return this.started && this.phase !== "off" && sessionId === this.trackedId;
  }

  /**
   * A worker record reached ready. An assistant-workspace record is adopted as
   * the resident conversation: at boot (the activation we started), after the
   * first message created a conversation (armed → online), or when a NEWER
   * assistant conversation was created (the previous one loses the exemption
   * and follows the normal idle-reclamation path). Becoming ready does NOT
   * reset the backoff ladder — only a stable online period does
   * (see {@link scheduleRestart}) — or a crash loop would reset it on every
   * short-lived ready blip.
   */
  onRecordReady(sessionId: string, cwd: string): void {
    if (!this.started || this.phase === "off") return;
    if (!isAssistantWorkspacePath(cwd, this.homedir)) return;
    if (sessionId === this.trackedId && this.phase === "online") return;
    const adopted = sessionId !== this.trackedId;
    this.clearTimer();
    this.trackedId = sessionId;
    if (adopted) this.attempt = 0;
    this.onlineSince = this.now();
    this.phase = "online";
    this.surface.log(adopted
      ? `[assistant-residency] adopted assistant session as resident`
      : `[assistant-residency] assistant session is online`);
    this.surface.publishPresenceChanged();
  }

  /** The tracked worker exited unexpectedly while online: restart with backoff. */
  onRecordCrashed(sessionId: string): void {
    if (!this.started || sessionId !== this.trackedId) return;
    if (this.phase !== "online") return;
    this.scheduleRestart("assistant worker exited unexpectedly");
  }

  /**
   * The tracked record was stopped outside shutdown. Residency keeps the
   * conversation available: restart with backoff (shutdown drains first and
   * the guard below stays silent).
   */
  onRecordStopped(sessionId: string): void {
    if (!this.started || sessionId !== this.trackedId) return;
    if (this.phase !== "online") return;
    if (this.surface.isShuttingDown()) return;
    this.scheduleRestart("assistant worker was stopped");
  }

  /**
   * The tracked conversation was DELETED (the session file is gone). Staying
   * "online" would advertise a presence for a record that no longer exists, and
   * a restart ladder would loop on not_found. Re-resolve instead: the next
   * newest assistant conversation (or armed with none). Called by the service
   * AFTER the catalog delete committed, so the lookup cannot resurrect the
   * deleted id.
   */
  onSessionDeleted(sessionId: string): void {
    if (!this.started) return;
    if (this.surface.isShuttingDown()) return;
    if (sessionId !== this.trackedId) return;
    this.clearTimer();
    this.trackedId = null;
    this.attempt = 0;
    this.onlineSince = undefined;
    this.phase = "armed";
    void this.resolveLatest();
  }

  /** The tracked conversation rekeyed to its real session id: follow it. */
  onRekeyed(oldId: string, newId: string): void {
    if (!this.started || oldId !== this.trackedId || newId === oldId) return;
    this.trackedId = newId;
    this.surface.publishPresenceChanged();
  }

  // ---------------------------------------------------------------------

  private async resolveLatest(): Promise<void> {
    let latest: { sessionId: string } | null;
    try {
      latest = await this.surface.findLatestAssistantSession();
    } catch (error) {
      if (error instanceof SessiondError && error.code === "unavailable") {
        // Seam not wired (no catalog assistant lookup): residency stays off —
        // never a fallback scan, never a fake presence.
        this.surface.log(`[assistant-residency] unavailable: ${error.message}`);
        return;
      }
      this.scheduleRestart(`assistant lookup failed (${errorLine(error)})`);
      return;
    }
    if (latest === null) {
      // No conversation yet: armed. The first message creates it through the
      // normal create path; the ready record is adopted via onRecordReady.
      this.clearTimer();
      this.trackedId = null;
      this.attempt = 0;
      this.onlineSince = undefined;
      this.phase = "armed";
      this.surface.log("[assistant-residency] armed (no assistant conversation yet)");
      this.surface.publishPresenceChanged();
      return;
    }
    if (latest.sessionId !== this.trackedId) {
      this.trackedId = latest.sessionId;
      this.attempt = 0;
      this.onlineSince = undefined;
    }
    await this.activateTracked();
  }

  private async activateTracked(): Promise<void> {
    const sessionId = this.trackedId;
    if (sessionId === null || this.surface.isShuttingDown() || !this.started) return;
    this.phase = "starting";
    this.surface.publishPresenceChanged();
    try {
      await this.surface.activate(sessionId);
    } catch (error) {
      // A newer conversation may have been adopted (created) while this
      // activation was in flight; never clobber the adoption with the stale
      // id's failure — re-resolve instead.
      if (this.trackedId !== sessionId) { await this.resolveLatest(); return; }
      if (error instanceof SessiondError && error.code === "not_found") {
        // The conversation disappeared (deleted): back to armed, no retry.
        this.clearTimer();
        this.trackedId = null;
        this.attempt = 0;
        this.onlineSince = undefined;
        this.phase = "armed";
        this.surface.log("[assistant-residency] assistant conversation vanished; armed");
        this.surface.publishPresenceChanged();
        return;
      }
      this.scheduleRestart(`assistant activation failed (${errorLine(error)})`);
      return;
    }
    // Same adoption race on the success path: report online only for the id
    // actually activated; a switched tracked id re-resolves to the newest.
    if (this.trackedId !== sessionId) { await this.resolveLatest(); return; }
    if (this.surface.isLiveSession(sessionId)) {
      this.onlineSince = this.now();
      this.phase = "online";
      this.surface.publishPresenceChanged();
      return;
    }
    this.scheduleRestart("assistant record missing after activation");
  }

  /** Re-resolve and re-activate after the backoff delay. */
  private async retryNow(): Promise<void> {
    if (!this.started || this.surface.isShuttingDown()) return;
    await this.resolveLatest();
  }

  private scheduleRestart(reason: string): void {
    if (!this.started || this.surface.isShuttingDown()) return;
    // A run that stayed online past the stability threshold earns a ladder
    // reset; anything shorter is a crash loop and keeps climbing.
    if (this.onlineSince !== undefined && this.now() - this.onlineSince >= this.stableOnlineMs) {
      this.attempt = 0;
    }
    this.onlineSince = undefined;
    this.attempt += 1;
    const delay = Math.min(this.retryBaseMs * 2 ** (this.attempt - 1), this.retryCapMs);
    this.phase = "restarting";
    this.surface.log(`[assistant-residency] ${reason}; retry #${this.attempt} in ${delay}ms`);
    this.surface.publishPresenceChanged();
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.retryNow();
    }, delay);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
