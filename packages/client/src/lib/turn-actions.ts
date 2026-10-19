import type { AssistantContentBlock, ToolResultMessage } from "./chat-view-model";

export type TurnActionTool = "send_to_session" | "create_session" | "open_session" | "draft_to_session";

/** A session action the assistant took during a turn. */
export interface TurnAction {
  toolCallId: string;
  toolName: TurnActionTool;
  input: Record<string, unknown>;
  resultDetails?: unknown;
}

const TURN_ACTION_TOOLS: ReadonlySet<string> = new Set<TurnActionTool>(["send_to_session", "create_session", "open_session", "draft_to_session"]);

/**
 * Successful session actions of a turn, for the compact chips under the answer.
 * Their full cards sit in the process, which is folded once the turn settles.
 */
export function extractTurnActions(
  content: AssistantContentBlock[],
  toolResults: Map<string, ToolResultMessage> | undefined,
): TurnAction[] {
  const actions: TurnAction[] = [];
  for (const block of content) {
    if (block.type !== "toolCall" || !TURN_ACTION_TOOLS.has(block.toolName)) continue;
    const result = toolResults?.get(block.toolCallId);
    if (!result || result.isError) continue;
    actions.push({
      toolCallId: block.toolCallId,
      toolName: block.toolName as TurnActionTool,
      input: (block.input ?? {}) as Record<string, unknown>,
      ...(result.details === undefined ? {} : { resultDetails: result.details }),
    });
  }
  return actions;
}
