import { startDaemon, type DaemonHandle, type DaemonOptions } from "../../src/composition/index.js";

/**
 * Guaranteed bounded teardown for daemons (and bare socket servers) created in
 * tests. Register the module-level `after(closeTrackedDaemons)` hook in the
 * test file, then start daemons through `startTrackedDaemon` / the
 * `startTrackedDaemonCompat` alias so a failing test body can never leak a
 * running daemon (sockets/locks) into the next test file or run — that leak is
 * what previously produced "sessiond lock file is unreadable" noise and
 * long-hanging test workers. `shutdown()` is idempotent and owner-checked, so
 * tests that already shut the daemon down themselves are unaffected.
 */
const tracked = new Set<DaemonHandle>();
const trackedServers = new Set<() => Promise<void>>();

/** Start a daemon and remember it for teardown. `options` excludes `directory`. */
export function startTrackedDaemon(
  directory: string,
  options: Omit<DaemonOptions, "directory"> = {},
): Promise<DaemonHandle> {
  return startDaemon({ directory, ...options }).then((handle) => {
    tracked.add(handle);
    return handle;
  });
}

/**
 * Same signature as `startDaemon` (full options object). Use this as an import
 * alias in a test file so every existing `await startDaemon({...})` call site
 * becomes tracked without touching the body; a rejected start (expected
 * conflict) never registers a handle.
 */
export function startTrackedDaemonCompat(options: DaemonOptions): Promise<DaemonHandle> {
  return startDaemon(options).then((handle) => {
    tracked.add(handle);
    return handle;
  });
}

/** Remember a bare socket server's close function for teardown. */
export function trackServerClose(close: () => Promise<void>): void {
  trackedServers.add(close);
}

const boundedShutdown = (handle: DaemonHandle): Promise<void> =>
  Promise.race<void>([
    handle.shutdown().catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);

/** Shut down every tracked daemon and bare server (bounded). Safe once per file. */
export function closeTrackedDaemons(): Promise<void> {
  const pending = [...tracked].map((handle) => boundedShutdown(handle));
  tracked.clear();
  const serverPending = [...trackedServers].map((close) => close());
  trackedServers.clear();
  return Promise.allSettled([...pending, ...serverPending]).then(() => {});
}