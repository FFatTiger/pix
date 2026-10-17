import assert from "node:assert/strict";
import { test } from "node:test";
import { ASSISTANT_SENT_MESSAGE_PREFIX } from "@fffattiger/pix-protocol";
import { firstMessageLabel } from "../src/service.js";

test("untitled sessions are labelled by their first message, without the Pixie marker", () => {
  assert.equal(firstMessageLabel("  修一下\n登录页  "), "修一下 登录页");
  assert.equal(firstMessageLabel(`${ASSISTANT_SENT_MESSAGE_PREFIX}\n\n整理周报`), "整理周报");
  assert.equal(firstMessageLabel("x".repeat(100))?.length, 80);
  assert.equal(firstMessageLabel("   "), undefined);
  assert.equal(firstMessageLabel(undefined), undefined);
});
