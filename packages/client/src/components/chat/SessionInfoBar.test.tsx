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

describe("SessionInfoBar — composer footer controls", () => {
  it("renders and toggles the completion-sound button", () => {
    const onSoundToggle = vi.fn();
    renderBar({ soundEnabled: true, onSoundToggle });
    const button = screen.getByLabelText("Disable completion sound");
    fireEvent.click(button);
    expect(onSoundToggle).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("renders the compact action for a selected session", () => {
    const onCompact = vi.fn();
    renderBar({ hasSession: true, onCompact });
    const button = screen.getByLabelText("Compact context");
    fireEvent.click(button);
    expect(onCompact).toHaveBeenCalledTimes(1);
    cleanup();
  });
});

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
  it("keeps exact context tokens and window visible instead of rounding the denominator to M", () => {
    const tokens = 796_285;
    const contextWindow = 1_050_000;
    const percent = tokens / contextWindow * 100;
    renderBar({ sessionStats: stats(), contextUsage: { tokens, contextWindow, percent } });
    const button = screen.getByLabelText("Session info");
    const exact = `75.8% ${tokens.toLocaleString()}/${contextWindow.toLocaleString()}`;
    expect(button.title).toContain(exact);
    expect(button.title).not.toContain("1.1M");
    expect(screen.getByText("76%")).toBeTruthy();
    fireEvent.click(button);
    expect(screen.getByText(exact)).toBeTruthy();
    cleanup();
  });

  it("does not restore stale stats context in the popover when displayed context is unknown", () => {
    renderBar({
      contextUsage: null,
      sessionStats: stats({
        tokens: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
        contextUsage: { percent: 80, contextWindow: 1_000_000, tokens: 800_000 },
      }),
    });
    fireEvent.click(screen.getByLabelText("Session info"));
    expect(screen.queryByText("Context")).toBeNull();
    expect(document.querySelector(".session-info-bar-popover")?.textContent).not.toContain("80.0%");
    expect(document.querySelector(".session-info-bar-donut")).toBeNull();
    cleanup();
  });

  it("identifies a selected-model estimate in both the footer and the popover", () => {
    renderBar({ sessionStats: stats(), contextUsage: { percent: 26.3711, tokens: 263_711, contextWindow: 1_000_000, estimated: true } });
    const button = screen.getByLabelText("Session info");
    expect(screen.getByText("26%")).toBeTruthy();
    expect(button.title).toContain("Estimated context for selected model: 26.4%");
    fireEvent.click(button);
    expect(screen.getByText("Estimated context for selected model")).toBeTruthy();
    cleanup();
  });
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
    expect(screen.getByText("50%")).toBeTruthy();
    fireEvent.click(statsBtn);
    // The popover opens and shows the honest total (and context) rows.
    expect(screen.getAllByText("Total").length).toBeGreaterThan(0);
    expect(screen.getByText("12,345")).toBeTruthy();
    cleanup();
  });

  it("keeps total-only/message-only stats out of the compact footer", () => {
    const sessionStats = stats({
      userMessages: 1,
      assistantMessages: 1,
      totalMessages: 2,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 999 },
    });
    renderBar({ sessionStats, contextUsage: null });
    expect(screen.queryByLabelText("Session info")).toBeNull();
    expect(screen.queryByText("999")).toBeNull();
    cleanup();
  });

  it("shows only input, output, combined cache and context percent in the footer summary", () => {
    const sessionStats = stats({
      tokens: { input: 100, output: 20, cacheRead: 40, cacheWrite: 10, total: 999 },
      contextUsage: { percent: 55, contextWindow: 200_000, tokens: 110_000 },
    });
    renderBar({ sessionStats, contextUsage: sessionStats.contextUsage });
    expect(screen.getByText("100")).toBeTruthy();
    expect(screen.getByText("20")).toBeTruthy();
    expect(screen.getByText("50")).toBeTruthy();
    expect(screen.getByText("55%")).toBeTruthy();
    expect(screen.queryByText("999")).toBeNull();
    expect(screen.queryByText("$0.00")).toBeNull();
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
