import { existsSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { parseFlags } from "../args.js";
import { hostLogPath, tailFile } from "../host-daemon.js";
import { pixErr } from "../log.js";

const DEFAULT_LINES = 100;
const FOLLOW_POLL_MS = 500;

/**
 * `pix logs [--lines N] [--follow]` — print the background Host log (stdout
 * and stderr of the Host started by `pix start --detach`). `--follow` keeps streaming
 * appended output until interrupted.
 */
export async function logsCommand(argv: string[]): Promise<number> {
  let lines = DEFAULT_LINES;
  let follow: boolean;
  try {
    const parsed = parseFlags(argv);
    if (parsed.positional.length > 0) throw new Error("usage: pix logs [--lines N] [--follow]");
    const raw = parsed.flags.get("--lines");
    if (raw !== undefined) {
      lines = Number(raw);
      if (!Number.isInteger(lines) || lines < 0) throw new Error(`invalid --lines: ${raw}`);
    }
    follow = parsed.boolFlags.has("--follow");
  } catch (error) {
    pixErr((error as Error).message);
    return 2;
  }
  const path = hostLogPath();
  if (!existsSync(path)) {
    pixErr(`no host log yet (${path}); start the host with \`pix start --detach\``);
    return 1;
  }
  const tail = tailFile(path, lines);
  if (tail !== "") process.stdout.write(`${tail}\n`);
  if (!follow) return 0;

  let offset = statSync(path).size;
  return new Promise<number>((resolve) => {
    const timer = setInterval(() => {
      let size: number;
      try {
        size = statSync(path).size;
      } catch {
        return; // rotated away; keep waiting for the new file
      }
      if (size < offset) offset = 0; // rotated / truncated
      if (size === offset) return;
      const fd = openSync(path, "r");
      try {
        const buffer = Buffer.alloc(size - offset);
        readSync(fd, buffer, 0, buffer.length, offset);
        process.stdout.write(buffer);
        offset = size;
      } finally {
        closeSync(fd);
      }
    }, FOLLOW_POLL_MS);
    process.once("SIGINT", () => {
      clearInterval(timer);
      resolve(0);
    });
  });
}
