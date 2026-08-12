import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const packageRoot = new URL("../", import.meta.url).pathname;
const srcRoot = join(packageRoot, "src");
const distRoot = join(packageRoot, "dist");
// The agent runtime surface (A1) and the read-only sessions catalog/locator
// (D1A-1) are public. Other session/model/credential/resource/trust ports
// remain deferred, so `agent` and `sessions` (plus the root `index.ts`)
// are the public source dirs.
const publicSourceDirs = new Set(["agent", "sessions"]);
const sdkImport = /@earendil-works\/pi-/;
const sdkNames = /\b(?:AgentSession|SessionManager|ModelRuntime|DefaultResourceLoader|ProjectTrustStore|AuthStorage)\b/;

async function walk(dir, suffix) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path, suffix));
    else if (entry.isFile() && path.endsWith(suffix)) files.push(path);
  }
  return files;
}

const failures = [];
const sourceFiles = await walk(srcRoot, ".ts");
for (const file of sourceFiles) {
  const rel = relative(srcRoot, file);
  const first = rel.split("/")[0];
  const text = await readFile(file, "utf8");
  if ((publicSourceDirs.has(first) || rel === "index.ts") && (sdkImport.test(text) || sdkNames.test(text))) {
    failures.push(`${rel}: public source leaks SDK import/name`);
  }
  if (first !== "internal" && sdkImport.test(text)) {
    failures.push(`${rel}: SDK import must stay in src/internal/**`);
  }
}

const declarationFiles = (await walk(distRoot, ".d.ts"))
  .filter((file) => !relative(distRoot, file).startsWith(`internal/`));
for (const file of declarationFiles) {
  const rel = relative(distRoot, file);
  const text = await readFile(file, "utf8");
  if (sdkImport.test(text) || sdkNames.test(text) || /(?:from|import\()\s*["'][^"']*internal\//.test(text)) {
    failures.push(`${rel}: public declaration leaks SDK/internal type`);
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`pi-sdk-adapter boundaries: PASS (${sourceFiles.length} source files, ${declarationFiles.length} public declarations)`);
