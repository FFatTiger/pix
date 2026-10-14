import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantActionCard, isAssistantActionTool } from "./AssistantActionCard";
import { queryKeys } from "@/api/query-keys";
import { getDraft, clearDraft } from "@/lib/draft-store";
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

describe("AssistantActionCard", () => {
  it("open_session: button navigates via the normal session-selection URL flow", () => {
    mount(<AssistantActionCard toolName="open_session" input={{ session: "修 bug 会话" }} />);
    fireEvent.click(screen.getByTestId("assistant-action-button"));
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({
      to: "/",
      search: { session: "s-1", cwd: "/repos/pix" },
    }));
  });

  it("open_session: unresolvable target disables the button with honest copy", () => {
    mount(<AssistantActionCard toolName="open_session" input={{ session: "ghost" }} />);
    expect(screen.getByText("Session not found: ghost")).toBeTruthy();
    expect((screen.getByTestId("assistant-action-button") as HTMLButtonElement).disabled).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("draft_to_session: parks the draft in the draft store, navigates, never sends", () => {
    mount(<AssistantActionCard toolName="draft_to_session" input={{ session: "s-1", text: "接着修 bug" }} />);
    expect(getDraft("s-1")).toBeNull();
    fireEvent.click(screen.getByTestId("assistant-action-button"));
    expect(getDraft("s-1")).toEqual({ value: "接着修 bug", images: [] });
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ search: { session: "s-1", cwd: "/repos/pix" } }));
    // No fetch happened: nothing was sent anywhere.
  });

  it("organize_sessions delete: two-step in-card confirmation before the API call", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      assertDelete(init);
      return new Response(JSON.stringify({ sessionId: "s-1", deleted: true }), { status: 200, headers: { "content-type": "application/json" } });
      function assertDelete(init2: RequestInit | undefined) {
        if (init2?.method !== "DELETE") throw new Error(`must be DELETE, got ${init2?.method}`);
      }
    });
    vi.stubGlobal("fetch", fetchMock);
    mount(<AssistantActionCard toolName="organize_sessions" input={{ action: "delete", sessions: [{ session: "s-1" }] }} />);
    // First click only arms the confirmation; nothing sent yet.
    fireEvent.click(screen.getByTestId("assistant-action-button"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText("Delete 1 session(s)? This cannot be undone.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Confirm delete/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0]![0])).toBe("/v1/sessions/s-1");
  });

  it("organize_sessions rename: reports the completed rename and calls no mutation", () => {
    const fetchMock = vi.fn(async () => { throw new Error("must not fetch"); });
    vi.stubGlobal("fetch", fetchMock);
    mount(<AssistantActionCard toolName="organize_sessions" input={{ action: "rename", sessions: [{ session: "s-1" }], title: "新标题" }} />);
    expect(screen.getByText("Renamed: 新标题")).toBeTruthy();
    expect(screen.queryByTestId("assistant-action-button")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("organize_sessions removed actions (pin/archive) render a disabled execute button and never call APIs", () => {
    const fetchMock = vi.fn(async () => { throw new Error("must not fetch"); });
    vi.stubGlobal("fetch", fetchMock);
    for (const removed of ["pin", "unpin", "archive", "unarchive"]) {
      const { unmount } = mount(<AssistantActionCard toolName="organize_sessions" input={{ action: removed, sessions: [{ session: "s-1" }] }} />);
      const button = screen.getByTestId("assistant-action-button") as HTMLButtonElement;
      expect(button.disabled, removed).toBe(true);
      fireEvent.click(button);
      expect(fetchMock).not.toHaveBeenCalled();
      unmount();
    }
  });

  it("send_to_session: shows the resolved target, delivery, and opens it", () => {
    mount(<AssistantActionCard toolName="send_to_session" input={{ session: "修 bug 会话", message: "接着修", delivery: "steer" }} />);
    expect(screen.getByText("To 修 bug 会话")).toBeTruthy();
    expect(screen.getByText("Steer")).toBeTruthy();
    expect(screen.getByText("接着修")).toBeTruthy();
    fireEvent.click(screen.getByTestId("assistant-action-button"));
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({
      search: { session: "s-1", cwd: "/repos/pix" },
    }));
  });

  it("send_to_session: an unresolved target disables Open", () => {
    mount(<AssistantActionCard toolName="send_to_session" input={{ session: "ghost", message: "hi" }} />);
    expect(screen.getByText("New turn")).toBeTruthy();
    expect((screen.getByTestId("assistant-action-button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("create_session: Open resolves the newest session whose project basename matches", () => {
    mount(
      <AssistantActionCard toolName="create_session" input={{ project: "pix", message: "修登录" }} />,
      [
        header({ sessionId: "old", cwd: "/repos/pix", updatedAt: 10 }),
        header({ sessionId: "other", cwd: "/repos/other", updatedAt: 99 }),
        header({ sessionId: "new", cwd: "/work/Pix", updatedAt: 50 }),
      ],
    );
    expect(screen.getByText("Project pix")).toBeTruthy();
    fireEvent.click(screen.getByTestId("assistant-action-button"));
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({
      search: { session: "new", cwd: "/work/Pix" },
    }));
  });

  it("create_session: no matching project shows text and no button", () => {
    mount(<AssistantActionCard toolName="create_session" input={{ project: "missing", message: "x" }} />);
    expect(screen.getByText("The new session is not in the list yet")).toBeTruthy();
    expect(screen.queryByTestId("assistant-action-button")).toBeNull();
  });

  it("isAssistantActionTool gates the action tools", () => {
    expect(isAssistantActionTool("open_session")).toBe(true);
    expect(isAssistantActionTool("organize_sessions")).toBe(true);
    expect(isAssistantActionTool("draft_to_session")).toBe(true);
    expect(isAssistantActionTool("send_to_session")).toBe(true);
    expect(isAssistantActionTool("create_session")).toBe(true);
    expect(isAssistantActionTool("stop_session")).toBe(false);
    expect(isAssistantActionTool("session_status")).toBe(false);
    expect(isAssistantActionTool("read")).toBe(false);
  });
});
