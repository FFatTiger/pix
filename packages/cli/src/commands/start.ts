import { parseBindArgs, type BindOptions } from "../args.js";
import { ensureSessiond, locateSessiond } from "../supervise.js";
import { defaultHostDaemonDeps, startHostBackground, tailFile, type HostDaemonDeps } from "../host-daemon.js";
import { openBrowser, runHost } from "./host-runner.js";
import { pixLog, pixErr } from "../log.js";

/**
 * Ensure sessiond, then start the Host in the background and report where it
 * listens. Shared by `start --detach` and `restart`.
 */
export async function launchBackground(
  options: BindOptions,
  deps: HostDaemonDeps = defaultHostDaemonDeps(),
): Promise<number> {
  try {
    await ensureSessiond(undefined, pixLog);
  } catch (error) {
    pixErr((error as Error).message);
    return 1;
  }
  const result = await startHostBackground(options, deps);
  if (result.action === "failed") {
    pixErr(result.reason);
    const tail = result.logFile === undefined ? "" : tailFile(result.logFile, 20);
    if (tail !== "") {
      pixErr(`last lines of ${result.logFile}:`);
      for (const line of tail.split("\n")) pixErr(`  ${line}`);
    }
    return 1;
  }
  const { record } = result;
  pixLog(
    result.action === "already-running"
      ? `host already running (pid ${record.pid}) at ${record.url}`
      : `host started in the background (pid ${record.pid}) at ${record.url}`,
  );
  pixLog(`  logs: ${record.logFile}  (\`pix logs --follow\`)`);
  pixLog("  stop: `pix stop`  ·  status: `pix status`");
  if (options.open) openBrowser(record.url);
  return 0;
}

/**
 * `pix start` — one-command boot. Ensures a pingable sessiond (reusing an
 * existing one, otherwise spawning a detached daemon and waiting for RPC
 * readiness), then boots the Hono Host serving the built client in the
 * foreground. `--detach` starts the Host in the background instead and
 * returns once it is healthy (`pix stop` / `restart` / `logs` manage it).
 */
export async function startCommand(argv: string[]): Promise<number> {
  // `--detach` is start-only; every other command rejects it as unknown.
  const detach = argv.includes("--detach");
  let options: BindOptions;
  try {
    options = parseBindArgs(argv.filter((arg) => arg !== "--detach"));
  } catch (error) {
    pixErr((error as Error).message);
    return 2;
  }
  if (detach) return launchBackground(options);
  try {
    await ensureSessiond(undefined, pixLog);
  } catch (error) {
    pixErr((error as Error).message);
    return 1;
  }
  // After ensure, the resolved location matches the daemon's directory.
  const location = locateSessiond();
  return runHost(location, options);
}
