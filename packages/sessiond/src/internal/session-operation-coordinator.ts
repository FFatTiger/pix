/**
 * Service-owned per-session FIFO identity coordinator (D4 session rename
 * upper-layer).
 *
 * Every identity mutation of one canonical session — activate, rename
 * (`sessions.rename` AND public `runtime.command(set_session_name)`), fork
 * (`runtime.command(fork)`), explicit stop, and delete — is admitted into the
 * SAME per-session FIFO lane. Same-id
 * operations serialize; different ids progress independently (there is NO
 * global identity lock and NO long I/O under the short global
 * {@link SessiondService.mutex}).
 *
 * Lane invariants:
 * - Each lane carries a unique owner token, a canonical id, the bound aliases
 *   (requested ids joined to this identity, e.g. after a worker rekey), and a
 *   monotonic identity generation that increments on rekey.
 * - The FIFO tail never rejects (a rejected/failed task can never poison later
 *   tasks) and one callback holds exactly one lane — it never re-admits
 *   recursively.
 * - Pending operation reservations are tracked as PER-KIND POSITIVE REFERENCE
 *   COUNTS (`Map<IdentityOperationKind, number>`), visible synchronously, so a
 *   delete can fail closed against an "earlier activation reservation" without
 *   waiting for the worker, and a lane is NEVER removed while a same-kind
 *   sibling is still queued/running — one settled task of a kind can never
 *   release a lane owned by another task of that same kind.
 * - Exact-owner cleanup: a lane (and every alias/generation) is removed only
 *   when the LAST pending reservation of EVERY kind settles, so success/failure
 *   leaves no coordinator/alias/generation leak.
 *
 * The coordinator is intentionally free of service internals (records, worker
 * connections, catalog, adapter): it only serializes identity operations and
 * exposes the alias/generation bookkeeping the service needs.
 */
import type { SessionHeader } from "@fffattiger/pix-runtime-core";

/** The identity operation kinds that share a per-session lane. */
export type IdentityOperationKind = "activate" | "submit" | "rename" | "fork" | "stop" | "delete";

interface Lane {
  /** Unique lane token (never re-created while the lane lives). */
  readonly token: object;
  /** Current canonical (authoritative) id; may change on rekey. */
  canonicalId: string;
  /** Every id bound to this identity (canonical id + requested-id aliases). */
  aliases: Set<string>;
  /** Monotonic identity generation; incremented on rekey. */
  generation: number;
  /** FIFO tail. NEVER rejects — failed tasks cannot poison later tasks. */
  tail: Promise<void>;
  /**
   * Per-kind positive reference counts of operations currently admitted
   * (running OR queued ahead). A lane drains only when the ENTIRE map is empty;
   * one same-kind sibling settling can never release the lane for another.
   */
  pending: Map<IdentityOperationKind, number>;
}

/** Identity-run context handed to each admitted operation. */
export interface IdentityOperationContext {
  /** Current canonical id at the moment the operation RUNS (may differ from the admitted id after a rekey). */
  readonly canonicalId: string;
  /** True when a rekey changed the lane generation after this operation was admitted. */
  readonly isStale: () => boolean;
}

/** Revisioned rename-title overlay entry. */
interface TitleEntry {
  name: string;
  revision: number;
}

/**
 * Service-owned revisioned title overlay (`sessionId -> {canonicalName,
 * revision}`). A title is published ONLY after a confirmed live/offline rename
 * success and applied to `sessions.list`/`sessions.read` through the service
 * wrappers. It bridges the window in which the read-side catalog has not yet
 * converged to the new title (offline rename converges immediately via the
 * shared adapter store; live rename converges when the Worker persists).
 *
 * - Retained across stop.
 * - Removed after a successful delete.
 * - Safely moved on rekey (never clobbers a newer target entry).
 * - A read that began before a newer publish (stale captured revision) can
 *   never clear the newer overlay entry.
 * - An entry is removed on read only when the catalog returns the SAME title
 *   (the catalog has converged to our rename) while the exact revision still
 *   owns the entry.
 * - Never alters id/path/timestamps/context — only the `title` field.
 */
export class SessionTitleOverlay {
  private readonly entries = new Map<string, TitleEntry>();
  private revisionCounter = 0;

  /** Publish a confirmed rename success. Bumps a fresh monotonic revision. */
  publish(sessionId: string, name: string): void {
    this.revisionCounter += 1;
    this.entries.set(sessionId, { name, revision: this.revisionCounter });
  }

  /** Remove an entry (after a successful delete). Idempotent. */
  remove(sessionId: string): void {
    this.entries.delete(sessionId);
  }

  /** Move an entry to a new canonical id on rekey; never clobbers a newer target. */
  move(fromId: string, toId: string): void {
    const entry = this.entries.get(fromId);
    if (!entry) return;
    const target = this.entries.get(toId);
    if (target && target.revision > entry.revision) {
      // The target already carries a newer rename — drop the stale source entry.
      this.entries.delete(fromId);
      return;
    }
    this.entries.delete(fromId);
    this.entries.set(toId, entry);
  }

  /** Revision observed by a read when it begins, for a single id. */
  captureFor(sessionId: string): number | undefined {
    return this.entries.get(sessionId)?.revision;
  }

  /** Revision snapshot observed by a list when it begins, per session id. */
  captureAll(): ReadonlyMap<string, number> {
    const captured = new Map<string, number>();
    for (const [id, entry] of this.entries) captured.set(id, entry.revision);
    return captured;
  }

  /**
   * Apply the overlay to a catalog header.
   *
   * - `capturedRevision` is the revision this read observed at start.
   * - A read that began before a newer publish can never clear the newer entry
   *   and always surfaces the current overlay title.
   * - A read that began at the current revision and whose catalog response
   *   matches the overlay title removes the entry (catalog converged; exact
   *   revision still owns the entry).
   * - A read that began at the current revision but whose catalog response
   *   disagrees (stale cache or external change) keeps the overlay so reads
   *   beginning after the successful rename still observe the new title; the
   *   entry is removed on a later convergent read.
   */
  apply(header: SessionHeader, capturedRevision: number | undefined): SessionHeader {
    const entry = this.entries.get(header.sessionId);
    if (!entry) return header;
    if (capturedRevision !== undefined && capturedRevision !== entry.revision) {
      // Read started before a newer publish → surface the current title, never clear.
      return { ...header, title: entry.name };
    }
    if (header.title === entry.name) {
      // Catalog has converged to our rename → the overlay has served its purpose.
      if (this.entries.get(header.sessionId) === entry) this.entries.delete(header.sessionId);
      return { ...header, title: entry.name };
    }
    return { ...header, title: entry.name };
  }

  /** Diagnostic count of live overlay entries (deterministic leak tests). */
  size(): number {
    return this.entries.size;
  }
}

/**
 * Per-session FIFO identity coordinator. See the module docstring for the
 * lane invariants. All methods are synchronous bookkeeping except the returned
 * operation promise; callers must never hold the global service mutex across
 * an admitted operation (the operation itself runs OUTSIDE the caller's lock).
 */
export class SessionOperationCoordinator {
  private readonly lanes = new Map<string, Lane>();
  private readonly aliasIndex = new Map<string, Lane>();

  /** Resolve the lane bound to `id` (canonical or alias), creating it if absent. */
  private laneFor(id: string): Lane {
    const existing = this.aliasIndex.get(id);
    if (existing) return existing;
    const lane: Lane = {
      token: {},
      canonicalId: id,
      aliases: new Set([id]),
      generation: 0,
      tail: Promise.resolve(),
      pending: new Map(),
    };
    this.lanes.set(id, lane);
    this.aliasIndex.set(id, lane);
    return lane;
  }

  /**
   * Admit an identity operation into the per-session FIFO lane.
   *
   * The per-kind reservation is incremented SYNCHRONOUSLY (before the operation
   * can be observed running and before any tail chaining), the operation waits
   * for every previously admitted operation of the same identity, and the lane
   * tail is made rejection-proof so a failed task never blocks the next one.
   * The returned promise settles with the operation result (rejection
   * propagates to this caller only); its `finally` decrements exactly one
   * reservation of this kind, removes the kind only at zero, and only then
   * performs exact-owner lane cleanup — so a settled same-kind sibling can
   * never release the lane while another same-kind operation is still pending.
   */
  admit<T>(id: string, kind: IdentityOperationKind, operation: (ctx: IdentityOperationContext) => Promise<T>): Promise<T> {
    const lane = this.laneFor(id);
    const generation = lane.generation;
    lane.pending.set(kind, (lane.pending.get(kind) ?? 0) + 1);
    const run = lane.tail.then(() =>
      operation({
        get canonicalId() {
          return lane.canonicalId;
        },
        isStale: () => lane.generation !== generation,
      }),
    );
    // Poisoning-immune tail: the next task never inherits this task's rejection.
    lane.tail = run.then(() => undefined, () => undefined);
    return run.finally(() => {
      this.releasePending(lane, kind);
    });
  }

  /**
   * Decrement exactly one per-kind reservation (Promise.finally semantics: a
   * rejected task still decrements exactly once). The kind is removed only at
   * zero; the lane is removed only when the whole map is empty. An underflow is
   * impossible by construction (each admit is paired with exactly one release
   * on the same lane/kind) — guard it fail-closed without leaking the lane.
   */
  private releasePending(lane: Lane, kind: IdentityOperationKind): void {
    const count = lane.pending.get(kind);
    if (count === undefined || count <= 0) {
      // Unreachable unless a bookkeeping bug introduced a mismatch. Fail closed:
      // never let a guard failure remove the lane mid-flight and orphan its
      // still-pending siblings (that is the exact same-kind race this counter
      // exists to prevent). A stray zero entry is tolerated; correct admit/
      // finally pairing never reaches this branch.
      lane.pending.set(kind, 0);
      return;
    }
    if (count === 1) lane.pending.delete(kind);
    else lane.pending.set(kind, count - 1);
    this.maybeRemoveLane(lane);
  }

  /**
   * Bind a rekeyed authoritative id to the same startup lane as the requested
   * id (called under the short global service mutex). Returns false when the
   * target already has an INDEPENDENT lane/reservation — the caller must fail
   * startup/rekey closed with a fixed conflict and never wait/merge/steal.
   * No-op (returns true) when the requested id has no lane (e.g. create-path
   * records that never joined a lane).
   */
  bindRekey(fromId: string, toId: string): boolean {
    const lane = this.aliasIndex.get(fromId);
    if (!lane) return true;
    if (toId === lane.canonicalId || lane.aliases.has(toId)) return true;
    const existing = this.aliasIndex.get(toId);
    if (existing && existing !== lane) return false;
    this.lanes.delete(lane.canonicalId);
    lane.canonicalId = toId;
    lane.aliases.add(toId);
    this.lanes.set(toId, lane);
    this.aliasIndex.set(toId, lane);
    lane.generation += 1;
    return true;
  }

  /** Canonical id for a requested id (undefined when no lane is bound). */
  resolveCanonical(id: string): string | undefined {
    return this.aliasIndex.get(id)?.canonicalId;
  }

  /** Whether `id` currently maps to any lane (canonical or alias). */
  hasLane(id: string): boolean {
    return this.aliasIndex.has(id);
  }

  /** Whether an operation of `kind` is currently admitted for `id` (running or queued). */
  hasPendingKind(id: string, kind: IdentityOperationKind): boolean {
    return (this.aliasIndex.get(id)?.pending.get(kind) ?? 0) > 0;
  }

  /**
   * True only when the lane contains exactly ONE reservation and it is the
   * currently-running operation of `kind`. Phase 5B uses this narrow exception
   * for the submit request that discovered turn-ledger capacity; any queued
   * sibling or different identity operation keeps rollover fail-closed.
   */
  isExclusivelyPending(id: string, kind: IdentityOperationKind): boolean {
    const lane = this.aliasIndex.get(id);
    return lane !== undefined && lane.pending.size === 1 && lane.pending.get(kind) === 1;
  }

  /** Exact-owner cleanup: remove the lane + every alias only when NO reservation of ANY kind remains. */
  private maybeRemoveLane(lane: Lane): void {
    if (lane.pending.size > 0) return;
    for (const alias of lane.aliases) this.aliasIndex.delete(alias);
    this.lanes.delete(lane.canonicalId);
  }

  /** Diagnostic view for deterministic leak tests. */
  diagnostics(): { lanes: number; aliases: number } {
    return { lanes: this.lanes.size, aliases: this.aliasIndex.size };
  }
}
