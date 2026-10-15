import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
  const view = render(
    <I18nProvider>
      <SubagentActivityCard
        activities={props.activities ?? [RUNNING, COMPLETED]}
        todos={props.todos ?? TODOS}
        {...(props.queuedMessages === undefined ? {} : { queuedMessages: props.queuedMessages })}
        {...(props.onSteerQueued === undefined ? {} : { onSteerQueued: props.onSteerQueued })}
        {...(props.onRecallQueue === undefined ? {} : { onRecallQueue: props.onRecallQueue })}
        onOpenActivity={onOpenActivity}
        onOpenDirectory={onOpenDirectory}
      />
    </I18nProvider>,
  );
  return { ...view, onOpenActivity, onOpenDirectory };
}

describe("SubagentActivityCard", () => {
  afterEach(() => {
    cleanup();
  });

  it("stays absent when the selected session has no todos, agent activity, or queued messages", () => {
    const { container } = render(
      <I18nProvider>
        <SubagentActivityCard activities={[]} todos={[]} onOpenActivity={() => undefined} onOpenDirectory={() => undefined} />
      </I18nProvider>,
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows the capsule for queued messages alone and lists them in the card", () => {
    const onSteerQueued = vi.fn();
    const onRecallQueue = vi.fn();
    renderCard({
      activities: [],
      todos: [],
      queuedMessages: { steering: ["steer me now"], followUp: ["after this turn"] },
      onSteerQueued,
      onRecallQueue,
    });
    const capsule = screen.getByRole("button", { name: "Expand status" });
    expect(capsule.textContent).toContain("2 queued");
    expect(capsule.querySelector(".status-capsule-queue")).toBeNull();

    fireEvent.click(capsule);
    const section = screen.getByTestId("status-queue-section");
    expect(within(section).getByText("Queued")).toBeTruthy();
    expect(within(section).getByText("steer me now")).toBeTruthy();
    expect(within(section).getByText("after this turn")).toBeTruthy();

    fireEvent.click(within(section).getByText("steer me now"));
    expect(within(section).getByText("steer me now").className).toContain("is-expanded");

    fireEvent.click(within(section).getAllByRole("button", { name: "Steer this message now" })[1]!);
    expect(onSteerQueued).toHaveBeenCalledWith(1);
    fireEvent.click(within(section).getByRole("button", { name: "Recall to input" }));
    expect(onRecallQueue).toHaveBeenCalledOnce();
  });

  it("counts queued messages beside the todo and agent counts", () => {
    renderCard({ queuedMessages: { steering: [], followUp: ["later"] } });
    const capsule = screen.getByRole("button", { name: "Expand status" });
    const queue = within(capsule).getByText("1 queued");
    expect(queue.className).toBe("status-capsule-queue");
    expect(capsule.textContent).toContain("Ship the panel");
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
          onOpenActivity={() => undefined}
          onOpenDirectory={() => undefined}
        />
      </I18nProvider>,
    );
    expect(screen.getByRole("button", { name: "Expand status" }).textContent).toContain("Ended 1");
  });

  it("carries the todo completion count and running-agent count on the capsule", () => {
    renderCard();
    const capsule = screen.getByRole("button", { name: "Expand status" });
    expect(within(capsule).getByText("1/3")).toBeTruthy();
    const agents = within(capsule).getByText("1");
    expect(agents.className).toBe("status-capsule-agents");
    expect(agents.getAttribute("title")).toBe("1 running");
  });

  it("omits the capsule counts when there are no todos and no running agents", () => {
    renderCard({ todos: [], activities: [COMPLETED] });
    const capsule = screen.getByRole("button", { name: "Expand status" });
    expect(capsule.querySelector(".status-capsule-count")).toBeNull();
    expect(capsule.querySelector(".status-capsule-agents")).toBeNull();
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
    const ended = screen.getByRole("button", { name: /Ended/ });
    ended.focus();
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => {
      ended.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(capsule.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(capsule);
  });

  it("renders the flat todo list with honest statuses and no section headers", () => {
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Expand status" }));
    const progress = screen.getByTestId("status-progress-section");
    expect(within(progress).getByText("Write the capsule").closest("[data-todo-status='completed']")).toBeTruthy();
    expect(within(progress).getByText("Ship the panel").closest("[data-todo-status='in_progress']")).toBeTruthy();
    expect(within(progress).getByText("Polish later").closest("[data-todo-status='pending']")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Progress" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Agents" })).toBeNull();
  });

  it("lists running agents in two-line rows with the short model name and keeps the ended entry", () => {
    const { onOpenActivity, onOpenDirectory } = renderCard();
    fireEvent.click(screen.getByRole("button", { name: "Expand status" }));
    const agents = screen.getByTestId("status-agents-section");
    expect(within(agents).getByText("Inspect runtime")).toBeTruthy();
    const meta = within(agents).getByText("claude-sonnet-4").closest(".subagent-activity-meta");
    expect(meta?.getAttribute("title")).toBe("anthropic/claude-sonnet-4 · Explore");
    expect(within(meta as HTMLElement).getByText("Explore")).toBeTruthy();
    expect(within(agents).queryByText("anthropic/claude-sonnet-4")).toBeNull();
    expect(within(agents).queryByText("Check tests")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open agent Inspect runtime" }));
    expect(onOpenActivity).toHaveBeenCalledWith(RUNNING);
    fireEvent.click(screen.getByRole("button", { name: /Ended/ }));
    expect(onOpenDirectory).toHaveBeenCalledOnce();
  });

  it.each(["completed", "failed", "partial", "stopped"] as const)("hides the agents section for %s-only activity and preserves the ended entry", (status) => {
    const { onOpenDirectory } = renderCard({ activities: [{ ...COMPLETED, status }], todos: [] });
    fireEvent.click(screen.getByRole("button", { name: "Expand status" }));
    expect(screen.queryByTestId("status-agents-section")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Ended/ }));
    expect(onOpenDirectory).toHaveBeenCalledOnce();
  });

  it("omits the model span when the running task has none", () => {
    const { model: _model, ...withoutModel } = RUNNING;
    renderCard({ activities: [withoutModel], todos: [] });
    fireEvent.click(screen.getByRole("button", { name: "Expand status" }));
    expect(screen.getByText("Inspect runtime")).toBeTruthy();
    expect(screen.getByText("Explore")).toBeTruthy();
    expect(screen.queryByText("claude-sonnet-4")).toBeNull();
  });

  it("keeps progress without an empty agents section when there are no children", () => {
    renderCard({ activities: [] });
    fireEvent.click(screen.getByRole("button", { name: "Expand status" }));
    expect(screen.getByTestId("status-progress-section")).toBeTruthy();
    expect(screen.queryByTestId("status-agents-section")).toBeNull();
    expect(screen.queryByRole("button", { name: /Ended/ })).toBeNull();
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
    renderCard({ todos });
    fireEvent.click(screen.getByRole("button", { name: "Expand status" }));
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
