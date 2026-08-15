/**
 * File watch transport for the existing GET /v1/files/watch?path= SSE route.
 *
 * Client boundaries intentionally forbid direct browser SSE constructors, so
 * this API-layer adapter consumes the same-origin event stream with fetch and
 * exposes only the tiny source interface used by FileViewer. Host errors and
 * payloads are never rendered; a failed stream simply stops live refresh.
 */

/** Minimal MessageEvent-like shape consumed by file viewers. */
export interface FileWatchEvent {
  readonly data?: string;
}

/** Watch source surface consumed by file viewers. */
export interface FileWatchSource {
  addEventListener(type: "change", listener: (event: FileWatchEvent) => void): void;
  close(): void;
}

/** URL → watch source factory, injectable for deterministic integration tests. */
export type FileWatchFactory = (url: string) => FileWatchSource;

function parseEventBlock(block: string): { event: string; data: string } | null {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  return data.length > 0 ? { event, data: data.join("\n") } : null;
}

function createFetchFileWatchSource(url: string): FileWatchSource {
  const controller = new AbortController();
  const listeners = new Set<(event: FileWatchEvent) => void>();

  void (async () => {
    try {
      const response = await fetch(url, {
        headers: { Accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) return;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (!controller.signal.aborted) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done }).replace(/\r\n?/g, "\n");

        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const parsed = parseEventBlock(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          if (parsed?.event === "change") {
            for (const listener of listeners) listener({ data: parsed.data });
          }
          boundary = buffer.indexOf("\n\n");
        }

        if (done) break;
      }
    } catch {
      // Abort, network failure, gate expiry, and malformed streams all degrade
      // to a static viewer. Fixed UI error handling remains outside this seam.
    }
  })();

  return {
    addEventListener(_type, listener) {
      listeners.add(listener);
    },
    close() {
      listeners.clear();
      controller.abort();
    },
  };
}

let fileWatchFactory: FileWatchFactory = createFetchFileWatchSource;

/** Open a same-origin watch stream for one authorized file. */
export function openFileWatch(url: string): FileWatchSource {
  return fileWatchFactory(url);
}

/** Replace the transport for deterministic tests or an alternate host bridge. */
export function setFileWatchFactory(factory: FileWatchFactory): void {
  fileWatchFactory = factory;
}
