import { join } from "node:path";
import { makeRuntimeError, type SessionCatalogPort, type SessionLocatorPort } from "@fffattiger/pix-runtime-core";
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
      return { sessionId, entries: [], pageInfo: { hasMore: false } };
    },
    async readSessionThinking(sessionId, entryId) {
      // The stub catalog has no sessions/entries, so any exact-identity lookup
      // fails closed with the canonical not_found (never a fabricated block).
      throw makeRuntimeError("not_found", `session not found: ${sessionId}/${entryId}`);
    },
    async readSessionTree(sessionId) {
      return { sessionId, roots: [], entryCount: 0 };
    },
    async deleteSession() {
      /* no-op stub */
    },
  };
}
