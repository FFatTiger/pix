import { describe, expect, it } from "vitest";
import {
  HostInfoSchema,
  PROTOCOL_VERSION,
  RuntimeAttachParamsSchema,
  SessionHeaderSchema,
} from "@fffattiger/pix-protocol";

describe("Protocol integration", () => {
  it("uses final Protocol schemas and strict resume cursor semantics", () => {
    expect(PROTOCOL_VERSION).toBe(2);
    expect(HostInfoSchema.parse({ mode: "local", capabilities: ["files"] })).toEqual({ mode: "local", capabilities: ["files"] });
    expect(SessionHeaderSchema.safeParse({ sessionId: "s", cwd: "/x", projectRoot: "/x" }).success).toBe(true);
    expect(SessionHeaderSchema.parse({ sessionId: "s", cwd: "/x", projectRoot: "/x" }).workspaceAccess).toBeUndefined();
    expect(SessionHeaderSchema.safeParse({
      sessionId: "s", cwd: "/x", projectRoot: "/x",
      workspaceAccess: { state: "authorized", reason: "allowed_root" },
    }).success).toBe(true);
    expect(SessionHeaderSchema.safeParse({
      sessionId: "s", cwd: "/x", projectRoot: "/x",
      workspaceAccess: { state: "authorized", reason: "outside_allowed_roots" },
    }).success).toBe(false);
    expect(RuntimeAttachParamsSchema.safeParse({ sessionId: "s", epoch: "e" }).success).toBe(false);
  });

  it("ships the real client runtime with RuntimeConnection as the transport owner", async () => {
    const runtime = await import("@/runtime");
    expect("SessionStore" in runtime).toBe(false);
    expect(typeof runtime.RuntimeConnection).toBe("function");
    expect("RuntimeSocket" in runtime).toBe(false);
    expect(typeof runtime.buildRuntimeWsUrl).toBe("function");
    // Host serves /v1/runtime at ROOT; path-independent URL (slash / no-slash identical).
    expect(runtime.buildRuntimeWsUrl({ href: "https://host/app/" })).toBe("wss://host/v1/runtime");
    expect(runtime.buildRuntimeWsUrl({ href: "https://host/app" })).toBe("wss://host/v1/runtime");
  });
});
