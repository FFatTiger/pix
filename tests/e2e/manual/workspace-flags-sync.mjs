/**
 * Round-5 workspace-flags sync, against an isolated sessiond + Host.
 *
 * Two browser pages share one Host:
 *   1. page A pins and archives a session and a project; page B sees each
 *      change without reloading;
 *   2. sessiond and Host restart over the same directories; both pages still
 *      see the flags after reload;
 *   3. a page carrying the legacy localStorage pin/archive prefs migrates
 *      them onto the server, and the other page sees the result.
 *
 * No model calls. Isolation: own temp sessiond/host/agent dirs and port.
 * Never the production directories or port 30145.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedSessionHistoryForTests } from "@fffattiger/pix-pi-sdk-adapter/testing";
import { launchChromeCdp } from "../helpers/chrome-cdp.mjs";
import {
  bootLifecycleStack,
  makeIsolatedDirs,
  teardownLifecycleStack,
  writeStubProviderConfig,
} from "../helpers/lifecycle-stack.mjs";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const CLIENT_DIST = join(ROOT, "packages", "client", "dist");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(label, probe, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await probe();
    if (last) return last;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}; last=${JSON.stringify(last)}`);
    await delay(150);
  }
}

function rowState(sessionId) {
  return `(() => {
    const pinned = document.querySelector('[data-testid="sidebar-pinned"]');
    const session = document.querySelector('[data-testid="session-select-${sessionId}"]');
    return {
      sessionVisible: Boolean(session),
      sessionPinned: Boolean(session && pinned && pinned.contains(session)),
    };
  })()`;
}

/** Drive the row's real context menu, so the write goes through the same
 * optimistic cache path a click uses. */
async function chooseContextAction(page, testId, label) {
  const opened = await page.evaluate(`(() => {
    const target = document.querySelector('[data-testid="${testId}"]');
    const row = target && target.closest("[data-session-row], .sidebar-list-row");
    if (!row) return "no-row";
    const rect = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: rect.left + 30, clientY: rect.top + 12 }));
    return "opened";
  })()`);
  assert.equal(opened, "opened", `context menu target for ${testId}`);
  await delay(300);
  const chosen = await page.evaluate(`(() => {
    const items = Array.from(document.querySelectorAll('[role="menuitem"], .ui-menu button, [role="menu"] button'));
    const labels = items.map((item) => (item.textContent ?? "").trim());
    const match = items.find((item) => (item.textContent ?? "").includes(${JSON.stringify(label)}));
    if (!match) return labels.join(" | ") || "no-menu";
    match.click();
    return "clicked";
  })()`);
  assert.equal(chosen, "clicked", `menu item ${label}; saw: ${chosen}`);
}

async function main() {
  const dirs = await makeIsolatedDirs("px-flags");
  // The host allows only its own cwd. Both projects live inside it so a
  // migrated project pin is a path the server accepts.
  const { mkdir, realpath } = await import("node:fs/promises");
  // AllowedRoots compares canonical paths; the temp dir's /var symlink would
  // otherwise disagree with the root the host recorded.
  const root = await realpath(dirs.projectCwd);
  const projectA = join(root, "alpha");
  const projectB = join(root, "beta");
  await mkdir(projectA, { recursive: true });
  await mkdir(projectB, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = dirs.agentDir;
  await writeStubProviderConfig(dirs.agentDir, "http://127.0.0.1:9/v1");
  const seededA = seedSessionHistoryForTests({ cwd: projectA, label: "alpha" });
  const seededB = seedSessionHistoryForTests({ cwd: projectB, label: "beta" });
  const sessionA = seededA.sessionId;
  const sessionB = seededB.sessionId;

  let stack = await bootLifecycleStack({ ...dirs, clientDist: CLIENT_DIST });
  const chrome = await launchChromeCdp();
  const results = [];
  const record = async (name, run) => {
    try {
      await run();
      results.push({ name, ok: true });
      console.log(`PASS — ${name}`);
    } catch (error) {
      results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
      console.log(`FAIL — ${name} :: ${results.at(-1).detail}`);
    }
  };

  try {
    const pageA = chrome;
    const pageB = await chrome.openTab();
    await pageA.navigate(stack.origin);
    await pageB.navigate(stack.origin);
    await waitFor("page A lists session A", () => pageA.evaluate(rowState(sessionA)).then((state) => state.sessionVisible));
    await waitFor("page B lists session A", () => pageB.evaluate(rowState(sessionA)).then((state) => state.sessionVisible));


    await record("pin on A shows on B without reload", async () => {
      await chooseContextAction(pageA, `session-select-${sessionA}`, "置顶");
      await waitFor("A shows its own pin", () => pageA.evaluate(rowState(sessionA)).then((state) => state.sessionPinned));
      await waitFor("B shows the pin", () => pageB.evaluate(rowState(sessionA)).then((state) => state.sessionPinned));
    });

    await record("archive on A hides the session on B without reload", async () => {
      await chooseContextAction(pageA, `session-select-${sessionA}`, "归档");
      await waitFor("B hides the archived session", () => pageB.evaluate(rowState(sessionA)).then((state) => !state.sessionVisible));
    });

    await record("flags survive a sessiond + host restart", async () => {
      await stack.handle.close();
      await stack.daemon.shutdown();
      await delay(500);
      // The host dir lease is held for the process lifetime; a restarted host
      // gets a fresh dir. Sessiond state (the flags) stays in its own dir.
      const nextHostDir = join((await import("node:os")).tmpdir(), `px-flags-host-${process.pid}-${Date.now()}`);
      await (await import("node:fs/promises")).mkdir(nextHostDir, { mode: 0o700 });
      dirs.hostDir = nextHostDir;
      stack = await bootLifecycleStack({ ...dirs, clientDist: CLIENT_DIST });
      await pageA.navigate(stack.origin);
      await pageB.navigate(stack.origin);
      await waitFor("A still hides the archived session", () => pageA.evaluate(rowState(sessionA)).then((state) => !state.sessionVisible));
      const onDisk = JSON.parse(await (await import("node:fs/promises")).readFile(join(dirs.sessiondDir, "workspace-state.json"), "utf8"));
      assert.equal(onDisk.sessions[sessionA].archived, true, "archived flag persisted");
      assert.equal(onDisk.sessions[sessionA].pinned, false, "archiving clears the pin");
    });

    await record("legacy localStorage prefs migrate to the server", async () => {
      // Migration runs once, on the page's first load, so the legacy prefs have
      // to be in place BEFORE navigation. A reload would find them already
      // stripped and never retry.
      const legacy = { pinnedSessions: [sessionB], archivedSessions: [], pinnedProjects: [projectB], archivedProjects: [] };
      const fresh = await chrome.openTab();
      await fresh.navigate(stack.origin);
      await fresh.evaluate(`localStorage.setItem("pi-sidebar-item-state", ${JSON.stringify(JSON.stringify(legacy))})`);
      await fresh.navigate(stack.origin);
      await waitFor("the fresh page shows the migrated pin", () => fresh.evaluate(rowState(sessionB)).then((state) => state.sessionPinned));
      await waitFor("B sees the migrated pin", () => pageB.evaluate(rowState(sessionB)).then((state) => state.sessionPinned));
      const onDisk = JSON.parse(await (await import("node:fs/promises")).readFile(join(dirs.sessiondDir, "workspace-state.json"), "utf8"));
      assert.equal(onDisk.sessions[sessionB]?.pinned, true, "migrated session pin reached the server");
      assert.equal(onDisk.projects[projectB]?.pinned, true, `migrated project pin reached the server; projects=${JSON.stringify(Object.keys(onDisk.projects ?? {}))}`);
    });
  } finally {
    await chrome.close().catch(() => {});
    await teardownLifecycleStack(stack, { ...dirs });

  }

  const failed = results.filter((result) => !result.ok);
  console.log(`\nSYNC summary: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
