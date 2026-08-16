import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import type { SlashCommandInfo, ThinkingLevel, ToolInfo } from "@fffattiger/pix-protocol";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
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
   * Explicit selection gate (history-switching fix). When `false` the selected
   * session is NOT the attached runtime (viewing history or a stale live
   * session), so the composer is honestly disabled even though a runtime may
   * still be attached to some OTHER session. When omitted the legacy behavior
   * applies: usable whenever the runtime is attached.
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

export function Composer({ live: liveProp, textareaRef }: ComposerProps) {
  const runtime = useRuntime();
  const { canAgent, canBrowseSessions, can } = useCapabilities();
  const http = useHttpClient();
  const { t } = useI18n();
  const inputRef = useRef<ChatInputHandle | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // `live` is true only when the selected session IS the attached runtime.
  const live = (liveProp ?? runtime.attached) === true;
  const state = live ? runtime.snapshot?.state : undefined;
  const cwd = live ? runtime.snapshot?.cwd ?? null : null;
  const sessionId = live ? runtime.sessionId : null;
  // Draft persistence key: the live session id, or a per-cwd placeholder while
  // a brand-new (not-yet-created) session is selected.
  const draftKey = sessionId ?? (cwd ? `new:${cwd}` : undefined);

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
  }, [textareaRef, live, sessionId]);

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
    ...createQueryOptions(http).sessions.tree(sessionId ?? ""),
    enabled: live && Boolean(sessionId) && canBrowseSessions,
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

  const toolResults = useMemo(() => {
    const map = new Map<string, import("@fffattiger/pix-protocol").ToolResultMessage>();
    for (const msg of runtime.messages) {
      if (msg.role === "toolResult") map.set(msg.toolCallId, msg);
    }
    return map;
  }, [runtime.messages]);

  const entryIds = useMemo(() => runtime.messages.map(() => ""), [runtime.messages]);

  const stepLabel = useMemo(
    () =>
      buildStepLabel({
        messages: runtime.messages,
        entryIds,
        streamingMessage: runtime.streamingPartial as import("@fffattiger/pix-protocol").AgentMessage | null,
        running: promptRunning,
        isCompacting,
        phase: runtime.snapshot?.streaming?.phase ?? null,
        toolResults,
        t,
      }),
    [runtime.messages, runtime.streamingPartial, runtime.snapshot, promptRunning, isCompacting, toolResults, t, entryIds],
  );

  const inputHistory = useMemo(() => getUserInputTexts(runtime.messages), [runtime.messages]);

  const queuedMessages = useMemo<QueuedMessagesView | null>(
    () => (live ? toQueuedMessagesView(state?.queuedMessages) : null),
    [live, state?.queuedMessages],
  );

  // --- real session stats (runtime get_session_stats; runtime.stats gate) ---
  // Fetched only while live + capability present. Refreshes when the session
  // or its message/pending counts settle; cleared on capability revoke or
  // session switch. A generation + cancel guard drops late settles so a stale
  // response can never pollute a newer session (no raw error is surfaced).
  const statsMessageCount = state?.messageCount ?? 0;
  const statsPendingCount = state?.pendingMessageCount ?? 0;
  const [sessionStatsData, setSessionStatsData] = useState<import("@fffattiger/pix-protocol").SessionStats | null>(null);
  const sessionStatsGenRef = useRef(0);
  useEffect(() => {
    if (!live || !hasStats || !sessionId) {
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
  }, [live, hasStats, sessionId, statsMessageCount, statsPendingCount, runtime]);

  const sessionStats = useMemo(
    () => (live && state ? buildSessionStatsView(state, runtime.messages, hasStats ? sessionStatsData : null) : null),
    [live, state, runtime.messages, hasStats, sessionStatsData],
  );
  // Context usage prefers the real stats projection; falls back to the snapshot state.
  const contextUsage = useMemo(
    () => (sessionStatsData?.contextUsage ? toContextUsageView(sessionStatsData.contextUsage) : toContextUsageView(state?.contextUsage)),
    [sessionStatsData, state?.contextUsage],
  );

  // --- tools preset (runtime getTools/setTools; none/full are real) ----------
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
  }, [live, hasToolsRead, runtime, sessionId, runtime.snapshot?.state.tools]);

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
  }, [runtime]);

  // --- error surfaces (fixed copy only) ---------------------------------------
  const [compactError, setCompactError] = useState<string | null>(null);
  useEffect(() => {
    setCompactError(null);
  }, [sessionId]);

  // Identity guards for late async settles (SessionActions pattern).
  const mountedRef = useRef(true);
  const sessionIdRef = useRef<string | null>(sessionId);
  const liveRef = useRef(live);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    sessionIdRef.current = sessionId;
    liveRef.current = live;
  }, [sessionId, live]);
  const isCurrent = useCallback(
    () => mountedRef.current && liveRef.current && (sessionIdRef.current === null || sessionIdRef.current === sessionId),
    [sessionId],
  );

  /** Restore the text into the composer when a send-path command fails. */
  const restoreDraft = useCallback((message: string) => {
    inputRef.current?.insertIfEmpty(message);
  }, []);

  // --- send paths -------------------------------------------------------------
  const handleSend = useCallback(
    (message: string, images?: AttachedImage[]) => {
      if (!live) return;
      const wireImages = toImageAttachments(images);
      runtime
        .sendPrompt(message, wireImages)
        .catch(() => {
          if (isCurrent()) restoreDraft(message);
        });
    },
    [live, runtime, isCurrent, restoreDraft],
  );

  const handleSteer = useCallback(
    (message: string, images?: AttachedImage[]) => {
      if (!hasSteer) return;
      runtime.steer(message, toImageAttachments(images)).catch(() => {
        if (isCurrent()) restoreDraft(message);
      });
    },
    [hasSteer, runtime, isCurrent, restoreDraft],
  );

  const handleFollowUp = useCallback(
    (message: string, images?: AttachedImage[]) => {
      if (!hasFollowUp) return;
      runtime.followUp(message, toImageAttachments(images)).catch(() => {
        if (isCurrent()) restoreDraft(message);
      });
    },
    [hasFollowUp, runtime, isCurrent, restoreDraft],
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

  const disabledReason = !canAgent
    ? "host has no agent capability"
    : !live
      ? runtime.attached
        ? "selected session is not live"
        : runtime.connection === "idle"
          ? "no project selected"
          : "runtime not attached"
      : runtime.sessionStopped
        ? "session stopped"
        : "";

  // The exact ChatInput is mounted only when it can honestly send; otherwise
  // the composer degrades to a disabled surface with the reason (no fake
  // controls, no lost drafts).
  if (!canAgent || !live || runtime.sessionStopped) {
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
            hasSession={Boolean(sessionId)}
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
