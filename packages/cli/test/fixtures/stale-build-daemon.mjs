// Test-only fake "same-protocol, incompatible-build" sessiond daemon (Phase 7A).
//
// Simulates a positively authenticated Protocol-v2 pix daemon whose BUILD is
// not reusable by the current CLI: `PIX_STALE_BUILD` selects the hello build
// block shape —
//   none      — hello omits `build` entirely (pre-Phase7A dist)
//   contract  — build with workerContract 99 (stale Worker contract generation)
//   product   — build with product "0.0.1" (different product build)
//   malformed — build with a non-hex fingerprint (fails the strict hello schema)
//
// Like a REAL v2 daemon it rejects protocolVersion !== 2 request envelopes, so
// the narrow legacy v1 control call can never positively verify it. It answers
// `system.ping` with a schema-valid v2 envelope (inspect sees it healthy),
// writes the on-disk secret + instance lock, serves the endpoint socket, and
// honors an authenticated, instance-fenced `system.shutdown` (removing exactly
// its own lock/socket and exiting) unless `PIX_REFUSE_SHUTDOWN=1` answers
// `forbidden` — proving a failed authenticated restart preserves authority.
import { createServer } from "node:net";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// Compiled-in contract generations (single source): the fixture's stale
// variants must differ from the CURRENT build in exactly ONE field, so the
// unaffected fields track the live constants instead of hardcoded numbers.
import {
  ADAPTER_CONTRACT_VERSION,
  PROTOCOL_VERSION,
  WORKER_CONTRACT_VERSION,
  SESSIOND_CONTRACT_VERSION,
} from "@fffattiger/pix-protocol";

const dir = process.env.PIX_SESSIOND_DIR;
if (!dir) {
  console.error("PIX_SESSIOND_DIR required");
  process.exit(2);
}
const staleKind = process.env.PIX_STALE_BUILD ?? "none";
const refuseShutdown = process.env.PIX_REFUSE_SHUTDOWN === "1";
// Race-fence mode: exit cleanly (lock + socket removed) right after the FIRST
// system.hello answer, simulating a daemon lost between probe and the reuse
// commit so `ensureSessiond` must re-decide instead of silently reusing it.
const exitAfterHello = process.env.PIX_EXIT_AFTER_HELLO === "1";
// Occupancy is fixture-owned runtime.listRunning state (no SDK Worker):
// busy advertises one live record, idle advertises none. ensureSessiond must
// not query this method and must not shut the daemon down either way.
const occupancy = process.env.PIX_FIXTURE_OCCUPANCY === "busy" ? "busy" : "idle";
const busySession = {
  sessionId: "fixture-busy-session",
  cwd: dir,
  projectRoot: dir,
  workerStatus: "busy",
  epoch: "fixture-epoch-1",
  name: "fixture-busy",
};
const endpoint = join(dir, "sessiond.sock");
const lockFile = join(dir, "sessiond.lock");
const secretFile = join(dir, "sessiond.secret");
const instanceId = `stale-build-${staleKind}-${process.pid}`;
const secret = `stale-build-secret-${process.pid}-0123456789abcdef`;
const rpcLogFile = process.env.PIX_RPC_LOG;
const recordRpc = (method) => {
  if (!rpcLogFile) return;
  try { writeFileSync(rpcLogFile, `${method}\n`, { flag: "a" }); } catch { /* test-only log */ }
};

mkdirSync(dir, { recursive: true });
writeFileSync(secretFile, `${secret}\n`, { mode: 0o600 });
writeFileSync(lockFile, JSON.stringify({ pid: process.pid, instanceId, createdAt: Date.now() }), { mode: 0o600 });

// A schema-shaped build block whose ONLY difference from a real one is the
// field under test (64-hex dummy fingerprint so `contract`/`product` variants
// fail exactly one matrix check).
const dummyFingerprint = "a".repeat(64);
const buildBlock = () => {
  // Tests may inject a fully valid build identity (JSON of the compiled
  // SESSIOND_BUILD_IDENTITY) so a "current" classification is reachable.
  const injected = process.env.PIX_FAKE_BUILD_JSON;
  if (injected !== undefined && injected !== "") {
    try { return JSON.parse(injected); } catch { return { malformed: true }; }
  }
  switch (staleKind) {
    case "contract":
      return {
        product: "0.1.0",
        protocol: PROTOCOL_VERSION,
        sessiond: SESSIOND_CONTRACT_VERSION,
        workerContract: 99,
        adapterContract: ADAPTER_CONTRACT_VERSION,
        fingerprint: dummyFingerprint,
      };
    case "product":
      return {
        product: "0.0.1",
        protocol: PROTOCOL_VERSION,
        sessiond: SESSIOND_CONTRACT_VERSION,
        workerContract: WORKER_CONTRACT_VERSION,
        adapterContract: ADAPTER_CONTRACT_VERSION,
        fingerprint: dummyFingerprint,
      };
    case "malformed":
      return {
        product: "0.1.0",
        protocol: PROTOCOL_VERSION,
        sessiond: SESSIOND_CONTRACT_VERSION,
        workerContract: WORKER_CONTRACT_VERSION,
        adapterContract: ADAPTER_CONTRACT_VERSION,
        fingerprint: "not-hex",
      };
    default:
      return undefined;
  }
};

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
      // A real v2 daemon fails the strict request schema for a v1 envelope.
      if (request && request.protocolVersion !== 2) {
        socket.write(JSON.stringify({ id: request.id, ok: false, method, error: { code: "protocol_mismatch", message: "unsupported envelope", retryable: false } }) + "\n");
        continue;
      }
      recordRpc(method);
      if (method === "system.ping") {
        socket.write(JSON.stringify({ id: request.id, ok: true, method, result: { pong: true, serverTime: Date.now() } }) + "\n");
      } else if (method === "system.hello") {
        const build = buildBlock();
        if (exitAfterHello) {
          // Race-fence determinism: remove the lock + public socket BEFORE the
          // hello answer is written, so by the time the CLI can possibly act
          // on a "current" classification the instance is provably gone.
          rmSync(lockFile, { force: true });
          rmSync(endpoint, { force: true });
        }
        const helloLine = JSON.stringify({
          id: request.id,
          ok: true,
          method,
          result: {
            protocolVersion: 2,
            sessiondVersion: "2",
            capabilities: ["runtime.authority", "runtime.resume"],
            ...(build === undefined ? {} : { build }),
          },
        }) + "\n";
        if (exitAfterHello) {
          // Flush the answer BEFORE exiting so the probe deterministically
          // receives a "current" classification for an already-gone instance.
          socket.write(helloLine, () => {
            socket.end();
            server.close();
            process.exit(0);
          });
        } else {
          socket.write(helloLine);
        }
      } else if (method === "runtime.listRunning") {
        const sessions = occupancy === "busy" ? [busySession] : [];
        socket.write(JSON.stringify({ id: request.id, ok: true, method, result: { sessions } }) + "\n");
      } else if (method === "system.shutdown") {
        const params = request.params || {};
        const authorized = params.instanceId === instanceId && !refuseShutdown;
        if (refuseShutdown) {
          socket.write(JSON.stringify({ id: request.id, ok: false, method, error: { code: "forbidden", message: "instance mismatch", retryable: false } }) + "\n");
        } else {
          socket.write(JSON.stringify({ id: request.id, ok: authorized, method, result: authorized ? { accepted: true } : undefined, error: authorized ? undefined : { code: "forbidden", message: "instance mismatch", retryable: false } }) + "\n");
          if (authorized) {
            setTimeout(() => {
              rmSync(lockFile, { force: true });
              rmSync(endpoint, { force: true });
              server.close();
              process.exit(0);
            }, 20);
          }
        }
      } else {
        socket.write(JSON.stringify({ id: request.id, ok: false, method, error: { code: "unsupported_capability", message: "unsupported", retryable: false } }) + "\n");
      }
    }
  });
});

server.listen(endpoint, () => {
  console.log(`stale-build-ready ${instanceId}`);
});
