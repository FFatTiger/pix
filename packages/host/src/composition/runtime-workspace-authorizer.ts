/**
 * Host-owned exact-session workspace authorizer (LC-01).
 *
 * Live observation and explicit activation never trust client cwd/projectRoot/
 * access flags. Identity is resolved from authenticated sessiond surfaces:
 *
 *   1. bounded `runtime.listRunning` exact sessionId match
 *   2. if that live snapshot is valid and contains no such session, inactive
 *      `activate` may use exact `sessions.read`
 *
 * Both paths classify cwd/projectRoot through the existing
 * {@link classifyWorkspaceAccess} / AllowedRoots owner. A failed or malformed
 * live lookup is unavailable (never pretended empty). Catalog is never a
 * fallback for a live miss that is not a proven empty snapshot.
 */
import {
  RuntimeListRunningResultSchema,
  SessionHeaderSchema,
  type ProtocolError,
  type RuntimeRunningItem,
  type SessiondMethodParams,
  type SessiondMethodResult,
  type SessiondRpcMethod,
} from "@fffattiger/pix-protocol";
import { classifyWorkspaceAccess, type WorkspaceAccess } from "../resources/workspace-access.js";
import type { AllowedRootService } from "../resources/allowed-roots.js";

/** Narrow read-only sessiond surface the authorizer consumes. */
export interface RuntimeWorkspaceLookupClient {
  call<M extends SessiondRpcMethod>(method: M, params: SessiondMethodParams[M], timeoutMs?: number): Promise<SessiondMethodResult[M]>;
}

export type RuntimeWorkspaceAuthorizeIntent = "observe" | "activate";

export interface RuntimeWorkspaceIdentity {
  readonly sessionId: string;
  readonly cwd: string;
  readonly projectRoot: string;
  readonly epoch?: string;
  readonly workerStatus?: RuntimeRunningItem["workerStatus"];
}

export type RuntimeWorkspaceAuthorization =
  | {
      readonly ok: true;
      readonly source: "live" | "catalog";
      readonly identity: RuntimeWorkspaceIdentity;
      readonly access: WorkspaceAccess;
    }
  | {
      readonly ok: false;
      readonly error: ProtocolError;
      readonly access?: WorkspaceAccess;
      readonly identity?: RuntimeWorkspaceIdentity;
    };

export interface RuntimeWorkspaceAuthorizer {
  authorize(request: {
    readonly sessionId: unknown;
    readonly intent: RuntimeWorkspaceAuthorizeIntent;
  }): Promise<RuntimeWorkspaceAuthorization>;
}

export interface RuntimeWorkspaceAuthorizerOptions {
  readonly client: RuntimeWorkspaceLookupClient;
  readonly roots: AllowedRootService | undefined;
  /** Bounded live lookup timeout (default 2_000 ms). */
  readonly listTimeoutMs?: number;
  /** Bounded catalog lookup timeout (default 2_000 ms). */
  readonly catalogTimeoutMs?: number;
}

const DEFAULT_LOOKUP_TIMEOUT_MS = 2_000;

/**
 * Live eligibility mirrors sessiond `requireActive` / `runningItems`:
 * crashed, stopped, and stopping are not attachable. starting/idle/ready/busy
 * remain live. `unavailable` is never a live record status.
 */
function isRequireActiveStatus(status: RuntimeRunningItem["workerStatus"]): boolean {
  return status !== "crashed" && status !== "stopped" && status !== "stopping" && status !== "unavailable";
}

function sanitizedError(code: ProtocolError["code"], message: string): ProtocolError {
  return { code, message, retryable: false };
}

function invalidSessionId(value: unknown): boolean {
  return typeof value !== "string" || value.length === 0 || !/[^\s]/.test(value);
}

function identityFromLive(item: RuntimeRunningItem): RuntimeWorkspaceIdentity {
  return {
    sessionId: item.sessionId,
    cwd: item.cwd,
    projectRoot: item.projectRoot,
    ...(item.epoch === undefined ? {} : { epoch: item.epoch }),
    workerStatus: item.workerStatus,
  };
}

function identityFromCatalog(detail: { sessionId: string; cwd: string; projectRoot: string }): RuntimeWorkspaceIdentity {
  return {
    sessionId: detail.sessionId,
    cwd: detail.cwd,
    projectRoot: detail.projectRoot,
  };
}

async function classifyIdentity(
  roots: AllowedRootService | undefined,
  identity: RuntimeWorkspaceIdentity,
): Promise<RuntimeWorkspaceAuthorization> {
  let access: WorkspaceAccess;
  try {
    access = await classifyWorkspaceAccess(roots, {
      cwd: identity.cwd,
      projectRoot: identity.projectRoot,
    });
  } catch {
    return { ok: false, error: sanitizedError("unavailable", "workspace lookup failed") };
  }
  if (access.state === "authorized") {
    return { ok: true, source: identity.workerStatus === undefined && identity.epoch === undefined ? "catalog" : "live", identity, access };
  }
  if (access.state === "history_only") {
    return { ok: false, error: sanitizedError("forbidden", "workspace is history-only"), access, identity };
  }
  return { ok: false, error: sanitizedError("unavailable", "workspace is unavailable"), access, identity };
}

function denyFromLiveStatus(status: RuntimeRunningItem["workerStatus"]): RuntimeWorkspaceAuthorization | undefined {
  if (isRequireActiveStatus(status)) return undefined;
  return { ok: false, error: sanitizedError("worker_unavailable", "runtime is not available") };
}

/**
 * Narrow production authorizer constructor. Tests and CLI composition inject
 * the same trusted sessiond client + AllowedRoots; this is not a second policy
 * owner.
 */
export function createRuntimeWorkspaceAuthorizer(
  options: RuntimeWorkspaceAuthorizerOptions,
): RuntimeWorkspaceAuthorizer {
  const listTimeoutMs = options.listTimeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS;
  const catalogTimeoutMs = options.catalogTimeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS;
  return {
    async authorize(request) {
      if (invalidSessionId(request.sessionId)) {
        return { ok: false, error: sanitizedError("invalid_input", "session identity is invalid") };
      }
      const sessionId = request.sessionId as string;
      let liveRaw: unknown;
      try {
        liveRaw = await options.client.call("runtime.listRunning", {}, listTimeoutMs);
      } catch {
        return { ok: false, error: sanitizedError("unavailable", "workspace lookup failed") };
      }
      const live = RuntimeListRunningResultSchema.safeParse(liveRaw);
      if (!live.success) {
        return { ok: false, error: sanitizedError("unavailable", "workspace lookup failed") };
      }
      const matches = live.data.sessions.filter((item) => item.sessionId === sessionId);
      if (matches.length > 1) {
        return { ok: false, error: sanitizedError("unavailable", "workspace lookup failed") };
      }
      if (matches.length === 1) {
        const item = matches[0]!;
        const statusDeny = denyFromLiveStatus(item.workerStatus);
        if (statusDeny) return statusDeny;
        const classified = await classifyIdentity(options.roots, identityFromLive(item));
        if (classified.ok) return { ...classified, source: "live" };
        return classified;
      }
      if (request.intent === "observe") {
        return { ok: false, error: sanitizedError("worker_unavailable", "runtime is not available") };
      }
      let catalogRaw: unknown;
      try {
        catalogRaw = await options.client.call("sessions.read", { sessionId }, catalogTimeoutMs);
      } catch (error) {
        if (error !== null && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "not_found") {
          return { ok: false, error: sanitizedError("not_found", "session was not found") };
        }
        return { ok: false, error: sanitizedError("unavailable", "workspace lookup failed") };
      }
      const catalog = SessionHeaderSchema.safeParse(catalogRaw);
      if (!catalog.success || catalog.data.sessionId !== sessionId) {
        return { ok: false, error: sanitizedError("unavailable", "workspace lookup failed") };
      }
      const classified = await classifyIdentity(options.roots, identityFromCatalog(catalog.data));
      if (classified.ok) return { ...classified, source: "catalog" };
      return classified;
    },
  };
}

export function identitiesMatch(
  expected: RuntimeWorkspaceIdentity,
  observed: { readonly sessionId: string; readonly cwd: string; readonly projectRoot: string; readonly epoch?: string },
  options: { readonly requireEpoch?: boolean } = {},
): boolean {
  if (observed.sessionId !== expected.sessionId) return false;
  if (observed.cwd !== expected.cwd) return false;
  if (observed.projectRoot !== expected.projectRoot) return false;
  // Activate mints a new epoch by design. Observe/attach compare the live epoch
  // when the authorizer captured one — a mismatch is an identity fence, not a
  // filesystem race claim.
  if (options.requireEpoch === true && expected.epoch !== undefined && observed.epoch !== expected.epoch) {
    return false;
  }
  return true;
}
