import { SessiondError } from "../errors.js";

export const subscriberOverflowError = (): SessiondError =>
  new SessiondError("unavailable", "subscriber queue overflowed", true);

/** Exact NDJSON wire size of an already-owned SessiondPush envelope, including the trailing newline. */
export const ndjsonQueuedBytes = (push: unknown): number =>
  Buffer.byteLength(JSON.stringify(push), "utf8") + 1;

export interface ClosedGate {
  readonly promise: Promise<SessiondError | null>;
  settle(error: SessiondError | null): void;
}

export const createClosedGate = (): ClosedGate => {
  let settle!: (error: SessiondError | null) => void;
  let settled = false;
  const promise = new Promise<SessiondError | null>((resolve) => {
    settle = resolve;
  });
  return {
    promise,
    settle(error) {
      if (settled) return;
      settled = true;
      settle(error);
    },
  };
};
