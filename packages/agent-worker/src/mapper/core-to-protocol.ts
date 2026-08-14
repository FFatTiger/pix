/**
 * Explicit Core → Protocol DTO mapping.
 *
 * Core canonical models are the application boundary; Protocol wire DTOs are
 * the process/network boundary. These helpers rebuild each value field-by-field
 * so that:
 *   - readonly Core arrays become mutable Protocol arrays (no `as any` / `as`);
 *   - every output is a fresh plain object validated downstream by the frozen
 *     `WorkerToSessiondPushSchema` transport gate;
 *   - the anti-corruption narrowing (Core `media_type: string` → Protocol
 *     supported-media enum) happens at this single boundary, where the adapter
 *     contract guarantees a supported value and the transport zod gate is the
 *     runtime safety net.
 */
import type {
  AgentMessage as ProtocolAgentMessage,
  AssistantContentBlock as ProtocolAssistantContentBlock,
  ImageContent as ProtocolImageContent,
  ImageContentSource as ProtocolImageContentSource,
  StreamingAgentMessage as ProtocolStreamingAgentMessage,
  SupportedImageMediaType,
  TextContent as ProtocolTextContent,
  ToolCallContent as ProtocolToolCallContent,
  ThinkingContent as ProtocolThinkingContent,
  UserContent as ProtocolUserContent,
  ExtensionUiRequest as ProtocolExtensionUiRequest,
} from "@fffattiger/pix-protocol";
import type {
  AgentMessage,
  AssistantContentBlock,
  BashProjection,
  CompactionProjection,
  ContextUsage,
  ExtensionStatusItem,
  ExtensionUiRequest,
  ExtensionWidgetItem,
  ImageContent,
  ImageContentSource,
  ModelRef,
  PendingExtensionUi,
  QueuedMessages,
  QueuedTurn,
  RuntimeCapabilitySet,
  RuntimeState,
  SlashCommandInfo,
  StreamingAgentMessage,
  TextContent,
  ThinkingContent,
  ToolCallContent,
  ToolInfo,
  TokenUsage,
  UserContent,
} from "@fffattiger/pix-runtime-core";

const copy = <T>(value: readonly T[] | undefined): T[] | undefined =>
  value === undefined ? undefined : [...value];

export function mapModelRef(model: ModelRef | null): { id: string; provider: string } | null {
  return model === null ? null : { id: model.id, provider: model.provider };
}

export function mapContextUsage(
  usage: ContextUsage | null | undefined,
):
  | { percent: number; contextWindow?: number; tokens?: number }
  | null
  | undefined {
  if (usage === undefined || usage === null) return usage;
  return {
    percent: usage.percent,
    ...(usage.contextWindow === undefined ? {} : { contextWindow: usage.contextWindow }),
    ...(usage.tokens === undefined ? {} : { tokens: usage.tokens }),
  };
}

export function mapToolInfo(tools: readonly ToolInfo[] | undefined) {
  if (tools === undefined) return undefined;
  return tools.map((tool) => ({
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    active: tool.active,
  }));
}

export function mapSlashCommands(commands: readonly SlashCommandInfo[] | undefined) {
  if (commands === undefined) return undefined;
  return commands.map((command) => ({
    name: command.name,
    ...(command.description === undefined ? {} : { description: command.description }),
    source: command.source,
    ...(command.sourceInfo === undefined ? {} : { sourceInfo: command.sourceInfo }),
  }));
}

/** Core `media_type: string` narrows to the Protocol supported-media enum. */
function mapImageSource(source: ImageContentSource): ProtocolImageContentSource {
  if (source.type === "base64") {
    // Adapter always emits a complete base64 source with a supported media type;
    // the transport schema gate fails closed if either were ever absent/invalid.
    return {
      type: "base64",
      media_type: source.media_type as SupportedImageMediaType,
      data: source.data as string,
    };
  }
  return {
    type: "url",
    url: source.url as string,
    ...(source.media_type === undefined
      ? {}
      : { media_type: source.media_type as SupportedImageMediaType }),
  };
}

export function mapImage(block: ImageContent): ProtocolImageContent {
  return { type: "image", source: mapImageSource(block.source) };
}

function mapAssistantBlock(block: AssistantContentBlock): ProtocolAssistantContentBlock {
  switch (block.type) {
    case "text": {
      const text: ProtocolTextContent = { type: "text", text: block.text };
      return text;
    }
    case "image":
      return mapImage(block);
    case "thinking": {
      const thinking: ProtocolThinkingContent = {
        type: "thinking",
        thinking: block.thinking,
        ...(block.deferred === undefined ? {} : { deferred: block.deferred }),
      };
      return thinking;
    }
    case "toolCall": {
      const toolCall: ProtocolToolCallContent = {
        type: "toolCall",
        toolCallId: block.toolCallId,
        toolName: block.toolName,
        input: block.input,
      };
      return toolCall;
    }
  }
}

function mapAssistantContent(
  blocks: readonly AssistantContentBlock[],
): ProtocolAssistantContentBlock[] {
  return blocks.map((block) => mapAssistantBlock(block));
}

export function mapUserContent(content: UserContent): ProtocolUserContent {
  if (typeof content === "string") return content;
  return content.map((block) =>
    block.type === "text" ? ({ type: "text", text: block.text } as ProtocolTextContent) : mapImage(block),
  );
}

export function mapTokenUsage(usage: TokenUsage | undefined) {
  if (usage === undefined) return undefined;
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    cost: {
      input: usage.cost.input,
      output: usage.cost.output,
      cacheRead: usage.cost.cacheRead,
      cacheWrite: usage.cost.cacheWrite,
      total: usage.cost.total,
    },
  };
}

export function mapExtensionStatuses(statuses: readonly ExtensionStatusItem[] | undefined) {
  if (statuses === undefined) return undefined;
  return statuses.map((status) => ({ key: status.key, text: status.text }));
}

export function mapExtensionWidgets(widgets: readonly ExtensionWidgetItem[] | undefined) {
  if (widgets === undefined) return undefined;
  return widgets.map((widget) => ({
    key: widget.key,
    lines: [...widget.lines],
    placement: widget.placement,
  }));
}

/** Core `ImageAttachment` (mimeType: string) narrows to the Protocol supported-media enum. */
function mapImageAttachment(image: { type: "image"; data: string; mimeType: string }) {
  return { type: "image" as const, data: image.data, mimeType: image.mimeType as SupportedImageMediaType };
}

function mapQueuedTurn(turn: QueuedTurn) {
  return {
    message: turn.message,
    ...(turn.images === undefined ? {} : { images: turn.images.map((image) => mapImageAttachment(image)) }),
  };
}

export function mapQueuedTurns(turns: readonly QueuedTurn[] | undefined) {
  if (turns === undefined) return undefined;
  return turns.map((turn) => mapQueuedTurn(turn));
}

export function mapQueuedMessages(queue: QueuedMessages | undefined) {
  if (queue === undefined) return undefined;
  return {
    steering: queue.steering.map((turn) => mapQueuedTurn(turn)),
    followUp: queue.followUp.map((turn) => mapQueuedTurn(turn)),
  };
}

export function mapBashProjection(bash: BashProjection | undefined) {
  if (bash === undefined) return undefined;
  return {
    command: bash.command,
    output: bash.output,
    excludeFromContext: bash.excludeFromContext,
    truncated: bash.truncated,
    cancelled: bash.cancelled,
    completed: bash.completed,
    ...(bash.exitCode === undefined ? {} : { exitCode: bash.exitCode }),
    ...(bash.fullOutputPath === undefined ? {} : { fullOutputPath: bash.fullOutputPath }),
    updateCount: bash.updateCount,
  };
}

export function mapCompactionProjection(compaction: CompactionProjection | undefined) {
  if (compaction === undefined) return undefined;
  return {
    reason: compaction.reason,
    status: compaction.status,
    ...(compaction.customInstructions === undefined ? {} : { customInstructions: compaction.customInstructions }),
    startedAt: compaction.startedAt,
  };
}

/**
 * Map a Core {@link ExtensionUiRequest} to the Protocol method-discriminated
 * {@link ExtensionUiRequest}. Only the fields valid for the method are carried;
 * cross-method fields are dropped so the strict discriminated schema accepts it.
 */
export function mapExtensionUiRequest(request: ExtensionUiRequest): ProtocolExtensionUiRequest {
  const id = request.id;
  const method = request.method;
  const timing = {
    ...(request.timeout === undefined ? {} : { timeout: request.timeout }),
    ...(request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt }),
  };
  // Canonical close marker: a close tombstone must survive the worker mapper
  // so the sessiond/browser projection REMOVES the request. Active pending
  // requests never carry it.
  const closed = request.closed === true ? { closed: true as const } : {};
  switch (method) {
    case "select":
      return { id, method: "select", title: request.title ?? "", options: [...(request.options ?? [])], ...timing, ...closed };
    case "confirm":
      return { id, method: "confirm", title: request.title ?? "", message: request.message ?? "", ...timing, ...closed };
    case "input":
      return {
        id,
        method: "input",
        title: request.title ?? "",
        ...(request.placeholder === undefined ? {} : { placeholder: request.placeholder }),
        ...timing,
        ...closed,
      };
    case "editor":
      return {
        id,
        method: "editor",
        title: request.title ?? "",
        ...(request.prefill === undefined ? {} : { prefill: request.prefill }),
        ...timing,
        ...closed,
      };
    case "notify":
      return {
        id,
        method: "notify",
        message: request.message ?? "",
        notifyType: request.notifyType ?? "info",
        ...timing,
        ...closed,
      };
    case "setStatus":
      return {
        id,
        method: "setStatus",
        statusKey: request.statusKey ?? "",
        ...(request.statusText === undefined ? {} : { statusText: request.statusText }),
        ...timing,
        ...closed,
      };
    case "setWidget":
      return {
        id,
        method: "setWidget",
        widgetKey: request.widgetKey ?? "",
        ...(request.widgetLines === undefined ? {} : { widgetLines: [...request.widgetLines] }),
        ...(request.widgetPlacement === undefined ? {} : { widgetPlacement: request.widgetPlacement }),
        ...timing,
        ...closed,
      };
    case "setTitle":
      return { id, method: "setTitle", title: request.title ?? "", ...timing, ...closed };
    case "set_editor_text":
      return { id, method: "set_editor_text", text: request.text ?? "", ...timing, ...closed };
    case "custom":
      return { id, method: "custom", lines: [...(request.lines ?? [])], ...timing, ...closed };
  }
}

export function mapPendingExtensionUi(
  pending: readonly ExtensionUiRequest[] | undefined,
) {
  if (pending === undefined) return undefined;
  return pending.map((request) => mapExtensionUiRequest(request));
}

/** Maps the canonical Core RuntimeState to the Protocol RuntimeState DTO. */
export function mapRuntimeState(state: RuntimeState) {
  const model = mapModelRef(state.model);
  return {
    sessionId: state.sessionId,
    ...(state.sessionFile === undefined ? {} : { sessionFile: state.sessionFile }),
    ...(state.leafId === undefined ? {} : { leafId: state.leafId }),
    isStreaming: state.isStreaming,
    isPromptRunning: state.isPromptRunning,
    isBashRunning: state.isBashRunning,
    isCompacting: state.isCompacting,
    ...(state.bash === undefined ? {} : { bash: mapBashProjection(state.bash) }),
    ...(state.compaction === undefined ? {} : { compaction: mapCompactionProjection(state.compaction) }),
    ...(state.autoCompactionEnabled === undefined ? {} : { autoCompactionEnabled: state.autoCompactionEnabled }),
    ...(state.autoRetryEnabled === undefined ? {} : { autoRetryEnabled: state.autoRetryEnabled }),
    model,
    messageCount: state.messageCount,
    ...(state.pendingMessageCount === undefined ? {} : { pendingMessageCount: state.pendingMessageCount }),
    ...(state.queuedMessages === undefined ? {} : { queuedMessages: mapQueuedMessages(state.queuedMessages) }),
    contextUsage: mapContextUsage(state.contextUsage),
    ...(state.systemPrompt === undefined ? {} : { systemPrompt: state.systemPrompt }),
    ...(state.thinkingLevel === undefined ? {} : { thinkingLevel: state.thinkingLevel }),
    ...(state.thinkingLevelPinned === undefined ? {} : { thinkingLevelPinned: state.thinkingLevelPinned }),
    ...(state.tools === undefined ? {} : { tools: mapToolInfo(state.tools) }),
    ...(state.extensionStatuses === undefined
      ? {}
      : { extensionStatuses: mapExtensionStatuses(state.extensionStatuses) }),
    ...(state.extensionWidgets === undefined
      ? {}
      : { extensionWidgets: mapExtensionWidgets(state.extensionWidgets) }),
    ...(state.pendingExtensionUi === undefined
      ? {}
      : { pendingExtensionUi: mapPendingExtensionUi(state.pendingExtensionUi) }),
    ...(state.sessionName === undefined ? {} : { sessionName: state.sessionName }),
    ...(state.writtenFiles === undefined ? {} : { writtenFiles: copy(state.writtenFiles) }),
  };
}

export function mapCapabilitySet(capabilities: RuntimeCapabilitySet) {
  return { capabilities: [...capabilities.capabilities], version: capabilities.version };
}

export function mapStreamingMessage(message: StreamingAgentMessage): ProtocolStreamingAgentMessage {
  switch (message.role) {
    case "user":
      return {
        role: "user",
        ...(message.content === undefined ? {} : { content: mapUserContent(message.content) }),
        ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
      };
    case "assistant":
      return {
        role: "assistant",
        ...(message.content === undefined ? {} : { content: mapAssistantContent(message.content) }),
        ...(message.model === undefined ? {} : { model: message.model }),
        ...(message.provider === undefined ? {} : { provider: message.provider }),
        ...(message.stopReason === undefined ? {} : { stopReason: message.stopReason }),
        ...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
        ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
        ...(message.usage === undefined ? {} : { usage: mapTokenUsage(message.usage) }),
        ...(message.writtenFiles === undefined ? {} : { writtenFiles: copy(message.writtenFiles) }),
      };
    case "toolResult":
      return {
        role: "toolResult",
        ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
        ...(message.toolName === undefined ? {} : { toolName: message.toolName }),
        ...(message.content === undefined ? {} : { content: mapToolResultContent(message.content) }),
        ...(message.isError === undefined ? {} : { isError: message.isError }),
        ...(message.details === undefined ? {} : { details: message.details }),
        ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
      };
    case "custom":
      return {
        role: "custom",
        ...(message.customType === undefined ? {} : { customType: message.customType }),
        ...(message.content === undefined ? {} : { content: mapUserContent(message.content) }),
        ...(message.display === undefined ? {} : { display: message.display }),
        ...(message.details === undefined ? {} : { details: message.details }),
        ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
      };
    case "bashExecution":
      return {
        role: "bashExecution",
        ...(message.command === undefined ? {} : { command: message.command }),
        ...(message.output === undefined ? {} : { output: message.output }),
        ...(message.exitCode === undefined ? {} : { exitCode: message.exitCode }),
        ...(message.cancelled === undefined ? {} : { cancelled: message.cancelled }),
        ...(message.truncated === undefined ? {} : { truncated: message.truncated }),
        ...(message.fullOutputPath === undefined ? {} : { fullOutputPath: message.fullOutputPath }),
        ...(message.excludeFromContext === undefined ? {} : { excludeFromContext: message.excludeFromContext }),
        ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
      };
  }
}

function mapToolResultContent(content: readonly (TextContent | ImageContent)[]): (ProtocolTextContent | ProtocolImageContent)[] {
  return content.map((block) =>
    block.type === "text" ? ({ type: "text", text: block.text } as ProtocolTextContent) : mapImage(block),
  );
}

export function mapAgentMessage(message: AgentMessage): ProtocolAgentMessage {
  switch (message.role) {
    case "user":
      return {
        role: "user",
        content: mapUserContent(message.content),
        ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
      };
    case "assistant":
      return {
        role: "assistant",
        content: mapAssistantContent(message.content),
        model: message.model,
        provider: message.provider,
        ...(message.stopReason === undefined ? {} : { stopReason: message.stopReason }),
        ...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
        ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
        ...(message.usage === undefined ? {} : { usage: mapTokenUsage(message.usage) }),
        ...(message.writtenFiles === undefined ? {} : { writtenFiles: copy(message.writtenFiles) }),
      };
    case "toolResult":
      return {
        role: "toolResult",
        toolCallId: message.toolCallId,
        ...(message.toolName === undefined ? {} : { toolName: message.toolName }),
        content: mapToolResultContent(message.content),
        ...(message.isError === undefined ? {} : { isError: message.isError }),
        ...(message.details === undefined ? {} : { details: message.details }),
        ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
      };
    case "custom":
      return {
        role: "custom",
        customType: message.customType,
        content: mapUserContent(message.content),
        display: message.display,
        ...(message.details === undefined ? {} : { details: message.details }),
        ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
      };
    case "bashExecution":
      return {
        role: "bashExecution",
        command: message.command,
        output: message.output,
        ...(message.exitCode === undefined ? {} : { exitCode: message.exitCode }),
        ...(message.cancelled === undefined ? {} : { cancelled: message.cancelled }),
        ...(message.truncated === undefined ? {} : { truncated: message.truncated }),
        ...(message.fullOutputPath === undefined ? {} : { fullOutputPath: message.fullOutputPath }),
        ...(message.excludeFromContext === undefined ? {} : { excludeFromContext: message.excludeFromContext }),
        ...(message.timestamp === undefined ? {} : { timestamp: message.timestamp }),
      };
  }
}

export function mapAgentMessages(messages: readonly AgentMessage[] | undefined) {
  if (messages === undefined) return undefined;
  return messages.map((message) => mapAgentMessage(message));
}

// Re-export PendingExtensionUi for callers that build snapshot projections.
export type { PendingExtensionUi };
