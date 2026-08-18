import { describe, expect, it } from "vitest";
import {
  HostInfoSchema,
  PROTOCOL_VERSION,
  RuntimeAttachParamsSchema,
  SessionHeaderSchema,
} from "@fffattiger/pix-protocol";
import {
  HOST_BOOTSTRAP_SCHEMA_VERSION,
  HostBootstrapResponseSchema,
} from "@fffattiger/pix-protocol/host-bootstrap";
import { BootstrapResponseSchema } from "./schemas";

describe("Protocol integration", () => {
  it("consumes the protocol-owned HTTP bootstrap schema literal, not Runtime Protocol v2", () => {
    expect(HOST_BOOTSTRAP_SCHEMA_VERSION).toBe(2);
    expect(PROTOCOL_VERSION).toBe(2);
    expect(BootstrapResponseSchema).toBe(HostBootstrapResponseSchema);
    const body = {
      ok: true as const,
      service: "pix-host",
      protocolVersion: HOST_BOOTSTRAP_SCHEMA_VERSION,
      sessiond: "unknown" as const,
      capabilities: [],
      mode: "local" as const,
      gate: { required: false, status: "disabled" as const },
      pathFlavor: "posix" as const,
    };
    expect(BootstrapResponseSchema.parse(body).protocolVersion).toBe(2);
    expect(BootstrapResponseSchema.safeParse({ ...body, protocolVersion: 1 }).success).toBe(false);
    const { pathFlavor: _ignored, ...withoutFlavor } = body;
    expect(BootstrapResponseSchema.safeParse(withoutFlavor).success).toBe(false);
  });

  it("uses final Protocol schemas and strict resume cursor semantics", () => {
    expect(PROTOCOL_VERSION).toBe(2);
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
