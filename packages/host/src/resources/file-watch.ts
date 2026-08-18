import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { lstat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { HttpError } from "../errors.js";

export interface FileWatchManager {
  open(filePath: string, signal?: AbortSignal): Response;
  activeCount(): number;
  reservedCount(): number;
  closeAll(): void;
}

interface WatchEntry {
  terminate(mode?: "close" | "error", error?: unknown): void;
}

interface FileSnapshot {
  exists: boolean;
  mtimeMs: number;
  size: number;
}

async function snapshotFile(path: string): Promise<FileSnapshot> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) return { exists: false, mtimeMs: 0, size: 0 };
    return { exists: true, mtimeMs: info.mtimeMs, size: info.size };
  } catch {
    return { exists: false, mtimeMs: 0, size: 0 };
  }
}

function sameSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.exists === right.exists && left.mtimeMs === right.mtimeMs && left.size === right.size;
}

export function createFileWatchManager(maxWatchers = 32): FileWatchManager {
  if (!Number.isInteger(maxWatchers) || maxWatchers < 1) throw new Error("maxWatchers must be positive");
  const reservations = new Map<string, WatchEntry>();
  const active = new Set<WatchEntry>();
  const encoder = new TextEncoder();

  return {
    open(filePath, signal) {
      if (active.size + reservations.size >= maxWatchers) throw new HttpError(429, "WATCH_LIMIT", "File watch limit reached");
      const reservationId = randomUUID();
      const parentPath = dirname(filePath);
      const childName = basename(filePath);
      let watcher: FSWatcher | undefined;
      let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
      let terminated = false;
      let reconcileChain = Promise.resolve();
      const entry: WatchEntry = {
        terminate(mode = "close", error) {
          if (terminated) return;
          terminated = true;
          reservations.delete(reservationId);
          active.delete(entry);
          signal?.removeEventListener("abort", onAbort);
          if (watcher) { watcher.close(); watcher = undefined; }
          if (!controllerRef) return;
          try {
            if (mode === "error") controllerRef.error(error);
            else controllerRef.close();
          } catch { /* exactly-once termination */ }
        },
      };
      const onAbort = () => entry.terminate();
      // Reserve synchronously before stat() or any other asynchronous work.
      reservations.set(reservationId, entry);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) entry.terminate();

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controllerRef = controller;
          if (terminated) { try { controller.close(); } catch { /* closed */ } return; }
          const send = (event: string, value: unknown) => {
            if (terminated) return;
            if (controller.desiredSize !== null && controller.desiredSize <= 0) { entry.terminate(); return; }
            try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`)); }
            catch { entry.terminate(); }
          };
          try {
            const initial = await snapshotFile(filePath);
            if (terminated) return;
            if (!initial.exists) throw new HttpError(404, "PATH_NOT_FOUND", "Path not found");
            let previous = initial;
            const reconcile = () => {
              if (terminated) return;
              reconcileChain = reconcileChain.then(async () => {
                if (terminated) return;
                const current = await snapshotFile(filePath);
                if (terminated || sameSnapshot(previous, current)) return;
                previous = current;
                if (!current.exists) send("change", { removed: true });
                else send("change", { modified: new Date(current.mtimeMs).toISOString(), size: current.size });
              }).catch(() => {
                if (!terminated) send("change", { removed: true });
              });
            };
            watcher = watch(parentPath, (eventType, filename) => {
              if (terminated) return;
              const hinted = typeof filename === "string" ? filename : undefined;
              // Watch events are hints only. Missing names and renames still
              // require an exact-child re-stat; a different sibling is ignored.
              if (hinted !== undefined && hinted !== childName && eventType !== "rename") return;
              reconcile();
            });
            if (terminated) { watcher.close(); watcher = undefined; return; }
            reservations.delete(reservationId);
            active.add(entry);
            watcher.once("error", (error) => entry.terminate("error", error));
            send("connected", { path: filePath, size: initial.size });
          } catch (error) {
            entry.terminate("error", error);
          }
        },
        cancel() { entry.terminate(); },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } });
    },
    activeCount: () => active.size,
    reservedCount: () => reservations.size,
    closeAll() {
      for (const entry of [...reservations.values(), ...active]) entry.terminate();
    },
  };
}
