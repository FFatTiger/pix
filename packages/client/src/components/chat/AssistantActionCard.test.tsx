import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OrganizeSessionsCard, isOrganizeSessionsTool, TurnActionChips } from "./AssistantActionCard";
import { extractTurnActions } from "@/lib/turn-actions";
import { queryKeys } from "@/api/query-keys";
import { clearDraft } from "@/lib/draft-store";
import { HttpClientProvider } from "@/app/http-context";
import { I18nProvider } from "@/hooks/useI18n";
import type { SessionHeader } from "@fffattiger/pix-protocol";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-router")>("@tanstack/react-router");
  return { ...actual, useNavigate: () => navigate };
});

function header(over: Partial<SessionHeader> = {}): SessionHeader {
  return {
    sessionId: "s-1",
    cwd: "/repos/pix",
    projectRoot: "/repos/pix",
    title: "修 bug 会话",
    createdAt: 1,
    updatedAt: Date.now(),
    ...over,
  } as SessionHeader;
}

function mount(card: React.ReactElement, sessions: SessionHeader[] = [header()]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  queryClient.setQueryData(queryKeys.sessions.page(1, 5), { sessions, page: 1, pageSize: 5, total: sessions.length, totalPages: 1, catalogRevision: 0 });
  return render(
    <QueryClientProvider client={queryClient}>
      <HttpClientProvider>
        <I18nProvider>{card}</I18nProvider>
      </HttpClientProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  navigate.mockClear();
  clearDraft("s-1");
  vi.unstubAllGlobals();
});

describe("OrganizeSessionsCard", () => {
  it("delete: two-step in-card confirmation before the API call", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      assertDelete(init);
      return new Response(JSON.stringify({ sessionId: "s-1", deleted: true }), { status: 200, headers: { "content-type": "application/json" } });
      function assertDelete(init2: RequestInit | undefined) {
        if (init2?.method !== "DELETE") throw new Error(`must be DELETE, got ${init2?.method}`);
      }
    });
    vi.stubGlobal("fetch", fetchMock);
    mount(<OrganizeSessionsCard input={{ action: "delete", sessions: [{ session: "s-1" }] }} />);
    // First click only arms the confirmation; nothing sent yet.
    fireEvent.click(screen.getByTestId("assistant-action-button"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText("Delete 1 session(s)? This cannot be undone.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Confirm delete/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0]![0])).toBe("/v1/sessions/s-1");
  });

  it("rename: reports the completed rename and calls no mutation", () => {
    const fetchMock = vi.fn(async () => { throw new Error("must not fetch"); });
    vi.stubGlobal("fetch", fetchMock);
    mount(<OrganizeSessionsCard input={{ action: "rename", sessions: [{ session: "s-1" }], title: "新标题" }} />);
    expect(screen.getByText("Renamed: 新标题")).toBeTruthy();
    expect(screen.queryByTestId("assistant-action-button")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("removed actions (pin/archive) render a disabled execute button and never call APIs", () => {
    const fetchMock = vi.fn(async () => { throw new Error("must not fetch"); });
    vi.stubGlobal("fetch", fetchMock);
    for (const removed of ["pin", "unpin", "archive", "unarchive"]) {
      const { unmount } = mount(<OrganizeSessionsCard input={{ action: removed, sessions: [{ session: "s-1" }] }} />);
      const button = screen.getByTestId("assistant-action-button") as HTMLButtonElement;
      expect(button.disabled, removed).toBe(true);
      fireEvent.click(button);
      expect(fetchMock).not.toHaveBeenCalled();
      unmount();
    }
  });

  it("isOrganizeSessionsTool only gates organize_sessions", () => {
    expect(isOrganizeSessionsTool("organize_sessions")).toBe(true);
    // The navigation tools are plain tool rows now; the chips carry the jump.
    expect(isOrganizeSessionsTool("open_session")).toBe(false);
    expect(isOrganizeSessionsTool("draft_to_session")).toBe(false);
    expect(isOrganizeSessionsTool("send_to_session")).toBe(false);
    expect(isOrganizeSessionsTool("create_session")).toBe(false);
    expect(isOrganizeSessionsTool("stop_session")).toBe(false);
    expect(isOrganizeSessionsTool("read")).toBe(false);
  });
});

describe("TurnActionChips", () => {
  it("lists the turn's successful session actions and opens the tool's own target", () => {
    const content = [
      { type: "toolCall", toolCallId: "c1", toolName: "send_to_session", input: { session: "x", message: "go" } },
      { type: "toolCall", toolCallId: "c2", toolName: "create_session", input: { project: "pix", message: "new" } },
      { type: "toolCall", toolCallId: "c3", toolName: "send_to_session", input: { session: "y", message: "failed" } },
      { type: "toolCall", toolCallId: "c4", toolName: "read", input: { path: "/a" } },
    ] as never;
    const results = new Map([
      ["c1", { role: "toolResult", toolCallId: "c1", isError: false, details: { sessionId: "s-9", cwd: "/repos/other", title: "另一个会话" } }],
      ["c2", { role: "toolResult", toolCallId: "c2", isError: false, details: { sessionId: "s-new", cwd: "/repos/pix", title: "new" } }],
      ["c3", { role: "toolResult", toolCallId: "c3", isError: true }],
      ["c4", { role: "toolResult", toolCallId: "c4", isError: false }],
    ]) as never;
    const actions = extractTurnActions(content, results);
    expect(actions.map((action) => action.toolCallId)).toEqual(["c1", "c2"]);

    mount(<TurnActionChips actions={actions} />);
    const chips = screen.getAllByTestId("turn-action-chip");
    expect(chips.map((chip) => chip.textContent)).toEqual(["Sent to另一个会话", "Creatednew"]);
    fireEvent.click(chips[1]!);
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ search: { session: "s-new", cwd: "/repos/pix" } }));
  });
});
