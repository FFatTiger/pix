import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_IMAGE_ATTACHMENTS as CORE_MAX_IMAGE_ATTACHMENTS,
  MAX_IMAGE_BASE64_LENGTH as CORE_MAX_IMAGE_BASE64_LENGTH,
  MAX_IMAGE_INPUT_BASE64_LENGTH as CORE_MAX_IMAGE_INPUT_BASE64_LENGTH,
  MAX_IMAGE_SOURCE_BYTES as CORE_MAX_IMAGE_SOURCE_BYTES,
  SUPPORTED_IMAGE_MEDIA_TYPES as CORE_SUPPORTED_IMAGE_MEDIA_TYPES,
} from "@fffattiger/pix-runtime-core";
import {
  FollowUpCommandSchema,
  ImageAttachmentArraySchema,
  ImageAttachmentSchema,
  MAX_IMAGE_ATTACHMENTS as WIRE_MAX_IMAGE_ATTACHMENTS,
  MAX_IMAGE_BASE64_LENGTH as WIRE_MAX_IMAGE_BASE64_LENGTH,
  MAX_IMAGE_INPUT_BASE64_LENGTH as WIRE_MAX_IMAGE_INPUT_BASE64_LENGTH,
  MAX_IMAGE_SOURCE_BYTES as WIRE_MAX_IMAGE_SOURCE_BYTES,
  PromptCommandSchema,
  SteerCommandSchema,
  SubmitTurnRequestSchema,
  SupportedImageMediaTypeSchema,
  UserMessageSchema,
} from "@fffattiger/pix-protocol";

const png = (data: string) => ({ type: "image" as const, data, mimeType: "image/png" as const });

test("image input limits match canonical Runtime Core", () => {
  assert.equal(WIRE_MAX_IMAGE_ATTACHMENTS, CORE_MAX_IMAGE_ATTACHMENTS);
  assert.equal(WIRE_MAX_IMAGE_BASE64_LENGTH, CORE_MAX_IMAGE_BASE64_LENGTH);
  assert.equal(WIRE_MAX_IMAGE_INPUT_BASE64_LENGTH, CORE_MAX_IMAGE_INPUT_BASE64_LENGTH);
  assert.equal(WIRE_MAX_IMAGE_SOURCE_BYTES, CORE_MAX_IMAGE_SOURCE_BYTES);
  assert.deepEqual([...SupportedImageMediaTypeSchema.options], [...CORE_SUPPORTED_IMAGE_MEDIA_TYPES]);
});

test("protocol accepts eight canonical images and rejects nine", () => {
  const eight = Array.from({ length: WIRE_MAX_IMAGE_ATTACHMENTS }, () => png("AA=="));
  const nine = [...eight, png("AA==")];
  assert.equal(ImageAttachmentArraySchema.safeParse(eight).success, true);
  assert.equal(ImageAttachmentArraySchema.safeParse(nine).success, false);
  for (const schema of [PromptCommandSchema, SteerCommandSchema, FollowUpCommandSchema]) {
    const type = schema === PromptCommandSchema ? "prompt" : schema === SteerCommandSchema ? "steer" : "follow_up";
    assert.equal(schema.safeParse({ commandId: "c1", type, message: "hi", images: eight }).success, true);
    assert.equal(schema.safeParse({ commandId: "c1", type, message: "hi", images: nine }).success, false);
  }
  assert.equal(SubmitTurnRequestSchema.safeParse({
    sessionId: "s1",
    prompt: "hi",
    operationId: "op1",
    images: eight,
  }).success, true);
  assert.equal(SubmitTurnRequestSchema.safeParse({
    sessionId: "s1",
    prompt: "hi",
    operationId: "op1",
    images: nine,
  }).success, false);
});

test("aggregate base64 is inclusive at 14M and rejects one character over", () => {
  const half = Math.floor(WIRE_MAX_IMAGE_INPUT_BASE64_LENGTH / 2);
  const evenHalf = half - (half % 4);
  const remainder = WIRE_MAX_IMAGE_INPUT_BASE64_LENGTH - evenHalf;
  const evenRemainder = remainder - (remainder % 4);
  const exact = [png("A".repeat(evenHalf)), png("A".repeat(evenRemainder))];
  assert.equal(exact[0]!.data.length + exact[1]!.data.length, WIRE_MAX_IMAGE_INPUT_BASE64_LENGTH);
  assert.equal(ImageAttachmentArraySchema.safeParse(exact).success, true);
  const over = [png("A".repeat(evenHalf)), png("A".repeat(evenRemainder + 4))];
  assert.equal(ImageAttachmentArraySchema.safeParse(over).success, false);
});

test("one 10 MiB decoded image is accepted with data unchanged", () => {
  const data = Buffer.alloc(WIRE_MAX_IMAGE_SOURCE_BYTES, 0).toString("base64");
  const image = png(data);
  const parsed = ImageAttachmentSchema.parse(image);
  assert.equal(parsed.data, data);
  assert.equal(parsed.mimeType, "image/png");
  assert.equal(ImageAttachmentArraySchema.safeParse([image]).success, true);
});

test("two large images are rejected by the shared aggregate even when each is legal", () => {
  const chunk = "A".repeat(8_000_000);
  const images = [png(chunk), png(chunk)];
  assert.equal(ImageAttachmentSchema.safeParse(images[0]).success, true);
  assert.equal(ImageAttachmentArraySchema.safeParse(images).success, false);
});

test("historical transcript images are not restricted by the input count", () => {
  const content = Array.from({ length: WIRE_MAX_IMAGE_ATTACHMENTS + 1 }, () => ({
    type: "image" as const,
    source: { type: "base64" as const, media_type: "image/png" as const, data: "AA==" },
  }));
  assert.equal(UserMessageSchema.safeParse({ role: "user", content }).success, true);
});

test("empty and omitted input image arrays stay legal", () => {
  assert.equal(ImageAttachmentArraySchema.safeParse([]).success, true);
  assert.equal(PromptCommandSchema.safeParse({ commandId: "c1", type: "prompt", message: "hi" }).success, true);
  assert.equal(PromptCommandSchema.safeParse({ commandId: "c1", type: "prompt", message: "hi", images: [] }).success, true);
  assert.equal(SubmitTurnRequestSchema.safeParse({ sessionId: "s1", prompt: "hi", operationId: "op1" }).success, true);
});
