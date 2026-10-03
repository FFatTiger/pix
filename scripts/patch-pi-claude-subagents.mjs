import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PATCHED_PLUGIN_VERSION = "0.3.8";
// Remove this patch and the postinstall/prebuild hooks once upstream 0.3.9+
// publishes native run-record / child event interfaces, after preserving
// (1) publish-before-return of the persisted running record and (2) in-process
// child message_update forwarding. 0.3.8 already ships the stale-index fix
// (737e775). The Pi 1.0 package also has durable resume preparation and fresh
// progress previews; only the two Pix bridge behaviors above are patched here.
const PRISTINE_RUNTIME_SHA256 = "176a4d6c678af81c95acdd8f2bf6fa2374ce33fb8f10ea493c6ea4cad83d4cd2";
const PATCHED_RUNTIME_SHA256 = "bc9b3ef4e92263ba9aac1b184621f25e3afb05ee42684b7719bd36a4f23fc218";
const RUNTIME_PATH = ["src", "runtime.ts"];

const replacements = [
  ["  createUnpersistedTaskRecord,\n", "  createTaskRecord,\n"],
  ["  const record = await createUnpersistedTaskRecord({", "  const record = await createTaskRecord({"],
  [
    "    name: options.spec.name,\n  });\n  const abortController = new AbortController();",
    "    name: options.spec.name,\n  });\n  options.onUpdate?.(record);\n  const abortController = new AbortController();",
  ],
  [
    [
      "          const unsubscribe = childSession.subscribe(event => {",
      "            if (event.type === \"message_end\") {",
      "              messages.push(event.message);",
      "              if (event.message.role === \"assistant\") {",
      "                applyAssistantTokenUsage(record, event.message);",
      "              }",
    ].join("\n"),
    [
      "          const unsubscribe = childSession.subscribe(event => {",
      "            if (event.type === \"message_update\") {",
      "              globalThis.__pixSubagentStream?.(childSession.sessionId, event);",
      "            }",
      "            if (event.type === \"message_end\") {",
      "              messages.push(event.message);",
      "              if (event.message.role === \"assistant\") {",
      "                applyAssistantTokenUsage(record, event.message);",
      "                globalThis.__pixSubagentStream?.(childSession.sessionId, event);",
      "              }",
    ].join("\n"),
  ],
  [
    [
      "      unsubscribe = childSession.subscribe(event => {",
      "        if (event.type !== \"message_end\") return;",
      "        messages.push(event.message);",
      "        if (event.message.role === \"assistant\") applyAssistantTokenUsage(options.record, event.message);",
      "        const preview = extractFinalText(messages);",
      "        if (preview) options.record.preview = preview.split(\"\\n\")[0]?.slice(0, 300);",
      "        applyLifecycleUsage(options.record, usageBaseline, lifecycle.snapshot.usage);",
      "      });",
    ].join("\n"),
    [
      "      unsubscribe = childSession.subscribe(event => {",
      "        if (event.type === \"message_update\") {",
      "          globalThis.__pixSubagentStream?.(sessionManager.getSessionId(), event);",
      "        }",
      "        if (event.type !== \"message_end\") return;",
      "        messages.push(event.message);",
      "        if (event.message.role === \"assistant\") {",
      "          applyAssistantTokenUsage(options.record, event.message);",
      "          globalThis.__pixSubagentStream?.(sessionManager.getSessionId(), event);",
      "        }",
      "        const preview = extractFinalText(messages);",
      "        if (preview) options.record.preview = preview.split(\"\\n\")[0]?.slice(0, 300);",
      "        applyLifecycleUsage(options.record, usageBaseline, lifecycle.snapshot.usage);",
      "      });",
    ].join("\n"),
  ],
];

function sha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

function replaceUnique(source, oldText, newText) {
  const matches = source.split(oldText).length - 1;
  if (matches !== 1) throw new Error(`pi-claude-subagents patch point count was ${matches}, expected 1`);
  return source.replace(oldText, newText);
}

export function patchPiClaudeSubagents(packageRoot) {
  const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  if (packageJson.name !== "pi-claude-subagents" || packageJson.version !== PATCHED_PLUGIN_VERSION) {
    throw new Error(`unsupported pi-claude-subagents version: ${String(packageJson.version ?? "missing")}`);
  }

  const runtimePath = join(packageRoot, ...RUNTIME_PATH);
  const runtime = readFileSync(runtimePath, "utf8");
  const digest = sha256(runtime);
  if (digest === PATCHED_RUNTIME_SHA256) return false;
  if (digest !== PRISTINE_RUNTIME_SHA256) {
    throw new Error(`unsupported pi-claude-subagents runtime layout: ${digest}`);
  }

  const patched = replacements.reduce(
    (source, [oldText, newText]) => replaceUnique(source, oldText, newText),
    runtime,
  );
  const patchedDigest = sha256(patched);
  if (patchedDigest !== PATCHED_RUNTIME_SHA256) {
    throw new Error(`pi-claude-subagents patched runtime hash mismatch: ${patchedDigest}`);
  }
  writeFileSync(runtimePath, patched);
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  patchPiClaudeSubagents(join(repoRoot, "node_modules", "pi-claude-subagents"));
}
