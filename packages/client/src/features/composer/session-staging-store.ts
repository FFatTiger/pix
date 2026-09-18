/**
 * Bounded in-memory composer staging owner (Phase 4A.3.2a).
 *
 * Owns per-target staged model/thinking activation settings for the Composer
 * send transaction. Composer consumes this owner through SessionStagingProvider.
 * Purely in-memory — no localStorage, no TanStack Query, no UI strings
 * (errors are structured ProtocolErrors with fixed messages).
 *
 * Ownership rules:
 *  - typed keys: `session:<id>` (existing session) and `new:<transactionId>`
 *    (provisional brand-new-session transaction), bounded (default max 32,
 *    injectable);
 *  - strict model/thinking validation (invalid → `invalid_input`);
 *  - EMPTY records (no model AND no thinking) are removed automatically;
 *  - A/B staging is independent (per-exact-key);
 *  - NO silent eviction: a NEW key at capacity returns a structured
 *    `session_busy retryable:true` (the caller decides, never silently dropped);
 *  - `promote` moves a provisional `new:` record to its exact `session:` key
 *    SYNCHRONOUSLY, fail-closed on collision (target already has staging) and
 *    retains the source record on any failure;
 *  - every record carries an immutable monotonic `revision` (record identity:
 *    a NEW selection/edit — including re-selecting the same value — is a NEW
 *    revision). A send captures the target record's revision at submission;
 *    the accepted submission clears the record ONLY through
 *    {@link SessionStagingStore.clearMatching} while that revision still
 *    matches, so an old acknowledgement can never erase a newer selection and
 *    a cleared/newer intent can never be resurrected (no admission state lives
 *    here — the runtime controller owns the authoritative admission snapshot);
 *  - definite/activation failure and uncertain delivery PRESERVE staging (the
 *    caller simply never clears); a successful live model/thinking control
 *    clears ONLY the matching staged field (`clearModel`/`clearThinking`),
 *    removing the record only when both fields are empty;
 *  - `useSyncExternalStore` snapshots are immutable and reference-stable
 *    between mutations; provider unmount clears every record (`dispose`).
 */
import type { ProtocolError, ThinkingLevel } from "@fffattiger/pix-protocol";

export type StagingNewKey = `new:${string}`;
export type StagingSessionKey = `session:${string}`;
export type StagingKey = StagingNewKey | StagingSessionKey;

export interface StagedModelRef {
  readonly provider: string;
  readonly modelId: string;
}

/** Exact model identity comparison (provider + modelId). */
export function sameStagedModel(
  a: StagedModelRef | null | undefined,
  b: StagedModelRef | null | undefined,
): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return a.provider === b.provider && a.modelId === b.modelId;
}

export interface StagedActivationRecord {
  readonly key: StagingKey;
  /** Immutable record identity: a NEW selection/edit is a NEW revision. */
  readonly revision: number;
  readonly model: StagedModelRef | null;
  readonly thinking: ThinkingLevel | null;
}

export interface SessionStagingSnapshot {
  readonly records: readonly StagedActivationRecord[];
}

export type StageResult = { readonly ok: true } | { readonly ok: false; readonly error: ProtocolError };
export type PromoteResult = { readonly ok: true } | { readonly ok: false; readonly error: ProtocolError };

export interface SessionStagingStoreOptions {
  readonly maxRecords?: number;
}

const DEFAULT_MAX_RECORDS = 32;
const THINKING_LEVELS: ReadonlySet<string> = new Set([
  "off", "minimal", "low", "medium", "high", "xhigh", "max",
]);

/** Typed key guard: any non-empty id after the `session:`/`new:` prefix. */
export function isStagingKey(value: unknown): value is StagingKey {
  return typeof value === "string" && /^(session|new):.+$/.test(value);
}

export function isProvisionalStagingKey(value: unknown): value is StagingNewKey {
  return typeof value === "string" && /^new:.+$/.test(value);
}

/** Exact-session staging key. Empty ids are rejected by {@link SessionStagingStore.stage}. */
export function sessionStagingKey(sessionId: string): StagingSessionKey {
  return `session:${sessionId}` as StagingSessionKey;
}

/** Provisional new-session staging key for one home/create transaction. */
export function provisionalStagingKey(transactionId: string): StagingNewKey {
  return `new:${transactionId}` as StagingNewKey;
}

function isNewKey(value: StagingKey): value is StagingNewKey {
  return value.startsWith("new:");
}

function sessionKey(sessionId: string): StagingSessionKey {
  return sessionStagingKey(sessionId);
}

function validSessionId(sessionId: string): boolean {
  return typeof sessionId === "string" && sessionId.length > 0;
}

function validModel(model: StagedModelRef): boolean {
  return model !== null
    && typeof model === "object"
    && typeof model.provider === "string"
    && model.provider.trim().length > 0
    && typeof model.modelId === "string"
    && model.modelId.trim().length > 0;
}

function validThinking(level: ThinkingLevel): boolean {
  return THINKING_LEVELS.has(level);
}

function errorResult(code: ProtocolError["code"], message: string, retryable: boolean): StageResult & PromoteResult {
  return { ok: false, error: { code, message, retryable } };
}

export class SessionStagingStore {
  private readonly maxRecords: number;
  private readonly records = new Map<StagingKey, StagedActivationRecord>();
  private readonly listeners = new Set<() => void>();
  private snapshot: SessionStagingSnapshot;
  private disposed = false;
  /** Monotonic record identity: no two records ever share a revision. */
  private revisionSeq = 0;

  constructor(options: SessionStagingStoreOptions = {}) {
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    if (!Number.isInteger(this.maxRecords) || this.maxRecords < 1) {
      throw new Error("SessionStagingStore maxRecords must be a positive integer");
    }
    this.snapshot = this.computeSnapshot();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): SessionStagingSnapshot => this.snapshot;

  get max(): number { return this.maxRecords; }
  get count(): number { return this.records.size; }

  /** Pure exact lookup (no touch, no publish). */
  get(key: StagingKey): StagedActivationRecord | null {
    return this.records.get(key) ?? null;
  }

  /**
   * Stage a model/thinking choice for an exact key. `model`/`thinking` are
   * optional: passing `undefined` preserves the existing field, passing `null`
   * clears it. A record with neither field is removed. Never silently evicts:
   * a NEW key at capacity returns `session_busy retryable:true`.
   */
  stage(
    key: StagingKey,
    model?: StagedModelRef | null,
    thinking?: ThinkingLevel | null,
  ): StageResult {
    if (this.disposed) return errorResult("unavailable", "session staging disposed", false);
    if (!isStagingKey(key)) return errorResult("invalid_input", "invalid staging key", false);
    if (model !== undefined && model !== null && !validModel(model)) {
      return errorResult("invalid_input", "invalid staged model", false);
    }
    if (thinking !== undefined && thinking !== null && !validThinking(thinking)) {
      return errorResult("invalid_input", "invalid staged thinking level", false);
    }
    const existing = this.records.get(key);
    const nextModel = model !== undefined ? (model ?? null) : (existing?.model ?? null);
    const nextThinking = thinking !== undefined ? (thinking ?? null) : (existing?.thinking ?? null);
    if (nextModel === null && nextThinking === null) {
      // Empty records are removed.
      this.records.delete(key);
    } else if (existing !== undefined) {
      this.records.set(key, { key, revision: ++this.revisionSeq, model: nextModel, thinking: nextThinking });
    } else {
      // New record needs capacity; no silent eviction.
      if (this.records.size >= this.maxRecords) {
        return errorResult("session_busy", "session staging is full", true);
      }
      this.records.set(key, { key, revision: ++this.revisionSeq, model: nextModel, thinking: nextThinking });
    }
    this.publish();
    return { ok: true };
  }

  /** Accepted send clears the exact record (accepted → clear). */
  clear(key: StagingKey): void {
    if (this.records.delete(key)) this.publish();
  }

  /**
   * Accepted-submission clear, fenced by record identity: removes the record
   * ONLY while its revision still equals the revision the send captured. A
   * newer selection (a different value OR a re-selected same value — both are
   * new generations) is NEVER erased, and a captured `null` revision (no
   * staged record at send time) is a no-op. No admission state is created
   * here: the runtime controller owns the authoritative admission snapshot,
   * so a stale acknowledgement can never resurrect a cleared intent.
   */
  clearMatching(key: StagingKey, revision: number | null): void {
    if (revision === null) return;
    const existing = this.records.get(key);
    if (existing === undefined || existing.revision !== revision) return;
    this.records.delete(key);
    this.publish();
  }


  /** Successful live model control clears ONLY the model field (keeps thinking). */
  clearModel(key: StagingKey): void {
    const existing = this.records.get(key);
    if (existing === undefined) return;
    if (existing.thinking === null) {
      this.records.delete(key);
    } else {
      this.records.set(key, { key, revision: ++this.revisionSeq, model: null, thinking: existing.thinking });
    }
    this.publish();
  }

  /** Successful live thinking control clears ONLY the thinking field (keeps model). */
  clearThinking(key: StagingKey): void {
    const existing = this.records.get(key);
    if (existing === undefined) return;
    if (existing.model === null) {
      this.records.delete(key);
    } else {
      this.records.set(key, { key, revision: ++this.revisionSeq, model: existing.model, thinking: null });
    }
    this.publish();
  }

  /**
   * Provisional → exact SYNCHRONOUS promote. Fail closed on collision (target
   * `session:` key already has staging → `conflict`); the source `new:` record
   * is retained on ANY failure and removed only on success.
   */
  promote(sourceKey: StagingNewKey, sessionId: string): PromoteResult {
    if (this.disposed) return errorResult("unavailable", "session staging disposed", false);
    if (!isNewKey(sourceKey)) {
      return errorResult("invalid_input", "promote source must be a provisional new: key", false);
    }
    if (!this.records.has(sourceKey)) {
      return errorResult("not_found", "provisional staging not found", false);
    }
    if (!validSessionId(sessionId)) {
      return errorResult("invalid_input", "invalid target session id", false);
    }
    const source = this.records.get(sourceKey)!;
    const targetKey = sessionKey(sessionId);
    const target = this.records.get(targetKey);
    if (target !== undefined && (target.model !== null || target.thinking !== null)) {
      // Fail closed on collision; source retained.
      return errorResult("conflict", "target session already has staged activation settings", false);
    }
    this.records.delete(sourceKey);
    this.records.set(targetKey, { key: targetKey, revision: ++this.revisionSeq, model: source.model, thinking: source.thinking });
    this.publish();
    return { ok: true };
  }

  /** Provider unmount clears every record. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.records.clear();
    this.publish();
  }

  private computeSnapshot(): SessionStagingSnapshot {
    return { records: [...this.records.values()] };
  }

  private publish(): void {
    this.snapshot = this.computeSnapshot();
    for (const listener of [...this.listeners]) listener();
  }
}
