import type {
  RuntimeEvent,
  RuntimeEventData,
} from "@fffattiger/pix-protocol";

export interface EventJournalOptions {
  maxEvents?: number;
  maxBytes?: number;
}

export interface JournalReplay {
  gap: boolean;
  events: readonly RuntimeEvent[];
}

const encoder = new TextEncoder();

/**
 * Event types that never advance the conversation fence
 * ({@link EventJournal.lastConversationEventId}). Every type listed here was
 * verified against the shared Protocol projection reducer
 * (`packages/protocol/src/projection.ts`): none of them can mutate messages,
 * the branch leaf, turn-running state, the steering/follow-up queue, or a
 * pending extension UI question — the only state a submitted turn races
 * against. They are broadcast noise (subagent streams, todo/side-chat/extension
 * UI state, cross-session running-set shims, titles, capability/built-in
 * projections) that streams while a client is otherwise current.
 *
 * Anything NOT in this set — including unknown or future wire types — counts
 * as a conversation event, so a new event type fails closed until it is
 * proven side-channel here against the reducer.
 */
export const SIDE_CHANNEL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "subagent_delta",
  "subagents_changed",
  "side_chat_delta",
  "side_chat_changed",
  "todo_changed",
  "extension_statuses",
  "extension_widgets",
  "extension_notification",
  "extension_error",
  "running_sessions_changed",
  "session_title",
  "built_ins_changed",
  "runtime_capabilities_changed",
]);

export interface JournalAppendResult {
  event: RuntimeEvent;
  evicted: readonly RuntimeEvent[];
}

export class EventJournal {
  private readonly entries: Array<{ event: RuntimeEvent; bytes: number }> = [];
  private totalBytes = 0;
  private nextId = 1;
  private conversationEventId = 0;
  readonly maxEvents: number;
  readonly maxBytes: number;

  constructor(options: EventJournalOptions = {}) {
    this.maxEvents = options.maxEvents ?? 2_000;
    this.maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxEvents) || this.maxEvents < 1) throw new RangeError("maxEvents must be a positive safe integer");
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1) throw new RangeError("maxBytes must be a positive safe integer");
  }

  get lastEventId(): number { return this.nextId - 1; }
  /** Event id of the most recent conversation (non-side-channel) event; 0 when none has been appended. */
  get lastConversationEventId(): number { return this.conversationEventId; }
  get firstEventId(): number { return this.entries[0]?.event.eventId ?? this.nextId; }
  get size(): number { return this.entries.length; }
  get bytes(): number { return this.totalBytes; }

  append(epoch: string, data: RuntimeEventData): RuntimeEvent {
    return this.appendDetailed(epoch, data).event;
  }

  appendDetailed(epoch: string, data: RuntimeEventData): JournalAppendResult {
    if (this.nextId > Number.MAX_SAFE_INTEGER) throw new RangeError("event cursor exhausted");
    const event = { ...data, epoch, eventId: this.nextId } as RuntimeEvent;
    const bytes = encoder.encode(JSON.stringify(event)).byteLength;
    const evicted: RuntimeEvent[] = [];
    this.nextId += 1;
    if (!SIDE_CHANNEL_EVENT_TYPES.has(data.type)) this.conversationEventId = event.eventId;
    this.entries.push({ event, bytes });
    this.totalBytes += bytes;
    while (this.entries.length > this.maxEvents || this.totalBytes > this.maxBytes) {
      const removed = this.entries.shift();
      if (removed) { this.totalBytes -= removed.bytes; evicted.push(removed.event); }
    }
    return { event, evicted };
  }

  replayAfter(lastEventId: number): JournalReplay {
    if (!Number.isSafeInteger(lastEventId) || lastEventId < 0) return { gap: true, events: [] };
    if (lastEventId > this.lastEventId) return { gap: true, events: [] };
    if (lastEventId < this.firstEventId - 1) return { gap: true, events: [] };
    return { gap: false, events: this.entries.filter(({ event }) => event.eventId > lastEventId).map(({ event }) => event) };
  }

  /** Test-only cursor positioning for overflow policy verification. */
  setNextEventIdForTest(nextEventId: number): void {
    if (!Number.isSafeInteger(nextEventId) || nextEventId < 1) throw new RangeError("nextEventId must be positive");
    this.nextId = nextEventId;
    this.conversationEventId = nextEventId - 1;
  }

  snapshot(): readonly RuntimeEvent[] { return this.entries.map(({ event }) => event); }
}
