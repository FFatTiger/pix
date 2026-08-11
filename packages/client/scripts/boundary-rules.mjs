/**
 * Pure client boundary rules (no node:url / fs deps) so the gate can be unit
 * tested under vitest. Imported by check-boundaries.mjs and the boundary test.
 *
 * The client may depend ONLY on @fffattiger/pix-protocol among the pix sibling
 * packages — never sessiond, runtime-core, the Pi SDK adapter, the host, or the
 * Pi SDK itself (M2 C1 spec §H).
 */
export const FORBIDDEN = [
  {
    id: "next-import",
    re: /from\s+["']next\/|import\s*\(\s*["']next\/|["']next\/font|["']next\/navigation|["']next\/link|["']next\/image/,
  },
  { id: "pi-sdk", re: /@earendil-works\/pi-/ },
  /**
   * Only @fffattiger/pix-protocol is permitted among pix sibling packages. The
   * negative lookahead lets `pix-protocol` through while forbidding
   * pix-sessiond, pix-runtime-core, pix-pi-sdk-adapter, pix-host, etc.
   */
  { id: "sibling-package", re: /@fffattiger\/pix-(?!protocol\b)/ },
  { id: "legacy-api", re: /["'`]\/api\// },
  { id: "event-source", re: /\bEventSource\b/ },
];

/**
 * Detect boundary violations in a single source file's text. Pure.
 */
export function detectFileViolations(content, relPath) {
  const violations = [];
  if (/\.tsx?$/.test(relPath) && /\bfetch\s*\(/.test(content) && !relPath.startsWith("src/api/")) {
    violations.push({ rule: "direct-fetch", file: relPath, line: 1, text: "fetch() is only allowed inside src/api" });
  }
  if (relPath.includes("protocol-shim")) {
    violations.push({ rule: "protocol-shim", file: relPath, line: 1, text: "temporary Protocol shim must be removed" });
  }
  for (const rule of FORBIDDEN) {
    if (rule.re.test(content)) {
      const lines = content.split(/\r?\n/);
      lines.forEach((line, idx) => {
        if (rule.re.test(line)) {
          violations.push({
            rule: rule.id,
            file: relPath,
            line: idx + 1,
            text: line.trim().slice(0, 120),
          });
        }
      });
    }
  }
  return violations;
}
