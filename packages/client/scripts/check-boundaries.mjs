#!/usr/bin/env node
/**
 * Boundary checks for packages/client source.
 * Fails if client sources reference forbidden Next/SDK/legacy API surface.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_ROOT = path.resolve(__dirname, "..");
const SRC_ROOT = path.join(CLIENT_ROOT, "src");

const FORBIDDEN = [
  {
    id: "next-import",
    // next/react, next/font, next/navigation, etc.
    re: /from\s+["']next\/|import\s*\(\s*["']next\/|["']next\/font|["']next\/navigation|["']next\/link|["']next\/image/,
  },
  { id: "pi-sdk", re: /@earendil-works\/pi-/ },
  // Literal legacy path segments in source (avoid dynamic joins in production).
  { id: "legacy-api", re: /["'`]\/api\// },
  { id: "event-source", re: /\bEventSource\b/ },
];

const TEXT_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".css",
  ".html",
  ".json",
  ".md",
]);

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
    if (/\.tsx?$/.test(rel) && /\bfetch\s*\(/.test(content) && !rel.startsWith("src/api/")) {
      violations.push({ rule: "direct-fetch", file: rel, line: 1, text: "fetch() is only allowed inside src/api" });
    }
    if (rel.includes("protocol-shim")) {
      violations.push({ rule: "protocol-shim", file: rel, line: 1, text: "temporary Protocol shim must be removed" });
    }
    for (const rule of FORBIDDEN) {
      if (rule.re.test(content)) {
        // Find line numbers for report
        const lines = content.split(/\r?\n/);
        lines.forEach((line, idx) => {
          if (rule.re.test(line)) {
            violations.push({
              rule: rule.id,
              file: rel,
              line: idx + 1,
              text: line.trim().slice(0, 120),
            });
          }
        });
      }
    }
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
