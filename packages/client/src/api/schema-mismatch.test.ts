import { describe, expect, it } from "vitest";
import {
  AuthProvidersResponseSchema,
  AuthProviderStatusResponseSchema,
  CommandsResponseSchema,
  FileListResponseSchema,
  GitStatusResponseSchema,
  ModelsResponseSchema,
  PluginsResponseSchema,
  SessionListSchema,
  SkillsResponseSchema,
  TrustResponseSchema,
  WorktreeListResponseSchema,
} from "./schemas";

const session = { sessionId: "s", cwd: "/repo", projectRoot: "/repo" };
const models = {
  models: [{ id: "m", provider: "p" }],
  defaultModel: null as null,
};

describe("deep schema mismatch matrix", () => {
  it.each([
    ["sessions", SessionListSchema, { sessions: [{ ...session, messageCount: -1 }] }],
    ["models", ModelsResponseSchema, { models: [{ id: "m" }], defaultModel: null }],
    ["models-legacy", ModelsResponseSchema, {
      models: {},
      modelList: [],
      defaultModel: null,
      thinkingLevels: {},
      thinkingLevelMaps: {},
      thinkingLevelPins: {},
    }],
    ["files", FileListResponseSchema, { path: "/", entries: [{ name: "x", isDir: "yes", isSymlink: false }] }],
    ["git", GitStatusResponseSchema, { isGitRepository: true, repositoryRoot: "/r", files: [{ filePath: "/r/a", status: "modified", code: "M", indexStatus: "M" }], additions: 0, deletions: 0 }],
    ["worktrees", WorktreeListResponseSchema, { projectRoot: "/r", isGit: true, isTopLevel: true, worktrees: [{ path: "/w", branch: null, isMain: false, authorized: "yes" }] }],
    ["skills", SkillsResponseSchema, { skills: [{ name: "s", enabled: "yes" }] }],
    ["plugins", PluginsResponseSchema, { plugins: [{ name: "p", enabled: 1 }] }],
    ["commands", CommandsResponseSchema, { commands: [{ name: "c", source: "unknown" }] }],
    ["auth", AuthProvidersResponseSchema, { providers: [{ id: "p", methods: ["password"] }] }],
    ["auth-status", AuthProviderStatusResponseSchema, { status: { providerId: "p", authorized: "yes" }, configured: true }],
    ["trust", TrustResponseSchema, { cwd: "/r", level: "maybe", trusted: true, canReloadResources: { allowed: true, level: "trusted" } }],
    ["trust-legacy-source", TrustResponseSchema, { cwd: "/r", level: "trusted", source: "file", trusted: true, canReloadResources: { allowed: true, level: "trusted" } }],
  ] as const)("rejects a nested %s field mismatch", (_name, schema, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  it("accepts exact Host catalog shapes", () => {
    expect(ModelsResponseSchema.safeParse(models).success).toBe(true);
    expect(AuthProvidersResponseSchema.safeParse({ providers: [{ id: "p", methods: ["oauth"] }] }).success).toBe(true);
    expect(AuthProviderStatusResponseSchema.safeParse({
      status: { providerId: "p", authorized: false },
      configured: false,
    }).success).toBe(true);
    expect(SkillsResponseSchema.safeParse({ skills: [{ name: "s", enabled: true }] }).success).toBe(true);
    expect(PluginsResponseSchema.safeParse({ plugins: [{ name: "p", enabled: false, version: "1" }] }).success).toBe(true);
    expect(CommandsResponseSchema.safeParse({ commands: [{ name: "c", source: "prompt", description: "d" }] }).success).toBe(true);
    expect(TrustResponseSchema.safeParse({
      cwd: "/r",
      level: "denied",
      trusted: false,
      canReloadResources: { allowed: false, level: "denied", reason: "Project resources are not trusted" },
    }).success).toBe(true);
  });
});
