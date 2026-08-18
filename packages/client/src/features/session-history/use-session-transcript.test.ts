import { describe, expect, it } from "vitest";
import type { SessionEntry } from "@fffattiger/pix-protocol";
import { mergeTranscriptEntries } from "./use-session-transcript";

const user = (entryId: string, content: string, parentEntryId?: string): SessionEntry => ({
  entryId,
  ...(parentEntryId === undefined ? {} : { parentEntryId }),
  message: { role: "user", content },
});

const assistant = (entryId: string, text: string, parentEntryId?: string): SessionEntry => ({
  entryId,
  ...(parentEntryId === undefined ? {} : { parentEntryId }),
  message: { role: "assistant", content: [{ type: "text", text }], model: "m", provider: "p" },
});

describe("mergeTranscriptEntries — UI-first reconciliation", () => {
  it("keeps authority in order and appends the optimistic tail", () => {
    const entries = mergeTranscriptEntries(
      [user("u1", "old"), assistant("a1", "answer", "u1")],
      [],
      [{ sessionId: "s1", baseEntryId: "a1", entry: user("optimistic:1", "new") }],
    );
    expect(entries.map((entry) => entry.entryId)).toEqual(["u1", "a1", "optimistic:1"]);
  });

  it("drops a ghost bubble when matching committed history follows its exact base leaf", () => {
    const entries = mergeTranscriptEntries(
      [
        user("u1", "old"),
        assistant("a1", "answer", "u1"),
        user("u2", "repeat", "a1"),
      ],
      [],
      [{ sessionId: "s1", baseEntryId: "a1", entry: user("optimistic:2", "repeat") }],
    );
    expect(entries.map((entry) => entry.entryId)).toEqual(["u1", "a1", "u2"]);
  });

  it("does not hide a new identical prompt when the older commit has a different parent", () => {
    const entries = mergeTranscriptEntries(
      [user("u1", "repeat"), assistant("a1", "answer", "u1")],
      [],
      [{ sessionId: "s1", baseEntryId: "a1", entry: user("optimistic:3", "repeat") }],
    );
    expect(entries.map((entry) => entry.entryId)).toEqual(["u1", "a1", "optimistic:3"]);
  });

  it("reconciles a first root prompt with a known null base", () => {
    const entries = mergeTranscriptEntries(
      [user("u-root", "first")],
      [],
      [{ sessionId: "s1", baseEntryId: null, entry: user("optimistic:root", "first") }],
    );
    expect(entries.map((entry) => entry.entryId)).toEqual(["u-root"]);
  });
});
