import { z } from "zod";
import { NonEmptyStringSchema } from "./common.js";
import { RuntimeCapabilitySchema } from "./domain.js";
import { RUNTIME_EPOCH_ROLLOVER_FEATURE, RUNTIME_READ_RPC_FEATURE, RUNTIME_RUNNING_WATCH_FEATURE, RUNTIME_SUBMIT_TURN_FEATURE } from "./features.js";
import { ProtocolVersionSchema, PROTOCOL_VERSION } from "./version.js";

/**
 * Canonical build identity / build-compatibility contract (Phase 7A).
 *
 * Protocol is the ONE owner of the build vocabulary, its fingerprint
 * semantics, and the compatibility matrix semantics. `system.hello` carries a
 * strict additive {@link SessiondBuild} block; `worker.init` /
 * `worker.ready` carry strict build blocks in both directions. CLI reuse and
 * sessiond Worker admission are decided by the pure evaluators below — never
 * by "same protocol major" alone: a shared Protocol major does NOT prove an
 * implementation-compatible build.
 *
 * Rules (frozen):
 *
 * - Every vocabulary that participates in the fingerprint is owned here (or
 *   derived once from a Protocol schema by the owning module) and is
 *   normalized with sorted, de-duplicated semantics, so the fingerprint is
 *   byte-stable across processes and platforms.
 * - "Unknown" is honest: a build block that is missing, malformed, or does not
 *   EXACTLY match the compiled-in expectation classifies as incompatible with
 *   a fixed reason. There is no permissive "close enough" reuse.
 * - The fingerprint is a determinism/drift detector over the wire vocabulary,
 *   not a secret: it must be reproducible in any environment without Node
 *   builtins (the protocol package is also bundled into the browser Client),
 *   so SHA-256 is implemented locally with zero dependencies.
 *
 * Contract-version bump rule: any change to the sessiond RPC surface, the
 * sessiond↔Worker IPC surface, or the adapter behavior contract that a peer
 * must know about bumps the corresponding constant below (and, when a wire
 * vocabulary changes, updates the vocabulary owner). Mixed dist deployments
 * then fail closed at the fence instead of being silently reused.
 */

/**
 * Pix product version this protocol build belongs to. Bump together with the
 * repo version; a peer built from a different product version is never
 * silently reused (its {@link SessiondBuild.product} differs).
 */
export const PIX_PRODUCT_VERSION = "0.1.0" as const;

/**
 * sessiond RPC/control contract generation. Bumped on every change to the
 * sessiond request/response surface that a CLI/Host peer must agree on.
 * v4 (catalog page split): `sessions.list` is true page/pageSize and returns
 * totals/revision; independent `projects.list` is added. A v3 Host must not be
 * reused because its limit/offset request and response shape are incompatible.
 * v5 (context-usage consistency): `sessions.context` results carry the
 * additive `contextTokens` numerator (strict-schema parsed at the RPC
 * boundary), and worker→sessiond `runtime_state_changed` frames may carry the
 * atomic `context` payload. A v4 peer's strict schemas reject both, so mixed
 * dist deployments must fail closed at this fence instead of being reused.
 */
export const SESSIOND_CONTRACT_VERSION = 5 as const;

/**
 * sessiond ↔ Worker IPC contract generation. Bumped on every change to the
 * `worker.*` message surface. A Worker built against a different generation
 * is rejected fail-closed by sessiond (and vice versa).
 * v3 (Phase 5B): `worker.init` / `worker.command` / `worker.interrupt` carry a
 * REQUIRED `epoch`; new `worker.rotateEpoch` / `worker.rotateEpochResult` IPC.
 * v4 (context-usage consistency): `worker.event` `runtime_state_changed` frames
 * may carry the atomic `context` {model, leafId, contextUsage} payload published
 * after committed message/bash updates, model changes, navigation and
 * compaction terminals. A v3 sessiond's strict event schema rejects the
 * payload, so mixed dist deployments must fail closed at this fence.
 */
export const WORKER_CONTRACT_VERSION = 4 as const;

/**
 * Adapter behavior-contract generation (the contract proven by
 * `runtime-contract-tests`). Bumped whenever the adapter behavior contract
 * changes such that a sessiond/Worker peer must be updated in lockstep.
 * v2 (CAT-01): Adapter projection schema 5 changes shared-index browse-kind
 * policy so user home roots are Projects. Mixed daemon/Worker adapters
 * sharing one index flap classification/totals; a v1 Adapter peer must not
 * be reused. This fences Adapter semantic/shared-index compatibility, not
 * browser-feature vocabulary.
 * v3 (context-usage consistency): the adapter derives context usage from the
 * ONE shared file-backed estimator (identical live/history numerator), caches
 * only the numerator by branch identity while window/percent track the CURRENT
 * model, and publishes the coherent `runtime_state_changed` context payload
 * after committed message/bash updates, model changes, navigation and
 * compaction terminals. A v2 peer must not be reused against it.
 * v4 (model submission consistency): existing sessions use native SDK model
 * restoration before global defaults; model/thinking mutations exclude turn
 * admission per runtime, including external streams and close races. A v3
 * Worker may run a turn under another model and must not be reused.
 */
export const ADAPTER_CONTRACT_VERSION = 4 as const;

/**
 * Canonicalization format version for the capability fingerprint. Bumped only
 * when the canonical string format below changes (never for vocabulary
 * additions — those change the fingerprint value by design).
 */
export const BUILD_FINGERPRINT_FORMAT = "pix.build-fingerprint.v1" as const;

/**
 * Sessiond capabilities advertised by `system.hello` for THIS build. Single
 * source: the sessiond application MUST advertise exactly this list, and the
 * build fingerprint is computed over exactly this list, so the advertised
 * surface and the fingerprinted surface can never drift apart.
 * Deterministic order (sorted, unique). Includes the independent read RPC
 * (Phase 2B) and atomic prompt admission (Phase 3) features on top of the
 * historical authority/resume/running-watch surface.
 */
export const SESSIOND_BUILD_CAPABILITIES: readonly string[] = Object.freeze([
  ...sortedUniqueStrings([
    "runtime.authority",
    "runtime.resume",
    RUNTIME_RUNNING_WATCH_FEATURE,
    RUNTIME_READ_RPC_FEATURE,
    RUNTIME_SUBMIT_TURN_FEATURE,
    RUNTIME_EPOCH_ROLLOVER_FEATURE,
  ]),
]);

/**
 * Runtime capability wire vocabulary mirrored from Runtime Core via the
 * Protocol schema (single source: {@link RuntimeCapabilitySchema.options}).
 */
export const RUNTIME_CAPABILITY_VOCABULARY: readonly string[] = Object.freeze([
  ...sortedUniqueStrings(RuntimeCapabilitySchema.options),
]);

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** Lowercase 64-hex SHA-256 fingerprint. */
export const BuildFingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/, "fingerprint must be 64 lowercase hex characters");
export type BuildFingerprint = z.infer<typeof BuildFingerprintSchema>;

const ContractVersionSchema = z.number().int().positive().safe();

/**
 * Strict sessiond build identity, carried additively by `system.hello` and
 * by `worker.init` (sessiond → Worker). Strict object: unknown extra fields
 * fail the wire schema instead of being silently accepted.
 */
export const SessiondBuildSchema = z.strictObject({
  /** Pix product version of the reporting build. */
  product: NonEmptyStringSchema,
  /** Frozen Pi Runtime Protocol version (matches the envelope literal). */
  protocol: ProtocolVersionSchema,
  /** sessiond RPC contract generation. */
  sessiond: ContractVersionSchema,
  /** Worker IPC contract generation sessiond speaks/expects. */
  workerContract: ContractVersionSchema,
  /** Adapter behavior-contract generation sessiond expects. */
  adapterContract: ContractVersionSchema,
  /** Deterministic capability fingerprint over this build's wire vocabulary. */
  fingerprint: BuildFingerprintSchema,
});
export type SessiondBuild = z.infer<typeof SessiondBuildSchema>;

/**
 * Strict Worker build identity, carried by `worker.ready`. The Worker
 * contract fields must match the sessiond's compiled expectation EXACTLY
 * before sessiond advertises or dispatches anything on this Worker.
 */
export const WorkerBuildSchema = z.strictObject({
  workerContract: ContractVersionSchema,
  adapterContract: ContractVersionSchema,
  fingerprint: BuildFingerprintSchema,
});
export type WorkerBuild = z.infer<typeof WorkerBuildSchema>;

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

/** Sort lexicographically and de-duplicate (deterministic normalization). */
export function sortedUniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * Deterministic SHA-256 (lowercase hex) over the UTF-8 bytes of `input`.
 *
 * Pure TypeScript on purpose: the protocol package is bundled into the
 * browser Client, so no Node builtin or platform global may be imported
 * here (UTF-8 encoding included). This is the canonical FIPS 180-4
 * compression function.
 */
export function sha256Hex(input: string): string {
  const bytes = encodeUtf8(input);
  const bitLength = bytes.length * 8;
  // Padded message: data || 0x80 || zeros || 64-bit big-endian bit length.
  const paddedLength = ((bytes.length + 8) >> 6) + 1;
  const blocks = new Uint8Array(paddedLength * 64);
  blocks.set(bytes);
  blocks[bytes.length] = 0x80;
  const lengthView = new DataView(blocks.buffer);
  lengthView.setUint32(blocks.length - 4, bitLength >>> 0, false);
  lengthView.setUint32(blocks.length - 8, Math.floor(bitLength / 0x1_0000_0000), false);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  const view = new DataView(blocks.buffer);
  // Typed-array element reads carry `| undefined` under
  // noUncheckedIndexedAccess; every slot is provably initialized here, so a
  // local accessor with the repo's non-null assertion idiom keeps the math
  // honest without scattering `!` through the compression function.
  const word = (t: number): number => w[t]!;
  const round = (t: number): number => SHA256_K[t]!;

  for (let block = 0; block < blocks.length; block += 64) {
    for (let t = 0; t < 16; t += 1) w[t] = view.getUint32(block + t * 4, false);
    for (let t = 16; t < 64; t += 1) {
      const s0 = rotr(word(t - 15), 7) ^ rotr(word(t - 15), 18) ^ (word(t - 15) >>> 3);
      const s1 = rotr(word(t - 2), 17) ^ rotr(word(t - 2), 19) ^ (word(t - 2) >>> 10);
      w[t] = (word(t - 16) + s0 + word(t - 7) + s1) >>> 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let t = 0; t < 64; t += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + round(t) + word(t)) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e;
      e = (d + temp1) >>> 0;
      d = c; c = b; b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7].map(toHex8).join("");
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (value: number, bits: number): number => ((value >>> bits) | (value << (32 - bits))) >>> 0;
const toHex8 = (value: number): string => value.toString(16).padStart(8, "0");

/**
 * Minimal dependency-free UTF-8 encoder (RFC 3629). Deterministic and
 * environment-independent — the fingerprint vocabulary is ASCII, but the
 * canonical string must encode identically in every runtime regardless.
 */
function encodeUtf8(input: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const code = input.codePointAt(i)!;
    if (code > 0xffff) i += 1; // surrogate pair consumed as one code point
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >>> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >>> 12), 0x80 | ((code >>> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >>> 18),
        0x80 | ((code >>> 12) & 0x3f),
        0x80 | ((code >>> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}

/** Fingerprint input parts; every part is normalized (sorted + de-duplicated). */
export interface BuildFingerprintParts {
  /** Capabilities the sessiond build advertises via `system.hello`. */
  sessiondCapabilities: readonly string[];
  /** sessiond ↔ Worker IPC message-type vocabulary of this build. */
  workerMessageTypes: readonly string[];
  /** Runtime capability wire vocabulary mirrored from Runtime Core. */
  runtimeCapabilities: readonly string[];
}

/**
 * Compute the deterministic capability fingerprint over the canonical string
 *
 * ```
 * <format>
 * runtimeCapabilities=<sorted csv>
 * sessiondCapabilities=<sorted csv>
 * workerMessageTypes=<sorted csv>
 * ```
 *
 * Input order never matters (sorted), duplicates never matter (de-duplicated),
 * and the key set is fixed, so the same vocabulary always yields the same
 * fingerprint in every process. Any vocabulary difference yields a different
 * fingerprint — that is the fence.
 */
export function computeBuildFingerprint(parts: BuildFingerprintParts): BuildFingerprint {
  const canonical = [
    BUILD_FINGERPRINT_FORMAT,
    `runtimeCapabilities=${sortedUniqueStrings(parts.runtimeCapabilities).join(",")}`,
    `sessiondCapabilities=${sortedUniqueStrings(parts.sessiondCapabilities).join(",")}`,
    `workerMessageTypes=${sortedUniqueStrings(parts.workerMessageTypes).join(",")}`,
  ].join("\n");
  return sha256Hex(canonical);
}

// ---------------------------------------------------------------------------
// Compatibility matrix
// ---------------------------------------------------------------------------

/** Fixed, structured reason a sessiond build is not reusable-compatible. */
export type SessiondBuildIncompatibilityReason =
  | "missing_build"
  | "malformed_build"
  | "product"
  | "protocol"
  | "sessiond_contract"
  | "worker_contract"
  | "adapter_contract"
  | "fingerprint";

export type SessiondBuildCompatibility =
  | { state: "compatible" }
  | { state: "incompatible"; reason: SessiondBuildIncompatibilityReason };

/** Fixed, structured reason a Worker build is not admissible. */
export type WorkerBuildIncompatibilityReason =
  | "missing_build"
  | "malformed_build"
  | "worker_contract"
  | "adapter_contract"
  | "fingerprint";

export type WorkerBuildCompatibility =
  | { state: "compatible" }
  | { state: "incompatible"; reason: WorkerBuildIncompatibilityReason };

/**
 * Evaluate an observed `system.hello` / `worker.init` build block against the
 * EXACT build this peer was compiled with. Same protocol major proves nothing
 * by itself: product, protocol, all three contract generations, and the
 * capability fingerprint must match exactly. Missing or malformed blocks are
 * honest structured incompatibilities, never permissive success.
 */
export function evaluateSessiondBuild(
  observed: unknown,
  expected: SessiondBuild,
): SessiondBuildCompatibility {
  if (observed === undefined || observed === null) {
    return { state: "incompatible", reason: "missing_build" };
  }
  const parsed = SessiondBuildSchema.safeParse(observed);
  if (!parsed.success) {
    return { state: "incompatible", reason: "malformed_build" };
  }
  const build = parsed.data;
  if (build.product !== expected.product) return { state: "incompatible", reason: "product" };
  if (build.protocol !== expected.protocol) return { state: "incompatible", reason: "protocol" };
  if (build.sessiond !== expected.sessiond) return { state: "incompatible", reason: "sessiond_contract" };
  if (build.workerContract !== expected.workerContract) return { state: "incompatible", reason: "worker_contract" };
  if (build.adapterContract !== expected.adapterContract) return { state: "incompatible", reason: "adapter_contract" };
  if (build.fingerprint !== expected.fingerprint) return { state: "incompatible", reason: "fingerprint" };
  return { state: "compatible" };
}

/**
 * Evaluate an observed `worker.ready` build block against the exact Worker
 * contract this sessiond was compiled with (see {@link WORKER_BUILD_IDENTITY}).
 * Unknown/older/malformed Worker builds are rejected fail-closed.
 */
export function evaluateWorkerBuild(
  observed: unknown,
  expected: WorkerBuild,
): WorkerBuildCompatibility {
  if (observed === undefined || observed === null) {
    return { state: "incompatible", reason: "missing_build" };
  }
  const parsed = WorkerBuildSchema.safeParse(observed);
  if (!parsed.success) {
    return { state: "incompatible", reason: "malformed_build" };
  }
  const build = parsed.data;
  if (build.workerContract !== expected.workerContract) return { state: "incompatible", reason: "worker_contract" };
  if (build.adapterContract !== expected.adapterContract) return { state: "incompatible", reason: "adapter_contract" };
  if (build.fingerprint !== expected.fingerprint) return { state: "incompatible", reason: "fingerprint" };
  return { state: "compatible" };
}

/**
 * Convenience constructor for tests/composition: builds the canonical sessiond
 * identity for a given vocabulary set. Production uses the frozen
 * {@link SESSIOND_BUILD_IDENTITY} exported from the worker contract module
 * (which owns the IPC message-type vocabulary derivation).
 */
export function sessiondBuildFor(parts: BuildFingerprintParts): SessiondBuild {
  return Object.freeze({
    product: PIX_PRODUCT_VERSION,
    protocol: PROTOCOL_VERSION,
    sessiond: SESSIOND_CONTRACT_VERSION,
    workerContract: WORKER_CONTRACT_VERSION,
    adapterContract: ADAPTER_CONTRACT_VERSION,
    fingerprint: computeBuildFingerprint(parts),
  });
}

/**
 * Convenience constructor for the canonical Worker identity: the Worker
 * contract fields plus the SAME build fingerprint (one build, one
 * fingerprint).
 */
export function workerBuildFor(fingerprint: BuildFingerprint): WorkerBuild {
  return Object.freeze({
    workerContract: WORKER_CONTRACT_VERSION,
    adapterContract: ADAPTER_CONTRACT_VERSION,
    fingerprint,
  });
}
