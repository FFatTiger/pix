import { describe, expect, it, beforeEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import {
  registerChatOpenFileTarget,
  useChatOpenFile,
} from "./chat-experience-bridge";

/** Component that mirrors the real consumer (MessageView onOpenFile wiring). */
function OpenFileProbe() {
  const onOpenFile = useChatOpenFile();
  return (
    <button
      data-testid="probe"
      onClick={() => onOpenFile?.("/tmp/proj/a.ts", { initialDisplayMode: "diff" })}
    >
      {onOpenFile === undefined ? "no-handler" : "has-handler"}
    </button>
  );
}

describe("chat-experience-bridge — open-file target registration", () => {
  beforeEach(() => {
    cleanup();
  });

  it("returns undefined (no dead handler) until a target registers", () => {
    render(<OpenFileProbe />);
    expect(screen.getByTestId("probe").textContent).toBe("no-handler");
  });

  it("hands a registered handler to useChatOpenFile subscribers", () => {
    const calls: string[] = [];
    const unregister = registerChatOpenFileTarget((path) => { calls.push(path); });
    render(<OpenFileProbe />);
    expect(screen.getByTestId("probe").textContent).toBe("has-handler");
    act(() => { screen.getByTestId("probe").click(); });
    expect(calls).toEqual(["/tmp/proj/a.ts"]);
    unregister();
  });

  it("unregister removes the target so subscribers fall back to undefined", () => {
    const unregister = registerChatOpenFileTarget(() => undefined);
    const { unmount } = render(<OpenFileProbe />);
    expect(screen.getByTestId("probe").textContent).toBe("has-handler");
    act(() => { unregister(); });
    unmount();
    render(<OpenFileProbe />);
    expect(screen.getByTestId("probe").textContent).toBe("no-handler");
  });

  it("registering twice replaces the previous target", () => {
    const first: string[] = [];
    const second: string[] = [];
    const unreg1 = registerChatOpenFileTarget((path) => { first.push(path); });
    registerChatOpenFileTarget((path) => { second.push(path); });
    render(<OpenFileProbe />);
    act(() => { screen.getByTestId("probe").click(); });
    expect(first).toEqual([]);
    expect(second).toEqual(["/tmp/proj/a.ts"]);
    // The superseded handler's unregister must NOT clear the replacement.
    unreg1();
    act(() => { screen.getByTestId("probe").click(); });
    expect(second).toEqual(["/tmp/proj/a.ts", "/tmp/proj/a.ts"]);
  });
});
