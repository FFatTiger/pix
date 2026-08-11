import { describe, expect, it } from "vitest";
import {
  HostInfoSchema,
  PROTOCOL_VERSION,
  RuntimeAttachParamsSchema,
  SessionHeaderSchema,
} from "@fffattiger/pix-protocol";

describe("Protocol integration", () => {
  it("uses final Protocol schemas and strict resume cursor semantics", () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(HostInfoSchema.parse({ mode: "local", capabilities: ["files"] })).toEqual({ mode: "local", capabilities: ["files"] });
    expect(SessionHeaderSchema.safeParse({ sessionId: "s", cwd: "/x", projectRoot: "/x" }).success).toBe(true);
    expect(RuntimeAttachParamsSchema.safeParse({ sessionId: "s", epoch: "e" }).success).toBe(false);
  });

  it("ships the real M2 client runtime (SessionStore + RuntimeSocket) instead of a stub", async () => {
    const runtime = await import("@/runtime");
    expect(typeof runtime.SessionStore).toBe("function");
    expect(typeof runtime.RuntimeSocket).toBe("function");
    expect(typeof runtime.buildRuntimeWsUrl).toBe("function");
    // Host serves /v1/runtime at ROOT; path-independent URL (slash / no-slash identical).
    expect(runtime.buildRuntimeWsUrl({ href: "https://host/app/" })).toBe("wss://host/v1/runtime");
    expect(runtime.buildRuntimeWsUrl({ href: "https://host/app" })).toBe("wss://host/v1/runtime");
  });
});
