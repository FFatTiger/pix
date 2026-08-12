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
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { ClientIdentity, ClientPlatform } from "@fffattiger/pix-protocol";
import {
  SessionStore,
  type RuntimeView,
  type SessionStoreOptions,
} from "./session-store.js";
import {
  createBrowserWebSocket,
  type RuntimeSocketDeps,
} from "./socket.js";

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
  readonly sendPrompt: SessionStore["sendPrompt"];
  readonly abort: SessionStore["abort"];
  readonly getState: SessionStore["getState"];
  readonly getCommands: SessionStore["getCommands"];
  readonly getLastAssistantText: SessionStore["getLastAssistantText"];
  readonly getSessionStats: SessionStore["getSessionStats"];
  readonly setSessionName: SessionStore["setSessionName"];
  readonly setThinkingLevel: SessionStore["setThinkingLevel"];
}

export function useRuntime(): RuntimeApi {
  const store = useRuntimeStore();
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return useMemo<RuntimeApi>(
    () =>
      ({
        ...view,
        connect: () => store.connect(),
        createSession: (params) => store.createSession(params),
        openSession: (sessionId) => store.openSession(sessionId),
        detach: () => store.detach(),
        stop: (reason) => store.stop(reason),
        fetchSnapshot: () => store.fetchSnapshot(),
        sendCommand: (command) => store.sendCommand(command),
        sendPrompt: (message) => store.sendPrompt(message),
        abort: () => store.abort(),
        getState: () => store.getState(),
        getCommands: () => store.getCommands(),
        getLastAssistantText: () => store.getLastAssistantText(),
        getSessionStats: () => store.getSessionStats(),
        setSessionName: (name) => store.setSessionName(name),
        setThinkingLevel: (level) => store.setThinkingLevel(level),
      }) as RuntimeApi,
    [store, view],
  );
}
