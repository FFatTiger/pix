/**
 * pix Client Runtime — RuntimeSocket + SessionStore + React provider.
 *
 * Public surface for the UI. The store reduces through the SHARED Protocol
 * `reduceRuntimeEventData` projection (identical semantics to the sessiond
 * authority) and exposes realtime state via useSyncExternalStore.
 */
export { RuntimeSocket, createBrowserWebSocket } from "./socket.js";
export type { ManagedWebSocket, RuntimeSocketDeps, RuntimeSocketHandler, NegotiatedHost, Timer } from "./socket.js";
export { SessionStore } from "./session-store.js";
export type { RuntimeView, SessionStoreOptions } from "./session-store.js";
export { RuntimeProvider, useRuntime, useRuntimeStore, detectClientIdentity, createBrowserSocketDeps } from "./runtime-provider.js";
export type { RuntimeProviderProps, RuntimeApi } from "./runtime-provider.js";
export { buildRuntimeWsUrl, buildHandshakeRequest, computeBackoffDelay, parseHostFrame, isFatalHandshakeError, isRetryableError } from "./protocol-wire.js";
export type { RuntimeLocation, BackoffOptions } from "./protocol-wire.js";
export { FATAL_HANDSHAKE_CODES, isActive, canSend } from "./lifecycle.js";
export type { ConnectionState } from "./lifecycle.js";
export { createDefaultIdFactory, decideEvent, decideCommandRetry } from "./correlation.js";
export { useResumeRefetch, ResumeRefetch } from "./use-resume-refetch.js";
export type { IdFactory, PendingRequest, EventApplyDecision, CommandRetryDecision, RequestKind } from "./correlation.js";
