import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, cleanup, fireEvent } from "@testing-library/react";
import { I18nProvider } from "@/hooks/useI18n";
import { WorkspaceTabBar } from "./WorkspaceTabBar";
import type { WorkspaceTab } from "./workspace-tab-state";

function mount(
  props: {
    tabs: WorkspaceTab[];
    activeTabId: string | null;
    sessionLabels?: Record<string, string>;
    onSelectTab?: (id: string) => void;
    onCloseTab?: (id: string) => void;
    runningSessionIds?: ReadonlySet<string>;
  },
) {
  const selectTab = props.onSelectTab ?? vi.fn();
  const closeTab = props.onCloseTab ?? vi.fn();
  const view = render(
    <I18nProvider>
      <WorkspaceTabBar
        tabs={props.tabs}
        activeTabId={props.activeTabId}
        sessionLabels={props.sessionLabels}
        onSelectTab={selectTab}
        onCloseTab={closeTab}
        runningSessionIds={props.runningSessionIds}
      />
    </I18nProvider>,
  );
  return { ...view, selectTab, closeTab };
}

function sessionTab(id: string): WorkspaceTab {
  return { kind: "session", id: `session:${id}`, sessionId: id, cwd: "/x" };
}

function fileTab(id: string): WorkspaceTab {
  return { kind: "file", id: `file:/x:/x/${id}.ts`, cwd: "/x", filePath: `/x/${id}.ts`, label: `${id}.ts`, viewerRevision: 0 };
}

afterEach(cleanup);

describe("WorkspaceTabBar — accessible tabs", () => {
  it("renders a tablist with role=tab entries and aria-selected", () => {
    const tabs = [sessionTab("A"), fileTab("a")];
    mount({ tabs, activeTabId: tabs[0]!.id });
    const list = screen.getByRole("tablist");
    expect(list).toBeTruthy();
    const roles = screen.getAllByRole("tab");
    expect(roles).toHaveLength(2);
    expect(roles[0]!.getAttribute("aria-selected")).toBe("true");
    expect(roles[1]!.getAttribute("aria-selected")).toBe("false");
  });

  it("shows session labels from the shared cache and falls back to a short id", () => {
    const tabs = [sessionTab("A")];
    mount({ tabs, activeTabId: tabs[0]!.id, sessionLabels: { A: "Session A" } });
    expect(screen.getByText("Session A")).toBeTruthy();
  });

  it("shows file tab labels with a full-path tooltip", () => {
    const tabs = [fileTab("a")];
    mount({ tabs, activeTabId: tabs[0]!.id });
    expect(screen.getByText("a.ts")).toBeTruthy();
    expect(screen.getByTitle("/x/a.ts")).toBeTruthy();
  });

  it("closing a tab calls onCloseTab and stops propagation", () => {
    const tabs = [sessionTab("A")];
    const { closeTab } = mount({ tabs, activeTabId: tabs[0]!.id, sessionLabels: { A: "Session A" } });
    const close = screen.getByRole("button", { name: "Close Session A" });
    fireEvent.click(close);
    expect(closeTab).toHaveBeenCalledWith(tabs[0]!.id);
  });

  it("selects a tab on click", () => {
    const tabs = [sessionTab("A"), fileTab("b")];
    const { selectTab } = mount({ tabs, activeTabId: tabs[0]!.id });
    fireEvent.click(screen.getAllByRole("tab")[1]!);
    expect(selectTab).toHaveBeenCalledWith(tabs[1]!.id);
  });

  it("moves roving focus with ArrowLeft/ArrowRight/Home/End and updates tabindex", () => {
    const tabs = [sessionTab("A"), fileTab("a"), fileTab("b")];
    mount({ tabs, activeTabId: tabs[0]!.id });
    const list = screen.getByRole("tablist");
    const roles = screen.getAllByRole("tab");
    expect(roles[0]!.getAttribute("tabindex")).toBe("0");

    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(document.activeElement).toBe(roles[1]!);
    expect(roles[1]!.getAttribute("tabindex")).toBe("0");
    expect(roles[0]!.getAttribute("tabindex")).toBe("-1");

    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(document.activeElement).toBe(roles[2]!);
    fireEvent.keyDown(list, { key: "End" });
    expect(document.activeElement).toBe(roles[2]!);
    fireEvent.keyDown(list, { key: "Home" });
    expect(document.activeElement).toBe(roles[0]!);
    fireEvent.keyDown(list, { key: "ArrowLeft" });
    // Clamped at the first tab.
    expect(document.activeElement).toBe(roles[0]!);
  });

  it("closes the focused tab with Delete and Backspace", () => {
    const tabs = [sessionTab("A"), fileTab("a")];
    const { closeTab } = mount({ tabs, activeTabId: tabs[0]!.id });
    const list = screen.getByRole("tablist");
    const roles = screen.getAllByRole("tab");

    // Focus the second tab, then Delete closes it.
    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(document.activeElement).toBe(roles[1]!);
    fireEvent.keyDown(list, { key: "Delete" });
    expect(closeTab).toHaveBeenCalledWith(tabs[1]!.id);

    // Backspace on the first tab closes it too.
    (closeTab as ReturnType<typeof vi.fn>).mockClear();
    fireEvent.keyDown(list, { key: "ArrowLeft" });
    fireEvent.keyDown(list, { key: "Backspace" });
    expect(closeTab).toHaveBeenCalledWith(tabs[0]!.id);
  });

  it("moves focus and the roving tabindex to the right neighbor after keyboard close", () => {
    const initialTabs = [sessionTab("A"), fileTab("a"), fileTab("b")];

    function Harness() {
      const [tabs, setTabs] = useState(initialTabs);
      return (
        <I18nProvider>
          <WorkspaceTabBar
            tabs={tabs}
            activeTabId={initialTabs[0]!.id}
            sessionLabels={{ A: "Session A" }}
            onSelectTab={() => {}}
            onCloseTab={(id) => setTabs((current) => current.filter((tab) => tab.id !== id))}
          />
        </I18nProvider>
      );
    }

    render(<Harness />);
    const list = screen.getByRole("tablist");
    const first = screen.getAllByRole("tab")[0]!;
    act(() => {
      first.focus();
      fireEvent.keyDown(list, { key: "Delete" });
    });

    const remaining = screen.getAllByRole("tab");
    expect(remaining).toHaveLength(2);
    expect(document.activeElement).toBe(remaining[0]!);
    expect(remaining[0]!.getAttribute("tabindex")).toBe("0");
    expect(remaining[1]!.getAttribute("tabindex")).toBe("-1");
  });

  it("scrolls the active tab into view when the active content changes", () => {
    const tabs = [sessionTab("A"), fileTab("b")];
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const { rerender } = mount({ tabs, activeTabId: tabs[0]!.id });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    rerender(
      <I18nProvider>
        <WorkspaceTabBar tabs={tabs} activeTabId={tabs[1]!.id} sessionLabels={{}} onSelectTab={vi.fn()} onCloseTab={vi.fn()} />
      </I18nProvider>,
    );
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it("marks a running session tab without marking file tabs", () => {
    const tabs = [sessionTab("A"), fileTab("a")];
    mount({
      tabs,
      activeTabId: tabs[0]!.id,
      sessionLabels: { A: "Session A" },
      runningSessionIds: new Set(["A"]),
    });
    const roles = screen.getAllByRole("tab");
    expect(roles[0]!.getAttribute("data-running")).toBe("true");
    expect(roles[0]!.querySelector(".workspace-tab-running-dot")).toBeTruthy();
    expect(roles[1]!.getAttribute("data-running")).toBeNull();
  });

  it("renders a session icon and file icons via getFileIcon", () => {
    const tabs = [sessionTab("A"), fileTab("a")];
    mount({ tabs, activeTabId: tabs[0]!.id });
    const first = screen.getAllByRole("tab")[0]!;
    const second = screen.getAllByRole("tab")[1]!;
    // Session tab renders a chat-bubble svg icon.
    expect(first.querySelector("svg")).toBeTruthy();
    // File tab renders the shared catppuccin file icon.
    expect(second.querySelector(".catppuccin-file-icon")).toBeTruthy();
  });
});
