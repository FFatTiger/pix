import { HttpError } from "../errors.js";

interface Waiter {
  granted: boolean;
  resolve(release: () => void): void;
  reject(error: unknown): void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** FIFO async mutex with abortable waiters and exactly-once release. */
export class AsyncMutex {
  private locked = false;
  private readonly waiters: Waiter[] = [];

  async runExclusive<T>(operation: () => Promise<T> | T, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try { return await operation(); }
    finally { release(); }
  }

  private acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new HttpError(499, "MUTATION_ABORTED", "Mutation aborted while waiting for lock"));
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { granted: false, resolve, reject, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          if (waiter.granted) return;
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          signal.removeEventListener("abort", waiter.onAbort!);
          reject(new HttpError(499, "MUTATION_ABORTED", "Mutation aborted while waiting for lock"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      if (!this.locked) this.grant(waiter);
      else this.waiters.push(waiter);
    });
  }

  private grant(waiter: Waiter): void {
    this.locked = true;
    waiter.granted = true;
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    let released = false;
    waiter.resolve(() => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) this.grant(next);
      else this.locked = false;
    });
  }
}

interface KeyEntry {
  mutex: AsyncMutex;
  users: number;
}

/** Per-key FIFO serialization; idle keys are removed after the last user. */
export class KeyedMutex {
  private readonly entries = new Map<string, KeyEntry>();

  async runExclusive<T>(key: string, operation: () => Promise<T> | T, signal?: AbortSignal): Promise<T> {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { mutex: new AsyncMutex(), users: 0 };
      this.entries.set(key, entry);
    }
    entry.users += 1;
    try { return await entry.mutex.runExclusive(operation, signal); }
    finally {
      entry.users -= 1;
      if (entry.users === 0 && this.entries.get(key) === entry) this.entries.delete(key);
    }
  }

  keyCount(): number { return this.entries.size; }
}
