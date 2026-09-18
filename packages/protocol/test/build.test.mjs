import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ADAPTER_CONTRACT_VERSION,
  PIX_PRODUCT_VERSION,
  RUNTIME_CAPABILITY_VOCABULARY,
  RUNTIME_EXPLICIT_ACTIVATE_FEATURE,
  RUNTIME_OBSERVE_EXISTING_FEATURE,
  SESSIOND_BUILD_CAPABILITIES,
  SESSIOND_BUILD_IDENTITY,
  SESSIOND_CONTRACT_VERSION,
  WORKER_BUILD_IDENTITY,
  WORKER_CONTRACT_VERSION,
  WORKER_IPC_MESSAGE_TYPES,
  BuildFingerprintSchema,
  SessiondBuildSchema,
  WorkerBuildSchema,
  computeBuildFingerprint,
  evaluateSessiondBuild,
  evaluateWorkerBuild,
  sha256Hex,
  sortedUniqueStrings,
} from "../dist/index.js";

/**
 * Phase 7A canonical build identity / compatibility contract.
 *
 * Determinism: the fingerprint is a pure function of the vocabulary — same
 * input always yields the same digest, input ORDER never matters, duplicates
 * never matter. Sorted deterministic semantics; unknown is honest and never
 * reusable-compatible.
 */

const parts = {
  sessiondCapabilities: ["runtime.authority", "runtime.resume", "runtime.running-watch.v1"],
  workerMessageTypes: ["worker.ready", "worker.init", "worker.command"],
  runtimeCapabilities: ["runtime.prompt", "runtime.abort"],
};

describe("build fingerprint", () => {
  it("is deterministic for identical vocabularies", () => {
    assert.equal(computeBuildFingerprint(parts), computeBuildFingerprint(parts));
  });

  it("is invariant to input order and duplicates (sorted deterministic semantics)", () => {
    assert.equal(
      computeBuildFingerprint(parts),
      computeBuildFingerprint({
        sessiondCapabilities: [...parts.sessiondCapabilities].reverse().concat("runtime.resume"),
        workerMessageTypes: [...parts.workerMessageTypes].reverse().reverse().concat("worker.init"),
        runtimeCapabilities: [...parts.runtimeCapabilities].slice().reverse(),
      }),
    );
  });

  it("changes when any vocabulary changes", () => {
    const base = computeBuildFingerprint(parts);
    assert.notEqual(
      base,
      computeBuildFingerprint({ ...parts, sessiondCapabilities: [...parts.sessiondCapabilities, "runtime.new-token"] }),
    );
    assert.notEqual(
      base,
      computeBuildFingerprint({ ...parts, workerMessageTypes: [...parts.workerMessageTypes, "worker.newFrame"] }),
    );
    assert.notEqual(
      base,
      computeBuildFingerprint({ ...parts, runtimeCapabilities: [...parts.runtimeCapabilities, "runtime.navigate"] }),
    );
  });

  it("drops a removed token (removal is also a fence difference)", () => {
    assert.notEqual(
      computeBuildFingerprint(parts),
      computeBuildFingerprint({ ...parts, sessiondCapabilities: parts.sessiondCapabilities.slice(0, 2) }),
    );
  });

  it("is a lowercase 64-hex digest", () => {
    assert.equal(BuildFingerprintSchema.safeParse(computeBuildFingerprint(parts)).success, true);
    assert.equal(BuildFingerprintSchema.safeParse("NOT-HEX").success, false);
    assert.equal(BuildFingerprintSchema.safeParse("a".repeat(63)).success, false);
    assert.equal(BuildFingerprintSchema.safeParse("A".repeat(64)).success, false);
  });

  it("sha256Hex matches the FIPS 180-4 test vectors", () => {
    assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert.equal(
      sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
    // > 1 block (multi-block padding path).
    assert.equal(sha256Hex("a".repeat(1000)).length, 64);
    assert.notEqual(sha256Hex("a".repeat(1000)), sha256Hex("a".repeat(1001)));
  });

  it("sha256Hex is deterministic for multi-byte UTF-8 inputs and separates them", () => {
    // The inline UTF-8 encoder must be stable and must actually widen BMP and
    // astral code points (distinct byte lengths ⇒ distinct digests).
    assert.equal(sha256Hex("é"), sha256Hex("é"));
    assert.notEqual(sha256Hex("é"), sha256Hex("e"));
    assert.notEqual(sha256Hex("😀"), sha256Hex("😀".slice(0, 1)));
  });

  it("sortedUniqueStrings sorts and dedupes", () => {
    assert.deepEqual(sortedUniqueStrings(["b", "a", "b", "c", "a"]), ["a", "b", "c"]);
  });
});

describe("canonical identities", () => {
  it("does not fingerprint Browser-Host lifecycle features", () => {
    // Frozen digest: CAT-01 bumps ADAPTER_CONTRACT_VERSION only. Do not
    // retarget this value for projection schema 5 or other Adapter policy.
    assert.equal(SESSIOND_BUILD_IDENTITY.fingerprint, "8307373fd59c809d1dea4afd0c13e1769806d24a60fdf085b44b148a4f370c7f");
    assert.equal(SESSIOND_BUILD_CAPABILITIES.includes(RUNTIME_OBSERVE_EXISTING_FEATURE), false);
    assert.equal(SESSIOND_BUILD_CAPABILITIES.includes(RUNTIME_EXPLICIT_ACTIVATE_FEATURE), false);
    assert.equal(RUNTIME_CAPABILITY_VOCABULARY.includes(RUNTIME_OBSERVE_EXISTING_FEATURE), false);
    assert.equal(RUNTIME_CAPABILITY_VOCABULARY.includes(RUNTIME_EXPLICIT_ACTIVATE_FEATURE), false);
    assert.equal(WORKER_IPC_MESSAGE_TYPES.includes(RUNTIME_OBSERVE_EXISTING_FEATURE), false);
    assert.equal(WORKER_IPC_MESSAGE_TYPES.includes(RUNTIME_EXPLICIT_ACTIVATE_FEATURE), false);
  });

  it("carry the compiled contract constants", () => {
    assert.equal(SESSIOND_BUILD_IDENTITY.product, PIX_PRODUCT_VERSION);
    assert.equal(SESSIOND_BUILD_IDENTITY.sessiond, SESSIOND_CONTRACT_VERSION);
    assert.equal(SESSIOND_BUILD_IDENTITY.workerContract, WORKER_CONTRACT_VERSION);
    assert.equal(SESSIOND_BUILD_IDENTITY.adapterContract, ADAPTER_CONTRACT_VERSION);
    assert.equal(WORKER_BUILD_IDENTITY.workerContract, WORKER_CONTRACT_VERSION);
    assert.equal(WORKER_BUILD_IDENTITY.adapterContract, ADAPTER_CONTRACT_VERSION);
    assert.equal(WORKER_BUILD_IDENTITY.fingerprint, SESSIOND_BUILD_IDENTITY.fingerprint);
  });

  it("are schema-valid and derived from the single-source vocabularies", () => {
    assert.equal(SessiondBuildSchema.safeParse(SESSIOND_BUILD_IDENTITY).success, true);
    assert.equal(WorkerBuildSchema.safeParse(WORKER_BUILD_IDENTITY).success, true);
    // The sessiond capability vocabulary is sorted, unique, frozen.
    assert.deepEqual(
      [...SESSIOND_BUILD_CAPABILITIES],
      sortedUniqueStrings([...SESSIOND_BUILD_CAPABILITIES]),
    );
    // The runtime capability vocabulary mirrors the Protocol schema enum.
    assert.deepEqual(
      [...RUNTIME_CAPABILITY_VOCABULARY],
      sortedUniqueStrings([...RUNTIME_CAPABILITY_VOCABULARY]),
    );
    // The Worker IPC vocabulary is sorted, unique, and derived from BOTH
    // schema unions (spot-check known members of each direction).
    for (const type of ["worker.init", "worker.command", "worker.getSnapshot", "worker.rotateEpoch", "worker.shutdown"]) {
      assert.ok(WORKER_IPC_MESSAGE_TYPES.includes(type), `missing sessiond→worker type ${type}`);
    }
    for (const type of ["worker.ready", "worker.event", "worker.snapshot", "worker.rotateEpochResult", "worker.fatal"]) {
      assert.ok(WORKER_IPC_MESSAGE_TYPES.includes(type), `missing worker→sessiond type ${type}`);
    }
    assert.deepEqual([...WORKER_IPC_MESSAGE_TYPES], sortedUniqueStrings([...WORKER_IPC_MESSAGE_TYPES]));
  });

  it("recomputes the identity fingerprint from the same vocabularies", () => {
    assert.equal(
      SESSIOND_BUILD_IDENTITY.fingerprint,
      computeBuildFingerprint({
        sessiondCapabilities: SESSIOND_BUILD_CAPABILITIES,
        workerMessageTypes: WORKER_IPC_MESSAGE_TYPES,
        runtimeCapabilities: RUNTIME_CAPABILITY_VOCABULARY,
      }),
    );
  });
});

describe("sessiond build matrix", () => {
  it("accepts the exact compiled identity", () => {
    assert.deepEqual(evaluateSessiondBuild(SESSIOND_BUILD_IDENTITY, SESSIOND_BUILD_IDENTITY), { state: "compatible" });
  });

  it("classifies missing and malformed builds honestly", () => {
    assert.deepEqual(evaluateSessiondBuild(undefined, SESSIOND_BUILD_IDENTITY), { state: "incompatible", reason: "missing_build" });
    assert.deepEqual(evaluateSessiondBuild(null, SESSIOND_BUILD_IDENTITY), { state: "incompatible", reason: "missing_build" });
    assert.deepEqual(evaluateSessiondBuild({}, SESSIOND_BUILD_IDENTITY), { state: "incompatible", reason: "malformed_build" });
    assert.deepEqual(evaluateSessiondBuild({ ...SESSIOND_BUILD_IDENTITY, fingerprint: "zz" }, SESSIOND_BUILD_IDENTITY), { state: "incompatible", reason: "malformed_build" });
    assert.deepEqual(evaluateSessiondBuild({ ...SESSIOND_BUILD_IDENTITY, extra: 1 }, SESSIOND_BUILD_IDENTITY), { state: "incompatible", reason: "malformed_build" });
  });

  it("rejects each single-field mismatch with its fixed reason (same protocol major is NOT compatibility)", () => {
    const cases = [
      ["product", { ...SESSIOND_BUILD_IDENTITY, product: "0.0.1" }],
      ["sessiond_contract", { ...SESSIOND_BUILD_IDENTITY, sessiond: SESSIOND_BUILD_IDENTITY.sessiond + 1 }],
      ["worker_contract", { ...SESSIOND_BUILD_IDENTITY, workerContract: SESSIOND_BUILD_IDENTITY.workerContract + 1 }],
      ["adapter_contract", { ...SESSIOND_BUILD_IDENTITY, adapterContract: SESSIOND_BUILD_IDENTITY.adapterContract + 1 }],
      ["fingerprint", { ...SESSIOND_BUILD_IDENTITY, fingerprint: "b".repeat(64) }],
    ];
    for (const [reason, observed] of cases) {
      assert.deepEqual(
        evaluateSessiondBuild(observed, SESSIOND_BUILD_IDENTITY),
        { state: "incompatible", reason },
        `expected ${reason}`,
      );
    }
  });

  it("release fences: pre-v4 Adapter generations are incompatible both ways before Worker SDK init", () => {
    // v4 restores continuation models and excludes model mutation from turn
    // admission. All prior Adapter generations must fail the reuse fence.
    assert.equal(ADAPTER_CONTRACT_VERSION, 4);
    assert.equal(SESSIOND_BUILD_IDENTITY.adapterContract, 4);
    for (const superseded of [1, 2, 3]) {
      const older = { ...SESSIOND_BUILD_IDENTITY, adapterContract: superseded };
      assert.deepEqual(evaluateSessiondBuild(older, SESSIOND_BUILD_IDENTITY), {
        state: "incompatible",
        reason: "adapter_contract",
      });
      assert.deepEqual(evaluateSessiondBuild(SESSIOND_BUILD_IDENTITY, older), {
        state: "incompatible",
        reason: "adapter_contract",
      });
    }
  });
});

describe("worker build matrix", () => {
  it("accepts the exact compiled identity", () => {
    assert.deepEqual(evaluateWorkerBuild(WORKER_BUILD_IDENTITY, WORKER_BUILD_IDENTITY), { state: "compatible" });
  });

  it("classifies missing and malformed builds honestly", () => {
    assert.deepEqual(evaluateWorkerBuild(undefined, WORKER_BUILD_IDENTITY), { state: "incompatible", reason: "missing_build" });
    assert.deepEqual(evaluateWorkerBuild("worker.ready", WORKER_BUILD_IDENTITY), { state: "incompatible", reason: "malformed_build" });
    assert.deepEqual(evaluateWorkerBuild({ ...WORKER_BUILD_IDENTITY, workerContract: "2" }, WORKER_BUILD_IDENTITY), { state: "incompatible", reason: "malformed_build" });
  });

  it("rejects each single-field mismatch with its fixed reason", () => {
    const cases = [
      ["worker_contract", { ...WORKER_BUILD_IDENTITY, workerContract: WORKER_BUILD_IDENTITY.workerContract + 1 }],
      ["adapter_contract", { ...WORKER_BUILD_IDENTITY, adapterContract: WORKER_BUILD_IDENTITY.adapterContract + 1 }],
      ["fingerprint", { ...WORKER_BUILD_IDENTITY, fingerprint: "c".repeat(64) }],
    ];
    for (const [reason, observed] of cases) {
      assert.deepEqual(
        evaluateWorkerBuild(observed, WORKER_BUILD_IDENTITY),
        { state: "incompatible", reason },
        `expected ${reason}`,
      );
    }
  });

  it("release fences: pre-v4 Worker Adapter generations are incompatible both ways", () => {
    // Workers missing the model-submission behavior must not be reused.
    assert.equal(WORKER_BUILD_IDENTITY.adapterContract, 4);
    for (const superseded of [1, 2, 3]) {
      const older = { ...WORKER_BUILD_IDENTITY, adapterContract: superseded };
      assert.deepEqual(evaluateWorkerBuild(older, WORKER_BUILD_IDENTITY), {
        state: "incompatible",
        reason: "adapter_contract",
      });
      assert.deepEqual(evaluateWorkerBuild(WORKER_BUILD_IDENTITY, older), {
        state: "incompatible",
        reason: "adapter_contract",
      });
    }
  });
});
