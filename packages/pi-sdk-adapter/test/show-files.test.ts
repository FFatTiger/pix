/**
 * `show_files`: parameter bounds, the single `open` constraint, relative-path
 * resolution, missing/directory failures, and the details shape. The tool
 * never returns file bytes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Check } from "typebox/value";
import { createShowFilesExtension, SHOW_FILES_MAX, SHOW_FILES_TOOL_NAME } from "../src/internal/show-files.js";

interface RegisteredTool {
  name: string;
  label: string;
  parameters: unknown;
  execute: (
    id: string,
    params: Record<string, never>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: { cwd: string },
  ) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean; details?: unknown }>;
}

function tool(): RegisteredTool {
  let registered: RegisteredTool | undefined;
  const api = { registerTool(candidate: RegisteredTool) { registered = candidate; } };
  (createShowFilesExtension() as (pi: unknown) => void)(api);
  assert.ok(registered, "show_files registered");
  return registered;
}

async function fixture(): Promise<{ cwd: string; file: string; image: string; dir: string }> {
  const cwd = await mkdtemp(join(tmpdir(), "pix-show-files-"));
  const file = join(cwd, "notes.md");
  const image = join(cwd, "shot.png");
  const dir = join(cwd, "subdir");
  await writeFile(file, "notes");
  await writeFile(image, "png");
  await mkdir(dir);
  return { cwd, file, image, dir };
}

describe("show_files", () => {
  it("registers for any session with the user-facing label", () => {
    const registered = tool();
    assert.equal(registered.name, SHOW_FILES_TOOL_NAME);
    assert.equal(registered.label, "给你看文件");
  });

  it("rejects an empty list, more than ten files, and an open that is not one of them", () => {
    const parameters = tool().parameters;
    const valid = (input: unknown) => Check(parameters as never, input);
    assert.equal(valid({ files: [] }), false);
    assert.equal(valid({ files: Array.from({ length: SHOW_FILES_MAX + 1 }, (_, i) => `f${i}`) }), false);
    assert.equal(valid({ files: ["a"], open: "a" }), true);
    assert.equal(valid({ files: ["a", "b"], open: "a" }), true);
    // The schema allows one optional open; membership is enforced at execute.
    assert.equal(valid({ files: ["a"], open: "b" }), true);
  });

  it("resolves relative paths, reports details, and never returns file bytes", async () => {
    const { cwd, file, image } = await fixture();
    try {
      const result = await tool().execute("c1", { files: ["notes.md", image], open: "shot.png" } as never, undefined, undefined, { cwd });
      assert.equal(result.isError, undefined);
      assert.match(result.content[0]!.text!, /已展示 2 个文件/);
      assert.match(result.content[0]!.text!, /shot\.png/);
      assert.equal(result.content[0]!.text!.includes("notes"), false);
      const details = result.details as { files: Array<{ path: string; name: string; kind: string }>; open?: string };
      assert.deepEqual(details.files.map((entry) => entry.name), ["notes.md", "shot.png"]);
      assert.deepEqual(details.files.map((entry) => entry.kind), ["file", "image"]);
      assert.equal(details.files[0]!.path, file);
      assert.equal(details.open, image);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("treats a blank open as no open", async () => {
    const { cwd, file } = await fixture();
    try {
      const result = await tool().execute("c5", { files: [file], open: "  " } as never, undefined, undefined, { cwd });
      assert.equal(result.isError, undefined);
      assert.equal((result.details as { open?: string }).open, undefined);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("fails closed for a missing file, a directory, and an open outside the list", async () => {
    const { cwd, dir, file } = await fixture();
    try {
      const registered = tool();
      const missing = await registered.execute("c2", { files: ["nope.txt"] } as never, undefined, undefined, { cwd });
      assert.equal(missing.isError, true);
      assert.match(missing.content[0]!.text!, /nope\.txt/);
      const directory = await registered.execute("c3", { files: [dir] } as never, undefined, undefined, { cwd });
      assert.equal(directory.isError, true);
      assert.match(directory.content[0]!.text!, /是目录/);
      const outside = await registered.execute("c4", { files: [file], open: "shot.png" } as never, undefined, undefined, { cwd });
      assert.equal(outside.isError, true);
      assert.match(outside.content[0]!.text!, /必须是 files 里的一个文件/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
