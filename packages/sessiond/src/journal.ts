import type {
  RuntimeEvent,
  RuntimeEventData,
} from "@fffattiger/pi-web-protocol";

export interface EventJournalOptions {
  maxEvents?: number;
  maxBytes?: number;
}

export interface JournalReplay {
  gap: boolean;
  events: readonly RuntimeEvent[];
}

const encoder = new TextEncoder();

export interface JournalAppendResult {
  event: RuntimeEvent;
  evicted: readonly RuntimeEvent[];
}

export class EventJournal {
  private readonly entries: Array<{ event: RuntimeEvent; bytes: number }> = [];
  private totalBytes = 0;
  private nextId = 1;
  readonly maxEvents: number;
  readonly maxBytes: number;

  constructor(options: EventJournalOptions = {}) {
    this.maxEvents = options.maxEvents ?? 2_000;
    this.maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxEvents) || this.maxEvents < 1) throw new RangeError("maxEvents must be a positive safe integer");
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1) throw new RangeError("maxBytes must be a positive safe integer");
  }

  get lastEventId(): number { return this.nextId - 1; }
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
  }

  snapshot(): readonly RuntimeEvent[] { return this.entries.map(({ event }) => event); }
}
