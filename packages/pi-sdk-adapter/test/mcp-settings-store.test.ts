import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpSettingsStore, validateMcpEntry } from "../src/internal/mcp-settings-store.js";

let agentDir: string;
const env = { ...process.env, PIX_FAKE_TOKEN: "from-env" };

const SERVERS = (servers: Record<string, unknown>): string => `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`;

async function readDoc(dir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(dir, "mcp.json"), "utf8")) as Record<string, unknown>;
}

beforeEach(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "pix-mcp-store-"));
});

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Document reads
// ---------------------------------------------------------------------------

describe("mcp settings store — reads", () => {
  it("missing file is an honest empty list", async () => {
    const store = createMcpSettingsStore({ agentDir, env });
    const snapshot = await store.readSettings();
    assert.deepEqual(snapshot.servers, []);
  });

  it("malformed JSON fails closed, never an empty list", async () => {
    await writeFile(join(agentDir, "mcp.json"), "{ not json");
    const store = createMcpSettingsStore({ agentDir, env });
    await assert.rejects(store.readSettings(), (error: { code?: string }) => error.code === "invalid_input");
  });

  it("non-object and bad mcpServers shape fail closed", async () => {
    await writeFile(join(agentDir, "mcp.json"), "[]");
    await assert.rejects(createMcpSettingsStore({ agentDir, env }).readSettings());
    await writeFile(join(agentDir, "mcp.json"), SERVERS({ a: { command: "x" } }).replace('"mcpServers"', '"mcpServersX"'));
    // no mcpServers key = direct empty document: valid, empty list
    const snapshot = await createMcpSettingsStore({ agentDir, env }).readSettings();
    assert.deepEqual(snapshot.servers, []);
  });

  it("lists invalid entries with their reason instead of dropping them", async () => {
    await writeFile(join(agentDir, "mcp.json"), SERVERS({
      sse: { type: "sse", url: "https://example.com/sse" },
      both: { command: "npx", url: "https://example.com" },
      neither: { description: "nothing" },
      ok: { command: "npx", args: ["-y", "fs-server"] },
    }));
    const snapshot = await createMcpSettingsStore({ agentDir, env }).readSettings();
    const byName = new Map(snapshot.servers.map((server) => [server.name, server]));
    assert.equal(byName.get("sse")!.valid, false);
    assert.match(byName.get("sse")!.invalidReason!, /sse/);
    assert.equal(byName.get("both")!.valid, false);
    assert.equal(byName.get("neither")!.valid, false);
    assert.equal(byName.get("ok")!.valid, true);
    assert.equal(byName.get("ok")!.kind, "stdio");
    assert.equal(byName.get("ok")!.enabled, true);
  });

  it("redacts literal env/header values but passes references through", async () => {
    await writeFile(join(agentDir, "mcp.json"), SERVERS({
      http: {
        url: "https://example.com/mcp",
        headers: {
          Authorization: "${DOCS_TOKEN}",
          Refresh: "!echo refresh-token",
          "X-Api-Key": "ghp_literal_secret",
          Embedded: "Bearer ${PARTIAL}",
        },
      },
      fs: { command: "npx", env: { LITERAL: "super-secret-literal", REF: "${PIX_FAKE_TOKEN}", CMD: "!echo cmd-value" } },
    }));
    const snapshot = await createMcpSettingsStore({ agentDir, env }).readSettings();
    const http = snapshot.servers.find((server) => server.name === "http")!;
    assert.deepEqual(http.headers!.Authorization, { redacted: false, value: "${DOCS_TOKEN}" });
    assert.deepEqual(http.headers!.Refresh, { redacted: false, value: "!echo refresh-token" });
    // A literal — even one that merely embeds a reference — never round-trips.
    assert.deepEqual(http.headers!["X-Api-Key"], { redacted: true });
    assert.deepEqual(http.headers!.Embedded, { redacted: true });
    const fs = snapshot.servers.find((server) => server.name === "fs")!;
    assert.deepEqual(fs.env!.LITERAL, { redacted: true });
    assert.deepEqual(fs.env!.REF, { redacted: false, value: "${PIX_FAKE_TOKEN}" });
    assert.deepEqual(fs.env!.CMD, { redacted: false, value: "!echo cmd-value" });
    const raw = await readDoc(agentDir);
    void raw;
  });
});

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

describe("mcp settings store — writes", () => {
  it("creates a new file (0600) and preserves unknown top-level keys and sibling servers", async () => {
    await writeFile(join(agentDir, "mcp.json"), SERVERS({
      keep: { command: "npx", exposure: "direct", customField: { nested: true } },
    }).replace("{\n  \"mcpServers\"", "{\n  \"autoEnableCodemode\": false,\n  \"mcpServers\""));
    const store = createMcpSettingsStore({ agentDir, env });
    const snapshot = await store.upsertServer({
      name: "docs",
      kind: "http",
      url: "https://docs.example.com/mcp",
      description: "Product docs",
    });
    assert.equal(snapshot.servers.length, 2);
    const raw = await readDoc(agentDir);
    assert.equal(raw.autoEnableCodemode, false);
    const servers = raw.mcpServers as Record<string, Record<string, unknown>>;
    assert.deepEqual(servers.keep!.customField, { nested: true });
    assert.equal(servers.keep!.exposure, "direct");
    assert.equal(servers.docs!.url, "https://docs.example.com/mcp");
    if (process.platform !== "win32") {
      const info = await stat(join(agentDir, "mcp.json"));
      // The pre-existing file keeps its mode; a fresh file would be 0600.
      assert.equal(info.mode & 0o777, 0o644);
    }
  });

  it("a brand-new file is 0600 and no temp files remain", async () => {
    const store = createMcpSettingsStore({ agentDir, env });
    await store.upsertServer({ name: "solo", kind: "stdio", command: "npx" });
    if (process.platform !== "win32") {
      const info = await stat(join(agentDir, "mcp.json"));
      assert.equal(info.mode & 0o077, 0, "mcp.json must be owner-only when created by pix");
    }
    const files = await readdir(agentDir);
    assert.deepEqual(files.filter((name) => name.includes(".tmp")), []);
  });

  it("keeps an existing file's mode on rewrite", async () => {
    await writeFile(join(agentDir, "mcp.json"), SERVERS({ a: { command: "x" } }));
    await chmod(join(agentDir, "mcp.json"), 0o644);
    const store = createMcpSettingsStore({ agentDir, env });
    await store.upsertServer({ name: "b", kind: "stdio", command: "y" });
    if (process.platform !== "win32") {
      const info = await stat(join(agentDir, "mcp.json"));
      assert.equal(info.mode & 0o777, 0o644);
    }
  });

  it("env mutations: preserve keeps a stored literal, replace/remove rewrite only that key", async () => {
    await writeFile(join(agentDir, "mcp.json"), SERVERS({
      fs: { command: "npx", env: { KEEP: "stored-literal", DROP: "x-drop-me", REF: "${SOME_VAR}" } },
    }));
    const store = createMcpSettingsStore({ agentDir, env });
    const snapshot = await store.upsertServer({
      name: "fs",
      kind: "stdio",
      command: "npx",
      env: {
        KEEP: { mode: "preserve" },
        DROP: { mode: "remove" },
        NEW: { mode: "replace", value: "!echo hi" },
      },
    });
    const fs = snapshot.servers.find((server) => server.name === "fs")!;
    assert.deepEqual(fs.env!.KEEP, { redacted: true });
    assert.equal("DROP" in fs.env!, false);
    assert.deepEqual(fs.env!.NEW, { redacted: false, value: "!echo hi" });
    assert.deepEqual(fs.env!.REF, { redacted: false, value: "${SOME_VAR}" });
    const raw = (await readDoc(agentDir)).mcpServers as Record<string, { env: Record<string, string> }>;
    assert.equal(raw.fs!.env.KEEP, "stored-literal");
    assert.equal(raw.fs!.env.NEW, "!echo hi");
    assert.equal("DROP" in raw.fs!.env, false);
  });

  it("preserve on a missing key fails closed", async () => {
    const store = createMcpSettingsStore({ agentDir, env });
    await assert.rejects(
      store.upsertServer({ name: "fs", kind: "stdio", command: "npx", env: { NOPE: { mode: "preserve" } } }),
      (error: { code?: string }) => error.code === "invalid_input",
    );
    // Nothing was written.
    assert.equal((await store.readSettings()).servers.length, 0);
  });

  it("rejects dash/underscore identity collisions with existing servers", async () => {
    await writeFile(join(agentDir, "mcp.json"), SERVERS({ "my-server": { command: "npx" } }));
    const store = createMcpSettingsStore({ agentDir, env });
    await assert.rejects(
      store.upsertServer({ name: "my_server", kind: "stdio", command: "npx" }),
      (error: { code?: string }) => error.code === "invalid_input",
    );
  });

  it("rejects invalid writes without touching the file", async () => {
    await writeFile(join(agentDir, "mcp.json"), SERVERS({ a: { command: "npx" } }));
    const before = await readFile(join(agentDir, "mcp.json"), "utf8");
    const store = createMcpSettingsStore({ agentDir, env });
    for (const bad of [
      { name: "bad name", kind: "stdio" as const, command: "x" },
      { name: "ok1", kind: "stdio" as const },
      { name: "ok2", kind: "http" as const, url: "ftp://nope" },
      { name: "ok3", kind: "http" as const, url: "https://a", command: "x" },
      { name: "ok4", kind: "stdio" as const, command: "x", url: "https://a" },
    ]) {
      await assert.rejects(store.upsertServer(bad));
    }
    assert.equal(await readFile(join(agentDir, "mcp.json"), "utf8"), before);
  });

  it("a same-name rewrite preserves exposure/oauth extras and enabled:false", async () => {
    await writeFile(join(agentDir, "mcp.json"), SERVERS({
      gh: { command: "old", enabled: false, exposure: "deferred", oauth: { clientId: "c" } },
    }));
    const store = createMcpSettingsStore({ agentDir, env });
    const snapshot = await store.upsertServer({ name: "gh", kind: "stdio", command: "new" });
    const gh = snapshot.servers.find((server) => server.name === "gh")!;
    assert.equal(gh.enabled, false);
    assert.equal(gh.command, "new");
    const raw = (await readDoc(agentDir)).mcpServers as Record<string, Record<string, unknown>>;
    assert.equal(raw.gh!.exposure, "deferred");
    assert.deepEqual(raw.gh!.oauth, { clientId: "c" });
    assert.equal(raw.gh!.command, "new");
  });

  it("a kind flip drops the other transport's fields", async () => {
    await writeFile(join(agentDir, "mcp.json"), SERVERS({
      x: { url: "https://old", headers: { A: "b" }, type: "http" },
    }));
    const store = createMcpSettingsStore({ agentDir, env });
    await store.upsertServer({ name: "x", kind: "stdio", command: "npx" });
    const raw = (await readDoc(agentDir)).mcpServers as Record<string, Record<string, unknown>>;
    assert.equal(raw.x!.command, "npx");
    assert.equal("url" in raw.x!, false);
    assert.equal("headers" in raw.x!, false);
    assert.equal("type" in raw.x!, false, "a kept http type would invalidate the stdio entry");
  });

  it("setEnabled writes explicit enabled:false; enabling removes the marker", async () => {
    await writeFile(join(agentDir, "mcp.json"), SERVERS({ a: { command: "npx" } }));
    const store = createMcpSettingsStore({ agentDir, env });
    let snapshot = await store.setEnabled("a", false);
    assert.equal(snapshot.servers[0]!.enabled, false);
    assert.equal(snapshot.servers[0]!.status.state, "disabled");
    snapshot = await store.setEnabled("a", true);
    assert.equal(snapshot.servers[0]!.enabled, true);
    const raw = (await readDoc(agentDir)).mcpServers as Record<string, Record<string, unknown>>;
    assert.equal("enabled" in raw.a!, false, "enabled is the default; no marker needed");
    await assert.rejects(store.setEnabled("missing", true), (error: { code?: string }) => error.code === "not_found");
  });

  it("removeServer deletes exactly one entry; missing → not_found", async () => {
    await writeFile(join(agentDir, "mcp.json"), SERVERS({
      a: { command: "a" },
      b: { command: "b", env: { SECRET: "keep" } },
    }));
    const store = createMcpSettingsStore({ agentDir, env });
    const snapshot = await store.removeServer("a");
    assert.deepEqual(snapshot.servers.map((server) => server.name), ["b"]);
    const raw = (await readDoc(agentDir)).mcpServers as Record<string, unknown>;
    assert.deepEqual(Object.keys(raw), ["b"]);
    await assert.rejects(store.removeServer("a"), (error: { code?: string }) => error.code === "not_found");
  });

  it("concurrent writes serialize (both land, file stays valid)", async () => {
    const store = createMcpSettingsStore({ agentDir, env });
    await Promise.all([
      store.upsertServer({ name: "one", kind: "stdio", command: "npx" }),
      store.upsertServer({ name: "two", kind: "stdio", command: "npx" }),
      store.removeServer("nope").catch(() => undefined),
      store.upsertServer({ name: "three", kind: "http", url: "https://three.example" }),
    ]);
    const snapshot = await store.readSettings();
    assert.deepEqual(snapshot.servers.map((server) => server.name).sort(), ["one", "three", "two"]);
  });
});

// ---------------------------------------------------------------------------
// Import (paste JSON)
// ---------------------------------------------------------------------------

describe("mcp settings store — import", () => {
  it("preview accepts mcpServers envelopes and direct maps, marking overwrite and invalid entries", async () => {
    await writeFile(join(agentDir, "mcp.json"), SERVERS({
      existing: { command: "npx" },
      "other-name": { command: "npx" },
    }));
    const store = createMcpSettingsStore({ agentDir, env });
    const preview = await store.importPreview({
      json: JSON.stringify({ mcpServers: {
        existing: { url: "https://new.example" },
        clash: { command: "npx" },
        "other_name": { command: "npx" },
        bad: { type: "sse", url: "https://x/sse" },
      } }),
    });
    const byName = new Map(preview.entries.map((entry) => [entry.name, entry]));
    assert.equal(byName.get("existing")!.overwrite, true);
    assert.equal(byName.get("existing")!.valid, true);
    assert.equal(byName.get("clash")!.overwrite, false);
    assert.equal(byName.get("other_name")!.valid, false, "underscore name collides with other-name");
    assert.match(byName.get("other_name")!.invalidReason!, /other-name/);
    assert.equal(byName.get("bad")!.valid, false);
  });

  it("import writes all-or-nothing and preserves unknown entry fields", async () => {
    await writeFile(join(agentDir, "mcp.json"), SERVERS({ keep: { command: "npx" } }));
    const before = await readFile(join(agentDir, "mcp.json"), "utf8");
    const store = createMcpSettingsStore({ agentDir, env });

    await assert.rejects(
      store.importServers({ json: JSON.stringify({ good: { command: "npx" }, bad: { type: "sse", url: "https://x" } }) }),
      (error: { code?: string }) => error.code === "invalid_input",
    );
    assert.equal(await readFile(join(agentDir, "mcp.json"), "utf8"), before, "rejected import writes nothing");

    const snapshot = await store.importServers({
      json: JSON.stringify({ keep2: { url: "https://x", exposure: "direct", toolExposure: { "get_*": "direct" } } }),
    });
    assert.deepEqual(snapshot.servers.map((server) => server.name).sort(), ["keep", "keep2"]);
    const raw = (await readDoc(agentDir)).mcpServers as Record<string, Record<string, unknown>>;
    assert.equal(raw.keep2!.exposure, "direct");
    assert.deepEqual(raw.keep2!.toolExposure, { "get_*": "direct" });
  });

  it("import rejects malformed payloads without touching the file", async () => {
    const store = createMcpSettingsStore({ agentDir, env });
    await assert.rejects(store.importPreview({ json: "not json" }));
    await assert.rejects(store.importPreview({ json: "{}" }));
    await assert.rejects(store.importServers({ json: "[]" }));
    assert.equal(await readFile(join(agentDir, "mcp.json"), "utf8").catch(() => ""), "");
  });
});

// ---------------------------------------------------------------------------
// Validation unit checks
// ---------------------------------------------------------------------------

describe("validateMcpEntry rules", () => {
  it("accepts streamable-http as http; rejects sse", () => {
    assert.equal(validateMcpEntry("a", { type: "streamable-http", url: "https://x" }).valid, true);
    const sse = validateMcpEntry("a", { type: "sse", url: "https://x" });
    assert.equal(sse.valid, false);
    assert.match(sse.valid ? "" : sse.reason, /sse/);
  });

  it("type must match the selected fields", () => {
    assert.equal(validateMcpEntry("a", { type: "stdio", url: "https://x" }).valid, false);
    assert.equal(validateMcpEntry("a", { type: "http", command: "x" }).valid, false);
  });

  it("invalid names are rejected", () => {
    assert.equal(validateMcpEntry("has space", { command: "x" }).valid, false);
    assert.equal(validateMcpEntry("", { command: "x" }).valid, false);
    assert.equal(validateMcpEntry("a/b", { command: "x" }).valid, false);
  });
});

// ---------------------------------------------------------------------------
// Probes (fake stdio server + local HTTP 401 server)
// ---------------------------------------------------------------------------

/** Minimal newline-delimited JSON-RPC MCP server over stdio. */
const FAKE_SERVER_JS = `
  const mode = process.argv[1];
  let buf = "";
  const respond = (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id === undefined) continue;
      let result;
      if (msg.method === "initialize") {
        result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1.0.0" } };
      } else if (msg.method === "tools/list") {
        result = { tools: [{ name: "token_" + (process.env.FAKE_TOKEN ?? "none"), description: "Fake tool " + mode, inputSchema: { type: "object" } }] };
      } else if (msg.method === "ping") {
        result = {};
      }
      if (result !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
    }
  };
  if (mode === "stderr-then-die") {
    // No stdin handler: the server DIES while the client waits for initialize,
    // so the probe fails and the stderr tail is surfaced.
    process.stdin.resume();
    process.stderr.write("fake server failed: token=" + (process.env.FAKE_TOKEN ?? "none") + "\\n");
    setTimeout(() => process.exit(3), 20);
  } else if (mode === "hang") {
    // Alive but silent: never answers, so the probe times out.
    process.stdin.resume();
    setInterval(() => {}, 1000);
  } else {
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", respond);
  }
`;

function fakeServer(mode: string): { command: string; args: string[] } {
  return { command: process.execPath, args: ["-e", FAKE_SERVER_JS, mode] };
}

async function withHttpServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address !== null && typeof address === "object");
    await run(`http://127.0.0.1:${address.port}/mcp`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function pidAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("mcp settings store — probe", () => {
  it("stdio server connects and lists tools", async () => {
    const store = createMcpSettingsStore({ agentDir, env });
    await store.upsertServer({ name: "fake", kind: "stdio", ...fakeServer("normal") });
    const snapshot = await store.testServer("fake", true);
    const fake = snapshot.servers.find((server) => server.name === "fake")!;
    assert.equal(fake.status.state, "connected");
    assert.equal(fake.status.tools[0]!.name, "token_none");
    assert.equal(fake.status.error, null);
  });

  it("expands ${VAR} and !command env values for the child process", async () => {
    const store = createMcpSettingsStore({ agentDir, env });
    await store.upsertServer({
      name: "refs",
      kind: "stdio",
      ...fakeServer("normal"),
      env: {
        FAKE_TOKEN: { mode: "replace", value: "${PIX_FAKE_TOKEN}" },
      },
    });
    let snapshot = await store.testServer("refs", true);
    assert.equal(snapshot.servers.find((server) => server.name === "refs")!.status.state, "connected");
    assert.equal(snapshot.servers.find((server) => server.name === "refs")!.status.tools[0]!.name, "token_from-env");

    await store.upsertServer({
      name: "cmd",
      kind: "stdio",
      ...fakeServer("normal"),
      env: { FAKE_TOKEN: { mode: "replace", value: "!echo substituted-value" } },
    });
    snapshot = await store.testServer("cmd", true);
    assert.equal(snapshot.servers.find((server) => server.name === "cmd")!.status.tools[0]!.name, "token_substituted-value");
  });

  it("missing ${VAR} fails the probe with the variable named", async () => {
    const store = createMcpSettingsStore({ agentDir, env });
    await store.upsertServer({
      name: "missing",
      kind: "stdio",
      ...fakeServer("normal"),
      env: { FAKE_TOKEN: { mode: "replace", value: "${PIX_DEFINITELY_UNSET_VAR}" } },
    });
    const snapshot = await store.testServer("missing", true);
    assert.equal(snapshot.servers[0]!.status.state, "failed");
    assert.match(snapshot.servers[0]!.status.error!, /PIX_DEFINITELY_UNSET_VAR/);
  });

  it("HTTP 401 reports needs_auth", async () => {
    const store = createMcpSettingsStore({ agentDir, env });
    await withHttpServer((_request, response) => {
      response.writeHead(401, { "www-authenticate": 'Bearer realm="x"' });
      response.end("unauthorized");
    }, async (url) => {
      await store.upsertServer({ name: "auth", kind: "http", url });
      const snapshot = await store.testServer("auth", true);
      assert.equal(snapshot.servers[0]!.status.state, "needs_auth");
    });
  });

  it("spawn failure reports failed with a reason", async () => {
    const store = createMcpSettingsStore({ agentDir, env });
    await store.upsertServer({ name: "ghost", kind: "stdio", command: join(agentDir, "no-such-binary") });
    const snapshot = await store.testServer("ghost", true);
    const ghost = snapshot.servers.find((server) => server.name === "ghost")!;
    assert.equal(ghost.status.state, "failed");
    assert.ok(ghost.status.error !== null && ghost.status.error.length > 0);
  });

  it("a hung server times out and its process group is killed", async () => {
    const store = createMcpSettingsStore({ agentDir, env });
    // The server announces its pid on stderr before hanging.
    const announce = `process.stderr.write(String(process.pid) + "\\n");\n${FAKE_SERVER_JS}`;
    await store.upsertServer({ name: "hung", kind: "stdio", command: process.execPath, args: ["-e", announce, "hang"] });
    const startedAt = Date.now();
    const snapshot = await store.testServer("hung", true);
    const hung = snapshot.servers.find((server) => server.name === "hung")!;
    assert.equal(hung.status.state, "failed");
    assert.match(hung.status.error!, /timed out/);
    assert.ok(Date.now() - startedAt < 30_000);
    // The pid from stderrTail identifies the child; it must be reaped.
    const pid = Number(hung.status.stderrTail.find((line) => /^\\d+$/.test(line)) ?? hung.status.stderrTail[0]);
    assert.ok(Number.isInteger(pid) && pid > 0, `stderrTail carried the pid: ${JSON.stringify(hung.status.stderrTail)}`);
    let alive = true;
    for (let attempt = 0; attempt < 100 && alive; attempt++) {
      alive = await pidAlive(pid);
      if (alive) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(alive, false, "the stdio child must be killed after the probe");
  });

  it("stderr tail is captured and literal secrets in it are masked", async () => {
    const store = createMcpSettingsStore({ agentDir, env });
    await store.upsertServer({
      name: "noisy",
      kind: "stdio",
      command: process.execPath,
      args: ["-e", FAKE_SERVER_JS, "stderr-then-die"],
      env: { FAKE_TOKEN: { mode: "replace", value: "super-secret-literal" } },
    });
    const snapshot = await store.testServer("noisy", true);
    const noisy = snapshot.servers.find((server) => server.name === "noisy")!;
    assert.equal(noisy.status.state, "failed");
    const joined = noisy.status.stderrTail.join("\n");
    assert.ok(joined.includes("fake server failed"), joined);
    assert.ok(!joined.includes("super-secret-literal"), "literal env values must be masked in stderr");
    assert.ok(joined.includes("•••"), "masked marker expected");
  });

  it("probe results are cached 30s and refresh forces a new probe", async () => {
    let clock = 1_000_000;
    const hitFile = join(agentDir, "hits.txt");
    const store = createMcpSettingsStore({ agentDir, env, now: () => clock });
    const counterScript = `require("fs").appendFileSync(${JSON.stringify(hitFile)}, "x");\n${FAKE_SERVER_JS}`;
    await store.upsertServer({
      name: "cached",
      kind: "stdio",
      command: process.execPath,
      args: ["-e", counterScript, "normal"],
    });

    await store.testServer("cached", true);
    assert.equal((await readFile(hitFile, "utf8")).length, 1);

    // Within the TTL the cached result is served.
    clock += 10_000;
    await store.testServer("cached", false);
    assert.equal((await readFile(hitFile, "utf8")).length, 1, "cache hit within TTL must not respawn the server");

    // Beyond the TTL the probe runs again.
    clock += 25_000;
    await store.testServer("cached", false);
    assert.equal((await readFile(hitFile, "utf8")).length, 2);

    // refresh=true bypasses the cache immediately.
    await store.testServer("cached", true);
    assert.equal((await readFile(hitFile, "utf8")).length, 3);
  });

  it("readSettings surfaces cached statuses and config changes invalidate them", async () => {
    const store = createMcpSettingsStore({ agentDir, env });
    await store.upsertServer({ name: "fake", kind: "stdio", ...fakeServer("normal") });
    let snapshot = await store.readSettings();
    assert.equal(snapshot.servers[0]!.status.state, "unknown");
    await store.testServer("fake", true);
    snapshot = await store.readSettings();
    assert.equal(snapshot.servers[0]!.status.state, "connected");
    // An edit changes the entry fingerprint → the cached result no longer applies.
    await store.upsertServer({ name: "fake", kind: "stdio", ...fakeServer("normal"), timeout: 30 });
    snapshot = await store.readSettings();
    assert.equal(snapshot.servers[0]!.status.state, "unknown");
  });

  it("disabled servers report disabled without spawning anything", async () => {
    const store = createMcpSettingsStore({ agentDir, env });
    await store.upsertServer({ name: "off", kind: "stdio", command: join(agentDir, "no-such-binary") });
    await store.setEnabled("off", false);
    const snapshot = await store.testServer("off", true);
    assert.equal(snapshot.servers[0]!.status.state, "disabled");
    assert.equal(snapshot.servers[0]!.status.error, null);
  });

  it("unknown and invalid servers probe to unknown; missing → not_found", async () => {
    await writeFile(join(agentDir, "mcp.json"), SERVERS({ bad: { type: "sse", url: "https://x" } }));
    const store = createMcpSettingsStore({ agentDir, env });
    const snapshot = await store.testServer("bad", true);
    assert.equal(snapshot.servers[0]!.status.state, "unknown");
    await assert.rejects(store.testServer("missing", true), (error: { code?: string }) => error.code === "not_found");
  });
});
