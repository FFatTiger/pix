import { parseBindArgs, type BindOptions } from "../args.js";
import { ensureSessiond, locateSessiond } from "../supervise.js";
import { runHost } from "./host-runner.js";
import { pixLog, pixErr } from "../log.js";

/**
 * `pix start` — M1 one-command boot. Ensures a pingable sessiond (reusing an
 * existing one, otherwise spawning a detached daemon and waiting for RPC
 * readiness), then boots the Hono Host serving the built client.
 */
export async function startCommand(argv: string[]): Promise<number> {
  let options: BindOptions;
  try {
    options = parseBindArgs(argv);
  } catch (error) {
    pixErr((error as Error).message);
    return 2;
  }
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
