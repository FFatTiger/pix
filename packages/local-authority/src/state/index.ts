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
export {
  ATTACHMENTS_DIR_ENV,
  UNFILED_ATTACHMENTS_SCOPE,
  attachmentScopeExists,
  attachmentScopePath,
  formatAttachmentFileName,
  isSafeAttachmentScope,
  removeAttachmentScope,
  resolveAttachmentsRoot,
  sanitizeAttachmentFileName,
  sweepStaleUnfiledAttachments,
  writeAttachmentFile,
  type AttachmentFileWrite,
} from "./attachments.js";
export {
  canonicalCompareKey,
  decomposeAbsolutePath,
  securePathApi,
  securePathPlatform,
  stripWindowsExtendedPrefix,
  type DecomposedAbsolutePath,
  type SecurePathPlatform,
} from "./platform-paths.js";
