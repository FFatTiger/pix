import assert from "node:assert/strict";
import test from "node:test";
import {
  parseBindArgs,
  parseFlags,
  DEFAULT_HOSTNAME,
  DEFAULT_PORT,
} from "../src/args.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { downCommand } from "../src/commands/down.js";
import { resolveCliPackageRoot } from "../src/paths.js";
import { runCli } from "../src/index.js";

test("parseBindArgs applies defaults", () => {
  const opts = parseBindArgs([]);
  assert.equal(opts.hostname, DEFAULT_HOSTNAME);
  assert.equal(opts.port, DEFAULT_PORT);
  assert.equal(opts.open, false);
});

test("parseBindArgs accepts --hostname/--port and --open", () => {
  const opts = parseBindArgs(["--hostname", "0.0.0.0", "--port", "4123", "--open"]);
  assert.equal(opts.hostname, "0.0.0.0");
  assert.equal(opts.port, 4123);
  assert.equal(opts.open, true);
});

test("parseBindArgs accepts --flag=value form", () => {
  const opts = parseBindArgs(["--hostname=127.0.0.1", "--port=8"]);
  assert.equal(opts.hostname, "127.0.0.1");
  assert.equal(opts.port, 8);
});

test("--no-open overrides --open", () => {
  assert.equal(parseBindArgs(["--open", "--no-open"]).open, false);
  assert.equal(parseBindArgs(["--no-open", "--open"]).open, false);
});

test("parseBindArgs rejects invalid port", () => {
  assert.throws(() => parseBindArgs(["--port", "abc"]), /invalid port/);
  assert.throws(() => parseBindArgs(["--port", "99999"]), /invalid port/);
});

test("parseBindArgs rejects unknown flag", () => {
  assert.throws(() => parseBindArgs(["--bogus"]), /unknown flag/);
});

test("parseBindArgs rejects value flag without value", () => {
  assert.throws(() => parseBindArgs(["--port"]), /requires a value/);
});

test("parseFlags collects positionals, value-flags and bool-flags", () => {
  const parsed = parseFlags(["status", "--all", "--hostname", "h", "extra"]);
  assert.deepEqual(parsed.positional, ["status", "extra"]);
  assert.equal(parsed.flags.get("--hostname"), "h");
  assert.equal(parsed.boolFlags.has("--all"), true);
});

test("help and parser contract expose pix down --all and reject sessiond-down", async () => {
  const help: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (message?: unknown) => { help.push(String(message)); };
  console.error = () => {};
  let helpCode: number;
  try {
    helpCode = await runCli(["--help"]);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  assert.equal(helpCode, 0);
  const helpText = help.join("\n");
  assert.match(helpText, /down --all/);
  assert.doesNotMatch(helpText, /sessiond-down/);

  const parsed = parseFlags(["--all"]);
  assert.equal(parsed.boolFlags.has("--all"), true);

  const unknown: string[] = [];
  console.error = (message?: unknown) => { unknown.push(String(message)); };
  console.log = (message?: unknown) => { unknown.push(String(message)); };
  let unknownCode: number;
  try {
    unknownCode = await runCli(["sessiond-down"]);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  assert.equal(unknownCode, 2);
  assert.ok(unknown.some((line) => line.includes("unknown command: sessiond-down")));

  const missingAll: string[] = [];
  console.error = (message?: unknown) => { missingAll.push(String(message)); };
  try {
    const code = await downCommand([]);
    assert.equal(code, 2);
  } finally {
    console.error = origErr;
  }
  assert.ok(missingAll.some((line) => line.includes("usage: pix down --all")));

  const supervise = readFileSync(join(resolveCliPackageRoot(), "src", "supervise.ts"), "utf8");
  assert.match(supervise, /`pix down --all` is the explicit maintenance stop and will end sessions/);
  assert.doesNotMatch(supervise, /sessiond-down/);
});
