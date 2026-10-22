import { DEFAULT_HOSTNAME, DEFAULT_PORT, parseBindArgs, parseFlags, type BindOptions } from "../args.js";
import { readHostRecord } from "../host-daemon.js";
import { launchBackground } from "./start.js";
import { stopServices } from "./stop.js";
import { pixErr } from "../log.js";

/**
 * `pix restart [--all] [--hostname H] [--port P] [--open]` — stop the
 * background Host and start it again in the background. The previous bind
 * address is reused unless overridden. `--all` also restarts sessiond, which
 * interrupts running sessions; without it sessions survive.
 */
export async function restartCommand(argv: string[]): Promise<number> {
  let options: BindOptions;
  let all: boolean;
  try {
    const parsed = parseFlags(argv);
    if (parsed.positional.length > 0 || parsed.boolFlags.has("--foreground")) {
      throw new Error("usage: pix restart [--all] [--hostname H] [--port P] [--open|--no-open]");
    }
    all = parsed.boolFlags.has("--all");
    const previous = readHostRecord();
    options = parseBindArgs(
      argv.filter((arg) => arg !== "--all"),
      previous.kind === "ok"
        ? { hostname: previous.record.hostname, port: previous.record.port }
        : { hostname: DEFAULT_HOSTNAME, port: DEFAULT_PORT },
    );
  } catch (error) {
    pixErr((error as Error).message);
    return 2;
  }
  const stopped = await stopServices(all);
  if (stopped !== 0) return stopped;
  return launchBackground(options);
}
