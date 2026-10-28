/**
 * Folder-browser error copy owner.
 *
 * The Host's browse/roots routes are the authorization authority. Their raw
 * error message is never rendered: a structured HttpError code/kind selects
 * fixed copy, with an English fallback so a missing i18n key can never surface
 * backend text.
 */
import { HttpError } from "@/api/http-client";

export const FOLDER_BROWSER_ERROR_KEYS = {
  forbidden: "desktop.folderBrowserErrorForbidden",
  notFound: "desktop.folderBrowserErrorNotFound",
  unavailable: "desktop.folderBrowserErrorUnavailable",
} as const;

export type FolderBrowserErrorKind = keyof typeof FOLDER_BROWSER_ERROR_KEYS;

const ENGLISH_COPY: Readonly<Record<FolderBrowserErrorKind, string>> = {
  forbidden: "That folder isn't available to Pix.",
  notFound: "That folder no longer exists.",
  unavailable: "Couldn't load folders. Check the server connection and try again.",
};

/** Code-first classification. Backend message text is never inspected. */
export function folderBrowserErrorKind(error: unknown): FolderBrowserErrorKind {
  if (error instanceof HttpError) {
    switch (error.code) {
      case "PATH_FORBIDDEN":
      case "ROOT_REPLACED":
        return "forbidden";
      case "PATH_NOT_FOUND":
      case "NOT_DIRECTORY":
        return "notFound";
      default:
        break;
    }
    if (error.kind === "network" || error.kind === "timeout" || error.kind === "decode") {
      return "unavailable";
    }
  }
  return "unavailable";
}

/** Fixed, user-facing copy. Optional translate maps the same en/zh-CN keys. */
export function describeFolderBrowserError(
  error: unknown,
  translate?: (key: string) => string,
): string {
  const kind = folderBrowserErrorKind(error);
  if (translate) {
    const translated = translate(FOLDER_BROWSER_ERROR_KEYS[kind]);
    if (translated.length > 0) return translated;
  }
  return ENGLISH_COPY[kind];
}
