/**
 * Host routes for the sessiond-owned workspace organization state
 * (round 5 redo): user pin/archive preferences for SESSIONS and PROJECTS.
 *
 * GET   /v1/workspace-flags          — full flags snapshot (revision + maps)
 * PATCH /v1/workspace-flags          — one entry {kind:"session"|"project",
 *                                       key, pinned?, archived?}
 *
 * Mounted ONLY when a workspace-flags seam (sessiond RPC client + mutation
 * guard) is present: a composition that wires no seam gets no route and no
 * capability token — when sessiond is down the guard 503s before any body is
 * parsed (fail closed, never a fake success). Project keys must be absolute
 * normalized paths inside AllowedRoots; the sessiond store re-validates.
 */
import type { Hono } from "hono";
import { isAbsolute } from "node:path";
import type { HostEnv } from "../env.js";
import { HttpError } from "../errors.js";
import type { MutationGuard } from "../resources/types.js";
import { readJsonObject } from "../resources/request-body.js";

export interface WorkspaceFlagsClient {
  /** Full snapshot from sessiond (`workspace.flags.get`). */
  getWorkspaceFlags(): Promise<unknown>;
  /** One-entry write (`workspace.setFlags`); at least one flag required. */
  setWorkspaceFlags(kind: "session" | "project", key: string, flags: { pinned?: boolean; archived?: boolean }): Promise<unknown>;
}

export interface WorkspaceFlagsSeam {
  client: WorkspaceFlagsClient;
  /** sessiond availability guard (production: `system.ping`). Fails closed 503. */
  mutationGuard: MutationGuard;
  /** AllowedRoots classifier for project keys (sessions are ids, not paths). */
  isAllowedPath(path: string): boolean;
}

export interface WorkspaceFlagsRouteDeps {
  workspaceFlags?: WorkspaceFlagsSeam;
}

const FLAGS_BODY_LIMIT = 2 * 1024;

type ParsedFlagsBody = { kind: "session" | "project"; key: string; flags: { pinned?: boolean; archived?: boolean } };

function parseWorkspaceFlagsBody(body: Record<string, unknown>): ParsedFlagsBody {
  const keys = Object.keys(body).sort();
  if (keys.length < 2 || keys.length > 4 || !keys.includes("kind") || !keys.includes("key")
    || keys.some((key) => key !== "kind" && key !== "key" && key !== "pinned" && key !== "archived")) {
    throw new HttpError(400, "INVALID_WORKSPACE_FLAGS", "Workspace flags body is invalid");
  }
  const kind = body.kind;
  const key = body.key;
  const pinned = body.pinned;
  const archived = body.archived;
  if (kind !== "session" && kind !== "project") {
    throw new HttpError(400, "INVALID_WORKSPACE_FLAGS", "Workspace flags body is invalid");
  }
  if (typeof key !== "string" || key.length === 0 || key.length > 4096) {
    throw new HttpError(400, "INVALID_WORKSPACE_FLAGS", "Workspace flags body is invalid");
  }
  if ((pinned !== undefined && typeof pinned !== "boolean")
    || (archived !== undefined && typeof archived !== "boolean")
    || (pinned === undefined && archived === undefined)) {
    throw new HttpError(400, "INVALID_WORKSPACE_FLAGS", "Workspace flags body is invalid");
  }
  return {
    kind,
    key,
    flags: {
      ...(pinned === undefined ? {} : { pinned: pinned as boolean }),
      ...(archived === undefined ? {} : { archived: archived as boolean }),
    },
  };
}

export function registerWorkspaceFlagsRoutes(app: Hono<HostEnv>, deps: WorkspaceFlagsRouteDeps): void {
  if (deps.workspaceFlags === undefined) return;
  const seam = deps.workspaceFlags;

  app.get("/v1/workspace-flags", async (c) => {
    if (c.req.url.includes("?")) {
      throw new HttpError(400, "INVALID_QUERY", "This endpoint does not accept query parameters");
    }
    await seam.mutationGuard.assertAvailable();
    try {
      return c.json(await seam.client.getWorkspaceFlags());
    } catch (error) {
      throw mapWorkspaceFlagsError(error);
    }
  });

  app.patch("/v1/workspace-flags", async (c) => {
    // Guard FIRST: a down sessiond 503s before any body is parsed.
    await seam.mutationGuard.assertAvailable();
    if (c.req.url.includes("?")) {
      throw new HttpError(400, "INVALID_QUERY", "This endpoint does not accept query parameters");
    }
    const body = await readJsonObject(c, FLAGS_BODY_LIMIT);
    const parsed = parseWorkspaceFlagsBody(body);
    if (parsed.kind === "session") {
      // Session ids are opaque uuid-ish strings; the store re-validates.
      if (/[\u0000-\u001f\u007f]/.test(parsed.key)) {
        throw new HttpError(400, "INVALID_WORKSPACE_FLAGS", "Workspace flags body is invalid");
      }
    } else {
      // Project keys are filesystem identities: absolute paths only (drive /
      // UNC shapes on win32 via the platform-aware isAbsolute — never a
      // hardcoded `/` prefix), and the Host's AllowedRoots owns the
      // classification (fail closed outside).
      if (!isAbsolute(parsed.key) || parsed.key.includes("\u0000")) {
        throw new HttpError(400, "INVALID_PROJECT_ROOT", "Project root is invalid");
      }
      if (!seam.isAllowedPath(parsed.key)) {
        throw new HttpError(403, "PATH_OUTSIDE_ALLOWED_ROOTS", "Path is outside the allowed roots");
      }
    }
    try {
      await seam.client.setWorkspaceFlags(parsed.kind, parsed.key, parsed.flags);
    } catch (error) {
      throw mapWorkspaceFlagsError(error);
    }
    return c.json({ success: true });
  });
}

function mapWorkspaceFlagsError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  const code = (error as { code?: string } | null)?.code;
  if (code === "invalid_input") return new HttpError(400, "INVALID_WORKSPACE_FLAGS", "Workspace flags are invalid");
  if (code === "not_found") return new HttpError(404, "WORKSPACE_FLAGS_NOT_FOUND", "Workspace flags target not found");
  if (code === "conflict" || code === "epoch_changed") return new HttpError(409, "WORKSPACE_FLAGS_CHANGED", "Workspace flags changed concurrently");
  return new HttpError(503, "WORKSPACE_FLAGS_UNAVAILABLE", "Workspace flags are temporarily unavailable");
}
