// scripts/remove-paths.mjs
//
// Cross-platform replacement for `rm -rf`. npm scripts run through cmd.exe on
// Windows, so Unix `rm` is not available. Node 22+ `fs.rmSync` is.

import { rmSync } from "node:fs";
import { resolve } from "node:path";

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error("usage: node scripts/remove-paths.mjs <path> [...path]");
  process.exitCode = 2;
} else {
  for (const path of paths) {
    rmSync(resolve(process.cwd(), path), { recursive: true, force: true });
  }
}
