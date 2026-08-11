import { join } from "node:path";
import type { SessionCatalogPort, SessionLocatorPort } from "@fffattiger/pix-runtime-core";
import type { ActivationContextProvider } from "../service.js";

/**
 * M1 session resolution stubs. They never touch a real Pi backend and never
 * start a worker; they only satisfy the service's port contracts so that
 * non-worker RPC paths (catalog reads, activation resolution) have deterministic
 * values while the worker runtime stays unavailable.
 */

/** A locator that reports every session as existing under `<dir>/sessions/<id>.jsonl`. */
export function createStubSessionLocator(directory: string): SessionLocatorPort {
  return {
    async locate(sessionId) {
      return { sessionId, sessionFile: join(directory, "sessions", `${sessionId}.jsonl`), exists: true };
    },
    async resolveLeafId(sessionId) {
      return sessionId;
    },
  };
}

/** An activation context that mirrors the requested cwd (or a neutral default). */
export function createStubActivationContext(): ActivationContextProvider {
  return {
    async resolve(_sessionId, _location, requestedCwd) {
      const cwd = requestedCwd ?? "/workspace";
      return { cwd, projectRoot: cwd };
    },
  };
}

/** An empty, read-only catalog so `sessions.*` respond without a real store. */
export function createStubSessionCatalog(): SessionCatalogPort {
  return {
    async listSessions() {
      return [];
    },
    async readSession(sessionId) {
      return { sessionId, cwd: "/workspace", projectRoot: "/workspace", entries: [] };
    },
    async readSessionContext(sessionId) {
      return { sessionId, entries: [] };
    },
    async deleteSession() {
      /* no-op stub */
    },
  };
}
