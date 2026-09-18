import { SessiondError } from "../errors.js";
import type { WorkerConnection, WorkerProcessFactory, WorkerStartInput } from "../worker.js";

/**
 * M1 worker factory: the daemon boots and serves the control/read surface
 * (system.ping, system.hello, sessions.*) without ever spawning a real Worker.
 *
 * {@link start} always rejects — synchronously, before allocating anything — so
 * `runtime.create`/`runtime.activate` fail fast with a structured
 * `worker_unavailable` error and no process is started. The {@link attempts}
 * counter lets tests assert that the daemon tried and refused rather than
 * silently succeeding.
 */
export class UnavailableWorkerFactory implements WorkerProcessFactory {
  /** Number of times {@link start} was invoked (always failed). */
  attempts = 0;

  async start(_input: WorkerStartInput): Promise<WorkerConnection> {
    this.attempts += 1;
    throw new SessiondError("worker_unavailable", "worker runtime is unavailable (M1)", true);
  }
}
