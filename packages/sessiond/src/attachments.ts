/**
 * Sessiond side of the shared Pix attachments store.
 *
 * Inline message images (submitTurn and prompt/steer/follow_up) are persisted
 * content-addressed under `attachments/<sessionId>/<sha256-16>.<ext>` through
 * the local-authority primitives — sessiond never forks the on-disk shape.
 * Marker lines are the protocol's; this module only decides the file name and
 * when a write happens. Uploads and the `unfiled` staging area stay host-owned;
 * sessiond only sweeps stale unfiled files and deletes a session's scope.
 */
import { createHash } from "node:crypto";
import {
  isSafeAttachmentScope,
  removeAttachmentScope,
  resolveAttachmentsRoot,
  sweepStaleUnfiledAttachments,
  writeAttachmentFile,
} from "@fffattiger/pix-local-authority/state";
import { appendAttachedMarkerLines, formatAttachedImageMarkerLine } from "@fffattiger/pix-protocol";

/** Matches the protocol `ImageAttachment` fields sessiond persists. `type` is unused. */
export interface InlineImageInput {
  data: string;
  mimeType: string;
}

export interface SessiondAttachmentStore {
  readonly root: string;
  /** Persist images under the session scope; return the message with marker lines appended. */
  annotateMessageWithImages(scope: string, message: string, images: readonly InlineImageInput[]): Promise<string>;
  /** Delete-session cleanup. Best-effort tolerant of ENOENT. */
  removeSessionScope(sessionId: string): Promise<void>;
  /** Remove unfiled staging files older than the max age. */
  sweepStaleUnfiled(): Promise<void>;
}

const DEFAULT_UNFILED_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** `<sha256 hex, first 16 chars>.<ext>`. Unknown mime types stay total (`bin`). */
export function attachmentImageFileName(data: string, mimeType: string): string {
  const bytes = Buffer.from(data, "base64");
  const sha16 = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  return `${sha16}.${IMAGE_EXTENSIONS[mimeType] ?? "bin"}`;
}

export function createSessiondAttachmentStore(options?: {
  root?: string;
  now?: () => number;
  maxUnfiledAgeMs?: number;
  onWarn?: (message: string) => void;
}): SessiondAttachmentStore {
  const root = options?.root ?? resolveAttachmentsRoot(process.env);
  const now = options?.now ?? Date.now;
  const maxUnfiledAgeMs = options?.maxUnfiledAgeMs ?? DEFAULT_UNFILED_MAX_AGE_MS;
  const warn = options?.onWarn ?? ((message: string): void => {
    console.error(`[sessiond] ${message}`);
  });
  return {
    root,
    async annotateMessageWithImages(scope, message, images) {
      if (!isSafeAttachmentScope(scope)) throw new Error("unsafe attachment scope");
      const lines: string[] = [];
      for (const image of images) {
        const written = await writeAttachmentFile({
          root,
          scope,
          name: attachmentImageFileName(image.data, image.mimeType),
          data: Buffer.from(image.data, "base64"),
        });
        lines.push(formatAttachedImageMarkerLine(written.path));
      }
      return appendAttachedMarkerLines(message, lines);
    },
    async removeSessionScope(sessionId) {
      if (!isSafeAttachmentScope(sessionId)) {
        warn("skipped attachment cleanup for an unsafe session scope");
        return;
      }
      await removeAttachmentScope(root, sessionId);
    },
    async sweepStaleUnfiled() {
      await sweepStaleUnfiledAttachments(root, maxUnfiledAgeMs, now());
    },
  };
}
