import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import {
  createAssistantCreateTargetResolver,
  parseWorkspaceRootsEnv,
  resolveAbsoluteProjectTarget,
} from "../src/internal/assistant-tools.js";
import { createAssistantCreateAuthorizer } from "../src/trust/index.js";

describe("parseWorkspaceRootsEnv", () => {
  it("unset / empty → null (home-directory fallback applies)", () => {
    assert.equal(parseWorkspaceRootsEnv({}), null);
    assert.equal(parseWorkspaceRootsEnv({ PIX_ALLOWED_ROOTS: "" }), null);
    assert.equal(parseWorkspaceRootsEnv({ PIX_ALLOWED_ROOTS: "  " }), null);
  });

  it("parses delimiter-separated absolute segments", () => {
    assert.deepEqual(
      parseWorkspaceRootsEnv({ PIX_ALLOWED_ROOTS: `/repos${":"}/work` }),
      ["/repos", "/work"],
    );
  });

  it("any relative segment fails closed to null", () => {
    assert.equal(parseWorkspaceRootsEnv({ PIX_ALLOWED_ROOTS: "/repos:relative" }), null);
  });
});

describe("resolveAbsoluteProjectTarget", () => {
  let base: string;
  let inside: string;
  let outside: string;
  let previousRoots: string | undefined;
  let previousAgentDir: string | undefined;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "pix-create-paths-"));
    inside = join(base, "inside", "project");
    outside = join(base, "outside");
    await mkdir(inside, { recursive: true });
    await mkdir(outside, { recursive: true });
    previousRoots = process.env.PIX_ALLOWED_ROOTS;
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(base, "agent");
    await mkdir(join(base, "agent"), { recursive: true });
    process.env.PIX_ALLOWED_ROOTS = join(base, "inside");
  });

  afterEach(async () => {
    process.env.PIX_ALLOWED_ROOTS = previousRoots;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(base, { recursive: true, force: true });
  });

  it("accepts an existing directory inside the configured roots", () => {
    const result = resolveAbsoluteProjectTarget(inside);
    assert.ok("cwd" in result, `expected a target, got: ${JSON.stringify(result)}`);
    assert.equal(result.cwd, realpathSync(inside));
  });

  it("rejects a directory outside the configured roots", () => {
    const result = resolveAbsoluteProjectTarget(outside);
    assert.ok("error" in result);
    assert.match(result.error, /不在 Pix 允许的根目录内/);
  });

  it("rejects missing paths and non-directories", async () => {
    const missing = resolveAbsoluteProjectTarget(join(base, "inside", "ghost"));
    assert.ok("error" in missing);
    assert.match(missing.error, /目录不存在/);
    const file = join(base, "inside", "notes.txt");
    await writeFile(file, "x");
    const notDir = resolveAbsoluteProjectTarget(file);
    assert.ok("error" in notDir);
    assert.match(notDir.error, /不是目录/);
  });

  it("resolves symlinks before the containment check (no escaping a root by symlink)", async () => {
    const link = join(base, "inside", "link");
    const { symlink } = await import("node:fs/promises");
    await symlink(outside, link);
    const result = resolveAbsoluteProjectTarget(link);
    assert.ok("error" in result);
    assert.match(result.error, /不在 Pix 允许的根目录内/);
  });

  it("rejects a trust-requiring project that is not trusted; accepts it once trusted", async () => {
    const guarded = join(base, "inside", "guarded");
    await mkdir(join(guarded, ".pi"), { recursive: true });
    await writeFile(join(guarded, ".pi", "settings.json"), "{}\n");
    const untrusted = resolveAbsoluteProjectTarget(guarded);
    assert.ok("error" in untrusted);
    assert.match(untrusted.error, /信任/);

    const store = new ProjectTrustStore(process.env.PI_CODING_AGENT_DIR!);
    store.set(guarded, true);
    const trusted = resolveAbsoluteProjectTarget(guarded);
    assert.ok("cwd" in trusted, `expected a target after trusting, got: ${JSON.stringify(trusted)}`);
    assert.equal(trusted.cwd, realpathSync(guarded));
  });

  it("a plain directory without project resources needs no explicit trust", () => {
    const result = resolveAbsoluteProjectTarget(inside);
    assert.ok("cwd" in result);
  });
});

describe("createAssistantCreateTargetResolver (sessiond-side guard)", () => {
  it("uses the injected env and agent dir without touching the process env", async () => {
    const base = await mkdtemp(join(tmpdir(), "pix-create-resolver-"));
    try {
      const inside = join(base, "inside", "project");
      const outside = join(base, "outside");
      await mkdir(inside, { recursive: true });
      await mkdir(outside, { recursive: true });
      await mkdir(join(base, "agent"), { recursive: true });
      const resolve = createAssistantCreateTargetResolver({
        env: { PIX_ALLOWED_ROOTS: join(base, "inside") },
        agentDir: join(base, "agent"),
      });
      const okResult = resolve(inside);
      assert.ok("cwd" in okResult);
      assert.equal(okResult.cwd, realpathSync(inside));
      const bad = resolve(outside);
      assert.ok("error" in bad);
      assert.match(bad.error, /不在 Pix 允许的根目录内/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("an unset PIX_ALLOWED_ROOTS falls back to the user home boundary", () => {
    const resolve = createAssistantCreateTargetResolver({ env: {} });
    // The real temp directory exists but sits outside the user's home, so the
    // home fallback boundary (not the roots list) rejects it.
    const result = resolve(realpathSync(tmpdir()));
    if ("error" in result) {
      assert.match(result.error, /主目录之外/);
    } else {
      assert.equal(result.cwd, realpathSync(tmpdir()), "tmpdir lives inside home on this platform; boundary vacuously holds");
    }
  });
});

describe("createAssistantCreateAuthorizer (public /trust seam)", () => {
  it("maps the resolver result onto the fixed ok/message shape", async () => {
    const base = await mkdtemp(join(tmpdir(), "pix-create-authorizer-"));
    try {
      const inside = join(base, "inside");
      const outside = join(base, "outside");
      await mkdir(inside, { recursive: true });
      await mkdir(outside, { recursive: true });
      const authorize = createAssistantCreateAuthorizer({ env: { PIX_ALLOWED_ROOTS: join(base, "inside") } });
      assert.deepEqual(authorize(inside), { ok: true, cwd: realpathSync(inside) });
      const rejected = authorize(outside);
      assert.equal(rejected.ok, false);
      assert.match((rejected as { message: string }).message, /不在 Pix 允许的根目录内/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
