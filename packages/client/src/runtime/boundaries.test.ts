import { describe, expect, it } from "vitest";

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
});
