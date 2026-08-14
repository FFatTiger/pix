import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostCapability, HostInfo } from "@fffattiger/pix-protocol";
import { HttpClientProvider } from "@/app/http-context";
import { CapabilityProvider } from "@/features/capability/CapabilityProvider";
import { WorkspacePanel } from "./WorkspacePanel";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function renderPanel(
  host: Partial<HostInfo>,
  props: { cwd?: string; open?: boolean } = {},
  onClose: () => void = () => undefined,
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <HttpClientProvider>
        <CapabilityProvider host={host}>{children}</CapabilityProvider>
      </HttpClientProvider>
    </QueryClientProvider>
  );
  return render(
    <WorkspacePanel cwd={props.cwd} open={props.open ?? true} onClose={onClose} />,
    { wrapper: Wrapper },
  );
}

/** A fetch router keyed by op/pathname so tests assert exact endpoint behavior. */
function makeRouter() {
  const calls: { pathname: string; params: Record<string, string> }[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://pix.local");
    const params = Object.fromEntries(url.searchParams.entries());
    calls.push({ pathname: url.pathname, params });
    if (url.pathname === "/v1/files" && params.op === "list") {
      return json({
        path: params.path,
        entries: [
          { name: "src", isDir: true, isSymlink: false },
          { name: "a.ts", isDir: false, isSymlink: false },
        ],
      });
    }
    if (url.pathname === "/v1/files" && params.op === "meta") {
      return json({
        path: params.path,
        size: 12,
        modified: "2026-01-01T00:00:00.000Z",
        isDirectory: false,
        mime: "text/plain",
      });
    }
    if (url.pathname === "/v1/files" && params.op === "read") {
      return json({ content: "hello world", language: "typescript", size: 11 });
    }
    if (url.pathname === "/v1/git/status") {
      return json({
        isGitRepository: true,
        repositoryRoot: params.cwd,
        files: [],
        additions: 0,
        deletions: 0,
      });
    }
    if (url.pathname === "/v1/worktrees") {
      return json({
        projectRoot: params.cwd,
        isGit: true,
        isTopLevel: true,
        worktrees: [
          { path: params.cwd, branch: "workspace-main", isMain: true, authorized: true, managedByPix: true },
        ],
      });
    }
    return json({});
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("WorkspacePanel", () => {
  let previous: typeof fetch;
  beforeEach(() => {
    previous = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = previous;
  });

  it("issues ZERO api requests when no workspace capability is negotiated", () => {
    const { impl } = makeRouter();
    globalThis.fetch = impl;
    const { container } = renderPanel({ mode: "local", capabilities: [] }, { cwd: "/proj" });
    expect(container.firstChild).toBeNull();
    expect(impl).not.toHaveBeenCalled();
  });

  it("offers only the Files tab when only files is negotiated", async () => {
    const { impl } = makeRouter();
    globalThis.fetch = impl;
    renderPanel({ mode: "local", capabilities: ["files"] }, { cwd: "/proj" });
    expect(screen.getByRole("tab", { name: "Files" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Git" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Worktrees" })).toBeNull();
    await waitFor(() => expect(screen.getByText("a.ts")).toBeTruthy());
  });

  it("offers only the Git tab when only git is negotiated", async () => {
    const { impl } = makeRouter();
    globalThis.fetch = impl;
    renderPanel({ mode: "local", capabilities: ["git"] }, { cwd: "/proj" });
    expect(screen.queryByRole("tab", { name: "Files" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Git" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Worktrees" })).toBeNull();
    await waitFor(() => expect(screen.getByText(/clean/i)).toBeTruthy());
  });

  it("defaults to Worktrees when only worktree is negotiated", async () => {
    const { impl, calls } = makeRouter();
    globalThis.fetch = impl;
    renderPanel({ mode: "local", capabilities: ["worktree"] }, { cwd: "/proj" });
    expect(screen.queryByRole("tab", { name: "Files" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Git" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Worktrees" })).toBeTruthy();
    await waitFor(() => expect(screen.getByText("workspace-main")).toBeTruthy());
    expect(calls.filter((c) => c.pathname === "/v1/worktrees")).toHaveLength(1);
    expect(calls.filter((c) => c.pathname === "/v1/files")).toHaveLength(0);
    expect(calls.filter((c) => c.pathname === "/v1/git/status")).toHaveLength(0);
  });

  it("switches Files/Git/Worktrees and only mounts the active tab", async () => {
    const { impl, calls } = makeRouter();
    globalThis.fetch = impl;
    renderPanel({ mode: "local", capabilities: ["files", "git", "worktree"] }, { cwd: "/proj" });
    await waitFor(() => expect(screen.getByText("a.ts")).toBeTruthy());
    const filesBefore = calls.filter((c) => c.pathname === "/v1/files").length;
    expect(calls.filter((c) => c.pathname === "/v1/git/status")).toHaveLength(0);
    expect(calls.filter((c) => c.pathname === "/v1/worktrees")).toHaveLength(0);

    fireEvent.click(screen.getByRole("tab", { name: "Git" }));
    await waitFor(() => expect(screen.getByText(/clean/i)).toBeTruthy());
    expect(screen.queryByText("a.ts")).toBeNull();
    expect(calls.filter((c) => c.pathname === "/v1/git/status")).toHaveLength(1);

    fireEvent.click(screen.getByRole("tab", { name: "Worktrees" }));
    await waitFor(() => expect(screen.getByText("workspace-main")).toBeTruthy());
    expect(screen.queryByText(/clean/i)).toBeNull();
    expect(calls.filter((c) => c.pathname === "/v1/worktrees")).toHaveLength(1);

    // Switching away from Files stopped further Files fetches for idle tab.
    const filesAfter = calls.filter((c) => c.pathname === "/v1/files").length;
    expect(filesAfter).toBe(filesBefore);
  });

  it("corrects the active tab when capabilities shrink away from it", async () => {
    const { impl } = makeRouter();
    globalThis.fetch = impl;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const build = (caps: HostCapability[]) => (
      <QueryClientProvider client={queryClient}>
        <HttpClientProvider>
          <CapabilityProvider host={{ mode: "local", capabilities: caps }}>
            <WorkspacePanel cwd="/proj" open onClose={() => undefined} />
          </CapabilityProvider>
        </HttpClientProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(build(["files", "git", "worktree"] satisfies HostCapability[]));
    await waitFor(() => expect(screen.getByText("a.ts")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "Worktrees" }));
    await waitFor(() => expect(screen.getByText("workspace-main")).toBeTruthy());

    // Drop worktree + files; only git remains → correct to Git.
    rerender(build(["git"] satisfies HostCapability[]));
    await waitFor(() => expect(screen.getByRole("tab", { name: "Git" })).toBeTruthy());
    expect(screen.queryByRole("tab", { name: "Worktrees" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Files" })).toBeNull();
    await waitFor(() => expect(screen.getByText(/clean/i)).toBeTruthy());
  });

  it("renders nothing when closed and issues zero worktree requests", () => {
    const { impl } = makeRouter();
    globalThis.fetch = impl;
    const { container } = renderPanel(
      { mode: "local", capabilities: ["worktree"] },
      { cwd: "/proj", open: false },
    );
    expect(container.firstChild).toBeNull();
    expect(impl).not.toHaveBeenCalled();
  });

  it("Worktrees UI has no create/delete/remove/force/open/switch/promote buttons", async () => {
    const { impl } = makeRouter();
    globalThis.fetch = impl;
    renderPanel({ mode: "local", capabilities: ["worktree"] }, { cwd: "/proj" });
    await waitFor(() => expect(screen.getByText("workspace-main")).toBeTruthy());
    const forbidden = /create|delete|remove|force|open|switch|promote|session/i;
    for (const button of screen.queryAllByRole("button")) {
      expect(button.textContent ?? "").not.toMatch(forbidden);
      expect(button.getAttribute("aria-label") ?? "").not.toMatch(forbidden);
    }
  });
});
