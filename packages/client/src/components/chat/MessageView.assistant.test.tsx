import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ASSISTANT_NOTIFY_MESSAGE_PREFIX, ASSISTANT_SENT_MESSAGE_PREFIX } from "@/lib/assistant-message";
import { MessageView } from "./MessageView";
import { queryKeys } from "@/api/query-keys";
import { I18nProvider } from "@/hooks/useI18n";
import type { SessionHeader } from "@fffattiger/pix-protocol";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-router")>("@tanstack/react-router");
  return { ...actual, useNavigate: () => navigate };
});

const writeText = vi.fn(async () => undefined);

function user(content: string) {
  return <MessageView message={{ role: "user", content, timestamp: 0 } as never} />;
}

function mount(node: React.ReactElement, sessions: SessionHeader[] = []) {
  const queryClient = new QueryClient();
  if (sessions.length > 0) {
    queryClient.setQueryData(queryKeys.sessions.page(1, 5), { sessions });
  }
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.setItem("pi-locale", "en");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});

afterEach(() => {
  navigate.mockClear();
  writeText.mockClear();
  window.localStorage.removeItem("pi-locale");
});

describe("UserMessageView assistant markers", () => {
  it("renders a sent-by-assistant label and copies the text without the marker", async () => {
    mount(user(`${ASSISTANT_SENT_MESSAGE_PREFIX}\n\n接着修登录`));
    expect(screen.getByText("Sent by assistant")).toBeTruthy();
    expect(screen.getByText("接着修登录")).toBeTruthy();
    expect(screen.queryByText(ASSISTANT_SENT_MESSAGE_PREFIX)).toBeNull();
    fireEvent.click(screen.getByTitle("Copy message"));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("接着修登录"));
  });

  it("leaves an ordinary user message as a bubble with no label", () => {
    mount(user("普通消息"));
    expect(screen.getByText("普通消息")).toBeTruthy();
    expect(screen.queryByText("Sent by assistant")).toBeNull();
    expect(document.querySelector(".chat-user-bubble")).toBeTruthy();
    expect(document.querySelector(".assistant-notice-card")).toBeNull();
  });

  it("renders a notification card with a result badge and opens the parsed session", () => {
    const body = [
      ASSISTANT_NOTIFY_MESSAGE_PREFIX,
      "",
      "会话: 修登录｜项目: pix｜id: s-9",
      "结果: 完成",
      "最后回复: 已修好",
    ].join("\n");
    mount(user(body));
    expect(screen.getByTestId("assistant-notice-card")).toBeTruthy();
    expect(screen.getByText("Work notice")).toBeTruthy();
    expect(screen.getByTestId("assistant-notice-badge").textContent).toBe("完成");
    expect(screen.getByTestId("assistant-notice-badge").className).toContain("is-positive");
    expect(screen.getByText("最后回复: 已修好")).toBeTruthy();
    expect(document.querySelector(".chat-user-bubble")).toBeNull();
    fireEvent.click(screen.getByTestId("assistant-action-button"));
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({
      search: { session: "s-9", cwd: "" },
    }));
  });

  it("renders every block of a multi-block notice", () => {
    const body = [
      ASSISTANT_NOTIFY_MESSAGE_PREFIX,
      "",
      "会话: 甲｜项目: pix｜id: s-1",
      "结果: 出错",
      "错误: boom",
      "",
      "会话: 乙｜项目: other｜id: s-2",
      "结果: 停下等用户",
    ].join("\n");
    mount(user(body));
    const badges = screen.getAllByTestId("assistant-notice-badge");
    expect(badges.map((badge) => badge.textContent)).toEqual(["出错", "停下等用户"]);
    expect(badges[0]!.className).toContain("is-error");
    expect(badges[1]!.className).toContain("is-accent");
    expect(screen.getAllByTestId("assistant-action-button")).toHaveLength(2);
    expect(screen.getByText("错误: boom")).toBeTruthy();
  });

  it("falls back to the raw body when a notice has no parseable blocks", () => {
    mount(user(`${ASSISTANT_NOTIFY_MESSAGE_PREFIX}\n\n这不是标准块`));
    expect(screen.getByTestId("assistant-notice-card")).toBeTruthy();
    expect(screen.getByText("这不是标准块")).toBeTruthy();
    expect(screen.queryByTestId("assistant-action-button")).toBeNull();
  });

  it("copies a notice unchanged, marker included", async () => {
    const body = `${ASSISTANT_NOTIFY_MESSAGE_PREFIX}\n\n自由文本`;
    mount(user(body));
    fireEvent.click(screen.getByTitle("Copy message"));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(body));
  });
});
