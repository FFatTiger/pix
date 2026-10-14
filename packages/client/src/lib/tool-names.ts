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
  iconName: "bookOpen" | "magnifyingGlass" | "brain" | "listBullets" | "checklist" | "folder" | "arrowRight" | "stacks" | "penNib";
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
  // Assistant session capabilities (round 3).
  session_status: { labelKey: "desktop.codexAssistantSessionStatus", detailKey: "desktop.codexAssistantSessionStatusDetail", iconName: "listBullets" },
  list_open_todos: { labelKey: "desktop.codexAssistantOpenTodos", detailKey: "desktop.codexAssistantOpenTodosDetail", iconName: "checklist" },
  summarize_activity: { labelKey: "desktop.codexAssistantActivity", detailKey: "desktop.codexAssistantActivityDetail", iconName: "listBullets" },
  find_file_changes: { labelKey: "desktop.codexAssistantFileChanges", detailKey: "desktop.codexAssistantFileChangesDetail", iconName: "folder" },
  list_projects: { labelKey: "desktop.codexAssistantProjects", detailKey: "desktop.codexAssistantProjectsDetail", iconName: "stacks" },
  open_session: { labelKey: "desktop.codexAssistantOpenSession", detailKey: "desktop.codexAssistantOpenSessionDetail", iconName: "arrowRight" },
  organize_sessions: { labelKey: "desktop.codexAssistantOrganize", detailKey: "desktop.codexAssistantOrganizeDetail", iconName: "stacks" },
  draft_to_session: { labelKey: "desktop.codexAssistantDraft", detailKey: "desktop.codexAssistantDraftDetail", iconName: "penNib" },
};

export function assistantToolLabel(toolName: string): AssistantToolLabel | null {
  return ASSISTANT_TOOL_LABELS[toolName] ?? null;
}

/** First meaningful string argument for a tool-call detail line (bounded). */
export function assistantToolDetailValue(toolName: string, input: Record<string, unknown> | undefined): string {
  const keys = toolName === "read_session" || toolName === "open_session" || toolName === "draft_to_session"
    ? ["session"]
    : toolName === "organize_sessions"
      ? ["action"]
      : ["query", "project", "path", "range", "uri"];
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
