import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  bundledPluginRoots,
  createCuratedExtensionsOverride,
  filterCuratedExtensions,
} from "../src/internal/curated-plugins.js";

function configBody(overrides: Record<string, boolean>): string {
  return `${JSON.stringify({
    version: 1,
    subagents: overrides.subagents ?? true,
    todo: overrides.todo ?? true,
    ask_user_question: overrides.ask_user_question ?? true,
    side_chat: overrides.side_chat ?? true,
  }, null, 2)}\n`;
}

describe("curated plugin loader filter", () => {
  it("keeps the exact bundled identity when desired-enabled and dedupes repeated exact-identity instances", () => {
    const roots = bundledPluginRoots();
    const subagents = roots.find((item) => item.id === "subagents")!;
    const todo = roots.find((item) => item.id === "todo")!;
    const ask = roots.find((item) => item.id === "ask_user_question")!;
    const runtime = { marker: "shared" };
    const filtered = filterCuratedExtensions({
      extensions: [
        { path: subagents.entry, resolvedPath: subagents.entry },
        { path: subagents.root, resolvedPath: subagents.root },
        { path: todo.entry, resolvedPath: todo.entry },
        { path: "/project/extensions/unrelated.ts", resolvedPath: "/project/extensions/unrelated.ts" },
        { path: ask.entry, resolvedPath: ask.entry },
      ],
      errors: [
        { path: "/project/extensions/broken.ts", error: "boom" },
        { path: subagents.entry, error: "curated load error stays visible when enabled" },
      ],
      runtime,
    }, new Set(["subagents", "todo"]));
    assert.deepEqual(filtered.extensions.map((item) => item.resolvedPath), [
      subagents.entry,
      todo.entry,
      "/project/extensions/unrelated.ts",
    ]);
    assert.equal(filtered.runtime, runtime);
    assert.deepEqual(filtered.errors, [
      { path: "/project/extensions/broken.ts", error: "boom" },
      { path: subagents.entry, error: "curated load error stays visible when enabled" },
    ]);
  });

  it("removes foreign-path copies by exact curated signature while preserving partial overlaps", () => {
    const roots = bundledPluginRoots();
    const subagents = roots.find((item) => item.id === "subagents")!;
    const userCopy = "/tmp/user/pi-claude-subagents/src/index.ts";
    const filtered = filterCuratedExtensions({
      extensions: [
        { path: subagents.entry, resolvedPath: subagents.entry },
        {
          path: userCopy,
          resolvedPath: userCopy,
          tools: new Map(["Agent", "SendMessage", "TaskOutput", "TaskStop"].map((name) => [name, {}])),
          commands: new Map(["agents", "pi-subagents-doctor"].map((name) => [name, {}])),
        },
        // A partial overlap is not the curated plugin and remains user-owned.
        {
          path: "/project/extensions/custom-agent.ts",
          resolvedPath: "/project/extensions/custom-agent.ts",
          tools: new Map([["Agent", {}]]),
          commands: new Map(),
        },
        // A configured entry resolving to the bundled path is also a duplicate.
        { path: userCopy, resolvedPath: subagents.root },
        { path: "/project/extensions/unrelated.ts", resolvedPath: "/project/extensions/unrelated.ts" },
      ],
      errors: [{ path: userCopy, error: "foreign load error preserved" }],
      runtime: {},
    }, new Set(["subagents"]));
    assert.deepEqual(filtered.extensions.map((item) => item.resolvedPath), [
      subagents.entry,
      "/project/extensions/custom-agent.ts",
      "/project/extensions/unrelated.ts",
    ]);
    assert.deepEqual(filtered.errors, [{ path: userCopy, error: "foreign load error preserved" }]);
  });

  it("drops a desired-disabled curated plugin even when the exact bundled path is present", () => {
    const roots = bundledPluginRoots();
    const subagents = roots.find((item) => item.id === "subagents")!;
    const filtered = filterCuratedExtensions({
      extensions: [
        { path: subagents.entry, resolvedPath: subagents.entry },
        { path: "/project/keep.ts", resolvedPath: "/project/keep.ts" },
      ],
      errors: [{ path: subagents.entry, error: "ignored because disabled" }],
      runtime: {},
    }, new Set(["todo"]));
    assert.deepEqual(filtered.extensions.map((item) => item.resolvedPath), ["/project/keep.ts"]);
    assert.deepEqual(filtered.errors, []);
  });

  it("override reads the CURRENT desired config on every load (create vs reload) and fails closed on corrupt config", async () => {
    const root = await mkdtemp(join(tmpdir(), "pix-curated-cfg-"));
    const agentDir = join(root, "agent");
    await mkdir(agentDir, { recursive: true, mode: 0o700 });
    const configPath = join(agentDir, "pix-builtins.json");
    try {
      const todoRoot = bundledPluginRoots().find((item) => item.id === "todo")!;
      const override = createCuratedExtensionsOverride(agentDir);
      const base = {
        extensions: [
          { path: todoRoot.entry, resolvedPath: todoRoot.entry },
          { path: "/project/keep.ts", resolvedPath: "/project/keep.ts" },
        ],
        errors: [] as Array<{ path: string; error: string }>,
        runtime: { marker: 1 },
      };

      // Missing config file: all four enabled — curated identity kept.
      const enabled = override(base);
      assert.equal(enabled.extensions.length, 2);

      // Disable todo: the same override call (reload path) now drops it.
      await writeFile(configPath, configBody({ todo: false }), { mode: 0o600 });
      const disabled = override(base);
      assert.deepEqual(disabled.extensions.map((item) => item.resolvedPath), ["/project/keep.ts"]);

      // Corrupt config fails closed: the override throws instead of guessing.
      await writeFile(configPath, "{ not json", { mode: 0o600 });
      assert.throws(() => override(base));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
