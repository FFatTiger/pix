#!/usr/bin/env node
/**
 * Boundary checks for packages/client source.
 * Fails if client sources reference forbidden Next/SDK/daemon/runtime-core
 * surface. The client may depend ONLY on @fffattiger/pix-protocol among the
 * pix sibling packages (M2 C1 spec §H). Pure rules live in boundary-rules.mjs.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectFileViolations } from "./boundary-rules.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_ROOT = path.resolve(__dirname, "..");
const SRC_ROOT = path.join(CLIENT_ROOT, "src");

const TEXT_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css", ".html", ".json", ".md"]);

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      files.push(...(await walk(full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

function isText(file) {
  return TEXT_EXT.has(path.extname(file));
}

async function main() {
  let rootStat;
  try {
    rootStat = await stat(SRC_ROOT);
  } catch {
    console.error(`Missing src root: ${SRC_ROOT}`);
    process.exit(1);
  }
  if (!rootStat.isDirectory()) {
    console.error(`src is not a directory: ${SRC_ROOT}`);
    process.exit(1);
  }

  const files = (await walk(SRC_ROOT)).filter(isText);
  const violations = [];

  for (const file of files) {
    const content = await readFile(file, "utf8");
    const rel = path.relative(CLIENT_ROOT, file);
    violations.push(...detectFileViolations(content, rel));
  }

  if (violations.length > 0) {
    console.error("Client boundary violations:\n");
    for (const v of violations) {
      console.error(`  [${v.rule}] ${v.file}:${v.line}: ${v.text}`);
    }
    console.error(`\n${violations.length} violation(s).`);
    process.exit(1);
  }

  console.log(`Boundary check OK (${files.length} files scanned).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
