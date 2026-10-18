import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebPushSender } from "../dist/resources/web-push-sender.js";
import { createWebPushStoreFromLease } from "../dist/resources/web-push-store.js";
import { openHostStateDirectoryLease } from "../dist/resources/host-state-directory.js";

// The real library and the real store, no stubs: 0.3.7 shipped with every
// stubbed test green while production could neither reach the CJS exports of
// web-push nor accept the 43-char private key it generates.
test("real web-push keys are minted and accepted by the real store", async () => {
  const keys = createWebPushSender().generateVapidKeys();
  assert.match(keys.publicKey, /^[A-Za-z0-9_-]{87}$/);
  assert.match(keys.privateKey, /^[A-Za-z0-9_-]{43}$/);

  const dir = mkdtempSync(join(realpathSync(tmpdir()), "pix-push-real-"));
  try {
    const lease = await openHostStateDirectoryLease({ hostDir: dir });
    try {
      const store = createWebPushStoreFromLease(lease);
      const stored = await store.getOrCreateVapidKeys(() => createWebPushSender().generateVapidKeys());
      assert.match(stored.publicKey, /^[A-Za-z0-9_-]{87}$/);
      assert.deepEqual(await store.getOrCreateVapidKeys(() => assert.fail("keys must persist")), stored);
    } finally {
      await lease.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
