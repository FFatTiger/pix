#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("../src/", import.meta.url);
const forbidden = [
  /@earendil-works\/pi-/,
  /\bAgentSession\b/,
  /\bSessionManager\b/,
  /pi\s*rpc/i,
  /from ["'](?:react|next|hono)/,
];

async function walk(url) {
  const entries = await readdir(url, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, url);
    if (entry.isDirectory()) files.push(...await walk(child));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(child);
  }
  return files;
}

const violations = [];
for (const file of await walk(root)) {
  const text = await readFile(file, "utf8");
  for (const pattern of forbidden) if (pattern.test(text)) violations.push(`${file.pathname}: ${pattern}`);
}
if (violations.length) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log("sessiond boundary check passed");
}
