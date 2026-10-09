/**
 * @fffattiger/pix-local-authority — secure-state contracts + platform backends.
 *
 * Host imports this narrow `.../state` surface (not the package root) so the
 * architecture boundary can allow exactly `@fffattiger/pix-local-authority/state`
 * and nothing else.
 *
 * Two backend implementations satisfy the same `SecureStateBackend` contract:
 *   - `posix.ts` on POSIX platforms (macOS/Linux);
 *   - `win32.ts` on Windows (drive-letter paths, NTFS semantics: no POSIX mode
 *     bits, directory fsync unsupported, case-insensitive equality).
 * The public exports are re-dispatched by `process.platform` at module load so
 * callers import ONE surface regardless of platform. Both modules also export
 * private test-only seams (`ensurePrivateDirectoryWithFs`) that must NOT leak
 * into the public surface; they are reachable through the direct
 * `dist/state/posix.js` / `dist/state/win32.js` module paths only.
 */
export * from "./contracts.js";

const isWindows = process.platform === "win32";

// Static imports keep both backends bundled deterministically; the dispatch
// below selects at module-init time. (Both modules only import node builtins +
// contracts, so loading the unused one has no side effects.)
import * as posixBackend from "./posix.js";
import * as win32Backend from "./win32.js";

const backend = isWindows ? win32Backend : posixBackend;

export const canonicalizeAbsolutePath = backend.canonicalizeAbsolutePath;
export const posixFileIdentity = backend.posixFileIdentity;
export const currentPrincipal = backend.currentPrincipal;
export const isOwnedByCurrentUser = backend.isOwnedByCurrentUser;
export const ensurePrivateDirectory = backend.ensurePrivateDirectory;
export const readStateDocument = backend.readStateDocument;
export const writeStateDocument = backend.writeStateDocument;
export const isPidAlive = backend.isPidAlive;
export const readLifetimeLock = backend.readLifetimeLock;
export const acquireLifetimeLock = backend.acquireLifetimeLock;
export const releaseLifetimeLock = backend.releaseLifetimeLock;
export const createPosixSecureStateBackend = backend.createPosixSecureStateBackend;
