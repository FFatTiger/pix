import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostApp, createNodeServer } from "../dist/index.js";
import WebSocket from "ws";

async function startServer(deps = {}) {
  const exposureMode = deps.exposureMode ?? "local";
  const host = createHostApp({
    logger: {},
    gate: { config: { read: () => ({ status: "disabled", source: "test" }) } },
    ...deps,
    exposureMode,
  });
  const hostname = exposureMode === "lan" ? "0.0.0.0" : "127.0.0.1";
  return createNodeServer(host, { port: 0, hostname });
}

function connect(port, options = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/runtime`, options);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("ws connect timeout"));
    }, 4000);
    function cleanup() {
      clearTimeout(timer);
      ws.removeAllListeners();
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CLOSING) {
        try {
          ws.terminate();
        } catch {
          /* already closed */
        }
      }
    }
    ws.on("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on("error", (err) => {
      cleanup();
      reject(err);
    });
    ws.on("unexpected-response", (_req, res) => {
      const code = res.statusCode;
      res.resume();
      cleanup();
      reject(Object.assign(new Error(`unexpected response ${code}`), { statusCode: code }));
    });
  });
}

function waitClose(ws, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeAllListeners();
      try {
        ws.terminate();
      } catch {
        /* already closed */
      }
      reject(new Error("close timeout"));
    }, timeoutMs);
    ws.on("close", (code, reason) => {
      clearTimeout(timer);
      ws.removeAllListeners("close");
      resolve({ code, reason: reason.toString() });
    });
  });
}

function waitMessage(ws, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeAllListeners();
      try {
        ws.terminate();
      } catch {
        /* already closed */
      }
      reject(new Error("message timeout"));
    }, timeoutMs);
    ws.on("message", (data) => {
      clearTimeout(timer);
      resolve(data.toString());
    });
  });
}

async function withServer(deps, fn) {
  const handle = await startServer(deps);
  try {
    await fn(handle);
  } finally {
    await handle.close();
  }
}

test("WS hello without runtime seam is closed with 1002 (not wired)", async () => {
  await withServer({}, async (handle) => {
    const ws = await connect(handle.port);
    ws.send("hello");
    const { code } = await waitClose(ws);
    assert.equal(code, 1002);
  });
});

test("WS client that never sends hello is closed with 1008 (timeout)", async () => {
  await withServer({ helloTimeoutMs: 80 }, async (handle) => {
    const ws = await connect(handle.port);
    const { code } = await waitClose(ws);
    assert.equal(code, 1008);
  });
});

test("WS hello delegates to the injected runtime seam (H0B) and frames flow", async () => {
  const captured = { hello: null, session: null, frames: [] };
  const runtimeWs = {
    attach(session, hello) {
      captured.hello = hello;
      captured.session = session;
      session.onMessage((frame) => captured.frames.push(frame));
      session.send(`pong:${hello}`);
    },
  };
  await withServer({ runtimeWs, helloTimeoutMs: 500 }, async (handle) => {
    const ws = await connect(handle.port);
    ws.send("hello-frame");
    const reply = await waitMessage(ws);
    assert.equal(reply, "pong:hello-frame");
    ws.send("second");
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.deepEqual(captured.frames, ["second"]);
    assert.equal(captured.hello, "hello-frame");
    assert.ok(captured.session.url.includes("/v1/runtime"));
  });
});

test("WS runtime attach sync throw and async rejection close with 1011", async () => {
  for (const runtimeWs of [
    { attach() { throw new Error("sync boom"); } },
    { attach() { return Promise.reject(new Error("async boom")); } },
  ]) {
    await withServer({ runtimeWs }, async (handle) => {
      const ws = await connect(handle.port);
      ws.send("hello");
      const { code } = await waitClose(ws);
      assert.equal(code, 1011);
    });
  }
});

test("oversized hello is closed with 1009", async () => {
  await withServer({ runtimeWs: { attach() {} }, wsHelloMaxBytes: 4 }, async (handle) => {
    const ws = await connect(handle.port);
    ws.send("hello-too-large");
    const { code } = await waitClose(ws);
    assert.equal(code, 1009);
  });
});

test("WS upgrade is rejected for untrusted Host header (before upgrade)", async () => {
  await withServer({}, async (handle) => {
    await assert.rejects(
      connect(handle.port, { headers: { host: "evil.example" } }),
      /unexpected response 403/,
    );
  });
});

test("WS upgrade enforces the gate: LAN + enabled auth requires cookie", async () => {
  const host = createHostApp({
    logger: {},
    gate: {
      config: { read: () => ({ status: "enabled", password: "secret", source: "test" }) },
    },
  });
  const handle = await createNodeServer(host, { port: 0, hostname: "127.0.0.1" });
  try {
    // LAN Host without cookie → handshake rejected.
    await assert.rejects(
      connect(handle.port, { headers: { host: "192.168.1.50" } }),
      /unexpected response 401/,
    );

    // Login over HTTP (local), then connect WS from the LAN host with cookie.
    const login = await host.app.request("http://localhost/v1/gate/login", {
      method: "POST",
      headers: {
        host: "localhost",
        "content-type": "application/json",
        "x-forwarded-for": "127.0.0.1",
      },
      body: JSON.stringify({ password: "secret" }),
    });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];

    const ws = await connect(handle.port, {
      headers: { host: "192.168.1.50", cookie },
    });
    ws.send("hello");
    const { code } = await waitClose(ws);
    assert.equal(code, 1002); // no seam → still guards after auth
  } finally {
    await handle.close();
  }
});

test("LAN-bound WS cannot be downgraded by spoofed loopback Host", async () => {
  await withServer({ exposureMode: "lan" }, async (handle) => {
    for (const host of ["localhost", "127.0.0.1"]) {
      await assert.rejects(
        connect(handle.port, { headers: { host } }),
        /unexpected response 403/,
      );
    }
  });
});

test("WS upgrade is rejected for cross-site Origin", async () => {
  await withServer({}, async (handle) => {
    await assert.rejects(
      connect(handle.port, {
        headers: {
          host: "localhost",
          origin: "https://evil.example",
          "sec-fetch-site": "cross-site",
        },
      }),
      /unexpected response 403/,
    );
  });
});

test("plain HTTP GET /v1/runtime is not hijacked by the WS route", async () => {
  const host = createHostApp({
    logger: {},
    gate: { config: { read: () => ({ status: "disabled", source: "test" }) } },
  });
  const res = await host.app.request("http://localhost/v1/runtime", {
    headers: { host: "localhost" },
  });
  // Must not upgrade; either 404 (no route match for non-WS) or a non-101 response.
  assert.ok(res.status !== 101, "non-WS request must not upgrade");
});

test("createNodeServer rejects exposure/bind mismatches", async () => {
  const host = createHostApp({
    logger: {},
    exposureMode: "local",
    gate: { config: { read: () => ({ status: "disabled", source: "test" }) } },
  });
  await assert.rejects(
    createNodeServer(host, { port: 0, hostname: "0.0.0.0" }),
    /does not match bind/,
  );
});

test("client dist fixture is optional; API-only host still works", async () => {
  const distDir = mkdtempSync(join(tmpdir(), "pi-web-host-api-only-"));
  const host = createHostApp({
    logger: {},
    clientDist: distDir,
    gate: { config: { read: () => ({ status: "disabled", source: "test" }) } },
  });
  try {
    const res = await host.app.request("http://localhost/v1/health", {
      headers: { host: "localhost" },
    });
    assert.equal(res.status, 200);
    const page = await host.app.request("http://localhost/", {
      headers: { host: "localhost", accept: "text/html" },
    });
    assert.equal(page.status, 404); // no index.html in empty dist
  } finally {
    rmSync(distDir, { recursive: true, force: true });
  }
});
