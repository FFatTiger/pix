/**
 * Adapter-collected outputs of nested tool calls (codemode 子调用结果).
 *
 * The Pi SDK's `ToolResultMessage.nestedCalls` record never carries child
 * results (pi-ai types.d.ts: "Results are not recorded"), but the runtime
 * emits a `tool_execution_end` event (with `parentToolCallId`) for every
 * nested call that DOES carry the result. This module is the single owner of
 * the pix-side enrichment built on top of those events:
 *
 * - {@link captureNestedToolResult} bounds one child result (text redacted +
 *   capped at `MAX_NESTED_RESULT_TEXT_CHARS` chars, images counted only).
 * - {@link NestedResultsArchive} accumulates the child results of one parent
 *   call in event order, memory-bounded per parent and across parents.
 * - {@link budgetPayload} renders the persisted record for the SDK custom
 *   entry (`pix-nested-results`, a plain `CustomEntry` that the SDK keeps out
 *   of LLM context and compaction) under the `MAX_NESTED_RESULTS_ENTRY_BYTES`
 *   whole-record budget — calls that do not fit are dropped from the record
 *   and keep only their nestedCalls status on the wire (no `result` field).
 * - {@link mergeNestedResults} joins a payload back onto a canonical
 *   `NestedToolCalls` summary: child ids match one-to-one with the runtime
 *   event ids (the SDK recorder uses the same `toolCall.id`); when ids do not
 *   line up (e.g. calls dropped by the SDK's 256-call record limit), records
 *   fall back to event order ONLY when the counts are equal.
 * - {@link nestedResultsIndexFromSdkEntries} recovers the payloads from a
 *   session's persisted custom entries for history projection; malformed
 *   records are skipped fail-closed (never partially applied).
 */
import {
  MAX_NESTED_RESULT_TEXT_CHARS,
  MAX_NESTED_RESULTS_ENTRY_BYTES,
  type NestedToolCallResult,
  type NestedToolCalls,
} from "@fffattiger/pix-runtime-core";
import { redactTextBounded } from "./sanitize.js";

/** SDK custom-entry `customType` identifying a pix nested-results record. */
export const NESTED_RESULTS_CUSTOM_TYPE = "pix-nested-results";
/**
 * Bounded number of parents kept in the live archive (FIFO beyond this).
 * The archive's lifetime is ONE agent turn (the adapter clears it on
 * agent_end/abort), so this only bounds SIMULTANEOUSLY RUNNING parent calls.
 * The SDK runs nested batches in parallel, but a single turn overlapping
 * more than this many codemode calls is far outside real model behavior;
 * beyond it the OLDEST uncommitted parent's child results degrade to
 * status-only (never wrong data, just absent enrichment).
 */
const MAX_ARCHIVED_PARENTS = 64;

/** One persisted child-result record (the wire/persisted shape). */
export interface NestedResultRecord {
  id: string;
  text: string;
  truncated: boolean;
  imageCount: number;
  isError: boolean;
}

/** Persisted record appended after the parent tool result entry. */
export interface NestedResultsPayload {
  version: 1;
  toolCallId: string;
  calls: readonly NestedResultRecord[];
}

/** Input to {@link budgetPayload}: a child id with its record (or a status-only marker). */
interface BudgetedCall {
  id: string;
  /** Undefined once the per-parent text budget is exhausted (status-only marker). */
  record: NestedResultRecord | undefined;
}

const encoder = new TextEncoder();
const utf8Bytes = (value: string): number => encoder.encode(value).byteLength;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

/**
 * Bound one child result from a raw `tool_execution_end` result payload.
 * Text blocks are redacted and joined with `\n`, then capped at
 * {@link MAX_NESTED_RESULT_TEXT_CHARS} characters (`truncated` marks the cut);
 * image blocks are counted, never stored.
 */
export function captureNestedToolResult(rawResult: unknown, isError: boolean): NestedToolCallResult {
  const raw = asRecord(rawResult);
  const content = Array.isArray(raw.content) ? raw.content : [];
  const texts: string[] = [];
  let imageCount = 0;
  let truncated = false;
  for (const block of content) {
    const item = asRecord(block);
    if (item.type === "text" && typeof item.text === "string") {
      if (item.text.length > MAX_NESTED_RESULT_TEXT_CHARS) truncated = true;
      texts.push(redactTextBounded(item.text, MAX_NESTED_RESULT_TEXT_CHARS));
    } else if (item.type === "image") imageCount += 1;
  }
  if (texts.length === 0 && typeof raw.error === "string") {
    if (raw.error.length > MAX_NESTED_RESULT_TEXT_CHARS) truncated = true;
    texts.push(redactTextBounded(raw.error, MAX_NESTED_RESULT_TEXT_CHARS));
  }
  let joined = texts.join("\n");
  if (joined.length > MAX_NESTED_RESULT_TEXT_CHARS) {
    truncated = true;
    joined = joined.slice(0, MAX_NESTED_RESULT_TEXT_CHARS);
  }
  return {
    text: joined,
    truncated,
    imageCount,
    isError: isError === true,
  };
}

/**
 * Live per-turn archive of child results, keyed by parent tool call id.
 * Memory-bounded: per parent the cumulative captured text stays within the
 * persisted-record budget (later calls are archived WITHOUT text so they can
 * still be matched, but persist as status-only), and at most
 * {@link MAX_ARCHIVED_PARENTS} parents are retained (FIFO).
 */
export class NestedResultsArchive {
  private parents = new Map<string, { calls: BudgetedCall[]; textBytes: number }>();

  record(parentToolCallId: string, childId: string, result: NestedToolCallResult): void {
    if (!parentToolCallId || !childId) return;
    let parent = this.parents.get(parentToolCallId);
    if (parent === undefined) {
      if (this.parents.size >= MAX_ARCHIVED_PARENTS) {
        const oldest = this.parents.keys().next().value;
        if (oldest !== undefined) this.parents.delete(oldest);
      }
      parent = { calls: [], textBytes: 0 };
      this.parents.set(parentToolCallId, parent);
    }
    // Once the per-parent text budget is exhausted the call is archived as a
    // status-only marker: it can still be matched by id, but never persists a
    // fabricated empty output.
    const bounded = parent.textBytes >= MAX_NESTED_RESULTS_ENTRY_BYTES
      ? undefined
      : { id: childId, text: result.text, truncated: result.truncated, imageCount: result.imageCount, isError: result.isError };
    if (bounded !== undefined) parent.textBytes += utf8Bytes(bounded.text);
    parent.calls.push({ id: childId, record: bounded });
  }

  /** Build the persisted payload for one parent and remove it from the archive. */
  takePayload(parentToolCallId: string): NestedResultsPayload | undefined {
    const parent = this.parents.get(parentToolCallId);
    if (parent === undefined) return undefined;
    this.parents.delete(parentToolCallId);
    return budgetPayload(parentToolCallId, parent.calls);
  }

  /** Whether any child result was archived for this parent. */
  has(parentToolCallId: string): boolean {
    return this.parents.has(parentToolCallId);
  }

  clear(): void {
    this.parents.clear();
  }
}

/**
 * Apply the whole-record budget: keep child records (in order) while the
 * serialized record stays within {@link MAX_NESTED_RESULTS_ENTRY_BYTES}
 * (UTF-8). Filling is a PREFIX: once a call does not fit, every later call is
 * dropped too — they keep only their nestedCalls status on the wire (no
 * `result` field, no empty output, no out-of-order subset).
 */
export function budgetPayload(toolCallId: string, calls: readonly BudgetedCall[]): NestedResultsPayload {
  const kept: NestedResultRecord[] = [];
  let budget = MAX_NESTED_RESULTS_ENTRY_BYTES
    - utf8Bytes(JSON.stringify({ version: 1, toolCallId, calls: [] }));
  for (const call of calls) {
    if (call.record === undefined) continue;
    const cost = utf8Bytes(JSON.stringify(call.record)) + 1;
    if (cost > budget) break;
    budget -= cost;
    kept.push(call.record);
  }
  return { version: 1, toolCallId, calls: kept };
}

/**
 * Join a persisted payload onto a canonical `NestedToolCalls` summary. Ids
 * match one-to-one in the common case; when they do not, records are applied
 * by EVENT ORDER and only when the counts are equal (never a partial guess).
 * Calls without a matching record keep their summary untouched (old records,
 * over-budget calls).
 */
export function mergeNestedResults(
  nested: NestedToolCalls,
  payload: NestedResultsPayload | undefined,
): NestedToolCalls {
  if (payload === undefined || payload.calls.length === 0) return nested;
  const byId = new Map(payload.calls.map((call) => [call.id, call]));
  const idMatched = nested.calls.filter((call) => byId.has(call.id)).length;
  const orderFallback = idMatched === 0 && payload.calls.length === nested.calls.length;
  const calls = nested.calls.map((call, index) => {
    const record = orderFallback ? payload.calls[index] : byId.get(call.id);
    if (record === undefined || call.result !== undefined) return call;
    return { ...call, result: { text: record.text, truncated: record.truncated, imageCount: record.imageCount, isError: record.isError } };
  });
  return { ...nested, calls };
}

/**
 * Recover persisted payloads from a session's raw SDK entries for history
 * projection. Only `custom` entries with {@link NESTED_RESULTS_CUSTOM_TYPE}
 * and a well-formed record are used; anything malformed is skipped whole
 * (fail-closed, never partially applied). Keyed by parent tool call id.
 */
export function nestedResultsIndexFromSdkEntries(entries: readonly unknown[]): Map<string, NestedResultsPayload> {
  const index = new Map<string, NestedResultsPayload>();
  for (const value of entries) {
    const entry = asRecord(value);
    if (entry.type !== "custom" || entry.customType !== NESTED_RESULTS_CUSTOM_TYPE) continue;
    const data = asRecord(entry.data);
    if (data.version !== 1 || typeof data.toolCallId !== "string" || !data.toolCallId || !Array.isArray(data.calls)) continue;
    const calls: NestedResultRecord[] = [];
    let valid = true;
    for (const raw of data.calls) {
      const call = asRecord(raw);
      if (typeof call.id !== "string" || !call.id
        || typeof call.text !== "string"
        || typeof call.truncated !== "boolean"
        || !Number.isSafeInteger(call.imageCount) || Number(call.imageCount) < 0
        || typeof call.isError !== "boolean") {
        valid = false;
        break;
      }
      calls.push({
        id: call.id,
        text: call.text,
        truncated: call.truncated,
        imageCount: Number(call.imageCount),
        isError: call.isError,
      });
    }
    if (!valid || index.has(data.toolCallId)) continue;
    index.set(data.toolCallId, budgetPayload(data.toolCallId, calls.map((record) => ({ id: record.id, record }))));
  }
  return index;
}
