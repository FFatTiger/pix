/**
 * Operator-configured provider identities from the agent-dir models.json.
 *
 * Product decision (settings cleanup): the pix model/provider catalog lists
 * ONLY providers the operator explicitly configured in
 * `<agentDir>/models.json`. Built-in providers — even ones with stored
 * credentials in auth.json or environment keys — are NOT catalog surfaces:
 * the config file is the single source of truth for "which providers did the
 * operator set up".
 *
 * Hard boundaries:
 *  - Reads `models.json` only for provider IDENTITIES (model identities come
 *    from the SDK runtime). The file may contain literal API keys; they are
 *    parsed and immediately discarded and
 *    must never appear in any return value, error, or log.
 *  - A missing file is an honest empty set (no configured providers). A
 *    malformed file fails closed with `invalid_input` — never a silent empty
 *    catalog that masquerades as "no providers configured".
 *  - Comment/trailing-comma tolerance mirrors the Pi SDK's models.json
 *    loader exactly (`//` line comments; no block comments) so the same file
 *    the CLI accepts works here. No other Pi semantics are re-implemented.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { makeRuntimeError } from "@fffattiger/pix-runtime-core";

/**
 * Strip `//` line comments and trailing commas, leaving string literals
 * untouched — the exact tolerance the Pi CLI's models.json loader applies
 * (verified against pi-coding-agent's stripJsonComments). Block comments are
 * NOT valid models.json, matching Pi's own parser.
 */
export function stripJsonComments(text: string): string {
  return text
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match[0] === '"' ? match : ""))
    .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail: string | undefined) =>
      tail ?? (match[0] === '"' ? match : ""));
}

/**
 * Provider ids configured in `<agentDir>/models.json` (empty set when the
 * file is absent). Literal keys and every other field are discarded.
 */
export async function readConfiguredProviderIds(agentDir: string): Promise<ReadonlySet<string>> {
  let raw: string;
  try {
    raw = await readFile(join(agentDir, "models.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set<string>();
    throw makeRuntimeError("unavailable", "models.json could not be read");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(raw));
  } catch {
    throw makeRuntimeError("invalid_input", "models.json is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw makeRuntimeError("invalid_input", "models.json must be an object");
  }
  const providers = (parsed as { providers?: unknown }).providers;
  // Pi's ModelsConfig schema requires the top-level `providers` field. A
  // PRESENT `{}` file is malformed, not equivalent to an absent file; never
  // turn it into a fake successful empty catalog.
  if (providers === undefined) {
    throw makeRuntimeError("invalid_input", "models.json providers is required");
  }
  if (providers === null || typeof providers !== "object" || Array.isArray(providers)) {
    throw makeRuntimeError("invalid_input", "models.json providers must be an object");
  }
  const providerIds = Object.keys(providers);
  if (providerIds.some((id) => id.trim().length === 0)) {
    throw makeRuntimeError("invalid_input", "models.json provider ids must be non-empty");
  }
  return new Set(providerIds);
}
