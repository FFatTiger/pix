import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_IMAGE_ATTACHMENTS,
  MAX_IMAGE_BASE64_LENGTH,
  MAX_IMAGE_INPUT_BASE64_LENGTH,
  MAX_IMAGE_SOURCE_BYTES,
  SUPPORTED_IMAGE_MEDIA_TYPES,
} from "./messages.js";

test("canonical input image limits are the frozen product bounds", () => {
  assert.equal(MAX_IMAGE_ATTACHMENTS, 8);
  assert.equal(MAX_IMAGE_BASE64_LENGTH, 14_000_000);
  assert.equal(MAX_IMAGE_INPUT_BASE64_LENGTH, 14_000_000);
  assert.equal(MAX_IMAGE_SOURCE_BYTES, 10 * 1024 * 1024);
  assert.deepEqual([...SUPPORTED_IMAGE_MEDIA_TYPES], [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
  ]);
});
