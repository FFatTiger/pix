/**
 * RuntimeProvider — wires the provider-owned RuntimeConnection +
 * SessionControllerRegistry into the React tree.
 *
 * Realtime runtime state flows through `useSyncExternalStore` (NOT TanStack
 * Query), mirroring the HttpClientProvider pattern: the provider constructs the
 * sole connection + registry once with browser IO deps and disposes them on
 * unmount. The owners are exposed via context; components read the exact
 * per-session {@link ExactRuntimeView} / connection-global surfaces and invoke
 * ID-bound lifecycle/command actions (no facade).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { ClientIdentity, ClientPlatform } from "@fffattiger/pix-protocol";
import {
  createBrowserWebSocket,
  type RuntimeSocketDeps,
} from "./socket.js";
import { RuntimeConnection } from "./runtime-connection.js";
import {
  SessionControllerRegistry,
  type RuntimeForegroundActivity,
  type SessionControllerRegistryOptions,
} from "./session-controller-registry.js";
import type { ControllerView } from "./session-controller.js";
import {
  createExactActions,
  emptyExactView,
  projectExactView,
  type ExactRuntimeApi,
  type ExactRuntimeView,
  type RuntimeConnectionApi,
} from "./exact-runtime.js";

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
  /** The ONE RuntimeConnection owned by the provider (also owned by nothing else). */
  readonly connection: RuntimeConnection;
  /** The ONE SessionControllerRegistry owned by the provider (also owned by nothing else). */
  readonly registry: SessionControllerRegistry;
}

const RuntimeContext = createContext<RuntimeContextValue | null>(null);

export interface RuntimeProviderProps {
  children: ReactNode;
  /** Override socket IO deps (tests). */
  readonly deps?: Partial<RuntimeSocketDeps>;
  readonly options?: SessionControllerRegistryOptions;
}

export function RuntimeProvider({ children, deps, options }: RuntimeProviderProps) {
  const [value] = useState<RuntimeContextValue>(() => {
    const socketDeps = createBrowserSocketDeps(deps);
    // RuntimeProvider OWNS exactly one RuntimeConnection and one
    // SessionControllerRegistry. The exact React hooks + the test-only
    // TestRuntimeStore only project/delegate these SAME owners; no second
    // connection/registry/lease/selection/staging/admission owner exists.
    const connection = new RuntimeConnection(socketDeps, {
      ...(options?.controllerOptions?.id === undefined ? {} : { id: options.controllerOptions.id }),
      ...(options?.controllerOptions?.setTimeout === undefined ? {} : { setTimeout: options.controllerOptions.setTimeout }),
      ...(options?.controllerOptions?.clearTimeout === undefined ? {} : { clearTimeout: options.controllerOptions.clearTimeout }),
    });
    const registry = new SessionControllerRegistry(connection, options);
    return { connection, registry };
  });
  // The owner is INTENTIONALLY IMMUTABLE: `deps`/`options` are read only in the
  // useState initializer, so rerendering the provider with different props never
  // rebuilds the connection/registry (documented + tested). Teardown uses the
  // StrictMode-safe deferred disposal below.
  useStrictModeSafeOwnerDispose(value);
  return <RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>;
}

/**
 * StrictMode-safe deferred owner disposal (Phase 4A.3.2a F1 fix).
 *
 * `main.tsx` renders under React `<StrictMode>`, whose simulated
 * mount→cleanup→setup on the INITIAL mount would permanently dispose the sole
 * registry/connection if the effect cleanup disposed synchronously. This hook
 * defers disposal to a microtask and cancels it when the SAME owner identity is
 * re-set up before the microtask flushes (StrictMode's second setup of the same
 * identity increments its version first).
 *
 * Mechanism (per-owner identity versioning, no timers/sleeps, no global
 * singleton):
 *  - a WeakMap keyed by the exact owner object tracks its setup version;
 *  - effect setup increments that version;
 *  - cleanup captures the version and queues a microtask;
 *  - the microtask disposes ONLY if that SAME owner identity still holds the
 *    cleanup's version (StrictMode second setup cancels the simulated cleanup; a
 *    NEW different owner identity does NOT cancel the old owner's real cleanup);
 *  - the owner is marked disposed (WeakMap entry deleted) before dispose so
 *    teardown (adapter unsubscribe + registry.dispose) runs EXACTLY ONCE.
 *
 * Because the provider owner is immutable (useState initializer), a real
 * unmount is the only way an owner's cleanup is followed by no re-setup, so
 * real teardown always runs on the microtask flush. Never runtime.stop.
 */
function useStrictModeSafeOwnerDispose(value: RuntimeContextValue): void {
  const versionsRef = useRef<WeakMap<object, number>>(new WeakMap());
  useEffect(() => {
    const versions = versionsRef.current;
    const key = value as unknown as object;
    const version = (versions.get(key) ?? 0) + 1;
    versions.set(key, version);
    return () => {
      const disposeVersion = version;
      queueMicrotask(() => {
        // Same owner identity re-set up before this microtask flushed
        // (StrictMode simulated cleanup): cancelled — keep the owner alive.
        if (versionsRef.current.get(key) !== disposeVersion) return;
        // Mark disposed exactly once, then run adapter cleanup + registry
        // teardown (one socket close).
        versionsRef.current.delete(key);
        value.registry.dispose();
      });
    };
  }, [value]);
}

/** Access the single provider-owned connection + registry (non-owning read). */
export function useRuntimeOwners(): RuntimeContextValue {
  const ctx = useContext(RuntimeContext);
  if (!ctx) throw new Error("useRuntimeOwners must be used within RuntimeProvider");
  return ctx;
}

// -------------------------------------------------------------------------
// Phase 4A.3.2a exact React APIs
// -------------------------------------------------------------------------

/**
 * useRuntimeConnection — reactive connection-global surface + stable actions.
 *
 * Reads the provider-owned RuntimeConnection via useSyncExternalStore and
 * exposes ONLY global fields (state/generation/host/features/error/fatal/
 * running+live ids/known) plus a stable `connect` and a registry-backed
 * `createSession`. No exact/lease/selection actions — those belong to
 * `useRuntime(sessionId)` / `useSelectedRuntime`.
 */
const EMPTY_FOREGROUND_ACTIVITY: RuntimeForegroundActivity = { optimisticRunningSessionId: null };

/**
 * useRuntimeForegroundActivity — GLOBAL indicator-only optimistic/turn owner.
 *
 * Reads the provider-owned registry via useSyncExternalStore and exposes only
 * `{ optimisticRunningSessionId }`. Never selected/current/lease fallback and
 * never a lifecycle owner. AppShell unions this into running cues; selected
 * transcript/composer never treat it as selected snapshot. Method/view refs
 * are stable between real foreground-id changes.
 */
export function useRuntimeForegroundActivity(): RuntimeForegroundActivity {
  const { registry } = useRuntimeOwners();
  const cacheRef = useRef<RuntimeForegroundActivity>(EMPTY_FOREGROUND_ACTIVITY);
  const getSnapshot = useCallback((): RuntimeForegroundActivity => {
    const next = registry.getForegroundActivity();
    const cache = cacheRef.current;
    if (cache.optimisticRunningSessionId === next.optimisticRunningSessionId) return cache;
    cacheRef.current = next;
    return next;
  }, [registry]);
  return useSyncExternalStore(registry.subscribe, getSnapshot, getSnapshot);
}

export function useRuntimeConnection(): RuntimeConnectionApi {
  const { connection, registry } = useRuntimeOwners();
  const view = useSyncExternalStore(connection.subscribe, connection.getSnapshot, connection.getSnapshot);
  // Stable actions — created ONCE per connection/registry so action identity is
  // stable across transport updates (only the reactive view fields refresh).
  const apiRef = useRef<RuntimeConnectionApi | null>(null);
  if (apiRef.current === null) {
    const api: RuntimeConnectionApi = {
      ...view,
      connect: () => connection.connect(),
      getLiveSessionStats: (sessionId) => connection.getLiveSessionStats(sessionId),
      sendLiveSessionCommand: (sessionId, command) => connection.sendLiveSessionCommand(sessionId, command),
      createSession: (params) => registry.createSession(params),
    };
    apiRef.current = api;
  }
  return useMemo<RuntimeConnectionApi>(
    () => ({ ...apiRef.current!, ...view }),
    [apiRef, view],
  );
}

/**
 * Exact per-session hook. `useRuntime(sessionId)` returns the stable exact
 * wrapper for that exact id (`null` only when `sessionId` is null). The hook
 * NEVER admits/attaches/touches during render: it peeks the injected registry
 * (pure) and subscribes via exact-ID membership subscription. Nonempty absent
 * sessions return a STABLE wrapper with `available:false` + the exact id + null
 * authority; actions admit only on invocation and are ID-bound (stable refs
 * across admission/eviction/rebind/reconnect).
 */
function useExactRuntime(sessionId: string | null): ExactRuntimeApi | null {
  const { registry } = useRuntimeOwners();
  // Cache the projected exact view so `getSnapshot` is reference-stable between
  // REAL changes (useSyncExternalStore requires it — a fresh object per call
  // would loop). The cache is rebuilt only when membership flips or the exact
  // controller's view reference changes.
  const cacheRef = useRef<{ sessionId: string; available: boolean; controllerView: ControllerView | null; view: ExactRuntimeView } | null>(null);
  const getSnapshot = useCallback((): ExactRuntimeView | null => {
    if (sessionId === null) return null;
    const controller = registry.peek(sessionId);
    const controllerView = controller === null ? null : controller.getSnapshot();
    const cache = cacheRef.current;
    if (cache !== null
      && cache.sessionId === sessionId
      && cache.available === (controller !== null)
      && cache.controllerView === controllerView) {
      return cache.view;
    }
    const view = controller === null ? emptyExactView(sessionId) : projectExactView(sessionId, controllerView!);
    cacheRef.current = { sessionId, available: controller !== null, controllerView, view };
    return view;
  }, [registry, sessionId]);
  const subscribe = useCallback((listener: () => void): (() => void) => {
    if (sessionId === null) return () => undefined;
    return registry.subscribeSession(sessionId, listener);
  }, [registry, sessionId]);
  const view = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  // Stable per-session actions — recreated only when the bound sessionId or
  // registry changes, NOT on admission/eviction/rebind/reconnect.
  const actions = useMemo(() => (sessionId === null ? null : createExactActions(registry, sessionId)), [registry, sessionId]);
  return useMemo<ExactRuntimeApi | null>(() => {
    if (sessionId === null || view === null || actions === null) return null;
    return { ...actions, ...view };
  }, [actions, view, sessionId]);
}

/**
 * Imperative exact-action coordinator for a DYNAMIC session id (e.g. a
 * just-created session whose id is only known after create resolves). Never
 * hands the raw registry to the UI: returns a function that builds ID-bound
 * exact actions over the SAME provider-owned registry (admission on
 * invocation, exactly like the exact hook). Use for post-create sends/actions
 * where a hook cannot be bound to an unknown id.
 */
export function useExactActionCoordinator(): (sessionId: string) => Omit<ExactRuntimeApi, keyof ExactRuntimeView> {
  const { registry } = useRuntimeOwners();
  return useCallback((sessionId: string) => createExactActions(registry, sessionId), [registry]);
}

/**
 * Exact per-session hook. `useRuntime(sessionId)` returns the stable exact
 * wrapper for that exact id (`null` only when `sessionId` is null). The hook
 * NEVER admits/attaches/touches during render: it peeks the injected registry
 * (pure) and subscribes via exact-ID membership subscription. Nonempty absent
 * sessions return a STABLE wrapper with `available:false` + the exact id + null
 * authority; actions admit only on invocation and are ID-bound (stable refs
 * across admission/eviction/rebind/reconnect).
 */
export function useRuntime(sessionId: string | null): ExactRuntimeApi | null {
  return useExactRuntime(sessionId);
}

const SelectedSessionContext = createContext<string | null>(null);

/**
 * Route-agnostic selected-session provider (Phase 4A.3.2a): purely declares
 * which sessionId the tree is currently selecting. NO router import, NO
 * fallback to holder/foreground. Wired around AppShell by the router.
 */
export function SelectedSessionProvider({ sessionId, children }: { sessionId: string | null; children: ReactNode }) {
  return <SelectedSessionContext.Provider value={sessionId}>{children}</SelectedSessionContext.Provider>;
}

/**
 * Read the exact runtime for the nearest {@link SelectedSessionProvider}'s
 * sessionId. Returns null when no selection is present — NEVER falls back to
 * the attached/foreground session.
 */
export function useSelectedRuntime(): ExactRuntimeApi | null {
  const sessionId = useContext(SelectedSessionContext);
  return useExactRuntime(sessionId);
}
