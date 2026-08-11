/**
 * Stable session-scoped monotonic id mints for message stream correlation.
 *
 * IDs are worker-local: a single monotonic counter backs both `streamId` and
 * `messageId` so that `message_start` → `message_update`* → `message_end` for
 * one stream share identical correlation ids within a worker's lifetime. They
 * are NOT persisted across worker restarts — on restart the sessiond
 * projection rebuilds from a fresh snapshot, which mints its own ids.
 */
export interface StreamIds {
  readonly streamId: string;
  readonly messageId: string;
}

export class StreamIdMinter {
  private counter = 0;
  /** Mint a fresh, never-reused pair of correlation ids. */
  mint(): StreamIds {
    this.counter += 1;
    return { streamId: `stream-${this.counter}`, messageId: `msg-${this.counter}` };
  }
}
