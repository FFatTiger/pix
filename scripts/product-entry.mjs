// Root product dispatcher. The lifecycle commands (`start`, `cli …`,
// `test:e2e:startup`) are implemented in the compiled `@fffattiger/pix-cli`
// package; this script only routes `npm run` / direct invocation to it so there
// is a single source of truth for command behavior (shared with the `pix` bin).
//
// It fails clearly when the CLI has not been built yet, rather than crashing on
// a missing module.

const command = process.argv[2] ?? "unknown";
const rest = process.argv.slice(3);

/** Map a root product-entry command to the argv the unified CLI expects. */
function cliArgv(cmd, tail) {
  switch (cmd) {
    case "start":
      return ["start", ...tail];
    case "cli":
      // `npm run cli -- status` → product-entry "cli" "status" → runCli ["status", ...]
      return tail;
    case "test:e2e:startup":
      return ["test:e2e:startup", ...tail];
    default:
      return null;
  }
}

const argv = cliArgv(command, rest);

if (argv === null) {
  console.error(`[pix] unknown bootstrap command: ${command}`);
  console.error("[pix] available: start | cli | test:e2e:startup");
  process.exitCode = 2;
} else {
  try {
    const { runCli } = await import("@fffattiger/pix-cli");
    const code = await runCli(argv);
    process.exitCode = code;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Cannot find module") || message.includes("ERR_MODULE_NOT_FOUND")) {
      console.error("[pix] the CLI is not built — run `npm run build` first");
    } else {
      console.error(`[pix] ${message}`);
    }
    process.exitCode = 1;
  }
}
