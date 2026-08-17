/**
 * @fffattiger/pix-local-authority — secure-state contracts + POSIX backend.
 *
 * Host imports this narrow `.../state` surface (not the package root) so the
 * architecture boundary can allow exactly `@fffattiger/pix-local-authority/state`
 * and nothing else.
 *
 * The POSIX module also exports a private test-only seam
 * (`ensurePrivateDirectoryWithFs`) that must NOT leak into the public surface;
 * it is re-exported here by explicit name, not via `export *`, so the public
 * export set stays exact while tests can still reach the seam through the
 * direct `dist/state/posix.js` module path.
 */
export * from "./contracts.js";
export {
  createSecureStateBackend,
  type SecureStateBackendFactoryOptions,
} from "./platform.js";
export {
  canonicalizeAbsolutePath,
  posixFileIdentity,
  currentPrincipal,
  isOwnedByCurrentUser,
  ensurePrivateDirectory,
  readStateDocument,
  writeStateDocument,
  isPidAlive,
  readLifetimeLock,
  acquireLifetimeLock,
  releaseLifetimeLock,
  createPosixSecureStateBackend,
} from "./posix.js";
