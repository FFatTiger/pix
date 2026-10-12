import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HttpClientProvider } from "@/app/http-context";
import { I18nProvider } from "@/hooks/useI18n";
import { ContextMenuProvider } from "@/components/ContextMenu";
import { FileExplorer } from "./FileExplorer";

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
  it("FileExplorer decorates rows from the one shared git.status(cwd) query", async () => {
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

    mount(<FileExplorer cwd="/repo" onOpenFile={() => undefined} />);

    await waitFor(() => {
      expect(document.querySelector("span[title='/repo/a.ts']")).toBeTruthy();
    });
    // The modified file is decorated from the shared query data …
    await waitFor(() => {
      const nameSpan = document.querySelector("span[title='/repo/a.ts']") as HTMLElement;
      expect(nameSpan.style.color).toContain("var(--git-status-modified)");
    });
    // … and exactly one git.status request hit the wire.
    await waitFor(() => expect(gitStatusCalls).toBe(1));
    expect(gitStatusCalls).toBe(1);
  });

  it("keeps the explorer honest and alive when git status fails (decorations drop, files keep listing)", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/git/status")) return json({ error: "git exploded", code: "GIT_FAILED" }, 500);
      if (url.includes("op=list")) {
        return json({ path: "/repo", entries: [{ name: "a.ts", isDir: false, isSymlink: false }] });
      }
      return json({ error: "not found" }, 404);
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchImpl);

    mount(<FileExplorer cwd="/repo" onOpenFile={() => undefined} />);

    // The tree still lists files — the git failure never fakes decorations or
    // takes the explorer down.
    await waitFor(() => {
      expect(document.querySelector("span[title='/repo/a.ts']")).toBeTruthy();
    });
    await waitFor(() => {
      const nameSpan = document.querySelector("span[title='/repo/a.ts']") as HTMLElement;
      expect(nameSpan.style.color).not.toContain("git-status-");
    });
  });
});
