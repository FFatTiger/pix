/**
 * File watch seam (GET /v1/files?path=&op=watch).
 *
 * The file viewer keeps the source watch wiring verbatim — one watch source
 * per open file, `change` events driving content/diff refresh, closed on
 * unmount. The concrete transport is injected here instead of constructed in
 * the component so the client boundary (which currently forbids the SSE
 * constructor surface) and the pending Host endpoint stay explicit:
 *
 *  - `openFileWatch(url)` is the single construction point. Until the Host
 *    `op=watch` endpoint lands, it returns an inert source that never fires
 *    and closes cleanly, so viewers render their initial fetch and simply do
 *    not live-refresh.
 *  - When the endpoint is ready, this module swaps the inert default for the
 *    browser SSE implementation (same-origin, `change` message events whose
 *    JSON payloads parse as `FileWatchChangeSchema`). No component changes.
 */

/** Minimal `MessageEvent`-like shape the viewers listen for. */
export interface FileWatchEvent {
  readonly data?: string;
}

/** Watch source surface consumed by the file viewers. */
export interface FileWatchSource {
  addEventListener(type: "change", listener: (event: FileWatchEvent) => void): void;
  close(): void;
}

/** URL → watch source factory (transport-injectable). */
export type FileWatchFactory = (url: string) => FileWatchSource;

function createInertFileWatchSource(): FileWatchSource {
  return {
    addEventListener() {
      // Inert: no Host watch endpoint yet, so nothing ever fires.
    },
    close() {
      // Inert: nothing was opened.
    },
  };
}

/**
 * Open a file watch stream. Current default is inert (Host endpoint pending);
 * the integration layer may override the factory without touching viewers.
 */
export function openFileWatch(url: string): FileWatchSource {
  return fileWatchFactory(url);
}

/** Current factory — inert until the Host watch endpoint lands. */
let fileWatchFactory: FileWatchFactory = createInertFileWatchSource;

/** Replace the watch transport (integration seam, e.g. when the Host lands). */
export function setFileWatchFactory(factory: FileWatchFactory): void {
  fileWatchFactory = factory;
}
