import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SlashCommandInfo, ThinkingLevel } from "@fffattiger/pix-protocol";
import { useCapabilities } from "@/features/capability/CapabilityProvider";
import { useSessionTranscript } from "@/features/session-history/use-session-transcript";
import { useSelectedWorkspaceAccess } from "@/features/session-history/use-selected-workspace-access";
import {
  describeWorkspaceAccess,
  type WorkspaceAccessDecision,
} from "@/api/workspace-access";
import { useRuntime, useRuntimeConnection, useExactActionCoordinator } from "@/runtime";
import { describeRuntimeObservationError } from "@/runtime/observation-errors";
import { useSessionStaging } from "@/features/composer/session-staging-provider";
import {
  provisionalStagingKey,
  sameStagedModel,
  sessionStagingKey,
  type StagingKey,
} from "@/features/composer/session-staging-store";
import { captureSubmitModel } from "@/features/composer/submit-activation";
import { useHttpClient } from "@/app/http-context";
import {
  configuredTitleModel,
  isAutoTitleArmed,
  requestSessionTitle,
} from "@/features/session-title/session-title";
import { createQueryOptions, queryKeys } from "@/api/query-keys";
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
  toBranchNavigatorTree,
  toContextUsageView,
  toImageAttachments,
  toLiveThinkingLevelOption,
  toQueuedMessagesView,
  assembleHistoryContextUsage,
  type ContextCatalogModel,
} from "@/components/chat/chat-runtime-view";
import type { BuiltinSlashCommandResult, QueuedMessages as QueuedMessagesView } from "@/lib/chat-view-model";
import type { FileIndexEntry } from "@/lib/file-fuzzy";
import type { ThinkingLevelOption } from "@/lib/thinking-levels";
import type { SessionTreeNode } from "@/lib/chat-view-model";

/**
 * Composer — the exact ported ChatInput wired to the provider-owned runtime.
 *
 * The source ChatWindow owned this wiring through its useAgentSession hook;
 * pix re-derives the same surface from the exact selected runtime and the Host
 * catalog queries:
 *  - send / steer / follow-up / abort / bash / compact(+abort) via ID-bound
 *    exact actions, each capability-gated (runtime.* caps) so a control is
 *    only offered when the runtime honestly advertises it;
 *  - model picker from the Host models catalog (runtime.model.set + Host
 *    `models`), thinking level from the snapshot (runtime.thinking.set — the
 *    Protocol has no "auto" level, so "auto" stays a display-only option);
 *    (tool preset removed: sessions default to FULL tool permissions, see
 *    pi-sdk-adapter create);
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
 * history); sending is the activation intent: the selected exact runtime's
 * `sendPromptToSession` activates that session if needed, then sends exactly
 * once. A brand-new first send uses one coordinator state machine over the
 * same registry. The exact ChatInput is mounted whenever a session is selected
 * and the host can agent; the only disabled surfaces are genuine global
 * inability (no selected session or no agent capability).
 */
export interface ComposerProps {
  /**
   * The SELECTED session (URL-driven). The composer stays editable for ANY
   * selected existing session; sending activates that exact session (see the
   * ID-bound `sendPromptToSession`) if it is not already attached.
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
   * Known project directory roots for the project picker dropdown (shown next
   * to the thinking-level control). Provided only while creating a NEW
   * session (home draft) — a session view's owning project is fixed by its
   * session id, so no picker is offered there.
   */
  projectRoots?: readonly string[];
  /** Select the project directory the new session is created in. */
  onProjectChange?: (projectRoot: string) => void;
  /**
   * Create + attach a brand-new session for the transient home draft on first
   * send. This callback MUST NOT navigate: Composer first reserves B's prompt
   * transaction, then asks the shell to promote the real session ID.
   */
  onCreateSession?: () => Promise<{ sessionId: string; cwd: string }>;
  /** Promote a new real session after sendPromptToSession owns B's command slot. */
  onCreatedSessionDispatched?: (created: { sessionId: string; cwd: string; firstMessage: string }) => void;
  /** Revalidate/publish session metadata after a prompt command settles. */
  onSessionActivitySettled?: (activity: { sessionId: string; cwd: string | null; firstMessage: string }) => void;
  /**
   * True when the selected session's authoritative catalog row already has a
   * title. Auto title generation only fires for untitled sessions so a user
   * rename is never clobbered (AppShell derives it from the sessions list).
   */
  selectedSessionHasTitle?: boolean;
}

/** Fixed safe copy — never surface a raw ProtocolError in the info bar. */
const COMPACT_ERROR_MESSAGE = "Failed to compact the session.";

function describeUnavailable(cause: unknown, translate?: (key: string) => string): string {
  if (cause && typeof cause === "object" && "code" in cause) {
    const code = (cause as { code: unknown }).code;
    if (code === "unsupported_capability") {
      return describeRuntimeObservationError(cause, translate);
    }
  }
  return COMPACT_ERROR_MESSAGE;
}

function workspaceAccessBoundary(
  decision: WorkspaceAccessDecision,
  translate: (key: string) => string,
): { code: "unsupported_capability"; message: string; retryable: false; phase: "activation" } {
  return {
    code: "unsupported_capability",
    message: describeWorkspaceAccess(decision, translate),
    retryable: false,
    phase: "activation",
  };
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

export function Composer({ live: liveProp, textareaRef, sessionId: selectedSessionProp, cwd: projectCwdProp, projectRoots, onProjectChange, onCreateSession, onCreatedSessionDispatched, onSessionActivitySettled, selectedSessionHasTitle }: ComposerProps) {
  // Exact selected runtime: AppShell (and standalone mounts) pass the URL/
  // selected session as a prop. Never a facade "current holder" — a detached
  // selected session stays history-only until a send activates it. Home/
  // new-session mounts pass no sessionId, so this hook returns null.
  const exact = useRuntime(selectedSessionProp ?? null);
  const workspace = useSelectedWorkspaceAccess(selectedSessionProp ?? null);
  const liveWorkspaceEnabled = workspace.liveWorkspaceEnabled;
  const workspaceDecision = workspace.decision;
  // Connection-global transport surface for the negotiated submit-turn feature
  // (legacy v2 shim vs submit-turn terminal catalog refresh).
  const connection = useRuntimeConnection();
  const submitTurnEnabled = connection.acceptedFeatures.includes("runtime.submit-turn.v1");
  // Imperative exact-action coordinator for a POST-CREATE session id (unknown
  // until create resolves); never the raw registry. Selected-session actions
  // go through `exact` (ID-bound exact hook).
  const exactActionsFor = useExactActionCoordinator();
  const queryClient = useQueryClient();
  // Provider-owned bounded staging owner (per-session + provisional draft).
  const staging = useSessionStaging();
  const homeTransactionIdRef = useRef(`home-${Math.random().toString(36).slice(2, 10)}`);
  const { canAgent, canBrowseSessions, can } = useCapabilities();
  const http = useHttpClient();
  const { t } = useI18n();

  const { soundEnabled, onSoundToggle, playDoneSound, unlockAudio } = useAudio();
  const inputRef = useRef<ChatInputHandle | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  /** Phase 3: last message sent to each session, for the terminal-driven catalog refresh. */
  const lastTurnMessageRef = useRef<Map<string, string>>(new Map());
  // Source-parity single-flight for the transient draft's ensure/create phase.
  // A fast second Enter joins the existing intent instead of creating another
  // worker or clearing a newer edit.
  const firstPromptCreateRef = useRef<Promise<{ sessionId: string; cwd: string }> | null>(null);

  // `live` is true only when the selected session IS the attached runtime.
  const live = (liveProp ?? exact?.attached ?? false) === true;
  // The SELECTED session the composer targets (send + draft). A live
  // standalone mount may inherit the attached session for backwards
  // compatibility. A non-live composer is a new-session surface, however:
  // it MUST stay untargeted so its first prompt takes onCreateSession instead
  // of being silently routed to a previously attached background session.
  const selectedSessionId = selectedSessionProp ?? (live ? exact?.sessionId ?? null : null);
  // The ATTACHED session (only meaningful while live) for live-only reads.
  const attachedSessionId = live ? exact?.sessionId ?? null : null;
  const state = live ? exact?.snapshot?.state : undefined;
  // Canonical project cwd: the explicit URL-scoped cwd (AppShell passes
  // `search.cwd`) when provided — honest project scope INDEPENDENT of the live
  // snapshot, so a detached read-only selection still has a project to query
  // catalogs against. Falls back to the live snapshot's cwd when the prop is
  // omitted (legacy standalone mounts).
  const cwd = projectCwdProp ?? (live ? exact?.snapshot?.cwd ?? null : null);
  // Draft persistence key: the selected session id, or a per-cwd placeholder
  // while a brand-new (not-yet-created) session is selected.
  const draftKey = selectedSessionId ?? (cwd ? `new:${cwd}` : undefined);

  // --- Session title generation (Settings → Chat consumer) ------------------
  const autoTitleFiredRef = useRef<Set<string>>(new Set());

  const applyGeneratedTitle = useCallback((sessionId: string) => {
    // sessiond published the revisioned title overlay; refresh the catalog
    // caches so the sidebar/tab labels converge to the authoritative title.
    void queryClient.invalidateQueries({ queryKey: queryKeys.sessions.lists });
    void queryClient.invalidateQueries({ queryKey: queryKeys.sessions.byId(sessionId) });
  }, [queryClient]);

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
  const capabilities = live ? exact?.capabilities?.capabilities ?? [] : [];
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
  const hasNavigate = hasCap("runtime.navigate");
  const hasStats = hasCap("runtime.stats");
  const canModels = can("models") && liveWorkspaceEnabled;
  const canFilesIndex = can("files") && liveWorkspaceEnabled;
  const canUpload = can("files.upload") && liveWorkspaceEnabled;
  const canSkills = can("skills") && liveWorkspaceEnabled;

  // Authoritative running state (never inferred) OR a prompt transaction owned
  // by THIS selected session. The exact hook is ID-bound to the selected
  // session, so a background holder's pending command can never make this
  // composer render a stop/running state. B's own activation-then-send still
  // becomes busy immediately because the exact optimistic transaction is keyed
  // to B before attach.
  const promptPendingForSelection = exact?.promptPending === true;
  const promptRunning = (live && (state?.isStreaming === true || state?.isPromptRunning === true))
    || promptPendingForSelection;
  const isCompacting = live && state?.isCompacting === true;
  const agentRunning = live && (state?.isStreaming === true || state?.isPromptRunning === true);
  const wasAgentRunningRef = useRef(false);
  useEffect(() => {
    const completed = wasAgentRunningRef.current && !agentRunning && live;
    wasAgentRunningRef.current = agentRunning;
    if (completed) playDoneSound();
  }, [agentRunning, live, playDoneSound]);

  // --- Host catalog queries (read-only) --------------------------------------
  // The MODEL catalog is GLOBAL (agent-dir models.json providers) and is
  // queried EVEN WHEN DETACHED or on the new-session home: a read-only
  // selected session keeps its model selector visible and interactive
  // (staged), backed by the Host catalog — never by the attached runtime's
  // state. It stays workspace-gated because the selector itself is a live
  // workspace surface. File/skill indexes stay LIVE-gated (their snapshots
  // feed @ mention highlighting in the live transcript).
  const modelsQuery = useQuery({
    ...createQueryOptions(http).models.list(),
    enabled: liveWorkspaceEnabled && canModels,
  });
  const filesIndexQuery = useQuery({
    ...createQueryOptions(http).files.index(cwd ?? ""),
    enabled: liveWorkspaceEnabled && live && Boolean(cwd) && canFilesIndex,
  });
  const skillsQuery = useQuery({
    ...createQueryOptions(http).skills.list(cwd ?? ""),
    enabled: liveWorkspaceEnabled && live && Boolean(cwd) && canSkills,
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

  // --- per-selected-session / provisional STAGED activation settings --------
  // Owned by the provider-mounted SessionStagingStore (bounded, A/B
  // independent, no silent eviction). A detached (read-only) selected session
  // cannot issue runtime commands; its model/thinking choices are STAGED
  // against the exact `session:<id>` key (or the provisional `new:home` key on
  // the home draft) and applied by the single send transaction (activation
  // settings) AFTER attach and BEFORE the prompt dispatch. Accepted sends clear
  // the exact record; definite/activation failure and uncertain delivery
  // preserve it. The home provisional record is promoted to the created
  // session's exact key before its first send.
  const stagingKey = useMemo<StagingKey>(() => (
    selectedSessionId
      ? sessionStagingKey(selectedSessionId)
      : provisionalStagingKey(homeTransactionIdRef.current)
  ), [selectedSessionId]);
  const stagedRecord = staging.get(stagingKey);
  const stagedModel = stagedRecord?.model ?? null;
  const stagedThinking = stagedRecord?.thinking ?? null;
  const stageModel = useCallback((provider: string, modelId: string) => {
    staging.stage(stagingKey, { provider, modelId });
  }, [staging, stagingKey]);
  const stageThinking = useCallback((level: ThinkingLevel | null) => {
    staging.stage(stagingKey, undefined, level);
  }, [staging, stagingKey]);
  const clearStagedModel = useCallback(() => {
    staging.clearModel(stagingKey);
  }, [staging, stagingKey]);
  const clearStagedThinking = useCallback(() => {
    staging.clearThinking(stagingKey);
  }, [staging, stagingKey]);

  // --- detached model / thinking baseline (honest, NEVER the attached A state) ---
  // The read-side context resolves settings on the selected JSONL branch with
  // zero Workers. Pending intent — an explicit staged choice, else the still-
  // admitted submission model — takes precedence over every baseline;
  // persisted values are the only detached fallback. In particular, do not
  // infer a model from an assistant message, use the catalog default, show the
  // first catalog entry, or replace unknown thinking with `auto`.
  const detachedBaselineModel = useMemo<{ provider: string; modelId: string } | null>(() => {
    // Existing session: only the branch-resolved JSONL value is authoritative.
    if (selectedSessionId) return transcript.persistedModel ?? null;
    // New transient home has no persisted session yet, so the project catalog
    // default is the correct creation baseline. If no default is configured,
    // offer the first visible model as a new-session choice (never as history).
    const defaultModel = modelsQuery.data?.defaultModel;
    if (defaultModel) return { provider: defaultModel.provider, modelId: defaultModel.id };
    const first = modelList[0];
    return first ? { provider: first.provider, modelId: first.id } : null;
  }, [selectedSessionId, transcript.persistedModel, modelsQuery.data, modelList]);
  // The model/thinking surfaced to ChatInput: the staged intent first, then
  // the authoritative runtime snapshot — the ATTACHED live state OR the exact
  // controller's still-valid ADMITTED snapshot (the accepted admission's
  // authoritative snapshot, installed before the submit promise resolved and
  // valid until the post-admission observation attach or any history-layer
  // transition / presentation reselect supersedes it) — else the exact branch
  // read baseline. A detached choice remains the user's pending intent until a
  // send applies it or a live control command supersedes it; an admitted intent
  // stays visible through the admission→observation gap, so neither hiding one
  // (which would display model A while the turn runs B) nor leaking it into
  // history browsing after a reselect is acceptable.
  const runtimeState = exact?.snapshot?.state ?? null;
  const runtimeSettingsEligible = live || exact?.hasAdmittedSnapshot === true;
  const model = stagedModel !== null
    ? stagedModel
    : runtimeSettingsEligible
      ? (runtimeState?.model ? { provider: runtimeState.model.provider, modelId: runtimeState.model.id } : null)
      : detachedBaselineModel;
  const isAutoModelSelection = model === null;
  const thinkingLevel: ThinkingLevelOption | undefined = live
    ? toLiveThinkingLevelOption(state, stagedThinking, exact?.createdWithAutoThinking === true)
    : (stagedThinking
      ?? (runtimeSettingsEligible && runtimeState?.thinkingLevel !== undefined && runtimeState.thinkingLevel !== null
        ? runtimeState.thinkingLevel
        : undefined)
      ?? (selectedSessionId ? transcript.persistedThinkingLevel : "auto")) as ThinkingLevelOption | undefined;
  // Whether the model/thinking change handlers run immediately (live, existing
  // setModel/setThinkingLevel) or only stage for the send transaction (detached).
  // Live: honor runtime.model.set even before the catalog settles. Detached /
  // empty-home: stage against the Host catalog so the selector stays visible
  // without attaching a Worker — only when the catalog actually has models.
  const modelChangeInteractive = live
    ? hasModelSet && canModels
    : canModels && modelList.length > 0;
  // Existing detached sessions with an older/missing v2 settings projection
  // are unknown, not `auto`. Hide the control until the selected branch read
  // resolves; a staged explicit choice remains visible. New-session home keeps
  // the creation-time `auto` choice because no persisted session exists yet.
  const thinkingChangeInteractive = live
    ? hasThinkingSet
    : selectedSessionId === null || stagedThinking !== null || transcript.persistedThinkingLevel !== undefined;

  const inputHistory = useMemo(() => getUserInputTexts(transcriptMessages), [transcriptMessages]);

  const queuedMessages = useMemo<QueuedMessagesView | null>(
    () => (live ? toQueuedMessagesView(state?.queuedMessages) : null),
    [live, state?.queuedMessages],
  );

  // --- serialized runtime info reads (single ordinary-command slot) ---------
  // Stats is an independent UI projection that shares the runtime's ONE
  // ordinary command slot. Read it outside an activation-then-send transaction
  // so it can never race the first prompt. Explicit lifecycle signals drive
  // refresh; stream deltas do not (stable method refs + primitive signals).
  // LIVE ONLY: a detached (read-only) selected session NEVER reads a
  // background same-id Worker's stats for its footer — a long-lived worker can
  // hold a different in-memory branch than the persisted JSONL being viewed,
  // so its counts/usage would describe another branch (the exact inconsistency
  // this fix removes). History totals derive from the complete persisted
  // branch (transcript) and context usage from the history assembler below.
  const [sessionStatsData, setSessionStatsData] = useState<{
    sessionId: string;
    stats: import("@fffattiger/pix-protocol").SessionStats;
  } | null>(null);
  const runtimeInfoGenRef = useRef(0);
  const exactAttachGeneration = exact?.attachGeneration;
  const exactPromptPending = exact?.promptPending;
  const exactGetSessionStats = exact?.getSessionStats;
  useEffect(() => {
    if (!liveWorkspaceEnabled || !selectedSessionId || !live) {
      setSessionStatsData(null);
      return;
    }
    if (exactPromptPending) return;
    const readStats = hasStats && exactGetSessionStats ? exactGetSessionStats : null;
    if (readStats === null) {
      setSessionStatsData(null);
      return;
    }
    const generation = ++runtimeInfoGenRef.current;
    let cancelled = false;
    const current = (): boolean => !cancelled && generation === runtimeInfoGenRef.current;
    void readStats().then(
      (stats) => {
        if (current()) setSessionStatsData({ sessionId: selectedSessionId, stats });
      },
      () => {
        // Honest degradation: a stopped/rekeyed/unsupported live read exposes
        // no percentage; never retain another session's value or guess zero.
        if (current()) setSessionStatsData(null);
      },
    );
    return () => { cancelled = true; };
  }, [
    liveWorkspaceEnabled,
    selectedSessionId,
    live,
    hasStats,
    exactAttachGeneration,
    exactPromptPending,
    exactGetSessionStats,
  ]);

  const selectedStats = sessionStatsData?.sessionId === selectedSessionId ? sessionStatsData.stats : null;
  const sessionStats = useMemo(() => {
    if (!selectedSessionId) return null;
    if (live && state) return buildSessionStatsView(state, transcriptMessages, hasStats ? selectedStats : null);
    return buildTranscriptSessionStatsView(selectedSessionId, transcriptMessages);
  }, [selectedSessionId, live, state, transcriptMessages, hasStats, selectedStats]);
  // Context-usage consistency: ONE authority per mode, never mixed. LIVE → the
  // exact runtime projection ONLY (`state.contextUsage`, owned by the shared
  // Protocol reducer's atomic runtime_state_changed payload + worker
  // snapshots); a stale one-shot SessionStats read can never override it nor
  // fabricate a window — buildSessionStatsView keeps the same precedence.
  // DETACHED history → the SAME /sessions/:id/context read that resolved the
  // displayed persisted model provides the numerator, combined with the EXACT
  // displayed model's catalog window (a staged pending model choice included:
  // the estimated percentage always belongs to the model shown next to it).
  // No background same-id Worker is read, attached, or reloaded for this.
  const contextCatalog = useMemo<readonly ContextCatalogModel[] | undefined>(
    () => modelsQuery.data?.models.map((entry) => ({
      provider: entry.provider,
      id: entry.id,
      ...(entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow }),
    })),
    [modelsQuery.data],
  );
  // A staged choice can survive automatic observation. Until it is applied,
  // the runtime usage belongs to a different model and cannot label that choice.
  const pendingLiveModel = live && stagedModel !== null && !sameStagedModel(
    stagedModel,
    state?.model ? { provider: state.model.provider, modelId: state.model.id } : null,
  );
  const contextUsage = live
    ? pendingLiveModel ? null : toContextUsageView(state?.contextUsage)
    : assembleHistoryContextUsage({
      contextTokens: transcript.contextTokens,
      model,
      catalog: contextCatalog,
    });

  // --- slash commands (runtime get_commands) ---------------------------------
  const [slashCommands, setSlashCommands] = useState<SlashCommandInfo[] | undefined>(undefined);
  const loadSlashCommands = useCallback((): Promise<SlashCommandInfo[]> => {
    // Runtime slash commands come from the attached runtime only. A detached
    // selected session stays history-only: never admit just to render a palette.
    if (!liveWorkspaceEnabled || !live || !exact) return Promise.resolve([]);
    return exact.getCommands().then((commands) => {
      setSlashCommands([...commands]);
      return [...commands];
    });
  }, [liveWorkspaceEnabled, live, exact]);

  // Builtin slash palette = the builtins {@link handleBuiltinCommand} ACTUALLY
  // handles (single source of truth, injected into ChatInput). An unlisted
  // builtin is never offered, so picking a palette entry can never fall through
  // as a model prompt. `/compact` is ONLY offered while the runtime is live and
  // advertises the compact capability — a stale/not-yet-activated session can
  // not execute it, so it must not be offered (no silent fall-through).
  const builtinSlashCommands = useMemo(
    () => (liveWorkspaceEnabled && live && hasCompact ? [{ name: "compact", description: t("desktop.compactCommandDescription"), source: "builtin" as const }] : []),
    [liveWorkspaceEnabled, live, hasCompact, t],
  );

  // --- error surfaces (fixed copy only) ---------------------------------------
  const [compactError, setCompactError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  useEffect(() => {
    setCompactError(null);
    setSendError(null);
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

  /** Fixed copy for a send failure. A new-session draft with NO chosen project
   *  fails with `invalid_input` — say so instead of the generic failure text.
   *  Any other code keeps the generic copy (never a raw ProtocolError). */
  const describeSendFailure = useCallback((cause: unknown): string => {
    if (cause && typeof cause === "object" && "code" in cause) {
      const code = (cause as { code?: unknown }).code;
      if (code === "invalid_input") return t("desktop.selectProjectFirst");
      if (code === "unsupported_capability") {
        const message = (cause as { message?: unknown }).message;
        if (typeof message === "string" && message.length > 0) return message;
      }
    }
    return t("desktop.sendFailed");
  }, [t]);

  // --- send paths -------------------------------------------------------------
  // Sending is the ACTIVATION intent. Existing-session send uses the selected
  // exact runtime. Negotiated submit may admit without preattach; the legacy
  // path owns acquire. A brand-new first send is one coordinator state machine:
  // capture provisional staging → registry-backed create (controller authority
  // installed before resolution) → promote stage to the exact ID fail-closed →
  // invoke dynamic exact ID-bound actions over the SAME registry. Accepted
  // admission clears exact staging; definite/activation failure and uncertain
  // delivery preserve it. The draft is restored on ANY activation-phase failure
  // (proven non-delivery) and on definite dispatch failures; uncertain dispatch
  // keeps the bubble.
  const handleSend = useCallback(
    (message: string, images?: AttachedImage[], submission?: { rawValue: string }): boolean => {
      setSendError(null);
      if (selectedSessionId && !liveWorkspaceEnabled) {
        restoreDraft(message);
        setSendError(describeWorkspaceAccess(workspaceDecision, t));
        return false;
      }
      const wireImages = toImageAttachments(images);
      // The model displayed IMMEDIATELY BEFORE this send is what the turn must
      // run with, carried on the SAME atomic submit activation overrides
      // (negotiated `runtime.submit-turn.v1`): the staged choice, the detached
      // branch-resolved history default, the home catalog default, or the
      // known live authority baseline — never a side-channel set_model+prompt.
      // The finite legacy v2 shim keeps its documented staged-only semantics;
      // a missing known model is never replaced by an arbitrary fallback, and
      // a known immutable live model needs no redundant unsupported mutation.
      const carriedModel = captureSubmitModel({
        displayedModel: model,
        negotiatedSubmitTurn: submitTurnEnabled,
        stagedModel,
        live,
        modelSetSupported: hasModelSet,
        authorityModel: live && state?.model
          ? { provider: state.model.provider, modelId: state.model.id }
          : null,
      });
      const activationSettings = {
        model: carriedModel,
        thinkingLevel: stagedThinking,
      };
      const sendToExact = (
        actions: { sendPromptToSession: NonNullable<typeof exact>['sendPromptToSession'] },
        sessionId: string,
      ): Promise<unknown> => {
        lastTurnMessageRef.current.set(sessionId, message);
        // Submission identity: the exact target record's revision at send
        // time. The accepted admission consumes the staged fields only while
        // this identity still matches — an old ack can never erase a newer
        // selection, and the wrong session's key can never be settled.
        const targetKey = sessionStagingKey(sessionId);
        const submission = { revision: staging.get(targetKey)?.revision ?? null };
        const sending = actions.sendPromptToSession(
          message,
          wireImages,
          {
            // Activation settings ride the SINGLE activation transaction:
            // applied atomically with admission (negotiated v1) or after
            // attach and before the prompt (finite legacy v2 shim).
            model: activationSettings.model,
            thinkingLevel: activationSettings.thinkingLevel,
          },
        );
        void sending
          .then(() => {
            // Accepted admission: the exact controller already installed the
            // admission's authoritative snapshot BEFORE this resolve, so the
            // display holds the submitted model through the admission→
            // observation gap with no staging-side bridge. Clear ONLY the
            // captured record generation (identity fence — a newer selection,
            // including a re-selected same value, is never erased; no staged
            // record at send time is a no-op). Catalog refresh is deferred to
            // the terminal turn status on the negotiated submit seam (Phase 3):
            // the admission ack must not refresh the catalog before the message
            // commits. The legacy v2 shim has no terminal status, so it
            // refreshes at settlement as before.
            if (mountedRef.current) staging.clearMatching(targetKey, submission.revision);
            if (!submitTurnEnabled) {
              onSessionActivitySettled?.({ sessionId, cwd, firstMessage: message });
            }
          })
          .catch((cause: unknown) => {
            if (isCurrent() && (isActivationFailure(cause) || isDefiniteFailure(cause))) {
              restoreDraft(message);
              setSendError(describeSendFailure(cause));
            }
          });
        return sending;
      };
      if (selectedSessionId && exact) {
        void sendToExact(exact, selectedSessionId);
        return true;
      }
      if (!onCreateSession || firstPromptCreateRef.current) return false;
      const imageCount = images?.length ?? 0;
      const submittedValue = submission?.rawValue ?? message;
      const provisionalKey = provisionalStagingKey(homeTransactionIdRef.current);
      // Session creation allocates identity only. The first turn carries the
      // staged model/thinking as one authority-owned submitTurn intent (or the
      // explicit finite legacy v2 activation-settings shim).
      const creating = onCreateSession();
      firstPromptCreateRef.current = creating;
      void creating
        // Capture provisional staging, promote fail-closed onto the created
        // exact ID, then invoke ID-bound actions over the SAME registry BEFORE
        // promoting the URL. Creation itself never mutates model or thinking.
        .then((created) => {
          const promoted = staging.promote(provisionalKey, created.sessionId);
          if (!promoted.ok && promoted.error.code !== "not_found") {
            throw promoted.error;
          }
          const createdActions = exactActionsFor(created.sessionId);
          void sendToExact(createdActions, created.sessionId);
          inputRef.current?.promoteDraft(created.sessionId, submittedValue, imageCount);
          onCreatedSessionDispatched?.({ ...created, firstMessage: message });
        })
        .catch((cause: unknown) => {
          // The transient draft was deliberately NOT cleared during create, so
          // a proven failure leaves the exact user input in place. Staging is
          // preserved (no clear).
          if (isCurrent() && (isActivationFailure(cause) || isDefiniteFailure(cause))) {
            restoreDraft(message);
            setSendError(describeSendFailure(cause));
          }
        })
        .finally(() => {
          if (firstPromptCreateRef.current === creating) firstPromptCreateRef.current = null;
        });
      return false;
    },
    [selectedSessionId, exact, exactActionsFor, isCurrent, restoreDraft, isActivationFailure, isDefiniteFailure, describeSendFailure, stagedModel, stagedThinking, model, live, hasModelSet, state, transcript.persistedModel, staging, submitTurnEnabled, onCreateSession, onCreatedSessionDispatched, onSessionActivitySettled, cwd, liveWorkspaceEnabled, workspaceDecision, t],
  );

  // Phase 3: the catalog refresh is deferred to COMMITTED/TERMINAL turn status
  // (never the fast admission ack). When a turn for the selected session
  // reaches completed/failed, publish the session activity so AppShell
  // revalidates the catalog with the now-persisted message.
  useEffect(() => {
    if (!onSessionActivitySettled || !selectedSessionId) return undefined;
    const firstMessage = lastTurnMessageRef.current.get(selectedSessionId);
    const actions = exact ?? exactActionsFor(selectedSessionId);
    return actions.subscribeTurnTerminal((terminal) => {
      if (terminal.sessionId !== selectedSessionId) return;
      onSessionActivitySettled?.({
        sessionId: terminal.sessionId,
        cwd,
        firstMessage: lastTurnMessageRef.current.get(terminal.sessionId) ?? firstMessage ?? "",
      });
    });
  }, [exact, exactActionsFor, onSessionActivitySettled, selectedSessionId, cwd]);

  // Auto title generation (Settings → Chat → “自动生成标题”): fires ONCE per
  // session id per page load on the first COMPLETED turn of an untitled
  // session, when the toggle is armed. The configured title model wins;
  // without one the Worker uses the session's current model.
  // The command rides the ordinary lane after the turn released it; a failure
  // is honest degradation (no auto title this load, no retry loop, no fake
  // success) and never clobbers an existing title (guarded by
  // selectedSessionHasTitle from the authoritative catalog row).
  useEffect(() => {
    if (!exact || !selectedSessionId) return undefined;
    return exact.subscribeTurnTerminal((terminal) => {
      if (terminal.sessionId !== selectedSessionId) return;
      if (terminal.state !== "completed") return;
      if (selectedSessionHasTitle) return;
      if (!isAutoTitleArmed()) return;
      if (autoTitleFiredRef.current.has(terminal.sessionId)) return;
      autoTitleFiredRef.current.add(terminal.sessionId);
      // Same model policy as the manual smart rename: the configured title
      // model wins, otherwise null lets the Worker use the session's current
      // model (never a silent skip).
      requestSessionTitle(exact, configuredTitleModel())
        .then(() => { applyGeneratedTitle(terminal.sessionId); })
        .catch(() => {
          // Honest degradation: leave the session untitled; manual smart
          // rename remains available from the session context menu.
        });
    });
  }, [exact, selectedSessionId, selectedSessionHasTitle, applyGeneratedTitle]);

  const handleSteer = useCallback(
    (message: string, images?: AttachedImage[]) => {
      if (!liveWorkspaceEnabled || !hasSteer || !exact) return;
      exact.steer(message, toImageAttachments(images)).catch((cause: unknown) => {
        if (isCurrent() && isDefiniteFailure(cause)) restoreDraft(message);
      });
    },
    [liveWorkspaceEnabled, hasSteer, exact, isCurrent, restoreDraft, isDefiniteFailure],
  );

  const handleFollowUp = useCallback(
    (message: string, images?: AttachedImage[]) => {
      if (!liveWorkspaceEnabled || !hasFollowUp || !exact) return;
      exact.followUp(message, toImageAttachments(images)).catch((cause: unknown) => {
        if (isCurrent() && isDefiniteFailure(cause)) restoreDraft(message);
      });
    },
    [liveWorkspaceEnabled, hasFollowUp, exact, isCurrent, restoreDraft, isDefiniteFailure],
  );

  const handlePromptWithStreamingBehavior = useCallback(
    (message: string, behavior: "steer" | "followUp", images?: AttachedImage[]) => {
      if (behavior === "steer") handleSteer(message, images);
      else handleFollowUp(message, images);
    },
    [handleSteer, handleFollowUp],
  );

  const handleAbort = useCallback(() => {
    if (!liveWorkspaceEnabled || !exact) return;
    void exact.abort().catch(() => undefined);
  }, [liveWorkspaceEnabled, exact]);

  const handleBash = useCallback(
    (command: string, excludeFromContext: boolean) => {
      if (!liveWorkspaceEnabled || !hasBash || !exact) return;
      void exact.runBash(command, { excludeFromContext }).catch(() => undefined);
    },
    [liveWorkspaceEnabled, hasBash, exact],
  );

  const handleAbortCompaction = useCallback(() => {
    if (!liveWorkspaceEnabled || !hasCompactAbort || !exact) return;
    void exact.abortCompaction().catch(() => undefined);
  }, [liveWorkspaceEnabled, hasCompactAbort, exact]);

  const handleCompact = useCallback(() => {
    if (!selectedSessionId || !exact || (live && !hasCompact)) return;
    if (!liveWorkspaceEnabled) {
      setCompactError(describeWorkspaceAccess(workspaceDecision, t));
      return;
    }
    setCompactError(null);
    void (async () => {
      try {
        // Selecting a tab stays read-only; clicking Compact is an explicit
        // activation intent, matching the source desktop's per-session action.
        // LC-02: the cold path uses the negotiated explicit activate envelope →
        // observation (never the legacy acquiring attach); a missing feature
        // rejects honestly with `unsupported_capability`.
        if (!live || exact.sessionId !== selectedSessionId) {
          await exact.activateAndObserve();
        }
        await exact.compact();
      } catch (cause) {
        if (isCurrent()) setCompactError(describeUnavailable(cause, t));
      }
    })();
  }, [selectedSessionId, live, hasCompact, exact, isCurrent, liveWorkspaceEnabled, workspaceDecision, t]);

  const handleModelChange = useCallback(
    (provider: string, modelId: string) => {
      if (!liveWorkspaceEnabled) return;
      if (live) {
        // LIVE selected session: keep the existing immediate setModel behavior
        // (capability-gated). Success clears ONLY the matching staged field;
        // failure preserves it.
        if (!hasModelSet || !exact) return;
        exact
          .setModel(provider, modelId)
          .then(() => {
            if (!isCurrent()) return undefined;
            clearStagedModel();
            return exact.fetchSnapshot();
          })
          .catch(() => undefined);
        return;
      }
      // DETACHED selected session: stage ONLY — no runtime command/attach here.
      // The staged model is applied by the send transaction (after attach,
      // before the prompt).
      stageModel(provider, modelId);
    },
    [liveWorkspaceEnabled, live, hasModelSet, exact, isCurrent, stageModel, clearStagedModel],
  );

  const handleThinkingLevelChange = useCallback(
    (level: ThinkingLevelOption) => {
      if (!liveWorkspaceEnabled) return;
      if (live) {
        // LIVE selected session: keep the existing immediate setThinkingLevel
        // behavior. The Protocol has no "auto" level (no unpin command exists);
        // the auto option stays display-only until the runtime grows an explicit
        // unpin. Success clears ONLY the matching staged field; failure preserves it.
        if (!hasThinkingSet || level === "auto" || !exact) return;
        exact
          .setThinkingLevel(level as ThinkingLevel)
          .then(() => {
            if (!isCurrent()) return undefined;
            clearStagedThinking();
            return exact.fetchSnapshot();
          })
          .catch(() => undefined);
        return;
      }
      // DETACHED selected session: stage ONLY — no runtime command/attach here.
      // "auto" is the neutral detached baseline: staging it clears the staged
      // thinking back to `auto` (nothing is sent on the next send).
      stageThinking(level === "auto" ? null : (level as ThinkingLevel));
    },
    [liveWorkspaceEnabled, live, hasThinkingSet, exact, isCurrent, stageThinking, clearStagedThinking],
  );

  const handleRecallQueue = useCallback(() => {
    if (!liveWorkspaceEnabled || !hasQueue || !exact) return;
    const queued = queuedMessages;
    void exact
      .clearQueue()
      .then(() => {
        if (!isCurrent() || !queued) return;
        const text = [...queued.steering, ...queued.followUp].reverse().join("\n");
        if (text) inputRef.current?.insertIfEmpty(text);
      })
      .catch(() => undefined);
  }, [liveWorkspaceEnabled, hasQueue, queuedMessages, exact, isCurrent]);

  const handleBuiltinCommand = useCallback(
    async (message: string): Promise<BuiltinSlashCommandResult> => {
      const [raw] = message.split(/\s+/);
      const command = raw ?? "/";
      const args = message.slice(command.length).trim();
      if (command === "/compact") {
        if (!liveWorkspaceEnabled) {
          const copy = describeWorkspaceAccess(workspaceDecision, t);
          if (isCurrent()) setCompactError(copy);
          return { handled: true, error: copy };
        }
        if (!hasCompact || !exact) return { handled: false };
        try {
          await exact.compact(args.length > 0 ? args : undefined);
          return { handled: true };
        } catch (cause) {
          const copy = describeUnavailable(cause, t);
          if (isCurrent()) setCompactError(copy);
          return { handled: true, error: copy };
        }
      }
      return { handled: false };
    },
    [liveWorkspaceEnabled, workspaceDecision, hasCompact, exact, isCurrent, t],
  );

  const handleBranchLeafChange = useCallback(
    (leafId: string | null) => {
      if (!liveWorkspaceEnabled || !hasNavigate || !live || !leafId || !exact) return;
      void exact
        .navigateTree(leafId)
        .then(() => (isCurrent() ? exact.fetchSnapshot() : undefined))
        .then(() => treeQuery.refetch())
        .catch(() => undefined);
    },
    [liveWorkspaceEnabled, hasNavigate, live, exact, isCurrent, treeQuery],
  );

  // --- adapter loaders (Host routes only; no invented endpoints) --------------
  const resourcesApi = useMemo(() => createResourcesApi(http), [http]);
  const configurationApi = useMemo(() => createConfigurationApi(http), [http]);
  const listFiles = useCallback(
    (targetCwd: string) => {
      if (!liveWorkspaceEnabled) return Promise.reject(workspaceAccessBoundary(workspaceDecision, t));
      return resourcesApi.files.index(targetCwd).then((data) => ("files" in data ? data : { files: [], truncated: true }));
    },
    [resourcesApi, liveWorkspaceEnabled, workspaceDecision, t],
  );
  const searchFiles = useCallback(
    (targetCwd: string, query: string) => {
      if (!liveWorkspaceEnabled) return Promise.reject(workspaceAccessBoundary(workspaceDecision, t));
      return resourcesApi.files
        .index(targetCwd, query)
        .then((data): { matches?: FileIndexEntry[] } => ("matches" in data ? { matches: [...data.matches] } : {}));
    },
    [resourcesApi, liveWorkspaceEnabled, workspaceDecision, t],
  );
  const listSkills = useCallback(
    (targetCwd: string) => {
      if (!liveWorkspaceEnabled || !canSkills) return Promise.resolve(null);
      return configurationApi.skills
        .list(targetCwd)
        .then((data) => ({ skills: data.skills.map((skill) => ({ name: skill.name, disableModelInvocation: !skill.enabled })) }));
    },
    [configurationApi, canSkills, liveWorkspaceEnabled],
  );
  const uploadFiles = useCallback(
    (files: File[], targetCwd: string) => {
      if (!liveWorkspaceEnabled) return Promise.reject(workspaceAccessBoundary(workspaceDecision, t));
      return resourcesApi.files
        .upload({ directory: targetCwd, files })
        .then((result) => {
          if (result.errors.length > 0) {
            throw new Error("Upload failed");
          }
          return result.uploaded;
        });
    },
    [resourcesApi, liveWorkspaceEnabled, workspaceDecision, t],
  );

  // Genuine global inability only: the host has no agent capability. An empty
  // home (no selected session) still mounts the exact ChatInput so the user can
  // pick a model and start a conversation; send creates then activates.
  const disabledReason = !canAgent
    ? "host has no agent capability"
    : (selectedSessionId && !liveWorkspaceEnabled ? describeWorkspaceAccess(workspaceDecision, t) : "");
  const canOfferCompact = liveWorkspaceEnabled && Boolean(selectedSessionId) && (!live || hasCompact);
  const workspaceAccessCopy = selectedSessionId && !liveWorkspaceEnabled
    ? describeWorkspaceAccess(workspaceDecision, t)
    : null;

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
        sendDisabled={!liveWorkspaceEnabled && Boolean(selectedSessionId)}
        {...(hasBash && liveWorkspaceEnabled ? { onBash: handleBash } : {})}
        onAbort={handleAbort}
        {...(hasSteer && liveWorkspaceEnabled ? { onSteer: handleSteer } : {})}
        {...(hasFollowUp && liveWorkspaceEnabled ? { onFollowUp: handleFollowUp } : {})}
        {...(liveWorkspaceEnabled && (hasSteer || hasFollowUp) ? { onPromptWithStreamingBehavior: handlePromptWithStreamingBehavior } : {})}
        isStreaming={promptRunning}
        isCompacting={isCompacting}
        {...(liveWorkspaceEnabled && hasCompactAbort ? { onAbortCompaction: handleAbortCompaction } : {})}
        model={model}
        isAutoModelSelection={isAutoModelSelection}
        modelNames={modelNames}
        modelList={modelList}
        {...(liveWorkspaceEnabled && modelChangeInteractive ? { onModelChange: handleModelChange } : {})}
        {...(thinkingLevel === undefined ? {} : { thinkingLevel })}
        {...(liveWorkspaceEnabled && thinkingChangeInteractive ? { onThinkingLevelChange: handleThinkingLevelChange } : {})}
        availableThinkingLevels={null}
        retryInfo={null}
        queuedMessages={queuedMessages}
        inputHistory={inputHistory}
        {...(liveWorkspaceEnabled && hasQueue ? { onRecallQueue: handleRecallQueue } : {})}
        {...(slashCommands === undefined ? {} : { slashCommands })}
        slashCommandsLoading={false}
        onLoadSlashCommands={loadSlashCommands}
        onBuiltinCommand={handleBuiltinCommand}
        builtinSlashCommands={builtinSlashCommands}
        onAudioUnlock={unlockAudio}
        {...(draftKey === undefined ? {} : { draftKey })}
        cwd={cwd}
        {...(onProjectChange && projectRoots ? { projectRoots, onProjectChange } : {})}
        messagesScrollRef={transcriptScrollRef}
        {...(liveWorkspaceEnabled && canFilesIndex ? { listFiles, searchFiles } : {})}
        {...(liveWorkspaceEnabled && canSkills ? { listSkills } : {})}
        {...(liveWorkspaceEnabled && canUpload ? { uploadFiles } : {})}
        fileIndexSnapshot={fileIndexSnapshot}
        skillNames={skillNames}
      />
      {workspaceAccessCopy || sendError ? (
        <div role="alert" aria-live="polite" style={{ padding: "6px 16px 0", color: "var(--status-danger)", fontSize: 12 }}>
          {sendError ?? workspaceAccessCopy}
        </div>
      ) : null}
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
