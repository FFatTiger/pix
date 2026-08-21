// Test-only preload for Windows Host lifecycle verification.
//
// Node's child.kill("SIGTERM") uses TerminateProcess on Windows and does not
// dispatch the JavaScript SIGTERM handler. The startup E2E launches the real
// product entry with this preload plus an IPC channel, then asks the preload to
// emit SIGTERM inside the child. That exercises the production runHost handler
// (server close + exact ledger-lock release) without weakening production or
// pretending a forced Windows termination was graceful.

const SHUTDOWN_MESSAGE = "pix-e2e-graceful-host-shutdown";

process.on("message", (message) => {
  if (message !== SHUTDOWN_MESSAGE) return;
  process.emit("SIGTERM", "SIGTERM");
});
