// Test-only endpoint selection, shared by compiled tests and the .mjs fixtures.
//
// A real sessiond on win32 listens on the named pipe `sessiondPaths` derives.
// Node refuses `server.listen` on a filesystem `.sock` path there (EACCES,
// port -1), so a stand-in daemon must bind exactly the endpoint the tests
// then connect to. POSIX keeps `<dir>/sessiond.sock`.
import { join } from "node:path";
import { sessiondPaths } from "@fffattiger/pix-sessiond/control";

export function fixtureEndpoint(dir: string): string {
  if (process.platform !== "win32") return join(dir, "sessiond.sock");
  return sessiondPaths(dir).endpoint;
}
