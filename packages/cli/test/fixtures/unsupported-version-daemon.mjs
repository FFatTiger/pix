// Test-only fake "daemon with an unsupported protocol version".
//
// Simulates a daemon that is genuinely pingable (`system.ping` answers a
// schema-valid v2 envelope, so inspect sees it healthy) but whose
// `system.hello` positively reports a protocol version that is NOT current and
// NOT the allowlisted legacy v1 — a future major (3), version 0, etc.
// `PIX_FAKE_PROTOCOL_VERSION` controls the reported version (default 3).
//
// It also honors an authenticated, instance-fenced `system.shutdown` (like the
// real v1 fixture), so if `ensureSessiond` were to misclassify it as
// knownLegacy it WOULD be destroyed — proving that the correct unverifiable
// classification is what keeps it alive (same pid, lock intact).
import { createServer } from "node:net";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.PIX_SESSIOND_DIR;
if (!dir) {
  console.error("PIX_SESSIOND_DIR required");
  process.exit(2);
}
const reportedVersion = Number(process.env.PIX_FAKE_PROTOCOL_VERSION ?? "3");
const endpoint = join(dir, "sessiond.sock");
const lockFile = join(dir, "sessiond.lock");
const secretFile = join(dir, "sessiond.secret");
const instanceId = `unsup-v${reportedVersion}-${process.pid}`;
const secret = `unsup-version-secret-${process.pid}-0123456789abcdef`;
const rpcLogFile = process.env.PIX_RPC_LOG;
const recordRpc = (method) => {
  if (!rpcLogFile) return;
  try { writeFileSync(rpcLogFile, `${method}\n`, { flag: "a" }); } catch { /* test-only log */ }
};

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
      recordRpc(method);
      if (method === "system.ping") {
        socket.write(JSON.stringify({ id: request.id, ok: true, method: "system.ping", result: { pong: true, serverTime: Date.now() } }) + "\n");
      } else if (method === "system.hello") {
        // Positively reports the unsupported version over the legacy envelope.
        socket.write(JSON.stringify({ id: request.id, ok: true, method: "system.hello", result: { protocolVersion: reportedVersion, capabilities: ["runtime.authority", "runtime.resume"] } }) + "\n");
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
  console.log(`unsup-version-ready ${instanceId}`);
});
