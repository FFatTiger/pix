import { urls } from "@/api/urls";
import { openWatchSession, type WatchSession } from "@/api/files-watch";

/**
 * pix API adapter for the file viewer.
 *
 * The viewer's reads/meta/diff are owned by React Query (see
 * createQueryOptions in query-keys.ts) so FileExplorer/QuickChanges/Viewer
 * share one remote-state authority. This seam only keeps the two transport
 * pieces that do not belong to a query: URL building for element src/href and
 * the per-file watch session (files-watch.ts).
 */

/** Build a files URL exactly like the source `getFileApiUrl` helper. */
export function getFileApiUrl(
  filePath: string,
  type: "read" | "download" | "meta" | "docx-preview",
  sourceSessionId?: string | null,
  params: Record<string, string | number | undefined> = {},
): string {
  return urls.files.file(filePath, type, { sessionId: sourceSessionId, params });
}

/**
 * Open the Host SSE watch session for a file. A session has explicit
 * connection state, bounded reconnect/backoff, and emits `resync` after every
 * (re)connect so the consumer can refetch content/diff authoritatively.
 */
export function watchFile(filePath: string, _sourceSessionId?: string | null): WatchSession {
  return openWatchSession(urls.files.watch(filePath));
}
