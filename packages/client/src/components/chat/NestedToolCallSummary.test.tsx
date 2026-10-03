import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { I18nProvider } from "@/hooks/useI18n";
import { NestedToolCallSummary } from "./NestedToolCallSummary";

afterEach(cleanup);

it("renders nested successes, errors, and unfinished calls as a parent summary", () => {
  render(<I18nProvider><NestedToolCallSummary value={{ complete: false, calls: [
    { id: "p/0", name: "read", status: "ok", arguments: { path: "README.md" } },
    { id: "p/1", name: "write", status: "error", error: "permission denied" },
    { id: "p/2", name: "search", status: "unfinished" },
  ] }} /></I18nProvider>);
  const summary = screen.getByRole("region", { name: "Nested tool calls" });
  expect(within(summary).getAllByRole("listitem")).toHaveLength(3);
  expect(within(summary).getByText("read · Completed")).toBeTruthy();
  expect(within(summary).getByText("write · Failed")).toBeTruthy();
  expect(within(summary).getByText("search · Unfinished")).toBeTruthy();
  expect(within(summary).getByText("permission denied")).toBeTruthy();
  expect(within(summary).getByText("Some call details are unavailable or unfinished.")).toBeTruthy();
});

it("does not add an empty section to ordinary tools", () => {
  const { container } = render(<I18nProvider><NestedToolCallSummary value={undefined} /></I18nProvider>);
  expect(container.childElementCount).toBe(0);
});
