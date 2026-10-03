import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SubagentArtifactObserver, type SubagentWatchHandle } from "../src/internal/subagent-observer.js";
import type { SubagentObservation } from "../src/internal/subagent-projection.js";

interface FakeWatch {
  readonly directory: string;
  readonly change: (basename: string | null) => void;
  readonly error: (error: unknown) => void;
  closed: boolean;
}

function task(description: string, childSessionId?: string) {
  return {
    taskId: "task-1",
    description,
    agentType: "explore",
    status: "running" as const,
    ...(childSessionId === undefined ? {} : { childSessionId }),
  };
}

function observation(input: {
  description?: string;
  childSessionId?: string;
  signature?: string;
  withTask?: boolean;
} = {}): SubagentObservation {
  const withTask = input.withTask ?? true;
  return {
    tasks: withTask ? [task(input.description ?? "inspect", input.childSessionId)] : [],
    watchTargets: withTask
      ? [
          { directory: "/tasks/parent", basenames: null },
          { directory: "/tasks/parent/task-1", basenames: ["task.json"] },
          { directory: "/sessions/project", basenames: ["child.jsonl"] },
        ]
      : [{ directory: "/tasks/parent", basenames: null }],
    childSignatures: input.signature === undefined ? [] : [input.signature],
  };
}

function harness(initial: SubagentObservation) {
  let current = initial;
  let readError: unknown;
  const watches: FakeWatch[] = [];
  const scheduled: Array<() => void> = [];
  const samples: Array<{ observation: SubagentObservation; publish: boolean }> = [];
  const errors: unknown[] = [];
  const observer = new SubagentArtifactObserver({
    read: () => {
      if (readError !== undefined) throw readError;
      return current;
    },
    onObservation: (next, publish) => samples.push({ observation: next, publish }),
    onError: (error) => errors.push(error),
    watchDirectory: (directory, change, error): SubagentWatchHandle => {
      const row: FakeWatch = { directory, change, error, closed: false };
      watches.push(row);
      return { close: () => { row.closed = true; } };
    },
    schedule: (run) => {
      scheduled.push(run);
      return () => {
        const index = scheduled.indexOf(run);
        if (index >= 0) scheduled.splice(index, 1);
      };
    },
  });
  const activeWatch = (directory: string) => [...watches].reverse().find((row) => row.directory === directory && !row.closed)!;
  const flush = () => {
    const queued = scheduled.splice(0);
    for (const run of queued) run();
  };
  return {
    observer,
    watches,
    samples,
    errors,
    activeWatch,
    flush,
    set(next: SubagentObservation) { current = next; },
    fail(error: unknown) { readError = error; },
    recover() { readError = undefined; },
  };
}

describe("SubagentArtifactObserver", () => {
  it("rereads after installing a watch so a mutation in the read/install gap is observed", () => {
    const before = observation();
    const after = observation({ childSessionId: "child", signature: "sig-child" });
    let current = before;
    let reads = 0;
    const samples: Array<{ observation: SubagentObservation; publish: boolean }> = [];
    const watches: SubagentWatchHandle[] = [];
    const observer = new SubagentArtifactObserver({
      read: () => { reads += 1; return current; },
      onObservation: (next, publish) => samples.push({ observation: next, publish }),
      onError: (error) => { throw error; },
      watchDirectory: (directory) => {
        const handle = { close: () => undefined };
        watches.push(handle);
        if (directory === "/sessions/project") current = after;
        return handle;
      },
      schedule: () => () => undefined,
    });

    const settled = observer.start(false);
    assert.equal(settled.tasks[0]?.childSessionId, "child");
    assert.equal(samples.at(-1)?.observation.tasks[0]?.childSessionId, "child");
    assert.equal(reads, 2, "one post-install reread closes the observation gap");
    assert.equal(watches.length, 3);
    observer.close();
  });

  it("rereads when an existing directory gains a basename after an event was filtered", () => {
    const original = observation();
    const expanded = {
      ...original,
      watchTargets: original.watchTargets.map((target) => target.directory === "/sessions/project"
        ? { ...target, basenames: ["child.jsonl", "new.jsonl"] }
        : target),
    };
    const linked = { ...expanded, tasks: [task("new child", "child-new")], childSignatures: ["sig-new"] };
    let current: SubagentObservation = original;
    let race = false;
    let sessionChange: ((name: string | null) => void) | undefined;
    let scheduled = 0;
    let watcherCount = 0;
    const samples: SubagentObservation[] = [];
    const observer = new SubagentArtifactObserver({
      read: () => {
        const result = current;
        if (race) {
          race = false;
          current = linked;
          sessionChange!("new.jsonl"); // The currently installed filter ignores it.
        }
        return result;
      },
      onObservation: (next) => samples.push(next),
      onError: (error) => { throw error; },
      watchDirectory: (directory, change) => {
        watcherCount += 1;
        if (directory === "/sessions/project") sessionChange = change;
        return { close: () => undefined };
      },
      schedule: () => { scheduled += 1; return () => undefined; },
    });
    observer.start(false);
    current = expanded;
    race = true;
    const latest = observer.refresh();
    assert.equal(latest.tasks[0]?.childSessionId, "child-new");
    assert.equal(samples.at(-1)?.tasks[0]?.childSessionId, "child-new");
    assert.equal(watcherCount, 3, "existing directory watchers are reused");
    assert.equal(scheduled, 0, "post-plan reread must recover an already filtered event");
    observer.close();
  });

  it("discovers a post-tool task, later child creation, appends, and atomic task replacement", () => {
    const h = harness(observation({ withTask: false }));
    h.observer.start(false);
    assert.equal(h.samples.length, 1);

    h.set(observation());
    h.activeWatch("/tasks/parent").change("task-1");
    h.flush();
    assert.equal(h.samples.length, 2);
    assert.equal(h.samples[1]?.publish, true);
    assert.equal(h.samples[1]?.observation.tasks[0]?.childSessionId, undefined);

    h.set(observation({ childSessionId: "child", signature: "sig-1" }));
    h.activeWatch("/sessions/project").change("child.jsonl");
    h.flush();
    assert.equal(h.samples[2]?.observation.tasks[0]?.childSessionId, "child");

    h.set(observation({ childSessionId: "child", signature: "sig-2" }));
    h.activeWatch("/sessions/project").change("child.jsonl");
    h.flush();
    assert.deepEqual(h.samples[3]?.observation.childSignatures, ["sig-2"]);

    h.set(observation({ description: "updated", childSessionId: "child", signature: "sig-2" }));
    h.activeWatch("/tasks/parent/task-1").change("task.json");
    h.flush();
    assert.equal(h.samples[4]?.observation.tasks[0]?.description, "updated");
  });

  it("filters unrelated siblings and coalesces duplicate unchanged notifications", () => {
    const h = harness(observation({ childSessionId: "child", signature: "sig-1" }));
    h.observer.start(false);
    h.activeWatch("/sessions/project").change("other.jsonl");
    assert.equal(h.samples.length, 1);
    assert.equal(h.watches.filter((row) => row.directory === "/sessions/project").length, 1);

    h.activeWatch("/sessions/project").change("child.jsonl");
    h.activeWatch("/sessions/project").change("child.jsonl");
    assert.equal(h.samples.length, 1);
    h.flush();
    assert.equal(h.samples.length, 1);
  });

  it("reports gaps, recreates failed watches on explicit refresh, and drops late callbacks after close", () => {
    const h = harness(observation());
    h.observer.start(false);
    const taskWatch = h.activeWatch("/tasks/parent/task-1");
    taskWatch.error(new Error("watch gap"));
    assert.equal(h.errors.length, 1);
    assert.equal(taskWatch.closed, true);

    h.set(observation({ description: "snapshot recovery" }));
    h.observer.refresh(true);
    assert.equal(h.samples.at(-1)?.observation.tasks[0]?.description, "snapshot recovery");
    assert.notEqual(h.activeWatch("/tasks/parent/task-1"), taskWatch);

    h.fail(new Error("read failed"));
    assert.throws(() => h.observer.refresh(true), /read failed/);
    assert.equal(h.errors.length, 2);
    h.recover();

    const late = h.activeWatch("/sessions/project");
    h.observer.close();
    const errorsBeforeLate = h.errors.length;
    late.change("child.jsonl");
    late.error(new Error("late"));
    h.flush();
    assert.equal(h.errors.length, errorsBeforeLate);
    assert.equal(h.watches.every((row) => row.closed), true);
  });
});
