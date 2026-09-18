/**
 * SessionStagingProvider + useSessionStaging — React wiring for the bounded
 * composer staging owner. The provider owns ONE SessionStagingStore and clears
 * it on real unmount via the same owner-version microtask used by RuntimeProvider
 * (StrictMode-safe: simulated cleanup is cancelled, no timer/global singleton).
 * The hook reads an immutable useSyncExternalStore snapshot (reference-stable
 * between mutations) and exposes stable store actions.
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
import {
  SessionStagingStore,
  type PromoteResult,
  type StagedActivationRecord,
  type StagedModelRef,
  type StagingKey,
  type StageResult,
  type SessionStagingStoreOptions,
} from "./session-staging-store.js";
import type { ThinkingLevel } from "@fffattiger/pix-protocol";

const SessionStagingContext = createContext<SessionStagingStore | null>(null);

export function SessionStagingProvider({ children, options }: { children: ReactNode; options?: SessionStagingStoreOptions }) {
  const [store] = useState(() => new SessionStagingStore(options));
  // The owner is INTENTIONALLY IMMUTABLE (useState initializer). Teardown uses
  // the StrictMode-safe deferred disposal below so simulated cleanup never
  // permanently clears live staging.
  useStrictModeSafeStagingDispose(store);
  return <SessionStagingContext.Provider value={store}>{children}</SessionStagingContext.Provider>;
}

function useStrictModeSafeStagingDispose(store: SessionStagingStore): void {
  const versionsRef = useRef<WeakMap<object, number>>(new WeakMap());
  useEffect(() => {
    const versions = versionsRef.current;
    const key = store as unknown as object;
    const version = (versions.get(key) ?? 0) + 1;
    versions.set(key, version);
    return () => {
      const disposeVersion = version;
      queueMicrotask(() => {
        if (versionsRef.current.get(key) !== disposeVersion) return;
        versionsRef.current.delete(key);
        store.dispose();
      });
    };
  }, [store]);
}

/** Access the single staging store (advanced). */
export function useSessionStagingStore(): SessionStagingStore {
  const ctx = useContext(SessionStagingContext);
  if (!ctx) throw new Error("useSessionStagingStore must be used within SessionStagingProvider");
  return ctx;
}

export interface SessionStagingApi {
  /** Reactive immutable snapshot records (changes only on mutation). */
  readonly records: readonly StagedActivationRecord[];
  readonly stage: (key: StagingKey, model?: StagedModelRef | null, thinking?: ThinkingLevel | null) => StageResult;
  readonly clear: (key: StagingKey) => void;
  /** Identity-fenced accepted-submission clear (see the store owner doc). */
  readonly clearMatching: (key: StagingKey, revision: number | null) => void;
  readonly clearModel: (key: StagingKey) => void;
  readonly clearThinking: (key: StagingKey) => void;
  readonly promote: (sourceKey: `new:${string}`, sessionId: string) => PromoteResult;
  readonly get: (key: StagingKey) => StagedActivationRecord | null;
}

export function useSessionStaging(): SessionStagingApi {
  const store = useSessionStagingStore();
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  // Stable action refs — created ONCE per store so the reactive `records`
  // refresh never changes the method identities.
  const apiRef = useRef<SessionStagingApi | null>(null);
  if (apiRef.current === null) {
    const api: SessionStagingApi = {
      ...snapshot,
      stage: (key, model, thinking) => store.stage(key, model, thinking),
      clear: (key) => store.clear(key),
      clearMatching: (key, revision) => store.clearMatching(key, revision),
      clearModel: (key) => store.clearModel(key),
      clearThinking: (key) => store.clearThinking(key),
      promote: (sourceKey, sessionId) => store.promote(sourceKey, sessionId),
      get: (key) => store.get(key),
    };
    apiRef.current = api;
  }
  return useMemo<SessionStagingApi>(() => ({ ...apiRef.current!, ...snapshot }), [apiRef, snapshot]);
}
