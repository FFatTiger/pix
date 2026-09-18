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

  it("PRODUCTION_AGENT_CAPABILITIES is exactly the full 20-token command surface (D2 auto_name opens the last command)", () => {    assert.deepEqual([...PRODUCTION_AGENT_CAPABILITIES], [
      "runtime.prompt",
      "runtime.abort",
      "runtime.stats",
      "runtime.session.rename",
      "runtime.thinking.set",
      "runtime.model.set",
      "runtime.steer",
      "runtime.follow_up",
      "runtime.queue",
      "runtime.bash",
      "runtime.bash.abort",
      "runtime.tools.read",
      "runtime.tools.write",
      "runtime.reload",
      "runtime.compact",
      "runtime.compact.abort",
      "runtime.extension_ui",
      "runtime.navigate",
      "runtime.fork",
      "runtime.auto_name",
    ]);
    // The full frozen command surface: every runtime command is now open, so
    // auto_name MUST be present (this is the completeness inversion — the last
    // closed command is now open).
    assert.ok(PRODUCTION_AGENT_CAPABILITIES.includes("runtime.auto_name"), "runtime.auto_name must be open");
    assert.equal(PRODUCTION_AGENT_CAPABILITIES.length, 20, "exactly 20 production tokens");  });
});
