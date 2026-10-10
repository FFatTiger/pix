import { describe, expect, it } from "vitest";
import {
  MAX_IMAGE_ATTACHMENTS,
  MAX_IMAGE_INPUT_BASE64_LENGTH,
  MAX_IMAGE_SOURCE_BYTES,
} from "@fffattiger/pix-protocol";
import {
  canonicalPromptImageMimeType,
  combinedImageLimitReason,
  getBase64DecodedByteLength,
  isBrowserImageFile,
  MAX_ATTACHED_IMAGE_BYTES,
  MAX_ATTACHED_IMAGES,
  validateAgentImages,
} from "./image-attachments";

// Ported verbatim from the legacy desktop source lib/image-attachments.test.mjs.
const image = { type: "image", mimeType: "image/png", data: "YWJj" };

describe("image attachment limits", () => {
  it("calculates padded base64 byte lengths and rejects malformed data", () => {
    expect(getBase64DecodedByteLength("YQ==")).toBe(1);
    expect(getBase64DecodedByteLength("YWI=")).toBe(2);
    expect(getBase64DecodedByteLength("YWJj")).toBe(3);
    expect(getBase64DecodedByteLength("YWJ=")).toBeNull();
    expect(getBase64DecodedByteLength("YR==")).toBeNull();
    expect(getBase64DecodedByteLength("YQ==\n")).toBeNull();
    expect(getBase64DecodedByteLength("not base64!")).toBeNull();
  });

  it("recognizes mobile photo files and identifies when browser conversion is required", () => {
    expect(isBrowserImageFile({ name: "IMG_0001.HEIC", type: "image/heic" })).toBe(true);
    expect(isBrowserImageFile({ name: "IMG_0001.HEIC", type: "" })).toBe(true);
    expect(isBrowserImageFile({ name: "scan.jpg", type: "" })).toBe(true);
    expect(isBrowserImageFile({ name: "notes.txt", type: "" })).toBe(false);

    expect(canonicalPromptImageMimeType({ name: "photo.jpg", type: "image/jpg" })).toBe("image/jpeg");
    expect(canonicalPromptImageMimeType({ name: "photo.jpg", type: "" })).toBe("image/jpeg");
    expect(canonicalPromptImageMimeType({ name: "photo.heic", type: "image/heic" })).toBeNull();
  });

  it("rejects invalid MIME, oversized, and too many image attachments", () => {
    expect(MAX_ATTACHED_IMAGES).toBe(MAX_IMAGE_ATTACHMENTS);
    expect(MAX_ATTACHED_IMAGE_BYTES).toBe(MAX_IMAGE_SOURCE_BYTES);
    expect(validateAgentImages([image])).toBeNull();
    expect(validateAgentImages([{ ...image, type: "text" }])).toMatch(/canonical base64/);
    expect(validateAgentImages([{ ...image, mimeType: "image/" }])).toMatch(/supported image MIME type/);
    expect(validateAgentImages([{ ...image, mimeType: "text/plain" }])).toMatch(/supported image MIME type/);
    expect(validateAgentImages([{ ...image, data: "A".repeat(MAX_IMAGE_INPUT_BASE64_LENGTH + 4) }])).toMatch(/together/);
    expect(validateAgentImages(Array.from({ length: MAX_ATTACHED_IMAGES + 1 }, () => image))).toMatch(/at most/);
  });

  it("combined proposed images honor count and aggregate before append", () => {
    const eight = Array.from({ length: MAX_IMAGE_ATTACHMENTS }, () => image);
    expect(combinedImageLimitReason(eight.slice(0, 7), [image])).toBeNull();
    expect(combinedImageLimitReason(eight, [image])).toBe("count");
    const half = "A".repeat(MAX_IMAGE_INPUT_BASE64_LENGTH / 2);
    expect(combinedImageLimitReason([{ data: half }], [{ data: half }])).toBeNull();
    expect(combinedImageLimitReason([{ data: half }], [{ data: half + "AAAA" }])).toBe("totalTooLarge");
  });
});
