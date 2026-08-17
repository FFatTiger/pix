# Pix — Durable Development & Architecture Rules

This file is the binding contract for any agent or human editing this repository.
It distills the invariant decisions behind pix's architecture. Where it conflicts
with a one-off change, the change is wrong. Docs hierarchy: `docs/refactor-architecture.md`
(target architecture / hard rules) → `docs/refactor-execution-plan.md` (current
milestone, task board, acceptance, execution rules — the execution single source
of truth) → `docs/migration-ledger.md` (old-worktree source provenance).

## 0. Product north star (immutable)

Pix is a **protocol-centered local agent workstation**: Vite Client + Hono thin
Host + independent `pix-sessiond` + per-session Worker + pix Runtime Protocol +
Pi ACL. **Zero Next.js** anywhere in the product path.

- `jsonl` / `~/.pi` remain the truth source. No DB replaces them.
- Web can restart at any time; sessions survive. `pix-sessiond` is the **only**
  session lifecycle authority; Web only proxies/attaches.
- Read-only history browsing = **0 Workers**; no hidden Worker activation.
- Realtime is **WebSocket + snapshot/resume** only; never polling-as-streaming.
- Pi SDK (`@earendil-works/pi-*`) may be imported **only** in
  `packages/pi-sdk-adapter`. UI / Host / sessiond / worker Controller never
  import Pi SDK and never parse raw Pi RPC frames. `pi-sdk-adapter` uses
  subpath exports (`/agent`, `/sessions`, `/models`, `/resources`, `/themes`);
  never a barrel that loads every adapter.
- `runtime-core` = pix's own Ports/models/errors; zero Protocol/Pi SDK/Hono/React.
  `protocol` = wire DTOs/zod; zero runtime-core/Pi SDK/Hono/React.
- `local-authority` (secure-state primitives) imports only Node builtins + its
  own modules. Host security-critical state delegates to it.

## 1. One authoritative owner per domain

Each domain has exactly one package/module that owns it. Any other code that
touches the behavior is a defect to route back to the owner — never a place to
fork the logic.

| Domain | Owner | Nothing else may… |
|---|---|---|
| Wire contract (schemas, version, capabilities, reducer) | `packages/protocol` | invent its own DTO, token, or projection semantics |
| Runtime Ports / canonical models / app errors | `packages/runtime-core` | depend on Protocol/Pi SDK/Hono/React |
| Pi SDK translation & capability projection | `packages/pi-sdk-adapter` | touch Pi SDK types anywhere else |
| Session lifecycle authority | `packages/sessiond` | be held by Web/Client state |
| Single-session runtime mapping | `packages/agent-worker` | import Pi SDK directly |
| HTTP/WS gateway, static, gate, files/git routes | `packages/host` | own session authority or runtime models |
| Client UI + typed transports + runtime view | `packages/client` | reach into backend/daemon/Worker internals |
| CLI lifecycle | `packages/cli` | drive sessiond via SIGTERM/PID |
| Adapter behavior contract | `packages/runtime-contract-tests` | be duplicated in each adapter's own tests |
| Cross-package semantic parity | `packages/cross-package-contract-tests` | leak into a production package or be parked in an unrelated test suite |
| Repo gates / cross-platform tooling | root `scripts/*` | be bypassed by ad-hoc shell in package scripts |

## 2. State ownership (four tiers, never blurred)

- **HTTP remote state → TanStack Query** (typed query options assembled in
  `packages/client/src/api/configuration.ts`, mutations in `mutations.ts`, keys
  in `query-keys.ts`). Server resource data only.
- **Realtime runtime state → SessionStore** (projected through the **shared**
  Protocol `reduceRuntimeEventData` accumulator — identical semantics to the
  sessiond authority) exposed via `useSyncExternalStore`. Realtime state
  **never** flows through TanStack Query, and the projection is **never** forked
  or re-implemented client-side.
- **Durable client preferences → one dedicated preference store/provider per
  domain** (ui-scale, locale, layout). Only that owner reads/writes browser
  persistence and synchronizes DOM/bootstrap state; components do not access
  `localStorage` or duplicate preference caches directly. The theme and
  wallpaper preferences were removed client-side (pix ships a fixed dark
  appearance; the backend theme contracts remain backward-compatible but
  unused by this client).
- **Component-local state → ephemeral UI only** (draft text, panel open/close,
  debounce, focus). If a value must survive reload, derive from a session or
  branch, or reflect remote truth, it belongs to one of the owners above.

## 3. Transports

- All HTTP goes through the typed transport layer in
  `packages/client/src/api/` (`HttpClient` + per-response zod schema + typed
  `HttpError` with `kind`/`status`/`code`). **No raw `fetch`/`XMLHttpRequest`/
  `EventSource` in components or hooks.** Transport implementations that
  legitimately need raw primitives (for example SSE/watch streams or upload
  progress) live in `packages/client/src/api/`, preserve the same typed error /
  schema / abort contract, and expose narrow injectable surfaces. Ordinary
  request/response domains still use `HttpClient`.
  A component doing its own XHR is a violation — route it through the typed
  transport and mutation lifecycle.
- WebSocket goes only through `RuntimeSocket`/`SessionStore`. No component
  opens its own socket.

## 4. Error honesty (fail-closed, no fake success)

- Errors are structured: `ProtocolError` / `HttpError` with **fixed codes**
  (`session_busy`, `unsupported_capability`, `invalid_input`, `not_found`,
  `unavailable`, …). Fixed user-facing copy is centralized in
  `describeXxxError` helpers.
- **No silent `catch` that returns a fallback-as-success** (returning null/empty
  to hide a failure so the UI "doesn't error"). Loading indicators must reflect
  real state; no fake loading that resolves to nothing, no fake success.
- Fail closed: unknown capability → `unsupported_capability`; schema mismatch →
  decode error; stale/wrong id → `not_found`; missing optional → error, never a
  permissive default.
- Degraded mode (sessiond down) is honest: read-only stays available and keeps
  its tokens; never advertise a capability whose seam is not wired.

## 5. Compatibility shims

A compatibility shim / back-compat alias is allowed **only** with all three:

1. an explicit version or capability it bridges (named in the shim's doc),
2. a **finite removal condition** (the release/commit that deletes it),
3. tests covering the shimmed behavior.

A shim with no removal condition is dead weight and must not be added. Keep a
running tally of pending-removal shims in the migration ledger.

## 6. External IDs fail closed before permissive SDK helpers

Never feed a caller-supplied or stale ID straight into a permissive SDK helper
(e.g., `SessionManager.open`, branch/context builders, `ProjectTrustStore.set`)
that can auto-create, append, or silently select another object. Use the owner's
identity/membership validation first (exact open/index path + `getSessionId`
identity check, branch membership, revision fence / negative cache). Fail with
the canonical port error: missing resource → `not_found`; malformed or
nonmember selector/cursor → `invalid_input`; stale revision/identity race →
`conflict`. Never create-on-stale, path-reuse, or permissive fallback.

## 7. Single source for versions, capabilities, vocabularies

- Protocol version: `packages/protocol/src/version.ts` (`PROTOCOL_VERSION`) —
  negotiated at handshake; never re-declared in Host/Client.
- Host capability tokens: `packages/protocol/src/capabilities.ts`. Runtime
  capability tokens: `packages/protocol/src/domain.ts` mirroring
  `packages/runtime-core/src/capabilities.ts` through the shared semantic
  mapping. **Clients degrade by capability, never by "is this an app"** and
  never by ad-hoc strings. A new token must land in the shared schema + the
  runtime-core mirror + the semantic mapping **and** only be advertised when
  the seam is actually wired and verified.
- Canonical domain vocabularies and limits live in their Runtime Core model;
  wire-only vocabularies live in Protocol. Protocol schemas explicitly project
  domain semantics and cross-package contract tests prove parity. Host, Client,
  sessiond, and adapters never maintain independent arrays, regexes, numeric
  counts, or "must stay in sync" mirrors.

## 8. Async lifecycle = explicit state machines

Follow the `SessionStore` / sessiond patterns; never "competing effects / ref
piles" where several `useEffect` writers race to own one lifecycle.

- Every async exchange carries **identity + revision**: `sessionId`, `epoch`,
  `commandId`, `envelopeId`, `generation`. At-most-once per epoch; same-epoch
  resend with the **same** `commandId`; `epoch_changed` never resends.
- **Bounded** waits everywhere (abort/stop/ack timers); no unbounded waits.
- Each pending slot settles **exactly once** on detach / stop / dispose /
  session-switch / epoch change / capability loss; a late frame can never settle
  a newly attached session.
- sessiond authority mutations: `AUTHORITY_COMMAND_TYPES` + bounded
  `worker.getSnapshot` authoritative refresh **before** the terminal result is
  published; refresh failure is fail-closed (no cached fake success),
  same-`commandId` single-flight, triple-match against malformed/late/wrong-id
  frames, epoch/rekey ownership guard.
- `interrupt`/`stop` are independent control channels (never blocked behind a
  long prompt/bash/compact); typed admission — a different interrupt type is
  `session_busy`, the same type coalesces.

## 9. Optimistic state vs authoritative snapshots

Optimistic UI lives in its **own transaction layer**, keyed by local and
correlated command/turn identity, removed on definite failure, retained only as
an explicit uncertain-delivery state, and cleared/reconciled on commit, rebase,
or detach. Reconciliation uses authoritative identity whenever the protocol
provides it; FIFO matching is allowed only when the wire contract explicitly
guarantees ordering and deterministic tests prove it. Optimistic state never
writes into the authoritative snapshot/projection, never touches stop/abort
ordering, and never overrides authority-derived running state.

## 10. Components must not own transport + persistence + render orchestration

A component consumes typed APIs/hooks; it does not fetch, open sockets, persist,
or write projections. Query/mutation wiring is centralized in `api/`; transport
is `SessionStore`'s job; persistence is the runtime's/authority's job. If a
component grows a second transport or a persistence side-channel, that is a
layering defect.

## 11. CSS token ownership

- Design tokens are defined **once**. `pix-adapter.css` owns only pix-specific
  fallback tokens and must **never redefine** a source `globals.css` selector.
  Unsafe values such as `url()` and `expression()` never reach CSS vars.
- **No `!important` as a bug fix.** Only where the source contract already
  requires it, with a comment explaining why; never add `!important` to
  override a defect.
- **No adapter/override as bug fix**: fixing a token by layering an override
  that masks the root cause is forbidden — fix the owner of the token.

## 12. i18n

- Every user-facing string goes through `t()` (`lib/i18n`); messages live in
  `lib/i18n/messages/{en,zh-CN}.ts`, registered in `registry.ts`. **No
  hard-coded user-facing literals**, no ad-hoc error copy — use the centralized
  `describeXxxError` helpers.
- Keys interpolate via `{key}`; a missing key warns in dev and falls back to
  `en`, never crashes, never ships a raw key to production UI.

## 13. Tests

- **Races / state machines get deterministic tests**: injected fakes, timers,
  and harnesses (`runtime/testing/harness.ts`); no timing-based assertions for
  lifecycle/reconnect/authority-refresh behavior.
- **Replacement components require parity tests**: a replacement must carry
  equivalent (or stronger) coverage of every behavior it replaces, proven before
  the old component is deleted.
- `pi-sdk-adapter` must pass the shared `runtime-contract-tests` suite; any
  future `pi-rpc-adapter` reuses the same suite. Do not duplicate the contract
  in each adapter's private tests.
- **Tests may not be deleted without an equivalent replacement.** Removing a
  test to "let the refactor pass" is a defect; deletion needs a replacement of
  equal or greater coverage and a documented reason.
- Adversarial/fail-closed cases (malformed frames, stale ids, symlink escapes,
  schema mismatches, capability revocation) are mandatory, not optional.

## 14. Validation commands

Required before merge (root):

```bash
npm run check:architecture   # 14+ gate: boundaries, Next-zero, tooling normal-forms
npm run typecheck
npm test
npm run build
git diff --check
```

Plus per the touched packages: `check:boundaries` (client), adapter
`check:commands`, and E2E suites `npm run test:e2e:startup`,
`npm run test:e2e:runtime`, `npm run test:e2e:sessions` when relevant. Scope
changes to the minimum packages; touch `package-lock.json` only when a
dependency actually changes.

Tooling rules (enforced by `check:architecture`): no recursive `rm` in any
package script (use `scripts/remove-paths.mjs`); no shell-dependent
`node --test` glob (use `scripts/run-node-test.mjs`); dependency builders spawn
tsc/npm as JS CLIs through the current Node (use `scripts/tool-invocation.mjs`).

## 15. Forbidden repair patterns

Concrete forms of the "fix that must never happen":

- Adding `!important` or a CSS/adapter override to mask a bug instead of fixing
  the token owner.
- Adding a compatibility shim with no version/capability note, no removal
  condition, and no tests.
- Passing a stale/external session id into a permissive SDK helper so it
  auto-creates or appends instead of failing closed with `not_found`.
- Wrapping a failing fetch in `.catch(() => fallback)` that returns fake
  empty/success to keep the UI from erroring.
- Adding a polling interval / Query `refetchInterval` to emulate WS streaming or
  resume.
- Adding a second effect/query that also writes the runtime projection,
  competing with the shared Protocol reducer.
- Advertising a capability token whose seam is not wired/verified.
- Deleting a test file while refactoring "because the component changed".
- Reintroducing `if (backend === "sdk")` vendor branches in sessiond/Host/
  Client instead of using adapter capabilities.
- Copying a failing Next-era module into `packages/` to "make the build pass".
- Using raw `fetch`/`XMLHttpRequest`/`EventSource` in a component "because it's
  just one call".

## 16. Definition of done

A slice is done only when **all** of the following hold:

- Production change confined to the owning package(s); no unrelated churn, no
  Next-era imports, no lockfile churn unless a dependency changed.
- Root `check:architecture`, `typecheck`, `test`, `build`, `git diff --check`
  pass; per-package `check:boundaries`/`check:commands` pass; relevant E2E suites
  pass.
- New behavior carries deterministic tests (races/state machines included);
  replaced behavior has parity tests; no test deleted without equivalent
  replacement.
- Capability tokens advertised only for seams that are wired and verified;
  fail-closed and degraded paths proven by tests.
- No forbidden repair pattern introduced; no silent fallback-as-success.
- Docs updated where behavior/terminology changes
  (`docs/refactor-execution-plan.md` milestone status, `docs/migration-ledger.md`
  provenance, `docs/refactor-architecture.md` invariants).
- Changes to Runtime Core / Protocol, sessiond single-instance, Host
  security/gate, Worker/Adapter, CLI lifecycle, E2E, and multi-file core Client
  runtime were verified by an independent (non-implementer) pass.
- Working tree clean; commit message states scope and validation.
