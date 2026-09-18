#!/usr/bin/env node
// pix — unified lifecycle entry (start / host / status / down / sessiond).
// Thin shim: real implementation lives in compiled dist/index.js.
import { runCli } from "../dist/index.js";

runCli(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
