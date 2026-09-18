import { describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { I18nProvider } from "@/hooks/useI18n";
import { BranchNavigator } from "./BranchNavigator";
import { toBranchNavigatorTree } from "./chat-runtime-view";
import type { SessionTreeNode as ProtocolSessionTreeNode } from "@/lib/session-tree";

function renderEmbedded(roots: ProtocolSessionTreeNode[]) {
  const onLeafChange = vi.fn();
  const utils = render(
    <I18nProvider>
      <BranchNavigator
        tree={toBranchNavigatorTree(roots)}
        activeLeafId={null}
        onLeafChange={onLeafChange}
        hasSession
        embedded
      />
    </I18nProvider>,
  );
  return { onLeafChange, utils };
}

describe("BranchNavigator — protocol label preview + U/A badge (F5)", () => {
  it("shows the protocol preview label, never the raw kind string", () => {
    const roots: ProtocolSessionTreeNode[] = [
      {
        entryId: "root",
        kind: "user",
        label: "Question",
        truncated: false,
        children: [
          { entryId: "a", kind: "user", label: "Follow-up Q", truncated: false, children: [] },
          { entryId: "b", kind: "assistant", label: "Answer B", truncated: false, children: [] },
        ],
      },
    ];
    renderEmbedded(roots);
    // Preview labels render; raw kind strings ("assistant" / "user") never do.
    expect(screen.getByText("Follow-up Q")).toBeTruthy();
    expect(screen.getByText("Answer B")).toBeTruthy();
    expect(screen.queryByText(/^assistant$/)).toBeNull();
    expect(screen.queryByText(/^user$/)).toBeNull();
    cleanup();
  });

  it("renders the correct U and A badges from the protocol kind", () => {
    const roots: ProtocolSessionTreeNode[] = [
      {
        entryId: "root",
        kind: "user",
        label: "Question",
        truncated: false,
        children: [
          { entryId: "a", kind: "user", label: "Follow-up Q", truncated: false, children: [] },
          { entryId: "b", kind: "assistant", label: "Answer B", truncated: false, children: [] },
        ],
      },
    ];
    renderEmbedded(roots);
    expect(screen.getAllByText("U").length).toBeGreaterThan(0);
    expect(screen.getAllByText("A").length).toBeGreaterThan(0);
    cleanup();
  });

  it("keeps an honest no-badge row for unknown/other kinds while showing their preview", () => {
    const roots: ProtocolSessionTreeNode[] = [
      {
        entryId: "root",
        kind: "user",
        label: "Question",
        truncated: false,
        children: [
          { entryId: "a", kind: "assistant", label: "Answer A", truncated: false, children: [] },
          { entryId: "c", kind: "system", label: "System note", truncated: false, children: [] },
          { entryId: "d", kind: "toolResult", label: "tool result preview", truncated: false, children: [] },
        ],
      },
    ];
    renderEmbedded(roots);
    expect(screen.getByText("System note")).toBeTruthy();
    expect(screen.getByText("tool result preview")).toBeTruthy();
    // The branch has exactly one U/A-badged row (the assistant); the other
    // kinds render with no fabricated badge.
    expect(screen.queryAllByText("A").length).toBe(1);
    expect(screen.queryAllByText("U").length).toBe(0);
    cleanup();
  });
});
