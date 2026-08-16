import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@/hooks/useI18n";
import { SessionInfoBar, type SessionInfoBarProps } from "./SessionInfoBar";
import type { ChatSessionStatsView } from "./chat-runtime-view";

function renderBar(props: Partial<SessionInfoBarProps> = {}) {
  const defaults: SessionInfoBarProps = {
    systemPrompt: null,
    sessionStats: null,
    contextUsage: null,
    hasSession: true,
    showChat: true,
  };
  return render(<I18nProvider><SessionInfoBar {...defaults} {...props} /></I18nProvider>);
}

function stats(overrides: Partial<ChatSessionStatsView> = {}): ChatSessionStatsView {
  return {
    sessionId: "s1",
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
    contextUsage: null,
    ...overrides,
  };
}

const historyLabel = "View full history";

describe("SessionInfoBar — history button gating (F3)", () => {
  it("renders the history button only when hasSession AND onViewFullHistory are present", () => {
    const onViewFullHistory = vi.fn();
    renderBar({ hasSession: true, onViewFullHistory });
    const btn = screen.getByLabelText(historyLabel);
    expect(btn).toBeTruthy();
    fireEvent.click(btn);
    expect(onViewFullHistory).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("never renders the history button without a handler (Host has no export route)", () => {
    renderBar({ hasSession: true });
    expect(screen.queryByLabelText(historyLabel)).toBeNull();
    cleanup();
  });

  it("never renders the history button when there is no session even with a handler", () => {
    renderBar({ hasSession: false, onViewFullHistory: vi.fn() });
    expect(screen.queryByLabelText(historyLabel)).toBeNull();
    cleanup();
  });
});

describe("SessionInfoBar — real-stats gating + popover (F4)", () => {
  it("shows the stats button when real total tokens exist even if input/output are 0, and opens the popover", () => {
    const sessionStats = stats({
      userMessages: 2,
      assistantMessages: 2,
      totalMessages: 4,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 12345 },
      contextUsage: { percent: 50, contextWindow: 200_000, tokens: 100_000 },
    });
    renderBar({ sessionStats, contextUsage: sessionStats.contextUsage });
    const statsBtn = screen.getByLabelText("Session info");
    expect(statsBtn).toBeTruthy();
    fireEvent.click(statsBtn);
    // The popover opens and shows the honest total (and context) rows.
    expect(screen.getAllByText("Total").length).toBeGreaterThan(0);
    expect(screen.getByText("12,345")).toBeTruthy();
    cleanup();
  });

  it("shows the stats button when only real message counts exist (no tokens/context)", () => {
    const sessionStats = stats({ userMessages: 1, assistantMessages: 1, totalMessages: 2 });
    renderBar({ sessionStats, contextUsage: null });
    const statsBtn = screen.getByLabelText("Session info");
    expect(statsBtn).toBeTruthy();
    fireEvent.click(statsBtn);
    expect(screen.getAllByText("Total").length).toBeGreaterThan(0);
    expect(screen.getByText("2")).toBeTruthy();
    cleanup();
  });

  it("shows the stats button when only real context exists (no tokens/messages)", () => {
    const sessionStats = stats({
      contextUsage: { percent: 10, contextWindow: 100_000, tokens: 10_000 },
    });
    renderBar({ sessionStats, contextUsage: sessionStats.contextUsage });
    expect(screen.getByLabelText("Session info")).toBeTruthy();
    cleanup();
  });

  it("hides the stats button for an empty session with no real stats", () => {
    renderBar({ sessionStats: stats(), contextUsage: null, hasSession: true });
    expect(screen.queryByLabelText("Session info")).toBeNull();
    cleanup();
  });

  it("never renders the stats button when sessionStats is null", () => {
    renderBar({ sessionStats: null, contextUsage: null });
    expect(screen.queryByLabelText("Session info")).toBeNull();
    cleanup();
  });
});
