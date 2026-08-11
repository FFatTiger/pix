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

  it("keeps the runtime transport as a non-product placeholder until M2", async () => {
    const runtimeModule = await import("./runtime-stubs");
    const runtime = runtimeModule.createRuntimeClientStub();
    await runtime.attach({ sessionId: "s" });
    // The stub is network-free and not wired into any product path; it never
    // reaches the "open" state.
    expect(runtime.state).toBe("closed");
  });
});
