import {
  reduceRuntimeEventData,
  type RuntimeEventData,
  type RuntimeSnapshot,
} from "@fffattiger/pix-protocol";

/**
 * Mutable sessiond authority wrapper around the shared, pure Protocol
 * {@link reduceRuntimeEventData} reducer (see
 * `@fffattiger/pix-protocol/projection`). This class is the single
 * authoritative accumulator on the host side; the browser SessionStore reduces
 * through the exact same pure function so the two projections can never drift.
 *
 * Public behavior is unchanged from the previous in-process implementation:
 *  - {@link snapshot} / {@link replace} clone defensively.
 *  - {@link apply} delegates to the Protocol reducer (which throws on session
 *    mismatch before mutating).
 *  - {@link rekey} rewrites the session id in place (host-only concern).
 */
const clone = <T>(value: T): T => structuredClone(value);

export class SnapshotProjection {
  private snapshotValue: RuntimeSnapshot;

  constructor(initial: RuntimeSnapshot) {
    this.snapshotValue = clone(initial);
  }

  snapshot(): RuntimeSnapshot {
    return clone(this.snapshotValue);
  }

  replace(snapshot: RuntimeSnapshot): void {
    this.snapshotValue = clone(snapshot);
  }

  /** Rewrite the session id on the snapshot and its nested state (host only). */
  rekey(sessionId: string): void {
    this.snapshotValue.sessionId = sessionId;
    this.snapshotValue.state.sessionId = sessionId;
  }

  /**
   * Apply a single {@link RuntimeEventData} via the shared Protocol reducer.
   * Throws on session id mismatch; the snapshot is untouched on throw.
   */
  apply(event: RuntimeEventData): void {
    this.snapshotValue = reduceRuntimeEventData(this.snapshotValue, event);
  }
}
