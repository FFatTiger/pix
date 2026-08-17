import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HttpClientProvider } from "@/app/http-context";
import { I18nProvider } from "@/hooks/useI18n";
import { ContextMenuProvider } from "@/components/ContextMenu";
import { FileExplorer } from "./FileExplorer";
import { QuickChangesPanel } from "./QuickChangesPanel";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const GIT_STATUS = {
  isGitRepository: true,
  repositoryRoot: "/repo",
  files: [{ filePath: "/repo/a.ts", status: "modified", code: "M", indexStatus: "M", worktreeStatus: " " }],
  additions: 1,
  deletions: 0,
};

function mount(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <HttpClientProvider>
        <I18nProvider>
          <ContextMenuProvider>{node}</ContextMenuProvider>
        </I18nProvider>
      </HttpClientProvider>
    </QueryClientProvider>,
  );
  return qc;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("shared git request ownership", () => {
  it("FileExplorer and QuickChangesPanel share ONE git.status(cwd) request", async () => {
    let gitStatusCalls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/git/status")) {
        gitStatusCalls += 1;
        return json(GIT_STATUS);
      }
      if (url.includes("op=list")) {
        return json({ path: "/repo", entries: [{ name: "a.ts", isDir: false, isSymlink: false }] });
      }
      return json({ error: "not found" }, 404);
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchImpl);

    // Both surfaces mounted under one QueryClient: they must consume the SAME
    // queryKeys.git.status("/repo") query, so exactly one request hits the wire.
    mount(
      <>
        <FileExplorer cwd="/repo" onOpenFile={() => undefined} />
        <QuickChangesPanel cwd="/repo" onOpenFile={() => undefined} />
      </>,
    );

    await waitFor(() => expect(gitStatusCalls).toBe(1));
    expect(gitStatusCalls).toBe(1);
  });

  it("surfaces a git status failure as an error row (never a silent null)", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/git/status")) return json({ error: "git exploded", code: "GIT_FAILED" }, 500);
      if (url.includes("op=list")) return json({ path: "/repo", entries: [] });
      return json({ error: "not found" }, 404);
    }) as unknown as typeof fetch);

    mount(<QuickChangesPanel cwd="/repo" onOpenFile={() => undefined} />);
    // The panel must render an honest failure surface instead of collapsing
    // into "no changes".
    await screen.findByText(/Could not load git status/);
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
