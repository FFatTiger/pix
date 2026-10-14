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
  iconName: "bookOpen" | "magnifyingGlass" | "brain" | "listBullets" | "checklist" | "folder" | "arrowRight" | "stacks" | "penNib" | "filePlus" | "circleX";
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
  // Local pi-memory tools (bundled pi-memory 0.4.2) share the Lore recall/write
  // wording; forget / restore / scratchpad get their own verbs.
  memory_read: { labelKey: "desktop.codexAssistantMemoryRecall", detailKey: "desktop.codexAssistantMemoryRecallDetail", iconName: "brain" },
  memory_status: { labelKey: "desktop.codexAssistantMemoryRecall", detailKey: "desktop.codexAssistantMemoryRecallDetail", iconName: "brain" },
  memory_write: { labelKey: "desktop.codexAssistantMemorySaved", detailKey: "desktop.codexAssistantMemorySavedDetail", iconName: "brain" },
  memory_forget: { labelKey: "desktop.codexAssistantMemoryForgot", detailKey: "desktop.codexAssistantMemoryForgotDetail", iconName: "brain" },
  // memory_restore's only argument (recoveryId) is not surfaced as a detail
  // value, so the detail is always empty and the label doubles as fallback.
  memory_restore: { labelKey: "desktop.codexAssistantMemoryRestored", detailKey: "desktop.codexAssistantMemoryRestored", iconName: "brain" },
  scratchpad: { labelKey: "desktop.codexAssistantScratchpad", detailKey: "desktop.codexAssistantScratchpadDetail", iconName: "penNib" },
  // Assistant session capabilities (round 3).
  session_status: { labelKey: "desktop.codexAssistantSessionStatus", detailKey: "desktop.codexAssistantSessionStatusDetail", iconName: "listBullets" },
  list_open_todos: { labelKey: "desktop.codexAssistantOpenTodos", detailKey: "desktop.codexAssistantOpenTodosDetail", iconName: "checklist" },
  summarize_activity: { labelKey: "desktop.codexAssistantActivity", detailKey: "desktop.codexAssistantActivityDetail", iconName: "listBullets" },
  find_file_changes: { labelKey: "desktop.codexAssistantFileChanges", detailKey: "desktop.codexAssistantFileChangesDetail", iconName: "folder" },
  list_projects: { labelKey: "desktop.codexAssistantProjects", detailKey: "desktop.codexAssistantProjectsDetail", iconName: "stacks" },
  open_session: { labelKey: "desktop.codexAssistantOpenSession", detailKey: "desktop.codexAssistantOpenSessionDetail", iconName: "arrowRight" },
  organize_sessions: { labelKey: "desktop.codexAssistantOrganize", detailKey: "desktop.codexAssistantOrganizeDetail", iconName: "stacks" },
  draft_to_session: { labelKey: "desktop.codexAssistantDraft", detailKey: "desktop.codexAssistantDraftDetail", iconName: "penNib" },
  // Assistant directly operates sessions (round 7).
  send_to_session: { labelKey: "desktop.codexAssistantSendToSession", detailKey: "desktop.codexAssistantSendToSessionDetail", iconName: "arrowRight" },
  create_session: { labelKey: "desktop.codexAssistantCreateSession", detailKey: "desktop.codexAssistantCreateSessionDetail", iconName: "filePlus" },
  stop_session: { labelKey: "desktop.codexAssistantStopSession", detailKey: "desktop.codexAssistantStopSessionDetail", iconName: "circleX" },
};

export function assistantToolLabel(toolName: string): AssistantToolLabel | null {
  return ASSISTANT_TOOL_LABELS[toolName] ?? null;
}

/** Per-tool argument keys probed for the detail value; unlisted tools fall back to the generic order. */
const TOOL_DETAIL_KEYS: Record<string, readonly string[]> = {
  read_session: ["session"],
  open_session: ["session"],
  draft_to_session: ["session"],
  send_to_session: ["session"],
  stop_session: ["session"],
  create_session: ["project"],
  organize_sessions: ["action"],
  memory_write: ["content"],
  memory_forget: ["match"],
  scratchpad: ["text"],
};

/** First meaningful string argument for a tool-call detail line (bounded). */
export function assistantToolDetailValue(toolName: string, input: Record<string, unknown> | undefined): string {
  const keys = TOOL_DETAIL_KEYS[toolName] ?? ["query", "project", "path", "range", "uri"];
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
