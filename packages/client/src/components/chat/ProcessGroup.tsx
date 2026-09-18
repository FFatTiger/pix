
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MarkdownBody } from "./MarkdownBody";
import { MessageView, ThinkingBlock, ToolCallBlock } from "./MessageView";
import { CodexProcessContent } from "./CodexProcessContent";
import { useDisclosurePresence } from "./DisclosureCollapse";
import { useI18n } from "@/hooks/useI18n";
import { useProcessDisplayMode } from "./useProcessDisplayMode";
import type { ProcessContentBlock } from "@/lib/process-content";
import type { ThinkingContent, ToolCallContent } from "@/lib/chat-view-model";
import type { DeferredThinkingLoader } from "@/lib/chat-view-model";
import type { StepTone } from "@/lib/step-categorizer";
import {
  classifyToolTone,
  classifyDocumentChangeKind,
  classifyShellCommand,
  extractToolTarget,
  basenameResourcePath,
} from "@/lib/step-categorizer";
import type { StepIconName } from "@/lib/step-visuals";
import { ChatTeardropDotsIcon } from "@phosphor-icons/react/ChatTeardropDots";
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
import { getFileIcon } from "./FileIcons";
import { cssPx } from "@/lib/ui-scale";

interface ProcessGroupProps {
  blocks: ProcessContentBlock[];
  isStreaming: boolean;
  startedAt?: number;
  completedAt?: number;
  isAnswerStreaming?: boolean;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
  sessionId?: string;
  /** pix adapter: injected deferred-thinking loader (host session-entry API). */
  loadDeferredThinking?: DeferredThinkingLoader | undefined;
}

type Step =
  | { kind: "thinking"; id: string; label: string; blocks: Array<Extract<ProcessContentBlock, { type: "thinking" | "text" }>> }
  | { kind: "tool"; id: string; label: string; block: Extract<ProcessContentBlock, { type: "toolCall" }>; leadBlocks: Array<Extract<ProcessContentBlock, { type: "thinking" | "text" }>> }
  | { kind: "toolGroup"; id: string; label: string; blocks: Array<Extract<ProcessContentBlock, { type: "toolCall" }>>; leadBlocks: Array<Array<Extract<ProcessContentBlock, { type: "thinking" | "text" }>>>; iconName: StepIconName; tone: StepTone; typeLabel: string; targetLabels: string[]; targets: string[] }
  | { kind: "custom"; id: string; label: string; block: Extract<ProcessContentBlock, { type: "custom" }> }
  | { kind: "image"; id: string; label: string; block: Extract<ProcessContentBlock, { type: "image" }> };

// ---------------------------------------------------------------------------
// Step labels (with tone enrichment)
// ---------------------------------------------------------------------------

function toolFallbackLabel(block: Extract<ProcessContentBlock, { type: "toolCall" }>): string {
  const label = block.input.label;
  return typeof label === "string" && label.trim() ? label : block.toolName;
}

type BuildLabelFn = (key: string) => string;

function enrichedToolLabel(
  block: Extract<ProcessContentBlock, { type: "toolCall" }>,
  ts: BuildLabelFn,
): { displayLabel: string; iconName: StepIconName; target?: string | undefined; tone?: StepTone | undefined; typeLabel?: string | undefined } {
  const fallback = toolFallbackLabel(block);
  const isError = block.status === "error";

  if (isError) {
    return { displayLabel: fallback, iconName: "warning", tone: undefined };
  }

  const tone = classifyToolTone({
    toolName: block.toolName,
    label: typeof block.input.label === "string" ? block.input.label : undefined,
    args: block.input,
    result: typeof block.result === "string" ? block.result : undefined,
  });

  let iconName: StepIconName = "toolbox";

  if (tone === "document_change") {
    const kind = classifyDocumentChangeKind({
      toolName: block.toolName,
      label: typeof block.input.label === "string" ? block.input.label : undefined,
      args: block.input,
      result: typeof block.result === "string" ? block.result : undefined,
    });
    if (kind === "create") iconName = "filePlus";
    else if (kind === "delete") iconName = "trash";
    else iconName = "pencilSimpleLine";

    const typeKey =
      kind === "create" ? "desktop.processStepFileCreate" :
      kind === "delete" ? "desktop.processStepFileDelete" :
      "desktop.processStepFileEdit";
    const typeLabel = ts(typeKey);

    const target = extractToolTarget({
      toolName: block.toolName,
      label: typeof block.input.label === "string" ? block.input.label : undefined,
      args: block.input,
      result: typeof block.result === "string" ? block.result : undefined,
    });

    if (target) {
      return { displayLabel: `${typeLabel} ${basenameResourcePath(target)}`, iconName, target, tone, typeLabel };
    }
    return { displayLabel: `${typeLabel}: ${fallback}`.slice(0, 100), iconName, tone, typeLabel };
  }

  if (tone === "document_read") {
    iconName = "bookOpen";
    const typeLabel = ts("desktop.processStepFileRead");
    const target = extractToolTarget({
      toolName: block.toolName,
      label: typeof block.input.label === "string" ? block.input.label : undefined,
      args: block.input,
      result: typeof block.result === "string" ? block.result : undefined,
    });
    if (target) {
      return { displayLabel: `${typeLabel} ${basenameResourcePath(target)}`, iconName, target, tone, typeLabel };
    }
    return { displayLabel: fallback, iconName, tone, typeLabel };
  }

  if (tone === "document_search") {
    iconName = "magnifyingGlass";
    const typeLabel = ts("desktop.processStepSearch");
    const pattern =
      typeof block.input.pattern === "string" ? block.input.pattern :
      typeof block.input.query === "string" ? block.input.query :
      "";
    if (pattern) {
      return { displayLabel: `${typeLabel} "${pattern.slice(0, 60)}"`, iconName, tone, typeLabel };
    }
    return { displayLabel: fallback, iconName, tone, typeLabel };
  }

  if (tone === "directory_list") {
    iconName = "folder";
    const typeLabel = ts("desktop.processStepList");
    const target = extractToolTarget({
      toolName: block.toolName,
      label: typeof block.input.label === "string" ? block.input.label : undefined,
      args: block.input,
      result: typeof block.result === "string" ? block.result : undefined,
    });
    if (target) {
      return { displayLabel: `${typeLabel} ${basenameResourcePath(target)}`, iconName, target, tone, typeLabel };
    }
    return { displayLabel: fallback, iconName, tone, typeLabel };
  }

  if (tone === "file_find") {
    iconName = "magnifyingGlass";
    const typeLabel = ts("desktop.processStepFind");
    const pattern =
      typeof block.input.pattern === "string" ? block.input.pattern :
      typeof block.input.glob === "string" ? block.input.glob :
      "";
    if (pattern) {
      return { displayLabel: `${typeLabel} "${pattern.slice(0, 60)}"`, iconName, tone, typeLabel };
    }
    return { displayLabel: fallback, iconName, tone, typeLabel };
  }

  if (tone === "command_execution") {
    const command = typeof block.input.command === "string"
      ? block.input.command
      : typeof block.input.cmd === "string"
        ? block.input.cmd
        : "";
    if (command) {
      const shell = classifyShellCommand(command);
      if (shell.kind === "list") {
        iconName = "folder";
        const typeLabel = ts("desktop.processStepList");
        const target = shell.argument ? ` ${shell.argument}` : "";
        return { displayLabel: `${typeLabel}${target}`, iconName, tone, typeLabel };
      }
      if (shell.kind === "search") {
        iconName = "magnifyingGlass";
        const typeLabel = ts("desktop.processStepSearch");
        const query = shell.argument ? ` "${shell.argument.slice(0, 60)}"` : "";
        return { displayLabel: `${typeLabel}${query}`, iconName, tone, typeLabel };
      }
      if (shell.kind === "find") {
        iconName = "magnifyingGlass";
        const typeLabel = ts("desktop.processStepFind");
        const query = shell.argument ? ` "${shell.argument.slice(0, 60)}"` : "";
        return { displayLabel: `${typeLabel}${query}`, iconName, tone, typeLabel };
      }
      if (shell.kind === "read") {
        iconName = "bookOpen";
        const typeLabel = ts("desktop.processStepRead");
        const target = shell.argument ? ` ${shell.argument}` : "";
        return { displayLabel: `${typeLabel}${target}`, iconName, tone, typeLabel, target: shell.argument || undefined };
      }
      if (shell.kind === "fetch") {
        iconName = "download";
        const typeLabel = ts("desktop.processStepFetch");
        const preview = shell.argument ? ` ${shell.argument.slice(0, 80)}` : "";
        return { displayLabel: `${typeLabel}${preview}`, iconName, tone, typeLabel };
      }
      if (shell.kind === "delete") {
        iconName = "trash";
        const typeLabel = ts("desktop.processStepDelete");
        const target = shell.argument ? ` ${shell.argument}` : "";
        return { displayLabel: `${typeLabel}${target}`, iconName, tone, typeLabel };
      }
      if (shell.kind === "copy") {
        iconName = "copy";
        const typeLabel = ts("desktop.processStepCopy");
        const target = shell.argument ? ` ${shell.argument}` : "";
        return { displayLabel: `${typeLabel}${target}`, iconName, tone, typeLabel };
      }
      // "run" fallback — use shell.binary + first non-flag argument instead of raw command
      iconName = "terminal";
      const typeLabel = ts("desktop.processStepCommand");
      const preview = shell.argument
        ? `${shell.binary} ${shell.argument.length > 60 ? shell.argument.slice(0, 57) + "..." : shell.argument}`
        : shell.binary;
      return { displayLabel: `${typeLabel} ${preview}`, iconName, tone, typeLabel };
    }
    iconName = "terminal";
    return { displayLabel: fallback, iconName, tone };
  }

  if (tone === "todo_update") {
    iconName = "checklist";
    const typeLabel = ts("desktop.processStepTodo");
    return { displayLabel: fallback, iconName, tone, typeLabel };
  }

  return { displayLabel: fallback, iconName, tone };
}

// ---------------------------------------------------------------------------
// Build steps from blocks
// ---------------------------------------------------------------------------

export function buildProcessSteps(
  blocks: ProcessContentBlock[],
  ts: BuildLabelFn,
  isStreaming = false,
): Step[] {
  const steps: Step[] = [];
  let pending: Array<Extract<ProcessContentBlock, { type: "thinking" | "text" }>> = [];

  const flushPending = () => {
    if (pending.length === 0) return;
    steps.push({
      kind: "thinking",
      id: pending.map((block) => block.id).join("+"),
      label: ts("desktop.processStepThinking"),
      blocks: pending,
    });
    pending = [];
  };

  for (const block of blocks) {
    if (block.type === "thinking" || block.type === "text") {
      pending.push(block);
      continue;
    }
    if (block.type === "toolCall") {
      // A thought that precedes a tool is its own observable agent step, not
      // invisible supporting content inside the tool's collapsed body. The
      // former grouping made a tool-heavy turn appear to have zero/one thought
      // even though session history held many separate thinking blocks. Keep
      // chronological reasoning visible in both timeline and tabs modes.
      flushPending();
      const { displayLabel } = enrichedToolLabel(block, ts);
      steps.push({
        kind: "tool",
        id: block.id,
        label: displayLabel,
        block,
        leadBlocks: [],
      });
      continue;
    }

    flushPending();
    if (block.type === "custom") {
      steps.push({ kind: "custom", id: block.id, label: formatCustomLabel(block.customType), block });
    } else if (block.type === "image") {
      steps.push({ kind: "image", id: block.id, label: ts("desktop.processOutput"), block });
    }
  }

  flushPending();
  try {
    return mergeConsecutiveToolSteps(steps, ts, isStreaming);
  } catch (e) {
    console.error("[ProcessGroup] mergeConsecutiveToolSteps crashed:", e);
    return steps;
  }
}

// ---------------------------------------------------------------------------
// Merge consecutive same-tone tool steps
// ---------------------------------------------------------------------------

function mergeConsecutiveToolSteps(
  steps: Step[],
  ts: BuildLabelFn,
  isStreaming: boolean,
): Step[] {
  if (steps.length < 2) return steps;

  const result: Step[] = [];
  let i = 0;

  while (i < steps.length) {
    const step = steps[i]!;
    if (step.kind !== "tool") {
      result.push(step);
      i++;
      continue;
    }

    // Error steps are never merged — push directly
    const toolStep = step as Extract<Step, { kind: "tool" }>;
    if (toolStep.block.status === "error") {
      result.push(step);
      i++;
      continue;
    }

    // Determine the tone of the current step
    const currentEnriched = enrichedToolLabel(toolStep.block, ts);
    const currentTone = currentEnriched.tone;

    // No defined tone — can't merge, push directly
    if (!currentTone) {
      result.push(step);
      i++;
      continue;
    }

    // Collect consecutive non-error tool steps with the SAME tone.
    let j = i + 1;
    while (j < steps.length && steps[j]!.kind === "tool") {
      const nextStep = steps[j]! as Extract<Step, { kind: "tool" }>;
      if (nextStep.block.status === "error") break;
      const nextEnriched = enrichedToolLabel(nextStep.block, ts);
      if (nextEnriched.tone !== currentTone) break;
      j++;
    }

    // Don't merge the last step while streaming (keep it visible as progress)
    if (isStreaming && j === steps.length && j > i + 1) {
      j--;
    }

    const groupSize = j - i;
    if (groupSize < 2) {
      result.push(step);
      i++;
      continue;
    }

    const group = steps.slice(i, j) as Array<Extract<Step, { kind: "tool" }>>;

    // All steps in the group share the same tone (guaranteed by the while loop)
    const enriched = group.map((s) => enrichedToolLabel(s.block, ts));

    // Build merged step
    const iconName = enriched[0]!.iconName;
    const typeLabel = enriched[0]!.typeLabel || "";
    const blocks = group.map((s) => s.block);
    const targetLabels = enriched.map((e) => e.displayLabel);

    // Collect raw file targets and deduplicate display names
    const rawTargets = enriched.map((e) => e.target || "");
    const shortTargetsAll = enriched.map((e) => {
      if (e.target) return basenameResourcePath(e.target);
      const dl = e.displayLabel;
      if (e.typeLabel && dl.startsWith(e.typeLabel + " ")) {
        return dl.slice(e.typeLabel.length + 1);
      }
      return dl;
    });

    // Deduplicate targets (preserve order, skip repeats)
    const seenTargets = new Set<string>();
    const seenPaths = new Set<string>();
    const shortTargets: string[] = [];
    const targets: string[] = [];
    for (let k = 0; k < shortTargetsAll.length; k++) {
      const st = shortTargetsAll[k]!;
      if (!seenTargets.has(st)) {
        seenTargets.add(st);
        shortTargets.push(st);
      }
      const p = rawTargets[k]!;
      if (p && !seenPaths.has(p)) {
        seenPaths.add(p);
        targets.push(p);
      }
    }

    const count = group.length;
    let label: string;
    if (count === 2 && shortTargets.length === 2) {
      label = `${typeLabel} ${shortTargets[0]}, ${shortTargets[1]}`;
    } else if (shortTargets.length === 1) {
      // All operations on the same target
      label = count === 1 ? `${typeLabel} ${shortTargets[0]}` : `${typeLabel} ${shortTargets[0]} ×${count}`;
    } else if (shortTargets.length === 2) {
      // 2 unique targets but possibly more than 2 operations (some repeated)
      label = `${typeLabel} ${shortTargets[0]}, ${shortTargets[1]}`;
    } else {
      label = `${typeLabel} ${shortTargets[0]} +${shortTargets.length - 1}`;
    }

    result.push({
      kind: "toolGroup",
      id: blocks.map((b) => b.id).join("+"),
      label,
      blocks,
      leadBlocks: group.map((s) => s.leadBlocks),
      iconName,
      tone: currentTone,
      typeLabel,
      targetLabels,
      targets,
    });

    i = j;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

type SummaryT = (key: string, params?: Record<string, string | number>) => string;

export function formatProcessDuration(t: SummaryT, durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(t("desktop.processDurationHours", { hours }));
  if (hours > 0 || minutes > 0) parts.push(t("desktop.processDurationMinutes", { minutes }));
  parts.push(t("desktop.processDurationSeconds", { seconds }));
  return parts.join(" ");
}

/** Shared outer title for every process display mode. */
export function computeProcessSummary(
  t: SummaryT,
  opts: {
    isStreaming: boolean;
    durationMs: number | undefined;
  },
): string {
  if (opts.durationMs === undefined) return t("desktop.processDurationUnknown");
  const duration = formatProcessDuration(t, opts.durationMs);
  return opts.isStreaming
    ? t("desktop.processElapsed", { duration })
    : t("desktop.processDuration", { duration });
}

function useProcessDurationMs(
  isStreaming: boolean,
  startedAt: number | undefined,
  completedAt: number | undefined,
): number | undefined {
  const mountedAtRef = useRef(Date.now());
  const [clock, setClock] = useState(() => (
    isStreaming ? Date.now() : (completedAt ?? startedAt ?? mountedAtRef.current)
  ));

  useEffect(() => {
    if (!isStreaming) {
      setClock(completedAt ?? Date.now());
      return;
    }
    const update = () => setClock(Date.now());
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [completedAt, isStreaming]);

  if (isStreaming) return Math.max(0, clock - (startedAt ?? mountedAtRef.current));
  if (startedAt === undefined || completedAt === undefined) return undefined;
  return Math.max(0, completedAt - startedAt);
}

function formatCustomLabel(customType: string): string {
  return customType
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function Caret() {
  return <CaretRightIcon size={12} className="shrink-0" />;
}

function stepIconElement(iconName: StepIconName, size: number = 14) {
  switch (iconName) {
    case "brain": return <ChatTeardropDotsIcon size={size} />;
    case "bookOpen": return <BookOpenIcon size={size} />;
    case "magnifyingGlass": return <MagnifyingGlassIcon size={size} />;
    case "pencilSimpleLine": return <PencilSimpleLineIcon size={size} />;
    case "filePlus": return <FilePlusIcon size={size} />;
    case "trash": return <TrashIcon size={size} />;
    case "folder": return <FolderIcon size={size} />;
    case "download": return <DownloadSimpleIcon size={size} />;
    case "copy": return <CopySimpleIcon size={size} />;
    case "terminal": return <TerminalIcon size={size} />;
    case "toolbox": return <ToolboxIcon size={size} />;
    case "image": return <ImageIcon size={size} />;
    case "listBullets": return <ListBulletsIcon size={size} />;
    case "checklist": return <ListBulletsIcon size={size} />;
    case "warning":
    case "circleX": return <WarningCircleIcon size={size} />;
    default: return <ToolboxIcon size={size} />;
  }
}

function StepIcon({ step, ts }: { step: Step; ts: BuildLabelFn }) {
  if (step.kind === "thinking") return stepIconElement("brain");
  if (step.kind === "image") return stepIconElement("image");
  if (step.kind === "custom") return stepIconElement("listBullets");
  if (step.kind === "toolGroup") return stepIconElement(step.iconName);

  const { iconName } = enrichedToolLabel(step.block, ts);
  return stepIconElement(iconName);
}

/** Render file-type icons and label for merged steps with file targets. */
function MergedFileTargets({ targets, typeLabel, count, label }: {
  targets: string[];
  typeLabel: string;
  count: number;
  label: string;
}) {
  if (targets.length === 0) {
    return <span className="max-w-52 truncate" title={label}>{label}</span>;
  }

  // 2 unique files: show both as normal file tags
  if (targets.length === 2) {
    return (
      <>
        <span className="shrink-0">{typeLabel}</span>
        <ProcessFileTag filePath={targets[0]!} />
        <ProcessFileTag filePath={targets[1]!} />
      </>
    );
  }

  // 3+ files: first file uses a normal ProcessFileTag (matching non-merged
  // style).  Additional distinct file-type icons are shown only for extensions
  // that differ from the first target (up to 2 extra, so 3 icons total).
  const firstExt = targets[0]!.split(".").pop()?.toLowerCase() || "";
  const extraIcons: Array<{ key: string; node: ReactNode }> = [];
  const seenExt = new Set<string>([firstExt]);
  for (let k = 1; k < targets.length && extraIcons.length < 2; k++) {
    const ext = targets[k]!.split(".").pop()?.toLowerCase() || "";
    if (!seenExt.has(ext)) {
      seenExt.add(ext);
      extraIcons.push({ key: targets[k]!, node: getFileIcon(targets[k]!, 12) });
    }
  }

  return (
    <>
      <span className="shrink-0">{typeLabel}</span>
      {extraIcons.length > 0 && (
        <span className="shrink-0 inline-flex gap-px">
          {extraIcons.map((d) => (
            <span key={d.key} className="inline-flex">{d.node}</span>
          ))}
        </span>
      )}
      <ProcessFileTag filePath={targets[0]!} />
      <span className="shrink-0 text-[10px] tabular-nums text-text-dim">+{count - 1}</span>
    </>
  );
}

function ProcessFileTag({ filePath }: { filePath: string }) {
  const basename = filePath.split(/[\\/]/).filter(Boolean).pop() || filePath;
  return (
    <span className="process-file-tag" title={filePath}>
      {getFileIcon(filePath, 12)}
      <span>{basename}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Step content rendering
// ---------------------------------------------------------------------------

function imageSource(block: Extract<ProcessContentBlock, { type: "image" }>): string | undefined {
  const source = block.source;
  if (source.type === "url") return source.url;
  if (!source.data) return undefined;
  return `data:${source.media_type ?? "image/png"};base64,${source.data}`;
}

function StepContent({ step, cwd, onOpenFile, sessionId, ts, isStreaming, loadThinking }: {
  step: Step;
  cwd?: string | undefined;
  onOpenFile?: ((filePath: string) => void) | undefined;
  sessionId?: string | undefined;
  ts: BuildLabelFn;
  isStreaming: boolean;
  loadThinking?: DeferredThinkingLoader | undefined;
}) {
  if (step.kind === "thinking") {
    return <ProcessNarrative blocks={step.blocks} cwd={cwd} onOpenFile={onOpenFile} sessionId={sessionId} isStreaming={isStreaming} loadThinking={loadThinking} />;
  }
  if (step.kind === "tool") {
    return (
      <div className="space-y-2">
        {step.leadBlocks.length > 0 && (
          <ProcessNarrative blocks={step.leadBlocks} cwd={cwd} onOpenFile={onOpenFile} sessionId={sessionId} isStreaming={isStreaming} loadThinking={loadThinking} />
        )}
        <ToolCallBlock
          block={{
            type: "toolCall",
            toolCallId: step.block.toolCallId,
            toolName: step.block.toolName,
            input: step.block.input,
          } as ToolCallContent}
          result={step.block.result}
          duration={step.block.duration}
          processStyle
        />
      </div>
    );
  }
  if (step.kind === "toolGroup") {
    return (
      <div className="space-y-2">
        {step.blocks.map((block, idx) => (
          <div key={block.id}>
            {step.leadBlocks[idx] && step.leadBlocks[idx].length > 0 && (
              <div className="mb-2">
                <ProcessNarrative blocks={step.leadBlocks[idx]} cwd={cwd} onOpenFile={onOpenFile} sessionId={sessionId} isStreaming={isStreaming} loadThinking={loadThinking} />
              </div>
            )}
            <ToolCallBlock
              block={{
                type: "toolCall",
                toolCallId: block.toolCallId,
                toolName: block.toolName,
                input: block.input,
              } as ToolCallContent}
              result={block.result}
              duration={block.duration}
              processStyle
            />
          </div>
        ))}
      </div>
    );
  }
  if (step.kind === "custom") {
    return <MessageView message={step.block.message} cwd={cwd} onOpenFile={onOpenFile} isStreaming={isStreaming} />;
  }

  const src = imageSource(step.block);
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={ts("desktop.processOutput")} className="max-h-72 max-w-full rounded border border-border object-contain" />
  ) : null;
}

function ProcessNarrative({ blocks, cwd, onOpenFile, sessionId, isStreaming, loadThinking }: {
  blocks: Array<Extract<ProcessContentBlock, { type: "thinking" | "text" }>>;
  cwd?: string | undefined;
  onOpenFile?: ((filePath: string) => void) | undefined;
  sessionId?: string | undefined;
  isStreaming: boolean;
  loadThinking?: DeferredThinkingLoader | undefined;
}) {
  return (
    <div className="space-y-2 pr-2">
      {blocks.map((block) =>
        block.type === "text" ? (
          <MarkdownBody key={block.id} cwd={cwd} onOpenFile={onOpenFile} className="!text-text-muted" isStreaming={isStreaming}>
            {block.text}
          </MarkdownBody>
        ) : (
          <ThinkingBlock
            key={block.id}
            block={{ type: "thinking", thinking: block.thinking, deferred: block.deferred } as ThinkingContent}
            sessionId={sessionId}
            entryId={block.origin.sourceEntryId}
            blockIndex={block.origin.sourceBlockIndex ?? 0}
            contentOnly
            cwd={cwd}
            onOpenFile={onOpenFile}
            className="!text-text-muted"
            isStreaming={isStreaming}
            loadThinking={loadThinking}
          />
        ),
      )}
    </div>
  );
}

function stepHasContent(step: Step): boolean {
  if (step.kind === "thinking") {
    return step.blocks.some((b) =>
      b.type === "text" ? b.text.trim().length > 0 : b.deferred || b.thinking.trim().length > 0,
    );
  }
  if (step.kind === "toolGroup") return step.blocks.length > 0;
  return true;
}

// ---------------------------------------------------------------------------
// ProcessGroup
// ---------------------------------------------------------------------------

export function ProcessGroup({
  blocks,
  isStreaming,
  startedAt,
  completedAt,
  isAnswerStreaming = false,
  cwd,
  onOpenFile,
  sessionId,
  loadDeferredThinking,
}: ProcessGroupProps) {
  const { t } = useI18n();
  const ts: BuildLabelFn = useCallback((key: string) => t(key as Parameters<typeof t>[0]), [t]);
  const { displayMode } = useProcessDisplayMode();
  const steps = useMemo(
    () => displayMode === "codex" ? [] : buildProcessSteps(blocks, ts, isStreaming),
    [blocks, displayMode, ts, isStreaming],
  );
  const [areaExpanded, setAreaExpanded] = useState(isStreaming);
  const [stepStates, setStepStates] = useState<Record<string, boolean>>({});
  const [activeTab, setActiveTab] = useState(0);
  const [showTopShadow, setShowTopShadow] = useState(false);
  const [showBottomShadow, setShowBottomShadow] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const wasStreamingRef = useRef(false);
  const hasUserSelectedTabRef = useRef(false);
  const userScrolledUpRef = useRef(false);
  const ignoreProgrammaticScrollUntilRef = useRef(0);
  // Capped step navigator (timeline list or tab list): only one is mounted at
  // a time, so a single ref tracks whichever navigator is currently rendered.
  const navScrollRef = useRef<HTMLDivElement | null>(null);
  const navUserScrolledUpRef = useRef(false);
  const activeTabRef = useRef<HTMLButtonElement | null>(null);
  const durationMs = useProcessDurationMs(isStreaming, startedAt, completedAt);
  const bodyPresence = useDisclosurePresence(areaExpanded);

  // Expanded groups may use up to half of the actual transcript viewport. The
  // max-height is measured from the scroller (not window/vh), converted once
  // from physical pixels under CSS zoom, and the content remains auto-sized
  // below that cap.
  useLayoutEffect(() => {
    const shell = shellRef.current;
    if (!shell || !bodyPresence.present || displayMode === "codex") {
      shell?.style.removeProperty("--process-group-max-height");
      return;
    }
    // Keep the measured cap through the 180ms exit transition. Closing stops
    // measurement work immediately, while presence owns the later cleanup.
    if (!areaExpanded) return;
    const viewport = shell.closest<HTMLElement>(".transcript-scroll");
    if (!viewport) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const viewportRect = viewport.getBoundingClientRect();
      const maxHeight = Math.max(64, Math.floor(cssPx(viewportRect.height) * 0.5));
      const value = `${maxHeight}px`;
      if (shell.style.getPropertyValue("--process-group-max-height") !== value) {
        shell.style.setProperty("--process-group-max-height", value);
      }
    };
    const schedule = () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    update();
    // Transcript anchoring runs in the parent layout effect. Re-measure after
    // two paint boundaries so the final anchored shell position wins, then
    // keep the height stable while the user scrolls (no scroll/row-height
    // feedback loop). Viewport/keyboard/panel resizes still update it.
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(update);
    });
    const observer = new ResizeObserver(schedule);
    observer.observe(viewport);
    window.addEventListener("resize", schedule);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [areaExpanded, bodyPresence.present, displayMode]);

  useEffect(() => {
    if (isStreaming) {
      wasStreamingRef.current = true;
      setAreaExpanded(true);
      return;
    }
    if (!wasStreamingRef.current) return;
    userScrolledUpRef.current = false;
    navUserScrolledUpRef.current = false;
    setStepStates({});
    const timer = window.setTimeout(() => setAreaExpanded(false), 300);
    wasStreamingRef.current = false;
    return () => window.clearTimeout(timer);
  }, [isStreaming]);

  useEffect(() => {
    if (steps.length === 0) return;
    const latest = steps[steps.length - 1]!;
    setActiveTab((currentTab) => {
      if (hasUserSelectedTabRef.current && currentTab < steps.length) return currentTab;
      return steps.length - 1;
    });
    if (isStreaming) {
      // `steps` is rebuilt from render-time block arrays, so its reference may
      // change even while the latest step is unchanged. Preserve the current
      // "only the latest step is open" behavior without scheduling a render
      // when that state is already in place.
      setStepStates((current) => {
        const isLatestOnlyOpen =
          current[latest.id] === true && Object.keys(current).length === 1;
        return isLatestOnlyOpen ? current : { [latest.id]: true };
      });
    }
  }, [isStreaming, steps]);

  const updateShadows = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    // Functional bail-outs: ResizeObserver/scroll fire at high frequency while
    // a step grows; committing the same shadow values would schedule a render
    // every time and nest into the streaming update batch.
    setShowTopShadow((prev) => {
      const next = element.scrollTop > 0;
      return prev === next ? prev : next;
    });
    setShowBottomShadow((prev) => {
      const next = element.scrollHeight - element.scrollTop - element.clientHeight > 1;
      return prev === next ? prev : next;
    });
  }, []);

  const handleProcessUserScroll = useCallback(() => {
    if (Date.now() < ignoreProgrammaticScrollUntilRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    userScrolledUpRef.current = distFromBottom > 4;
  }, []);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !areaExpanded || !bodyPresence.present) return;
    const observer = new ResizeObserver(updateShadows);
    element.addEventListener("scroll", updateShadows, { passive: true });
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    updateShadows();
    return () => {
      element.removeEventListener("scroll", updateShadows);
      observer.disconnect();
    };
  }, [activeTab, areaExpanded, bodyPresence.present, displayMode, isStreaming, stepStates, steps.length, updateShadows]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !areaExpanded || !bodyPresence.present) return;
    el.addEventListener("scroll", handleProcessUserScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleProcessUserScroll);
  }, [areaExpanded, bodyPresence.present, displayMode, handleProcessUserScroll]);

  useEffect(() => {
    if (!isStreaming || !scrollRef.current) return;
    if (userScrolledUpRef.current) return;
    ignoreProgrammaticScrollUntilRef.current = Date.now() + 100;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    updateShadows();
  }, [blocks, isStreaming, updateShadows]);

  // Capped step navigator (timeline list / tab list): detect manual upward
  // scrolling so streaming auto-follow pauses while the user reads earlier
  // steps. The pause is sticky until the mode changes or streaming ends.
  useEffect(() => {
    if (!isStreaming) return;
    const el = navScrollRef.current;
    if (!el) return;
    navUserScrolledUpRef.current = false;
    const onScroll = () => {
      if (Date.now() < ignoreProgrammaticScrollUntilRef.current) return;
      navUserScrolledUpRef.current =
        el.scrollHeight - el.scrollTop - el.clientHeight > 4;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [isStreaming, displayMode, areaExpanded]);

  // Capped step navigator: keep the growing step list pinned to the bottom
  // while streaming, unless the user has scrolled up. Independent of the
  // content-pane scroll handling below the navigator.
  useEffect(() => {
    if (!isStreaming) return;
    const el = navScrollRef.current;
    if (!el || navUserScrolledUpRef.current) return;
    ignoreProgrammaticScrollUntilRef.current = Date.now() + 100;
    el.scrollTop = el.scrollHeight;
  }, [steps, isStreaming, displayMode, areaExpanded]);

  // Tabs mode: keep the active tab visible inside the capped navigator when the
  // selection changes (including after the user picks an older step). Scoped to
  // the navigator only, so the outer page is never scrolled.
  useEffect(() => {
    if (displayMode !== "tabs") return;
    const nav = navScrollRef.current;
    const btn = activeTabRef.current;
    if (!nav || !btn) return;
    const navRect = nav.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    if (btnRect.top < navRect.top) nav.scrollTop += btnRect.top - navRect.top;
    else if (btnRect.bottom > navRect.bottom) nav.scrollTop += btnRect.bottom - navRect.bottom;
  }, [displayMode, activeTab]);

  if ((displayMode === "codex" ? blocks.length === 0 : steps.length === 0) && !isStreaming) return null;

  const singleThinking = displayMode !== "codex" && steps.length === 1 && steps[0]!.kind === "thinking" && !isStreaming;

  const summary = computeProcessSummary(t, {
    isStreaming,
    durationMs,
  });

  return (
    <div
      ref={shellRef}
      className={`group/process process-group-shell relative mb-3 min-w-0${displayMode === "codex" ? " process-group-shell--codex" : ""}${bodyPresence.present && displayMode !== "codex" ? " process-group-shell--expanded" : ""}`}
      data-expanded={areaExpanded ? "true" : "false"}
      data-display-mode={displayMode}
    >
      <div className="group/summary-row flex items-center">
        <button
          type="button"
          onClick={() => setAreaExpanded((v) => !v)}
          className="group/summary flex min-w-0 items-center gap-1.5 text-left leading-relaxed text-text-dim transition-colors hover:text-text-muted"
          aria-expanded={areaExpanded}
        >
          {isStreaming && <span aria-hidden="true" className="process-streaming-dot shrink-0" />}
          <span className="process-group-summary-label">{summary}</span>
          <span className={`process-group-caret${areaExpanded ? " is-expanded" : ""}`}>
            <Caret />
          </span>
        </button>
      </div>

      {bodyPresence.present && (
        <div
          className="disclosure-collapse process-group-collapse"
          data-state={bodyPresence.visuallyOpen ? "open" : "closed"}
          aria-hidden={!areaExpanded}
          inert={areaExpanded ? undefined : true}
        >
          <div className="disclosure-collapse-inner process-group-collapse-inner">
            <div className={`process-group-body${displayMode === "codex" ? " process-group-codex-body" : " overflow-hidden"}`}>
          {displayMode === "codex" ? (
            <CodexProcessContent
              blocks={blocks}
              cwd={cwd}
              onOpenFile={onOpenFile}
              isStreaming={isStreaming}
              isAnswerStreaming={isAnswerStreaming}
            />
          ) : singleThinking ? (
            <div className="process-group-pane relative">
              <div ref={scrollRef} className="h-full overflow-y-auto pr-2">
                <StepContent step={steps[0]!} cwd={cwd} onOpenFile={onOpenFile} sessionId={sessionId} ts={ts} isStreaming={isStreaming} loadThinking={loadDeferredThinking} />
              </div>
              {showTopShadow && <div aria-hidden="true" className="chat-fade chat-fade-top pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-gradient-to-b from-bg to-transparent" />}
              {showBottomShadow && <div aria-hidden="true" className="chat-fade chat-fade-bottom pointer-events-none absolute inset-x-0 bottom-0 z-10 h-6 bg-gradient-to-t from-bg to-transparent" />}
            </div>
          ) : displayMode === "timeline" ? (
            <div className="process-group-layout process-group-layout--timeline">
              <div className="relative h-full min-h-0">
                <div className="absolute left-2 -top-1.5 h-4 w-2 rounded-bl border-b border-l border-border" />
                <div ref={navScrollRef} className="process-step-nav process-step-nav--fill ml-5 h-full space-y-2">
                  {steps.map((step, index) => {
                  const open = stepStates[step.id] ?? false;
                  const hasContent = stepHasContent(step);
                  const isError =
                    (step.kind === "tool" && step.block.status === "error") ||
                    (step.kind === "toolGroup" && step.blocks.some(b => b.status === "error"));
                  const toolInfo = step.kind === "tool" ? enrichedToolLabel(step.block, ts) : null;
                  const hasFileTag = step.kind !== "toolGroup" && toolInfo?.target !== undefined && toolInfo?.typeLabel !== undefined;
                  return (
                    <div key={step.id} className="group/step relative min-w-0">
                        {index < steps.length - 1 && <span className="absolute bottom-[-9px] left-[7px] top-[22px] border-l border-border" />}
                        <button
                          type="button"
                          onClick={() => hasContent && setStepStates((state) => ({ ...state, [step.id]: !open }))}
                          className={`flex w-full min-w-0 items-center gap-1.5 text-left text-sm leading-relaxed transition-colors ${
                            hasContent ? "cursor-pointer" : "cursor-default"
                          } ${isError ? "text-red-400 hover:text-red-300" : "text-text-dim hover:text-text-muted"}`}
                        >
                          <span className="shrink-0"><StepIcon step={step} ts={ts} /></span>
                          {step.kind === "toolGroup" && step.targets.length > 0 ? (
                            <MergedFileTargets
                              targets={step.targets}
                              typeLabel={step.typeLabel}
                              count={step.blocks.length}
                              label={step.label}
                            />
                          ) : hasFileTag ? (
                            <>
                              <span className="shrink-0">{toolInfo!.typeLabel}</span>
                              <ProcessFileTag filePath={toolInfo!.target!} />
                            </>
                          ) : (
                            <span
                              className="truncate"
                              title={step.kind === "toolGroup" ? step.targetLabels.join("\n") : undefined}
                            >
                              {step.label}
                            </span>
                          )}
                          {step.kind === "tool" && step.block.duration !== undefined && (
                            <span className="shrink-0 text-[11px] tabular-nums text-text-dim">{step.block.duration}s</span>
                          )}
                          {isError && (
                            <span className="shrink-0 text-[11px] font-medium text-red-400">{t("desktop.processFailedStep")}</span>
                          )}
                          {hasContent && (
                            <span className={`ml-0.5 shrink-0 transition-opacity ${open ? "opacity-70 rotate-90" : "opacity-0 group-hover/step:opacity-70"}`}>
                              <Caret />
                            </span>
                          )}
                        </button>
                        {open && hasContent && (
                          <div className="ml-5 mt-1.5 overflow-x-hidden">
                            <StepContent step={step} cwd={cwd} onOpenFile={onOpenFile} sessionId={sessionId} ts={ts} isStreaming={isStreaming} loadThinking={loadDeferredThinking} />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          ) : (
            <div className="process-group-layout process-group-layout--tabs">
              <div ref={navScrollRef} className="process-step-nav flex flex-wrap gap-1">
                {steps.map((step, index) => {
                  const isError =
                    (step.kind === "tool" && step.block.status === "error") ||
                    (step.kind === "toolGroup" && step.blocks.some(b => b.status === "error"));
                  const toolInfo = step.kind === "tool" ? enrichedToolLabel(step.block, ts) : null;
                  const hasFileTag = step.kind !== "toolGroup" && toolInfo?.target !== undefined && toolInfo?.typeLabel !== undefined;
                  const isRunning = isStreaming && index === steps.length - 1;
                  const isActive = activeTab === index;
                  return (
                    <button
                      key={step.id}
                      ref={isActive ? activeTabRef : undefined}
                      type="button"
                      onClick={() => {
                        if (index === steps.length - 1 && isStreaming) {
                          hasUserSelectedTabRef.current = false;
                          userScrolledUpRef.current = false;
                          navUserScrolledUpRef.current = false;
                        } else {
                          hasUserSelectedTabRef.current = true;
                          navUserScrolledUpRef.current = true;
                        }
                        setActiveTab(index);
                      }}
                      data-has-file-target={hasFileTag ? "true" : undefined}
                      title={step.kind === "toolGroup" ? step.targetLabels.join("\n") : undefined}
                      className={`process-tab flex items-center gap-1 font-mono text-xs transition-colors ${
                        isActive
                          ? isError
                            ? "process-tab-error"
                            : "process-tab-active"
                          : "text-text-dim hover:text-text"
                      }${isRunning ? " process-tab-streaming" : ""}`}
                    >
                      <StepIcon step={step} ts={ts} />
                      {step.kind === "toolGroup" && step.targets.length > 0 ? (
                        <MergedFileTargets
                          targets={step.targets}
                          typeLabel={step.typeLabel}
                          count={step.blocks.length}
                          label={step.label}
                        />
                      ) : hasFileTag ? (
                        <>
                          <span className="shrink-0">{toolInfo!.typeLabel}</span>
                          <ProcessFileTag filePath={toolInfo!.target!} />
                        </>
                      ) : (
                        <span
                          className={`truncate ${step.kind === "toolGroup" ? "max-w-64" : "max-w-52"}`}
                          title={step.kind === "toolGroup" ? step.targetLabels.join("\n") : undefined}
                        >
                          {step.label}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              <div className="process-group-pane relative">
                <div ref={scrollRef} className="h-full overflow-y-auto pr-2">
                  {steps[activeTab] && <StepContent step={steps[activeTab]} cwd={cwd} onOpenFile={onOpenFile} sessionId={sessionId} ts={ts} isStreaming={isStreaming} loadThinking={loadDeferredThinking} />}
                </div>
                {showTopShadow && <div aria-hidden="true" className="chat-fade chat-fade-top pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-gradient-to-b from-bg to-transparent" />}
                {showBottomShadow && <div aria-hidden="true" className="chat-fade chat-fade-bottom pointer-events-none absolute inset-x-0 bottom-0 z-10 h-6 bg-gradient-to-t from-bg to-transparent" />}
              </div>
            </div>
            )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
