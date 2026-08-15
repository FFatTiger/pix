// Public themes surface of the pix Pi SDK Adapter.
//
// Read-only ThemeCatalogPort backed by a high-fidelity port of the legacy
// desktop web app's theme parser (its lib/theme.ts): the five built-in theme sets
// (gruvbox / miku-aqua / orbital-rose / scarlet-tether / solarized, dark +
// light), agent-dir global themes (`<agentDir>/themes/*.json`), and trusted
// project themes (`<cwd>/.pi/themes/*.json`), with dark/light filename
// pairing, palette-luminance polarity inference, `vars` reference expansion,
// xterm-256 color indices, and the 52 pi CLI color tokens projected onto the
// frozen 29 CSS custom properties. Precedence matches the source exactly:
// global → project → built-in.
//
// This module satisfies runtime-core ThemeCatalogPort WITHOUT importing the
// Pi SDK: the only SDK touchpoint (getAgentDir for the default agent dir)
// lives in src/internal/theme-store.ts. Fail-closed hardening over the source:
// theme names are validated before any filesystem use, discovered files must
// stay inside (realpath of) their theme directory — symlink escapes are
// skipped — theme files are size-capped, and any color literal that is not a
// safe hex/rgba value is sanitized to the source's default-chain value.
// No write/reload/install, no network, no Worker/Agent.
import type {
  ResolvedTheme,
  ThemeCatalogPort,
  ThemeSetInfo,
} from "@fffattiger/pix-runtime-core";
import { createPiSdkThemeStore } from "../internal/theme-store.js";

/**
 * Injectable read-only theme store contract. The default implementation
 * (created by the internal store factory) parses pi theme JSON from the
 * built-in registry + agent-dir global dir + trusted project dir; tests and
 * composition may supply their own to exercise the catalog in isolation.
 */
export interface PiSdkThemeStore {
  listThemeSets(cwd?: string): Promise<readonly ThemeSetInfo[]>;
  resolveTheme(
    name: string,
    mode: "dark" | "light",
    cwd?: string,
  ): Promise<ResolvedTheme>;
}

/** Options for the default filesystem-backed store (ignored when a store is injected). */
export interface PiSdkThemeCatalogOptions {
  /** Agent config directory (global themes live in `<agentDir>/themes`). */
  readonly agentDir?: string;
  /**
   * Canonical absolute project working directory for project themes. Project
   * `.pi/themes` are read ONLY when `trusted` is true (fail closed); there is
   * never an implicit working-directory fallback.
   */
  readonly cwd?: string;
  /** Effective project trust gating project-local theme discovery. */
  readonly trusted?: boolean;
}

class PiSdkThemeCatalog implements ThemeCatalogPort {
  constructor(private readonly store: PiSdkThemeStore) {}

  listThemeSets(cwd?: string): Promise<readonly ThemeSetInfo[]> {
    return this.store.listThemeSets(cwd);
  }

  resolveTheme(
    name: string,
    mode: "dark" | "light",
    cwd?: string,
  ): Promise<ResolvedTheme> {
    return this.store.resolveTheme(name, mode, cwd);
  }
}

function isThemeStore(value: unknown): value is PiSdkThemeStore {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { listThemeSets?: unknown }).listThemeSets === "function"
  );
}

/**
 * Create a read-only ThemeCatalogPort. Pass an explicit
 * {@link PiSdkThemeCatalogOptions} (agentDir/cwd/trusted) or inject a
 * {@link PiSdkThemeStore} for tests/composition. Reads are pure JSON parsing
 * only — no write, no network, zero Workers/Agents.
 */
export function createPiSdkThemeCatalog(
  options: PiSdkThemeStore | PiSdkThemeCatalogOptions,
): ThemeCatalogPort {
  const store = isThemeStore(options)
    ? options
    : createPiSdkThemeStore({
        ...(options.agentDir === undefined ? {} : { agentDir: options.agentDir }),
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.trusted === undefined ? {} : { trusted: options.trusted }),
      });
  return new PiSdkThemeCatalog(store);
}
