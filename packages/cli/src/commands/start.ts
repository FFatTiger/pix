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
    const ensured = await ensureSessiond(undefined, pixLog);
    const located = locateSessiond(ensured.directory);
    const location = ensured.endpoint === located.endpoint
      ? located
      : {
          ...located,
          endpoint: ensured.endpoint,
          paths: { ...located.paths, endpoint: ensured.endpoint },
        };
    return runHost(location, options);
  } catch (error) {
    pixErr((error as Error).message);
    return 1;
  }
}
