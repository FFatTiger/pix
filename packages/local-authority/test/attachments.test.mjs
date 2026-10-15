import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readdir, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LocalAuthorityError,
  removeAttachmentScope,
  sweepStaleUnfiledAttachments,
  writeAttachmentFile,
} from "../dist/index.js";

/** Fresh store root plus an "outside" tree a planted symlink points into. */
async function makeFixture() {
  const base = await mkdtemp(join(tmpdir(), "pix-att-symlink-"));
  const root = join(base, "store");
  const outside = join(base, "outside");
  await mkdir(outside, { recursive: true });
  return { base, root, outside };
}

test("writeAttachmentFile refuses a scope directory replaced by a symlink", async () => {
  const { base, root, outside } = await makeFixture();
  try {
    await mkdir(join(root, "evil"), { recursive: true });
    await rm(join(root, "evil"), { recursive: true });
    await symlink(outside, join(root, "evil"));
    await assert.rejects(
      writeAttachmentFile({ root, scope: "evil", name: "pwn.txt", data: new Uint8Array([1]) }),
      LocalAuthorityError,
    );
    // Nothing landed outside the store through the link.
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("writeAttachmentFile refuses a store root that is a symlink", async () => {
  const { base, root, outside } = await makeFixture();
  try {
    await mkdir(root, { recursive: true });
    const linkedRoot = join(base, "linked-root");
    await symlink(root, linkedRoot);
    await assert.rejects(
      writeAttachmentFile({ root: linkedRoot, scope: "s1", name: "a.txt", data: new Uint8Array([1]) }),
      LocalAuthorityError,
    );
    // The scope directory was not created inside the linked target either:
    // the root is rejected BEFORE any scope creation.
    assert.deepEqual(await readdir(root), []);
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("writeAttachmentFile refuses a scope path occupied by a regular file", async () => {
  const { base, root } = await makeFixture();
  try {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "occupied"), "x");
    await assert.rejects(
      writeAttachmentFile({ root, scope: "occupied", name: "a.txt", data: new Uint8Array([1]) }),
      LocalAuthorityError,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("sweep never deletes through a symlinked unfiled directory", async () => {
  const { base, root, outside } = await makeFixture();
  try {
    await mkdir(root, { recursive: true });
    await symlink(outside, join(root, "unfiled"));
    await writeFile(join(outside, "stale.bin"), "old");
    const removed = await sweepStaleUnfiledAttachments(root, 0);
    assert.equal(removed, 0);
    assert.deepEqual(await readdir(outside), ["stale.bin"]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("sweep and removeAttachmentScope fail closed through a symlinked store root", async () => {
  const { base, root, outside } = await makeFixture();
  try {
    await mkdir(join(outside, "unfiled"), { recursive: true });
    await writeFile(join(outside, "unfiled", "stale.bin"), "old");
    await mkdir(join(outside, "sess"), { recursive: true });
    await writeFile(join(outside, "sess", "keep.txt"), "keep");
    const linkedRoot = join(base, "linked-root");
    await symlink(outside, linkedRoot);
    await assert.rejects(sweepStaleUnfiledAttachments(linkedRoot, 0), LocalAuthorityError);
    await assert.rejects(removeAttachmentScope(linkedRoot, "sess"), LocalAuthorityError);
    // Nothing outside the store was touched through the link.
    assert.deepEqual(await readdir(join(outside, "unfiled")), ["stale.bin"]);
    assert.deepEqual(await readdir(join(outside, "sess")), ["keep.txt"]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("writeAttachmentFile happy path: write, reuse, real dirs", async () => {
  const { base, root } = await makeFixture();
  try {
    const first = await writeAttachmentFile({ root, scope: "s1", name: "a.png", data: new Uint8Array([1, 2, 3]) });
    assert.equal(first.existed, false);
    const second = await writeAttachmentFile({ root, scope: "s1", name: "a.png", data: new Uint8Array([1, 2, 3]) });
    assert.equal(second.existed, true);
    assert.equal(first.path, second.path);
    assert.deepEqual(await readdir(join(root, "s1")), ["a.png"]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
