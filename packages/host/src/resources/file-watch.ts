import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
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

export function createFileWatchManager(maxWatchers = 32): FileWatchManager {
  if (!Number.isInteger(maxWatchers) || maxWatchers < 1) throw new Error("maxWatchers must be positive");
  const reservations = new Map<string, WatchEntry>();
  const active = new Set<WatchEntry>();
  const encoder = new TextEncoder();

  return {
    open(filePath, signal) {
      if (active.size + reservations.size >= maxWatchers) throw new HttpError(429, "WATCH_LIMIT", "File watch limit reached");
      const reservationId = randomUUID();
      let watcher: FSWatcher | undefined;
      let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
      let terminated = false;
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
            const initial = await stat(filePath);
            if (terminated) return;
            let previousMtime = initial.mtimeMs;
            let previousSize = initial.size;
            watcher = watch(filePath, async () => {
              if (terminated) return;
              try {
                const current = await stat(filePath);
                if (terminated || (current.mtimeMs === previousMtime && current.size === previousSize)) return;
                previousMtime = current.mtimeMs;
                previousSize = current.size;
                send("change", { modified: current.mtime.toISOString(), size: current.size });
              } catch { if (!terminated) send("change", { removed: true }); }
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
