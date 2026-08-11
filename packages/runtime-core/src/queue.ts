/**
 * Canonical queued-message model for steer / follow-up messages that arrive
 * while a turn is running. The queue is part of the runtime state and must be
 * recoverable from a snapshot.
 */
import type { ImageAttachment } from "./messages.js";

export interface QueuedTurn {
  message: string;
  images?: readonly ImageAttachment[];
}

export interface QueuedMessages {
  steering: readonly QueuedTurn[];
  followUp: readonly QueuedTurn[];
}

export function emptyQueuedMessages(): QueuedMessages {
  return { steering: [], followUp: [] };
}

export function isQueueEmpty(queue: QueuedMessages): boolean {
  return queue.steering.length === 0 && queue.followUp.length === 0;
}
