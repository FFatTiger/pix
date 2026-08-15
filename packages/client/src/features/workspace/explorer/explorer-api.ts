import { HttpError, type HttpClient } from "@/api/http-client";
import { urls } from "@/api/urls";
import {
  FileListResponseSchema,
  GitStatusResponseSchema,
  UploadCheckResponseSchema,
} from "@/api/schemas";
import { joinFilePath } from "@/lib/file-paths";
import type { GitFileStatus, GitFileStatusKind, GitStatusResponse } from "@/lib/git-types";

/**
 * pix API adapter for the file explorer (source DOM/state machine unchanged).
 *
 * The source components called the legacy files/git routes directly; pix
 * routes every request through the shared HttpClient against /v1 URLs with
 * schema validation. Fixed error copy and capability gating stay with the
 * outer composition layer.
 */

/** Source upload contract (conflict preflight + batch result envelope). */
export interface ExplorerUploadResponse {
  uploaded?: string[];
  skipped?: string[];
  errors?: Array<{ name: string; error: string }>;
  conflicts?: string[];
  nonReplaceable?: string[];
  error?: string;
}

/** Source tree node shape consumed by FileExplorer's lazy TreeNode. */
export interface ExplorerFileNode {
  name: string;
  fullPath: string;
  isDir: boolean;
  size: number;
  children?: ExplorerFileNode[] | undefined;
  loaded?: boolean;
}

/** List a directory via GET /v1/files?op=list, mapped onto the tree shape. */
export async function fetchExplorerEntries(http: HttpClient, dirPath: string): Promise<ExplorerFileNode[]> {
  const data = await http.get(urls.files.resource(dirPath, "list"), { schema: FileListResponseSchema });
  return data.entries.map((entry) => ({
    name: entry.name,
    fullPath: joinFilePath(dirPath, entry.name),
    isDir: entry.isDir,
    size: 0,
    children: entry.isDir ? [] : undefined,
    loaded: !entry.isDir,
  }));
}

/**
 * Git status via GET /v1/git/status?cwd=. pix does not surface ignored paths
 * (yet), so `ignoredPaths` is an empty list — the tree's dimming of ignored
 * entries simply never triggers instead of guessing client-side.
 */
export async function fetchExplorerGitStatus(http: HttpClient, cwd: string): Promise<GitStatusResponse> {
  const data = await http.get(urls.git.status(cwd), { schema: GitStatusResponseSchema });
  return {
    isGitRepository: data.isGitRepository,
    repositoryRoot: data.repositoryRoot,
    files: data.files.map((file): GitFileStatus => ({ ...file, status: file.status as GitFileStatusKind, code: file.code as GitFileStatus["code"] })),
    additions: data.additions,
    deletions: data.deletions,
    ignoredPaths: [],
  };
}

/**
 * Upload conflict preflight.
 *
 * Contract endpoint: POST /v1/files?path=&op=upload-check returning
 * `{ conflicts, nonReplaceable }` (Host endpoint pending). Until it lands,
 * the pix POST /v1/files route answers the JSON preflight with its multipart
 * guard (415 UNSUPPORTED_MEDIA_TYPE) or an operation error — those exact
 * failures fall back to a client-side preflight against the landed
 * `op=list` of the target directory, so the source conflict card keeps
 * working against today's Host surface. Any other error propagates.
 */
export async function checkExplorerUploadConflicts(
  http: HttpClient,
  directory: string,
  fileNames: string[],
): Promise<ExplorerUploadResponse> {
  try {
    return await http.post(urls.files.uploadCheck(directory), { fileNames }, { schema: UploadCheckResponseSchema });
  } catch (error) {
    if (error instanceof HttpError && uploadCheckPending(error)) {
      const listed = await http.get(urls.files.resource(directory, "list"), { schema: FileListResponseSchema });
      const existing = new Set(listed.entries.filter((entry) => !entry.isDir).map((entry) => entry.name));
      return { conflicts: fileNames.filter((name) => existing.has(name)), nonReplaceable: [] };
    }
    throw error;
  }
}

function uploadCheckPending(error: HttpError): boolean {
  if (error.status === 404 || error.status === 405 || error.status === 415 || error.status === 501) return true;
  return error.code === "UNSUPPORTED_MEDIA_TYPE" || error.code === "INVALID_OPERATION" || error.code === "INVALID_ROUTE";
}
