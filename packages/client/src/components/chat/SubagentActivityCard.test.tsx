import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  const view = render(
    <I18nProvider>
      <SubagentActivityCard
        activities={props.activities ?? [RUNNING, COMPLETED]}
        todos={props.todos ?? TODOS}
        {...(props.queuedMessages === undefined ? {} : { queuedMessages: props.queuedMessages })}
        {...(props.onToggleQueuedDelivery === undefined ? {} : { onToggleQueuedDelivery: props.onToggleQueuedDelivery })}
        {...(props.queueSwitchError === undefined ? {} : { queueSwitchError: props.queueSwitchError })}
        {...(props.onRecallQueue === undefined ? {} : { onRecallQueue: props.onRecallQueue })}
        onOpenActivity={onOpenActivity}
      />
    </I18nProvider>,
  );
  return { ...view, onOpenActivity };
}

describe("SubagentActivityCard", () => {
  // The tab reports its own width to the shared shape box; jsdom has no
  // ResizeObserver and no layout, so the observer is a no-op here.
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  beforeEach(() => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub;
  });

  afterEach(() => {
    cleanup();
  });

  it("stays absent when the selected session has no todos, agent activity, or queued messages", () => {
    const { container } = render(
      <I18nProvider>
        <SubagentActivityCard activities={[]} todos={[]} onOpenActivity={() => undefined} />
      </I18nProvider>,
    );
    expect(container.firstChild).toBeNull();
  });

  it("lists queued rows in delivery order with their type labels, and a label click toggles the type", () => {
    const onToggleQueuedDelivery = vi.fn();
    const onRecallQueue = vi.fn();
    renderCard({
      activities: [],
      todos: [],
      queuedMessages: { steering: ["steer me now", "second steer"], followUp: ["after this turn"] },
      onToggleQueuedDelivery,
      onRecallQueue,
    });
    const capsule = screen.getByRole("button", { name: "Expand status" });
    expect(capsule.textContent).toContain("3 queued");
    expect(capsule.querySelector(".status-capsule-queue")).toBeNull();

    fireEvent.click(capsule);
    const section = screen.getByTestId("status-queue-section");
    expect(within(section).getByText("Queued")).toBeTruthy();
    // Rows render steering entries first (delivery order), then follow-ups.
    const rows = within(section).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      "steer me nowSteer",
      "second steerSteer",
      "after this turnQueue",
    ]);
    // The message body sits on the left; the delivery-type label sits on the right.
    expect(
      rows.map((row) => Array.from(row.querySelectorAll("button")).map((button) => button.className)),
    ).toEqual([
      ["status-queue-text", "status-queue-kind is-steer"],
      ["status-queue-text", "status-queue-kind is-steer"],
      ["status-queue-text", "status-queue-kind is-follow-up"],
    ]);
    const labels = within(section).getAllByRole("button", { name: /Steer: inserted|Queue: sent/ });
    expect(labels.map((label) => label.className)).toEqual([
      "status-queue-kind is-steer",
      "status-queue-kind is-steer",
      "status-queue-kind is-follow-up",
    ]);

    // Clicking a text row still expands it; clicking a label toggles the type.
    fireEvent.click(within(section).getByText("steer me now"));
    expect(within(section).getByText("steer me now").className).toContain("is-expanded");
    fireEvent.click(labels[2]!);
    expect(onToggleQueuedDelivery).toHaveBeenCalledWith(2);
    fireEvent.click(within(section).getByRole("button", { name: "Recall to input" }));
    expect(onRecallQueue).toHaveBeenCalledOnce();
  });

  it("renders the queue-switch failure notice inside the queue section", () => {
    renderCard({
      activities: [],
      todos: [],
      queuedMessages: { steering: [], followUp: ["later"] },
      onToggleQueuedDelivery: () => undefined,
      queueSwitchError: "Could not switch the message type; restored",
    });
    fireEvent.click(screen.getByRole("button", { name: "Expand status" }));
    const section = screen.getByTestId("status-queue-section");
    expect(within(section).getByRole("alert").textContent).toBe("Could not switch the message type; restored");
  });

  it("counts queued messages beside the todo and agent counts", () => {
    renderCard({ queuedMessages: { steering: [], followUp: ["later"] } });
    const capsule = screen.getByRole("button", { name: "Expand status" });
    // The queued segment reads like the agent counts — an icon plus the number —
    // with the full sentence in its accessible name, so it never needs clipping.
    const queue = capsule.querySelector(".status-capsule-queue") as HTMLElement;
    expect(queue.textContent).toBe("1");
    expect(queue.getAttribute("title")).toBe("1 queued");
    expect(queue.getAttribute("aria-label")).toBe("1 queued");
    expect(queue.querySelector("svg")).toBeTruthy();
    expect(capsule.textContent).toContain("Ship the panel");
  });

  it("summarizes the first in-progress todo ahead of pending, completed, and agent counts", () => {
    renderCard();
    expect(screen.getByRole("button", { name: "Expand status" }).textContent).toContain("Ship the panel");
    expect(screen.getByRole("button", { name: "Expand status" }).textContent).not.toContain("1 running");
    expect(screen.getByRole("button", { name: "Expand status" }).textContent).not.toContain("Write the capsule");
  });

  it("puts todos first in the capsule, then agents, and stays with only ended agents", () => {
    const { rerender } = renderCard({
      todos: [{ id: 1, subject: "Write the capsule", status: "completed" }, { id: 2, subject: "Polish later", status: "pending" }],
      activities: [RUNNING, COMPLETED],
    });
    expect(screen.getByRole("button", { name: "Expand status" }).textContent).toContain("Polish later");
    const card = (activities: SubagentActivity[], todos: StatusTodoItem[]) => (
      <I18nProvider>
        <SubagentActivityCard activities={activities} todos={todos} onOpenActivity={() => undefined} />
      </I18nProvider>
    );
    rerender(card([RUNNING, COMPLETED], [{ id: 1, subject: "Write the capsule", status: "completed" }]));
    expect(screen.getByRole("button", { name: "Expand status" }).textContent).toContain("Write the capsule");
    rerender(card([RUNNING, COMPLETED], []));
    expect(screen.getByRole("button", { name: "Expand status" }).textContent).toContain("Agents");
    rerender(card([COMPLETED], []));
    expect(screen.getByRole("button", { name: "Expand status" }).textContent).toContain("Agents");
  });

  it("counts agents by state on the capsule: running, done, failed", () => {
    renderCard({
      activities: [RUNNING, COMPLETED, { ...COMPLETED, key: "p", taskId: "p", status: "partial" }, { ...COMPLETED, key: "f", taskId: "f", status: "failed" }, { ...COMPLETED, key: "s", taskId: "s", status: "stopped" }],
    });
    const capsule = screen.getByRole("button", { name: "Expand status" });
    expect(within(capsule).getByText("1/3")).toBeTruthy();
    expect(within(capsule).getByTitle("1 running").textContent).toBe("1");
    expect(within(capsule).getByTitle("2 done").textContent).toBe("2");
    expect(within(capsule).getByTitle("2 failed").textContent).toBe("2");
  });

  it("omits a state with no agents in it", () => {
    renderCard({ activities: [COMPLETED] });
    const capsule = screen.getByRole("button", { name: "Expand status" });
    expect(capsule.querySelector(".status-capsule-agent.is-running")).toBeNull();
    expect(capsule.querySelector(".status-capsule-agent.is-failed")).toBeNull();
    expect(capsule.querySelector(".status-capsule-agent.is-done")).toBeTruthy();
  });

  it("toggles the expanded card from the capsule as transient internal state", () => {
    renderCard();
    const capsule = screen.getByRole("button", { name: "Expand status" });
    expect(capsule.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("status-card-shell").querySelector(".status-card-panel")?.hasAttribute("inert")).toBe(true);

    fireEvent.click(capsule);
    expect(capsule.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("status-card-shell").querySelector(".status-card-panel")?.hasAttribute("inert")).toBe(false);
    expect(screen.getByTestId("status-progress-section")).toBeTruthy();

    // Tab and card never coexist: the tab leaves the tab order and the card's
    // own header (same summary + caret) collapses it back.
    expect(capsule.getAttribute("tabindex")).toBe("-1");
    const header = screen.getByRole("button", { name: "Show less" });
    expect(header.textContent).toContain(capsule.textContent ?? "");
    fireEvent.click(header);
    expect(capsule.getAttribute("aria-expanded")).toBe("false");
    expect(capsule.getAttribute("tabindex")).toBe("0");
    expect(screen.getByTestId("status-card-shell").querySelector(".status-card-panel")?.hasAttribute("inert")).toBe(true);
  });

  it("closes on outside pointer and Escape, but not on an inside pointer", () => {
    renderCard();
    const capsule = screen.getByRole("button", { name: "Expand status" });
    fireEvent.click(capsule);
    expect(capsule.getAttribute("aria-expanded")).toBe("true");

    fireEvent.pointerDown(screen.getByTestId("status-progress-section"));
    expect(capsule.getAttribute("aria-expanded")).toBe("true");

    fireEvent.pointerDown(document.body);
    expect(capsule.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(capsule);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(capsule.getAttribute("aria-expanded")).toBe("false");
  });

  it("removes its window listeners on unmount (later events change nothing)", () => {
    const { unmount } = renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Expand status" }));
    unmount();
    // No throw: listeners were removed with the component.
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerDown(document.body);
  });

  it("does not close when another modal already consumed Escape", () => {
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Expand status" }));
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    event.preventDefault();
    window.dispatchEvent(event);
    expect(screen.getByRole("button", { name: "Expand status" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("restores capsule focus when Escape closes a focused card", () => {
    renderCard();
    const capsule = screen.getByRole("button", { name: "Expand status" });
    fireEvent.click(capsule);
    const row = screen.getByRole("button", { name: "Open agent Inspect runtime" });
    row.focus();
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => {
      row.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(capsule.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(capsule);
  });

  it("folds done todos into one row and keeps the step in progress and what comes next", () => {
    renderCard({ activities: [] });
    fireEvent.click(screen.getByRole("button", { name: "Expand status" }));
    const progress = screen.getByTestId("status-progress-section");
    expect(within(progress).queryByText("To-do")).toBeNull();
    expect(within(progress).queryByText("Write the capsule")).toBeNull();
    fireEvent.click(within(progress).getByRole("button", { name: "1 done" }));
    expect(within(progress).getByText("Write the capsule").closest("[data-todo-status='completed']")).toBeTruthy();
    expect(within(progress).getByText("Ship the panel").closest("[data-todo-status='in_progress']")).toBeTruthy();
    expect(within(progress).getByText("Polish later").closest("[data-todo-status='pending']")).toBeTruthy();
  });

  it("lists running agents first, type before title, then recently ended ones with when they ended", () => {
    const { onOpenActivity } = renderCard({ activities: [{ ...COMPLETED, completedAt: Date.now() - 3 * 60_000 }, RUNNING] });
    fireEvent.click(screen.getByRole("button", { name: "Expand status" }));
    const agents = screen.getByTestId("status-agents-section");
    const note = within(agents).getByText("Explore");
    const title = within(agents).getByText("Inspect runtime");
    expect(note.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const ended = within(agents).getByText("Check tests");
    expect(title.compareDocumentPosition(ended) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(ended.closest(".subagent-activity-row")?.className).toContain("is-ended");
    expect(ended.closest(".subagent-activity-row")?.textContent).toContain("3m ago");
    fireEvent.click(screen.getByRole("button", { name: "Open agent Inspect runtime" }));
    expect(onOpenActivity).toHaveBeenCalledWith(RUNNING);
  });

  it("keeps only the five most recently ended agents", () => {
    const ended = [0, 1, 2, 3, 4, 5, 6].map((index) => ({ ...COMPLETED, key: `e${index}`, taskId: `e${index}`, title: `Ended ${index}`, completedAt: 1_000 + index }));
    renderCard({ activities: ended, todos: [] });
    fireEvent.click(screen.getByRole("button", { name: "Expand status" }));
    const titles = within(screen.getByTestId("status-agents-section")).getAllByText(/^Ended \d$/).map((node) => node.textContent);
    expect(titles).toEqual(["Ended 6", "Ended 5", "Ended 4", "Ended 3", "Ended 2"]);
  });

  it("shows the agent type as the one-line note", () => {
    const { model: _model, ...withoutModel } = RUNNING;
    renderCard({ activities: [withoutModel], todos: [] });
    fireEvent.click(screen.getByRole("button", { name: "Expand status" }));
    expect(screen.getByText("Inspect runtime")).toBeTruthy();
    expect(screen.getByText("Explore").className).toContain("subagent-activity-note");
  });

  it("keeps progress without an empty agents section when there are no children", () => {
    renderCard({ activities: [] });
    fireEvent.click(screen.getByRole("button", { name: "Expand status" }));
    expect(screen.getByTestId("status-progress-section")).toBeTruthy();
    expect(screen.queryByTestId("status-agents-section")).toBeNull();
  });

  it("keeps a running task pending until its validated child session arrives", () => {
    const { childSessionId: _childSessionId, ...pending } = RUNNING;
    const { rerender, onOpenActivity } = renderCard({ activities: [pending], todos: [] });
    fireEvent.click(screen.getByRole("button", { name: "Expand status" }));
    expect(screen.queryByRole("button", { name: "Open agent Inspect runtime" })).toBeNull();
    expect(screen.getByText("Inspect runtime").closest("[aria-disabled='true']")).toBeTruthy();

    rerender(
      <I18nProvider>
        <SubagentActivityCard
          activities={[RUNNING]}
          todos={[]}
          onOpenActivity={onOpenActivity}
         
        />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open agent Inspect runtime" }));
    expect(onOpenActivity).toHaveBeenCalledWith(RUNNING);
  });

  it("shows the next three pending todos and folds the rest behind N more", () => {
    const todos: StatusTodoItem[] = Array.from({ length: 10 }, (_, index) => ({
      id: index + 1,
      subject: `Item ${index + 1}`,
      status: index === 4 ? "in_progress" : index < 4 ? "completed" : "pending",
    }));
    renderCard({ todos, activities: [] });
    fireEvent.click(screen.getByRole("button", { name: "Expand status" }));
    const progress = screen.getByTestId("status-progress-section");
    expect(within(progress).getByRole("button", { name: "4 done" })).toBeTruthy();
    for (const index of [5, 6, 7, 8]) expect(within(progress).getByText(`Item ${index}`)).toBeTruthy();
    expect(within(progress).queryByText("Item 9")).toBeNull();
    fireEvent.click(within(progress).getByRole("button", { name: "2 more" }));
    expect(within(progress).getByText("Item 10")).toBeTruthy();
    expect(within(progress).queryByRole("button", { name: /more$/ })).toBeNull();
  });

  it("names sections only when the card has more than one", () => {
    renderCard({ todos: [], activities: [RUNNING] });
    fireEvent.click(screen.getByRole("button", { name: "Expand status" }));
    expect(within(screen.getByTestId("status-agents-section")).queryByText("Agents")).toBeNull();
    cleanup();
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Expand status" }));
    expect(within(screen.getByTestId("status-agents-section")).getByText("Agents")).toBeTruthy();
  });

});
