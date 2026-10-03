import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { patchPiClaudeSubagents } from "./patch-pi-claude-subagents.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const installedRoot = join(repoRoot, "node_modules", "pi-claude-subagents");
const pristineRuntimeHash = "176a4d6c678af81c95acdd8f2bf6fa2374ce33fb8f10ea493c6ea4cad83d4cd2";
const patchedRuntimeHash = "bc9b3ef4e92263ba9aac1b184621f25e3afb05ee42684b7719bd36a4f23fc218";
// Packaged source at aaa56e9; the Pix patch must never alter its notification owner.
const pristineIndexHash = "bc68335a3c33ece4ce8751558e48c22cf9f3f762bf4182f108bf209638a6d0e4";

function hash(source) {
  return createHash("sha256").update(source).digest("hex");
}

function replaceUnique(source, oldText, newText) {
  assert.equal(source.split(oldText).length - 1, 1);
  return source.replace(oldText, newText);
}

function pristineRuntimeFromInstalled(source) {
  let pristine = replaceUnique(
    source,
    [
      "      unsubscribe = childSession.subscribe(event => {",
      "        if (event.type === \"message_update\") {",
      "          globalThis.__pixSubagentStream?.(sessionManager.getSessionId(), event);",
      "        }",
      "        if (event.type !== \"message_end\") return;",
      "        messages.push(event.message);",
      "        if (event.message.role === \"assistant\") {",
      "          applyAssistantTokenUsage(options.record, event.message);",
      "          globalThis.__pixSubagentStream?.(sessionManager.getSessionId(), event);",
      "        }",
      "        const preview = extractFinalText(messages);",
      "        if (preview) options.record.preview = preview.split(\"\\n\")[0]?.slice(0, 300);",
      "        applyLifecycleUsage(options.record, usageBaseline, lifecycle.snapshot.usage);",
      "      });",
    ].join("\n"),
    [
      "      unsubscribe = childSession.subscribe(event => {",
      "        if (event.type !== \"message_end\") return;",
      "        messages.push(event.message);",
      "        if (event.message.role === \"assistant\") applyAssistantTokenUsage(options.record, event.message);",
      "        const preview = extractFinalText(messages);",
      "        if (preview) options.record.preview = preview.split(\"\\n\")[0]?.slice(0, 300);",
      "        applyLifecycleUsage(options.record, usageBaseline, lifecycle.snapshot.usage);",
      "      });",
    ].join("\n"),
  );
  pristine = replaceUnique(
    pristine,
    [
      "          const unsubscribe = childSession.subscribe(event => {",
      "            if (event.type === \"message_update\") {",
      "              globalThis.__pixSubagentStream?.(childSession.sessionId, event);",
      "            }",
      "            if (event.type === \"message_end\") {",
      "              messages.push(event.message);",
      "              if (event.message.role === \"assistant\") {",
      "                applyAssistantTokenUsage(record, event.message);",
      "                globalThis.__pixSubagentStream?.(childSession.sessionId, event);",
      "              }",
    ].join("\n"),
    [
      "          const unsubscribe = childSession.subscribe(event => {",
      "            if (event.type === \"message_end\") {",
      "              messages.push(event.message);",
      "              if (event.message.role === \"assistant\") {",
      "                applyAssistantTokenUsage(record, event.message);",
      "              }",
    ].join("\n"),
  );
  pristine = replaceUnique(
    pristine,
    "  createTaskRecord,\n",
    "  createUnpersistedTaskRecord,\n",
  );
  pristine = replaceUnique(
    pristine,
    "  const record = await createTaskRecord({",
    "  const record = await createUnpersistedTaskRecord({",
  );
  return replaceUnique(
    pristine,
    "    name: options.spec.name,\n  });\n  options.onUpdate?.(record);\n  const abortController = new AbortController();",
    "    name: options.spec.name,\n  });\n  const abortController = new AbortController();",
  );
}

async function copyInstalledPackage() {
  const root = await mkdtemp(join(tmpdir(), "pix-subagents-patch-"));
  await cp(installedRoot, root, { recursive: true });
  return root;
}

describe("pi-claude-subagents downstream patch", () => {
  it("patches the exact pristine 0.3.8 runtime, leaves index pristine, and is idempotent", async () => {
    const installedRuntime = await readFile(join(installedRoot, "src", "runtime.ts"), "utf8");
    const installedIndex = await readFile(join(installedRoot, "src", "index.ts"), "utf8");
    assert.equal(hash(installedRuntime), patchedRuntimeHash);
    assert.equal(hash(installedIndex), pristineIndexHash);
    assert.equal(installedIndex.includes("pi-subagent-started"), false);
    assert.equal(installedRuntime.includes("globalThis.__pixSubagentStream?.(childSession.sessionId, event)"), true);
    assert.equal(installedRuntime.includes("globalThis.__pixSubagentStream?.(sessionManager.getSessionId(), event)"), true);
    assert.equal(installedRuntime.split("globalThis.__pixSubagentStream").length - 1, 4);
    assert.equal(patchPiClaudeSubagents(installedRoot), false);

    const pristine = pristineRuntimeFromInstalled(installedRuntime);
    assert.equal(hash(pristine), pristineRuntimeHash);
    assert.equal(pristine.includes("__pixSubagentStream"), false);
    const root = await copyInstalledPackage();
    try {
      await writeFile(join(root, "src", "runtime.ts"), pristine);
      assert.equal(patchPiClaudeSubagents(root), true);
      const patched = await readFile(join(root, "src", "runtime.ts"), "utf8");
      assert.equal(patched, installedRuntime);
      assert.equal(await readFile(join(root, "src", "index.ts"), "utf8"), installedIndex);
      assert.equal(patched.includes("if (event.type === \"message_end\")"), true);
      assert.equal(patched.includes("if (event.type !== \"message_end\") return;"), true);
      assert.equal(patchPiClaudeSubagents(root), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects version or layout ambiguity without writing a partial patch", async () => {
    const root = await copyInstalledPackage();
    try {
      const runtimePath = join(root, "src", "runtime.ts");
      const ambiguous = `${pristineRuntimeFromInstalled(await readFile(runtimePath, "utf8"))}\n// unexpected layout\n`;
      await writeFile(runtimePath, ambiguous);
      assert.throws(() => patchPiClaudeSubagents(root), /unsupported pi-claude-subagents runtime layout/);
      assert.equal(await readFile(runtimePath, "utf8"), ambiguous);

      const packagePath = join(root, "package.json");
      const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
      await writeFile(packagePath, JSON.stringify({ ...packageJson, version: "0.3.9" }));
      assert.throws(() => patchPiClaudeSubagents(root), /unsupported pi-claude-subagents version/);
      assert.equal(await readFile(runtimePath, "utf8"), ambiguous);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
