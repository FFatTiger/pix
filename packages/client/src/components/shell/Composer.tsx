import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import type { SlashCommandInfo, ThinkingLevel, ToolInfo } from "@fffattiger/pix-protocol";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import { useSessionTranscript } from "@/features/session-history/use-session-transcript";
import { useRuntime } from "@/runtime";
import { useHttpClient } from "@/app/http-context";
import { createQueryOptions } from "@/api/query-keys";
import { createConfigurationApi } from "@/api/configuration";
import { createResourcesApi } from "@/api/resources";
import { useI18n } from "@/hooks/useI18n";
import { ChatInput, type AttachedImage, type ChatInputHandle } from "@/components/chat/ChatInput";
import { SessionInfoBar } from "@/components/chat/SessionInfoBar";
import { chatInputHandle, transcriptScrollRef } from "@/components/chat/chat-experience-bridge";
import {
  buildSessionStatsView,
  buildStepLabel,
  toBranchNavigatorTree,
  toContextUsageView,
  toImageAttachments,
  toQueuedMessagesView,
} from "@/components/chat/chat-runtime-view";
import type { BuiltinSlashCommandResult, QueuedMessages as QueuedMessagesView } from "@/lib/chat-view-model";
import type { FileIndexEntry } from "@/lib/file-fuzzy";
import type { ThinkingLevelOption } from "@/lib/thinking-levels";
import type { SessionTreeNode } from "@/lib/chat-view-model";

/**
 * Composer — the exact ported ChatInput wired to the pix RuntimeApi.
 *
 * The source ChatWindow owned this wiring through its useAgentSession hook;
 * pix re-derives the same surface from the live SessionStore projection and
 * the Host catalog queries:
 *  - send / steer / follow-up / abort / bash / compact(+abort) via the typed
 *    RuntimeApi helpers, each capability-gated (runtime.* caps) so a control
 *    is only offered when the runtime honestly advertises it;
 *  - model picker from the Host models catalog (runtime.model.set + Host
 *    `models`), thinking level from the snapshot (runtime.thinking.set — the
 *    Protocol has no "auto" level, so "auto" stays a display-only option);
 *  - tools preset from runtime getTools/setTools (none/full are real; the
 *    Protocol exposes no default tool set, so "default" keeps the current
 *    selection — see handoff);
 *  - queued messages, draft (per-session key), input history, slash commands
 *    (runtime get_commands), @ file index + skills (Host catalogs) and the
 *    upload adapter (Host /v1/files upload), all injected through the
 *    component's pix adapter surface;
 *  - deferred-thinking / bash full-output loaders stay UNWIRED: the Host
 *    routes do not exist yet, so the source UI hides those affordances
 *    instead of fetching a route that is not there.
 *
 * A failed send/steer/follow-up restores the text into the composer (the
 * source kept the draft through its notice shelf; pix has none). When the
 * selected session is not live the composer degrades to an honestly disabled
 * surface — the exact ChatInput is only mounted when it can actually send.
 */
export interface ComposerProps {
  /**
   * The SELECTED session (URL-driven). The composer stays editable for ANY
   * selected existing session; sending activates that exact session (see
   * {@link RuntimeApi.sendPromptToSession}) if it is not already attached.
   * Omitted → falls back to the attached session (legacy standalone mounts).
   */
  sessionId?: string;
  /**
   * Explicit selection gate (history-switching fix). When `false` the selected
   * session is NOT the attached runtime (viewing history or a stale live
   * session). The composer remains editable + sendable — sending is the
   * activation intent. When omitted the legacy behavior applies: usable
   * whenever the runtime is attached.
   */
  live?: boolean;
  /**
   * Explicit ref to the composer textarea (D2-P8). ExtensionRequests restores
   * focus here after the final extension request closes/cancels. No document
   * queries.
   */
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
}

/** Fixed safe copy — never surface a raw ProtocolError in the info bar. */
const COMPACT_ERROR_MESSAGE = "Failed to compact the session.";

function describeUnavailable(cause: unknown): string {
  if (cause && typeof cause === "object" && "code" in cause) {
    const code = (cause as { code: unknown }).code;
    if (code === "unsupported_capability") return "Not supported by this runtime.";
  }
  return COMPACT_ERROR_MESSAGE;
}

function getUserInputTexts(messages: readonly { role: string; content?: unknown }[]): string[] {
  const seen = new Set<string>();
  const history: string[] = [];
  for (let index = messages.length - 1; index >= 0 && history.length < 50; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "user") continue;
    const content = message.content;
    let text = "";
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      text = content
        .filter((block): block is { type: "text"; text: string } => (block as { type: string }).type === "text")
        .map((block) => block.text)
        .join("\n");
    }
    const trimmed = text.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    history.push(trimmed);
  }
  return history;
}

export function Composer({ live: liveProp, textareaRef, sessionId: selectedSessionProp }: ComposerProps) {
  const runtime = useRuntime();
  const { canAgent, canBrowseSessions, can } = useCapabilities();
  const http = useHttpClient();
  const { t } = useI18n();
  const inputRef = useRef<ChatInputHandle | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // The SELECTED session the composer targets (send + draft). Falls back to the
  // attached session when the prop is omitted (legacy standalone mounts).
  const selectedSessionId = selectedSessionProp ?? runtime.sessionId ?? null;
  // `live` is true only when the selected session IS the attached runtime.
  const live = (liveProp ?? runtime.attached) === true;
  // The ATTACHED session (only meaningful while live) for live-only reads.
  const attachedSessionId = live ? runtime.sessionId : null;
  const state = live ? runtime.snapshot?.state : undefined;
  const cwd = live ? runtime.snapshot?.cwd ?? null : null;
  // Draft persistence key: the selected session id, or a per-cwd placeholder
  // while a brand-new (not-yet-created) session is selected.
  const draftKey = selectedSessionId ?? (cwd ? `new:${cwd}` : undefined);

  // Publish the exact ChatInputHandle so the transcript's "edit" action can
  // restore a user message into the composer (source onEditContent wiring).
  useEffect(() => {
    chatInputHandle.current = inputRef.current;
    return () => {
      if (chatInputHandle.current === inputRef.current) chatInputHandle.current = null;
    };
  }, [live]);

  // Bridge the AppShell-owned textarea ref onto the exact ChatInput's textarea
  // (the ported component owns its ref internally; the wrapper captures the
  // DOM node once mounted so extension-request focus restore keeps working).
  useEffect(() => {
    if (!textareaRef || !live) return;
    textareaRef.current = rootRef.current?.querySelector("textarea") ?? null;
    return () => {
      if (textareaRef.current !== null) textareaRef.current = null;
    };
  }, [textareaRef, live, attachedSessionId]);

  // --- capability gates -----------------------------------------------------
  const capabilities = live ? runtime.capabilities?.capabilities ?? [] : [];
  const hasCap = useCallback(
    (capability: string) => live && capabilities.includes(capability as never),
    [live, capabilities],
  );
  const hasSteer = hasCap("runtime.steer");
  const hasFollowUp = hasCap("runtime.follow_up");
  const hasQueue = hasCap("runtime.queue");
  const hasBash = hasCap("runtime.bash");
  const hasCompact = hasCap("runtime.compact");
  const hasCompactAbort = hasCap("runtime.compact.abort");
  const hasModelSet = hasCap("runtime.model.set");
  const hasThinkingSet = hasCap("runtime.thinking.set");
  const hasToolsRead = hasCap("runtime.tools.read");
  const hasToolsWrite = hasCap("runtime.tools.write");
  const hasNavigate = hasCap("runtime.navigate");
  const hasStats = hasCap("runtime.stats");
  const canModels = can("models");
  const canFilesIndex = can("files");
  const canUpload = can("files.upload");
  const canSkills = can("skills");

  // Authoritative running state (never inferred).
  const promptRunning = live && (state?.isStreaming === true || state?.isPromptRunning === true);
  const isCompacting = live && state?.isCompacting === true;

  // --- Host catalog queries (read-only) --------------------------------------
  const modelsQuery = useQuery({
    ...createQueryOptions(http).models.list(cwd ?? ""),
    enabled: live && canModels && Boolean(cwd),
  });
  const filesIndexQuery = useQuery({
    ...createQueryOptions(http).files.index(cwd ?? ""),
    enabled: live && Boolean(cwd) && canFilesIndex,
  });
  const skillsQuery = useQuery({
    ...createQueryOptions(http).skills.list(cwd ?? ""),
    enabled: live && Boolean(cwd) && canSkills,
  });
  // Branch tree for the SessionInfoBar navigator: the SAME sessions.tree query
  // the history view uses; live leaf selection overrides from the snapshot.
  const treeQuery = useQuery({
    ...createQueryOptions(http).sessions.tree(attachedSessionId ?? ""),
    enabled: live && Boolean(attachedSessionId) && canBrowseSessions,
  });

  const modelList = useMemo(
    () =>
      (modelsQuery.data?.models ?? []).map((model) => ({
        id: model.id,
        provider: model.provider,
        name: model.displayName ?? model.id,
      })),
    [modelsQuery.data],
  );
  const modelNames = useMemo(() => {
    const names: Record<string, string> = {};
    for (const model of modelList) names[`${model.provider}:${model.id}`] = model.name;
    return names;
  }, [modelList]);

  const fileIndexSnapshot = useMemo(() => {
    const data = filesIndexQuery.data;
    if (!data || !cwd || !("files" in data)) return null;
    const paths = new Set<string>();
    const dirs = new Set<string>();
    for (const file of data.files) {
      const lower = file.toLowerCase();
      paths.add(lower);
      const slash = lower.lastIndexOf("/");
      if (slash > 0) dirs.add(lower.slice(0, slash));
    }
    return { cwd, paths, dirs, truncated: data.truncated };
  }, [filesIndexQuery.data, cwd]);

  const skillNames = useMemo(() => {
    const data = skillsQuery.data;
    return data ? new Set(data.skills.map((skill) => skill.name)) : null;
  }, [skillsQuery.data]);

  const branchTree = useMemo<SessionTreeNode[] | undefined>(
    () => (treeQuery.data ? toBranchNavigatorTree(treeQuery.data.tree.roots) : undefined),
    [treeQuery.data],
  );
  // Live leaf override: a live runtime can hold an in-memory navigated leaf the
  // persisted catalog tree never fabricates (see lib/session-tree contract).
  const branchActiveLeafId = live
    ? state?.leafId ?? treeQuery.data?.tree.currentLeafId ?? null
    : treeQuery.data?.tree.currentLeafId ?? null;

  // Protocol v2: rows/input-history/labels/stats/minimap share the same merged
  // transcript (persisted pages + committed live entries by entryId).
  const transcript = useSessionTranscript({
    sessionId: selectedSessionId,
    enabled: true,
    live,
  });
  const transcriptMessages = useMemo(
    () => transcript.entries.map((entry) => entry.message),
    [transcript.entries],
  );
  const transcriptEntryIds = transcript.entryIds;

  const toolResults = useMemo(() => {
    const map = new Map<string, import("@fffattiger/pix-protocol").ToolResultMessage>();
    for (const msg of transcriptMessages) {
      if (msg.role === "toolResult") map.set(msg.toolCallId, msg);
    }
    return map;
  }, [transcriptMessages]);

  const entryIds = useMemo(() => transcriptEntryIds, [transcriptEntryIds]);

  const stepLabel = useMemo(
    () =>
      buildStepLabel({
        messages: transcriptMessages,
        entryIds,
        streamingMessage: runtime.streamingPartial as import("@fffattiger/pix-protocol").AgentMessage | null,
        running: promptRunning,
        isCompacting,
        phase: runtime.snapshot?.streaming?.phase ?? null,
        toolResults,
        t,
      }),
    [transcriptMessages, runtime.streamingPartial, runtime.snapshot, promptRunning, isCompacting, toolResults, t, entryIds],
  );

  const inputHistory = useMemo(() => getUserInputTexts(transcriptMessages), [transcriptMessages]);

  const queuedMessages = useMemo<QueuedMessagesView | null>(
    () => (live ? toQueuedMessagesView(state?.queuedMessages) : null),
    [live, state?.queuedMessages],
  );

  // --- real session stats (runtime get_session_stats; runtime.stats gate) ---
  // Fetched only while live + capability present. Refreshed from EXPLICIT
  // lifecycle signals (sessionId + attachGeneration) — NOT from the whole
  // `runtime` object (which changes identity on every stream event) and NOT from
  // message counts (which tick during a stream). So a streaming session never
  // refires the fetch; a fresh attach / session switch / detach / stop does. A
  // generation + cancel guard drops late settles so a stale response can never
  // pollute a newer session (no raw error is surfaced).
  const [sessionStatsData, setSessionStatsData] = useState<import("@fffattiger/pix-protocol").SessionStats | null>(null);
  const sessionStatsGenRef = useRef(0);
  useEffect(() => {
    if (!live || !hasStats || !attachedSessionId) {
      setSessionStatsData(null);
      return;
    }
    const gen = ++sessionStatsGenRef.current;
    let cancelled = false;
    void runtime.getSessionStats().then(
      (stats) => {
        if (cancelled || gen !== sessionStatsGenRef.current) return;
        setSessionStatsData(stats);
      },
      () => {
        // Best-effort: a failed stats read never surfaces a raw error; the
        // bar simply keeps the message-derived view.
      },
    );
    return () => { cancelled = true; };
    // `runtime.getSessionStats` is a STABLE command reference (see useRuntime),
    // so omitting the whole `runtime` object here means streaming deltas never
    // re-trigger the fetch — only the explicit lifecycle signal does.
  }, [live, hasStats, attachedSessionId, runtime.attachGeneration, runtime.getSessionStats]);

  const sessionStats = useMemo(
    () => (live && state ? buildSessionStatsView(state, transcriptMessages, hasStats ? sessionStatsData : null) : null),
    [live, state, transcriptMessages, hasStats, sessionStatsData],
  );
  // Context usage prefers the real stats projection; falls back to the snapshot state.
  const contextUsage = useMemo(
    () => (sessionStatsData?.contextUsage ? toContextUsageView(sessionStatsData.contextUsage) : toContextUsageView(state?.contextUsage)),
    [sessionStatsData, state?.contextUsage],
  );

  // --- tools preset (runtime getTools/setTools; none/full are real) ----------
  // Fetched while live + capability present. Refresh keyed on the stable
  // getTools command + the authoritative tool list reference (`state.tools` is
  // an immutable array whose identity only changes when tools actually change,
  // never on streaming deltas) — the whole `runtime` object is NOT a dep, so a
  // streaming session never refires getTools per event.
  const [tools, setToolsState] = useState<readonly ToolInfo[] | null>(null);
  useEffect(() => {
    if (!live || !hasToolsRead) {
      setToolsState(null);
      return;
    }
    let cancelled = false;
    runtime
      .getTools()
      .then((list) => {
        if (!cancelled) setToolsState(list);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [live, hasToolsRead, runtime.getTools, attachedSessionId, state?.tools]);

  const toolPreset = useMemo<"none" | "default" | "full" | undefined>(() => {
    if (!live || !hasToolsRead || !tools || tools.length === 0) return undefined;
    const active = tools.filter((tool) => tool.active).length;
    if (active === 0) return "none";
    if (active === tools.length) return "full";
    return "default";
  }, [live, hasToolsRead, tools]);

  // --- slash commands (runtime get_commands) ---------------------------------
  const [slashCommands, setSlashCommands] = useState<SlashCommandInfo[] | undefined>(undefined);
  const loadSlashCommands = useCallback((): Promise<SlashCommandInfo[]> => {
    return runtime.getCommands().then((commands) => {
      setSlashCommands([...commands]);
      return [...commands];
    });
  }, [runtime.getCommands]);

  // Builtin slash palette = the builtins {@link handleBuiltinCommand} ACTUALLY
  // handles (single source of truth, injected into ChatInput). An unlisted
  // builtin is never offered, so picking a palette entry can never fall through
  // as a model prompt. `/compact` is ONLY offered while the runtime is live and
  // advertises the compact capability — a stale/not-yet-activated session can
  // not execute it, so it must not be offered (no silent fall-through).
  const builtinSlashCommands = useMemo(
    () => (live && hasCompact ? [{ name: "compact", description: t("desktop.compactCommandDescription"), source: "builtin" as const }] : []),
    [live, hasCompact, t],
  );

  // --- error surfaces (fixed copy only) ---------------------------------------
  const [compactError, setCompactError] = useState<string | null>(null);
  useEffect(() => {
    setCompactError(null);
  }, [selectedSessionId]);

  // Identity guards for late async settles (SessionActions pattern).
  const mountedRef = useRef(true);
  const selectedSessionIdRef = useRef<string | null>(selectedSessionId);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    selectedSessionIdRef.current = selectedSessionId;
  }, [selectedSessionId]);
  // Current = still mounted AND still targeting the same SELECTED session. The
  // composer is always active for a selected session (activation is the send
  // intent), so `isCurrent` is NOT gated on live — a send-triggered activation
  // settle for the current selection must restore/keep the draft on failure.
  const isCurrent = useCallback(
    () => mountedRef.current && (selectedSessionIdRef.current === null || selectedSessionIdRef.current === selectedSessionId),
    [selectedSessionId],
  );

  /** True when a failure is DEFINITE (the turn never started) — only then restore the draft. */
  const isDefiniteFailure = useCallback((cause: unknown): boolean => {
    if (cause !== null && typeof cause === "object" && (cause as { retryable?: unknown }).retryable === true) {
      return false;
    }
    return true;
  }, []);

  /** Restore the text into the composer when a send-path command fails. */
  const restoreDraft = useCallback((message: string) => {
    inputRef.current?.insertIfEmpty(message);
  }, []);

  // --- send paths -------------------------------------------------------------
  // Sending is the ACTIVATION intent: `sendPromptToSession` ensures the exact
  // selected session is attached (open if absent/stale/stopped, detach+open if
  // a different session is attached), awaits the authoritative attach, then
  // sends the prompt exactly once. If already attached it sends directly.
  const handleSend = useCallback(
    (message: string, images?: AttachedImage[]) => {
      if (!selectedSessionId) return;
      const wireImages = toImageAttachments(images);
      runtime
        .sendPromptToSession(selectedSessionId, message, wireImages)
        .catch((cause: unknown) => {
          // Optimistic UI: the bubble is already on screen. Only a DEFINITE
          // failure (not accepted — incl. a definite ACTIVATION failure such as
          // not_found) rolls the text back into the composer; a retryable
          // timeout/transport failure usually has the turn running server-side
          // — the optimistic bubble stays until message_end/rebase.
          if (isCurrent() && isDefiniteFailure(cause)) restoreDraft(message);
        });
    },
    [selectedSessionId, runtime, isCurrent, restoreDraft, isDefiniteFailure],
  );

  const handleSteer = useCallback(
    (message: string, images?: AttachedImage[]) => {
      if (!hasSteer) return;
      runtime.steer(message, toImageAttachments(images)).catch((cause: unknown) => {
        if (isCurrent() && isDefiniteFailure(cause)) restoreDraft(message);
      });
    },
    [hasSteer, runtime, isCurrent, restoreDraft, isDefiniteFailure],
  );

  const handleFollowUp = useCallback(
    (message: string, images?: AttachedImage[]) => {
      if (!hasFollowUp) return;
      runtime.followUp(message, toImageAttachments(images)).catch((cause: unknown) => {
        if (isCurrent() && isDefiniteFailure(cause)) restoreDraft(message);
      });
    },
    [hasFollowUp, runtime, isCurrent, restoreDraft, isDefiniteFailure],
  );

  const handlePromptWithStreamingBehavior = useCallback(
    (message: string, behavior: "steer" | "followUp", images?: AttachedImage[]) => {
      if (behavior === "steer") handleSteer(message, images);
      else handleFollowUp(message, images);
    },
    [handleSteer, handleFollowUp],
  );

  const handleAbort = useCallback(() => {
    void runtime.abort().catch(() => undefined);
  }, [runtime]);

  const handleBash = useCallback(
    (command: string, excludeFromContext: boolean) => {
      if (!hasBash) return;
      void runtime.runBash(command, { excludeFromContext }).catch(() => undefined);
    },
    [hasBash, runtime],
  );

  const handleAbortCompaction = useCallback(() => {
    if (!hasCompactAbort) return;
    void runtime.abortCompaction().catch(() => undefined);
  }, [hasCompactAbort, runtime]);

  const handleCompact = useCallback(() => {
    if (!hasCompact) return;
    setCompactError(null);
    runtime.compact().catch((cause: unknown) => {
      if (isCurrent()) setCompactError(describeUnavailable(cause));
    });
  }, [hasCompact, runtime, isCurrent]);

  const handleModelChange = useCallback(
    (provider: string, modelId: string) => {
      if (!hasModelSet) return;
      runtime
        .setModel(provider, modelId)
        .then(() => (isCurrent() ? runtime.fetchSnapshot() : undefined))
        .catch(() => undefined);
    },
    [hasModelSet, runtime, isCurrent],
  );

  const handleThinkingLevelChange = useCallback(
    (level: ThinkingLevelOption) => {
      // The Protocol has no "auto" level (no unpin command exists); the auto
      // option stays display-only until the runtime grows an explicit unpin.
      if (!hasThinkingSet || level === "auto") return;
      runtime
        .setThinkingLevel(level as ThinkingLevel)
        .then(() => (isCurrent() ? runtime.fetchSnapshot() : undefined))
        .catch(() => undefined);
    },
    [hasThinkingSet, runtime, isCurrent],
  );

  const handleToolPresetChange = useCallback(
    (preset: "none" | "default" | "full") => {
      if (!hasToolsWrite || !tools) return;
      if (preset === "none") {
        void runtime.setTools([]).catch(() => undefined);
      } else if (preset === "full") {
        void runtime.setTools(tools.map((tool) => tool.name)).catch(() => undefined);
      }
      // "default": the Protocol exposes no default tool set to restore — the
      // derived preset re-renders from the authoritative tool list unchanged.
    },
    [hasToolsWrite, tools, runtime],
  );

  const handleRecallQueue = useCallback(() => {
    if (!hasQueue) return;
    const queued = queuedMessages;
    void runtime
      .clearQueue()
      .then(() => {
        if (!isCurrent() || !queued) return;
        const text = [...queued.steering, ...queued.followUp].reverse().join("\n");
        if (text) inputRef.current?.insertIfEmpty(text);
      })
      .catch(() => undefined);
  }, [hasQueue, queuedMessages, runtime, isCurrent]);

  const handleBuiltinCommand = useCallback(
    async (message: string): Promise<BuiltinSlashCommandResult> => {
      const [raw] = message.split(/\s+/);
      const command = raw ?? "/";
      const args = message.slice(command.length).trim();
      if (command === "/compact") {
        if (!hasCompact) return { handled: false };
        try {
          await runtime.compact(args.length > 0 ? args : undefined);
          return { handled: true };
        } catch (cause) {
          if (isCurrent()) setCompactError(describeUnavailable(cause));
          return { handled: true, error: COMPACT_ERROR_MESSAGE };
        }
      }
      return { handled: false };
    },
    [hasCompact, runtime, isCurrent],
  );

  const handleBranchLeafChange = useCallback(
    (leafId: string | null) => {
      if (!hasNavigate || !live || !leafId) return;
      void runtime
        .navigateTree(leafId)
        .then(() => (isCurrent() ? runtime.fetchSnapshot() : undefined))
        .then(() => treeQuery.refetch())
        .catch(() => undefined);
    },
    [hasNavigate, live, runtime, isCurrent, treeQuery],
  );

  // --- adapter loaders (Host routes only; no invented endpoints) --------------
  const resourcesApi = useMemo(() => createResourcesApi(http), [http]);
  const configurationApi = useMemo(() => createConfigurationApi(http), [http]);
  const listFiles = useCallback(
    (targetCwd: string) => resourcesApi.files.index(targetCwd).then((data) => ("files" in data ? data : { files: [], truncated: true })),
    [resourcesApi],
  );
  const searchFiles = useCallback(
    (targetCwd: string, query: string) =>
      resourcesApi.files
        .index(targetCwd, query)
        .then((data): { matches?: FileIndexEntry[] } => ("matches" in data ? { matches: [...data.matches] } : {})),
    [resourcesApi],
  );
  const listSkills = useCallback(
    (targetCwd: string) => {
      if (!canSkills) return Promise.resolve(null);
      return configurationApi.skills
        .list(targetCwd)
        .then((data) => ({ skills: data.skills.map((skill) => ({ name: skill.name, disableModelInvocation: !skill.enabled })) }))
        .catch(() => null);
    },
    [configurationApi, canSkills],
  );
  const uploadFiles = useCallback(
    (files: File[], targetCwd: string) =>
      resourcesApi.files
        .upload({ directory: targetCwd, files })
        .then((result) => {
          if (result.errors.length > 0) {
            throw new Error("Upload failed");
          }
          return result.uploaded;
        }),
    [resourcesApi],
  );

  // Genuine global inability only: no selected session (yet) or the host has no
  // agent capability. The composer NEVER exposes a detached/continue-live/stopped
  // state — sending is the activation intent for any selected existing session.
  const disabledReason = !canAgent
    ? "host has no agent capability"
    : !selectedSessionId
      ? "select a session"
      : "";

  // The exact ChatInput is mounted whenever a session is selected and the host
  // can agent; otherwise the composer degrades to a disabled surface with the
  // reason (no fake controls, no lost drafts).
  if (!canAgent || !selectedSessionId) {
    return (
      <footer className="composer composer--disabled">
        <div className="composer-inner">
          <textarea
            ref={textareaRef}
            className="composer-input"
            rows={2}
            aria-label="Message the agent"
            disabled
            placeholder={disabledReason || "Composer disabled"}
            readOnly
            value=""
            onChange={() => undefined}
          />
          <div className="composer-toolbar">
            <span className="composer-status" aria-live="polite">{disabledReason || "readonly"}</span>
          </div>
        </div>
      </footer>
    );
  }

  return (
    <div ref={rootRef} className="chat-composer-region">
      <ChatInput
        ref={inputRef}
        onSend={handleSend}
        {...(hasBash ? { onBash: handleBash } : {})}
        onAbort={handleAbort}
        {...(hasSteer ? { onSteer: handleSteer } : {})}
        {...(hasFollowUp ? { onFollowUp: handleFollowUp } : {})}
        {...(hasSteer || hasFollowUp ? { onPromptWithStreamingBehavior: handlePromptWithStreamingBehavior } : {})}
        isStreaming={promptRunning}
        isCompacting={isCompacting}
        {...(hasCompactAbort ? { onAbortCompaction: handleAbortCompaction } : {})}
        stepLabel={stepLabel}
        model={state?.model ? { provider: state.model.provider, modelId: state.model.id } : null}
        isAutoModelSelection={state?.model == null}
        modelNames={modelNames}
        modelList={modelList}
        {...(hasModelSet && canModels ? { onModelChange: handleModelChange } : {})}
        {...(toolPreset === undefined ? {} : { toolPreset })}
        {...(hasToolsWrite && toolPreset !== undefined ? { onToolPresetChange: handleToolPresetChange } : {})}
        {...(state?.thinkingLevel === undefined ? {} : { thinkingLevel: state.thinkingLevel as ThinkingLevelOption })}
        {...(hasThinkingSet ? { onThinkingLevelChange: handleThinkingLevelChange } : {})}
        availableThinkingLevels={null}
        retryInfo={null}
        queuedMessages={queuedMessages}
        inputHistory={inputHistory}
        {...(hasQueue ? { onRecallQueue: handleRecallQueue } : {})}
        {...(slashCommands === undefined ? {} : { slashCommands })}
        slashCommandsLoading={false}
        onLoadSlashCommands={loadSlashCommands}
        onBuiltinCommand={handleBuiltinCommand}
        builtinSlashCommands={builtinSlashCommands}
        {...(draftKey === undefined ? {} : { draftKey })}
        cwd={cwd}
        messagesScrollRef={transcriptScrollRef}
        {...(canFilesIndex ? { listFiles, searchFiles } : {})}
        {...(canSkills ? { listSkills } : {})}
        {...(canUpload ? { uploadFiles } : {})}
        fileIndexSnapshot={fileIndexSnapshot}
        skillNames={skillNames}
      />
      <div className="session-info-bar-wrap">
        <div className="session-info-bar-inner">
          <SessionInfoBar
            systemPrompt={state?.systemPrompt ?? null}
            sessionStats={sessionStats}
            contextUsage={contextUsage}
            hasSession={Boolean(selectedSessionId)}
            showChat
            {...(hasCompact ? { onCompact: handleCompact } : {})}
            isCompacting={isCompacting}
            compactError={compactError}
            branchTree={branchTree}
            branchActiveLeafId={branchActiveLeafId}
            {...(hasNavigate ? { onBranchLeafChange: handleBranchLeafChange } : {})}
          />
        </div>
      </div>
    </div>
  );
}
