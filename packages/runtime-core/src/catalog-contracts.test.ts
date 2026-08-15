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
import { THEME_CSS_VAR_KEYS } from "./index.js";
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
  SessionTree,
  SessionTreeNode,
  SessionTreeNodeKind,
  ThemeCatalogPort,
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

// Read-only theme catalog: exactly the two read methods — no write/reload and
// NO expansion of ResourceCatalogPort (themes are a separate narrow port, not
// a resource-catalog seam).
const _themeNoWrite: Missing<ThemeCatalogPort, "writeTheme"> = true;
const _themeNoReload: Missing<ThemeCatalogPort, "reload"> = true;
const _themeNoListSkills: Missing<ThemeCatalogPort, "listSkills"> = true;
const _themeNotResourceCatalog: Assignable<
  ThemeCatalogPort,
  ResourceCatalogPort
> = false;
const _resourceCatalogNotTheme: Assignable<
  ResourceCatalogPort,
  ThemeCatalogPort
> = false;
const _themeExact: IsExact<
  keyof ThemeCatalogPort,
  "listThemeSets" | "resolveTheme"
> = true;

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
// (list/read/context/tree) nor the legacy catalog deleteSession. The read-only
// SessionCatalogPort keeps its existing deleteSession (unchanged contract).
const _mutNoList: Missing<SessionMutationPort, "listSessions"> = true;
const _mutNoRead: Missing<SessionMutationPort, "readSession"> = true;
const _mutNoContext: Missing<SessionMutationPort, "readSessionContext"> = true;
const _mutNoTree: Missing<SessionMutationPort, "readSessionTree"> = true;
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

test("a read-only theme catalog object exposes exactly the two read methods", () => {
  const catalog: ThemeCatalogPort = {
    listThemeSets: () => Promise.resolve([]),
    resolveTheme: () => Promise.reject(new Error("not implemented")),
  };
  assert.deepEqual(Object.keys(catalog).sort(), ["listThemeSets", "resolveTheme"]);
});

test("the theme CSS variable whitelist is the frozen 29-key web-client surface", () => {
  // Order is part of the frozen projection; every key is a custom property.
  assert.equal(THEME_CSS_VAR_KEYS.length, 29);
  for (const key of THEME_CSS_VAR_KEYS) {
    assert.match(key, /^--[a-z-]+$/, `${key} must be a lowercase CSS custom property`);
  }
  // Defensive-corruption guard: no duplicates can ever enter the whitelist.
  assert.equal(new Set(THEME_CSS_VAR_KEYS).size, THEME_CSS_VAR_KEYS.length);
});

test("a read-only session catalog object exposes no renameSession", () => {
  const catalog: SessionCatalogPort = {
    listSessions: () => Promise.resolve([]),
    readSession: () => Promise.reject(new Error("not implemented")),
    readSessionContext: () => Promise.reject(new Error("not implemented")),
    readSessionTree: () => Promise.reject(new Error("not implemented")),
    deleteSession: () => Promise.resolve(),
  };
  const keys = Object.keys(catalog);
  assert.ok(!keys.includes("renameSession"));
  assert.ok(keys.includes("deleteSession"), "legacy deleteSession stays on the catalog");
  assert.ok(keys.includes("readSessionTree"), "the branch-tree read stays on the catalog");
});

/* ------------------------------------------------------------------ */
/* Session branch-tree contract (BranchNavigator slice)               */
/* ------------------------------------------------------------------ */

// The tree node kind vocabulary is EXACT: six normalized pix-owned kinds and
// no backend entry-type string ever leaks into the canonical model.
const _treeKindExact: IsExact<
  SessionTreeNodeKind,
  "user" | "assistant" | "toolResult" | "bashExecution" | "custom" | "system"
> = true;

// The tree DTO carries structural ids/labels only — never a raw message
// object, raw file path or any live-runtime state field.
const _treeNoMessages: Missing<SessionTree, "messages"> = true;
const _treeNoEntries: Missing<SessionTree, "entries"> = true;
const _treeNoSessionFile: Missing<SessionTree, "sessionFile"> = true;
const _treeNoWorkerState: Missing<SessionTree, "workerStatus"> = true;
const _treeNodeNoMessage: Missing<SessionTreeNode, "message"> = true;
const _treeNodeNoLabel: Missing<SessionTreeNode, "path"> = true;

// readSessionTree returns the canonical tree and stays read-only (no
// activation surface on the catalog).
const _catalogNoActivate: Missing<SessionCatalogPort, "activate"> = true;
const _catalogNoOpen: Missing<SessionCatalogPort, "open"> = true;

test("the normalized session tree is JSON-serializable and carries no message payloads", () => {
  const tree: SessionTree = {
    sessionId: "s1",
    currentLeafId: "e2",
    entryCount: 3,
    roots: [
      {
        entryId: "e1",
        kind: "user",
        label: "hello world",
        truncated: false,
        children: [
          {
            entryId: "e3",
            parentEntryId: "e1",
            kind: "assistant",
            label: "sure",
            truncated: false,
            children: [],
            skippedEntryIds: ["e2"],
          },
        ],
      },
    ],
  };
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(tree)));
  const json = JSON.stringify(tree);
  assert.ok(!json.includes("message"), "tree must not carry message payloads");
  assert.ok(!json.includes("thinking"), "tree must not carry thinking text");
  assert.ok(!json.includes("toolCall"), "tree must not carry tool payloads");
  assert.ok(!json.includes(".jsonl"), "tree must not carry raw file paths");
});

test("the session tree kinds are exactly the six normalized values", () => {
  const kinds: readonly SessionTreeNodeKind[] = [
    "user",
    "assistant",
    "toolResult",
    "bashExecution",
    "custom",
    "system",
  ];
  assert.equal(new Set(kinds).size, 6);
  for (const kind of kinds) {
    assert.match(kind, /^(user|assistant|toolResult|bashExecution|custom|system)$/);
  }
});
