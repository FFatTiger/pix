// Copy non-TS test fixtures into dist-test so child-process tests can spawn them.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const src = join(packageRoot, "test", "fixtures");
const dest = join(packageRoot, "dist-test", "test", "fixtures");
if (!existsSync(src)) {
  console.warn("[sessiond] no test fixtures to copy");
  process.exit(0);
}
mkdirSync(dirname(dest), { recursive: true });
cpSync(src, dest, { recursive: true });
