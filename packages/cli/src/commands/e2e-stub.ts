import { pixErr } from "../log.js";

/**
 * `pix test:e2e:startup` — owned by B5 (Startup E2E). B4 exposes the command
 * surface and dispatcher but deliberately does not implement the end-to-end
 * startup test. It fails clearly (exit 1) rather than reporting false success,
 * so a CI gate that references it cannot pass silently before B5 lands.
 */
export async function e2eStartupCommand(): Promise<number> {
  pixErr("test:e2e:startup is not implemented yet (B5 Startup E2E)");
  return 1;
}
