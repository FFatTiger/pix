import assert from "node:assert/strict";
import test from "node:test";
import {
  classifySessiondState,
  collectDoctorReport,
  doctorCommand,
  doctorExitCode,
  formatDoctorText,
  parseDoctorFlags,
  type DoctorReport,
} from "../src/commands/doctor.js";
import { runCli } from "../src/index.js";
import type { SessiondStatus } from "../src/supervise.js";

function status(partial: Partial<SessiondStatus> = {}): SessiondStatus {
  return {
    alive: false,
    pingable: false,
    obstructed: false,
    obstruction: undefined,
    pid: undefined,
    instanceId: undefined,
    directory: "/tmp/pix-sessiond",
    endpoint: "/tmp/pix-sessiond/sessiond.sock",
    ...partial,
  };
}

function report(partial: Partial<DoctorReport> = {}): DoctorReport {
  return {
    schemaVersion: 1,
    os: "linux",
    arch: "x64",
    node: "v22.19.0",
    engines: ">=22.19.0",
    backendKind: "posix",
    sessiondDirectory: "/tmp/pix-sessiond",
    hostDirectory: "/tmp/pix-host",
    endpointKind: "unix-socket",
    endpoint: "/tmp/pix-sessiond/sessiond.sock",
    pathBudgetBytes: 108,
    gitVersion: "2.53.0",
    sessiond: { state: "not-running", pingable: false, pid: null, obstruction: null },
    lastStart: { state: "missing", code: null, message: null },
    secureContext: "Web UI is ordinary on localhost or HTTPS. HTTP LAN is insecure-origin and not an installable PWA.",
    ...partial,
  };
}

async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string[] }> {
  const out: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (message?: unknown) => { out.push(String(message)); };
  console.error = (message?: unknown) => { out.push(String(message)); };
  try {
    return { code: await fn(), out };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

test("parseDoctorFlags accepts --json --platform and rejects unknown flags", () => {
  assert.deepEqual(parseDoctorFlags(["--json", "--platform"]), { json: true });
  assert.throws(() => parseDoctorFlags(["--all"]), /unknown flag/);
});

test("classifySessiondState is honest about obstruction and stale locks", () => {
  assert.equal(classifySessiondState(status()), "not-running");
  assert.equal(classifySessiondState(status({ pid: 12, alive: false })), "stale-lock");
  assert.equal(classifySessiondState(status({ alive: true, pingable: true, pid: 12 })), "running");
  assert.equal(classifySessiondState(status({ obstructed: true, obstruction: "unsafe lock" })), "obstructed");
});

test("collectDoctorReport is read-only and never prints a secret", async () => {
  const collected = await collectDoctorReport({
    platform: "win32",
    arch: "x64",
    nodeVersion: "v22.19.0",
    inspect: async () => status({
      directory: "C:\\Users\\yzq\\.pi\\pix\\sessiond",
      endpoint: "\\\\.\\pipe\\pix-sessiond-abc",
    }),
    resolveBackend: () => ({ kind: "windows" }),
    gitVersion: async () => "2.53.0.windows.3",
    lastStart: async () => ({ kind: "valid", record: {
      kind: "pix.sessiond.last-start",
      version: 1,
      ok: true,
      code: "ok",
      message: "sessiond started",
      at: "2026-01-01T00:00:00.000Z",
    } }),
    hostDirectory: "C:\\Users\\yzq\\.pi\\pix\\host",
  });
  assert.equal(collected.schemaVersion, 1);
  assert.equal(collected.os, "win32");
  assert.equal(collected.backendKind, "windows");
  assert.equal(collected.endpointKind, "named-pipe");
  assert.equal(collected.pathBudgetBytes, null);
  assert.equal(collected.gitVersion, "2.53.0.windows.3");
  assert.equal(collected.lastStart.state, "ok");
  const text = JSON.stringify(collected);
  assert.equal(/secret|AUTH /i.test(text), false);
});

test("doctor --json emits the stable schema and fails closed on obstruction", async () => {
  const collected = await collectDoctorReport({
    platform: "linux",
    inspect: async () => status({ obstructed: true, obstruction: "unsafe lock" }),
    resolveBackend: () => ({ kind: "posix" }),
    gitVersion: async () => null,
    lastStart: async () => ({ kind: "missing" }),
    hostDirectory: "/tmp/pix-host",
  });
  assert.equal(collected.sessiond.state, "obstructed");
  assert.equal(doctorExitCode(collected), 1);
  const captured = await capture(() => doctorCommand(["--json"], {
    platform: "linux",
    inspect: async () => status({ obstructed: true, obstruction: "unsafe lock" }),
    resolveBackend: () => ({ kind: "posix" }),
    gitVersion: async () => null,
    lastStart: async () => ({ kind: "missing" }),
    hostDirectory: "/tmp/pix-host",
  }));
  assert.equal(captured.code, 1);
  const parsed = JSON.parse(captured.out[0]!.replace(/^\[pix] /, "")) as DoctorReport;
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.sessiond.state, "obstructed");
  assert.equal(parsed.gitVersion, null);
});

test("doctor text report includes secure-context guidance and no secret", () => {
  const lines = formatDoctorText(report({ backendKind: "unavailable" }));
  assert.equal(lines.some((line) => line.includes("backend: unavailable")), true);
  assert.equal(lines.some((line) => line.startsWith("secure-context:")), true);
  assert.equal(lines.join("\n").includes("secret"), false);
  assert.equal(doctorExitCode(report({ backendKind: "unavailable" })), 1);
});

test("runCli help lists doctor", async () => {
  const captured = await capture(() => runCli(["--help"]));
  assert.equal(captured.code, 0);
  assert.equal(captured.out.some((line) => line.includes("doctor")), true);
});
