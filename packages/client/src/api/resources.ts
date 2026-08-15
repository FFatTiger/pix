import type { HttpClient } from "./http-client";
import { urls } from "./urls";
import {
  CwdBrowseResponseSchema,
  CwdDefaultResponseSchema,
  CwdRootsResponseSchema,
  CwdValidateResponseSchema,
  FileIndexResponseSchema,
  FileListResponseSchema,
  FileMetaResponseSchema,
  FileTextResponseSchema,
  GitDiffResponseSchema,
  GitStatusResponseSchema,
  UploadCheckResponseSchema,
  UploadResponseSchema,
  WorktreeCreateResponseSchema,
  WorktreeDeleteResponseSchema,
  WorktreeListResponseSchema,
} from "./schemas";

export interface UploadInput {
  directory: string;
  files: readonly File[];
  conflict?: "error" | "overwrite" | "skip";
}

export function createResourcesApi(http: HttpClient) {
  return {
    files: {
      list: (path: string, signal?: AbortSignal) => http.get(urls.files.resource(path, "list"), { schema: FileListResponseSchema, ...(signal === undefined ? {} : { signal }) }),
      meta: (path: string, signal?: AbortSignal) => http.get(urls.files.resource(path, "meta"), { schema: FileMetaResponseSchema, ...(signal === undefined ? {} : { signal }) }),
      read: (path: string, signal?: AbortSignal) => http.get(urls.files.resource(path, "read"), { schema: FileTextResponseSchema, ...(signal === undefined ? {} : { signal }) }),
      preview: (path: string, signal?: AbortSignal) => http.get<Blob>(urls.files.resource(path, "preview"), { responseMode: "blob", ...(signal === undefined ? {} : { signal }) }),
      download: (path: string, range?: string, signal?: AbortSignal) => http.get<Response>(urls.files.resource(path, "download"), { responseMode: "response", ...(range === undefined ? {} : { headers: { Range: range } }), ...(signal === undefined ? {} : { signal }) }),
      upload: (input: UploadInput, signal?: AbortSignal) => {
        const data = new FormData();
        for (const file of input.files) data.append("files", file, file.name);
        return http.raw(urls.files.upload(input.directory, input.conflict), data, { method: "POST", schema: UploadResponseSchema, ...(signal === undefined ? {} : { signal }) });
      },
      /**
       * POST /v1/files?path=&op=upload-check — conflict preflight. Host
       * endpoint pending; the resource seam is frozen to the source contract
       * (`conflicts` + `nonReplaceable`) so the endpoint can land as-is.
       */
      uploadCheck: (path: string, fileNames: string[], signal?: AbortSignal) =>
        http.post(urls.files.uploadCheck(path), { fileNames }, { schema: UploadCheckResponseSchema, ...(signal === undefined ? {} : { signal }) }),
      index: (cwd: string, q?: string, signal?: AbortSignal) => http.get(urls.files.index(cwd, q), { schema: FileIndexResponseSchema, ...(signal === undefined ? {} : { signal }) }),
    },
    git: {
      status: (cwd: string, signal?: AbortSignal) => http.get(urls.git.status(cwd), { schema: GitStatusResponseSchema, ...(signal === undefined ? {} : { signal }) }),
      diff: (cwd: string, path: string, signal?: AbortSignal) => http.get(urls.git.diff(cwd, path), { schema: GitDiffResponseSchema, ...(signal === undefined ? {} : { signal }) }),
    },
    cwd: {
      validate: (cwd: string, signal?: AbortSignal) => http.post(urls.cwd.validate(), { cwd }, { schema: CwdValidateResponseSchema, ...(signal === undefined ? {} : { signal }) }),
      browse: (path?: string, signal?: AbortSignal) => http.get(urls.cwd.browse(path), { schema: CwdBrowseResponseSchema, ...(signal === undefined ? {} : { signal }) }),
      roots: (signal?: AbortSignal) => http.get(urls.cwd.roots(), { schema: CwdRootsResponseSchema, ...(signal === undefined ? {} : { signal }) }),
      createDefault: (signal?: AbortSignal) => http.post(urls.cwd.default(), {}, { schema: CwdDefaultResponseSchema, ...(signal === undefined ? {} : { signal }) }),
    },
    worktrees: {
      list: (cwd: string, signal?: AbortSignal) => http.get(urls.worktrees.list(cwd), { schema: WorktreeListResponseSchema, ...(signal === undefined ? {} : { signal }) }),
      create: (input: { cwd: string; branch: string }, signal?: AbortSignal) => http.post(urls.worktrees.mutate(), input, { schema: WorktreeCreateResponseSchema, ...(signal === undefined ? {} : { signal }) }),
      // Dormant mutation helper (no WorktreePanel controls import it): parses
      // the managed delete contract (fallbackCwd + branchRetained).
      remove: (input: { cwd: string; path: string; force?: boolean }, signal?: AbortSignal) => http.delete(urls.worktrees.mutate(), input, { schema: WorktreeDeleteResponseSchema, ...(signal === undefined ? {} : { signal }) }),
    },
  };
}
export type ResourcesApi = ReturnType<typeof createResourcesApi>;
