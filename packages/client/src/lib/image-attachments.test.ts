import { describe, expect, it } from "vitest";
import {
  getBase64DecodedByteLength,
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

  it("rejects invalid MIME, oversized, and too many image attachments", () => {
    const oversizedData = "AAAA".repeat(Math.ceil((MAX_ATTACHED_IMAGE_BYTES + 1) / 3));

    expect(validateAgentImages([image])).toBeNull();
    expect(validateAgentImages([{ ...image, type: "text" }])).toMatch(/valid base64 image/);
    expect(validateAgentImages([{ ...image, mimeType: "image/" }])).toMatch(/image MIME type/);
    expect(validateAgentImages([{ ...image, mimeType: "text/plain" }])).toMatch(/image MIME type/);
    expect(validateAgentImages([{ ...image, data: oversizedData }])).toMatch(/10MB/);
    expect(validateAgentImages(Array.from({ length: MAX_ATTACHED_IMAGES + 1 }, () => image))).toMatch(/at most/);
  });
});
