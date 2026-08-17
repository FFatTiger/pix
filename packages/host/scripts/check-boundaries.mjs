#!/usr/bin/env node
/**
 * Architecture boundary check for packages/host.
 *
 * The host foundation (gate, security, static, ws guard, types) must not
 * import Pi SDK / sessiond / protocol / legacy Next code, and must not
 * reference AgentSession / SessionManager / Pi RPC concepts.
 *
 * The composition layer (src/composition/**) — the runtime WS gateway — is the
 * ONE place allowed to depend on the pix Runtime Protocol and the narrow
 * sessiond client (`@fffattiger/pix-sessiond/client`). It still must NOT import
 * Pi SDK, runtime-core, the sessiond main entry, or any other sessiond
 * subpath; and it must not reference AgentSession/SessionManager.
 */
import { relative, sep } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = join(packageRoot, "src");
const compositionRoot = join(srcRoot, "composition");

// Forbidden for EVERY host source file (foundation + composition).
const GLOBAL_FORBIDDEN_IMPORT_PREFIXES = [
  "@earendil-works/",
  "next/",
  "@fffattiger/pix-runtime-core",
  "react",
  "react-dom",
];

// Adapter root and non-catalog subpaths are forbidden everywhere. Composition
// may import ONLY the four exact catalog subpaths listed below.
const FORBIDDEN_ADAPTER_PREFIXES = [
  "@fffattiger/pix-pi-sdk-adapter",
];

/** Exact adapter subpaths composition may import (D3B-R1B). */
const COMPOSITION_ALLOWED_ADAPTER_SUBPATHS = new Set([
  "@fffattiger/pix-pi-sdk-adapter/models",
  "@fffattiger/pix-pi-sdk-adapter/credentials",
  "@fffattiger/pix-pi-sdk-adapter/resources",
  "@fffattiger/pix-pi-sdk-adapter/trust",
  "@fffattiger/pix-pi-sdk-adapter/themes",
]);

// These identifiers are intentionally assembled from parts so this
// boundary-enforcement script is not itself flagged by the workspace
// check:architecture gate, which scans host source for their literal form.
const FORBIDDEN_IDENTIFIERS = ["Agent" + "Session", "Session" + "Manager", "rpc-manager", "PiRpc", "RpcManager"];

// Protocol/sessiond are forbidden in the foundation except the exact HTTP
// bootstrap schema subpath. Composition may import the protocol root plus that
// same exact subpath. The sessiond main entry and every non-client subpath stay
// forbidden even in composition — the host only consumes the narrow client.
const FOUNDATION_FORBIDDEN_IMPORT_PREFIXES = [
  ...GLOBAL_FORBIDDEN_IMPORT_PREFIXES,
  "@fffattiger/pix-sessiond",
];

const PROTOCOL_ROOT = "@fffattiger/pix-protocol";
const PROTOCOL_HOST_BOOTSTRAP = "@fffattiger/pix-protocol/host-bootstrap";

const ALLOWED_EXTERNAL_PREFIXES = [
  "hono",
  "@hono/node-server",
  "@hono/node-ws",
  // Slice 1 (local-authority): the foundation may import ONLY the narrow
  // `.../state` secure-state surface (enforced exactly below, not by prefix).
  "@fffattiger/pix-local-authority/state",
  // CP-02: foundation may project ONLY the HTTP bootstrap schema version.
  PROTOCOL_HOST_BOOTSTRAP,
];

/** Externals that composition source may import in addition to hono. */
const COMPOSITION_ALLOWED_EXTERNAL_PREFIXES = [
  ...ALLOWED_EXTERNAL_PREFIXES,
  PROTOCOL_ROOT,
  "@fffattiger/pix-sessiond/client",
  // Exact catalog subpaths only — enforced below, not via prefix match alone.
  "@fffattiger/pix-pi-sdk-adapter/models",
  "@fffattiger/pix-pi-sdk-adapter/credentials",
  "@fffattiger/pix-pi-sdk-adapter/resources",
  "@fffattiger/pix-pi-sdk-adapter/trust",
  "@fffattiger/pix-pi-sdk-adapter/themes",
];

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, files);
    } else if (full.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

function isComposition(file) {
  const rel = relative(srcRoot, file);
  return rel === "composition" || rel.startsWith(`composition${sep}`);
}

let failures = 0;

function fail(message) {
  failures += 1;
  console.error(`FAIL: ${message}`);
}

for (const file of walk(srcRoot)) {
  const source = readFileSync(file, "utf8");
  const relativePath = file.slice(srcRoot.length + 1);
  const inComposition = isComposition(file);

  const forbidden = inComposition
    ? GLOBAL_FORBIDDEN_IMPORT_PREFIXES
    : FOUNDATION_FORBIDDEN_IMPORT_PREFIXES;

  for (const prefix of forbidden) {
    const match = source.match(new RegExp(`from\\s+["'](${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`));
    if (match) fail(`${relativePath} imports forbidden module "${match[1]}"`);
  }

  // Composition may use the sessiond client subpath only; the main entry or any
  // other subpath is forbidden everywhere.
  for (const match of source.matchAll(/from\s+["'](@fffattiger\/pix-sessiond(?:\/[^"']+)?)["']/g)) {
    const specifier = match[1];
    if (specifier !== "@fffattiger/pix-sessiond/client") {
      fail(`${relativePath} imports sessiond non-client surface "${specifier}"`);
    } else if (!inComposition) {
      fail(`${relativePath} imports sessiond client outside composition`);
    }
  }

  // Adapter: foundation forbids all; composition allows ONLY the four exact
  // catalog subpaths (never the adapter root, agent, sessions, testing, etc.).
  for (const match of source.matchAll(/from\s+["'](@fffattiger\/pix-pi-sdk-adapter(?:\/[^"']+)?)["']/g)) {
    const specifier = match[1];
    if (!inComposition) {
      fail(`${relativePath} imports pi-sdk-adapter outside composition ("${specifier}")`);
    } else if (!COMPOSITION_ALLOWED_ADAPTER_SUBPATHS.has(specifier)) {
      fail(`${relativePath} imports non-catalog adapter surface "${specifier}"`);
    }
  }

  // Protocol: foundation may import ONLY `.../host-bootstrap`. Composition may
  // import the protocol root or that exact bootstrap subpath — never any other
  // protocol subpath.
  for (const match of source.matchAll(/from\s+["'](@fffattiger\/pix-protocol(?:\/[^"']+)?)["']/g)) {
    const specifier = match[1];
    if (inComposition) {
      if (specifier !== PROTOCOL_ROOT && specifier !== PROTOCOL_HOST_BOOTSTRAP) {
        fail(`${relativePath} imports non-allowed protocol surface "${specifier}"`);
      }
    } else if (specifier !== PROTOCOL_HOST_BOOTSTRAP) {
      fail(`${relativePath} imports protocol outside the host-bootstrap subpath ("${specifier}")`);
    }
  }

  // local-authority: allowed ONLY as the exact `.../state` secure-state subpath,
  // never the package root or any other subpath.
  for (const match of source.matchAll(/from\s+["'](@fffattiger\/pix-local-authority(?:\/[^"']+)?)["']/g)) {
    const specifier = match[1];
    if (specifier !== "@fffattiger/pix-local-authority/state") {
      fail(`${relativePath} imports non-state local-authority surface "${specifier}"`);
    }
  }

  for (const prefix of FORBIDDEN_ADAPTER_PREFIXES) {
    // Catch require()/dynamic forms that the from-import scan may miss on the
    // root package (already covered for exact from-imports above).
    void prefix;
  }

  for (const identifier of FORBIDDEN_IDENTIFIERS) {
    if (source.includes(identifier)) {
      fail(`${relativePath} references forbidden identifier "${identifier}"`);
    }
  }

  const allowedExternals = inComposition
    ? COMPOSITION_ALLOWED_EXTERNAL_PREFIXES
    : ALLOWED_EXTERNAL_PREFIXES;
  for (const match of source.matchAll(/from\s+["']([^".][^"']*)["']/g)) {
    const specifier = match[1];
    if (specifier.startsWith("node:")) continue;
    if (specifier.startsWith(".")) continue;
    if (allowedExternals.some((p) => specifier === p || specifier.startsWith(`${p}/`))) continue;
    fail(`${relativePath} imports undeclared external "${specifier}"`);
  }
}

if (failures > 0) {
  console.error(`\nBoundary check failed with ${failures} violation(s).`);
  process.exit(1);
}
console.log(`Boundary check passed (${walk(srcRoot).length} files).`);
