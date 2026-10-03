# Pix / Pi 1.0 adaptation

This change upgrades the Pi SDK packages to 1.0.0. Pi imports remain inside
`pi-sdk-adapter`; sessiond remains the session authority. History reads do not
start workers or load project extensions.

## Behavior

| Pi 1.0 surface | Pix behavior | Boundary |
| --- | --- | --- |
| Native MCP | Adapter registers the native `builtin:mcp` factory. `/mcp` status and authorization messages reach the web notification surface. | Server definitions belong in `mcp.json`, including trusted project `.pi/mcp.json`. Untrusted project files are not loaded. |
| Codemode and tool search | Adapter registers the native factories and respects `defaultTools`, default-inactive tools, disabled builtins and user replacements. | No second MCP implementation. A forced-empty tool policy stays empty through startup and reload. |
| Global tool selection (`pixDefaultTools`) | The global `settings.json` key selects the tools offered to new sessions: `null`/absent-without-`defaultTools` = all selectable tools (codemode/tool_search included, future tools auto-on), an array = explicit allowlist (empty = all off), absent key = the native `defaultTools` selection (± entries honored, never overwritten). Applied at startup, after `bindExtensions` and after reload for prefs-following runtimes; an explicit `input.toolNames`/`setTools` override still wins. Edited via Settings → Tools (GET/PUT `/v1/settings/tools`, same settings.json CAS/lock as the raw editor). | Hidden/deferred/codemode-exposure tools are never on/off rows (adapter projection filters to direct/model-only). Saved-but-unavailable names persist without applying. The structured write touches only `pixDefaultTools`; the raw editor stays verbatim. |
| Extension commands and input hooks | SDK preflight distinguishes a started prompt, queued input and input handled by an extension. Handled input can finish without an assistant message. | The client removes the corresponding optimistic message when an extension consumes it. Genuine errors keep their error behavior. |
| Extension notifications | Informational and warning messages use a typed notification event and bounded notification state. | Errors continue through the error path. OAuth URLs are shown in the web UI; the Host does not open a browser. |
| Nested tool calls | Parent call identity survives tool start/update/end events. A parent tool result carries its nested-call summary, structured output and tool usage. | Summaries stay inside the parent result. They do not create transcript entry IDs or subagent sessions. Nested writes still update written-file tracking. |
| Tool result media | Existing image rendering is retained alongside textual and structured output. | Image payloads continue through the existing history deferral and wire limits. |
| Edited context | Live and history estimates invalidate usage measured before a later context edit. | Estimates use the selected raw branch before pagination or media deferral. Post-compaction usage remains unknown until a retained valid response exists. |
| Virtual chat models | Registered virtual chat models remain selectable. Unknown context limits are omitted. Live window limits come from the SDK, including its physical-response selection. | The zero-worker global catalog does not execute session extensions to discover session-only virtual models. History cannot reconstruct an unregistered router from a physical response name. |
| Image and classifier models | The chat picker uses the SDK's chat-model catalog. | Image generation and classification remain separate SDK/extension operations, not ordinary chat model selections. |
| Side chat | Direct, active extension tools are copied into the side chat. Namespaced tools in read-only mode require a read-only annotation. | Hidden, deferred, codemode and model-only tools are not made directly callable. Side chat has no nested-call host, so codemode/tool-search execution stays in the main session. |
| Terminal-only features | SDK terminal features remain available to Pi terminal users. | Pix does not expose fullscreen terminal layout or terminal theme settings as web functionality. |

## Subagent notifications

The updated plugin buffers only until the next safe tool boundary. At that
boundary it sends a steering message. It does not wait for the parent's full
run to finish. Idle parents receive a coalesced notification that starts a turn.

- Keep the latest pending state per child; completion replaces a pending warning.
- Combine children ready at the same boundary into one message.
- Include stage preview and execution counters in progress warnings; mark an
  unchanged preview honestly.
- Return the first foreground checkpoint through the Agent tool without a
  second automatic copy. A launch containing foreground children reserves all
  its slots before any child starts; insufficient capacity rejects the whole
  launch so waiting for another slot cannot block checkpoint delivery.
- A terminal status whose output is still being saved does not acknowledge
  delivery. Agent summaries and TaskOutput leave its completion notification pending.
- Retain TaskOutput for requested status checks, recovery and diagnosis. Reading
  a final result suppresses another automatic delivery for that execution,
  including a completion callback that arrives later. Reading a running result
  does not suppress its eventual completion.
- A resumed child can report its new result. Durable resume preparation commits
  the new notification generation; preparation failure preserves the previous
  record and its pending result. Stage previews start fresh. Late callbacks from
  an older execution cannot settle the new one. A completed execution cannot
  return to running because of an old warning.
- Notifications and TaskOutput read the latest invocation's output. The output
  archive retains earlier invocations, with a persisted offset locating the
  latest result even when older output is long or contains separator text.
- Session shutdown discards pending notifications; late callbacks cannot send
  messages into a replacement session.

Pix recognizes single and batched plugin messages as refresh signals. Validated
persisted task records remain the owner of subagent state; notification details
do not bypass membership or child-session identity checks.

## Existing compatibility patch

The local subagent package still needs Pix's existing running-record publication
and child-stream bridge patch. Native nested tool calls are unrelated to that
bridge and cannot replace it. The finite removal condition and protected hashes
remain in `docs/migration-ledger.md`, section 110.

## Interface corrections

Session selection no longer moves a row to the top. Activity time and explicit
pinning determine list order. Running child agents open their card by default;
a manual collapse survives updates within that running batch. Earlier/later todo
counts are buttons that expand the whole list and allow it to be collapsed again.

## Validation

Coverage includes offline real-SDK builtin registration, trusted project MCP
configuration, command handling without an assistant turn, native activation
across reload, live/history context parity after edits, nested-call metadata and
secret redaction, protocol/core vocabulary and limit parity, worker mapping, and
client interaction tests. Provider-backed OAuth login and real remote model
routing require external service availability; an offline test does not prove
those services are available.

Those input receipts also cross an authority barrier: sessiond refreshes the
worker snapshot before publishing a terminal turn status. It sends the same
session/epoch/cursor-fenced snapshot through the observation stream and the
exact turn subscription. An attached client preserves its event FIFO; a
background session can converge without taking the visible session's lease.
A fast handled input therefore cannot leave an older admission snapshot marked
running in either server or browser. Refresh failure is explicit; a real
external stream remains busy. The snapshot deadline stays effective while
transport writes are blocked, and late failures cannot settle another request.

Implementation validation completed with root `check:architecture`, `typecheck`,
`test`, `build`, Client/Adapter boundaries, Adapter command coverage,
startup/runtime/sessions E2E and `git diff --check` passing. The root test run
had 3,519 passes and one platform skip; this includes Client 1,217, Adapter 528,
Protocol 246 and sessiond 397 passes. The subagent package at `aaa56e9` passed
all 120 tests and independent verification.

Independent Pix verification closed all findings, including the actual
fast-handled Adapter → Worker → sessiond → Client interleaving, stdin write
backpressure, quoted credential truncation, background controller isolation,
external stream preservation and the exact packaged bridge hashes.

Production activation completed on 2026-10-03 at 14:02 Asia/Shanghai after
explicit user approval. A detached executor stopped the identity-checked Host,
shut down sessiond through its authenticated RPC, then started both with the
production environment and absolute entry path. The new daemon authenticated
with the expected sessiond/Worker/Adapter contracts **8/7/7**. Local and public
health checks passed, and the public JS/CSS bytes matched the validated build.
The parent independently repeated the authenticated build and public health
checks after restart. Deployment evidence is recorded in migration ledger §113.

The Tools settings update went live on 2026-10-03 at 15:35 Asia/Shanghai. The
Host and client assets were updated while sessiond and its four live sessions
were retained, because another session was working. Global tool selection was
verified as `all`. New Workers read the new defaults; an existing attached
session can apply them immediately with **Settings → Tools → Enable all**.
All ten root validation steps and the independent source review passed.
