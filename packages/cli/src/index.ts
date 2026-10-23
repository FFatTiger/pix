/**
 * pix CLI — production composition + lifecycle entry point.
 *
 * Dispatches the lifecycle commands (`start`, `host`, `status`, `down`,
 * `sessiond`, `update`, `test:e2e:startup`) to their command modules. The root
 * `scripts/product-entry.mjs` and the `pix` bin both reach the CLI through
 * {@link runCli}, keeping a single source of truth for command behavior.
 *
 * Composition-root scope: this package only starts/stops the Host and sessiond
 * and discovers running instances. It imports no Worker/runtime/WS/files
 * resources and declares no capability beyond what the Host actually mounts.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startCommand } from "./commands/start.js";
import { hostCommand } from "./commands/host.js";
import { statusCommand } from "./commands/status.js";
import { stopCommand } from "./commands/stop.js";
import { restartCommand } from "./commands/restart.js";
import { logsCommand } from "./commands/logs.js";
import { downCommand } from "./commands/down.js";
import { sessiondCommand } from "./commands/sessiond-foreground.js";
import { updateCommand } from "./commands/update.js";
import { pixErr, pixLog } from "./log.js";

/**
 * Read the CLI package version from the manifest adjacent to this compiled
 * module (`dist/index.js` → `../package.json`), which holds in both the
 * workspace layout and the REL1 self-contained release bundle.
 */
export function resolveCliVersion(fromUrl: string = import.meta.url): string {
  try {
    const manifest = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(fromUrl)), "..", "package.json"), "utf8"),
    ) as { version?: unknown };
    if (typeof manifest.version === "string" && manifest.version.length > 0) {
      return manifest.version;
    }
  } catch {
    // fall through to a fixed unknown marker
  }
  return "unknown";
}

function printHelp(): void {
  pixLog("usage: pix <command> [options]");
  pixLog("commands:");
  pixLog("  start [--hostname H] [--port P] [--open|--no-open] [--detach]");
  pixLog("                                      ensure sessiond + boot host (--detach: in the background)");
  pixLog("  stop [--all]                        stop the background host (--all also stops sessiond)");
  pixLog("  restart [--all] [--hostname H] [--port P] [--open]");
  pixLog("                                      restart the background host (--all also restarts sessiond)");
  pixLog("  status                              report sessiond + background host state");
  pixLog("  logs [--lines N] [--follow]         print the background host log");
  pixLog("  host  [--hostname H] [--port P] [--open|--no-open]  boot host only (needs sessiond)");
  pixLog("  down --all                          stop sessiond only (requires --all)");
  pixLog("  sessiond                            run sessiond in the foreground");
  pixLog("  update [version] [--check] [--restart]  install the latest (or given) release from npm");
}

/**
 * Run the pix CLI against `argv` (the args after the command name). Resolves
 * with the process exit code; never throws — errors are mapped to exit codes.
 */
export async function runCli(argv: string[]): Promise<number> {
  const command = argv[0];
  const rest = argv.slice(1);
  switch (command) {
    case "--version":
    case "-v": {
      pixLog(`pix ${resolveCliVersion()}`);
      return 0;
    }
    case "start":
      return startCommand(rest);
    case "host":
      return hostCommand(rest);
    case "stop":
      return stopCommand(rest);
    case "restart":
      return restartCommand(rest);
    case "logs":
      return logsCommand(rest);
    case "status":
      return statusCommand();
    case "down":
      return downCommand(rest);
    case "sessiond":
      return sessiondCommand();
    case "update":
      return updateCommand(rest);
    case undefined:
    case "-h":
    case "--help":
    case "help":
      printHelp();
      return 0;
    default:
      pixErr(`unknown command: ${command}`);
      printHelp();
      return 2;
  }
}
