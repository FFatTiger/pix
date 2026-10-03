import { watch } from "node:fs";
import { MAX_SUBAGENT_TASKS } from "@fffattiger/pix-runtime-core";
import {
  MAX_SUBAGENT_TASK_DIRS,
  type SubagentObservation,
  type SubagentWatchTarget,
} from "./subagent-projection.js";

const DEBOUNCE_MS = 20;
const MAX_WATCHED_DIRECTORIES = 1 + MAX_SUBAGENT_TASK_DIRS + MAX_SUBAGENT_TASKS;

export interface SubagentWatchHandle {
  close(): void;
  unref?(): void;
}

export interface SubagentObserverDeps {
  read(): SubagentObservation;
  onObservation(observation: SubagentObservation, publish: boolean): void;
  onError(error: unknown): void;
  watchDirectory?(
    directory: string,
    onChange: (basename: string | null) => void,
    onError: (error: unknown) => void,
  ): SubagentWatchHandle;
  schedule?(run: () => void, delayMs: number): () => void;
}

interface ActiveWatch {
  readonly handle: SubagentWatchHandle;
  basenames: ReadonlySet<string> | null;
}

function nativeWatchDirectory(
  directory: string,
  onChange: (basename: string | null) => void,
  onError: (error: unknown) => void,
): SubagentWatchHandle {
  const watcher = watch(directory, { persistent: false }, (_eventType, filename) => {
    onChange(filename === null ? null : filename.toString());
  });
  watcher.on("error", onError);
  watcher.unref();
  return watcher;
}

function nativeSchedule(run: () => void, delayMs: number): () => void {
  const timer = setTimeout(run, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

/**
 * Event-driven observer for the bounded, sanitized artifact plan emitted by
 * subagent-projection. It never parses plugin files or publishes state itself.
 */
export class SubagentArtifactObserver {
  private readonly watchDirectory;
  private readonly schedule;
  private readonly watches = new Map<string, ActiveWatch>();
  private active = false;
  private generation = 0;
  private cancelScheduled: (() => void) | undefined;
  private refreshing = false;
  private lastFingerprint: string | undefined;

  constructor(private readonly deps: SubagentObserverDeps) {
    this.watchDirectory = deps.watchDirectory ?? nativeWatchDirectory;
    this.schedule = deps.schedule ?? nativeSchedule;
  }

  start(publish = false): SubagentObservation {
    if (this.active) return this.refresh(publish);
    this.active = true;
    this.generation += 1;
    return this.refresh(publish);
  }

  refresh(publish = true): SubagentObservation {
    if (!this.active) throw new Error("subagent observer is closed");
    if (this.refreshing) throw new Error("recursive subagent observer refresh");
    this.refreshing = true;
    const generation = this.generation;
    try {
      let observation: SubagentObservation | undefined;
      for (let pass = 0; pass <= MAX_WATCHED_DIRECTORIES; pass += 1) {
        observation = this.deps.read();
        if (!this.active || generation !== this.generation) return observation;
        const planChanged = this.reconcile(observation.watchTargets, generation);
        if (!this.active || generation !== this.generation) return observation;
        if (!planChanged) {
          const fingerprint = JSON.stringify([observation.tasks, observation.childSignatures]);
          if (fingerprint !== this.lastFingerprint) {
            this.lastFingerprint = fingerprint;
            this.deps.onObservation(observation, publish);
          }
          return observation;
        }
      }
      throw new Error("subagent observer watch set did not stabilize");
    } catch (error) {
      this.deps.onError(error);
      throw error;
    } finally {
      this.refreshing = false;
    }
  }

  close(): void {
    if (!this.active) return;
    this.active = false;
    this.generation += 1;
    this.cancelScheduled?.();
    this.cancelScheduled = undefined;
    for (const active of this.watches.values()) active.handle.close();
    this.watches.clear();
  }

  private reconcile(targets: readonly SubagentWatchTarget[], generation: number): boolean {
    const desired = new Map<string, ReadonlySet<string> | null>();
    for (const target of targets) {
      if (desired.size >= MAX_WATCHED_DIRECTORIES) break;
      const incoming = target.basenames === null ? null : new Set(target.basenames);
      const current = desired.get(target.directory);
      if (current === null || incoming === null) desired.set(target.directory, null);
      else desired.set(target.directory, new Set([...(current ?? []), ...incoming]));
    }

    let changed = false;
    for (const [directory, active] of this.watches) {
      const basenames = desired.get(directory);
      if (basenames === undefined) {
        active.handle.close();
        this.watches.delete(directory);
        changed = true;
      } else {
        // Widening a live filename filter has the same read/install gap as
        // adding a directory: an event may have hit the previous filter.
        if (active.basenames === null || basenames === null) {
          changed ||= active.basenames !== basenames;
        } else {
          changed ||= active.basenames.size !== basenames.size
            || [...basenames].some((name) => !active.basenames!.has(name));
        }
        active.basenames = basenames;
      }
    }

    for (const [directory, basenames] of desired) {
      if (this.watches.has(directory)) continue;
      try {
        const handle = this.watchDirectory(
          directory,
          (changedBasename) => {
            if (!this.active || generation !== this.generation) return;
            const active = this.watches.get(directory);
            if (active === undefined) return;
            if (changedBasename !== null && active.basenames !== null && !active.basenames.has(changedBasename)) return;
            this.scheduleRefresh();
          },
          (error) => {
            if (!this.active || generation !== this.generation) return;
            const active = this.watches.get(directory);
            if (active !== undefined) {
              active.handle.close();
              this.watches.delete(directory);
            }
            this.deps.onError(error);
          },
        );
        handle.unref?.();
        if (!this.active || generation !== this.generation) {
          handle.close();
          continue;
        }
        this.watches.set(directory, { handle, basenames });
        changed = true;
      } catch (error) {
        this.deps.onError(error);
      }
    }
    return changed;
  }

  private scheduleRefresh(): void {
    if (this.cancelScheduled !== undefined) return;
    const generation = this.generation;
    this.cancelScheduled = this.schedule(() => {
      this.cancelScheduled = undefined;
      if (!this.active || generation !== this.generation) return;
      try {
        this.refresh(true);
      } catch {
        // refresh already reported the structured observer error.
      }
    }, DEBOUNCE_MS);
  }
}
