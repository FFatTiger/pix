import { main as runNodeTests } from "../../../scripts/run-node-test.mjs";

// POSIX implementation tests deliberately exercise Unix path spelling, mode
// bits, hard links, directory fsync, and POSIX race seams. Running those files
// against a Windows filesystem proves neither backend and produces false
// failures. Windows instead runs every portable contract/process test plus the
// dedicated native Windows backend suite. POSIX keeps the complete test set.
const WINDOWS_TEST_FILES = [
  "test/build-native.test.mjs",
  "test/package-surface.test.mjs",
  "test/platform-factory.test.mjs",
  "test/process-start.test.mjs",
  "test/process-tree.test.mjs",
  "test/root-policy.test.mjs",
  "test/windows-backend.test.mjs",
  "test/windows-identity.test.mjs",
  "test/windows-native.test.mjs",
  "test/windows-path.test.mjs",
  "test/windows-security.test.mjs",
];

const patterns = process.platform === "win32" ? WINDOWS_TEST_FILES : ["test/*.test.mjs"];
process.exitCode = runNodeTests(patterns);
