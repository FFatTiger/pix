/**
 * Cumulative-partial → append-only delta diff for message streaming.
 *
 * Core `message_update.message` is a CUMULATIVE partial. This module diffs a
 * baseline cumulative against the next cumulative and yields 0..N append-only
 * Protocol {@link StreamingMessageDelta}s, or signals `restart` when the
 * mutation is non-prefix / irreducible (image re-write, toolCall input mutation,
 * role/toolCallId/customType change, content shrinkage). The caller then mints
 * fresh stream ids and emits a new `message_start` so the sessiond projection
 * authoritatively replaces the stale partial — it NEVER synthesizes a
 * `message_end` or a malformed delta.
 */
import type { StreamingMessageDelta } from "@fffattiger/pix-protocol";
import type {
  AssistantContentBlock,
  StreamingAgentMessage,
  TextContent,
  ImageContent,
} from "@fffattiger/pix-runtime-core";
import { mapImage } from "./core-to-protocol.js";

export type DiffResult =
  | { readonly kind: "deltas"; readonly deltas: StreamingMessageDelta[] }
  | { readonly kind: "restart" };

/** Structural deep equality over JSON-shaped values. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === "object") {
    if (typeof b !== "object" || Array.isArray(b)) return false;
    const ak = Object.keys(a as Record<string, unknown>);
    const bk = Object.keys(b as Record<string, unknown>);
    if (ak.length !== bk.length) return false;
    for (const key of ak) {
      if (!deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
    }
    return true;
  }
  return false;
}

function diffAssistant(
  baseline: StreamingAgentMessage & { role: "assistant" },
  current: StreamingAgentMessage & { role: "assistant" },
): DiffResult {
  const baselineBlocks = baseline.content ?? [];
  const currentBlocks = current.content ?? [];
  if (currentBlocks.length < baselineBlocks.length) return { kind: "restart" };
  const deltas: StreamingMessageDelta[] = [];
  for (let i = 0; i < currentBlocks.length; i += 1) {
    const c = currentBlocks[i];
    if (c === undefined) continue;
    if (i < baselineBlocks.length) {
      const b = baselineBlocks[i];
      if (b === undefined || c.type !== b.type) return { kind: "restart" };
      if (c.type === "text" && b.type === "text") {
        if (c.text === b.text) continue;
        if (c.text.startsWith(b.text) && c.text.length > b.text.length) {
          deltas.push({ role: "assistant", delta: { type: "text", text: c.text.slice(b.text.length) } });
          continue;
        }
        return { kind: "restart" };
      }
      if (c.type === "thinking" && b.type === "thinking") {
        if (c.thinking === b.thinking) continue;
        if (c.thinking.startsWith(b.thinking) && c.thinking.length > b.thinking.length) {
          deltas.push({ role: "assistant", delta: { type: "thinking", thinking: c.thinking.slice(b.thinking.length) } });
          continue;
        }
        return { kind: "restart" };
      }
      if (c.type === "toolCall" && b.type === "toolCall") {
        if (c.toolCallId === b.toolCallId && c.toolName === b.toolName && deepEqual(c.input, b.input)) continue;
        return { kind: "restart" };
      }
      if (c.type === "image" && b.type === "image") {
        if (deepEqual(c, b)) continue;
        return { kind: "restart" };
      }
      return { kind: "restart" };
    }
    // New trailing block: only text/thinking/toolCall are expressible; image restarts.
    if (c.type === "text") {
      if (c.text.length > 0) deltas.push({ role: "assistant", delta: { type: "text", text: c.text } });
      continue;
    }
    if (c.type === "thinking") {
      if (c.thinking.length > 0) deltas.push({ role: "assistant", delta: { type: "thinking", thinking: c.thinking } });
      continue;
    }
    if (c.type === "toolCall") {
      deltas.push({
        role: "assistant",
        delta: { type: "toolCall", toolCallId: c.toolCallId, toolName: c.toolName, input: c.input },
      });
      continue;
    }
    return { kind: "restart" };
  }
  return { kind: "deltas", deltas };
}

function diffToolResult(
  baseline: StreamingAgentMessage & { role: "toolResult" },
  current: StreamingAgentMessage & { role: "toolResult" },
): DiffResult {
  if (current.toolCallId !== baseline.toolCallId) return { kind: "restart" };
  const baselineContent = baseline.content ?? [];
  const currentContent = current.content ?? [];
  if (currentContent.length < baselineContent.length) return { kind: "restart" };
  const deltas: StreamingMessageDelta[] = [];
  for (let i = 0; i < currentContent.length; i += 1) {
    const c = currentContent[i];
    if (c === undefined) continue;
    if (i < baselineContent.length) {
      const b = baselineContent[i];
      if (b === undefined || c.type !== b.type) return { kind: "restart" };
      if (c.type === "text" && b.type === "text") {
        if (c.text === b.text) continue;
        if (c.text.startsWith(b.text) && c.text.length > b.text.length) {
          deltas.push({ role: "toolResult", toolCallId: current.toolCallId!, delta: { type: "text", text: c.text.slice(b.text.length) } });
          continue;
        }
        return { kind: "restart" };
      }
      if (c.type === "image" && b.type === "image") {
        if (deepEqual(c, b)) continue;
        return { kind: "restart" };
      }
      return { kind: "restart" };
    }
    // New trailing block: text suffix or a brand-new image (expressible for toolResult).
    if (c.type === "text") {
      if (c.text.length > 0) deltas.push({ role: "toolResult", toolCallId: current.toolCallId!, delta: { type: "text", text: c.text } });
      continue;
    }
    deltas.push({ role: "toolResult", toolCallId: current.toolCallId!, delta: { type: "image", image: mapImage(c) } });
  }
  return { kind: "deltas", deltas };
}

function diffCustom(
  baseline: StreamingAgentMessage & { role: "custom" },
  current: StreamingAgentMessage & { role: "custom" },
): DiffResult {
  if (current.customType !== baseline.customType) return { kind: "restart" };
  if (deepEqual(current.content, baseline.content)) return { kind: "deltas", deltas: [] };
  // Custom deltas are text-only: only a string content that prefix-extends maps.
  if (
    typeof current.content === "string" &&
    typeof baseline.content === "string" &&
    current.content.startsWith(baseline.content) &&
    current.content.length > baseline.content.length
  ) {
    return {
      kind: "deltas",
      deltas: [
        { role: "custom", customType: current.customType!, delta: { type: "text", text: current.content.slice(baseline.content.length) } },
      ],
    };
  }
  return { kind: "restart" };
}

function diffBashExecution(
  baseline: StreamingAgentMessage & { role: "bashExecution" },
  current: StreamingAgentMessage & { role: "bashExecution" },
): DiffResult {
  if (current.command !== baseline.command) return { kind: "restart" };
  const deltas: StreamingMessageDelta[] = [];
  const baselineOutput = baseline.output ?? "";
  const currentOutput = current.output ?? "";
  if (currentOutput !== baselineOutput) {
    if (currentOutput.startsWith(baselineOutput) && currentOutput.length > baselineOutput.length) {
      deltas.push({ role: "bashExecution", delta: { type: "output", output: currentOutput.slice(baselineOutput.length) } });
    } else {
      return { kind: "restart" };
    }
  }
  // Status fields: emit a single status delta carrying the changed fields.
  const status: Record<string, unknown> = {};
  if (current.exitCode !== baseline.exitCode && current.exitCode !== undefined) status.exitCode = current.exitCode;
  if (current.cancelled !== baseline.cancelled && current.cancelled !== undefined) status.cancelled = current.cancelled;
  if (current.truncated !== baseline.truncated && current.truncated !== undefined) status.truncated = current.truncated;
  if (Object.keys(status).length > 0) {
    deltas.push({ role: "bashExecution", delta: { type: "status", ...status } });
  }
  return { kind: "deltas", deltas };
}

/**
 * Diff two cumulative partials of the SAME role. Different roles must be
 * handled by the caller as a restart (this function assumes equal roles).
 */
export function diffSameRole(baseline: StreamingAgentMessage, current: StreamingAgentMessage): DiffResult {
  // A byte-identical cumulative is a duplicate — no output, baseline unchanged.
  if (deepEqual(baseline, current)) return { kind: "deltas", deltas: [] };
  switch (current.role) {
    case "assistant":
      return baseline.role === "assistant" ? diffAssistant(baseline, current) : { kind: "restart" };
    case "toolResult":
      return baseline.role === "toolResult" ? diffToolResult(baseline, current) : { kind: "restart" };
    case "custom":
      return baseline.role === "custom" ? diffCustom(baseline, current) : { kind: "restart" };
    case "bashExecution":
      return baseline.role === "bashExecution" ? diffBashExecution(baseline, current) : { kind: "restart" };
    case "user":
      // user has no Protocol update delta; any mutation restarts.
      return { kind: "restart" };
  }
}

export type { AssistantContentBlock, TextContent };
