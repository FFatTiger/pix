import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/hooks/useI18n";
import type { StatusTodoItem, SubagentActivity } from "@/lib/subagent-activity";
import { SubagentActivityCard } from "./SubagentActivityCard";

const RUNNING: SubagentActivity = {
  key: "task:running",
  taskId: "running",
  title: "Inspect runtime",
  agentType: "Explore",
  model: "anthropic/claude-sonnet-4",
  status: "running",
  startedAt: Date.now() - 2_000,
  childSessionId: "child-running",
};

const COMPLETED: SubagentActivity = {
  key: "task:completed",
  taskId: "completed",
  title: "Check tests",
  agentType: "verification",
  status: "completed",
  childSessionId: "child-completed",
};

const TODOS: readonly StatusTodoItem[] = [
  { id: 1, subject: "Write the capsule", status: "completed" },
  { id: 2, subject: "Ship the panel", status: "in_progress" },
  { id: 3, subject: "Polish later", status: "pending" },
];

function renderCard(
  props: Partial<React.ComponentProps<typeof SubagentActivityCard>> = {},
) {
  const onOpenActivity = props.onOpenActivity ?? vi.fn();
  const onOpenDirectory = props.onOpenDirectory ?? vi.fn();
  const onDisplayModeChange = props.onDisplayModeChange ?? vi.fn();
  const view = render(
    <I18nProvider>
      <SubagentActivityCard
        activities={props.activities ?? [RUNNING, COMPLETED]}
        todos={props.todos ?? TODOS}
        displayMode={props.displayMode ?? "mini"}
        onDisplayModeChange={onDisplayModeChange}
        onOpenActivity={onOpenActivity}
        onOpenDirectory={onOpenDirectory}
      />
    </I18nProvider>,
  );
  return { ...view, onOpenActivity, onOpenDirectory, onDisplayModeChange };
}

describe("SubagentActivityCard", () => {
  afterEach(() => {
    cleanup();
  });

  it("stays absent when the selected session has no todos or agent activity", () => {
    const { container } = render(
      <I18nProvider>
        <SubagentActivityCard activities={[]} todos={[]} onOpenActivity={() => undefined} onOpenDirectory={() => undefined} />
      </I18nProvider>,
    );
    expect(container.firstChild).toBeNull();
  });

  it("summarizes the first in-progress todo ahead of pending, completed, and agent counts", () => {
    renderCard();
    expect(screen.getByRole("button", { name: "Expand status" }).textContent).toContain("Ship the panel");
    expect(screen.getByRole("button", { name: "Expand status" }).textContent).not.toContain("1 running");
    expect(screen.getByRole("button", { name: "Expand status" }).textContent).not.toContain("Write the capsule");
  });

  it("falls through capsule priority from pending todo to completed todo to running then ended agents", () => {
    const { rerender } = renderCard({
      todos: [{ id: 1, subject: "Write the capsule", status: "completed" }, { id: 2, subject: "Polish later", status: "pending" }],
      activities: [RUNNING, COMPLETED],
    });
    expect(screen.getByRole("button", { name: "Expand status" }).textContent).toContain("Polish later");

    rerender(
      <I18nProvider>
        <SubagentActivityCard
          activities={[RUNNING, COMPLETED]}
          todos={[{ id: 1, subject: "Write the capsule", status: "completed" }]}
          displayMode="mini"
          onDisplayModeChange={() => undefined}
          onOpenActivity={() => undefined}
          onOpenDirectory={() => undefined}
        />
      </I18nProvider>,
    );
    expect(screen.getByRole("button", { name: "Expand status" }).textContent).toContain("Write the capsule");

    rerender(
      <I18nProvider>
        <SubagentActivityCard
          activities={[RUNNING, COMPLETED]}
          todos={[]}
          displayMode="mini"
          onDisplayModeChange={() => undefined}
          onOpenActivity={() => undefined}
          onOpenDirectory={() => undefined}
        />
      </I18nProvider>,
    );
    expect(screen.getByRole("button", { name: "Expand status" }).textContent).toContain("1 running");

    rerender(
      <I18nProvider>
        <SubagentActivityCard
          activities={[COMPLETED]}
          todos={[]}
          displayMode="mini"
          onDisplayModeChange={() => undefined}
          onOpenActivity={() => undefined}
          onOpenDirectory={() => undefined}
        />
      </I18nProvider>,
    );
    expect(screen.getByRole("button", { name: "Expand status" }).textContent).toContain("Ended 1");
  });

  it("keeps the capsule visible and toggles panel from the same control", () => {
    const { onDisplayModeChange, rerender } = renderCard({ displayMode: "mini" });
    const capsule = screen.getByRole("button", { name: "Expand status" });
    expect(capsule.getAttribute("aria-expanded")).toBe("false");
    expect(capsule.getAttribute("title")).toBe("Ship the panel");
    expect(screen.getByRole("button", { name: "Progress" }).closest(".status-card-panel")?.hasAttribute("inert")).toBe(true);
    fireEvent.click(capsule);
    expect(onDisplayModeChange).toHaveBeenCalledWith("panel");

    rerender(
      <I18nProvider>
        <SubagentActivityCard
          activities={[RUNNING, COMPLETED]}
          todos={TODOS}
          displayMode="panel"
          onDisplayModeChange={onDisplayModeChange}
          onOpenActivity={() => undefined}
          onOpenDirectory={() => undefined}
        />
      </I18nProvider>,
    );
    const openCapsule = screen.getByRole("button", { name: "Expand status" });
    expect(openCapsule.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "Progress" })).toBeTruthy();
    fireEvent.click(openCapsule);
    expect(onDisplayModeChange).toHaveBeenCalledWith("mini");
  });

  it("keeps the panel open on outside pointer and closes only on Escape or the capsule", () => {
    const onDisplayModeChange = vi.fn();
    const { unmount } = renderCard({ displayMode: "panel", onDisplayModeChange });
    fireEvent.click(screen.getByRole("button", { name: "Progress" }));
    fireEvent.pointerDown(document.body);
    expect(onDisplayModeChange).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onDisplayModeChange).toHaveBeenCalledWith("mini");
    unmount();
    onDisplayModeChange.mockClear();
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerDown(document.body);
    expect(onDisplayModeChange).not.toHaveBeenCalled();
  });

  it("does not close when another modal already consumed Escape", () => {
    const onDisplayModeChange = vi.fn();
    renderCard({ displayMode: "panel", onDisplayModeChange });
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    event.preventDefault();
    window.dispatchEvent(event);
    expect(onDisplayModeChange).not.toHaveBeenCalled();
  });

  it("restores capsule focus when Escape closes a focused panel", () => {
    const onDisplayModeChange = vi.fn();
    renderCard({ displayMode: "panel", onDisplayModeChange });
    const progress = screen.getByRole("button", { name: "Progress" });
    progress.focus();
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    progress.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(onDisplayModeChange).toHaveBeenCalledOnce();
    expect(onDisplayModeChange).toHaveBeenCalledWith("mini");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Expand status" }));
  });

  it("keeps Progress open by default with honest statuses and count, and collapses on the header", () => {
    renderCard({ displayMode: "panel" });
    const heading = screen.getByRole("button", { name: "Progress" });
    expect(heading.getAttribute("aria-expanded")).toBe("true");
    expect(heading.textContent).toContain("1/3");
    const progress = screen.getByTestId("status-progress-section");
    expect(within(progress).getByText("Write the capsule").closest("[data-todo-status='completed']")).toBeTruthy();
    expect(within(progress).getByText("Ship the panel").closest("[data-todo-status='in_progress']")).toBeTruthy();
    expect(within(progress).getByText("Polish later").closest("[data-todo-status='pending']")).toBeTruthy();
    expect(within(progress).getByText("Write the capsule").closest("button")).toBeNull();

    fireEvent.click(heading);
    expect(heading.getAttribute("aria-expanded")).toBe("false");
    expect(within(progress).queryByText("Ship the panel")).toBeNull();
  });

  it("opens running Agents by default and keeps manual collapse until the next running batch", () => {
    const { onOpenActivity, onOpenDirectory, rerender } = renderCard({ displayMode: "panel" });
    const heading = screen.getByRole("button", { name: "Agents" });
    expect(heading.getAttribute("aria-expanded")).toBe("true");
    expect(heading.textContent).toContain("1 running");
    expect(screen.getByText("Inspect runtime")).toBeTruthy();
    expect(screen.getByText("anthropic/claude-sonnet-4")).toBeTruthy();
    expect(screen.queryByText("Check tests")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open agent Inspect runtime" }));
    expect(onOpenActivity).toHaveBeenCalledWith(RUNNING);
    fireEvent.click(screen.getByRole("button", { name: /Ended/ }));
    expect(onOpenDirectory).toHaveBeenCalledOnce();

    fireEvent.click(heading);
    expect(heading.getAttribute("aria-expanded")).toBe("false");
    const card = (activities: readonly SubagentActivity[]) => (
      <I18nProvider>
        <SubagentActivityCard activities={activities} todos={TODOS} displayMode="panel" onOpenActivity={onOpenActivity} onOpenDirectory={onOpenDirectory} />
      </I18nProvider>
    );
    rerender(card([{ ...RUNNING, title: "Updated progress" }, COMPLETED]));
    expect(heading.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Updated progress")).toBeNull();
    rerender(card([COMPLETED]));
    expect(screen.queryByRole("button", { name: "Agents" })).toBeNull();
    rerender(card([{ ...RUNNING, key: "task:next", taskId: "next" }, COMPLETED]));
    expect(screen.getByRole("button", { name: "Agents" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Inspect runtime")).toBeTruthy();
  });

  it.each(["completed", "failed", "partial", "stopped"] as const)("hides the Agents section for %s-only activity and preserves the ended entry", (status) => {
    const { onOpenDirectory } = renderCard({ activities: [{ ...COMPLETED, status }], todos: [], displayMode: "panel" });
    expect(screen.queryByTestId("status-agents-section")).toBeNull();
    expect(screen.queryByRole("button", { name: "Agents" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Ended/ }));
    expect(onOpenDirectory).toHaveBeenCalledOnce();
  });

  it("omits the actual model line when the running task has none", () => {
    const { model: _model, ...withoutModel } = RUNNING;
    renderCard({ activities: [withoutModel], todos: [], displayMode: "panel" });
    expect(screen.getByText("Inspect runtime")).toBeTruthy();
    expect(screen.getByText("Explore")).toBeTruthy();
    expect(screen.queryByText("anthropic/claude-sonnet-4")).toBeNull();
  });

  it("keeps progress without an empty Agents section when there are no children", () => {
    renderCard({ activities: [], displayMode: "panel" });
    expect(screen.getByTestId("status-progress-section")).toBeTruthy();
    expect(screen.queryByTestId("status-agents-section")).toBeNull();
    expect(screen.queryByRole("button", { name: /Ended/ })).toBeNull();
  });

  it("keeps a running task pending until its validated child session arrives", () => {
    const { childSessionId: _childSessionId, ...pending } = RUNNING;
    const { rerender, onOpenActivity } = renderCard({ activities: [pending], todos: [], displayMode: "panel" });
    expect(screen.getByRole("button", { name: "Agents" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByRole("button", { name: "Open agent Inspect runtime" })).toBeNull();
    expect(screen.getByText("Inspect runtime").closest("[aria-disabled='true']")).toBeTruthy();

    rerender(
      <I18nProvider>
        <SubagentActivityCard
          activities={[RUNNING]}
          todos={[]}
          displayMode="panel"
          onDisplayModeChange={() => undefined}
          onOpenActivity={onOpenActivity}
          onOpenDirectory={() => undefined}
        />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open agent Inspect runtime" }));
    expect(onOpenActivity).toHaveBeenCalledWith(RUNNING);
  });

  it("renders earlier/later count rows around a three-item focus window", () => {
    const todos: StatusTodoItem[] = Array.from({ length: 8 }, (_, index) => ({
      id: index + 1,
      subject: `Item ${index + 1}`,
      status: index === 4 ? "in_progress" : index < 4 ? "completed" : "pending",
    }));
    renderCard({ todos, displayMode: "panel" });
    const progress = screen.getByTestId("status-progress-section");
    expect(within(progress).getByText("3 earlier")).toBeTruthy();
    expect(within(progress).getByText("Item 4")).toBeTruthy();
    expect(within(progress).getByText("Item 5")).toBeTruthy();
    expect(within(progress).getByText("Item 6")).toBeTruthy();
    expect(within(progress).queryByText("Item 1")).toBeNull();
    expect(within(progress).queryByText("Item 7")).toBeNull();
    expect(within(progress).queryByText("Item 8")).toBeNull();
    expect(within(progress).getByText("2 later")).toBeTruthy();

    const more = within(progress).getByRole("button", { name: "2 later" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(more.getAttribute("aria-controls")).toBe("status-progress-body");
    fireEvent.click(more);
    for (let index = 1; index <= 8; index += 1) {
      expect(within(progress).getByText(`Item ${index}`)).toBeTruthy();
    }
    const fewer = within(progress).getByRole("button", { name: "Show less" });
    expect(fewer.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(fewer);
    expect(within(progress).queryByText("Item 1")).toBeNull();
    expect(within(progress).queryByText("Item 8")).toBeNull();
    fireEvent.click(within(progress).getByRole("button", { name: "3 earlier" }));
    expect(within(progress).getByText("Item 1")).toBeTruthy();
    expect(within(progress).getByText("Item 8")).toBeTruthy();
  });
});
