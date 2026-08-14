/**
 * Type- and runtime-level contract tests for the read-only domain catalog
 * foundation (D3B-R1A): exact project-trust tri-state, project catalog
 * context shape, and read/query vs mutation port segregation.
 *
 * These guards are compile-time exactness checks: a violation is a `tsc`
 * error during `build:test`/`typecheck`, so the type assertions live at module
 * scope. Runtime checks follow for the trust vocabulary.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  CredentialCatalogPort,
  CredentialStorePort,
  ModelCatalogPort,
  ProjectCatalogContext,
  ProjectTrustPort,
  ProjectTrustQueryPort,
  ProjectTrustState,
  ResourceCatalogPort,
  ResourceCatalogStorePort,
  SessionCatalogPort,
  SessionMutationPort,
  TrustGateResult,
} from "./index.js";

/* ------------------------------------------------------------------ */
/* Compile-time exactness (module scope)                              */
/* ------------------------------------------------------------------ */

/** True when A and B are the exact same type. */
type IsExact<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2
      ? true
      : false
    : false;

/** `true` when `M` is NOT a member of type `T`'s keys. */
type Missing<T, M extends string> = M extends keyof T ? "MUST_NOT_EXIST" : true;

/** `true` when `A` is assignable to `B`. */
type Assignable<A, B> = A extends B ? true : false;

// Trust is an EXACT tri-state. Adding a fourth state or dropping one fails this.
const _trustStateExact: IsExact<
  ProjectTrustState,
  "unknown" | "trusted" | "denied"
> = true;

// Project catalog context carries exactly the canonical cwd.
const _contextExact: IsExact<ProjectCatalogContext, { readonly cwd: string }> =
  true;

// Read-only model catalog: no refresh/test/configure/setModel network writes.
const _modelNoRefresh: Missing<ModelCatalogPort, "refresh"> = true;
const _modelNoSetModel: Missing<ModelCatalogPort, "setModel"> = true;
const _modelNoConfigure: Missing<ModelCatalogPort, "configure"> = true;

// Read-only credential catalog: provider metadata/status only — no authorize/logout.
const _credNoAuthorize: Missing<CredentialCatalogPort, "authorize"> = true;
const _credNoLogout: Missing<CredentialCatalogPort, "logout"> = true;

// Read-only resource catalog: metadata only — no write/install/toggle/reload.
const _resNoWrite: Missing<ResourceCatalogPort, "writePlugin"> = true;
const _resNoInstall: Missing<ResourceCatalogPort, "installSkill"> = true;
const _resNoToggle: Missing<ResourceCatalogPort, "setPluginEnabled"> = true;
const _resNoReload: Missing<ResourceCatalogPort, "reload"> = true;

// Read-only trust query: no setTrust mutation and no full-status accessor.
const _trustQueryNoSet: Missing<ProjectTrustQueryPort, "setTrust"> = true;
const _trustQueryLeanOnly: Missing<ProjectTrustQueryPort, "getTrust"> = true;

// Mutation ports are separately declared and each EXTENDS its read-only port
// (they are not a combined cross-domain writable object).
const _storeExtendsCatalog: Assignable<
  CredentialStorePort,
  CredentialCatalogPort
> = true;
const _resStoreExtendsRead: Assignable<
  ResourceCatalogStorePort,
  ResourceCatalogPort
> = true;
const _trustPortExtendsQuery: Assignable<ProjectTrustPort, ProjectTrustQueryPort> =
  true;

// The reverse is NOT assignable: a read-only port is not a mutation port.
const _catalogIsNotStore: Assignable<CredentialCatalogPort, CredentialStorePort> =
  false;
const _readIsNotStore: Assignable<ResourceCatalogPort, ResourceCatalogStorePort> =
  false;
const _queryIsNotPort: Assignable<ProjectTrustQueryPort, ProjectTrustPort> = false;

// Session mutation (offline rename) is a SEPARATE, narrow port: it carries
// only `renameSession` and never exposes the read-side catalog surface
// (list/read/context) nor the legacy catalog deleteSession. The read-only
// SessionCatalogPort keeps its existing deleteSession (unchanged contract).
const _mutNoList: Missing<SessionMutationPort, "listSessions"> = true;
const _mutNoRead: Missing<SessionMutationPort, "readSession"> = true;
const _mutNoContext: Missing<SessionMutationPort, "readSessionContext"> = true;
const _mutNoLocate: Missing<SessionMutationPort, "locate"> = true;
const _mutNoDelete: Missing<SessionMutationPort, "deleteSession"> = true;
const _mutOnlyRename: Assignable<
  SessionMutationPort,
  { renameSession(sessionId: string, name: string): Promise<void> }
> = true;

// The mutation port and the read-only catalog stay distinct: neither is
// assignable to the other (a catalog object cannot serve as a rename port and
// a rename port cannot serve as a catalog).
const _mutNotCatalog: Assignable<SessionMutationPort, SessionCatalogPort> = false;
const _catalogNotMut: Assignable<SessionCatalogPort, SessionMutationPort> = false;

/* ------------------------------------------------------------------ */
/* Runtime vocabulary checks                                          */
/* ------------------------------------------------------------------ */

const TRUST_STATES: readonly ProjectTrustState[] = [
  "unknown",
  "trusted",
  "denied",
];

test("project trust state is exactly the tri-state {unknown,trusted,denied}", () => {
  assert.deepEqual([...TRUST_STATES].sort(), ["denied", "trusted", "unknown"]);
  for (const state of TRUST_STATES) {
    assert.ok(typeof state === "string" && state.length > 0);
  }
});

test("trust gate result carries the tri-state level, not a binary marker", () => {
  const denied: TrustGateResult = {
    allowed: false,
    level: "denied",
    reason: "project is not trusted",
  };
  const trusted: TrustGateResult = { allowed: true, level: "trusted" };
  const unknown: TrustGateResult = { allowed: false, level: "unknown" };
  assert.equal(denied.level, "denied");
  assert.equal(trusted.allowed, true);
  assert.equal(unknown.allowed, false);
  // JSON-serializable, backend-neutral, no SDK type leakage.
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(denied)));
});

test("a read-only resource catalog object exposes no mutation methods", () => {
  const read: ResourceCatalogPort = {
    listSkills: () => Promise.resolve([]),
    listPlugins: () => Promise.resolve([]),
    listCommands: () => Promise.resolve([]),
  };
  const keys = Object.keys(read);
  assert.ok(!keys.includes("writePlugin"));
  assert.ok(!keys.includes("installSkill"));
  assert.ok(!keys.includes("reload"));
});

test("a read-only trust query object exposes no mutation methods", () => {
  const query: ProjectTrustQueryPort = {
    getProjectTrustState: () => Promise.resolve("unknown"),
    isTrusted: () => Promise.resolve(false),
    canReloadResources: () =>
      Promise.resolve({ allowed: false, level: "unknown" }),
  };
  const keys = Object.keys(query);
  assert.ok(!keys.includes("setTrust"));
  assert.ok(!keys.includes("getTrust"));
});

test("the session mutation port exposes only renameSession", () => {
  const mutation: SessionMutationPort = {
    renameSession: () => Promise.resolve(),
  };
  const keys = Object.keys(mutation);
  assert.deepEqual(keys, ["renameSession"]);
  assert.equal(typeof mutation.renameSession, "function");
});

test("a read-only session catalog object exposes no renameSession", () => {
  const catalog: SessionCatalogPort = {
    listSessions: () => Promise.resolve([]),
    readSession: () => Promise.reject(new Error("not implemented")),
    readSessionContext: () => Promise.reject(new Error("not implemented")),
    deleteSession: () => Promise.resolve(),
  };
  const keys = Object.keys(catalog);
  assert.ok(!keys.includes("renameSession"));
  assert.ok(keys.includes("deleteSession"), "legacy deleteSession stays on the catalog");
});
