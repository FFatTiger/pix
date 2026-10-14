/**
 * Sessiond-owned durable workspace state (round 5 redo; round 7 merge).
 *
 * User organization preferences (session + project pin/archive) AND the
 * assistant delegation ledger live HERE — never in the Pi session JSONL
 * (that is chat-record truth with a live writer in the worker process) and
 * never in the disposable SQLite projection. This file is the single
 * writer's store: only SessiondService mutates it, every mutation bumps a
 * revision and writes atomically, and a projection rebuild can never lose
 * it.
 *
 * Layout (PIX_SESSIOND_DIR):
 *   workspace-state.json        — schema v2 document (0600, regular file)
 *   workspace-state.json.tmp    — same-dir staging file, atomic rename target
 *
 * Document shape (namespaced for organization state):
 * {
 *   "kind": "pix.sessiond.workspace-state",
 *   "schemaVersion": 2,
 *   "revision": 42,
 *   "sessions":  { "<sessionId>":  { "pinned": true, "archived": false } },
 *   "projects":  { "<projectRoot>": { "pinned": true, "archived": false } },
 *   "assistantDelegations": { …opaque ledger owned by assistant-ops.ts… }
 * }
 *
 * `assistantDelegations` is an OPAQUE namespace: the store only persists and
 * reloads it verbatim — shape validation belongs to its owner
 * (assistant-ops.ts), so a semantically-broken ledger degrades to "empty" in
 * the owner without quarantining the user's pin/archive flags. It never
 * surfaces on /v1/workspace-flags and never triggers sessions_changed.
 * Schema v1 files predate the namespace: reading one yields
 * `assistantDelegations === undefined` (empty), and the next write upgrades
 * the document to v2.
 *
 * Durability discipline (mirrors the daemon settings file, hardened):
 *   - temp write (0600) → fsync → atomic rename, same directory
 *   - corrupt/unreadable file is QUARANTINED (renamed to
 *     workspace-state.json.corrupt-<epoch-ms>) and the store restarts empty:
 *     organization prefs are user convenience, never worth bricking sessiond.
 *   - missing file ⇒ empty state (revision 0)
 *
 * Path safety: project keys must be absolute normalized paths; the HOST layer
 * additionally checks AllowedRoots before forwarding a project write.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export const WORKSPACE_STATE_KIND = "pix.sessiond.workspace-state" as const;
export const WORKSPACE_STATE_SCHEMA_VERSION = 2 as const;
export const WORKSPACE_STATE_FILE_NAME = "workspace-state.json";
/** Schema versions this build can READ (writes are always current-version). */
const READABLE_SCHEMA_VERSIONS = new Set([1, WORKSPACE_STATE_SCHEMA_VERSION]);

export interface WorkspaceFlags {
  pinned?: boolean;
  archived?: boolean;
}

export interface WorkspaceStateSnapshot {
  readonly revision: number;
  readonly sessions: Readonly<Record<string, WorkspaceFlags>>;
  readonly projects: Readonly<Record<string, WorkspaceFlags>>;
  /** Opaque assistant delegation ledger (owner: assistant-ops.ts). Absent on
   * schema-v1 documents and until the first delegation write. */
  readonly assistantDelegations?: unknown;
}

export interface WorkspaceStateMutationInput {
  readonly pinned?: boolean;
  readonly archived?: boolean;
}

/** Effective merged flags for one entry (absent fields keep their value). */
export function mergeWorkspaceFlags(previous: WorkspaceFlags | undefined, patch: WorkspaceStateMutationInput): Required<WorkspaceFlags> {
  const base = previous ?? {};
  return {
    pinned: patch.pinned !== undefined ? patch.pinned : base.pinned === true,
    archived: patch.archived !== undefined ? patch.archived : base.archived === true,
  };
}

function isPlainFlags(value: unknown): value is WorkspaceFlags {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "pinned" && key !== "archived") return false;
    const flag = record[key];
    if (flag !== undefined && typeof flag !== "boolean") return false;
  }
  return true;
}

function parseNamespace(value: unknown): Record<string, WorkspaceFlags> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, WorkspaceFlags> = {};
  for (const [key, flags] of Object.entries(value as Record<string, unknown>)) {
    if (key.length === 0 || !isPlainFlags(flags)) return null;
    out[key] = flags;
  }
  return out;
}

function parseDocument(raw: string): WorkspaceStateSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.kind !== WORKSPACE_STATE_KIND) return null;
  const schemaVersion = record.schemaVersion;
  if (schemaVersion !== WORKSPACE_STATE_SCHEMA_VERSION && !READABLE_SCHEMA_VERSIONS.has(schemaVersion as number)) return null;
  if (typeof record.revision !== "number" || !Number.isSafeInteger(record.revision) || record.revision < 0) return null;
  const sessions = parseNamespace(record.sessions);
  const projects = parseNamespace(record.projects);
  if (sessions === null || projects === null) return null;
  // v1 documents carry no assistantDelegations namespace (undefined = empty).
  // For v2 the value is passed through verbatim — its shape is validated by
  // the owning module, never here.
  const delegations = (schemaVersion as number) >= 2 ? record.assistantDelegations : undefined;
  return delegations === undefined
    ? { revision: record.revision, sessions, projects }
    : { revision: record.revision, sessions, projects, assistantDelegations: delegations };
}

/** Normalize a project key: absolute, resolved, no trailing separator. */
export function normalizeProjectKey(projectRoot: string): string | null {
  if (typeof projectRoot !== "string" || projectRoot.length === 0 || projectRoot.includes("\u0000")) return null;
  if (!isAbsolute(projectRoot)) return null;
  try {
    return resolve(projectRoot);
  } catch {
    return null;
  }
}

/** Write-through contract shared by the durable file store and the test double. */
export interface WorkspaceStateStore {
  /** Point-in-time snapshot (defensive copies; cheap — maps are small). */
  snapshot(): WorkspaceStateSnapshot;
  /** Set flags for one entry; at least one field required. Returns effective flags. */
  setSessionFlags(sessionId: string, patch: WorkspaceStateMutationInput): Required<WorkspaceFlags>;
  setProjectFlags(projectRoot: string, patch: WorkspaceStateMutationInput): Required<WorkspaceFlags>;
  /** Opaque assistant delegation ledger (owner: assistant-ops.ts). Undefined
   * until the first write; never surfaced on any external API. */
  readAssistantDelegations(): unknown;
  /** Replace the whole ledger value and bump the shared revision. */
  writeAssistantDelegations(value: unknown): void;
}

export class WorkspaceStateError extends Error {
  constructor(public readonly code: "invalid_input" | "unavailable", message: string, public readonly retryable: boolean) {
    super(message);
    this.name = "WorkspaceStateError";
  }
}

/** In-memory store for tests (same contract, no durability). */
export class InMemoryWorkspaceStateStore implements WorkspaceStateStore {
  private revision = 0;
  private readonly sessions: Record<string, WorkspaceFlags> = {};
  private readonly projects: Record<string, WorkspaceFlags> = {};
  private delegations: unknown;

  snapshot(): WorkspaceStateSnapshot {
    return {
      revision: this.revision,
      sessions: { ...this.sessions },
      projects: { ...this.projects },
      ...(this.delegations === undefined ? {} : { assistantDelegations: this.delegations }),
    };
  }

  setSessionFlags(sessionId: string, patch: WorkspaceStateMutationInput): Required<WorkspaceFlags> {
    if (typeof sessionId !== "string" || sessionId.length === 0) throw new WorkspaceStateError("invalid_input", "session id is invalid", false);
    if (patch.pinned === undefined && patch.archived === undefined) throw new WorkspaceStateError("invalid_input", "at least one flag must be provided", false);
    const merged = mergeWorkspaceFlags(this.sessions[sessionId], patch);
    this.sessions[sessionId] = merged;
    this.revision += 1;
    return merged;
  }

  setProjectFlags(projectRoot: string, patch: WorkspaceStateMutationInput): Required<WorkspaceFlags> {
    const key = normalizeProjectKey(projectRoot);
    if (key === null) throw new WorkspaceStateError("invalid_input", "project root is invalid", false);
    if (patch.pinned === undefined && patch.archived === undefined) throw new WorkspaceStateError("invalid_input", "at least one flag must be provided", false);
    const merged = mergeWorkspaceFlags(this.projects[key], patch);
    this.projects[key] = merged;
    this.revision += 1;
    return merged;
  }

  readAssistantDelegations(): unknown {
    return this.delegations;
  }

  writeAssistantDelegations(value: unknown): void {
    this.delegations = value;
    this.revision += 1;
  }
}

/**
 * Durable file-backed store. Constructed once by the daemon composition; the
 * service is the only caller (single writer). Load is lazy+cached with
 * write-through persistence.
 */
export class FileWorkspaceStateStore implements WorkspaceStateStore {
  private state: WorkspaceStateSnapshot | null = null;
  private readonly filePath: string;

  constructor(directory: string) {
    this.filePath = resolve(directory, WORKSPACE_STATE_FILE_NAME);
  }

  snapshot(): WorkspaceStateSnapshot {
    return { ...(this.state ?? (this.state = this.load())) };
  }

  setSessionFlags(sessionId: string, patch: WorkspaceStateMutationInput): Required<WorkspaceFlags> {
    if (typeof sessionId !== "string" || sessionId.length === 0) throw new WorkspaceStateError("invalid_input", "session id is invalid", false);
    if (patch.pinned === undefined && patch.archived === undefined) throw new WorkspaceStateError("invalid_input", "at least one flag must be provided", false);
    const current = this.snapshot();
    const merged = mergeWorkspaceFlags(current.sessions[sessionId], patch);
    const sessions = { ...current.sessions, [sessionId]: merged };
    // Every write carries the WHOLE document — a flags mutation must never
    // drop the assistant delegations namespace (single-file single-writer).
    const next: WorkspaceStateSnapshot = current.assistantDelegations === undefined
      ? { revision: current.revision + 1, sessions, projects: current.projects }
      : { revision: current.revision + 1, sessions, projects: current.projects, assistantDelegations: current.assistantDelegations };
    this.persist(next);
    this.state = next;
    return merged;
  }

  setProjectFlags(projectRoot: string, patch: WorkspaceStateMutationInput): Required<WorkspaceFlags> {
    const key = normalizeProjectKey(projectRoot);
    if (key === null) throw new WorkspaceStateError("invalid_input", "project root is invalid", false);
    if (patch.pinned === undefined && patch.archived === undefined) throw new WorkspaceStateError("invalid_input", "at least one flag must be provided", false);
    const current = this.snapshot();
    const merged = mergeWorkspaceFlags(current.projects[key], patch);
    const projects = { ...current.projects, [key]: merged };
    const next: WorkspaceStateSnapshot = current.assistantDelegations === undefined
      ? { revision: current.revision + 1, sessions: current.sessions, projects }
      : { revision: current.revision + 1, sessions: current.sessions, projects, assistantDelegations: current.assistantDelegations };
    this.persist(next);
    this.state = next;
    return merged;
  }

  readAssistantDelegations(): unknown {
    return this.snapshot().assistantDelegations;
  }

  writeAssistantDelegations(value: unknown): void {
    const current = this.snapshot();
    const next: WorkspaceStateSnapshot = { revision: current.revision + 1, sessions: current.sessions, projects: current.projects, assistantDelegations: value };
    this.persist(next);
    this.state = next;
  }

  private load(): WorkspaceStateSnapshot {
    let raw: string;
    try {
      if (!existsSync(this.filePath)) return { revision: 0, sessions: {}, projects: {} };
      raw = readFileSync(this.filePath, "utf8");
    } catch {
      // Unreadable ⇒ treat as corrupt (quarantine below would also fail).
      return { revision: 0, sessions: {}, projects: {} };
    }
    const parsed = parseDocument(raw);
    if (parsed !== null) return parsed;
    // Corrupt: quarantine (best-effort) and restart empty. Organization prefs
    // must never brick the daemon; the user can re-pin.
    try {
      renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
    } catch {
      // Quarantine failure leaves the corrupt file; the next write's atomic
      // rename replaces it.
    }
    return { revision: 0, sessions: {}, projects: {} };
  }

  /** Atomic write: same-dir temp (0600) → fsync → rename. Throws unavailable. */
  private persist(next: WorkspaceStateSnapshot): void {
    const document = `${JSON.stringify({
      kind: WORKSPACE_STATE_KIND,
      schemaVersion: WORKSPACE_STATE_SCHEMA_VERSION,
      revision: next.revision,
      sessions: next.sessions,
      projects: next.projects,
      ...(next.assistantDelegations === undefined ? {} : { assistantDelegations: next.assistantDelegations }),
    }, null, 2)}\n`;
    const tmp = `${this.filePath}.tmp`;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
      const handle = openSync(tmp, "w", 0o600);
      try {
        writeFileSync(handle, document, "utf8");
      } finally {
        closeSync(handle);
      }
      renameSync(tmp, this.filePath);
    } catch {
      throw new WorkspaceStateError("unavailable", "could not persist workspace state", true);
    }
  }
}
