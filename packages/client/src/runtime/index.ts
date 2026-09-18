/**
 * pix Client Runtime — RuntimeConnection + SessionControllerRegistry + exact
 * React hooks.
 *
 * Public surface for the UI. Realtime runtime state flows through
 * `useSyncExternalStore`; components read the exact per-session
 * {@link ExactRuntimeView} / connection-global surfaces and invoke ID-bound
 * lifecycle/command actions. The raw SessionController/SessionControllerRegistry
 * are implementation internals and are NOT exported to the UI; the UI uses the
 * exact hooks (`useRuntime(sessionId)` / `useSelectedRuntime`), the connection
 * hook (`useRuntimeConnection`) and the post-create coordinator
 * (`useExactActionCoordinator`). RuntimeConnection remains the sole
 * RuntimeSocket owner (enforced by boundaries.test.ts).
 */
export { createBrowserWebSocket } from "./socket.js";
export type { ManagedWebSocket, RuntimeSocketDeps, NegotiatedHost, Timer } from "./socket.js";
export { RuntimeConnection } from "./runtime-connection.js";
export type {
  RuntimeConnectionOptions,
  RuntimeConnectionView,
  RuntimeTransportState,
  RuntimeControllerPort,
  RuntimeControllerBinding,
  RuntimeAttachmentRouteHandle,
  RuntimeAttemptSpec,
  RuntimeAttemptHandle,
  RuntimeAttemptExpectation,
  RuntimeAttemptDisconnectPolicy,
} from "./runtime-connection.js";
export {
  RuntimeProvider,
  useRuntime,
  useRuntimeOwners,
  useRuntimeConnection,
  useRuntimeForegroundActivity,
  useSelectedRuntime,
  useExactActionCoordinator,
  SelectedSessionProvider,
  detectClientIdentity,
  createBrowserSocketDeps,
} from "./runtime-provider.js";
export type { RuntimeProviderProps } from "./runtime-provider.js";
export {
  buildExactSnapshot,
  createExactActions,
  emptyExactView,
  projectExactView,
} from "./exact-runtime.js";
export type {
  ExactRuntimeApi,
  ExactRuntimeView,
  ExactSubmitTurnInput,
  RuntimeConnectionApi,
} from "./exact-runtime.js";
export { buildRuntimeWsUrl, buildHandshakeRequest, computeBackoffDelay, parseHostFrame, isFatalHandshakeError, isRetryableError } from "./protocol-wire.js";
export type { RuntimeLocation, BackoffOptions } from "./protocol-wire.js";
export { homePresentationKey, sessionPresentationKey } from "./session-controller-registry.js";
export type { PresentationProvenance } from "./session-controller.js";
export { describeRuntimeObservationError, runtimeObservationMessageKind, RUNTIME_OBSERVATION_MESSAGE_KEYS } from "./observation-errors.js";
export { FATAL_HANDSHAKE_CODES, isActive, canSend } from "./lifecycle.js";
export type { ConnectionState } from "./lifecycle.js";
export { createDefaultIdFactory, decideEvent, decideCommandRetry } from "./correlation.js";
export { useResumeRefetch, ResumeRefetch } from "./use-resume-refetch.js";
export type { IdFactory, PendingRequest, EventApplyDecision, CommandRetryDecision, RequestKind } from "./correlation.js";
