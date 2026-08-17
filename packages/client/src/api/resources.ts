import { HttpError } from "./http-client";
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

/** Upload progress snapshot reported by the progress-capable transport. */
export interface UploadProgress {
  loaded: number;
  total: number;
  percent: number;
}

export type UploadResponse = import("zod").infer<typeof UploadResponseSchema>;

/**
 * Typed 409 conflict surface for uploads. The Host answers a
 * `conflict=error` batch with FILE_EXISTS plus the two per-name lists; the
 * upload state machine needs them to render the replace/skip card, so they
 * ride on a typed error instead of being re-inferred from a raw body.
 */
export class UploadConflictError extends Error {
  readonly status = 409;
  readonly code = "FILE_EXISTS";
  readonly conflicts: string[];
  readonly nonReplaceable: string[];

  constructor(message: string, conflicts: string[], nonReplaceable: string[]) {
    super(message);
    this.name = "UploadConflictError";
    this.conflicts = conflicts;
    this.nonReplaceable = nonReplaceable;
  }
}

function extractStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function describeUploadFailure(status: number, body: unknown): string {
  if (body && typeof body === "object") {
    const record = body as { message?: unknown; error?: unknown };
    if (typeof record.message === "string" && record.message.trim()) return record.message;
    if (typeof record.error === "string" && record.error.trim()) return record.error;
  }
  if (typeof body === "string" && body.trim()) return body;
  return `Upload failed (HTTP ${status})`;
}

/**
 * Progress-capable upload transport (XHR, same-origin /v1). Fetch cannot
 * report upload progress, so this transport uses XHR and validates the
 * response with the same strict schema as the HttpClient path. Non-2xx
 * responses throw HttpError; a 409 FILE_EXISTS throws UploadConflictError with
 * the per-name conflict lists. Aborting `signal` cancels the XHR.
 */
function uploadWithProgress(
  input: UploadInput,
  onProgress: (progress: UploadProgress) => void,
  signal?: AbortSignal,
): Promise<UploadResponse> {
  return new Promise((resolve, reject) => {
    const url = urls.files.upload(input.directory, input.conflict);
    const formData = new FormData();
    for (const file of input.files) formData.append("files", file, file.name);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress({ loaded: event.loaded, total: event.total, percent: Math.round((event.loaded / event.total) * 100) });
      }
    };
    const onAbort = () => xhr.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    xhr.onerror = () => {
      signal?.removeEventListener("abort", onAbort);
      reject(new HttpError({ kind: "network", path: url, code: "NETWORK_ERROR", message: "Network error while uploading files" }));
    };
    xhr.onabort = () => {
      signal?.removeEventListener("abort", onAbort);
      reject(new HttpError({ kind: "aborted", path: url, code: "ABORTED", message: "Upload cancelled" }));
    };
    xhr.onload = () => {
      signal?.removeEventListener("abort", onAbort);
      let body: unknown;
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) as unknown : undefined;
      } catch {
        body = xhr.responseText;
      }
      if ((xhr.status >= 200 && xhr.status < 300) || xhr.status === 207) {
        const parsed = UploadResponseSchema.safeParse(body);
        if (parsed.success) {
          resolve(parsed.data);
          return;
        }
        reject(new HttpError({ kind: "decode", status: xhr.status, path: url, code: "INVALID_RESPONSE", message: "Host response did not match the expected schema", body }));
        return;
      }
      if (xhr.status === 409) {
        reject(new UploadConflictError(
          "One or more files already exist",
          extractStringArray((body as { conflicts?: unknown })?.conflicts),
          extractStringArray((body as { nonReplaceable?: unknown })?.nonReplaceable),
        ));
        return;
      }
      reject(new HttpError({ status: xhr.status, path: url, message: describeUploadFailure(xhr.status, body), body }));
    };
    xhr.send(formData);
  });
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
       * Progress-capable upload transport for the file workspace state machine
       * (see uploadWithProgress). The mutation seam (mutations.ts) uses the
       * plain `upload`; this typed XHR path only carries progress + the typed
       * conflict surface for the replace/skip card.
       */
      uploadWithProgress,
      /**
       * POST /v1/files?path=&op=upload-check — conflict preflight. Live on the
       * Host; returns `{ conflicts, nonReplaceable }`.
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
