// Child-process oracle for the sessiond RPC disconnect crash (rpc.ts).
//
// Runs under Node's DEFAULT unhandledRejection behavior (reject with no handler
// => throw => exit 1). Scenario mirrors production:
//   - a real SessiondRpcClient issues a valid slow command and times out
//     (simulating the 10s production timeout), destroying the socket;
//   - the server keeps the gated command and completes it LATE, writing onto a
//     now-closed writer.
//
// If the server leaks any unhandled rejection the process dies (exit 1) before
// printing SURVIVED. A healthy server logs a drop, discards the late response,
// and still answers a fresh command.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessiondRpcClient, SessiondRpcServer } from "../../src/rpc.js";

const directory = await mkdtemp(join(tmpdir(), "sessiond-rpc-crash-"));
const endpoint = join(directory, "rpc.sock");
const SECRET = "s".repeat(40);

let resolveCommand;
const gate = new Promise((resolve) => {
  resolveCommand = resolve;
});

const handler = {
  async handle(method, params) {
    if (method === "system.ping") return { pong: true };
    if (method === "runtime.command") {
      await gate;
      return { commandId: params.command.commandId, result: { ok: true, type: "set_thinking_level" } };
    }
    return { ok: true };
  },
};

const server = new SessiondRpcServer({ endpoint, secret: SECRET, handler });
await server.listen();

const client = new SessiondRpcClient({ endpoint, secret: SECRET, timeoutMs: 300 });
// host-style: the client rejection is handled immediately (never an unhandled rejection).
await client
  .call("runtime.command", { sessionId: "s1", command: { commandId: "cc1", type: "prompt", message: "hello" } })
  .then(
    () => {},
    () => {},
  );

await new Promise((resolve) => setTimeout(resolve, 600)); // client timeout fires at 300ms, socket destroyed
resolveCommand(); // command completes long after the client gave up
await new Promise((resolve) => setTimeout(resolve, 400));

// The server must still answer a fresh command.
const pong = await client.call("system.ping", {});
if (pong.pong !== true) {
  console.error("PING_FAILED");
  process.exit(2);
}

await server.close();
await rm(directory, { recursive: true, force: true });
console.log("SURVIVED");
process.exit(0);
