// Read-only theme catalog tests (D3B-R6): high-fidelity pi theme parsing
// semantics against REAL temporary directories — built-in registry, global
// vs project precedence, dark/light pairing, single-file polarity inference,
// bad-JSON isolation, vars references, ANSI/256 colors, unsafe-value
// sanitization, and fail-closed path/symlink escape handling.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPiSdkThemeCatalog } from "../src/themes/index.js";
import { THEME_CSS_VAR_KEYS, isRuntimeError, type ThemeCatalogPort } from "@fffattiger/pix-runtime-core";

async function fixture(): Promise<{
  root: string;
  agentDir: string;
  globalThemes: string;
  project: string;
  projectThemes: string;
  outside: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "pix-themes-catalog-"));
  const agentDir = join(root, "agent");
  const globalThemes = join(agentDir, "themes");
  const project = join(root, "project");
  const projectThemes = join(project, ".pi", "themes");
  const outside = join(root, "outside");
  await mkdir(globalThemes, { recursive: true });
  await mkdir(projectThemes, { recursive: true });
  await mkdir(outside, { recursive: true });
  return { root, agentDir, globalThemes, project, projectThemes, outside };
}

const temporary: string[] = [];
async function freshFixture() {
  const f = await fixture();
  temporary.push(f.root);
  return f;
}

function writeTheme(
  dir: string,
  file: string,
  theme: Record<string, unknown>,
): Promise<void> {
  return writeFile(join(dir, file), JSON.stringify(theme), "utf8");
}

const DARK_VARS = {
  bg0: "#1e1e2e",
  bg1: "#2a2a3c",
  bg2: "#3a3a4e",
  bg3: "#4a4a5e",
  fg0: "#e0e0ff",
  fg3: "#9090c0",
  fg4: "#606090",
  orange: "#d65d0e",
  green: "#2fbf71",
  red: "#cc241d",
  blue: "#458588",
};

describe("pi-sdk theme catalog — built-in registry", () => {
  it("lists exactly the five built-in sets (dark + light each) with no user themes", async () => {
    const { agentDir } = await freshFixture();
    const catalog = createPiSdkThemeCatalog({ agentDir });
    const sets = await catalog.listThemeSets();
    assert.deepEqual(
      sets.map((s) => [s.name, s.hasDark, s.hasLight, s.builtin]),
      [
        ["gruvbox", true, true, true],
        ["miku-aqua", true, true, true],
        ["orbital-rose", true, true, true],
        ["scarlet-tether", true, true, true],
        ["solarized", true, true, true],
      ],
    );
    assert.equal(sets[0]!.displayName, "Gruvbox");
    assert.equal(sets[2]!.displayName, "Orbital Rose");
  });

  it("resolves every built-in dark and light variant with the canonical cssVars vocabulary", async () => {
    const { agentDir } = await freshFixture();
    const catalog = createPiSdkThemeCatalog({ agentDir });
    for (const name of ["gruvbox", "miku-aqua", "orbital-rose", "scarlet-tether", "solarized"]) {
      for (const mode of ["dark", "light"] as const) {
        const theme = await catalog.resolveTheme(name, mode);
        assert.equal(theme.name, name);
        assert.deepEqual(
          Object.keys(theme.cssVars).sort(),
          [...THEME_CSS_VAR_KEYS].sort(),
          `${name}/${mode} matches the canonical theme vocabulary`,
        );
        assert.match(theme.cssVars["--bg"]!, /^#[0-9a-f]{6}$/);
        assert.match(theme.cssVars["--bg-subtle"]!, /^rgba\(\d{1,3},\d{1,3},\d{1,3},0\.\d+\)$/);
        assert.match(theme.cssVars["--hatch-color"]!, /^rgba\(\d{1,3},\d{1,3},\d{1,3},0\.\d+\)$/);
      }
    }
  });

  it("infers polarity from the palette: gruvbox dark is dark, light is light", async () => {
    const { agentDir } = await freshFixture();
    const catalog = createPiSdkThemeCatalog({ agentDir });
    assert.equal((await catalog.resolveTheme("gruvbox", "dark")).isDark, true);
    assert.equal((await catalog.resolveTheme("gruvbox", "light")).isDark, false);
    assert.equal((await catalog.resolveTheme("gruvbox", "dark")).cssVars["--bg"], "#282828");
    assert.equal((await catalog.resolveTheme("gruvbox", "light")).cssVars["--bg"], "#fbf1c7");
  });
});

describe("pi-sdk theme catalog — discovery, precedence and pairing", () => {
  it("merges global and project sets by base name; user sets shadow same-named built-ins", async () => {
    const f = await freshFixture();
    await writeTheme(f.globalThemes, "custom-dark.json", {
      name: "custom-dark",
      vars: DARK_VARS,
      colors: { accent: "orange" },
    });
    await writeTheme(f.projectThemes, "custom-light.json", {
      name: "custom-light",
      vars: { ...DARK_VARS, bg0: "#ffffff" },
      colors: { accent: "orange" },
    });
    await writeTheme(f.projectThemes, "gruvbox-dark.json", {
      name: "gruvbox-shadow",
      vars: { ...DARK_VARS, bg0: "#101010" },
      colors: {},
    });
    const catalog = createPiSdkThemeCatalog({ agentDir: f.agentDir, cwd: f.project, trusted: true });
    const sets = await catalog.listThemeSets(f.project);
    const byName = new Map(sets.map((s) => [s.name, s]));
    // Merged across global+project.
    assert.deepEqual(
      [byName.get("custom")!.hasDark, byName.get("custom")!.hasLight, byName.get("custom")!.builtin],
      [true, true, false],
    );
    // A user set with the built-in base name suppresses the built-in listing
    // (gruvbox listed once, non-builtin: dark from the project file only).
    const gruvbox = byName.get("gruvbox")!;
    assert.equal(gruvbox.builtin, false);
    assert.equal(gruvbox.hasDark, true);
    assert.equal(gruvbox.hasLight, false);
    // Built-ins with no user clash still appear.
    assert.equal(byName.get("solarized")!.builtin, true);
  });

  it("resolution precedence is global → project → built-in (source-verified order)", async () => {
    const f = await freshFixture();
    await writeTheme(f.globalThemes, "shared-dark.json", {
      name: "shared-global",
      vars: { ...DARK_VARS, bg0: "#010101" },
      colors: {},
    });
    await writeTheme(f.projectThemes, "shared-dark.json", {
      name: "shared-project",
      vars: { ...DARK_VARS, bg0: "#020202" },
      colors: {},
    });
    const catalog = createPiSdkThemeCatalog({ agentDir: f.agentDir, cwd: f.project, trusted: true });
    // Global file wins for the same candidate filename.
    assert.equal((await catalog.resolveTheme("shared", "dark")).cssVars["--bg"], "#010101");
    // Built-in only when no user theme resolves the name. NOTE: the candidate
    // chain (`{base}-{variant}.json` → `{base}.json` → OPPOSITE-variant file) is
    // tried per directory BEFORE the built-in fallback, so a user
    // `solarized-dark.json` also serves `mode=light` (opposite fallback) and the
    // built-in light palette is never reached — source behavior.
    await writeTheme(f.globalThemes, "solarized-dark.json", {
      name: "solarized-override",
      vars: { ...DARK_VARS, bg0: "#030303" },
      colors: {},
    });
    const catalog2 = createPiSdkThemeCatalog({ agentDir: f.agentDir, cwd: f.project, trusted: true });
    assert.equal((await catalog2.resolveTheme("solarized", "dark")).cssVars["--bg"], "#030303");
    assert.equal((await catalog2.resolveTheme("solarized", "light")).cssVars["--bg"], "#030303");
  });

  it("pairs -dark/-light by filename; a single file infers polarity from bg0 luminance", async () => {
    const f = await freshFixture();
    await writeTheme(f.globalThemes, "pair-dark.json", {
      name: "pair-dark",
      vars: DARK_VARS,
      colors: {},
    });
    await writeTheme(f.globalThemes, "pair-light.json", {
      name: "pair-light",
      vars: { ...DARK_VARS, bg0: "#fdf6e3" },
      colors: {},
    });
    await writeTheme(f.globalThemes, "night.json", {
      name: "night",
      vars: { ...DARK_VARS, bg0: "#0d0d0d" },
      colors: {},
    });
    await writeTheme(f.globalThemes, "day.json", {
      name: "day",
      vars: { ...DARK_VARS, bg0: "#ffffff" },
      colors: {},
    });
    const catalog = createPiSdkThemeCatalog({ agentDir: f.agentDir });
    const sets = await catalog.listThemeSets();
    const byName = new Map(sets.map((s) => [s.name, s]));
    assert.deepEqual(
      [byName.get("pair")!.hasDark, byName.get("pair")!.hasLight],
      [true, true],
    );
    // Single-file sets (no -dark/-light suffix) infer their variant from content.
    assert.deepEqual(
      [byName.get("night")!.hasDark, byName.get("night")!.hasLight],
      [true, false],
    );
    assert.deepEqual(
      [byName.get("day")!.hasDark, byName.get("day")!.hasLight],
      [false, true],
    );
    // Requesting the missing variant of a single-file set resolves the file
    // (source fallback chain) and reports the file's real polarity.
    const opposite = await catalog.resolveTheme("night", "light");
    assert.equal(opposite.isDark, true);
  });

  it("a single bad JSON file never breaks the listing (isolation)", async () => {
    const f = await freshFixture();
    await writeFile(join(f.globalThemes, "bad.json"), "{ not json", "utf8");
    await writeFile(
      join(f.globalThemes, "no-colors.json"),
      JSON.stringify({ name: "no-colors" }),
      "utf8",
    );
    await writeTheme(f.globalThemes, "good-dark.json", {
      name: "good",
      vars: DARK_VARS,
      colors: {},
    });
    const catalog = createPiSdkThemeCatalog({ agentDir: f.agentDir });
    const sets = await catalog.listThemeSets();
    const names = sets.map((s) => s.name);
    assert.ok(names.includes("good"));
    assert.ok(!names.includes("bad"));
    assert.ok(!names.includes("no-colors"));
    // Resolving a bad file falls through to 404 (not a crash).
    await assert.rejects(() => catalog.resolveTheme("bad", "dark"), (error: unknown) => {
      assert.ok(isRuntimeError(error));
      assert.equal(error.code, "not_found");
      return true;
    });
  });
});

describe("pi-sdk theme catalog — parsing semantics", () => {
  it("resolves vars references, raw hex without #, and xterm-256 indices", async () => {
    const f = await freshFixture();
    await writeTheme(f.globalThemes, "parsing-dark.json", {
      name: "parsing",
      vars: { ...DARK_VARS, orange: 208 },
      colors: {
        accent: "orange",       // vars reference
        text: "#FFAA00",        // uppercase hex → lowercased
        muted: "9090c0",        // raw hex without "#"
        dim: 242,               // 256-color grayscale index
        error: "red",           // vars reference
        mdLink: 196,            // 256-color cube index
      },
    });
    const catalog = createPiSdkThemeCatalog({ agentDir: f.agentDir });
    const theme = await catalog.resolveTheme("parsing", "dark");
    assert.equal(theme.cssVars["--accent"], "#ff6600"); // 208 → cube hex
    assert.equal(theme.cssVars["--text"], "#ffaa00");
    assert.equal(theme.cssVars["--text-muted"], "#9090c0");
    assert.equal(theme.cssVars["--accent-red"], "#cc241d"); // vars.red
    // 242 grayscale: v = round(10/23*255) = 111 = 0x6f
    assert.equal(theme.cssVars["--text-dim"], "#6f6f6f");
    assert.equal(theme.cssVars["--accent-red"], "#cc241d"); // vars.red via colors.error
    // Git status colors are contrast-adjusted against the panel background
    // (ensureContrast, source behavior) — keep a safe-literal check here.
    assert.match(theme.cssVars["--git-status-deleted"], /^#[0-9a-f]{6}$/);
  });

  it("sanitizes unsafe color literals to the default chain (no CSS injection)", async () => {
    const f = await freshFixture();
    await writeTheme(f.globalThemes, "evil-dark.json", {
      name: "evil",
      vars: DARK_VARS,
      colors: {
        accent: "url(javascript:alert(1))",
        text: "expression(alert(1))",
        muted: "red", // named color — not a safe literal
        border: "#GGGGGG",
        success: "rgba(0,0,0,0.5)",
      },
    });
    const catalog = createPiSdkThemeCatalog({ agentDir: f.agentDir });
    const theme = await catalog.resolveTheme("evil", "dark");
    const values = Object.values(theme.cssVars);
    for (const value of values) {
      assert.match(value, /^(?:#[0-9a-f]{3,6}|rgba\(\d{1,3},\d{1,3},\d{1,3},(?:0(?:\.\d+)?|1(?:\.0+)?)\))$/);
    }
    assert.ok(!values.some((v) => v.includes("url") || v.includes("expression")));
    // accent unsafe → default chain (orange from vars).
    assert.equal(theme.cssVars["--accent"], "#d65d0e");
    // text unsafe → fg0 default from vars.
    assert.equal(theme.cssVars["--text"], "#e0e0ff");
    // success unsafe → green vars default.
    assert.equal(theme.cssVars["--accent-green"], "#2fbf71");
  });

  it("missing tokens fall back to the source default palette", async () => {
    const f = await freshFixture();
    await writeTheme(f.globalThemes, "bare-dark.json", {
      name: "bare",
      colors: {},
    });
    const catalog = createPiSdkThemeCatalog({ agentDir: f.agentDir });
    const theme = await catalog.resolveTheme("bare", "dark");
    assert.equal(theme.cssVars["--bg"], "#1a1a1a"); // bg0 default
    assert.equal(theme.cssVars["--text"], "#e8e8e8"); // fg0 default
    assert.equal(theme.cssVars["--accent"], "#d97706"); // orange default
    assert.equal(theme.isDark, true); // #1a1a1a luminance < 0.5
  });
});

describe("pi-sdk theme catalog — fail-closed path handling", () => {
  it("rejects traversal/empty/separator names before any filesystem use", async () => {
    const f = await freshFixture();
    const catalog = createPiSdkThemeCatalog({ agentDir: f.agentDir });
    for (const bad of [
      "../evil",
      "..",
      "a/b",
      "a\\b",
      "",
      ".hidden",
      "-leading",
      "has space",
      "nul\0byte",
      "%2e%2e",
      "x".repeat(65),
    ]) {
      await assert.rejects(
        () => catalog.resolveTheme(bad, "dark"),
        (error: unknown) => {
          assert.ok(isRuntimeError(error), `${bad}: structured error`);
          assert.equal(error.code, "invalid_input");
          // Sanitized message: never contains the raw filesystem shape.
          assert.ok(!error.message.includes("/"));
          return true;
        },
        bad,
      );
    }
  });

  it("never resolves a theme name as a direct filesystem path (source fallback removed)", async () => {
    const f = await freshFixture();
    await writeFile(join(f.outside, "steal.json"), JSON.stringify({ name: "steal", colors: {} }), "utf8");
    const catalog = createPiSdkThemeCatalog({ agentDir: f.agentDir });
    await assert.rejects(
      () => catalog.resolveTheme(join(f.outside, "steal.json"), "dark"),
      (error: unknown) => {
        assert.ok(isRuntimeError(error));
        assert.equal(error.code, "invalid_input");
        return true;
      },
    );
    await assert.rejects(
      () => catalog.resolveTheme("../../outside/steal", "dark"),
      (error: unknown) => {
        assert.ok(isRuntimeError(error));
        assert.equal(error.code, "invalid_input");
        return true;
      },
    );
  });

  it("skips files whose realpath escapes the theme dir (symlink escape)", async () => {
    const f = await freshFixture();
    await writeFile(
      join(f.outside, "escaped.json"),
      JSON.stringify({ name: "escaped", vars: DARK_VARS, colors: {} }),
      "utf8",
    );
    await symlink(join(f.outside, "escaped.json"), join(f.globalThemes, "escaped-dark.json"));
    const catalog = createPiSdkThemeCatalog({ agentDir: f.agentDir });
    const sets = await catalog.listThemeSets();
    assert.ok(!sets.some((s) => s.name === "escaped"), "symlinked file must not be listed");
    await assert.rejects(
      () => catalog.resolveTheme("escaped", "dark"),
      (error: unknown) => {
        assert.ok(isRuntimeError(error));
        assert.equal(error.code, "not_found");
        return true;
      },
    );
    assert.equal(existsSync(join(f.outside, "escaped.json")), true); // untouched
  });

  it("rejects a project .pi/themes dir that is a symlink outside the project", async () => {
    const f = await freshFixture();
    const outsideThemes = join(f.outside, "themes");
    await mkdir(outsideThemes, { recursive: true });
    await writeTheme(outsideThemes, "outsider-dark.json", {
      name: "outsider",
      vars: DARK_VARS,
      colors: {},
    });
    await rm(f.projectThemes, { recursive: true });
    await symlink(outsideThemes, f.projectThemes);
    const catalog = createPiSdkThemeCatalog({ agentDir: f.agentDir, cwd: f.project, trusted: true });
    const sets = await catalog.listThemeSets(f.project);
    assert.ok(!sets.some((s) => s.name === "outsider"), "symlinked project theme dir must not contribute");
    await assert.rejects(
      () => catalog.resolveTheme("outsider", "dark", f.project),
      (error: unknown) => {
        assert.ok(isRuntimeError(error));
        assert.equal(error.code, "not_found");
        return true;
      },
    );
  });

  it("skips oversized theme files (bounded read)", async () => {
    const f = await freshFixture();
    await writeFile(
      join(f.globalThemes, "huge-dark.json"),
      JSON.stringify({ name: "huge", colors: { accent: "x".repeat(300 * 1024) } }),
      "utf8",
    );
    const catalog = createPiSdkThemeCatalog({ agentDir: f.agentDir });
    const sets = await catalog.listThemeSets();
    assert.ok(!sets.some((s) => s.name === "huge"));
  });
});

describe("pi-sdk theme catalog — trust gating and cwd contract", () => {
  it("project themes load only while trusted; global + built-ins stay readable untrusted", async () => {
    const f = await freshFixture();
    await writeTheme(f.projectThemes, "proj-dark.json", {
      name: "proj",
      vars: DARK_VARS,
      colors: {},
    });
    const untrusted = createPiSdkThemeCatalog({ agentDir: f.agentDir, cwd: f.project, trusted: false });
    let sets = await untrusted.listThemeSets(f.project);
    assert.ok(!sets.some((s) => s.name === "proj"));
    await assert.rejects(
      () => untrusted.resolveTheme("proj", "dark", f.project),
      (error: unknown) => {
        assert.ok(isRuntimeError(error));
        assert.equal(error.code, "not_found");
        return true;
      },
    );

    const trusted = createPiSdkThemeCatalog({ agentDir: f.agentDir, cwd: f.project, trusted: true });
    sets = await trusted.listThemeSets(f.project);
    assert.ok(sets.some((s) => s.name === "proj"));
    assert.ok(sets.some((s) => s.name === "gruvbox" && s.builtin));
    const resolved = await trusted.resolveTheme("proj", "dark", f.project);
    assert.equal(resolved.name, "proj");

    // No cwd at all: global + built-ins only (trusted irrelevant).
    const noCwd = createPiSdkThemeCatalog({ agentDir: f.agentDir, trusted: true });
    sets = await noCwd.listThemeSets();
    assert.ok(!sets.some((s) => s.name === "proj"));
  });

  it("rejects non-absolute/NUL cwds with structured invalid_input", async () => {
    const f = await freshFixture();
    const catalog: ThemeCatalogPort = createPiSdkThemeCatalog({ agentDir: f.agentDir, trusted: true });
    for (const bad of ["relative/path", "", "nul\0dir"]) {
      await assert.rejects(
        () => catalog.listThemeSets(bad),
        (error: unknown) => {
          assert.ok(isRuntimeError(error));
          assert.equal(error.code, "invalid_input");
          return true;
        },
      );
    }
  });

  it("structured not_found for unknown names; sanitized messages never leak paths", async () => {
    const f = await freshFixture();
    const catalog = createPiSdkThemeCatalog({ agentDir: f.agentDir });
    await assert.rejects(
      () => catalog.resolveTheme("does-not-exist", "dark"),
      (error: unknown) => {
        assert.ok(isRuntimeError(error));
        assert.equal(error.code, "not_found");
        assert.equal(error.retryable, false);
        assert.ok(!error.message.includes(f.root), "no path leak");
        return true;
      },
    );
  });
});

after(async () => {
  for (const dir of temporary) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
