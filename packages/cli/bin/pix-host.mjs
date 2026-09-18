#!/usr/bin/env node
// pix-host — boot the Hono Host only. Requires an already-running, pingable
// sessiond; it never spawns one. Thin shim over the unified CLI dispatcher.
import { runCli } from "../dist/index.js";

runCli(["host", ...process.argv.slice(2)]).then((code) => {
  process.exitCode = code;
});
