// Test-only fake "protocol-v2 daemon with a hello blip".
//
// Simulates a HEALTHY v2 daemon that answers `system.ping` with a schema-valid
// v2 envelope (so inspect/probe sees it as reachable/healthy) but responds to
// `system.hello` with garbage that neither the current client nor the legacy
// envelope can parse — a transient "hello blip". `ensureSessiond` must classify
// it as UNVERIFIABLE and preserve it (same pid, lock intact), never shutting it
// down on a guess.
import { createServer } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.PIX_SESSIOND_DIR;
if (!dir) {
  console.error("PIX_SESSIOND_DIR required");
  process.exit(2);
}
const endpoint = join(dir, "sessiond.sock");
const lockFile = join(dir, "sessiond.lock");
const secretFile = join(dir, "sessiond.secret");
const instanceId = `blip-v2-${process.pid}`;
const secret = "blip-v2-secret-0123456789abcdef0123456789abcdef";

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
        // Schema-valid v2 ping response (accepted by the current client).
        socket.write(JSON.stringify({ id: request.id, ok: true, method: "system.ping", result: { pong: true, serverTime: Date.now() } }) + "\n");
      } else if (method === "system.hello") {
        // The hello blip: unparseable garbage.
        socket.write("not-a-valid-response\n");
      } else {
        socket.write(JSON.stringify({ id: request.id, ok: false, method, error: { code: "unsupported_capability", message: "unsupported", retryable: false } }) + "\n");
      }
    }
  });
});

server.listen(endpoint, () => {
  console.log(`blip-v2-ready ${instanceId}`);
});
