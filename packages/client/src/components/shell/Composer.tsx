import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import type { SlashCommandInfo, ThinkingLevel, ToolInfo } from "@fffattiger/pix-protocol";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import { foldsPathCase } from "@/lib/file-paths";
import { useSessionTranscript } from "@/features/session-history/use-session-transcript";
import { useRuntime } from "@/runtime";
import { useHttpClient } from "@/app/http-context";
import { createQueryOptions } from "@/api/query-keys";
import { createConfigurationApi } from "@/api/configuration";
import { createResourcesApi } from "@/api/resources";
import { useI18n } from "@/hooks/useI18n";
import { useAudio } from "@/hooks/useAudio";
import { ChatInput, type AttachedImage, type ChatInputHandle } from "@/components/chat/ChatInput";
import { SessionInfoBar } from "@/components/chat/SessionInfoBar";
import { chatInputHandle, transcriptScrollRef } from "@/components/chat/chat-experience-bridge";
import {
  buildSessionStatsView,
  buildTranscriptSessionStatsView,
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
 * source kept the draft through its notice shelf; pix has none). The composer
 * stays EDITABLE for ANY selected existing session — there is NO history/
 * detached/live split. Selecting/browsing a session is read-only (0-Worker
 * history); sending is the activation intent: `sendPromptToSession` activates
 * the exact selected session if needed, then sends exactly once. The exact
 * ChatInput is mounted whenever a session is selected and the host can agent;
 * the only disabled surfaces are genuine global inability (no selected session
 * or no agent capability).
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
  /**
   * Canonical project cwd (AppShell passes `search.cwd`). Used for the Host
   * model catalog and @ file/skill scope INDEPENDENT of the live runtime
   * snapshot, so a detached (read-only) selected session still gets an honest
   * project-scoped catalog. Omitted → falls back to the live snapshot's cwd
   * (legacy standalone mounts; null while detached).
   */
  cwd?: string | null;
  /**
   * Optional Host-catalog cwd when the URL has no project selected. Used only
   * to keep the model picker honest on the empty home; file/skill indexes stay
   * gated on the explicit project cwd.
   */
  catalogCwd?: string | null;
  /**
   * Empty-home create: AppShell owns create + URL navigation. When the user
   * sends with no selected session, Composer asks the shell to create one and
   * then activates it exactly once. Omitted → send without a session is a no-op.
   */
  onCreateSession?: (settings?: {
    model?: { provider: string; modelId: string };
    thinkingLevel?: ThinkingLevel;
  }) => Promise<string>;
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

export function Composer({ live: liveProp, textareaRef, sessionId: selectedSessionProp, cwd: projectCwdProp, catalogCwd: catalogCwdProp, onCreateSession }: ComposerProps) {
  const runtime = useRuntime();
  const { canAgent, canBrowseSessions, can, pathFlavor } = useCapabilities();
  const http = useHttpClient();
  const { t } = useI18n();
  const { soundEnabled, onSoundToggle, playDoneSound, unlockAudio } = useAudio();
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
  // Canonical project cwd: the explicit URL-scoped cwd (AppShell passes
  // `search.cwd`) when provided — honest project scope INDEPENDENT of the live
  // snapshot, so a detached read-only selection still has a project to query
  // catalogs against. Falls back to the live snapshot's cwd when the prop is
  // omitted (legacy standalone mounts).
  const cwd = projectCwdProp ?? (live ? runtime.snapshot?.cwd ?? null : null);
  const catalogCwd = cwd ?? catalogCwdProp ?? null;
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
  const foldPathCase = foldsPathCase(pathFlavor);

  // Authoritative running state (never inferred) OR a prompt transaction in
  // flight (activation + dispatch) — so an in-progress send is never treated as
  // idle, including while a read-only selected session is being activated.
  const promptRunning = live && (state?.isStreaming === true || state?.isPromptRunning === true)
    || runtime.promptPending;
  const isCompacting = live && state?.isCompacting === true;
  const agentRunning = live && (state?.isStreaming === true || state?.isPromptRunning === true);
  const wasAgentRunningRef = useRef(false);
  useEffect(() => {
    const completed = wasAgentRunningRef.current && !agentRunning && live && runtime.sessionId === selectedSessionId;
    wasAgentRunningRef.current = agentRunning;
    if (completed) playDoneSound();
  }, [agentRunning, live, playDoneSound, runtime.sessionId, selectedSessionId]);

  // --- Host catalog queries (read-only) --------------------------------------
  // The MODEL catalog is queried for the canonical project cwd EVEN WHEN
  // DETACHED: a read-only selected session must keep its model selector visible
  // and interactive (staged), backed by the Host catalog — never by the attached
  // runtime's state. File/skill indexes stay LIVE-gated (their snapshots feed
  // @ mention highlighting in the live transcript); the loaders below still run
  // project-cwd-scoped when the @ menu is used.
  const modelsQuery = useQuery({
    ...createQueryOptions(http).models.list(catalogCwd ?? ""),
    enabled: canModels && Boolean(catalogCwd),
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
      const key = foldPathCase ? file.toLowerCase() : file;
      paths.add(key);
      const slash = key.lastIndexOf("/");
      if (slash > 0) dirs.add(key.slice(0, slash));
    }
    return { cwd, paths, dirs, truncated: data.truncated };
  }, [filesIndexQuery.data, cwd, foldPathCase]);

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

  // --- per-selected-session STAGED activation settings --------------------------
  // A detached (read-only) selected session cannot issue runtime commands; its
  // model/thinking choices are STAGED here (session-tagged) and applied by the
  // single send transaction (`sendPromptToSession` activation settings) AFTER
  // attach and BEFORE the prompt dispatch — no parallel component-side
  // control race. Values are only visible while owned by the CURRENT selected
  // session (`staged.sessionId === selectedSessionId`), so stale session A
  // staged settings are NEVER displayed under B. Cleared only after a send
  // successfully applied them (success path below); preserved on proven
  // activation/config failure so the user's intent is not silently dropped.
  interface StagedActivation {
    readonly sessionId: string | null;
    readonly model: { provider: string; modelId: string } | null;
    readonly thinking: ThinkingLevel | null;
  }
  const [staged, setStaged] = useState<StagedActivation>({ sessionId: null, model: null, thinking: null });
  const stagedModel = staged.sessionId === selectedSessionId ? staged.model : null;
  const stagedThinking = staged.sessionId === selectedSessionId ? staged.thinking : null;
  const stageModel = useCallback((provider: string, modelId: string) => {
    setStaged((prev) => ({
      sessionId: selectedSessionId,
      model: { provider, modelId },
      thinking: prev.sessionId === selectedSessionId ? prev.thinking : null,
    }));
  }, [selectedSessionId]);
  const stageThinking = useCallback((level: ThinkingLevel | null) => {
    setStaged((prev) => ({
      sessionId: selectedSessionId,
      model: prev.sessionId === selectedSessionId ? prev.model : null,
      thinking: level,
    }));
  }, [selectedSessionId]);
  const clearStaged = useCallback(() => {
    setStaged((prev) => (prev.sessionId === selectedSessionId ? { sessionId: null, model: null, thinking: null } : prev));
  }, [selectedSessionId]);

  // --- detached model / thinking baseline (honest, NEVER the attached A state) ---
  // A read-only selected session B shows its OWN projected model + thinking:
  //  - model baseline: staged selection → latest persisted assistant message of
  //    B (provider/model inferred) if present in the Host catalog → Host
  //    defaultModel → null (honest: nothing known). The attached runtime's
  //    state (A) is NEVER reused for B.
  //  - thinking baseline: staged value or the neutral `auto` (never claims A's
  //    value).
  const detachedInferredModel = useMemo(() => {
    for (let index = transcriptMessages.length - 1; index >= 0; index -= 1) {
      const message = transcriptMessages[index];
      if (message?.role === "assistant" && typeof message.model === "string" && typeof message.provider === "string") {
        return { provider: message.provider, modelId: message.model };
      }
    }
    return null;
  }, [transcriptMessages]);
  const isModelInCatalog = useCallback(
    (candidate: { provider: string; modelId: string }): boolean =>
      modelList.some((model) => model.provider === candidate.provider && model.id === candidate.modelId),
    [modelList],
  );
  const detachedModel = useMemo<{ provider: string; modelId: string } | null>(() => {
    // 1. prefer the staged selection (explicit user intent for B).
    if (stagedModel) return stagedModel;
    // 2. infer from B's latest persisted assistant message when catalog-valid.
    if (detachedInferredModel && isModelInCatalog(detachedInferredModel)) return detachedInferredModel;
    // 3. Host defaultModel for the project cwd (never A's runtime model).
    const defaultModel = modelsQuery.data?.defaultModel;
    if (defaultModel && isModelInCatalog({ provider: defaultModel.provider, modelId: defaultModel.id })) {
      return { provider: defaultModel.provider, modelId: defaultModel.id };
    }
    // Catalog exists but no default / inferred model: show the first entry so
    // ChatInput can render the selector (it requires a currentName). Never
    // reuse the attached session's runtime model.
    const first = modelList[0];
    if (first) return { provider: first.provider, modelId: first.id };
    return null;
  }, [stagedModel, detachedInferredModel, isModelInCatalog, modelsQuery.data, modelList]);
  const detachedThinking = stagedThinking ?? "auto";
  // The model/thinking surfaced to ChatInput: live → the authoritative runtime
  // snapshot state (existing behavior); detached → the honest B baseline above.
  const model = live
    ? (state?.model ? { provider: state.model.provider, modelId: state.model.id } : null)
    : detachedModel;
  const isAutoModelSelection = live ? state?.model == null : detachedModel == null;
  const thinkingLevel: ThinkingLevelOption | undefined = live
    ? (state?.thinkingLevel === undefined ? undefined : state.thinkingLevel as ThinkingLevelOption)
    : detachedThinking;
  // Whether the model/thinking change handlers run immediately (live, existing
  // setModel/setThinkingLevel) or only stage for the send transaction (detached).
  // Live: honor runtime.model.set even before the catalog settles. Detached /
  // empty-home: stage against the Host catalog so the selector stays visible
  // without attaching a Worker — only when the catalog actually has models.
  const modelChangeInteractive = live
    ? hasModelSet && canModels
    : canModels && modelList.length > 0;
  const thinkingChangeInteractive = live ? hasThinkingSet : true;

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

  // --- serialized runtime info reads (single ordinary-command slot) ---------
  // Stats and tools are independent UI projections but share the runtime's ONE
  // ordinary command slot. Read them sequentially, never during an
  // activation-then-send transaction, so neither can race the first prompt or
  // each other. Explicit lifecycle signals drive refresh; stream deltas do not.
  const [sessionStatsData, setSessionStatsData] = useState<import("@fffattiger/pix-protocol").SessionStats | null>(null);
  const [tools, setToolsState] = useState<readonly ToolInfo[] | null>(null);
  const runtimeInfoGenRef = useRef(0);
  useEffect(() => {
    if (!live || !attachedSessionId) {
      setSessionStatsData(null);
      setToolsState(null);
      return;
    }
    if (runtime.promptPending) return;
    const generation = ++runtimeInfoGenRef.current;
    let cancelled = false;
    const current = (): boolean => !cancelled && generation === runtimeInfoGenRef.current;
    void (async () => {
      if (hasStats) {
        try {
          const stats = await runtime.getSessionStats();
          if (current()) setSessionStatsData(stats);
        } catch {
          // Best-effort: retain transcript-derived stats.
        }
      } else if (current()) {
        setSessionStatsData(null);
      }
      if (!current()) return;
      if (hasToolsRead) {
        try {
          const list = await runtime.getTools();
          if (current()) setToolsState(list);
        } catch {
          // Best-effort: hide the preset when the read is unavailable.
        }
      } else if (current()) {
        setToolsState(null);
      }
    })();
    return () => { cancelled = true; };
  }, [
    live,
    attachedSessionId,
    hasStats,
    hasToolsRead,
    runtime.attachGeneration,
    runtime.promptPending,
    runtime.getSessionStats,
    runtime.getTools,
    state?.tools,
  ]);

  const sessionStats = useMemo(() => {
    if (!selectedSessionId) return null;
    if (live && state) return buildSessionStatsView(state, transcriptMessages, hasStats ? sessionStatsData : null);
    return buildTranscriptSessionStatsView(selectedSessionId, transcriptMessages);
  }, [selectedSessionId, live, state, transcriptMessages, hasStats, sessionStatsData]);
  // buildSessionStatsView already merges context with live snapshot priority;
  // never let the one-shot attach-time stats read overwrite a newer turn value.
  const contextUsage = sessionStats?.contextUsage ?? toContextUsageView(state?.contextUsage);

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

  /**
   * True when a failure happened in the ACTIVATION phase (before the prompt
   * command was dispatched) — the prompt is PROVEN non-delivery regardless of
   * any retryable transport metadata, so the draft must be restored/retained
   * and no phantom bubble may remain. Tagged by the store (`phase:
   * "activation"`).
   */
  const isActivationFailure = useCallback((cause: unknown): boolean => {
    return cause !== null && typeof cause === "object" && (cause as { phase?: unknown }).phase === "activation";
  }, []);

  /** Restore the text into the composer when a send-path command fails. */
  const restoreDraft = useCallback((message: string) => {
    inputRef.current?.insertIfEmpty(message);
  }, []);

  // --- send paths -------------------------------------------------------------
  // Sending is the ACTIVATION intent: `sendPromptToSession` transitions to the
  // exact selected session (open if absent/stale/stopped, detach+open if a
  // different session is attached), awaits the authoritative attach, then sends
  // the prompt exactly once. If already attached it sends directly. The draft
  // is restored on ANY activation-phase failure (proven non-delivery) and on
  // definite dispatch failures; uncertain dispatch keeps the bubble.
  const handleSend = useCallback(
    (message: string, images?: AttachedImage[]) => {
      const wireImages = toImageAttachments(images);
      const activationSettings = {
        model: stagedModel,
        thinkingLevel: stagedThinking,
      };
      const sendTo = (sessionId: string, applyActivationSettings = true): void => {
        runtime
          .sendPromptToSession(
            sessionId,
            message,
            wireImages,
            applyActivationSettings
              ? {
                  // Detached staging rides the SINGLE activation transaction:
                  // applied after attach and before the prompt.
                  model: activationSettings.model,
                  thinkingLevel: activationSettings.thinkingLevel,
                }
              : undefined,
          )
          .then(() => {
            if (isCurrent()) clearStaged();
          })
          .catch((cause: unknown) => {
            if (isCurrent() && (isActivationFailure(cause) || isDefiniteFailure(cause))) restoreDraft(message);
          });
      };
      if (selectedSessionId) {
        sendTo(selectedSessionId);
        return;
      }
      if (!onCreateSession) return;
      void onCreateSession({
        ...(stagedModel === null ? {} : { model: stagedModel }),
        ...(stagedThinking === null ? {} : { thinkingLevel: stagedThinking }),
      })
        // Create already applied model/thinking. Reapplying them before the
        // first prompt can fail capability checks and restore the draft, making
        // the user press Enter twice.
        .then((sessionId) => { sendTo(sessionId, false); })
        .catch((cause: unknown) => {
          if (isCurrent() && (isActivationFailure(cause) || isDefiniteFailure(cause))) restoreDraft(message);
        });
    },
    [selectedSessionId, runtime, isCurrent, restoreDraft, isActivationFailure, isDefiniteFailure, stagedModel, stagedThinking, clearStaged, onCreateSession],
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
    if (!selectedSessionId || (live && !hasCompact)) return;
    setCompactError(null);
    void (async () => {
      try {
        // Selecting a tab stays read-only; clicking Compact is an explicit
        // activation intent, matching the source desktop's per-session action.
        if (!live || runtime.sessionId !== selectedSessionId) {
          await runtime.openSession(selectedSessionId);
        }
        await runtime.compact();
      } catch (cause) {
        if (isCurrent()) setCompactError(describeUnavailable(cause));
      }
    })();
  }, [selectedSessionId, live, hasCompact, runtime, isCurrent]);

  const handleModelChange = useCallback(
    (provider: string, modelId: string) => {
      if (live) {
        // LIVE selected session: keep the existing immediate setModel behavior
        // (capability-gated).
        if (!hasModelSet) return;
        runtime
          .setModel(provider, modelId)
          .then(() => (isCurrent() ? runtime.fetchSnapshot() : undefined))
          .catch(() => undefined);
        return;
      }
      // DETACHED selected session: stage ONLY — no runtime command/attach here.
      // The staged model is applied by the send transaction (after attach,
      // before the prompt).
      stageModel(provider, modelId);
    },
    [live, hasModelSet, runtime, isCurrent, stageModel],
  );

  const handleThinkingLevelChange = useCallback(
    (level: ThinkingLevelOption) => {
      if (live) {
        // LIVE selected session: keep the existing immediate setThinkingLevel
        // behavior. The Protocol has no "auto" level (no unpin command exists);
        // the auto option stays display-only until the runtime grows an explicit
        // unpin.
        if (!hasThinkingSet || level === "auto") return;
        runtime
          .setThinkingLevel(level as ThinkingLevel)
          .then(() => (isCurrent() ? runtime.fetchSnapshot() : undefined))
          .catch(() => undefined);
        return;
      }
      // DETACHED selected session: stage ONLY — no runtime command/attach here.
      // "auto" is the neutral detached baseline: staging it clears the staged
      // thinking back to `auto` (nothing is sent on the next send).
      stageThinking(level === "auto" ? null : (level as ThinkingLevel));
    },
    [live, hasThinkingSet, runtime, isCurrent, stageThinking],
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

  // Genuine global inability only: the host has no agent capability. An empty
  // home (no selected session) still mounts the exact ChatInput so the user can
  // pick a model and start a conversation; send creates then activates.
  const disabledReason = !canAgent ? "host has no agent capability" : "";
  const canOfferCompact = Boolean(selectedSessionId) && (!live || hasCompact);

  if (!canAgent) {
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
        model={model}
        isAutoModelSelection={isAutoModelSelection}
        modelNames={modelNames}
        modelList={modelList}
        {...(modelChangeInteractive ? { onModelChange: handleModelChange } : {})}
        {...(toolPreset === undefined ? {} : { toolPreset })}
        {...(hasToolsWrite && toolPreset !== undefined ? { onToolPresetChange: handleToolPresetChange } : {})}
        {...(thinkingLevel === undefined ? {} : { thinkingLevel })}
        {...(thinkingChangeInteractive ? { onThinkingLevelChange: handleThinkingLevelChange } : {})}
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
        onAudioUnlock={unlockAudio}
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
            soundEnabled={soundEnabled}
            onSoundToggle={onSoundToggle}
            {...(canOfferCompact ? { onCompact: handleCompact } : {})}
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
