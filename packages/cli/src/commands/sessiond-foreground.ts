import { main } from "@fffattiger/pix-sessiond/daemon";
import { pixErr } from "../log.js";

/**
 * `pix sessiond` — run the sessiond daemon in the foreground (same lifecycle as
 * the `pix-sessiond` bin). Reads `PIX_SESSIOND_DIR` then `~/.pi/pix/sessiond`.
 * Returns the daemon's exit code; never returns while the daemon is running.
 */
export async function sessiondCommand(): Promise<number> {
  try {
    return await main();
  } catch (error) {
    pixErr((error as Error).message);
    return 1;
  }
}
