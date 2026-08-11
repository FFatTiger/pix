import assert from "node:assert/strict";
import test from "node:test";
import {
  parseBindArgs,
  parseFlags,
  DEFAULT_HOSTNAME,
  DEFAULT_PORT,
} from "../src/args.js";

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
