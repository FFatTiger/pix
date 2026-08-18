import assert from "node:assert/strict";
import test from "node:test";
import { resolveHostPathFlavor } from "../dist/resources/path-flavor.js";

test("resolveHostPathFlavor classifies drive, UNC, and posix", () => {
  assert.equal(resolveHostPathFlavor("D:\\src_test_env\\pix"), "windows-drive");
  assert.equal(resolveHostPathFlavor("D:/src_test_env/pix"), "windows-drive");
  assert.equal(resolveHostPathFlavor("\\\\server\\share\\repo"), "windows-unc");
  assert.equal(resolveHostPathFlavor("/home/user/repo"), "posix");
  assert.equal(resolveHostPathFlavor(undefined), "posix");
  assert.equal(resolveHostPathFlavor(""), "posix");
});
