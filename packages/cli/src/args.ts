/**
 * Minimal, dependency-free argument parsing for the pix CLI. Supports the flags
 * the composition root actually consumes (`--hostname`, `--port`, `--open`,
 * `--no-open`, `--all`) in both `--flag value` and `--flag=value` forms. It
 * deliberately rejects unknown flags so a typo (e.g. `--post`) fails loudly
 * instead of silently binding to the wrong port.
 */

export const DEFAULT_HOSTNAME = "127.0.0.1";
export const DEFAULT_PORT = 30141;

export interface BindOptions {
  hostname: string;
  port: number;
  open: boolean;
}

export interface ParsedFlags {
  /** Positional (non-flag) arguments, in order. */
  positional: string[];
  /** Map of flag name -> raw string value (present flags only). */
  flags: Map<string, string>;
  /** Set of flags that were passed without a value (boolean flags). */
  boolFlags: Set<string>;
}

const VALUE_FLAGS = new Set(["--hostname", "--port"]);
const BOOL_FLAGS = new Set(["--open", "--no-open", "--all"]);

/**
 * Parse an argv array into positionals, value-flags and boolean flags. Throws
 * on an unknown flag or a value-flag missing its value, so callers fail fast.
 */
export function parseFlags(argv: string[]): ParsedFlags {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  const boolFlags = new Set<string>();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq >= 0) {
      const name = arg.slice(0, eq);
      const value = arg.slice(eq + 1);
      if (VALUE_FLAGS.has(name)) {
        flags.set(name, value);
      } else {
        throw new Error(`unknown flag: ${name}`);
      }
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      flags.set(arg, value);
      i += 1;
    } else if (BOOL_FLAGS.has(arg)) {
      boolFlags.add(arg);
    } else {
      throw new Error(`unknown flag: ${arg}`);
    }
  }

  return { positional, flags, boolFlags };
}

/** Parse host-bind options, applying defaults and validating the port range. */
export function parseBindArgs(argv: string[]): BindOptions {
  const { flags, boolFlags } = parseFlags(argv);
  const hostname = flags.get("--hostname") ?? DEFAULT_HOSTNAME;
  const portRaw = flags.get("--port") ?? String(DEFAULT_PORT);
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid port: ${portRaw}`);
  }
  // --no-open wins; default is no browser launch.
  const open = boolFlags.has("--open") && !boolFlags.has("--no-open");
  return { hostname, port, open };
}
