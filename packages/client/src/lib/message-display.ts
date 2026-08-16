import type { AssistantContentBlock, AssistantMessage, ThinkingContent, ToolCallContent } from "./chat-view-model";

/**
 * pix adapter: Array.prototype.findLastIndex needs the ES2023 lib; pix
 * compiles against ES2022, so this local helper keeps the source-identical
 * semantics (last index matching the predicate, else -1).
 */
function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index--) {
    if (predicate(items[index]!)) return index;
  }
  return -1;
}

interface DisplayOptions {
  isStreaming?: boolean | undefined;
}

export function isEmptyThinkingBlock(block: AssistantContentBlock, options: DisplayOptions = {}): block is ThinkingContent {
  return block.type === "thinking" && !block.deferred && !options.isStreaming && block.thinking.trim() === "";
}

/**
 * Error text for a completed assistant message whose provider turn failed
 * (stopReason "error"). Ported verbatim from pi-web lib/message-display.ts so a
 * failed turn always renders an answer row instead of silently vanishing.
 */
export function getAssistantErrorMessage(
  message: AssistantMessage,
  options: DisplayOptions = {},
): string | null {
  if (options.isStreaming || message.stopReason !== "error") return null;
  return message.errorMessage?.trim() || "Unknown provider error";
}

/**
 * Fallback answer for an INTERRUPTED turn: the final assistant message ends
 * with tool calls (stopReason "toolUse") and no later answer message exists —
 * the turn died mid-flight (e.g. worker/host restart). pi-web folds its text
 * into the collapsed process group and shows nothing; pi desktop shows the
 * last generated text inline. Pix surfaces the message's LAST contiguous run
 * of text blocks as the final answer so the agent's last words stay visible
 * after completion. Pure display fallback: streaming turns and turns with a
 * real final answer are untouched.
 */
export function lastContiguousTextRun(message: AssistantMessage): AssistantContentBlock[] {
  const blocks = getDisplayableAssistantBlocks(message);
  const runs: Array<{ start: number; end: number }> = [];
  let start = -1;
  for (let index = 0; index <= blocks.length; index += 1) {
    const block = index < blocks.length ? blocks[index] : undefined;
    const isText = block !== undefined
      && block.type === "text"
      && typeof (block as { text?: string }).text === "string"
      && (block as { text: string }).text.trim().length > 0;
    if (isText && start === -1) start = index;
    if ((!isText || index === blocks.length) && start !== -1) {
      runs.push({ start, end: index });
      start = -1;
    }
  }
  if (runs.length === 0) return [];
  const last = runs[runs.length - 1]!;
  return blocks.slice(last.start, last.end);
}

export function getDisplayableAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): AssistantContentBlock[] {
  return (message.content ?? []).filter((block) => !isEmptyThinkingBlock(block, options));
}

function isFinalAnswerBlock(block: AssistantContentBlock): boolean {
  return block.type === "text" || block.type === "image";
}

export function splitFinalAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): { answerBlocks: AssistantContentBlock[]; processBlocks: AssistantContentBlock[] } {
  const blocks = getDisplayableAssistantBlocks(message, options);
  const lastProcessIndex = findLastIndex(blocks, (block) => !isFinalAnswerBlock(block));
  if (lastProcessIndex === -1) {
    return { answerBlocks: blocks, processBlocks: [] };
  }
  return {
    answerBlocks: blocks.slice(lastProcessIndex + 1),
    processBlocks: blocks.slice(0, lastProcessIndex + 1),
  };
}

export function countToolCallBlocks(blocks: AssistantContentBlock[]): number {
  return blocks.filter((block): block is ToolCallContent => block.type === "toolCall").length;
}
