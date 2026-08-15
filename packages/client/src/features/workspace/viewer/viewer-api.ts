import type { HttpClient } from "@/api/http-client";
import { urls } from "@/api/urls";
import { FileMetaResponseSchema, FileTextResponseSchema, GitDiffResponseSchema } from "@/api/schemas";
import { openFileWatch, type FileWatchSource } from "@/api/files-watch";
import type { GitFileDiffResponse } from "@/lib/git-types";

/**
 * pix API adapter for the file viewer (source DOM/state machine unchanged).
 *
 * The source built legacy files-route URLs and fetched with bare fetch; pix
 * builds /v1/files?path=&op=… URLs through the shared URL builder and reads
 * through the shared HttpClient with schema validation. DOCX preview uses
 * the Host's dedicated op=docx-preview (sandboxed HTML).
 */

/** Text file read result (GET /v1/files?op=read). */
export interface ViewerFileData {
  content: string;
  language: string;
  size: number;
}

/** Build a files URL exactly like the source `getFileApiUrl` helper. */
export function getFileApiUrl(
  filePath: string,
  type: "read" | "download" | "meta" | "docx-preview" | "watch",
  sourceSessionId?: string | null,
  params: Record<string, string | number | undefined> = {},
): string {
  return urls.files.file(filePath, type, { sessionId: sourceSessionId, params });
}

/** Open the watch stream for a file (transport seam; see @/api/files-watch). */
export function watchFile(filePath: string, sourceSessionId?: string | null): FileWatchSource {
  return openFileWatch(getFileApiUrl(filePath, "watch", sourceSessionId));
}

/** Read a text file. Throws HttpError with the Host's sanitized message. */
export async function fetchFileContent(
  http: HttpClient,
  filePath: string,
  sourceSessionId?: string | null,
): Promise<ViewerFileData> {
  return http.get(getFileApiUrl(filePath, "read", sourceSessionId), { schema: FileTextResponseSchema });
}

/** Read file metadata (GET /v1/files?op=meta). */
export async function fetchFileMeta(
  http: HttpClient,
  filePath: string,
  sourceSessionId?: string | null,
): Promise<{ path: string; size: number; modified: string; isDirectory: boolean; mime: string | null }> {
  return http.get(getFileApiUrl(filePath, "meta", sourceSessionId), { schema: FileMetaResponseSchema });
}

/** Per-file git diff (GET /v1/git/diff?cwd=&path=). */
export async function fetchGitFileDiff(
  http: HttpClient,
  cwd: string,
  filePath: string,
): Promise<GitFileDiffResponse> {
  const result = await http.get(urls.git.diff(cwd, filePath), { schema: GitDiffResponseSchema });
  if (result.supported) {
    return { supported: true, status: result.status as GitFileDiffResponse["status"], patch: result.patch };
  }
  return { supported: false };
}
