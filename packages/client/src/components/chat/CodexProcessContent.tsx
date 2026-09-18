import { useMemo, useState, type ReactNode } from "react";
import { BookOpenIcon } from "@phosphor-icons/react/BookOpen";
import { CaretRightIcon } from "@phosphor-icons/react/CaretRight";
import { CopySimpleIcon } from "@phosphor-icons/react/CopySimple";
import { DownloadSimpleIcon } from "@phosphor-icons/react/DownloadSimple";
import { FilePlusIcon } from "@phosphor-icons/react/FilePlus";
import { FolderIcon } from "@phosphor-icons/react/Folder";
import { ImageIcon } from "@phosphor-icons/react/Image";
import { ListBulletsIcon } from "@phosphor-icons/react/ListBullets";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/MagnifyingGlass";
import { PencilSimpleLineIcon } from "@phosphor-icons/react/PencilSimpleLine";
import { TerminalIcon } from "@phosphor-icons/react/Terminal";
import { ToolboxIcon } from "@phosphor-icons/react/Toolbox";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import { MarkdownBody } from "./MarkdownBody";
import { DisclosureCollapse } from "./DisclosureCollapse";
import { useI18n } from "@/hooks/useI18n";
import type { ImageContent, ToolResultMessage } from "@/lib/chat-view-model";
import type { ProcessContentBlock } from "@/lib/process-content";
import {
  basenameResourcePath,
  classifyDocumentChangeKind,
  classifyShellCommand,
  classifyToolTone,
  extractToolTarget,
  type StepTone,
} from "@/lib/step-categorizer";
import type { StepIconName } from "@/lib/step-visuals";
import { countPatchStats } from "@/lib/turn-written-files";

type ToolBlock = Extract<ProcessContentBlock, { type: "toolCall" }>;
type TextBlock = Extract<ProcessContentBlock, { type: "text" }>;
type ThinkingBlock = Extract<ProcessContentBlock, { type: "thinking" }>;
type SequenceBlock = Extract<ProcessContentBlock, { type: "toolCall" | "custom" | "image" }>;

type CodexFlowItem =
  | { kind: "narrative"; id: string; block: TextBlock }
  | { kind: "thinkingStatus"; id: string; block: ThinkingBlock }
  | { kind: "tools"; id: string; blocks: ToolBlock[]; entries: SequenceBlock[] }
  | { kind: "custom"; id: string; block: Extract<ProcessContentBlock, { type: "custom" }> }
  | { kind: "image"; id: string; block: Extract<ProcessContentBlock, { type: "image" }> };

interface CodexProcessContentProps {
  blocks: ProcessContentBlock[];
  cwd?: string | undefined;
  onOpenFile?: ((filePath: string) => void) | undefined;
  isStreaming: boolean;
  isAnswerStreaming: boolean;
}

interface ToolPresentation {
  action: string;
  completedAction?: string | undefined;
  continuedAction?: string | undefined;
  detail: string;
  iconName: StepIconName;
  tone?: StepTone | undefined;
  target?: string | undefined;
}

type Translate = ReturnType<typeof useI18n>["t"];

const DETAIL_PREVIEW_CHARS = 8_000;
const MAX_GROUP_ACTIONS = 3;

interface CodexGroupImage {
  key: string;
  src: string;
}

/** Codex mode preserves source order and batches tools until visible model text appears. */
export function buildCodexFlowItems(
  blocks: ProcessContentBlock[],
  isStreaming = false,
  isAnswerStreaming = false,
): CodexFlowItem[] {
  const items: CodexFlowItem[] = [];
  let sequence: SequenceBlock[] = [];
  let pendingThinking: ThinkingBlock | undefined;

  const flushSequence = () => {
    if (sequence.length === 0) return;
    const tools = sequence.filter((block): block is ToolBlock => block.type === "toolCall");
    if (tools.length > 0) {
      items.push({
        kind: "tools",
        id: sequence.map((block) => block.id).join("+"),
        blocks: tools,
        entries: sequence,
      });
    } else {
      for (const block of sequence) {
        if (block.type === "custom") {
          items.push({ kind: "custom", id: block.id, block });
        } else if (block.type === "image") {
          items.push({ kind: "image", id: block.id, block });
        }
      }
    }
    sequence = [];
  };

  for (const block of blocks) {
    if (block.type === "toolCall" || block.type === "custom" || block.type === "image") {
      pendingThinking = undefined;
      sequence.push(block);
      continue;
    }

    if (block.type === "thinking") {
      // Thinking is only the transient title for work that has not arrived yet.
      // It stays out of settled history and does not create an invisible split.
      pendingThinking = thinkingTitle(block.thinking) ? block : undefined;
    } else if (block.type === "text" && block.text.trim().length > 0) {
      flushSequence();
      pendingThinking = undefined;
      items.push({ kind: "narrative", id: block.id, block });
    }
  }

  flushSequence();
  if (isStreaming && !isAnswerStreaming && pendingThinking) {
    items.push({ kind: "thinkingStatus", id: pendingThinking.id, block: pendingThinking });
  }
  return items;
}

function readString(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function commandText(block: ToolBlock): string | undefined {
  return readString(block.input, ["command", "cmd"]);
}

function queryText(block: ToolBlock): string | undefined {
  return readString(block.input, ["pattern", "query", "glob"]);
}

function toolTarget(block: ToolBlock): string | undefined {
  return extractToolTarget({
    toolName: block.toolName,
    label: typeof block.input.label === "string" ? block.input.label : undefined,
    args: block.input,
    result: toolResultText(block.result),
  });
}

function concise(value: string, max = 120): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 3)}...` : normalized;
}

function displayToolName(toolName: string): string {
  const normalized = toolName.trim().replace(/[_-]+/g, " ");
  return normalized.toLowerCase() === "agent"
    ? "Agent"
    : normalized || toolName;
}

function isImageViewTool(block: ToolBlock): boolean {
  if (toolResultImages(block.result).length > 0) return true;
  const normalized = block.toolName.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return normalized === "view_image" || normalized.endsWith("_view_image") || normalized.endsWith("viewimage");
}

function toolTone(block: ToolBlock): StepTone | undefined {
  return classifyToolTone({
    toolName: block.toolName,
    label: typeof block.input.label === "string" ? block.input.label : undefined,
    args: block.input,
    result: toolResultText(block.result),
  });
}

function isCommandInvocation(block: ToolBlock): boolean {
  return toolTone(block) === "command_execution";
}

function classifyPresentation(block: ToolBlock, t: Translate): ToolPresentation {
  const tone = toolTone(block);

  // A command's non-zero exit is not enough to infer failure: probes such as
  // grep/test commonly use it as expected control flow. Preserve the command
  // action and raw output without inventing a failure label.
  if (block.status === "error" && tone !== "command_execution") {
    return {
      action: t("desktop.codexProcessGroupFailed"),
      detail: t("desktop.codexProcessToolFailed", { tool: block.toolName }),
      iconName: "warning",
      tone,
    };
  }

  const target = toolTarget(block);
  const shortTarget = target ? basenameResourcePath(target) : undefined;

  if (isImageViewTool(block)) {
    const imageCount = Math.max(1, toolResultImages(block.result).length);
    return {
      action: t("desktop.codexProcessGroupViewedImages"),
      completedAction: t("desktop.codexProcessCompletedViewedImages"),
      continuedAction: t("desktop.codexProcessGroupViewedImages"),
      detail: block.status === "running"
        ? t("desktop.codexProcessToolViewingImages")
        : t(
            imageCount === 1 ? "desktop.codexProcessToolViewedImage" : "desktop.codexProcessToolViewedImages",
            { count: imageCount },
          ),
      iconName: "image",
      tone,
      target,
    };
  }

  if (tone === "document_change") {
    const kind = classifyDocumentChangeKind({
      toolName: block.toolName,
      label: typeof block.input.label === "string" ? block.input.label : undefined,
      args: block.input,
      result: toolResultText(block.result),
    });
    if (kind === "create") {
      return {
        action: t("desktop.codexProcessGroupCreatedFiles"),
        completedAction: t("desktop.codexProcessCompletedCreatedFiles"),
        detail: t("desktop.codexProcessToolCreated", { target: shortTarget ?? block.toolName }),
        iconName: "filePlus",
        tone,
        target,
      };
    }
    if (kind === "delete") {
      return {
        action: t("desktop.codexProcessGroupDeletedFiles"),
        completedAction: t("desktop.codexProcessCompletedDeletedFiles"),
        detail: t("desktop.codexProcessToolDeleted", { target: shortTarget ?? block.toolName }),
        iconName: "trash",
        tone,
        target,
      };
    }
    return {
      action: t("desktop.codexProcessGroupEditedFiles"),
      completedAction: t("desktop.codexProcessCompletedEditedFiles"),
      detail: t("desktop.codexProcessToolEdited", { target: shortTarget ?? block.toolName }),
      iconName: "pencilSimpleLine",
      tone,
      target,
    };
  }

  if (tone === "document_read") {
    return {
      action: t("desktop.codexProcessGroupReadFiles"),
      completedAction: t("desktop.codexProcessCompletedReadFiles"),
      continuedAction: t("desktop.codexProcessGroupReadFiles"),
      detail: t("desktop.codexProcessToolRead", { target: shortTarget ?? block.toolName }),
      iconName: "bookOpen",
      tone,
      target,
    };
  }

  if (tone === "document_search" || tone === "file_find") {
    const query = queryText(block);
    return {
      action: t("desktop.codexProcessGroupSearched"),
      completedAction: t("desktop.codexProcessCompletedSearched"),
      detail: query
        ? t("desktop.codexProcessToolSearchedFor", { query: concise(query, 80) })
        : t("desktop.codexProcessToolSearched"),
      iconName: "magnifyingGlass",
      tone,
      target,
    };
  }

  if (tone === "directory_list") {
    return {
      action: t("desktop.codexProcessGroupListed"),
      completedAction: t("desktop.codexProcessCompletedListed"),
      detail: t("desktop.codexProcessToolListed", { target: shortTarget ?? block.toolName }),
      iconName: "folder",
      tone,
      target,
    };
  }

  if (tone === "command_execution") {
    const command = commandText(block);
    if (command) {
      const shell = classifyShellCommand(command);
      const shellTarget = shell.argument ? concise(shell.argument, 80) : shortTarget;
      if (shell.kind === "read") {
        return {
          action: t("desktop.codexProcessGroupReadFiles"),
          completedAction: t("desktop.codexProcessCompletedReadFiles"),
          continuedAction: t("desktop.codexProcessGroupReadFiles"),
          detail: t("desktop.codexProcessToolRead", { target: shellTarget ?? shell.binary }),
          iconName: "bookOpen",
          tone: "document_read",
          target,
        };
      }
      if (shell.kind === "search" || shell.kind === "find") {
        return {
          action: t("desktop.codexProcessGroupSearched"),
          completedAction: t("desktop.codexProcessCompletedSearched"),
          detail: shellTarget
            ? t("desktop.codexProcessToolSearchedFor", { query: shellTarget })
            : t("desktop.codexProcessToolSearched"),
          iconName: "magnifyingGlass",
          tone: "document_search",
          target,
        };
      }
      if (shell.kind === "list") {
        return {
          action: t("desktop.codexProcessGroupListed"),
          completedAction: t("desktop.codexProcessCompletedListed"),
          detail: t("desktop.codexProcessToolListed", { target: shellTarget ?? shell.binary }),
          iconName: "folder",
          tone: "directory_list",
          target,
        };
      }
      if (shell.kind === "fetch") {
        return {
          action: t("desktop.codexProcessGroupFetched"),
          completedAction: t("desktop.codexProcessCompletedFetched"),
          detail: t("desktop.codexProcessToolFetched", { target: shellTarget ?? shell.binary }),
          iconName: "download",
          tone,
          target,
        };
      }
      if (shell.kind === "delete") {
        return {
          action: t("desktop.codexProcessGroupDeletedFiles"),
          completedAction: t("desktop.codexProcessCompletedDeletedFiles"),
          detail: t("desktop.codexProcessToolDeleted", { target: shellTarget ?? shell.binary }),
          iconName: "trash",
          tone: "document_change",
          target,
        };
      }
      if (shell.kind === "copy") {
        return {
          action: t("desktop.codexProcessGroupCopied"),
          completedAction: t("desktop.codexProcessCompletedCopied"),
          detail: t("desktop.codexProcessToolCopied", { target: shellTarget ?? shell.binary }),
          iconName: "copy",
          tone,
          target,
        };
      }
    }

    const preview = concise(command ?? block.toolName);
    const detail = block.status === "running"
      ? t("desktop.codexProcessToolRunning", { command: preview })
      : block.duration !== undefined
        ? t("desktop.codexProcessToolRanIn", { command: preview, duration: block.duration })
        : t("desktop.codexProcessToolRan", { command: preview });
    return {
      action: t("desktop.codexProcessGroupRanCommands"),
      completedAction: t("desktop.codexProcessCompletedRanCommands"),
      detail,
      iconName: "terminal",
      tone,
      target,
    };
  }

  if (tone === "todo_update") {
    return {
      action: t("desktop.codexProcessGroupUpdatedTodos"),
      completedAction: t("desktop.codexProcessCompletedUpdatedTodos"),
      detail: t("desktop.codexProcessToolUsed", { tool: block.toolName }),
      iconName: "checklist",
      tone,
      target,
    };
  }

  return {
    action: t("desktop.codexProcessGroupUsedTool", { tool: displayToolName(block.toolName) }),
    completedAction: t("desktop.codexProcessCompletedUsedTool", { tool: displayToolName(block.toolName) }),
    detail: t(
      block.status === "running" ? "desktop.codexProcessToolUsing" : "desktop.codexProcessToolUsed",
      { tool: displayToolName(block.toolName) },
    ),
    iconName: "toolbox",
    tone,
    target,
  };
}

function iconFor(name: StepIconName, size = 16): ReactNode {
  switch (name) {
    case "bookOpen": return <BookOpenIcon size={size} />;
    case "magnifyingGlass": return <MagnifyingGlassIcon size={size} />;
    case "pencilSimpleLine": return <PencilSimpleLineIcon size={size} />;
    case "filePlus": return <FilePlusIcon size={size} />;
    case "trash": return <TrashIcon size={size} />;
    case "folder": return <FolderIcon size={size} />;
    case "download": return <DownloadSimpleIcon size={size} />;
    case "copy": return <CopySimpleIcon size={size} />;
    case "terminal": return <TerminalIcon size={size} />;
    case "image": return <ImageIcon size={size} />;
    case "listBullets":
    case "checklist": return <ListBulletsIcon size={size} />;
    case "warning":
    case "circleX": return <WarningCircleIcon size={size} />;
    default: return <ToolboxIcon size={size} />;
  }
}

function toolResultText(result: ToolResultMessage | undefined): string | undefined {
  if (!result) return undefined;
  return result.content
    .filter((part): part is Extract<ToolResultMessage["content"][number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function toolResultImages(result: ToolResultMessage | undefined): ImageContent[] {
  if (!result) return [];
  return result.content.filter((part): part is ImageContent => part.type === "image");
}

function imageSource(source: ImageContent["source"]): string | undefined {
  if (source.type === "url") return source.url;
  if (!source.data) return undefined;
  return `data:${source.media_type};base64,${source.data}`;
}

function imageOnlyGroup(entries: SequenceBlock[]): CodexGroupImage[] | undefined {
  const images: CodexGroupImage[] = [];
  for (const entry of entries) {
    if (entry.type !== "toolCall" || entry.status !== "success") return undefined;
    const entryImages = toolResultImages(entry.result)
      .map((image, index) => {
        const src = imageSource(image.source);
        return src ? { key: `${entry.id}:${index}`, src } : undefined;
      })
      .filter((image): image is CodexGroupImage => image !== undefined);
    if (entryImages.length === 0) return undefined;
    images.push(...entryImages);
  }
  return images.length > 0 ? images : undefined;
}

function uniqueActions(
  blocks: ToolBlock[],
  presentations: ToolPresentation[],
  status: ToolBlock["status"],
): string[] {
  const actions: string[] = [];
  const seen = new Set<string>();
  blocks.forEach((block, index) => {
    const presentation = presentations[index];
    const identity = presentation?.action;
    const displayStatus = block.status === "error" && isCommandInvocation(block)
      ? "success"
      : block.status;
    if (displayStatus !== status || !presentation || !identity || seen.has(identity)) return;
    seen.add(identity);
    const action = status === "success"
      ? actions.length > 0
        ? presentation.continuedAction ?? presentation.completedAction ?? identity
        : presentation.completedAction ?? identity
      : identity;
    actions.push(action);
  });
  return actions;
}

function isPresentationFailure(block: ToolBlock): boolean {
  return block.status === "error" && !isCommandInvocation(block);
}

function summarizeGroupActions(
  blocks: ToolBlock[],
  presentations: ToolPresentation[],
  locale: string,
  t: Translate,
): string {
  if (locale !== "zh-CN") {
    const actions = presentations.reduce<string[]>((result, item) => {
      if (!result.includes(item.action)) result.push(item.action);
      return result;
    }, []);
    return actions.slice(0, MAX_GROUP_ACTIONS).join(" · ");
  }

  // Codex's Chinese labels concatenate actions without punctuation. Deduplicate
  // in source order, cap the summary at three semantic parts, and reserve room
  // for current running work plus a genuine non-command tool failure.
  const completedAll = uniqueActions(blocks, presentations, "success");
  const runningAll = uniqueActions(blocks, presentations, "running");
  const hasFailure = blocks.some(isPresentationFailure);
  const actionBudget = MAX_GROUP_ACTIONS - (hasFailure ? 1 : 0);
  const runningActions = runningAll.slice(0, actionBudget);
  const completedActions = completedAll.slice(0, Math.max(0, actionBudget - runningActions.length));
  const completedText = completedActions.join("");
  const runningText = runningActions.join("");
  const completed = completedText;
  const running = runningText
    ? t("desktop.codexProcessRunningActions", { actions: runningText })
    : "";

  let summary = completed && running
    ? t("desktop.codexProcessCompletedThenRunning", { completed, running })
    : completed || running;
  if (hasFailure) {
    summary = summary
      ? t("desktop.codexProcessActionsWithFailure", { actions: summary })
      : t("desktop.codexProcessSomeFailed");
  }
  return summary || t("desktop.codexProcessGroupUsedTools");
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function patchStats(block: ToolBlock): { additions: number; deletions: number } | undefined {
  const details = block.result?.details;
  if (typeof details !== "object" || details === null) return undefined;
  const patch = (details as Record<string, unknown>).patch;
  if (typeof patch !== "string" || !patch) return undefined;
  return countPatchStats(patch);
}

function CodexToolDetails({ block }: { block: ToolBlock }) {
  const { t } = useI18n();
  const [showFull, setShowFull] = useState(false);
  const resultText = toolResultText(block.result) ?? "";
  const truncated = resultText.length > DETAIL_PREVIEW_CHARS && !showFull;
  const visibleResult = truncated ? resultText.slice(0, DETAIL_PREVIEW_CHARS) : resultText;
  const images = toolResultImages(block.result);
  const hasInput = Object.keys(block.input).length > 0;

  return (
    <div className={`codex-tool-details${isPresentationFailure(block) ? " is-error" : ""}`}>
      {hasInput && (
        <div className="codex-tool-detail-section">
          <div className="codex-tool-detail-label">{t("desktop.codexProcessInput")}</div>
          <pre>{json(block.input)}</pre>
        </div>
      )}
      {block.result && (
        <div className="codex-tool-detail-section">
          <div className="codex-tool-detail-label">{t("desktop.codexProcessOutput")}</div>
          {visibleResult.trim() ? <pre>{visibleResult}</pre> : <div className="codex-tool-empty">{t("desktop.noOutput")}</div>}
          {images.length > 0 && (
            <div className="codex-tool-images">
              {images.map((image, index) => {
                const src = imageSource(image.source);
                return src ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={index} src={src} alt="" loading="lazy" decoding="async" />
                ) : null;
              })}
            </div>
          )}
          {truncated && (
            <button type="button" className="codex-tool-show-more" onClick={() => setShowFull(true)}>
              {t("desktop.loadFullOutput")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function CodexToolRow({ block }: { block: ToolBlock }) {
  const { t } = useI18n();
  const presentation = classifyPresentation(block, t);
  // Tools never auto-expand: a newly appeared tool stays collapsed until the
  // user opens it, matching Codex's quiet default.
  const [expanded, setExpanded] = useState(false);
  const hasDetails = Object.keys(block.input).length > 0 || Boolean(block.result);
  const stats = patchStats(block);

  return (
    <div
      className={`codex-tool-row${isCommandInvocation(block) ? " is-command" : ""}${isPresentationFailure(block) ? " is-error" : ""}${block.status === "running" ? " is-running" : ""}`}
      data-tool-id={block.toolCallId}
    >
      <button
        type="button"
        className="codex-tool-row-trigger"
        onClick={() => hasDetails && setExpanded((value) => !value)}
        aria-expanded={hasDetails ? expanded : undefined}
      >
        <span className="codex-tool-icon" aria-hidden="true">{iconFor(presentation.iconName)}</span>
        <span className="codex-tool-row-label" title={presentation.target ?? presentation.detail}>
          {presentation.detail}
        </span>
        {stats && (stats.additions > 0 || stats.deletions > 0) && (
          <span className="codex-tool-diff" aria-label={t("desktop.codexProcessDiffStats", { additions: stats.additions, deletions: stats.deletions })}>
            <span className="is-added">+{stats.additions}</span>
            <span className="is-removed">-{stats.deletions}</span>
          </span>
        )}
        {block.duration !== undefined && presentation.tone !== "command_execution" && (
          <span className="codex-tool-duration">{t("desktop.codexProcessToolDuration", { duration: block.duration })}</span>
        )}
        {hasDetails && (
          <CaretRightIcon className={`codex-tool-caret${expanded ? " is-expanded" : ""}`} size={13} aria-hidden="true" />
        )}
      </button>
      <DisclosureCollapse open={expanded && hasDetails} className="codex-tool-row-collapse">
        <CodexToolDetails block={block} />
      </DisclosureCollapse>
    </div>
  );
}

function CodexToolGroup({ blocks, entries, cwd, onOpenFile, isStreaming }: {
  blocks: ToolBlock[];
  entries: SequenceBlock[];
  cwd?: string | undefined;
  onOpenFile?: ((filePath: string) => void) | undefined;
  isStreaming: boolean;
}) {
  const { locale, t } = useI18n();
  const presentations = useMemo(() => blocks.map((block) => classifyPresentation(block, t)), [blocks, t]);
  const groupImages = useMemo(() => imageOnlyGroup(entries), [entries]);
  const hasRunning = blocks.some((block) => block.status === "running");
  // Groups never auto-expand either: a running group signals itself through
  // the subtle `is-running` highlight instead of blowing open its rows.
  const [expanded, setExpanded] = useState(false);
  const actionSummary = summarizeGroupActions(blocks, presentations, locale, t);
  const hasFailure = blocks.some(isPresentationFailure);

  const headerIcon = groupImages
    ? "image"
    : presentations.find((item) => item.iconName === "warning")?.iconName ?? presentations[0]?.iconName ?? "toolbox";
  const groupLabel = groupImages
    ? t(
        groupImages.length === 1 ? "desktop.codexProcessToolViewedImage" : "desktop.codexProcessToolViewedImages",
        { count: groupImages.length },
      )
    : actionSummary;

  return (
    <section
      className={`codex-tool-group${groupImages ? " is-image-group" : ""}${blocks.length === 1 && isCommandInvocation(blocks[0]!) ? " is-command-group" : ""}${hasFailure ? " is-error" : ""}${hasRunning ? " is-running" : ""}`}
      data-tool-count={blocks.length}
      {...(groupImages ? { "data-image-count": groupImages.length } : {})}
    >
      <button
        type="button"
        className="codex-tool-group-trigger"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <span className="codex-tool-icon" aria-hidden="true">{iconFor(headerIcon)}</span>
        <span className="codex-tool-group-label">{groupLabel}</span>
        <CaretRightIcon className={`codex-tool-caret${expanded ? " is-expanded" : ""}`} size={13} aria-hidden="true" />
      </button>
      <DisclosureCollapse open={expanded} className="codex-tool-group-collapse">
        <div className="codex-tool-group-scroll" tabIndex={0} aria-label={groupLabel}>
          {groupImages ? (
            <div className="codex-image-strip">
              {groupImages.map((image) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={image.key} src={image.src} alt="" loading="lazy" decoding="async" />
              ))}
            </div>
          ) : (
            <div className="codex-tool-group-items">
              {entries.map((entry) => {
                if (entry.type === "toolCall") {
                  return (
                    <CodexToolRow
                      key={entry.id}
                      block={entry}
                    />
                  );
                }
                if (entry.type === "custom") {
                  return <CodexCustomGroup key={entry.id} block={entry} cwd={cwd} onOpenFile={onOpenFile} isStreaming={isStreaming} />;
                }
                const src = imageSource(entry.source);
                return src ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={entry.id} src={src} alt="" className="codex-process-image" loading="lazy" decoding="async" />
                ) : null;
              })}
            </div>
          )}
        </div>
      </DisclosureCollapse>
    </section>
  );
}

function thinkingTitle(thinking: string): string | undefined {
  const paragraphs = thinking
    .split(/\n+/)
    .map((part) => part.replace(/^\s*(?:[-*#>]|\d+[.)])\s*/, "").trim())
    .filter(Boolean);
  const paragraph = paragraphs[paragraphs.length - 1];
  return paragraph ? concise(paragraph, 110) : undefined;
}

function CodexThinkingStatus({ block }: { block: ThinkingBlock }) {
  const title = thinkingTitle(block.thinking);
  if (!title) return null;
  return (
    <div className="codex-thinking-status" role="status" aria-live="polite">
      <span className="codex-thinking-status-label">{title}</span>
      <CaretRightIcon className="codex-thinking-status-caret" size={13} aria-hidden="true" />
    </div>
  );
}

function customText(block: Extract<ProcessContentBlock, { type: "custom" }>): string {
  const content = block.message.content;
  if (typeof content === "string") return content;
  return content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

function customImages(block: Extract<ProcessContentBlock, { type: "custom" }>): ImageContent[] {
  const content = block.message.content;
  if (typeof content === "string") return [];
  return content.filter((part): part is ImageContent => part.type === "image");
}

function customGroupLabel(customType: string, t: Translate): string {
  const normalized = customType.toLowerCase().replace(/[_-]+/g, " ");
  return normalized.includes("subagent") && normalized.includes("notification")
    ? t("desktop.codexProcessAgentResult")
    : t("desktop.codexProcessEventUpdate");
}

function CodexCustomGroup({ block, cwd, onOpenFile, isStreaming }: {
  block: Extract<ProcessContentBlock, { type: "custom" }>;
  cwd?: string | undefined;
  onOpenFile?: ((filePath: string) => void) | undefined;
  isStreaming: boolean;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const text = customText(block);
  const images = customImages(block);

  return (
    <section className="codex-custom-group">
      <button type="button" className="codex-tool-group-trigger" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
        <span className="codex-tool-icon" aria-hidden="true">{iconFor("listBullets")}</span>
        <span className="codex-tool-group-label" title={block.customType}>{customGroupLabel(block.customType, t)}</span>
        <CaretRightIcon className={`codex-tool-caret${expanded ? " is-expanded" : ""}`} size={13} aria-hidden="true" />
      </button>
      <DisclosureCollapse open={expanded} className="codex-custom-group-collapse">
        <div className="codex-custom-content codex-tool-group-scroll" tabIndex={0} aria-label={customGroupLabel(block.customType, t)}>
          {text && <MarkdownBody cwd={cwd} onOpenFile={onOpenFile} isStreaming={isStreaming}>{text}</MarkdownBody>}
          {images.map((image, index) => {
            const src = imageSource(image.source);
            return src ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={index} src={src} alt="" loading="lazy" decoding="async" />
            ) : null;
          })}
        </div>
      </DisclosureCollapse>
    </section>
  );
}

export function CodexProcessContent({ blocks, cwd, onOpenFile, isStreaming, isAnswerStreaming }: CodexProcessContentProps) {
  const items = useMemo(
    () => buildCodexFlowItems(blocks, isStreaming, isAnswerStreaming),
    [blocks, isAnswerStreaming, isStreaming],
  );

  return (
    <div className="codex-process-flow">
      {items.map((item) => {
        if (item.kind === "tools") {
          // A lone tool is never grouped: it renders as one expandable row.
          // Only runs of 2+ adjacent tools (possibly mixed with custom/image
          // entries) collapse into a CodexToolGroup.
          if (item.blocks.length === 1 && item.entries.length === 1) {
            return <CodexToolRow key={item.id} block={item.blocks[0]!} />;
          }
          return (
            <CodexToolGroup
              key={item.id}
              blocks={item.blocks}
              entries={item.entries}
              cwd={cwd}
              onOpenFile={onOpenFile}
              isStreaming={isStreaming}
            />
          );
        }
        if (item.kind === "custom") {
          return <CodexCustomGroup key={item.id} block={item.block} cwd={cwd} onOpenFile={onOpenFile} isStreaming={isStreaming} />;
        }
        if (item.kind === "image") {
          const src = imageSource(item.block.source);
          return src ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={item.id} src={src} alt="" className="codex-process-image" loading="lazy" decoding="async" />
          ) : null;
        }
        if (item.kind === "thinkingStatus") return <CodexThinkingStatus key={item.id} block={item.block} />;
        return (
          <MarkdownBody key={item.id} cwd={cwd} onOpenFile={onOpenFile} isStreaming={isStreaming}>
            {item.block.text}
          </MarkdownBody>
        );
      })}
    </div>
  );
}
