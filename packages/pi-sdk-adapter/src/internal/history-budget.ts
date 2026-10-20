// Budgeted direct-history page fitting (zero workers).
//
// `sessions.context` must never fail on size alone: a session whose active
// branch exceeds the lightweight history budget (protocol
// `MAX_HISTORY_RESPONSE_BYTES`) is served as the NEWEST suffix of complete
// entries that fits, with `pageInfo.hasMore` + `nextCursor` so the caller pages
// older slices through the existing `before` cursor. A single entry that alone
// exceeds the budget is shrunk in place — inline base64 media becomes a truthful
// omission summary and every oversized text payload is truncated behind its own
// visible in-band marker — so the projection never drops entries and never
// truncates silently.
//
// Sizing is measured on the EXACT page the producer is about to return (the
// caller passes its own builder), newline-inclusive, which is the same
// arithmetic the sessiond RPC writer applies to the serialized response.
import { utf8ByteLength } from "@fffattiger/pix-protocol";
import type { SessionEntry } from "@fffattiger/pix-runtime-core";

/** Bisection rounds for the largest fitting text fraction (1/2^N precision). */
const SHRINK_ITERATIONS = 8;

/** Visible in-band marker for one truncated payload, with its exact byte loss. */
const truncationMarker = (removedBytes: number): string =>
  `[${removedBytes} bytes truncated from initial history payload]`;

/** Marker used when a whole entry has to be reduced to a minimal stub. */
const ENTRY_STUB_MARKER = "[entry content truncated: exceeds the history response budget]";

const pageBytes = (value: unknown): number => utf8ByteLength(`${JSON.stringify(value)}\n`);

const entryBytes = (value: unknown): number => utf8ByteLength(JSON.stringify(value)) + 1;

interface TextPayload {
  /** Path inside the entry document (`message.content[i].text`, …). */
  readonly path: readonly (string | number)[];
  readonly text: string;
  /** Tool-call arguments: restored as a visible `{truncated, preview}` object. */
  readonly json: boolean;
}

function readPath(target: unknown, path: readonly (string | number)[]): unknown {
  let cursor: unknown = target;
  for (const key of path) cursor = (cursor as Record<string | number, unknown>)[key]!;
  return cursor;
}

function writePath(target: unknown, path: readonly (string | number)[], value: unknown): void {
  const parent = readPath(target, path.slice(0, -1)) as Record<string | number, unknown>;
  parent[path[path.length - 1]!] = value;
}

function cloneEntry(entry: SessionEntry): { entry: SessionEntry; document: Record<string, unknown> } {
  // Round-trip through JSON exactly like the wire does: the projection is plain
  // JSON data, and edits stay structurally identical to what a caller receives.
  const document = JSON.parse(JSON.stringify(entry)) as Record<string, unknown>;
  return { entry: document as unknown as SessionEntry, document };
}

function safeJsonText(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized : "";
  } catch {
    return "";
  }
}

/** Truncate to `length` UTF-16 units without splitting a surrogate pair. */
function truncateSafe(text: string, length: number): string {
  if (length >= text.length) return text;
  if (length <= 0) return "";
  const code = text.charCodeAt(length - 1);
  const cut = code >= 0xd800 && code <= 0xdbff ? length - 1 : length;
  return text.slice(0, cut);
}

/**
 * Every truncatable text payload of one projected entry. Only fields that are
 * unbounded on the wire are listed: `details`/`structuredContent` are already
 * capped by the mapper's sanitizer, so they can never drive a page over budget.
 */
function textPayloads(entry: SessionEntry): TextPayload[] {
  const message = entry.message;
  const payloads: TextPayload[] = [];
  switch (message.role) {
    case "user":
      if (typeof message.content === "string") {
        payloads.push({ path: ["message", "content"], text: message.content, json: false });
      } else {
        message.content.forEach((block, index) => {
          if (block.type === "text") {
            payloads.push({ path: ["message", "content", index, "text"], text: block.text, json: false });
          }
        });
      }
      break;
    case "assistant":
      message.content.forEach((block, index) => {
        if (block.type === "text") {
          payloads.push({ path: ["message", "content", index, "text"], text: block.text, json: false });
        } else if (block.type === "thinking") {
          payloads.push({ path: ["message", "content", index, "thinking"], text: block.thinking, json: false });
        } else if (block.type === "toolCall") {
          const serialized = safeJsonText(block.input);
          if (serialized.length > 0) {
            payloads.push({ path: ["message", "content", index, "input"], text: serialized, json: true });
          }
        }
      });
      break;
    case "toolResult":
      message.content.forEach((block, index) => {
        if (block.type === "text") {
          payloads.push({ path: ["message", "content", index, "text"], text: block.text, json: false });
        }
      });
      break;
    case "custom":
      if (typeof message.content === "string") {
        payloads.push({ path: ["message", "content"], text: message.content, json: false });
      } else {
        message.content.forEach((block, index) => {
          if (block.type === "text") {
            payloads.push({ path: ["message", "content", index, "text"], text: block.text, json: false });
          }
        });
      }
      break;
    case "bashExecution":
      payloads.push({ path: ["message", "output"], text: message.output, json: false });
      payloads.push({ path: ["message", "command"], text: message.command, json: false });
      // Optional path to the full output; kept whole whenever it fits, because
      // it is what makes the existing on-demand full-output read work.
      if (message.fullOutputPath !== undefined) {
        payloads.push({ path: ["message", "fullOutputPath"], text: message.fullOutputPath, json: false });
      }
      break;
  }
  return payloads;
}

function inlineImageSummary(count: number, bytes: number, mimes: ReadonlySet<string>): string {
  const mimeText = mimes.size > 0 ? `: ${[...mimes].join(", ")}` : "";
  return `[${count} inline image${count === 1 ? "" : "s"} omitted from initial history payload${mimeText}, ~${bytes} bytes]`;
}

function base64DecodedBytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

/**
 * Replace inline base64 images anywhere in an entry's content with ONE truthful
 * summary block per content array (URL sources stay verbatim). Honest
 * placeholder, same spirit as the `deferMedia` projection; entry identity and
 * ordering never change.
 */
function stripInlineMedia(entry: SessionEntry): SessionEntry {
  const message = entry.message;
  if (message.role === "bashExecution" || typeof message.content === "string") return entry;
  let omitted = 0;
  let bytes = 0;
  const mimes = new Set<string>();
  const content: unknown[] = [];
  for (const block of message.content) {
    if (block.type === "image" && block.source.type === "base64") {
      omitted += 1;
      bytes += base64DecodedBytes(typeof block.source.data === "string" ? block.source.data : "");
      if (typeof block.source.media_type === "string") mimes.add(block.source.media_type);
      continue;
    }
    content.push(block);
  }
  if (omitted === 0) return entry;
  content.push({ type: "text", text: inlineImageSummary(omitted, bytes, mimes) });
  return {
    ...entry,
    message: { ...message, content } as typeof message,
  } as SessionEntry;
}

/**
 * Smallest schema-valid projection of one entry: every optional payload
 * (details / structuredContent / nestedCalls / usage / writtenFiles / media /
 * fullOutputPath) is dropped and the unbounded identity strings are capped.
 * Used only when even fully-truncated text cannot fit.
 */
function stubEntry(entry: SessionEntry, marker: string): SessionEntry {
  const message = entry.message;
  switch (message.role) {
    case "user":
      return { ...entry, message: { role: "user", content: marker } };
    case "assistant":
      return {
        ...entry,
        message: {
          role: "assistant",
          content: [{ type: "text", text: marker }],
          model: truncateSafe(message.model, 200),
          provider: truncateSafe(message.provider, 200),
        },
      };
    case "toolResult":
      return {
        ...entry,
        message: {
          role: "toolResult",
          toolCallId: truncateSafe(message.toolCallId, 200),
          ...(message.toolName === undefined ? {} : { toolName: truncateSafe(message.toolName, 200) }),
          content: [{ type: "text", text: marker }],
        },
      };
    case "custom":
      return {
        ...entry,
        message: {
          role: "custom",
          customType: truncateSafe(message.customType, 200),
          content: marker,
          display: message.display,
        },
      };
    case "bashExecution":
      return { ...entry, message: { ...message, command: marker, output: "", truncated: true } };
  }
}

/**
 * Apply a text fraction to every truncatable payload. EVERY payload that loses
 * text carries its own visible marker with its exact removed byte count, so no
 * silent cut can survive.
 */
function applyTextFraction(entry: SessionEntry, payloads: readonly TextPayload[], fraction: number): SessionEntry {
  const { entry: next, document } = cloneEntry(entry);
  for (const payload of payloads) {
    const kept = truncateSafe(payload.text, Math.floor(payload.text.length * fraction));
    const removed = utf8ByteLength(payload.text) - utf8ByteLength(kept);
    if (removed <= 0) continue;
    const marker = truncationMarker(removed);
    const withMarker = kept.length === 0 ? marker : `${kept}\n${marker}`;
    writePath(document, payload.path, payload.json ? { truncated: true, preview: withMarker } : withMarker);
  }
  return next;
}

/** Drop the optional identity/path fields a full-budget stub cannot afford. */
function stubEntryWithin(entry: SessionEntry, fits: (candidate: SessionEntry) => boolean): SessionEntry | null {
  const stub = stubEntry(entry, ENTRY_STUB_MARKER);
  if (fits(stub)) return stub;
  if (stub.message.role === "bashExecution") {
    // Last resort: the on-demand path goes too (a page that cannot hold it must
    // still make cursor progress); `truncated` keeps the cut visible.
    const { fullOutputPath: _dropped, ...rest } = stub.message;
    const minimal = { ...stub, message: { ...rest, truncated: true } };
    if (fits(minimal)) return minimal;
  }
  // Empty content + marker is the irreducible form; only an unsatisfiable
  // budget (smaller than the empty envelope) can reject it.
  return null;
}

/**
 * Shrink ONE entry until `fits` accepts the page containing it: media summaries
 * first, then the largest text fraction that still fits (bisected against the
 * caller's real serialized page), then a marker-only stub. Returns `null` only
 * when not even the irreducible stub fits the budget.
 */
export function shrinkHistoryEntryToFit(
  entry: SessionEntry,
  fits: (candidate: SessionEntry) => boolean,
): SessionEntry | null {
  const mediaStripped = stripInlineMedia(entry);
  if (fits(mediaStripped)) return mediaStripped;
  const payloads = textPayloads(mediaStripped);
  if (payloads.length > 0) {
    // Start from the smallest legal text fraction: if even that cannot fit, the
    // entry needs the stub below.
    const smallest = applyTextFraction(mediaStripped, payloads, 0);
    if (fits(smallest)) {
      let best = smallest;
      let low = 0;
      let high = 1;
      for (let iteration = 0; iteration < SHRINK_ITERATIONS; iteration += 1) {
        const mid = (low + high) / 2;
        const candidate = applyTextFraction(mediaStripped, payloads, mid);
        if (fits(candidate)) {
          best = candidate;
          low = mid;
        } else {
          high = mid;
        }
      }
      return markBashTruncated(best);
    }
  }
  return stubEntryWithin(mediaStripped, fits);
}

/** A shrunk bash output must keep the existing on-demand full-output affordance. */
function markBashTruncated(entry: SessionEntry): SessionEntry {
  return entry.message.role === "bashExecution"
    ? { ...entry, message: { ...entry.message, truncated: true } }
    : entry;
}

/**
 * Fit one projected page into the lightweight history budget.
 *
 * - No `maxBytes` ⇒ the page is returned as-is (a producer that was not given
 *   a budget keeps its complete-branch contract).
 * - A page within budget is returned unchanged.
 * - Otherwise the NEWEST suffix of complete entries that fits is returned, with
 *   `pageInfo.hasMore`/`nextCursor` produced by the caller's OWN builder so the
 *   cursor always addresses the first returned entry.
 * - When the newest entry alone is over budget it is shrunk and still returned
 *   (see {@link shrinkHistoryEntryToFit}), so every page makes progress and no
 *   entry is ever dropped.
 */
export function fitHistoryPage<Result>(input: {
  readonly entries: readonly SessionEntry[];
  /** Count of projected entries strictly older than `entries[0]` (cursor math). */
  readonly olderCount: number;
  readonly maxBytes?: number | undefined;
  readonly build: (entries: SessionEntry[], olderCount: number) => Result;
}): Result {
  const { entries, olderCount, build } = input;
  const maxBytes = input.maxBytes;
  if (maxBytes === undefined) return build([...entries], olderCount);
  const complete = build([...entries], olderCount);
  if (pageBytes(complete) <= maxBytes) return complete;

  // Linear walk from the newest entry. A page's wire size is its envelope plus
  // each entry plus one joining comma, so per-entry sizes are measured ONCE
  // (never re-serializing a growing window). The chosen window is re-measured
  // below, so the estimate can only over-prune/slightly over-admit.
  let used = pageBytes(build([], olderCount + entries.length));
  // `oldest` is the index of the oldest entry in the window; the number of
  // entries strictly older than it is exactly `olderCount + oldest`.
  let oldest = entries.length;
  let window: SessionEntry[] = [];
  let index = entries.length - 1;
  const packFrom = (from: number): void => {
    for (let cursor = from; cursor >= 0; cursor -= 1) {
      const entry = entries[cursor]!;
      const size = entryBytes(entry);
      if (used + size > maxBytes) break;
      used += size;
      window = [entry, ...window];
      oldest = cursor;
    }
  };
  packFrom(index);
  if (window.length === 0) {
    // The newest entry ALONE is over budget: shrink it in place (visible marker)
    // and keep it — an entry is never dropped, and the cursor still covers the
    // entries behind it. Keep packing any older entry that still fits.
    const newestIndex = entries.length - 1;
    const shrunk = shrinkHistoryEntryToFit(entries[newestIndex]!, (candidate) =>
      pageBytes(build([candidate], olderCount + newestIndex)) <= maxBytes);
    if (shrunk === null) {
      // Unsatisfiable budget (below the empty envelope): return the newest entry
      // as-is. Progress and zero entry loss still hold; only the size bound
      // cannot be met, and that is honest rather than a silent empty page.
      return build([entries[newestIndex]!], olderCount + newestIndex);
    }
    window = [shrunk];
    oldest = newestIndex;
    used = pageBytes(build(window, olderCount + oldest));
    packFrom(newestIndex - 1);
  }
  // Exact confirmation: the real envelope/cursor can differ by a few bytes from
  // the estimate, so trim the oldest entry until the serialized page fits. At
  // least one entry always stays, so a hasMore page is never empty.
  let result = build(window, olderCount + oldest);
  for (let guard = 0; guard < window.length - 1 && pageBytes(result) > maxBytes; guard += 1) {
    window = window.slice(1);
    oldest += 1;
    result = build(window, olderCount + oldest);
  }
  return result;
}
