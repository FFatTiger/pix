/**
 * RuntimeProvider — wires the {@link SessionStore} into the React tree.
 *
 * Realtime runtime state flows through `useSyncExternalStore` (NOT TanStack
 * Query), mirroring the HttpClientProvider pattern: the provider constructs the
 * store once with browser IO deps and disposes it on unmount. The store is
 * exposed via context; components read the immutable {@link RuntimeView} and
 * invoke lifecycle/command actions.
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { ClientIdentity, ClientPlatform, ImageAttachment } from "@fffattiger/pix-protocol";
import {
  SessionStore,
  type RuntimeView,
  type PromptActivationSettings,
  type SessionStoreOptions,
} from "./session-store.js";
import { createDefaultIdFactory } from "./correlation.js";
import {
  createBrowserWebSocket,
  type RuntimeSocketDeps,
} from "./socket.js";

/** Fresh command ids for the read-only UI helper (navigateTree). */
const uiCommandId = createDefaultIdFactory();
/** Detect the client shell (pwa when running standalone) and platform. */
export function detectClientIdentity(navigatorLike: Navigator, matchMedia?: (q: string) => { matches: boolean }): ClientIdentity {
  const isStandalone = typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches;
  const shell = isStandalone ? "pwa" : "web";
  const platform = detectPlatform(navigatorLike);
  return { shell, platform };
}

function detectPlatform(navigatorLike: Navigator): ClientPlatform {
  const ua = navigatorLike.userAgent ?? "";
  if (/Win/i.test(ua)) return "win";
  if (/Mac/i.test(ua)) return "mac";
  if (/Linux/i.test(ua)) return "linux";
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "unknown";
}

/**
 * Build browser IO deps for the socket. All globals are read here so tests can
 * inject overrides via {@link RuntimeProviderProps.deps}.
 */
export function createBrowserSocketDeps(overrides: Partial<RuntimeSocketDeps> = {}): RuntimeSocketDeps {
  const identity = overrides.identity ?? detectClientIdentity(globalThis.navigator, (q) => globalThis.matchMedia?.(q) ?? { matches: false });
  return {
    createWebSocket: overrides.createWebSocket ?? createBrowserWebSocket,
    now: overrides.now ?? (() => Date.now()),
    setTimeout: overrides.setTimeout ?? ((fn, ms) => setTimeout(fn, ms)),
    clearTimeout: overrides.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)),
    random: overrides.random ?? Math.random,
    location: overrides.location ?? globalThis.location,
    identity,
    onOnline: overrides.onOnline ?? ((cb) => {
      globalThis.addEventListener("online", cb);
      return () => globalThis.removeEventListener("online", cb);
    }),
    onVisible: overrides.onVisible ?? ((cb) => {
      const handler = (): void => { if (globalThis.document.visibilityState === "visible") cb(); };
      globalThis.document.addEventListener("visibilitychange", handler);
      return () => globalThis.document.removeEventListener("visibilitychange", handler);
    }),
    ...(overrides.features === undefined ? {} : { features: overrides.features }),
  };
}

interface RuntimeContextValue {
  readonly store: SessionStore;
}

const RuntimeContext = createContext<RuntimeContextValue | null>(null);

export interface RuntimeProviderProps {
  children: ReactNode;
  /** Override socket IO deps (tests). */
  readonly deps?: Partial<RuntimeSocketDeps>;
  readonly options?: SessionStoreOptions;
}

export function RuntimeProvider({ children, deps, options }: RuntimeProviderProps) {
  const [value] = useState<RuntimeContextValue>(() => {
    const socketDeps = createBrowserSocketDeps(deps);
    const store = new SessionStore(socketDeps, options);
    return { store };
  });
  // Dispose the store (close socket + detach hooks) on unmount. NEVER runtime.stop.
  useEffect(() => () => value.store.dispose(), [value]);
  return <RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>;
}

/** Access the raw store (advanced). */
export function useRuntimeStore(): SessionStore {
  const ctx = useContext(RuntimeContext);
  if (!ctx) throw new Error("useRuntimeStore must be used within RuntimeProvider");
  return ctx.store;
}

/** Reactive runtime view + bound lifecycle/command actions. */
export interface RuntimeApi extends RuntimeView {
  readonly connect: () => void;
  readonly createSession: SessionStore["createSession"];
  readonly openSession: SessionStore["openSession"];
  readonly detach: SessionStore["detach"];
  readonly stop: SessionStore["stop"];
  readonly fetchSnapshot: SessionStore["fetchSnapshot"];
  readonly sendCommand: SessionStore["sendCommand"];
  readonly sendPrompt: (message: string, images?: readonly ImageAttachment[]) => Promise<unknown>;
  /**
   * Activation-then-send (single state machine in the store): ensure the exact
   * `sessionId` is attached (open if absent/stale/stopped; detach+open if a
   * different session is attached), await the authoritative attach, apply any
   * optional staged activation settings (model, then thinking level — the ONLY
   * transport for detached Composer staging) in deterministic order, then send
   * the prompt exactly once. Optimistic bubble/overlay are preserved through
   * activation; definite activation failure (incl. a staged-settings failure)
   * removes the phantom bubble and rejects (Composer retains the draft and
   * preserves the staged settings); never creates a session.
   */
  readonly sendPromptToSession: (sessionId: string, message: string, images?: readonly ImageAttachment[], activationSettings?: PromptActivationSettings) => Promise<unknown>;
  readonly respondExtensionUi: SessionStore["respondExtensionUi"];
  readonly sendExtensionUiInput: SessionStore["sendExtensionUiInput"];
  readonly steer: SessionStore["steer"];
  readonly followUp: SessionStore["followUp"];
  readonly clearQueue: SessionStore["clearQueue"];
  readonly runBash: SessionStore["runBash"];
  readonly abortBash: SessionStore["abortBash"];
  readonly abort: SessionStore["abort"];
  readonly getState: SessionStore["getState"];
  readonly getCommands: SessionStore["getCommands"];
  readonly getLastAssistantText: SessionStore["getLastAssistantText"];
  readonly getSessionStats: SessionStore["getSessionStats"];
  readonly setSessionName: SessionStore["setSessionName"];
  readonly setThinkingLevel: SessionStore["setThinkingLevel"];
  readonly setModel: SessionStore["setModel"];
  readonly getTools: SessionStore["getTools"];
  readonly setTools: SessionStore["setTools"];
  readonly reload: SessionStore["reload"];
  readonly compact: SessionStore["compact"];
  readonly abortCompaction: SessionStore["abortCompaction"];
  /**
   * Read-only UI helper: navigate the LIVE session tree to a leaf entry via
   * the ordinary `navigate_tree` runtime command. Reuses {@link
   * SessionStore.sendCommand} (same single-in-flight slot, at-most-once
   * commandId correlation) — no store/protocol semantics are added here. The
   * caller gates on the `runtime.navigate` capability.
   */
  readonly navigateTree: (targetId: string) => Promise<unknown>;
}

export function useRuntime(): RuntimeApi {
  const store = useRuntimeStore();
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  // Stable command API shell — created ONCE per store so command identity is
  // stable across stream events (the reactive `view` changes on every notify;
  // the methods must NOT). Composer's stats/tools reads key on explicit
  // lifecycle signals (attachGeneration / sessionId) + these stable methods, so
  // they never refire on every streaming delta. Only the reactive view fields
  // are refreshed per notify via the `{ ...api, ...view }` merge below.
  const apiRef = useRef<RuntimeApi | null>(null);
  if (apiRef.current === null) {
    const api: RuntimeApi = {
      ...view,
      connect: () => store.connect(),
      createSession: (params) => store.createSession(params),
      openSession: (sessionId) => store.openSession(sessionId),
      detach: () => store.detach(),
      stop: (reason) => store.stop(reason),
      fetchSnapshot: () => store.fetchSnapshot(),
      sendCommand: (command) => store.sendCommand(command),
      // Images ride the same optimistic prompt path as text (parity): the store
      // mints the commandId and appends the speculative user bubble + running
      // overlay for BOTH text-only and image sends.
      sendPrompt: (message, images) => store.sendPrompt(message, images),
      sendPromptToSession: (sessionId, message, images, activationSettings) => store.sendPromptToSession(sessionId, message, images, activationSettings),
      respondExtensionUi: (request, reply) => store.respondExtensionUi(request, reply),
      sendExtensionUiInput: (request, data) => store.sendExtensionUiInput(request, data),
      steer: (message, images) => store.steer(message, images),
      followUp: (message, images) => store.followUp(message, images),
      clearQueue: () => store.clearQueue(),
      runBash: (command, options) => store.runBash(command, options),
      abortBash: () => store.abortBash(),
      abort: () => store.abort(),
      getState: () => store.getState(),
      getCommands: () => store.getCommands(),
      getLastAssistantText: () => store.getLastAssistantText(),
      getSessionStats: () => store.getSessionStats(),
      setSessionName: (name) => store.setSessionName(name),
      setThinkingLevel: (level) => store.setThinkingLevel(level),
      setModel: (provider, modelId) => store.setModel(provider, modelId),
      getTools: () => store.getTools(),
      setTools: (names) => store.setTools(names),
      reload: () => store.reload(),
      compact: (customInstructions) => store.compact(customInstructions),
      abortCompaction: () => store.abortCompaction(),
      navigateTree: (targetId) =>
        store.sendCommand({ commandId: uiCommandId(), type: "navigate_tree", targetId }),
    };
    apiRef.current = api;
  }
  return useMemo<RuntimeApi>(
    // Refresh the reactive view fields onto the stable API shell; the methods
    // keep the same reference, so only the view part changes identity.
    () => ({ ...apiRef.current!, ...view }),
    [apiRef, view],
  );
}
