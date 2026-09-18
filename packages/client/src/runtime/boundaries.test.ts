/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Build forbidden specifiers from SPLIT parts so this test file does not itself
// trip the sibling-package / pi-sdk regexes (which match contiguous substrings).
const pixPrefix = "@fffattiger/" + "pix-";
const forbiddenSpecs: readonly string[] = ["sessiond", "runtime-core", "pi-sdk-adapter", "host"].map(
  (name) => pixPrefix + name,
);
const protocolSpec = pixPrefix + "protocol";
const piSdkSpec = "@earendil-works/" + "pi-sdk";

interface BoundaryViolation {
  rule: string;
  file: string;
  line: number;
  text: string;
}
type DetectFn = (content: string, relPath: string) => BoundaryViolation[];

let detect: DetectFn | null = null;
async function loadDetect(): Promise<DetectFn> {
  if (detect) return detect;
  // Dynamic import of the pure JS gate module; typed via the cast below.
  // @ts-expect-error -- pure .mjs gate has no type declaration; cast below.
  const mod = (await import("../../scripts/boundary-rules.mjs")) as { detectFileViolations: DetectFn };
  detect = mod.detectFileViolations;
  return detect;
}

describe("client boundary gate (Part H)", () => {
  it("forbids sessiond / runtime-core / pi-sdk-adapter / host imports in client src", async () => {
    const d = await loadDetect();
    for (const spec of forbiddenSpecs) {
      const violations = d(`import { x } from "${spec}";`, "src/runtime/x.ts");
      expect(violations.some((v) => v.rule === "sibling-package"), `${spec} must be forbidden`).toBe(true);
    }
    expect(d(`import {} from "${piSdkSpec}";`, "src/x.ts").some((v) => v.rule === "pi-sdk")).toBe(true);
  });

  it("allows only @fffattiger/pix-protocol among sibling packages", async () => {
    const d = await loadDetect();
    const ok = d(`import { reduceRuntimeEventData } from "${protocolSpec}";`, "src/runtime/z.ts");
    expect(ok.some((v) => v.rule === "sibling-package")).toBe(false);
  });

  it("the real client runtime source passes the gate", async () => {
    const d = await loadDetect();
    const sample = `export {} from "${protocolSpec}";`;
    expect(d(sample, "src/runtime/index.ts")).toEqual([]);
  });

  it("RuntimeConnection is the sole production RuntimeSocket constructor/handler", () => {
    const sources = import.meta.glob("./*.ts", { eager: true, query: "?raw", import: "default" }) as Record<string, string>;
    const constructors: string[] = [];
    const handlers: string[] = [];
    for (const [path, source] of Object.entries(sources)) {
      const file = path.slice(2);
      if (file.includes(".test.") || file === "socket.ts") continue;
      if (/new\s+RuntimeSocket\s*\(/.test(source)) constructors.push(file);
      if (/implements\s+RuntimeSocketHandler/.test(source)) handlers.push(file);
    }
    expect(constructors).toEqual(["runtime-connection.ts"]);
    expect(handlers).toEqual(["runtime-connection.ts"]);
  });

  it("Phase 4 production has zero facade / takeover / store-based runtime references", () => {
    // Static scan over the production source tree (no imports executed).
    const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
    const files: string[] = [];
    const walk = (dir: string, rel = ""): void => {
      for (const entry of readdirSync(dir)) {
        const abs = path.join(dir, entry);
        const nextRel = rel ? `${rel}/${entry}` : entry;
        if (statSync(abs).isDirectory()) {
          if (entry === "testing" || entry === "node_modules") continue;
          walk(abs, nextRel);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry)) continue;
        if (/\.test\./.test(entry)) continue;
        files.push(nextRel);
      }
    };
    walk(srcDir);
    const forbidden = [
      /useRuntime\s*\(\s*\)/,
      /useRuntimeStore/,
      /useLegacyRuntime/,
      /\bSessionStore\b/,
      /(?<!Exact)\bRuntimeApi\b/,
      /(?<!Exact|Controller)\bRuntimeView\b/,
      /liveTakeoverRef/,
      /selectedSessionPending/,
    ];
    const productionHits: string[] = [];
    for (const rel of files) {
      const source = readFileSync(path.join(srcDir, rel), "utf8");
      for (const pattern of forbidden) {
        if (pattern.test(source)) productionHits.push(`${rel} matches ${pattern}`);
      }
    }
    expect(productionHits).toEqual([]);
    const appShell = readFileSync(path.join(srcDir, "components/shell/AppShell.tsx"), "utf8");
    expect(/\bopenSession\s*\(/.test(appShell), "AppShell must not call openSession (selection never attaches)").toBe(false);
    expect(/liveTakeoverRef/.test(appShell), "AppShell must not contain liveTakeoverRef").toBe(false);
    const composer = readFileSync(path.join(srcDir, "components/shell/Composer.tsx"), "utf8");
    expect(/useRuntime\s*\(\s*\)/.test(composer)).toBe(false);
    expect(/useSessionStaging/.test(composer)).toBe(true);
  });
});
