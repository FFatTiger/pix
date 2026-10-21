/**
 * Evidence + assertions for the turn file-row fix (write + show_files on the
 * same path, and the no-baseline diff preview).
 *
 * Boots the REAL production stack in-process (sessiond daemon + Hono Host +
 * built Client) from an isolated temp agentDir/project, then drives the real
 * Chrome over CDP. Two seeded sessions cover every card state:
 *   - git repo cwd: write+show (turn 1), show-only (turn 2), write-only new
 *     file (turn 3), write-only tracked file (turn 4);
 *   - non-git cwd: write+show on a new markdown file (the reported defect).
 *
 * Screenshots land in ./shots. Run: node tests/e2e/manual/turn-files-show-files.mjs
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launchChromeCdp } from "../helpers/chrome-cdp.mjs";
import {
  bootLifecycleStack,
  makeIsolatedDirs,
  teardownLifecycleStack,
  writeStubProviderConfig,
} from "../helpers/lifecycle-stack.mjs";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const CLIENT_DIST = join(ROOT, "packages", "client", "dist");
const EVIDENCE = join(ROOT, "tests", "e2e", ".artifacts", "turn-files");
const SEED = join(import.meta.dirname, "seed-turn-files.mjs");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CARDS = `(() => [...document.querySelectorAll(".chat-assistant-message")].map((node) => ({
  reply: (node.querySelector(".chat-assistant-content")?.textContent ?? "").slice(0, 30),
  chips: [...node.querySelectorAll(".turn-written-file-chip")].map((b) => (b.textContent ?? "").trim()),
  rows: [...node.querySelectorAll(".turn-shown-row")].map((b) => ({
    name: b.querySelector(".turn-shown-name")?.textContent ?? "",
    dir: b.querySelector(".turn-shown-dir")?.textContent ?? "",
    stats: b.querySelector(".turn-shown-stats")?.textContent ?? "",
  })),
})))()`;

const PREVIEW = `(() => {
  const pane = document.querySelector(".subagent-panel");
  if (!pane) return { open: false };
  return {
    open: true,
    title: pane.querySelector(".subagent-panel-heading")?.textContent ?? "",
    buttons: [...pane.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim()).filter(Boolean),
    renderedMarkdown: Boolean(pane.querySelector(".markdown-file-preview")),
    headings: [...pane.querySelectorAll(".markdown-file-preview h1")].map((h) => h.textContent),
    tableRows: [...pane.querySelectorAll("table")].map((t) => t.querySelectorAll("tr").length),
    tableCells: [...pane.querySelectorAll("td")].slice(0, 3).map((c) => c.textContent),
    sourceRendered: Boolean(pane.querySelector("pre")),
    lineNumbers: pane.querySelectorAll(".react-syntax-highlighter-line-number, span.linenumber").length,
    text: (pane.textContent ?? "").slice(0, 160),
  };
})()`;

async function focusReply(page, index) {
  await page.evaluate(`(() => {
    document.querySelectorAll(".chat-assistant-message")[${index}]?.scrollIntoView({ block: "center" });
  })()`);
  await delay(400);
}

async function clickCard(page, text, label) {
  const clicked = await page.evaluate(`(() => {
    const buttons = [...document.querySelectorAll(".turn-written-file-chip, .turn-shown-row, .turn-shown-shot")];
    const target = buttons.find((b) => (b.textContent ?? "").includes(${JSON.stringify(text)}) || (b.getAttribute("title") ?? "").includes(${JSON.stringify(text)}));
    if (!target) return false;
    target.click();
    return true;
  })()`);
  assert.equal(clicked, true, `${label}: card for ${text} must be clickable`);
  await page.waitFor(`Boolean(document.querySelector(".subagent-panel"))`, { timeoutMs: 20_000, label: `${label}: preview pane` });
  await delay(1200);
}

async function closePreview(page) {
  await page.evaluate(`document.querySelector(".subagent-icon-button")?.click()`);
  await delay(400);
}

async function openSession(page, origin, sessionId, cwd, minReplies, label) {
  await page.navigate(`${origin}/?session=${sessionId}&cwd=${encodeURIComponent(cwd)}`);
  await page.waitFor(`document.querySelectorAll(".chat-assistant-message").length >= ${minReplies}`, {
    timeoutMs: 30_000,
    label: `${label}: replies rendered`,
  });
  await delay(800);
}

const results = [];
async function check(name, run) {
  try {
    await run();
    results.push({ name, ok: true });
    console.log(`PASS — ${name}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ name, ok: false, detail });
    console.log(`FAIL — ${name} :: ${detail}`);
  }
}

async function main() {
  const dirs = await makeIsolatedDirs("px-turnfiles");
  const gitDir = join(dirs.projectCwd, "git-project");
  const plainDir = join(dirs.projectCwd, "plain-project");
  mkdirSync(gitDir, { recursive: true });
  mkdirSync(plainDir, { recursive: true });
  mkdirSync(EVIDENCE, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = dirs.agentDir;
  await writeStubProviderConfig(dirs.agentDir, "http://127.0.0.1:9/v1");

  const { execFileSync } = await import("node:child_process");
  const seeded = JSON.parse(execFileSync(process.execPath, [SEED, dirs.agentDir, gitDir, plainDir], { encoding: "utf8" }));

  const stack = await bootLifecycleStack({ ...dirs, clientDist: CLIENT_DIST });
  const chrome = await launchChromeCdp();
  let cards = [];
  try {
    const page = chrome;
    await page.setViewport(1440, 900);

    await openSession(page, stack.origin, seeded.gitSession, gitDir, 4, "git");
    cards = await page.evaluate(CARDS);
    await focusReply(page, 0);
    await page.screenshot(join(EVIDENCE, "a-turn1-write-and-show-card.png"));

    await check("a turn that wrote AND showed one file renders the shown card with its write stats", async () => {
      const card = cards[0];
      assert.ok(card, `first reply must exist: ${JSON.stringify(cards)}`);
      assert.deepEqual(card.chips, [], "no written chip for a shown path");
      assert.equal(card.rows.length, 1, "exactly one row for the file");
      assert.equal(card.rows[0].name, "SCOPE-STATUS.md");
      assert.equal(card.rows[0].stats, "+31", "write stats ride on the shown card");
    });

    await check("the shown card opens the rendered markdown preview, never a diff", async () => {
      await clickCard(page, "SCOPE-STATUS.md", "git/turn1");
      const view = await page.evaluate(PREVIEW);
      await page.screenshot(join(EVIDENCE, "b-turn1-preview.png"));
      assert.equal(view.buttons.includes("差异"), true, `diff toggle offered only because the file has a working-tree diff: ${JSON.stringify(view.buttons)}`);
      assert.equal(view.renderedMarkdown, true, "markdown renders");
      assert.deepEqual(view.tableRows, [4, 3, 3], "every table keeps its rows");
      assert.equal(view.lineNumbers, 0, "no syntax line numbers over a document");
      await closePreview(page);
    });

    await check("a show-only turn renders the identical card without stats", async () => {
      await focusReply(page, 1);
      await page.screenshot(join(EVIDENCE, "c-turn2-show-only-card.png"));
      const card = cards[1];
      assert.deepEqual(card.chips, []);
      assert.deepEqual(card.rows.map((r) => [r.name, r.stats]), [["SCOPE-STATUS.md", ""]], "same card, no write marker");
      await clickCard(page, "SCOPE-STATUS.md", "git/turn2");
      const view = await page.evaluate(PREVIEW);
      assert.equal(view.renderedMarkdown, true);
      assert.deepEqual(view.tableRows, [4, 3, 3]);
      await closePreview(page);
    });

    await check("a write-only new file keeps the chip and opens the host's all-added diff", async () => {
      await focusReply(page, 2);
      await page.screenshot(join(EVIDENCE, "d-turn3-write-only-chip.png"));
      assert.deepEqual(cards[2].chips, ["REPORT.md+66"]);
      assert.deepEqual(cards[2].rows, [], "written-only files never become shown rows");
      await clickCard(page, "REPORT.md", "git/turn3");
      const view = await page.evaluate(PREVIEW);
      await page.screenshot(join(EVIDENCE, "e-turn3-diff.png"));
      assert.equal(view.renderedMarkdown, false, "a diff is not a rendered document");
      assert.match(view.text, /@@ -0,0 \+1,66 @@/, "the synthesized new-file hunk header");
      assert.match(view.text, /第 1 行记录/);
      await closePreview(page);
    });

    await check("a write-only tracked file still shows the real git diff", async () => {
      await focusReply(page, 3);
      await page.screenshot(join(EVIDENCE, "f-turn4-tracked-chip.png"));
      assert.deepEqual(cards[3].chips, ["tracked.md+6"]);
      await clickCard(page, "tracked.md", "git/turn4");
      const view = await page.evaluate(PREVIEW);
      await page.screenshot(join(EVIDENCE, "g-turn4-real-git-diff.png"));
      assert.equal(view.renderedMarkdown, false);
      assert.match(view.text, /@@ -2,3 \+2,5 @@/, "real git hunk header preserved");
      assert.match(view.text, /追加的一行/);
      await closePreview(page);
    });

    // Non-git cwd: the reported defect.
    await openSession(page, stack.origin, seeded.plainSession, plainDir, 1, "plain");
    const plainCards = await page.evaluate(CARDS);
    await focusReply(page, 0);
    await page.screenshot(join(EVIDENCE, "h-nongit-write-and-show-card.png"));

    await check("outside a git repo a write+show file is still the shown card with stats", async () => {
      assert.deepEqual(plainCards[0].chips, []);
      assert.deepEqual(plainCards[0].rows.map((r) => [r.name, r.stats]), [["SCOPE-STATUS.md", "+12"]]);
    });

    await check("outside a git repo the preview renders the markdown instead of raw tokenized source", async () => {
      await clickCard(page, "SCOPE-STATUS.md", "plain/turn1");
      const view = await page.evaluate(PREVIEW);
      await page.screenshot(join(EVIDENCE, "i-nongit-preview.png"));
      assert.deepEqual(view.buttons, ["预览", "原始内容"], `no diff mode without a baseline: ${JSON.stringify(view.buttons)}`);
      assert.equal(view.renderedMarkdown, true, "document renders (the old bug showed raw source)");
      assert.deepEqual(view.tableRows, [3, 2], "tables keep their rows");
      assert.equal(view.lineNumbers, 0, "no syntax line numbers");
      assert.equal(view.sourceRendered, false, "no <pre> source dump");
    });
  } finally {
    await chrome.close().catch(() => {});
    await teardownLifecycleStack(stack).catch(() => {});
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed; screenshots in ${EVIDENCE}`);
  if (failed.length > 0) process.exitCode = 1;
}

await main();
