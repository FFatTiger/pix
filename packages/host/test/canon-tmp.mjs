// Temporary directories for host tests, in the long canonical form.
//
// `os.tmpdir()` on a Windows runner is the 8.3 short name (`C:\Users\RUNNER~1\…`)
// while `fs.realpath` (and therefore every canonical path the host returns)
// expands it to the long name (`C:\Users\runneradmin\…`). A test that builds
// its directory from the short name and then compares it to a realpath result
// fails even though both name the same directory. `realpathSync.native` asks
// the OS for the long name; the JS realpath keeps the short one.
import { realpathSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CANON_TMP = realpathSync.native(tmpdir());

export function tempDir(prefix) {
  return realpathSync.native(mkdtempSync(join(CANON_TMP, prefix)));
}
