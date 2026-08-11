import { describe, expect, it } from "vitest";
import {
  AuthProvidersResponseSchema,
  FileListResponseSchema,
  GitStatusResponseSchema,
  ModelsResponseSchema,
  PluginsResponseSchema,
  SessionListSchema,
  SkillsResponseSchema,
  WorktreeListResponseSchema,
} from "./schemas";

const session = { sessionId: "s", cwd: "/repo", projectRoot: "/repo" };
const models = { models: {}, modelList: [], defaultModel: null, thinkingLevels: {}, thinkingLevelMaps: {}, thinkingLevelPins: {} };

describe("deep schema mismatch matrix", () => {
  it.each([
    ["sessions", SessionListSchema, { sessions: [{ ...session, messageCount: -1 }] }],
    ["models", ModelsResponseSchema, { ...models, thinkingLevels: { x: [1] } }],
    ["files", FileListResponseSchema, { path: "/", entries: [{ name: "x", isDir: "yes", isSymlink: false }] }],
    ["git", GitStatusResponseSchema, { isGitRepository: true, repositoryRoot: "/r", files: [{ filePath: "/r/a", status: "modified", code: "M", indexStatus: "M" }], additions: 0, deletions: 0 }],
    ["worktrees", WorktreeListResponseSchema, { projectRoot: "/r", isGit: true, isTopLevel: true, worktrees: [{ path: "/w", branch: null, isMain: false, authorized: "yes" }] }],
    ["skills", SkillsResponseSchema, { skills: [{ name: "s", enabled: "yes" }] }],
    ["plugins", PluginsResponseSchema, { plugins: [{ name: "p", enabled: 1 }] }],
    ["auth", AuthProvidersResponseSchema, { providers: [{ id: "p", methods: ["password"] }] }],
  ] as const)("rejects a nested %s field mismatch", (_name, schema, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });
});
