import {
  ImageAttachmentArraySchema,
  ImageAttachmentSchema,
  MAX_IMAGE_ATTACHMENTS,
  MAX_IMAGE_INPUT_BASE64_LENGTH,
  MAX_IMAGE_SOURCE_BYTES,
  SupportedImageMediaTypeSchema,
  type ImageAttachment,
  type SupportedImageMediaType,
} from "@fffattiger/pix-protocol";

/** @deprecated Use Protocol `MAX_IMAGE_SOURCE_BYTES`. Kept as a Protocol-derived alias. */
export const MAX_ATTACHED_IMAGE_BYTES = MAX_IMAGE_SOURCE_BYTES;
/** @deprecated Use Protocol `MAX_IMAGE_ATTACHMENTS`. Kept as a Protocol-derived alias. */
export const MAX_ATTACHED_IMAGES = MAX_IMAGE_ATTACHMENTS;

export const PROMPT_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set(SupportedImageMediaTypeSchema.options);

const IMAGE_FILE_EXTENSION = /\.(?:avif|bmp|gif|heic|heif|jpe?g|png|webp)$/i;
const MOBILE_IMAGE_MAX_EDGE = 2048;
const MOBILE_JPEG_QUALITY = 0.86;

export interface PreparedBrowserImage {
  data: string;
  mimeType: SupportedImageMediaType;
  previewUrl: string;
}

export type Base64ImageAttachment = ImageAttachment;

/** iOS can omit the MIME type for Photos picker files; the name is the fallback. */
export function isBrowserImageFile(file: Pick<File, "name" | "type">): boolean {
  return file.type.toLowerCase().startsWith("image/") || IMAGE_FILE_EXTENSION.test(file.name);
}

/** Return the protocol-safe media type when the original bytes can pass through. */
export function canonicalPromptImageMimeType(file: Pick<File, "name" | "type">): SupportedImageMediaType | null {
  const declared = file.type.toLowerCase();
  const normalized = declared === "image/jpg" || declared === "image/pjpeg" ? "image/jpeg" : declared;
  const parsed = SupportedImageMediaTypeSchema.safeParse(normalized);
  if (parsed.success) return parsed.data;
  if (normalized) return null;
  const extension = file.name.toLowerCase().match(/\.([^.]+)$/)?.[1];
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "png") return "image/png";
  if (extension === "gif") return "image/gif";
  if (extension === "webp") return "image/webp";
  return null;
}

function readBlobAsBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      if (comma < 0) reject(new Error("image data URL is malformed"));
      else resolve(result.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error("image read failed"));
    reader.readAsDataURL(blob);
  });
}

function loadBrowserImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("browser could not decode the image"));
    image.src = url;
  });
}

function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("image conversion failed")),
      "image/jpeg",
      MOBILE_JPEG_QUALITY,
    );
  });
}

/**
 * Prepare a picker/drop image for the wire protocol. PNG/JPEG/GIF/WebP pass
 * through when already within the source-byte bound. Unsupported mobile formats
 * (notably iPhone HEIC/HEIF, sometimes with an empty MIME type) and oversized
 * photos are decoded by the browser, resized, and re-encoded as JPEG.
 */
export async function prepareBrowserImage(file: File): Promise<PreparedBrowserImage> {
  const canonicalMimeType = canonicalPromptImageMimeType(file);
  if (canonicalMimeType && file.size <= MAX_IMAGE_SOURCE_BYTES) {
    return {
      data: await readBlobAsBase64(file),
      mimeType: canonicalMimeType,
      previewUrl: URL.createObjectURL(file),
    };
  }

  if (!isBrowserImageFile(file)) throw new Error("file is not an image");

  const sourceUrl = URL.createObjectURL(file);
  try {
    const image = await loadBrowserImage(sourceUrl);
    const longestEdge = Math.max(image.naturalWidth, image.naturalHeight);
    if (!Number.isFinite(longestEdge) || longestEdge <= 0) throw new Error("image dimensions are invalid");
    const scale = Math.min(1, MOBILE_IMAGE_MAX_EDGE / longestEdge);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("image canvas is unavailable");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const jpeg = await canvasToJpeg(canvas);
    if (jpeg.size > MAX_IMAGE_SOURCE_BYTES) throw new Error("converted image is too large");
    return {
      data: await readBlobAsBase64(jpeg),
      mimeType: "image/jpeg",
      previewUrl: URL.createObjectURL(jpeg),
    };
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

function base64Value(code: number): number | null {
  if (code >= 0x41 && code <= 0x5a) return code - 0x41;
  if (code >= 0x61 && code <= 0x7a) return code - 0x61 + 26;
  if (code >= 0x30 && code <= 0x39) return code - 0x30 + 52;
  if (code === 0x2b) return 62;
  if (code === 0x2f) return 63;
  return null;
}

/** Returns the decoded size only for canonical, padded base64 without whitespace. */
export function getBase64DecodedByteLength(data: string): number | null {
  if (!data || data.length % 4 !== 0) return null;

  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const dataEnd = data.length - padding;
  let lastValue: number | null = null;
  for (let index = 0; index < dataEnd; index += 1) {
    const value = base64Value(data.charCodeAt(index));
    if (value === null) return null;
    lastValue = value;
  }
  for (let index = dataEnd; index < data.length; index += 1) {
    if (data[index] !== "=") return null;
  }
  // Padding consumes low-order bits that must be zero in canonical base64.
  if ((padding === 2 && (lastValue as number) % 16 !== 0) || (padding === 1 && (lastValue as number) % 4 !== 0)) {
    return null;
  }
  return (data.length / 4) * 3 - padding;
}

export function isBase64ImageWithinLimits(value: unknown): value is ImageAttachment {
  return ImageAttachmentSchema.safeParse(value).success;
}

export type CombinedImageLimitReason = "count" | "totalTooLarge";

export function combinedImageLimitReason(
  existing: readonly { data: string }[],
  incoming: readonly { data: string }[],
): CombinedImageLimitReason | null {
  if (existing.length + incoming.length > MAX_IMAGE_ATTACHMENTS) return "count";
  let total = 0;
  for (const image of existing) total += image.data.length;
  for (const image of incoming) total += image.data.length;
  if (total > MAX_IMAGE_INPUT_BASE64_LENGTH) return "totalTooLarge";
  return null;
}

/** Return an API-safe error for prompt, steering, and follow-up image arrays. */
export function validateAgentImages(value: unknown): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return "images must be an array";
  const parsed = ImageAttachmentArraySchema.safeParse(value);
  if (parsed.success) return null;
  if (value.length > MAX_IMAGE_ATTACHMENTS) {
    return `A message can include at most ${MAX_IMAGE_ATTACHMENTS} images`;
  }
  let total = 0;
  for (const image of value) {
    if (image && typeof image === "object" && "data" in image && typeof image.data === "string") {
      total += image.data.length;
    }
  }
  if (total > MAX_IMAGE_INPUT_BASE64_LENGTH) {
    return `Attached images together must stay within ${MAX_IMAGE_INPUT_BASE64_LENGTH} base64 characters`;
  }
  return "Each image must be valid canonical base64 with a supported image MIME type";
}
