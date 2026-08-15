// Read-only theme catalog store: a high-fidelity port of the legacy desktop
// web app's theme parser (its lib/theme.ts + lib/themes/index.ts).
//
// This is the ONLY module in the themes domain that touches the Pi SDK — a
// single `getAgentDir` call for the default agent dir (mirroring the pi CLI
// custom-themes dir `getAgentDir()/themes`; the source hard-codes
// `~/.pi/agent/themes`, which is the same location for a default install).
//
// Parsing semantics are copied 1:1 from the source:
//   - Pi theme JSON: { name, vars?: {key: hex|number}, colors: {token: hex|
//     number|varRef|""} }; all 52 pi CLI color tokens; missing tokens default.
//   - Filename pairing: `{base}-dark.json` / `{base}-light.json` pair into one
//     set; a single `{base}.json` infers polarity from the bg0 luminance.
//   - Color values: hex strings, xterm-256 indices, `vars` references, raw
//     6-digit hex without "#", and "" (terminal default → source default chain).
//   - 52 tokens → frozen 29 CSS custom properties (palette-derived mixes,
//     lighten/darken accent, contrast-adjusted git status colors, rgba hatch).
//   - Precedence: agent-dir global themes → trusted project themes → built-in
//     registry (verified against the source: global candidates win over project
//     candidates with the same filename; built-ins only when no user set shares
//     the base name).
//
// Fail-closed hardening deltas over the source (each documented in docs):
//   1. Theme names are validated against a strict pattern BEFORE any
//      filesystem use; the source's "resolve name as a direct file path"
//      fallback is REMOVED (arbitrary file read).
//   2. A theme directory only contributes files whose realpath stays inside
//      the realpath of the directory, and the directory itself must stay inside
//      its caller-owned base (agentDir / project cwd) — symlink escapes are
//      skipped.
//   3. Theme files are size-capped; oversized files are skipped.
//   4. Any color literal that is not a safe 3/6-digit lowercase hex (or an
//      internally generated rgba() literal) is sanitized to "" — i.e. it
//      behaves exactly like an unset token and the source's default chain
//      applies. url()/expression()/named colors never reach CSS vars.
//   5. A single bad JSON file never breaks the listing (source behavior).
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, extname, isAbsolute, join, relative, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  makeRuntimeError,
  type ResolvedTheme,
  type ThemeCssVarKey,
  type ThemeSetInfo,
  type ThemeVariant,
} from "@fffattiger/pix-runtime-core";
import type { PiSdkThemeStore } from "../themes/index.js";
import gruvboxDark from "../themes/builtin/gruvbox-dark.json" with { type: "json" };
import gruvboxLight from "../themes/builtin/gruvbox-light.json" with { type: "json" };
import mikuAquaDark from "../themes/builtin/miku-aqua-dark.json" with { type: "json" };
import mikuAquaLight from "../themes/builtin/miku-aqua-light.json" with { type: "json" };
import orbitalRoseDark from "../themes/builtin/orbital-rose-dark.json" with { type: "json" };
import orbitalRoseLight from "../themes/builtin/orbital-rose-light.json" with { type: "json" };
import scarletTetherDark from "../themes/builtin/scarlet-tether-dark.json" with { type: "json" };
import scarletTetherLight from "../themes/builtin/scarlet-tether-light.json" with { type: "json" };
import solarizedDark from "../themes/builtin/solarized-dark.json" with { type: "json" };
import solarizedLight from "../themes/builtin/solarized-light.json" with { type: "json" };

// ─── Pi theme JSON model ────────────────────────────────────────────────────

export interface PiTheme {
  name: string;
  vars?: Record<string, string | number>;
  colors: Record<string, string | number>;
}

/** A built-in theme set, pairing a dark and/or light variant by base name. */
export interface BuiltinThemeSet {
  name: string;
  dark?: PiTheme;
  light?: PiTheme;
}

/** The five built-in theme sets shipped with the app (verbatim source JSON). */
export const BUILTIN_THEMES: readonly BuiltinThemeSet[] = [
  { name: "gruvbox", dark: gruvboxDark as PiTheme, light: gruvboxLight as PiTheme },
  { name: "miku-aqua", dark: mikuAquaDark as PiTheme, light: mikuAquaLight as PiTheme },
  { name: "orbital-rose", dark: orbitalRoseDark as PiTheme, light: orbitalRoseLight as PiTheme },
  { name: "scarlet-tether", dark: scarletTetherDark as PiTheme, light: scarletTetherLight as PiTheme },
  { name: "solarized", dark: solarizedDark as PiTheme, light: solarizedLight as PiTheme },
];

/** Look up a built-in theme set by base name. */
export function findBuiltinTheme(name: string): BuiltinThemeSet | undefined {
  return BUILTIN_THEMES.find((t) => t.name === name);
}

// ─── Hardening limits ───────────────────────────────────────────────────────

/**
 * Theme names must be plain ASCII slugs: a leading alphanumeric then
 * alphanumerics, ".", "_" or "-", at most 64 chars. No path separators, no
 * "..", no NUL, no leading dot/dash — a name can never traverse out of a
 * theme directory when interpolated into a candidate filename.
 */
export const THEME_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isSafeThemeName(name: string): boolean {
  return typeof name === "string" && THEME_NAME_PATTERN.test(name);
}

/** Theme files larger than this are skipped (bounded read; source JSONs are <10 KiB). */
export const MAX_THEME_FILE_BYTES = 256 * 1024;

/** Safe literal a resolved color may carry (see resolveColor sanitization). */
const SAFE_HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/;

// ─── 256-color palette → hex ────────────────────────────────────────────────

// Standard xterm 256-color palette. 0-15: ANSI, 16-231: 6x6x6 cube, 232-255: grayscale.
function ansiToHex(code: number): string {
  // 0-15: basic ANSI colors
  const ansi: Record<number, string> = {
    0: "#000000", 1: "#800000", 2: "#008000", 3: "#808000",
    4: "#000080", 5: "#800080", 6: "#008080", 7: "#c0c0c0",
    8: "#808080", 9: "#ff0000", 10: "#00ff00", 11: "#ffff00",
    12: "#0000ff", 13: "#ff00ff", 14: "#00ffff", 15: "#ffffff",
  };
  if (code in ansi) return ansi[code]!;

  // 16-231: 6×6×6 RGB cube
  if (code >= 16 && code <= 231) {
    const n = code - 16;
    const r = Math.round((Math.floor(n / 36) % 6) * (255 / 5));
    const g = Math.round((Math.floor(n / 6) % 6) * (255 / 5));
    const b = Math.round((n % 6) * (255 / 5));
    return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
  }

  // 232-255: grayscale ramp
  if (code >= 232 && code <= 255) {
    const v = Math.round(((code - 232) / 23) * 255);
    const h = v.toString(16).padStart(2, "0");
    return `#${h}${h}${h}`;
  }

  return "#000000";
}

// ─── Color resolution ───────────────────────────────────────────────────────

/**
 * Resolve a single color value to a hex string.
 * - Hex string: returned lowercased (3/6 digits only — unsafe literals are
 *   sanitized to "", which triggers the caller's default chain exactly like an
 *   unset token; the source passed unknown literals through verbatim)
 * - Number: treated as 256-color index, converted to hex
 * - String matching a var name: resolved from vars
 * - Empty string: returns empty (caller substitutes the default)
 */
function resolveColor(
  value: string | number | undefined,
  vars: Record<string, string>,
): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "number") return ansiToHex(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return "";
    if (trimmed.startsWith("#")) {
      const lower = trimmed.toLowerCase();
      return SAFE_HEX.test(lower) ? lower : "";
    }
    // Variable reference
    if (vars[trimmed]) return vars[trimmed]!.toLowerCase();
    // Could be a raw number-as-string: "242"
    const num = Number(trimmed);
    if (!isNaN(num) && trimmed === String(num)) return ansiToHex(num);
    // Raw hex without "#": "282828"
    if (/^[0-9a-fA-F]{6}$/.test(trimmed)) return `#${trimmed.toLowerCase()}`;
    // Unknown/unsafe literal — sanitized to the unset-token default chain.
    return "";
  }
  return "";
}

/** Resolve all `vars` entries to hex strings. */
function resolveVars(vars: Record<string, string | number> | undefined): Record<string, string> {
  const resolved: Record<string, string> = {};
  if (!vars) return resolved;
  for (const [key, value] of Object.entries(vars)) {
    resolved[key] = resolveColor(value, {});
  }
  return resolved;
}

/** Resolve all `colors` entries, expanding var references. */
function resolveColors(
  colors: Record<string, string | number>,
  vars: Record<string, string>,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(colors)) {
    resolved[key] = resolveColor(value, vars);
  }
  return resolved;
}

// ─── Color manipulation helpers ─────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(hex);
  if (!m) return null;
  return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

/** Lighten a hex color by mixing with white. factor 0 = no change, 1 = white. */
function lighten(hex: string, factor: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const [r, g, b] = rgb;
  return rgbToHex(
    Math.round(r + (255 - r) * factor),
    Math.round(g + (255 - g) * factor),
    Math.round(b + (255 - b) * factor),
  );
}

/** Darken a hex color by mixing with black. factor 0 = no change, 1 = black. */
function darken(hex: string, factor: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const [r, g, b] = rgb;
  return rgbToHex(
    Math.round(r * (1 - factor)),
    Math.round(g * (1 - factor)),
    Math.round(b * (1 - factor)),
  );
}

/** Mix two hex colors. factor 0 = all a, factor 1 = all b. */
function mix(a: string, b: string, factor: number): string {
  const ra = hexToRgb(a);
  const rb = hexToRgb(b);
  if (!ra || !rb) return a;
  return rgbToHex(
    Math.round(ra[0] + (rb[0] - ra[0]) * factor),
    Math.round(ra[1] + (rb[1] - ra[1]) * factor),
    Math.round(ra[2] + (rb[2] - ra[2]) * factor),
  );
}

/** Calculate relative luminance (0-1). Used to determine dark vs light. */
function relativeLuminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0.5;
  const luminanceChannel = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return (
    0.2126 * luminanceChannel(rgb[0]!) +
    0.7152 * luminanceChannel(rgb[1]!) +
    0.0722 * luminanceChannel(rgb[2]!)
  );
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLum = relativeLuminance(foreground);
  const backgroundLum = relativeLuminance(background);
  return (Math.max(foregroundLum, backgroundLum) + 0.05) / (Math.min(foregroundLum, backgroundLum) + 0.05);
}

/**
 * Preserve a theme status color's hue while making a modest contrast adjustment
 * (source behavior, verbatim).
 */
function ensureContrast(color: string, background: string, minimum = 3): string {
  if (!hexToRgb(color) || !hexToRgb(background) || contrastRatio(color, background) >= minimum) {
    return color;
  }

  const darkenForContrast = relativeLuminance(background) > relativeLuminance(color);
  for (let step = 1; step <= 20; step += 1) {
    const candidate = darkenForContrast
      ? darken(color, step * 0.05)
      : lighten(color, step * 0.05);
    if (contrastRatio(candidate, background) >= minimum) return candidate;
  }
  return darkenForContrast ? "#000000" : "#ffffff";
}

// ─── pi CLI token → CSS variable mapping ────────────────────────────────────

/**
 * Maps resolved pi CLI theme colors + vars to the frozen 29 CSS custom
 * properties (source behavior, verbatim; every emitted value is a safe color
 * literal because inputs were sanitized in resolveColor).
 */
function mapToCssVars(
  colors: Record<string, string>,
  vars: Record<string, string>,
): Record<ThemeCssVarKey, string> {
  // ── Extract base palette from vars ──
  const bg0 = vars.bg0 || "#1a1a1a";
  const bg1 = vars.bg1 || "#242424";
  const bg2 = vars.bg2 || "#2e2e2e";
  const bg3 = vars.bg3 || "#383838";
  const fg0 = vars.fg0 || "#e8e8e8";
  const fg3 = vars.fg3 || "#888888";
  const fg4 = vars.fg4 || "#555555";

  // Semantic palette colors
  const red = vars.red || "#dc2626";
  const green = vars.green || "#16a34a";
  const orange = vars.orange || "#d97706";

  // ── Resolve key pi CLI tokens ──
  const accent = colors.accent || orange;
  const text = colors.text || fg0;
  const muted = colors.muted || fg3;
  const dim = colors.dim || fg4;
  const border = colors.border || bg3;
  const borderAccent = colors.borderAccent || accent;
  const selectedBg = colors.selectedBg || bg2;
  const success = colors.success || green;
  const error = colors.error || red;
  const warning = colors.warning || orange;
  const gitAdded = colors.toolDiffAdded || success;
  const gitDeleted = colors.toolDiffRemoved || error;
  const gitModified = warning;
  const userMessageBg = colors.userMessageBg || bg1;
  const toolSuccessBg = colors.toolSuccessBg || bg1;

  // Determine if dark theme
  const isDark = relativeLuminance(bg0) < 0.5;

  // ── Build CSS variables ──
  const css = {} as Record<ThemeCssVarKey, string>;

  // Core backgrounds
  css["--bg"] = bg0;
  css["--bg-panel"] = bg1;
  css["--bg-secondary"] = bg1;
  css["--bg-card"] = bg1;
  css["--bg-hover"] = bg2;
  css["--bg-selected"] = selectedBg === bg1 ? bg2 : selectedBg;
  css["--bg-card-hover"] = mix(bg1, bg2, 0.5);
  css["--bg-subtle"] = isDark
    ? `rgba(255,255,255,0.035)`
    : `rgba(15,23,42,0.035)`;

  // Borders
  css["--border"] = border;
  css["--border-hover"] = borderAccent;

  // Text
  css["--text"] = text;
  css["--text-muted"] = muted;
  css["--text-dim"] = dim;

  // Accent
  css["--accent"] = accent;
  css["--accent-hover"] = isDark ? lighten(accent, 0.2) : darken(accent, 0.15);
  css["--accent-blue"] = vars.blue || accent;

  // Semantic colors
  css["--accent-red"] = error;
  css["--accent-green"] = success;
  css["--accent-orange"] = warning;

  // Git status uses the theme's diff/semantic palette, adjusted only enough
  // to keep its small text readable on the active panel background.
  const gitStatusBackgroundWeight = isDark ? 0.24 : 0.18;
  css["--git-status-added"] = ensureContrast(gitAdded, bg1);
  css["--git-status-modified"] = ensureContrast(gitModified, bg1);
  css["--git-status-deleted"] = ensureContrast(gitDeleted, bg1);
  css["--git-status-added-bg"] = mix(bg1, gitAdded, gitStatusBackgroundWeight);
  css["--git-status-modified-bg"] = mix(bg1, gitModified, gitStatusBackgroundWeight);
  css["--git-status-deleted-bg"] = mix(bg1, gitDeleted, gitStatusBackgroundWeight);

  // Message bubbles
  css["--user-bg"] = userMessageBg;
  css["--assistant-bg"] = bg0;
  css["--tool-bg"] = toolSuccessBg;

  // Hatch pattern
  css["--hatch-color"] = isDark
    ? `rgba(${hexToRgb(accent)?.join(",") || "100,193,182"},0.16)`
    : `rgba(${hexToRgb(accent)?.join(",") || "13,148,136"},0.12)`;

  return css;
}

// ─── Theme loading ──────────────────────────────────────────────────────────

/** All pi CLI color tokens (52; source array, verbatim). */
export const ALL_COLOR_TOKENS: readonly string[] = [
  "accent", "border", "borderAccent", "borderMuted",
  "success", "error", "warning", "muted", "dim", "text", "thinkingText",
  "selectedBg", "userMessageBg", "userMessageText",
  "customMessageBg", "customMessageText", "customMessageLabel",
  "toolPendingBg", "toolSuccessBg", "toolErrorBg", "toolTitle", "toolOutput",
  "mdHeading", "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock",
  "mdCodeBlockBorder", "mdQuote", "mdQuoteBorder", "mdHr", "mdListBullet",
  "toolDiffAdded", "toolDiffRemoved", "toolDiffContext",
  "syntaxComment", "syntaxKeyword", "syntaxFunction", "syntaxVariable",
  "syntaxString", "syntaxNumber", "syntaxType", "syntaxOperator", "syntaxPunctuation",
  "thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium",
  "thinkingHigh", "thinkingXhigh", "thinkingMax",
  "bashMode",
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isColorValue(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
}

/**
 * Normalize parsed theme JSON (already size-capped and JSON-parsed by the
 * caller). Mirrors the source: requires a string name and an object `colors`,
 * fills missing color tokens with "" — except that non-string/number color and
 * vars values are dropped instead of forwarded (they can only produce "" later).
 */
function normalizeThemeJson(json: unknown): PiTheme | null {
  if (!isPlainObject(json)) return null;
  if (typeof json.name !== "string" || json.name === "") return null;
  if (!isPlainObject(json.colors)) return null;
  const varsRaw = isPlainObject(json.vars) ? json.vars : undefined;

  const vars: Record<string, string | number> = {};
  if (varsRaw) {
    for (const [key, value] of Object.entries(varsRaw)) {
      if (isColorValue(value)) vars[key] = value;
    }
  }

  // Fill missing tokens with empty strings
  const colors: Record<string, string | number> = {};
  for (const token of ALL_COLOR_TOKENS) {
    const value = json.colors[token];
    colors[token] = isColorValue(value) ? value : "";
  }

  return { name: json.name, ...(varsRaw ? { vars } : {}), colors };
}

/** Parse and normalize a theme JSON file. Returns null for any invalid file. */
function parseThemeFile(path: string): PiTheme | null {
  try {
    const raw = readFileSync(path, "utf-8");
    return normalizeThemeJson(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Normalize an in-memory built-in theme JSON object. */
function normalizeBuiltinTheme(json: unknown): PiTheme | null {
  return normalizeThemeJson(json);
}

// ─── File-name convention helpers ───────────────────────────────────────────

/**
 * Detect the base name and variant from a theme filename (source behavior):
 *   gruvbox-dark.json  → { base: "gruvbox", variant: "dark" }
 *   gruvbox-light.json → { base: "gruvbox", variant: "light" }
 *   monokai.json       → { base: "monokai", variant: null }
 */
function parseThemeFilename(
  filename: string,
): { base: string; variant: ThemeVariant | null } {
  const stem = basename(filename, extname(filename));

  // Try "-dark" / "-light" suffix (case-insensitive)
  const darkMatch = /^(.+)-dark$/i.exec(stem);
  if (darkMatch) return { base: darkMatch[1]!, variant: "dark" };

  const lightMatch = /^(.+)-light$/i.exec(stem);
  if (lightMatch) return { base: lightMatch[1]!, variant: "light" };

  // Single-file theme — variant determined from content later
  return { base: stem, variant: null };
}

/** Convert a kebab-case theme name to a display-friendly title (source). */
function themeNameToDisplay(name: string): string {
  return name
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// ─── Containment (fail-closed discovery) ────────────────────────────────────

/** True when `child` equals `parent` or is strictly beneath it (both realpaths). */
function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return (
    rel === "" ||
    (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
  );
}

/**
 * Resolve the canonical theme dir for a caller-owned base. Fails closed
 * (null) when the dir does not exist or its realpath escapes the base —
 * a symlinked `themes` directory cannot relocate reads outside agentDir/cwd.
 */
function resolveThemeDir(dir: string, base: string): string | null {
  try {
    if (!existsSync(dir)) return null;
    const realDir = realpathSync(dir);
    const realBase = realpathSync(base);
    return isWithin(realBase, realDir) ? realDir : null;
  } catch {
    return null;
  }
}

/**
 * Canonicalize one candidate theme file inside a resolved theme dir: regular
 * file (symlinks followed), size-capped, realpath inside the dir. Any check
 * failing means the candidate is treated as absent (fail closed).
 */
function canonicalThemeFile(dir: string, filename: string): string | null {
  const fullPath = join(dir, filename);
  try {
    const st = statSync(fullPath); // follows symlinks
    if (!st.isFile()) return null;
    if (st.size > MAX_THEME_FILE_BYTES) return null;
    const realFile = realpathSync(fullPath);
    return isWithin(dir, realFile) ? realFile : null;
  } catch {
    return null;
  }
}

// ─── Scanning ───────────────────────────────────────────────────────────────

/** One discovered theme file with its base name and effective variant. */
interface ScannedFile {
  base: string;
  variant: ThemeVariant;
}

/**
 * Scan a theme directory for pi CLI theme JSON files. Files whose base name is
 * not a safe theme name, files escaping the directory (symlinks), oversized
 * files and invalid JSON are skipped — one bad file never breaks the listing.
 */
function scanThemeDir(dir: string | null): ScannedFile[] {
  const results: ScannedFile[] = [];
  if (!dir) return results;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    // Permission errors, etc.
    return results;
  }
  for (const entry of entries) {
    if (extname(entry) !== ".json") continue;
    const parsed = parseThemeFilename(entry);
    if (!isSafeThemeName(parsed.base)) continue;
    const file = canonicalThemeFile(dir, entry);
    if (!file) continue;
    const theme = parseThemeFile(file);
    if (!theme) continue;
    const vars = resolveVars(theme.vars);
    const bg0 = vars.bg0 || "#1a1a1a";
    const isDark = relativeLuminance(bg0) < 0.5;
    // If variant wasn't detected from filename, infer from content
    const variant = parsed.variant ?? (isDark ? "dark" : "light");
    results.push({ base: parsed.base, variant });
  }
  return results;
}

// ─── Store options ──────────────────────────────────────────────────────────

/** Options for the filesystem-backed read-only theme store. */
export interface PiSdkThemeStoreOptions {
  /** Agent config directory; defaults to the SDK agent dir (PI_CODING_AGENT_DIR or ~/.pi/agent). */
  agentDir?: string;
  /**
   * Canonical absolute project working directory for project themes
   * (`<cwd>/.pi/themes`). Project themes are read ONLY when `trusted` is true.
   */
  cwd?: string;
  /** Effective project trust gating project-local theme discovery. */
  trusted?: boolean;
}

function validateCwd(cwd: string): string {
  if (typeof cwd !== "string" || cwd === "" || cwd.includes("\0") || !isAbsolute(cwd)) {
    throw makeRuntimeError("invalid_input", "theme catalog cwd must be a non-empty absolute path");
  }
  return cwd;
}

function notFoundError(name: string): never {
  throw makeRuntimeError("not_found", `Theme "${name}" not found`);
}

// ─── Store implementation ───────────────────────────────────────────────────

class PiSdkThemeStoreImpl implements PiSdkThemeStore {
  private readonly agentDir: string;
  private readonly trusted: boolean;
  private readonly optionCwd: string | undefined;

  constructor(options: PiSdkThemeStoreOptions) {
    this.agentDir = options.agentDir ?? getAgentDir();
    this.trusted = options.trusted === true;
    this.optionCwd = options.cwd;
  }

  /** Theme dirs in source precedence order: global first, then project. */
  private dirsFor(cwd: string | undefined): (string | null)[] {
    const dirs: (string | null)[] = [
      resolveThemeDir(join(this.agentDir, "themes"), this.agentDir),
    ];
    const effectiveCwd = cwd ?? this.optionCwd;
    if (effectiveCwd !== undefined && this.trusted) {
      const project = validateCwd(effectiveCwd);
      dirs.push(resolveThemeDir(join(project, ".pi", "themes"), project));
    }
    return dirs;
  }

  async listThemeSets(cwd?: string): Promise<readonly ThemeSetInfo[]> {
    const effectiveCwd = cwd !== undefined ? validateCwd(cwd) : undefined;
    const result: ThemeSetInfo[] = [];
    const seen = new Set<string>();

    // Collect all scanned files (global first, then project — source order).
    const allFiles: ScannedFile[] = [];
    for (const dir of this.dirsFor(effectiveCwd)) {
      allFiles.push(...scanThemeDir(dir));
    }

    // Group by base name
    const groups = new Map<string, ScannedFile[]>();
    for (const f of allFiles) {
      const list = groups.get(f.base) || [];
      list.push(f);
      groups.set(f.base, list);
    }

    // Build ThemeSetInfo for each group
    for (const [base, files] of groups) {
      if (seen.has(base)) continue;
      seen.add(base);

      let hasDark = false;
      let hasLight = false;
      for (const f of files) {
        if (f.variant === "dark") hasDark = true;
        if (f.variant === "light") hasLight = true;
      }

      result.push({
        name: base,
        displayName: themeNameToDisplay(base),
        hasDark,
        hasLight,
        builtin: false,
      });
    }

    // Built-in themes — only when no user theme shares the same base name.
    for (const builtin of BUILTIN_THEMES) {
      if (seen.has(builtin.name)) continue;
      seen.add(builtin.name);
      result.push({
        name: builtin.name,
        displayName: themeNameToDisplay(builtin.name),
        hasDark: !!builtin.dark,
        hasLight: !!builtin.light,
        builtin: true,
      });
    }

    return result;
  }

  async resolveTheme(
    name: string,
    mode: ThemeVariant,
    cwd?: string,
  ): Promise<ResolvedTheme> {
    if (!isSafeThemeName(name)) {
      throw makeRuntimeError("invalid_input", "Invalid theme name");
    }
    const effectiveCwd = cwd !== undefined ? validateCwd(cwd) : undefined;

    // Candidate filenames in priority order (source behavior)
    const candidates = [
      `${name}-${mode}.json`,                          // e.g. gruvbox-dark.json
      `${name}.json`,                                  // e.g. monokai.json (single-file)
      `${name}-${mode === "dark" ? "light" : "dark"}.json`, // opposite variant fallback
    ];

    for (const dir of this.dirsFor(effectiveCwd)) {
      if (!dir) continue;
      for (const candidate of candidates) {
        const file = canonicalThemeFile(dir, candidate);
        if (!file) continue;
        const theme = parseThemeFile(file);
        if (!theme) continue;
        return projectTheme(name, theme);
      }
    }

    // NOTE: the source's "try name as a direct file path" fallback is
    // deliberately REMOVED — a theme name must never read outside the theme
    // directories (fail closed).

    // Built-in theme fallback. User themes above take precedence; a built-in
    // is only used when nothing else resolved.
    const builtin = findBuiltinTheme(name);
    if (builtin) {
      const theme =
        mode === "light"
          ? builtin.light ?? builtin.dark
          : builtin.dark ?? builtin.light;
      if (theme) {
        const normalized = normalizeBuiltinTheme(theme);
        if (normalized) return projectTheme(name, normalized);
      }
    }

    notFoundError(name);
  }
}

/** Resolve one theme JSON into the canonical ResolvedTheme projection. */
function projectTheme(name: string, theme: PiTheme): ResolvedTheme {
  const vars = resolveVars(theme.vars);
  const colors = resolveColors(theme.colors, vars);
  const cssVars = mapToCssVars(colors, vars);
  const bg0 = vars.bg0 || "#1a1a1a";
  return {
    name, // Use the base name, not the file's internal name (source behavior)
    isDark: relativeLuminance(bg0) < 0.5,
    cssVars,
  };
}

/**
 * Create the filesystem-backed read-only theme store. Global themes come from
 * `<agentDir>/themes` (default: the SDK agent dir), project themes from
 * `<cwd>/.pi/themes` ONLY while `trusted` is true. No write, no network.
 */
export function createPiSdkThemeStore(
  options: PiSdkThemeStoreOptions = {},
): PiSdkThemeStore {
  return new PiSdkThemeStoreImpl(options);
}
