/**
 * @fffattiger/pix-local-authority — secure-state contracts + POSIX backend.
 *
 * Host imports this narrow `.../state` surface (not the package root) so the
 * architecture boundary can allow exactly `@fffattiger/pix-local-authority/state`
 * and nothing else.
 */
export * from "./contracts.js";
export * from "./posix.js";
