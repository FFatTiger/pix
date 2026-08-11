/**
 * Architecture boundary tests for runtime-core.
 *
 * Prove that runtime-core stays a zero-dependency kernel:
 * - no external/platform imports (everything must be relative, no `node:`, no
 *   zod, no Pi SDK/RPC, no Protocol, no React/Hono);
 * - no SDK/RPC type names in the source surface;
 * - the capability vocabulary never encodes backend identity (`sdk`/`rpc`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { RUNTIME_CAPABILITIES } from "./capabilities.js";

const here = dirname(fileURLToPath(import.meta.url));
// dist-test/boundaries.test.js -> packages/runtime-core/src
const srcDir = statSync(join(here, "..", "src")).isDirectory()
  ? join(here, "..", "src")
  : here;

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const importPattern = /^\s*(?:import|export)\b[\s\S]*?\bfrom\s*["']([^"']+)["']/gm;

test("runtime-core has no external or platform imports", () => {
  const files = listTsFiles(srcDir).filter((f) => !f.endsWith(".test.ts"));
  assert.ok(files.length > 0, "expected to find runtime-core source files");
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(importPattern)) {
      const specifier = match[1];
      assert.ok(
        specifier !== undefined &&
          (specifier.startsWith("./") || specifier.startsWith("../")),
        `${file}: non-relative import "${specifier}" — runtime-core must not import Protocol, Zod, Pi SDK/RPC, React, Hono or node:*`,
      );
    }
  }
});

test("runtime-core never mentions SDK/RPC type names", () => {
  const files = listTsFiles(srcDir).filter((f) => !f.endsWith(".test.ts"));
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    assert.ok(
      !/\bAgentSession\b/.test(text),
      `${file}: forbidden type name "AgentSession"`,
    );
    assert.ok(
      !/\bSessionManager\b/.test(text),
      `${file}: forbidden type name "SessionManager"`,
    );
  }
});

test("capabilities never encode backend identity (no sdk/rpc markers)", () => {
  assert.equal(RUNTIME_CAPABILITIES.length, 20, "expected the 20 canonical capabilities");
  for (const capability of RUNTIME_CAPABILITIES) {
    assert.match(capability, /^runtime\.[a-z_]+(\.[a-z_]+)?$/, `malformed capability "${capability}"`);
    assert.ok(
      !capability.includes("sdk") && !capability.includes("rpc"),
      `capability "${capability}" leaks backend identity`,
    );
  }
  const unique = new Set(RUNTIME_CAPABILITIES);
  assert.equal(unique.size, RUNTIME_CAPABILITIES.length, "capabilities must be unique");
});
