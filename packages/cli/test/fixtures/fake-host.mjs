// Test-only stand-in for a background `pix host`: holds the Host-dir lock
// (trusted-roots.lock with its pid, like the real Host) and answers
// GET /v1/health as pix-host. argv: <port> <mode>
//   mode "ok"          — serve until SIGTERM, then release the lock and exit
//   mode "crash"       — print a line and exit 3 before listening
//   mode "silent"      — hold the lock but never listen
//   mode "ignore-term" — serve, but ignore SIGTERM (needs SIGKILL)
import { createServer } from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const port = Number(process.argv[2]);
const mode = process.argv[3] ?? "ok";
const hostDir = process.env.PIX_HOST_DIR;
const lockPath = join(hostDir, "trusted-roots.lock");

if (mode === "crash") {
  console.error("fake-host: listen EADDRINUSE");
  process.exit(3);
}

mkdirSync(hostDir, { recursive: true });
writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, instanceId: "fake", createdAt: Date.now() })}\n`);
console.log(`fake-host: pid ${process.pid} mode ${mode}`);

if (mode === "silent") {
  setInterval(() => {}, 1000);
} else {
  const server = createServer((req, res) => {
    if (req.url === "/v1/health") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, service: "pix-host" }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  server.listen(port, "127.0.0.1");
  process.on("SIGTERM", () => {
    if (mode === "ignore-term") return;
    server.close();
    rmSync(lockPath, { force: true });
    process.exit(0);
  });
}
