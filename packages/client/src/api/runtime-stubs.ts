import type { RuntimeAttachParams } from "@fffattiger/pix-protocol";

/**
 * M2 placeholder. This is NOT a product implementation and is intentionally NOT
 * wired into any product path (no provider consumes it; it performs no network
 * I/O). The real RuntimeSocket + SessionStore land in M2. It exists only so the
 * Protocol shapes it will satisfy can be type-checked ahead of time.
 */
export type RuntimeConnectionState = "idle" | "connecting" | "open" | "reconnecting" | "closed" | "error";

export interface RuntimeClient {
  readonly state: RuntimeConnectionState;
  attach(params: RuntimeAttachParams): Promise<void>;
  detach(): void;
}

export function createRuntimeClientStub(): RuntimeClient {
  let state: RuntimeConnectionState = "idle";
  return {
    get state() { return state; },
    async attach(_params) { state = "closed"; },
    detach() { state = "idle"; },
  };
}
