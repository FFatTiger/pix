import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createPiSdkAgentRuntimeFactory,
  PRODUCTION_AGENT_CAPABILITIES,
  PiSdkAgentRuntimeFactory,
} from "../src/agent/index.js";

function assertNoSdkSurface(value: object): void {
  const names = Object.getOwnPropertyNames(value);
  assert.equal(
    names.some((name) => /AgentSession|SessionManager|ModelRuntime|ResourceLoader|TrustStore|AuthStorage/.test(name)),
    false,
  );
}

describe("public agent factory surface", () => {
  it("returns a backend-neutral factory with no SDK names on the surface", () => {
    // Full RUNTIME_CAPABILITIES is used only to construct the surface for this
    // inspection; production callers use PRODUCTION_AGENT_CAPABILITIES (see below).
    const factory = createPiSdkAgentRuntimeFactory({ capabilities: PRODUCTION_AGENT_CAPABILITIES });
    assertNoSdkSurface(factory as object);
  });

  it("requires capabilities — zero-argument construction/call is a compile error", () => {
    // The @ts-expect-error directives below enforce the compile-time contract:
    // PiSdkAgentRuntimeFactoryOptions.capabilities is required and there is no
    // zero-argument factory entry point. Composition (R1/R2) must explicitly
    // choose a capability surface. The runtime assertions confirm the guard.
    assert.throws(() => {
      // @ts-expect-error capabilities is required: no-arg construction must not compile
      new PiSdkAgentRuntimeFactory();
    });
    assert.throws(() => {
      // @ts-expect-error capabilities is required: no-arg helper must not compile
      createPiSdkAgentRuntimeFactory();
    });
  });

  it("PRODUCTION_AGENT_CAPABILITIES is exactly prompt+abort+stats+rename+thinking.set+model.set+steer+follow_up+queue and leaks no broader surface", () => {
    assert.deepEqual([...PRODUCTION_AGENT_CAPABILITIES], [
      "runtime.prompt",
      "runtime.abort",
      "runtime.stats",
      "runtime.session.rename",
      "runtime.thinking.set",
      "runtime.model.set",
      "runtime.steer",
      "runtime.follow_up",
      "runtime.queue",
    ]);
    // Still-forbidden: tools/bash/fork/extension-UI/auto_name/reload must NOT
    // leak through the production surface. `runtime.stats` + `runtime.session.rename`
    // (D2-P1), `runtime.thinking.set` (D2-P2), `runtime.model.set` (D2-P3) and
    // `runtime.steer`/`runtime.follow_up`/`runtime.queue` (D2-P4) ARE allowed here.
    const leaked = [...PRODUCTION_AGENT_CAPABILITIES].filter((capability) =>
      /tools|bash|fork|extension_ui|navigate|compact|reload|auto_name/.test(capability),
    );
    assert.deepEqual(leaked, [], "production surface must not leak tools/bash/fork/extension-UI/reload/auto_name capabilities");
  });
});
