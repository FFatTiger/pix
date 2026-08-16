// Test-only fake "protocol-v1" sessiond daemon.
//
// Simulates a STALE v1 daemon that answers `system.ping` (pong) and
// `system.hello` with protocolVersion 1, writes the on-disk secret + instance
// lock, serves the endpoint socket, and honors an authenticated
// `system.shutdown` (instance-fenced) by removing the lock/socket and exiting.
// Used to verify `pix start`/ensureSessiond never silently reuses a pingable
// v1 daemon and safely replaces only the owned/authenticated instance.
import { createServer } from "node:net";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.PIX_SESSIOND_DIR;
if (!dir) {
  console.error("PIX_SESSIOND_DIR required");
  process.exit(2);
}
const endpoint = join(dir, "sessiond.sock");
const lockFile = join(dir, "sessiond.lock");
const secretFile = join(dir, "sessiond.secret");
const instanceId = `fake-v1-${process.pid}`;
const secret = "fake-v1-secret-0123456789abcdef0123456789";

mkdirSync(dir, { recursive: true });
writeFileSync(secretFile, `${secret}\n`, { mode: 0o600 });
writeFileSync(lockFile, JSON.stringify({ pid: process.pid, instanceId, createdAt: Date.now() }), { mode: 0o600 });

const server = createServer((socket) => {
  socket.setNoDelay(true);
  let authenticated = false;
  let buffered = "";
  socket.on("data", (chunk) => {
    buffered += chunk.toString("utf8");
    let nl;
    while ((nl = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, nl);
      buffered = buffered.slice(nl + 1);
      if (!authenticated) {
        authenticated = line.startsWith("AUTH ") && line.slice(5) === secret;
        if (!authenticated) { socket.destroy(); return; }
        socket.write("OK\n");
        continue;
      }
      if (line.length === 0) continue;
      let request;
      try { request = JSON.parse(line); } catch { socket.destroy(); return; }
      const method = request && request.method;
      if (method === "system.ping") {
        socket.write(JSON.stringify({ id: request.id, ok: true, method, result: { pong: true } }) + "\n");
      } else if (method === "system.hello") {
        // STALE v1: reports the old protocol version.
        socket.write(JSON.stringify({ id: request.id, ok: true, method, result: { protocolVersion: 1, capabilities: ["runtime.authority", "runtime.resume"] } }) + "\n");
      } else if (method === "system.shutdown") {
        const params = request.params || {};
        const accepted = params.instanceId === instanceId;
        socket.write(JSON.stringify({ id: request.id, ok: accepted, method, result: accepted ? { accepted: true } : undefined, error: accepted ? undefined : { code: "forbidden", message: "instance mismatch", retryable: false } }) + "\n");
        if (accepted) {
          setTimeout(() => {
            rmSync(lockFile, { force: true });
            rmSync(endpoint, { force: true });
            server.close();
            process.exit(0);
          }, 20);
        }
      } else {
        socket.write(JSON.stringify({ id: request.id, ok: false, method, error: { code: "unsupported_capability", message: "unsupported", retryable: false } }) + "\n");
      }
    }
  });
});

server.listen(endpoint, () => {
  console.log(`fake-v1-ready ${instanceId}`);
});
