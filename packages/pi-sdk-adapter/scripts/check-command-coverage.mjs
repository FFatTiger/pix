import { readFile } from "node:fs/promises";

const commands = [
  "prompt", "abort", "get_state", "set_model", "fork", "navigate_tree",
  "set_thinking_level", "compact", "set_session_name", "get_session_stats",
  "get_last_assistant_text", "set_auto_compaction", "clear_queue", "steer",
  "follow_up", "get_tools", "get_commands", "set_tools", "reload",
  "abort_compaction", "extension_ui_response", "extension_ui_input",
  "set_auto_retry", "bash", "abort_bash", "generate_session_title",
];
const source = await readFile(new URL("../src/internal/adapter.ts", import.meta.url), "utf8");
const missing = commands.filter((command) => !source.includes(`case \"${command}\"`));
if (missing.length) {
  console.error(`missing command implementations: ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`pi-sdk-adapter command coverage: PASS (${commands.length}/26)`);
