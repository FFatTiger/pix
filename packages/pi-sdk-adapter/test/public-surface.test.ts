import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createPiSdkAgentRuntimeFactory,
  M2_AGENT_CAPABILITIES,
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
    // inspection; production callers use M2_AGENT_CAPABILITIES (see below).
    const factory = createPiSdkAgentRuntimeFactory({ capabilities: M2_AGENT_CAPABILITIES });
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

  it("M2_AGENT_CAPABILITIES is exactly prompt+abort and leaks no broader surface", () => {
    assert.deepEqual([...M2_AGENT_CAPABILITIES], ["runtime.prompt", "runtime.abort"]);
    const leaked = [...M2_AGENT_CAPABILITIES].filter((capability) =>
      /model|tools|bash|fork|extension_ui|navigate|compact|reload|queue|stats|session\.rename|auto_name/.test(capability),
    );
    assert.deepEqual(leaked, [], "M2 must not leak model/tools/bash/fork/extension-UI capabilities");
  });
});
