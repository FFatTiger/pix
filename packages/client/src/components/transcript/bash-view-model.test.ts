import { describe, expect, it } from "vitest";
import {
  BASH_EMPTY_OUTPUT,
  LIVE_BASH_ROW_ID,
  flattenBashViewModel,
  projectBashViewModel,
} from "./bash-view-model";

describe("projectBashViewModel", () => {
  it("projects command, output, exit code, cancelled, truncated", () => {
    const view = projectBashViewModel({
      command: "echo hi",
      output: "hi\n",
      exitCode: 0,
      cancelled: false,
      truncated: true,
      fullOutputPath: "/secret/path.out",
      excludeFromContext: true,
    });
    expect(view.command).toBe("echo hi");
    expect(view.output).toBe("hi\n");
    expect(view.exitCode).toBe(0);
    expect(view.cancelled).toBe(false);
    expect(view.truncated).toBe(true);
    expect(view.completed).toBe(true);
    expect(view.running).toBe(false);
    expect(view.statusLabels).toEqual(["exit 0", "truncated"]);
    // fullOutputPath must never appear on the view-model.
    expect(view).not.toHaveProperty("fullOutputPath");
    expect(JSON.stringify(view)).not.toContain("/secret/path.out");
    // excludeFromContext does not affect visibility or labels.
    expect(view.statusLabels.join(" ")).not.toMatch(/exclude|context/i);
  });

  it("uses fixed (no output) sentinel for empty output", () => {
    const view = projectBashViewModel({ command: "true", output: "" });
    expect(view.output).toBe(BASH_EMPTY_OUTPUT);
  });

  it("marks cancelled without inventing exit code", () => {
    const view = projectBashViewModel({
      command: "sleep 10",
      output: "partial",
      cancelled: true,
    });
    expect(view.cancelled).toBe(true);
    expect(view.exitCode).toBeUndefined();
    expect(view.statusLabels).toEqual(["cancelled"]);
  });

  it("honors live running / completed flags", () => {
    const running = projectBashViewModel(
      { command: "ls", output: "a" },
      { running: true, completed: false },
    );
    expect(running.running).toBe(true);
    expect(running.completed).toBe(false);
    expect(running.statusLabels).toEqual(["running"]);

    const done = projectBashViewModel(
      { command: "ls", output: "a", exitCode: 1 },
      { running: false, completed: true },
    );
    expect(done.running).toBe(false);
    expect(done.completed).toBe(true);
    expect(done.statusLabels).toEqual(["exit 1"]);
  });
});

describe("flattenBashViewModel", () => {
  it("joins command, output, and status labels", () => {
    const text = flattenBashViewModel(
      projectBashViewModel({ command: "echo", output: "x", exitCode: 0 }),
    );
    expect(text).toBe("$ echo\nx\nexit 0");
  });
});

describe("LIVE_BASH_ROW_ID", () => {
  it("is a stable constant independent of content", () => {
    expect(LIVE_BASH_ROW_ID).toBe("row:state:bash");
  });
});
