import assert from "node:assert/strict";
import test from "node:test";
import { createHostApp } from "../dist/index.js";

function appWith(lines, extra = {}) {
  const logger = {
    info() {},
    warn(message, fields) { lines.push({ message, fields }); },
  };
  const app = createHostApp({
    logger,
    exposureMode: "local",
    gate: { config: { read: () => ({ status: "disabled", source: "test" }) } },
    ...extra,
  }).app;
  return app;
}

const report = {
  kind: "send_failure",
  code: "unavailable",
  phase: "activation",
  message: "runtime connection lost",
  retryable: true,
  connectionState: "attached",
  epoch: "e1",
  sessionKind: "assistant",
  sessionId: "s1",
};

function post(app, body, headers = {}) {
  return app.request("http://localhost/v1/diagnostics/send-failure", {
    method: "POST",
    headers: { host: "localhost", "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("a send-failure report writes one structured line and nothing else", async () => {
  const lines = [];
  const app = appWith(lines);
  const res = await post(app, report);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  const diagnostic = lines.filter((line) => line.message === "client send failure");
  assert.equal(diagnostic.length, 1);
  lines.splice(0, lines.length, ...diagnostic);
  assert.equal(lines[0].message, "client send failure");
  assert.equal(lines[0].fields.code, "unavailable");
  assert.equal(lines[0].fields.sessionKind, "assistant");
  assert.equal(lines[0].fields.sessionId, "s1");
  assert.equal("prompt" in lines[0].fields, false);
});

test("a report is rejected when the gate is enabled and no session is present", async () => {
  const lines = [];
  const app = appWith(lines, {
    gate: { config: { read: () => ({ status: "enabled", password: "secret", source: "test" }) } },
  });
  const res = await post(app, report);
  assert.equal(res.status, 401);
  assert.equal(lines.filter((line) => line.message === "client send failure").length, 0);
});

test("malformed reports fail closed and are not logged", async () => {
  const lines = [];
  const app = appWith(lines);
  const cases = [
    [{}, 400],
    [{ ...report, prompt: "secret text" }, 400],
    [{ ...report, code: "not_a_code" }, 400],
    [{ ...report, message: "x".repeat(201) }, 400],
  ];
  for (const [body, status] of cases) {
    const res = await post(app, body);
    assert.equal(res.status, status);
  }
  const text = await post(app, "not json");
  assert.equal(text.status, 400);
  assert.equal(lines.filter((line) => line.message === "client send failure").length, 0);
});

test("the same address is rate limited past the window budget", async () => {
  const lines = [];
  const app = appWith(lines);
  for (let i = 0; i < 30; i += 1) {
    const res = await post(app, report);
    assert.equal(res.status, 200);
  }
  const limited = await post(app, report);
  assert.equal(limited.status, 429);
  assert.equal(lines.filter((line) => line.message === "client send failure").length, 30);
});
