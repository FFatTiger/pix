/**
 * Tool-name predicates shared by the chat views.
 *
 * Pi's built-in names are plain `write` / `edit`, but MCP servers expose the
 * same operations under prefixed or namespaced names, so each predicate also
 * accepts the common decorated forms.
 */

/**
 * Human process-line identity for the assistant/memory tools (both display
 * modes — codex + timeline — resolve the label through this one table).
 * Returns null for every other tool (callers fall back to their generic
 * labeling). `kind` drives the icon; `detailKey` interpolates `{value}`.
 */
export type AssistantToolLabel = {
  labelKey: string;
  detailKey: string;
  iconName: "bookOpen" | "magnifyingGlass" | "brain";
};

const ASSISTANT_TOOL_LABELS: Record<string, AssistantToolLabel> = {
  search_sessions: { labelKey: "desktop.codexAssistantSearchedSessions", detailKey: "desktop.codexAssistantSearchedSessionsDetail", iconName: "magnifyingGlass" },
  read_session: { labelKey: "desktop.codexAssistantReadSession", detailKey: "desktop.codexAssistantReadSessionDetail", iconName: "bookOpen" },
  // Lore memory tools: recall reads vs. writes.
  lore_search: { labelKey: "desktop.codexAssistantMemoryRecall", detailKey: "desktop.codexAssistantMemoryRecallDetail", iconName: "brain" },
  lore_get_node: { labelKey: "desktop.codexAssistantMemoryRecall", detailKey: "desktop.codexAssistantMemoryRecallDetail", iconName: "brain" },
  lore_boot: { labelKey: "desktop.codexAssistantMemoryRecall", detailKey: "desktop.codexAssistantMemoryRecallDetail", iconName: "brain" },
  lore_create_node: { labelKey: "desktop.codexAssistantMemorySaved", detailKey: "desktop.codexAssistantMemorySavedDetail", iconName: "brain" },
  lore_update_node: { labelKey: "desktop.codexAssistantMemorySaved", detailKey: "desktop.codexAssistantMemorySavedDetail", iconName: "brain" },
  lore_delete_node: { labelKey: "desktop.codexAssistantMemorySaved", detailKey: "desktop.codexAssistantMemorySavedDetail", iconName: "brain" },
};

export function assistantToolLabel(toolName: string): AssistantToolLabel | null {
  return ASSISTANT_TOOL_LABELS[toolName] ?? null;
}

/** First meaningful string argument for a tool-call detail line (bounded). */
export function assistantToolDetailValue(toolName: string, input: Record<string, unknown> | undefined): string {
  const keys = toolName === "read_session"
    ? ["session"]
    : ["query", "project", "uri"];
  for (const key of keys) {
    const value = input?.[key];
    if (typeof value === "string" && value.trim() !== "") {
      const normalized = value.replace(/\s+/g, " ").trim();
      return normalized.length > 60 ? `${normalized.slice(0, 59)}…` : normalized;
    }
  }
  return "";
}

export function isWriteToolName(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return name === "write" ||
    name.startsWith("write_") ||
    name.endsWith(".write") ||
    name.endsWith("_write");
}

export function isEditToolName(toolName: string): boolean {
  const name = toolName.toLowerCase();
  return name === "edit" ||
    name.startsWith("edit_") ||
    name.endsWith(".edit") ||
    name.endsWith("_edit") ||
    name.includes("str_replace") ||
    name.includes("replace_editor");
}
