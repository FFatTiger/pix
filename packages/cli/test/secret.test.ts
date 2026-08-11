import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLocalSecret, UnsafeSecretError, MIN_SECRET_LENGTH } from "../src/secret.js";

const tempDir = (): Promise<string> => mkdtemp(join(tmpdir(), "pix-secret-"));

test("readLocalSecret returns undefined when the file is absent", async () => {
  const dir = await tempDir();
  try {
    assert.equal(await readLocalSecret(join(dir, "missing")), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readLocalSecret returns the trimmed secret and never creates a file", async () => {
  const dir = await tempDir();
  const file = join(dir, "sessiond.secret");
  try {
    const value = "a".repeat(MIN_SECRET_LENGTH + 10);
    await writeFile(file, `${value}\n`);
    assert.equal(await readLocalSecret(file), value);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readLocalSecret reads only an existing file (read-only contract)", async () => {
  const dir = await tempDir();
  const file = join(dir, "never.created");
  try {
    await readLocalSecret(file);
    // No file should have been created by a read attempt.
    await assert.rejects(() => import("node:fs/promises").then((m) => m.stat(file)), (e) => (e as NodeJS.ErrnoException).code === "ENOENT");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readLocalSecret rejects a symlink", async () => {
  const dir = await tempDir();
  const target = join(dir, "target");
  const link = join(dir, "sessiond.secret");
  try {
    await writeFile(target, "a".repeat(MIN_SECRET_LENGTH + 5));
    await symlink(target, link);
    await assert.rejects(() => readLocalSecret(link), (e) => e instanceof UnsafeSecretError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readLocalSecret rejects a non-regular file (directory)", async () => {
  const dir = await tempDir();
  try {
    await assert.rejects(() => readLocalSecret(dir), (e) => e instanceof UnsafeSecretError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readLocalSecret rejects a too-short secret", async () => {
  const dir = await tempDir();
  const file = join(dir, "sessiond.secret");
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(file, "short");
    await assert.rejects(() => readLocalSecret(file), (e) => e instanceof UnsafeSecretError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
