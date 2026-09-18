import { createPreferencesApi } from "@/api/preferences";
import type { HttpClient } from "@/api/http-client";

/**
 * Server-side preference sync core (pix.json `preferences`).
 *
 * Ownership split (AGENTS §2):
 *  - Each preference domain keeps its dedicated localStorage owner (reads stay
 *    synchronous; existing owners/tests unchanged).
 *  - THIS module is the single server-sync owner: it applies the server map
 *    into the local mirrors on hydration, uploads local-only values (one-time
 *    migration), and batches every reported write into one debounced PATCH.
 *
 * Conflict policy: the SERVER value wins on hydration unless the key is dirty
 * (a write is queued). Writes apply locally first and sync asynchronously; a
 * failed sync keeps the local value and re-queues the patch (honest
 * degradation — the local state already applied, no fake success metadata).
 */

/** The synced preference keys (raw localStorage key names). */
export const PREFERENCE_KEYS: readonly string[] = [
  "pi-sidebar-item-state",
  "pi-sidebar-projects-open",
  "pi-sidebar-sessions-open",
  "pi-sidebar-pinned-open",
  "pi-fork-tree-collapsed",
  "pi-collapsed-time-groups",
  "pi-process-display-mode",
  "pi-title-auto",
  "pi-title-model",
  "pi-input-shortcut",
  "pi-markdown-list-continue",
  "pi-sound-enabled",
  "pi-favorite-models",
  "pi-locale",
  "pi-provider-icon-mode",
];

const PREFERENCE_KEY_SET = new Set(PREFERENCE_KEYS);
const FLUSH_DEBOUNCE_MS = 600;

const pendingWrites = new Map<string, string | null>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let currentHttpClient: () => HttpClient | null = () => null;

/** Registered by HttpClientProvider so imperative flushes reach transport. */
export function registerPreferenceHttpClient(get: () => HttpClient | null): void {
  currentHttpClient = get;
}

function isSyncedKey(key: string): boolean {
  return PREFERENCE_KEY_SET.has(key);
}

/**
 * Report a preference write from any domain owner. The value has already been
 * applied to localStorage by the owner; this queues the debounced server
 * patch (key-deduped: last write per key wins). Unknown keys are ignored —
 * the registry is the client's fixed surface; the host validates shape
 * independently.
 */
export function reportPreferenceWrite(key: string, value: string | null): void {
  if (!isSyncedKey(key)) return;
  pendingWrites.set(key, value);
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushNow();
  }, FLUSH_DEBOUNCE_MS);
}

/** Flush the queued patch now (also cancels the debounce timer). */
export function flushNow(): Promise<void> {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pendingWrites.size === 0) return Promise.resolve();
  const http = currentHttpClient();
  if (http === null) return Promise.resolve(); // no transport yet; retried later
  const patch: Record<string, string | null> = {};
  for (const [key, value] of pendingWrites) patch[key] = value;
  pendingWrites.clear();
  return createPreferencesApi(http).update({ patch }).then(undefined, (error: unknown) => {
    // Honest degradation: the local value already applied. Re-queue the patch
    // so a later write (or the next hydration) retries it; warn in dev.
    if (import.meta.env.DEV) console.warn("[preferences] server sync failed; re-queued", error);
    for (const [key, value] of Object.entries(patch)) {
      if (!pendingWrites.has(key)) pendingWrites.set(key, value);
    }
  });
}

/** Apply one server value into the local mirror + notify owners (storage event). */
function applyServerValue(key: string, value: string | null): void {
  if (!isSyncedKey(key)) return;
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: value, storageArea: window.localStorage }));
  } catch {
    // Storage unavailable: hydration degrades to local-only this session.
  }
}

function readLocalValue(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Test seam: the currently queued patch (read-only copy). */
export function pendingPatchSnapshot(): Record<string, string | null> {
  return Object.fromEntries(pendingWrites);
}

/**
 * Hydrate the server preference map into the local mirrors (server wins
 * unless a local write is queued) and upload local-only values once. Returns
 * the migration flush promise (resolves also on failure — re-queued).
 */
export function hydratePreferencesFromServer(serverMap: Record<string, string>): Promise<void> {
  const migrationPatch: Record<string, string> = {};
  for (const key of PREFERENCE_KEYS) {
    if (pendingWrites.has(key)) continue; // dirty local write wins
    const serverValue = serverMap[key] ?? null;
    const localValue = readLocalValue(key);
    if (serverValue !== null) {
      if (serverValue !== localValue) applyServerValue(key, serverValue);
    } else if (localValue !== null) {
      migrationPatch[key] = localValue; // first device uploads its value
    }
  }
  if (Object.keys(migrationPatch).length === 0) return Promise.resolve();
  for (const [key, value] of Object.entries(migrationPatch)) pendingWrites.set(key, value);
  return flushNow();
}

/** Test seam: forget queued writes between tests. */
export function resetPendingWritesForTest(): void {
  pendingWrites.clear();
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}
