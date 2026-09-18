#!/usr/bin/env node
// pix-sessiond — run the sessiond daemon in the foreground. Reads
// PIX_SESSIOND_DIR (then ~/.pi/pix/sessiond). Never returns until shutdown.
import { main } from "@fffattiger/pix-sessiond/daemon";

main().then((code) => {
  process.exitCode = code;
});
