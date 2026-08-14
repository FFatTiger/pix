import { render, screen, waitFor, fireEvent, act, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpClientProvider } from "@/app/http-context";
import {
  WorktreePanel,
  describeWorktreeError,
  describeWorktreeMutationError,
} from "./WorktreePanel";
import { HttpError } from "@/api/http-client";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

interface PanelProps {
  cwd: string | undefined;
  canWorktree?: boolean;
  canWorktreeWrite?: boolean;
  onOpenWorktree?: (path: string) => void;
}

function renderPanel(props: PanelProps) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <HttpClientProvider>{children}</HttpClientProvider>
    </QueryClientProvider>
  );
  return render(
    <WorktreePanel
      cwd={props.cwd}
      canWorktree={props.canWorktree ?? true}
      canWorktreeWrite={props.canWorktreeWrite ?? false}
      onOpenWorktree={props.onOpenWorktree}
    />,
    { wrapper: Wrapper },
  );
}

interface FetchCalls {
  list: { cwd: string }[];
  create: { cwd: string; branch: string }[];
  remove: { cwd: string; path: string; force: boolean }[];
}

interface RouterOpts {
  list?: (cwd: string) => Response | Promise<Response>;
  create?: (body: { cwd: string; branch: string }) => Response | Promise<Response>;
  remove?: (body: { cwd: string; path: string; force: boolean }) => Response | Promise<Response>;
}

/** Fetch router keyed by /v1/worktrees method that records exact calls. */
function makeRouter(opts: RouterOpts = {}) {
  const calls: FetchCalls = { list: [], create: [], remove: [] };
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://pix.local");
    const method = init?.method ?? "GET";
    const body =
      init?.body !== undefined && typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    if (url.pathname === "/v1/worktrees") {
      if (method === "GET") {
        const cwd = url.searchParams.get("cwd") ?? "";
        calls.list.push({ cwd });
        if (opts.list) return opts.list(cwd);
      } else if (method === "POST") {
        calls.create.push(body as { cwd: string; branch: string });
        if (opts.create) return opts.create(body as { cwd: string; branch: string });
      } else if (method === "DELETE") {
        calls.remove.push(body as { cwd: string; path: string; force: boolean });
        if (opts.remove) return opts.remove(body as { cwd: string; path: string; force: boolean });
      }
    }
    return json({});
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function listResponse(worktrees: unknown[], projectRoot = "/proj") {
  return json({ projectRoot, isGit: true, isTopLevel: true, worktrees });
}

const MAIN = {
  path: "/proj",
  branch: "main",
  isMain: true,
  authorized: true,
  managedByPix: true,
};
const LINKED = {
  path: "/proj-worktrees/feature",
  branch: "feature/x",
  isMain: false,
  authorized: true,
  managedByPix: true,
};
/** Authorized (inside AllowedRoot) but NOT Pix-managed — openable, never deletable. */
const UNMANAGED_AUTH = {
  path: "/proj-worktrees/manual",
  branch: "manual",
  isMain: false,
  authorized: true,
  managedByPix: false,
};
const EXTERNAL = {
  path: "/tmp/external-wt",
  branch: null,
  isMain: false,
  authorized: false,
  managedByPix: false,
};

/** Standard full topology for a cwd of /proj. */
function standardList() {
  return listResponse([MAIN, LINKED, UNMANAGED_AUTH, EXTERNAL]);
}

describe("WorktreePanel", () => {
  let previous: typeof fetch;
  beforeEach(() => {
    previous = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = previous;
    cleanup();
  });

  it("never requests the API when the worktree capability is absent", () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    globalThis.fetch = fetchImpl;
    renderPanel({ cwd: "/proj", canWorktree: false });
    expect(screen.getByText(/not available/i)).toBeTruthy();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("prompts to open a project when no cwd is set and issues zero requests", () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    globalThis.fetch = fetchImpl;
    renderPanel({ cwd: undefined });
    expect(screen.getByText(/open a project/i)).toBeTruthy();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("renders non-git status without worktree rows", async () => {
    const { impl } = makeRouter({
      list: () => json({ projectRoot: "/plain", isGit: false, isTopLevel: false, worktrees: [] }),
    });
    globalThis.fetch = impl;
    renderPanel({ cwd: "/plain" });
    await waitFor(() => expect(screen.getByText(/not a git repository/i)).toBeTruthy());
    expect(screen.queryByRole("list", { name: /git worktrees/i })).toBeNull();
  });

  it("renders main, linked, detached, and unauthorized rows with no action buttons (list-only without write cap)", async () => {
    const { impl } = makeRouter({ list: () => standardList() });
    globalThis.fetch = impl;
    renderPanel({ cwd: "/proj" });
    await waitFor(() => expect(screen.getByText("Detached")).toBeTruthy());
    expect(screen.getAllByText("linked").length).toBe(3);
    expect(screen.getAllByText("main").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("authorized").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("External · not authorized")).toBeTruthy();
    expect(screen.getByText("/tmp/external-wt")).toBeTruthy();

    // Strictly read-only without worktree.write: no create/remove/force/open.
    expect(screen.queryByLabelText("New worktree branch")).toBeNull();
    const forbidden = /create|delete|remove|force|open|switch|promote|session/i;
    for (const button of screen.queryAllByRole("button")) {
      expect(button.textContent ?? "").not.toMatch(forbidden);
      expect(button.getAttribute("aria-label") ?? "").not.toMatch(forbidden);
    }
    // Only the refresh control is an action.
    expect(screen.getByRole("button", { name: /refresh/i })).toBeTruthy();
  });

  it("maps host errors to fixed sanitized copy and never shows raw body", async () => {
    const { impl } = makeRouter({
      list: () =>
        json(
          { code: "PATH_FORBIDDEN", message: "SECRET=/etc/passwd stack:Error at /secret/path" },
          403,
        ),
    });
    globalThis.fetch = impl;
    renderPanel({ cwd: "/proj" });
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toMatch(/outside the allowed roots/i);
    expect(alert.textContent).not.toMatch(/SECRET|stack|\/etc\/passwd|\/secret\/path/i);
  });

  it("fails closed on a malformed response (schema mismatch)", async () => {
    const { impl } = makeRouter({
      list: () => json({ projectRoot: "/proj", isGit: true, worktrees: "nope" }),
    });
    globalThis.fetch = impl;
    renderPanel({ cwd: "/proj" });
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toMatch(/unable to load worktrees/i);
    expect(screen.queryByText("main")).toBeNull();
  });

  it("isolates query keys by cwd so A→B stale responses never overwrite B", async () => {
    let resolveA: ((value: Response) => void) | undefined;
    const aPromise = new Promise<Response>((resolve) => {
      resolveA = resolve;
    });
    const { impl } = makeRouter({
      list: (cwd) => {
        if (cwd === "/proj-a") return aPromise;
        if (cwd === "/proj-b") {
          return listResponse([
            { path: "/repo-b-root", branch: "branch-b", isMain: true, authorized: true, managedByPix: true },
          ]);
        }
        return json({});
      },
    });
    globalThis.fetch = impl;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <HttpClientProvider>{children}</HttpClientProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(<WorktreePanel cwd="/proj-a" canWorktree />, { wrapper: Wrapper });

    // Switch to B while A is still in flight.
    rerender(
      <QueryClientProvider client={queryClient}>
        <HttpClientProvider>
          <WorktreePanel cwd="/proj-b" canWorktree />
        </HttpClientProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText("branch-b")).toBeTruthy());
    expect(screen.queryByText("branch-a")).toBeNull();

    // Late A response must not clobber B.
    await act(async () => {
      resolveA?.(
        listResponse([
          { path: "/repo-a-root", branch: "branch-a", isMain: true, authorized: true, managedByPix: true },
        ]),
      );
      await aPromise;
    });
    await waitFor(() => expect(screen.getByText("branch-b")).toBeTruthy());
    expect(screen.queryByText("branch-a")).toBeNull();
    expect(screen.getAllByText("/repo-b-root").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("/repo-a-root")).toBeNull();
  });

  it("re-fetches when Refresh is pressed", async () => {
    const { impl, calls } = makeRouter({ list: () => listResponse([MAIN]) });
    globalThis.fetch = impl;
    renderPanel({ cwd: "/proj" });
    await waitFor(() => expect(screen.getByRole("list", { name: /git worktrees/i })).toBeTruthy());
    expect(calls.list.length).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    await waitFor(() => expect(calls.list.length).toBe(2));
  });
});

describe("WorktreePanel managed workflow (worktree.write)", () => {
  let previous: typeof fetch;
  beforeEach(() => {
    previous = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = previous;
    cleanup();
  });

  async function renderManaged(
    cwd = "/proj",
    opts: RouterOpts = {},
    onOpenWorktree?: (path: string) => void,
  ) {
    const { impl, calls } = makeRouter({ list: () => standardList(), ...opts });
    globalThis.fetch = impl;
    renderPanel({ cwd, canWorktreeWrite: true, onOpenWorktree: onOpenWorktree ?? (() => undefined) });
    await waitFor(() => expect(screen.getByRole("list", { name: /git worktrees/i })).toBeTruthy());
    return { impl, calls };
  }

  it("write cap reveals create form and per-row open/delete controls", async () => {
    await renderManaged();
    // Create form present.
    expect(screen.getByLabelText("New worktree branch")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create" })).toBeTruthy();
    // Open: authorized non-current rows (LINKED + UNMANAGED_AUTH), never current MAIN.
    expect(screen.getByRole("button", { name: "Open worktree feature/x" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open worktree manual" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /open worktree main/ })).toBeNull();
    // External/unauthorized never gets Open.
    expect(screen.queryByRole("button", { name: /open worktree external/i })).toBeNull();
    // Delete: managed non-main only (LINKED). Unmanaged-authorized/manual has NO delete.
    expect(screen.getByRole("button", { name: "Delete worktree feature/x" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /delete worktree manual/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /delete worktree main/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /delete worktree external/i })).toBeNull();
  });

  it("capability revoke hides create form and action controls immediately", async () => {
    const { impl } = makeRouter({ list: () => standardList() });
    globalThis.fetch = impl;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <HttpClientProvider>{children}</HttpClientProvider>
      </QueryClientProvider>
    );
    const build = (write: boolean) => (
      <QueryClientProvider client={queryClient}>
        <HttpClientProvider>
          <WorktreePanel cwd="/proj" canWorktree canWorktreeWrite={write} onOpenWorktree={() => undefined} />
        </HttpClientProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(build(true), { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByLabelText("New worktree branch")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Delete worktree feature/x" })).toBeTruthy();

    rerender(build(false));
    await waitFor(() => expect(screen.queryByLabelText("New worktree branch")).toBeNull());
    expect(screen.queryByRole("button", { name: /delete worktree feature\/x/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /open worktree feature\/x/ })).toBeNull();
  });

  it("create success navigates the returned path (no mutation elsewhere)", async () => {
    const onOpen = vi.fn();
    const { impl, calls } = makeRouter({
      list: () => standardList(),
      create: (body) => {
        expect(body.cwd).toBe("/proj");
        return json({ path: "/proj-worktrees/feat", branch: body.branch, managedByPix: true }, 201);
      },
    });
    globalThis.fetch = impl;
    renderPanel({ cwd: "/proj", canWorktreeWrite: true, onOpenWorktree: onOpen });
    await waitFor(() => expect(screen.getByLabelText("New worktree branch")).toBeTruthy());

    fireEvent.change(screen.getByLabelText("New worktree branch"), { target: { value: "feat" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith("/proj-worktrees/feat"));
    expect(calls.create).toEqual([{ cwd: "/proj", branch: "feat" }]);
    expect(calls.remove).toHaveLength(0);
    expect(calls.list.length).toBeGreaterThanOrEqual(1);
  });

  it("create pending disables the form and a double submit sends exactly one request", async () => {
    let resolveCreate: ((value: Response) => void) | undefined;
    const createPromise = new Promise<Response>((resolve) => {
      resolveCreate = resolve;
    });
    const onOpen = vi.fn();
    const { impl, calls } = makeRouter({
      list: () => standardList(),
      create: () => createPromise,
    });
    globalThis.fetch = impl;
    renderPanel({ cwd: "/proj", canWorktreeWrite: true, onOpenWorktree: onOpen });
    await waitFor(() => expect(screen.getByLabelText("New worktree branch")).toBeTruthy());

    fireEvent.change(screen.getByLabelText("New worktree branch"), { target: { value: "feat" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await act(async () => { await Promise.resolve(); });
    // Pending: form disabled, status shown.
    expect((screen.getByLabelText("New worktree branch") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toMatch(/creating worktree/i);

    // Double submit attempt (disabled button) — still exactly one POST.
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(calls.create).toHaveLength(1);

    await act(async () => {
      resolveCreate?.(json({ path: "/proj-worktrees/feat", branch: "feat", managedByPix: true }, 201));
      await createPromise;
    });
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith("/proj-worktrees/feat"));
    expect(calls.create).toHaveLength(1);
  });

  it("stale create result after capability revoke never navigates or surfaces an error", async () => {
    let resolveCreate: ((value: Response) => void) | undefined;
    const createPromise = new Promise<Response>((resolve) => {
      resolveCreate = resolve;
    });
    const onOpen = vi.fn();
    const { impl } = makeRouter({
      list: () => standardList(),
      create: () => createPromise,
    });
    globalThis.fetch = impl;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <HttpClientProvider>{children}</HttpClientProvider>
      </QueryClientProvider>
    );
    const build = (write: boolean) => (
      <QueryClientProvider client={queryClient}>
        <HttpClientProvider>
          <WorktreePanel cwd="/proj" canWorktree canWorktreeWrite={write} onOpenWorktree={onOpen} />
        </HttpClientProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(build(true), { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByLabelText("New worktree branch")).toBeTruthy());

    fireEvent.change(screen.getByLabelText("New worktree branch"), { target: { value: "feat" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await act(async () => { await Promise.resolve(); });

    // Revoke the write capability while the create is in flight.
    rerender(build(false));
    await waitFor(() => expect(screen.queryByLabelText("New worktree branch")).toBeNull());

    await act(async () => {
      resolveCreate?.(json({ path: "/proj-worktrees/feat", branch: "feat", managedByPix: true }, 201));
      await createPromise;
    });
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("stale create result after cwd change never navigates or surfaces an error", async () => {
    let resolveCreate: ((value: Response) => void) | undefined;
    const createPromise = new Promise<Response>((resolve) => {
      resolveCreate = resolve;
    });
    const onOpen = vi.fn();
    const { impl } = makeRouter({
      list: (cwd) => (cwd === "/proj" ? standardList() : listResponse([{ ...MAIN, path: "/other" }])),
      create: () => createPromise,
    });
    globalThis.fetch = impl;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <HttpClientProvider>{children}</HttpClientProvider>
      </QueryClientProvider>
    );
    const build = (cwd: string) => (
      <QueryClientProvider client={queryClient}>
        <HttpClientProvider>
          <WorktreePanel cwd={cwd} canWorktree canWorktreeWrite onOpenWorktree={onOpen} />
        </HttpClientProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(build("/proj"), { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByLabelText("New worktree branch")).toBeTruthy());

    fireEvent.change(screen.getByLabelText("New worktree branch"), { target: { value: "feat" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await act(async () => { await Promise.resolve(); });

    rerender(build("/other"));
    await waitFor(() => expect(screen.getByRole("list", { name: /git worktrees/i })).toBeTruthy());

    await act(async () => {
      resolveCreate?.(json({ path: "/proj-worktrees/feat", branch: "feat", managedByPix: true }, 201));
      await createPromise;
    });
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("Open invokes navigation only — never a mutation or session call", async () => {
    const onOpen = vi.fn();
    const { impl, calls } = makeRouter({ list: () => standardList() });
    globalThis.fetch = impl;
    renderPanel({ cwd: "/proj", canWorktreeWrite: true, onOpenWorktree: onOpen });
    await waitFor(() => expect(screen.getByRole("list", { name: /git worktrees/i })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Open worktree feature/x" }));
    expect(onOpen).toHaveBeenCalledWith("/proj-worktrees/feature");
    // No POST/DELETE — pure URL cwd navigation, no git checkout / session mutation.
    expect(calls.create).toHaveLength(0);
    expect(calls.remove).toHaveLength(0);
    expect(calls.list).toHaveLength(1);
  });

  it("delete dirty 409 reveals a row-local inline confirmation (no force yet)", async () => {
    const { impl, calls } = makeRouter({
      list: () => standardList(),
      remove: () => json({ code: "WORKTREE_DIRTY", message: "leak" }, 409),
    });
    globalThis.fetch = impl;
    renderPanel({ cwd: "/proj", canWorktreeWrite: true });
    await waitFor(() => expect(screen.getByRole("list", { name: /git worktrees/i })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Delete worktree feature/x" }));
    // Initial delete sends force:false only.
    await waitFor(() =>
      expect(calls.remove).toEqual([{ cwd: "/proj", path: "/proj-worktrees/feature", force: false }]),
    );
    // Row-local confirmation appears with irreversible warning, Delete anyway + Cancel.
    expect(await screen.findByRole("alert", { name: /confirm deleting feature\/x/i })).toBeTruthy();
    expect(screen.getByText(/permanent and cannot be undone/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete worktree feature/x anyway" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    // No error alert — the confirmation IS the response.
    expect(screen.queryByText(/only pix-managed/i)).toBeNull();
  });

  it("Cancel closes the confirmation, sends no force, and returns focus to Delete", async () => {
    const { impl, calls } = makeRouter({
      list: () => standardList(),
      remove: () => json({ code: "WORKTREE_DIRTY", message: "leak" }, 409),
    });
    globalThis.fetch = impl;
    renderPanel({ cwd: "/proj", canWorktreeWrite: true });
    await waitFor(() => expect(screen.getByRole("list", { name: /git worktrees/i })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Delete worktree feature/x" }));
    const cancel = await screen.findByRole("button", { name: "Cancel" });
    // Default/returned focus favors Cancel (safe escape).
    expect(document.activeElement).toBe(cancel);

    fireEvent.click(cancel);
    await waitFor(() =>
      expect(screen.queryByRole("alert", { name: /confirm deleting/i })).toBeNull(),
    );
    // Still only the initial force:false request — Cancel never forces.
    expect(calls.remove).toHaveLength(1);
    expect(calls.remove[0]?.force).toBe(false);
    // Delete control is back and refocused.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Delete worktree feature/x" })),
    );
  });

  it("Delete anyway forces exactly once and succeeds", async () => {
    const { impl, calls } = makeRouter({
      list: () => standardList(),
      remove: (body) => {
        if (!body.force) return json({ code: "WORKTREE_DIRTY", message: "leak" }, 409);
        return json({ success: true, fallbackCwd: "/proj", branchRetained: true });
      },
    });
    globalThis.fetch = impl;
    renderPanel({ cwd: "/proj", canWorktreeWrite: true });
    await waitFor(() => expect(screen.getByRole("list", { name: /git worktrees/i })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Delete worktree feature/x" }));
    await screen.findByRole("button", { name: "Delete worktree feature/x anyway" });
    fireEvent.click(screen.getByRole("button", { name: "Delete worktree feature/x anyway" }));

    await waitFor(() =>
      expect(calls.remove).toEqual([
        { cwd: "/proj", path: "/proj-worktrees/feature", force: false },
        { cwd: "/proj", path: "/proj-worktrees/feature", force: true },
      ]),
    );
    // Force fired exactly once and the confirmation closed.
    expect(calls.remove.filter((c) => c.force === true)).toHaveLength(1);
    await waitFor(() =>
      expect(screen.queryByRole("alert", { name: /confirm deleting/i })).toBeNull(),
    );
  });

  it.each([
    { code: "WORKTREE_BUSY", status: 409, message: "This worktree has an active Agent session." },
    { code: "WORKTREE_NOT_MANAGED", status: 403, message: "Only Pix-managed worktrees can be removed." },
    { code: "WORKTREE_MANAGED_UNAVAILABLE", status: 503, message: "This action is temporarily unavailable." },
  ])("$code never offers force and shows fixed copy", async ({ code, status, message }) => {
    const { impl, calls } = makeRouter({
      list: () => standardList(),
      remove: () => json({ code, message: "raw-leak" }, status),
    });
    globalThis.fetch = impl;
    renderPanel({ cwd: "/proj", canWorktreeWrite: true });
    await waitFor(() => expect(screen.getByRole("list", { name: /git worktrees/i })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Delete worktree feature/x" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(message);
    expect(alert.textContent).not.toMatch(/raw-leak/);
    // No confirmation → no force path.
    expect(screen.queryByRole("button", { name: /delete worktree feature\/x anyway/i })).toBeNull();
    expect(calls.remove).toHaveLength(1);
    expect(calls.remove[0]?.force).toBe(false);
  });

  it("selected delete (deleted path == current cwd) navigates fallbackCwd", async () => {
    // cwd IS the linked worktree being deleted.
    const onOpen = vi.fn();
    const { impl, calls } = makeRouter({
      list: () => listResponse([{ ...MAIN }, { ...LINKED }]),
      remove: () => json({ success: true, fallbackCwd: "/proj", branchRetained: true }),
    });
    globalThis.fetch = impl;
    renderPanel({ cwd: "/proj-worktrees/feature", canWorktreeWrite: true, onOpenWorktree: onOpen });
    await waitFor(() => expect(screen.getByRole("list", { name: /git worktrees/i })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Delete worktree feature/x" }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith("/proj"));
    expect(calls.remove[0]?.path).toBe("/proj-worktrees/feature");
  });

  it("non-selected delete keeps the current cwd (no navigation)", async () => {
    const onOpen = vi.fn();
    const { impl, calls } = makeRouter({
      list: () => standardList(),
      remove: () => json({ success: true, fallbackCwd: "/proj", branchRetained: true }),
    });
    globalThis.fetch = impl;
    renderPanel({ cwd: "/proj", canWorktreeWrite: true, onOpenWorktree: onOpen });
    await waitFor(() => expect(screen.getByRole("list", { name: /git worktrees/i })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Delete worktree feature/x" }));
    await waitFor(() => expect(calls.remove).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("late delete result after cwd change never navigates or surfaces an error", async () => {
    let resolveRemove: ((value: Response) => void) | undefined;
    const removePromise = new Promise<Response>((resolve) => {
      resolveRemove = resolve;
    });
    const onOpen = vi.fn();
    const { impl } = makeRouter({
      list: (cwd) => (cwd === "/proj" ? standardList() : listResponse([{ ...MAIN, path: "/other" }])),
      remove: () => removePromise,
    });
    globalThis.fetch = impl;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <HttpClientProvider>{children}</HttpClientProvider>
      </QueryClientProvider>
    );
    const build = (cwd: string) => (
      <QueryClientProvider client={queryClient}>
        <HttpClientProvider>
          <WorktreePanel cwd={cwd} canWorktree canWorktreeWrite onOpenWorktree={onOpen} />
        </HttpClientProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(build("/proj"), { wrapper: Wrapper });
    await waitFor(() => expect(screen.getByRole("list", { name: /git worktrees/i })).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Delete worktree feature/x" }));
    await act(async () => { await Promise.resolve(); });

    rerender(build("/other"));
    await waitFor(() => expect(screen.getByRole("list", { name: /git worktrees/i })).toBeTruthy());

    await act(async () => {
      resolveRemove?.(json({ success: true, fallbackCwd: "/proj", branchRetained: true }));
      await removePromise;
    });
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("successful create still runs the existing mutation-option invalidation (list refetches)", async () => {
    const { impl, calls } = makeRouter({
      list: () => standardList(),
      create: (body) =>
        json({ path: `/proj-worktrees/${body.branch}`, branch: body.branch, managedByPix: true }, 201),
    });
    globalThis.fetch = impl;
    renderPanel({ cwd: "/proj", canWorktreeWrite: true });
    await waitFor(() => expect(screen.getByRole("list", { name: /git worktrees/i })).toBeTruthy());
    expect(calls.list.length).toBe(1);

    fireEvent.change(screen.getByLabelText("New worktree branch"), { target: { value: "feat" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    // onSuccess invalidates worktrees.list(cwd) → the mounted list refetches.
    await waitFor(() => expect(calls.list.length).toBeGreaterThanOrEqual(2));
  });

  it("successful delete still runs the existing mutation-option invalidation (list refetches)", async () => {
    const { impl, calls } = makeRouter({
      list: () => standardList(),
      remove: () => json({ success: true, fallbackCwd: "/proj", branchRetained: true }),
    });
    globalThis.fetch = impl;
    renderPanel({ cwd: "/proj", canWorktreeWrite: true });
    await waitFor(() => expect(screen.getByRole("list", { name: /git worktrees/i })).toBeTruthy());
    expect(calls.list.length).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Delete worktree feature/x" }));
    await waitFor(() => expect(calls.list.length).toBeGreaterThanOrEqual(2));
  });

  it("never renders raw malicious message markers on create or delete errors", async () => {
    // Create error with malicious body.
    const createRouter = makeRouter({
      list: () => standardList(),
      create: () =>
        json({ code: "INTERNAL", message: "SECRET=/etc/passwd stack at /tmp leak path", path: "/leak" }, 500),
    });
    globalThis.fetch = createRouter.impl;
    renderPanel({ cwd: "/proj", canWorktreeWrite: true });
    await waitFor(() => expect(screen.getByLabelText("New worktree branch")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("New worktree branch"), { target: { value: "feat" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Unable to create the worktree."),
    );
    const createAlert = screen.getByRole("alert");
    expect(createAlert.textContent).not.toMatch(/SECRET|stack|\/etc|\/tmp|\/leak|INTERNAL/);
    cleanup();

    // Delete error with malicious body.
    const deleteRouter = makeRouter({
      list: () => standardList(),
      remove: () =>
        json({ code: "INTERNAL", message: "SECRET=/etc/passwd stack at /tmp leak path", path: "/leak" }, 500),
    });
    globalThis.fetch = deleteRouter.impl;
    renderPanel({ cwd: "/proj", canWorktreeWrite: true });
    await waitFor(() => expect(screen.getByRole("list", { name: /git worktrees/i })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Delete worktree feature/x" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Unable to remove the worktree."),
    );
    const deleteAlert = screen.getByRole("alert");
    expect(deleteAlert.textContent).not.toMatch(/SECRET|stack|\/etc|\/tmp|\/leak|INTERNAL/);
  });

  it("exposes mobile-safe row/confirmation structure and accessible naming", async () => {
    const { impl } = makeRouter({
      list: () => standardList(),
      remove: () => json({ code: "WORKTREE_DIRTY", message: "leak" }, 409),
    });
    globalThis.fetch = impl;
    renderPanel({ cwd: "/proj", canWorktreeWrite: true, onOpenWorktree: () => undefined });
    await waitFor(() => expect(screen.getByRole("list", { name: /git worktrees/i })).toBeTruthy());

    const row = screen.getByText("/proj-worktrees/feature").closest("li");
    expect(row?.className).toContain("worktree-row");
    // Actions are a wrapped flex row (mobile-safe, no horizontal overflow).
    expect(row?.querySelector(".worktree-row-actions")).toBeTruthy();
    // Buttons carry descriptive names incl. branch/path basename.
    expect(screen.getByRole("button", { name: "Open worktree feature/x" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete worktree feature/x" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Delete worktree feature/x" }));
    const confirm = await screen.findByRole("alert", { name: /confirm deleting feature\/x/i });
    expect(confirm.className).toContain("worktree-delete-confirm");
    expect(confirm.querySelector(".worktree-delete-confirm-actions")).toBeTruthy();
    // Cancel is the focused (safe) control.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  });
});

describe("describeWorktreeMutationError", () => {
  it("maps known create/delete codes to fixed copy", () => {
    expect(
      describeWorktreeMutationError(
        new HttpError({ status: 400, path: "/v1/worktrees", message: "LEAK", code: "INVALID_BRANCH" }),
        "create",
      ),
    ).toBe("Invalid branch name.");
    expect(
      describeWorktreeMutationError(
        new HttpError({ status: 409, path: "/v1/worktrees", message: "LEAK", code: "WORKTREE_EXISTS" }),
        "create",
      ),
    ).toBe("A worktree for this branch already exists.");
    expect(
      describeWorktreeMutationError(
        new HttpError({ status: 409, path: "/v1/worktrees", message: "LEAK", code: "WORKTREE_BUSY" }),
        "delete",
      ),
    ).toBe("This worktree has an active Agent session.");
    expect(
      describeWorktreeMutationError(
        new HttpError({ status: 403, path: "/v1/worktrees", message: "LEAK", code: "WORKTREE_NOT_MANAGED" }),
        "delete",
      ),
    ).toBe("Only Pix-managed worktrees can be removed.");
    expect(
      describeWorktreeMutationError(
        new HttpError({ status: 409, path: "/v1/worktrees", message: "LEAK", code: "MAIN_WORKTREE" }),
        "delete",
      ),
    ).toBe("The main worktree cannot be removed.");
    expect(
      describeWorktreeMutationError(
        new HttpError({ status: 503, path: "/v1/worktrees", message: "LEAK", code: "WORKTREE_MANAGED_UNAVAILABLE" }),
        "delete",
      ),
    ).toBe("This action is temporarily unavailable.");
    expect(
      describeWorktreeMutationError(
        new HttpError({ status: 401, path: "/v1/worktrees", message: "LEAK" }),
        "delete",
      ),
    ).toBe("You are not authorized for this action.");
    expect(
      describeWorktreeMutationError(
        new HttpError({ kind: "network", path: "/v1/worktrees", message: "LEAK" }),
        "create",
      ),
    ).toBe("Network error — unable to reach the host.");
    expect(
      describeWorktreeMutationError(
        new HttpError({ kind: "timeout", path: "/v1/worktrees", message: "LEAK" }),
        "delete",
      ),
    ).toBe("Request timed out — try again.");
  });

  it("never echoes raw host messages on unknown codes", () => {
    const err = new HttpError({
      status: 500,
      path: "/v1/worktrees",
      message: "SECRET=/etc/passwd\nstack at /tmp",
      code: "INTERNAL",
    });
    const copy = describeWorktreeMutationError(err, "delete");
    expect(copy).toBe("Unable to remove the worktree.");
    expect(copy).not.toMatch(/SECRET|stack|\/etc|\/tmp/);
  });
});

describe("describeWorktreeError", () => {
  it("maps known codes to fixed copy", () => {
    expect(
      describeWorktreeError(
        new HttpError({ status: 400, path: "/v1/worktrees", message: "LEAK", code: "INVALID_PATH" }),
      ),
    ).toBe("Invalid project path.");
    expect(
      describeWorktreeError(
        new HttpError({ status: 403, path: "/v1/worktrees", message: "LEAK", code: "PATH_FORBIDDEN" }),
      ),
    ).toBe("Project path is outside the allowed roots.");
    expect(
      describeWorktreeError(
        new HttpError({ status: 404, path: "/v1/worktrees", message: "LEAK", code: "PATH_NOT_FOUND" }),
      ),
    ).toBe("Project path was not found.");
  });

  it("never echoes raw host messages", () => {
    const err = new HttpError({
      status: 500,
      path: "/v1/worktrees",
      message: "SECRET=/etc/passwd\nstack at /tmp",
      code: "INTERNAL",
    });
    const copy = describeWorktreeError(err);
    expect(copy).toBe("Unable to load worktrees.");
    expect(copy).not.toMatch(/SECRET|stack|\/etc|\/tmp/);
  });
});
