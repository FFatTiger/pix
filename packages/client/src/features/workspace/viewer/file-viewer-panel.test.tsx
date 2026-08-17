import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, act, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HttpClientProvider } from "@/app/http-context";
import { I18nProvider } from "@/hooks/useI18n";
import { FileViewerPanel, type FileViewerPanelHandle } from "./FileViewerPanel";
import { setWatchSessionFactory, type WatchConnectionState, type WatchSession } from "@/api/files-watch";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

/** Controllable fake watch session; the test drives change/resync/state events. */
function fakeWatchSession() {
  const change = new Set<(event: { data?: string }) => void>();
  const resync = new Set<() => void>();
  const stateListeners = new Set<(state: WatchConnectionState) => void>();
  let state: WatchConnectionState = "connected";
  let lastError: string | undefined;
  const session: WatchSession = {
    get state() { return state; },
    get lastError() { return lastError; },
    addEventListener(type, listener) {
      if (type === "change") {
        const l = listener as (event: { data?: string }) => void;
        change.add(l);
        return () => change.delete(l);
      }
      if (type === "resync") {
        const l = listener as () => void;
        resync.add(l);
        return () => resync.delete(l);
      }
      const l = listener as (state: WatchConnectionState) => void;
      stateListeners.add(l);
      return () => stateListeners.delete(l);
    },
    close() {
      state = "closed";
      change.clear();
      resync.clear();
      stateListeners.clear();
    },
  };
  return {
    session,
    emitChange(data?: string) { for (const l of [...change]) l(data === undefined ? {} : { data }); },
    emitResync() { for (const l of [...resync]) l(); },
    emitState(next: WatchConnectionState, error?: string) {
      state = next;
      if (error !== undefined) lastError = error;
      for (const l of [...stateListeners]) l(next);
    },
  };
}

function mount(qc: QueryClient, node: React.ReactNode) {
  return render(
    <QueryClientProvider client={qc}>
      <HttpClientProvider>
        <I18nProvider>{node}</I18nProvider>
      </HttpClientProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("FileViewerPanel — workspace-owned tabs", () => {
  it("clears all tabs when the workspace cwd changes", async () => {
    const harness = fakeWatchSession();
    setWatchSessionFactory(() => harness.session);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("op=read")) return json({ content: "AAAA", language: "text", size: 4 });
      if (url.includes("/v1/git/diff")) return json({ supported: false });
      return json({ error: "not found" }, 404);
    }) as unknown as typeof fetch);

    const ref = createRef<FileViewerPanelHandle>();
    const { rerender } = mount(qc, <FileViewerPanel ref={ref} cwd="/repoA" />);

    act(() => { ref.current?.openFile("/repoA/a.ts", "a.ts"); });
    await screen.findByText("AAAA");
    // The tab label renders (in the TabBar and the viewer status bar).
    expect(screen.getAllByText("a.ts").length).toBeGreaterThan(0);

    // Switching the workspace must not reinterpret old tabs under the new cwd.
    rerender(
      <QueryClientProvider client={qc}>
        <HttpClientProvider>
          <I18nProvider><FileViewerPanel ref={ref} cwd="/repoB" /></I18nProvider>
        </HttpClientProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.queryByText("a.ts")).toBeNull());
    expect(screen.queryByText("AAAA")).toBeNull();
  });
});

describe("FileViewer — out-of-order watch settles", () => {
  it("never lets a stale read settle overwrite the newest content", async () => {
    const harness = fakeWatchSession();
    setWatchSessionFactory(() => harness.session);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const reads: Array<ReturnType<typeof deferred<Response>>> = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("op=read")) {
        const d = deferred<Response>();
        reads.push(d);
        return d.promise;
      }
      if (url.includes("/v1/git/diff")) return Promise.resolve(json({ supported: false }));
      return Promise.resolve(json({ error: "not found" }, 404));
    }) as unknown as typeof fetch);

    const ref = createRef<FileViewerPanelHandle>();
    mount(qc, <FileViewerPanel ref={ref} cwd="/repo" />);
    act(() => { ref.current?.openFile("/repo/a.ts", "a.ts"); });

    // Initial read settles with A.
    await waitFor(() => expect(reads.length).toBe(1));
    await act(async () => { reads[0]!.resolve(json({ content: "AAAA", language: "text", size: 4 })); });
    await screen.findByText("AAAA");

    // Change 1 starts a refetch (B); change 2 starts a refetch (C) which
    // aborts the in-flight B.
    await act(async () => { harness.emitChange("{\"modified\":1}"); });
    await waitFor(() => expect(reads.length).toBe(2));
    await act(async () => { harness.emitChange("{\"modified\":2}"); });
    await waitFor(() => expect(reads.length).toBe(3));

    // The NEWEST settle (C) lands first…
    await act(async () => { reads[2]!.resolve(json({ content: "CCCC", language: "text", size: 4 })); });
    await screen.findByText("CCCC");

    // …then the stale (B) settles late and must be ignored.
    await act(async () => { reads[1]!.resolve(json({ content: "BBBB", language: "text", size: 4 })); });
    await waitFor(() => expect(screen.queryByText("BBBB")).toBeNull());
    expect(screen.getByText("CCCC")).toBeTruthy();

    // The live-diff snapshot is against the previously SHOWN content (A→C),
    // never the stale B: the diff toggle is present with the change count.
    await waitFor(() => expect(screen.getByText(/\+1/)).toBeTruthy());
  });

  it("surfaces a read failure as a typed error with a retry action", async () => {
    const harness = fakeWatchSession();
    setWatchSessionFactory(() => harness.session);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    let fail = true;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("op=read")) {
        if (fail) return json({ error: "File not found", code: "PATH_NOT_FOUND" }, 404);
        return json({ content: "AAAA", language: "text", size: 4 });
      }
      if (url.includes("/v1/git/diff")) return json({ supported: false });
      return json({ error: "not found" }, 404);
    }) as unknown as typeof fetch);

    const ref = createRef<FileViewerPanelHandle>();
    mount(qc, <FileViewerPanel ref={ref} cwd="/repo" />);
    act(() => { ref.current?.openFile("/repo/a.ts", "a.ts"); });

    // Honest error: the Host's message is shown (not swallowed)…
    await screen.findByText(/File not found/);
    // …with a retry action that recovers.
    fail = false;
    await act(async () => {
      const retry = screen.getByRole("button", { name: "Retry" });
      retry.click();
    });
    await screen.findByText("AAAA");
  });

  it("surfaces a non-blocking watch status when the stream degrades", async () => {
    const harness = fakeWatchSession();
    setWatchSessionFactory(() => harness.session);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("op=read")) return json({ content: "AAAA", language: "text", size: 4 });
      if (url.includes("/v1/git/diff")) return json({ supported: false });
      return json({ error: "not found" }, 404);
    }) as unknown as typeof fetch);

    const ref = createRef<FileViewerPanelHandle>();
    mount(qc, <FileViewerPanel ref={ref} cwd="/repo" />);
    act(() => { ref.current?.openFile("/repo/a.ts", "a.ts"); });
    await screen.findByText("AAAA");
    expect(screen.queryByText(/Reconnecting/)).toBeNull();

    // Stream drops → the viewer surfaces a typed, non-blocking reconnecting
    // status while the already-loaded content stays visible (no toast).
    act(() => { harness.emitState("reconnecting", "Watch stream ended"); });
    expect(screen.getByText(/Reconnecting/)).toBeTruthy();
    expect(screen.getByText("AAAA")).toBeTruthy();

    // Budget exhausted → a distinct closed surface, still non-blocking.
    act(() => { harness.emitState("closed", "Watch stream ended"); });
    expect(screen.getByText(/Watch disconnected/)).toBeTruthy();
    expect(screen.getByText("AAAA")).toBeTruthy();
  });
});
