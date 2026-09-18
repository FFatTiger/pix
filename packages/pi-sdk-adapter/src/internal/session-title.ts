import {
  Agent,
  type AgentMessage,
  type AgentOptions,
  type AgentState,
  type AgentTool,
} from "@earendil-works/pi-agent-core";

const TITLE_TIMEOUT_MS = 90_000;
const MAX_TITLE_LENGTH = 80;

const TITLE_PROMPT = `Create a concise title for this session based on the conversation above.

Requirements:
- Match the primary language used by the user.
- Describe the user's concrete goal or the outcome, not the act of chatting.
- Use 4-12 words for space-separated languages, or 8-24 characters for CJK text when practical.
- Do not call any tools.
- Return only the title as plain text, with no quotes, label, markdown, or explanation.`;

/** Minimal AgentSession surface required for title generation. */
export interface SessionTitleSource {
  readonly agent: Agent;
}

function createShadowTools(tools: AgentTool[]): AgentTool[] {
  return tools.map((tool) => ({
    ...tool,
    execute: async () => {
      throw new Error("Tools cannot be executed while generating a session title");
    },
  }));
}

/**
 * Build a temporary Agent configuration whose provider-facing prefix matches
 * the source Agent. Tool implementations are replaced without changing their
 * names, descriptions, or schemas, so a naming run cannot mutate the project.
 * When a model override object is provided it is used for `initialState.model`
 * instead of the source's current model.
 */
export function buildSessionTitleAgentOptions(
  source: Agent,
  model?: AgentState["model"],
): AgentOptions {
  const state = source.state;
  return {
    initialState: {
      systemPrompt: state.systemPrompt,
      model: model ?? state.model,
      thinkingLevel: state.thinkingLevel,
      tools: createShadowTools(state.tools),
      messages: state.messages,
    },
    convertToLlm: source.convertToLlm,
    streamFn: source.streamFunction,
    steeringMode: source.steeringMode,
    followUpMode: source.followUpMode,
    transport: source.transport,
    toolExecution: source.toolExecution,
    // Conditional spreads keep exactOptionalPropertyTypes happy: the optional
    // AgentOptions fields must not be explicitly set to undefined.
    ...(source.transformContext === undefined ? {} : { transformContext: source.transformContext }),
    ...(source.getApiKey === undefined ? {} : { getApiKey: source.getApiKey }),
    ...(source.onPayload === undefined ? {} : { onPayload: source.onPayload }),
    ...(source.onResponse === undefined ? {} : { onResponse: source.onResponse }),
    ...(source.sessionId === undefined ? {} : { sessionId: source.sessionId }),
    ...(source.thinkingBudgets === undefined ? {} : { thinkingBudgets: source.thinkingBudgets }),
    ...(source.maxRetryDelayMs === undefined ? {} : { maxRetryDelayMs: source.maxRetryDelayMs }),
  };
}

/**
 * A running source session usually ends in the user message currently being
 * answered. Fold the title request into a copy of that message so the title
 * request does not send two consecutive user messages to the provider.
 */
export function appendTitleRequestToTrailingUser(messages: AgentMessage[]): AgentMessage[] {
  const lastMessage = messages.at(-1);
  if (!lastMessage || lastMessage.role !== "user") return messages;

  const content = typeof lastMessage.content === "string"
    ? `${lastMessage.content}\n\n${TITLE_PROMPT}`
    : [...lastMessage.content, { type: "text" as const, text: TITLE_PROMPT }];

  return [
    ...messages.slice(0, -1),
    { ...lastMessage, content },
  ];
}

function stripWrappingQuotes(value: string): string {
  const pairs: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ["`", "`"],
    ["\u201c", "\u201d"],
    ["\u300c", "\u300d"],
    ["\u300e", "\u300f"],
  ];
  for (const [start, end] of pairs) {
    if (value.startsWith(start) && value.endsWith(end) && value.length > start.length + end.length) {
      return value.slice(start.length, -end.length).trim();
    }
  }
  return value;
}

export function parseGeneratedSessionTitle(raw: string): string {
  let value = raw.trim();
  const fenced = value.match(/^```(?:json|text)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) value = fenced[1]!.trim();

  if (value.startsWith("{")) {
    try {
      const parsed = JSON.parse(value) as { title?: unknown };
      if (typeof parsed.title === "string") value = parsed.title.trim();
    } catch {
      // Fall back to plain-text cleanup below.
    }
  }

  value = value.split(/\r?\n/, 1)[0] ?? "";
  value = value.replace(/^(?:session\s+title|title|标题)\s*[:：-]\s*/i, "");
  value = stripWrappingQuotes(value).replace(/\s+/g, " ").trim();
  value = value.replace(/[。.!]+$/u, "").trim();

  if (!/[\p{L}\p{N}]/u.test(value)) {
    throw new Error("The model did not return a usable session title");
  }

  const characters = Array.from(value);
  if (characters.length > MAX_TITLE_LENGTH) {
    value = characters.slice(0, MAX_TITLE_LENGTH).join("").trim();
  }
  return value;
}

/**
 * Scan the shadow agent's newly generated messages for the final assistant
 * title text. Usage is intentionally NOT captured — the caller only needs the
 * title string.
 */
function getGeneratedTitle(agent: Agent, historyLength: number): string {
  const generatedMessages = agent.state.messages.slice(historyLength);
  for (let i = generatedMessages.length - 1; i >= 0; i--) {
    const message = generatedMessages[i]!;
    if (message.role !== "assistant") continue;
    if (message.stopReason === "error") {
      throw new Error(message.errorMessage || "The title model request failed");
    }
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (!text) continue;
    return parseGeneratedSessionTitle(text);
  }
  throw new Error("The model did not return a session title");
}

export function sanitizeTitleMessages(messages: AgentMessage[]): AgentMessage[] {
  const sanitized: AgentMessage[] = [];
  let expectedToolResultIds: Set<string> | undefined;

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;

    if (message.role === "assistant") {
      const followingToolResultIds = new Set<string>();
      for (let resultIndex = index + 1; resultIndex < messages.length; resultIndex++) {
        const resultMessage = messages[resultIndex]!;
        if (resultMessage.role !== "toolResult") break;
        followingToolResultIds.add(resultMessage.toolCallId);
      }

      expectedToolResultIds = new Set<string>();
      const content = message.content.filter((block) => {
        if (block.type !== "toolCall") return true;
        if (!followingToolResultIds.has(block.id)) return false;
        expectedToolResultIds!.add(block.id);
        return true;
      });

      if (content.length > 0) {
        sanitized.push({ ...message, content });
      }
      continue;
    }

    if (message.role === "toolResult") {
      if (expectedToolResultIds?.delete(message.toolCallId)) {
        sanitized.push(message);
      }
      continue;
    }

    expectedToolResultIds = undefined;
    sanitized.push(message);
  }

  return sanitized;
}

export async function generateSessionTitle(
  source: SessionTitleSource,
  options?: { model?: unknown },
): Promise<string> {
  const sourceAgent = source.agent;
  await sourceAgent.waitForIdle?.();

  const sanitizedMessages = sanitizeTitleMessages(sourceAgent.state.messages);
  const historyLength = sanitizedMessages.length;
  if (!sanitizedMessages.some(
    (message) => message.role === "user" || message.role === "compactionSummary",
  )) {
    throw new Error("The session has no user messages to name");
  }

  const agentOptions = buildSessionTitleAgentOptions(
    sourceAgent,
    options?.model as AgentState["model"] | undefined,
  );
  agentOptions.initialState!.messages = sanitizedMessages;
  const continuesFromTrailingUser = sanitizedMessages.at(-1)?.role === "user";
  if (continuesFromTrailingUser) {
    agentOptions.initialState!.messages = appendTitleRequestToTrailingUser(sanitizedMessages);
  }

  const temporaryAgent = new Agent(agentOptions);
  const runPromise = continuesFromTrailingUser
    ? temporaryAgent.continue()
    : temporaryAgent.prompt(TITLE_PROMPT);
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      runPromise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          temporaryAgent.abort();
          reject(new Error("Session title generation timed out"));
        }, TITLE_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    temporaryAgent.abort();
    await runPromise.catch(() => {});
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  return getGeneratedTitle(temporaryAgent, historyLength);
}
