# Vendored pi-side-chat headless engine

This directory is an adapter-internal, characterized downstream port of `pi-side-chat@0.4.0`. It is not an installed npm dependency and is not exported from `@fffattiger/pix-pi-sdk-adapter`.

## Exact origin

- Project: <https://github.com/nicobailon/pi-side-chat>
- License: MIT, retained in `LICENSE`
- Version: `pi-side-chat@0.4.0`
- Git commit: `9d59cc042634111c1ed633b7bacb9f74611aebbd`
- npm tarball SHA-1: `6e61267ad1473bd051b7d89b73c6fbd566323da9`
- npm tarball integrity: `sha512-bNtnTQkyXGsfmtgVR+4SgBmV6yTEo7lh9ZNoFKrcxcDWJcAIukbTi7JtqOmjOecoAxtH4kOCuIVsmdUW6wwFrw==`

Source SHA-1 values from that tarball:

| Upstream source | SHA-1 | Downstream file/use |
| --- | --- | --- |
| `side-chat-overlay.ts` | `577b474bdcde329625f5c2ae692517f6cf60c9a3` | `headless-controller.ts` agent construction, prompt lifecycle, mode tools, `peek_main`, event projection |
| `fork-surgery.ts` | `06d85e8832578396cf5686b921c2a4a494be887a` | `fork-surgery.ts` |
| `file-activity-tracker.ts` | `171c74abca0cce983257b82aff9f941c27b1b4f9` | `file-activity-tracker.ts` |
| `tool-wrapper.ts` | `bceaee0b404947a76a485617c1a448f93e2d2c76` | `tool-wrapper.ts` |
| `index.ts` | `d1d9b05de262532875f7b499001745aa9e71a9a1` | Extension-tool adaptation and main-write tracking behavior only; its global `ExtensionRunner.prototype` patch is deliberately excluded |
| `package.json` | `baaaf3e554dcf3702af98df16979c7288d04d6e6` | Version/license metadata |

The tarball can be rechecked without modifying this repository:

```bash
mkdir -p /tmp/pi-side-chat-0.4.0
cd /tmp/pi-side-chat-0.4.0
npm pack --ignore-scripts pi-side-chat@0.4.0
shasum pi-side-chat-0.4.0.tgz
```

## Downstream edits

- Retargeted `@mariozechner/pi-*` imports to Pix's pinned `@earendil-works/pi-*` 0.87.1 APIs and the current camel-case `toolCall` message shape.
- Extracted the reusable `Agent` lifecycle from the private TUI overlay into a typed headless controller. Terminal rendering, editor, layout, focus, shortcuts, overlay persistence, and `ctx.ui.custom` are not copied.
- Uses the caller's real `ModelRuntime` or `ModelRegistry` `streamSimple` method, read-only session manager, registered extension tools, and public extension-context factory. It does not patch `ExtensionRunner` or inspect private fields.
- Added synchronous run admission, conversation/run IDs, monotonic revisions, generation fences, structured streaming thinking/text and tool status, bounded overlap waits, stale overlap rejection, independent abort, and bounded idempotent disposal.
- Added `details: undefined` to short-circuit tool results required by the 0.87.1 `AgentToolResult` contract.
- Replaced the upstream unbounded overlap confirmation promise with a 30-second deny timeout. Abort/dispose also deny and settle a pending confirmation.
- Side display state starts after the fork baseline and framing message, so copied parent messages are model context only.

Discussion (`read_only`) mode removes the built-in `bash`, `edit`, and `write` tools by using upstream `createReadOnlyTools`. Registered extension tools remain available with their original permissions; this is not a complete mutation sandbox. Edit-mode bash overlap detection remains heuristic, as upstream documents.

Reset, clear, and refork are intentionally not controller mutations. The owner disposes this controller and creates a new one, which captures a fresh parent branch/model/thinking/system prompt and receives a new conversation identity.

## Mandatory removal condition

This port is pinned to `pi-side-chat@0.4.0`. The first Pix upgrade away from that version must remove it in favor of a compatible upstream public headless controller, or replace it with a newly reviewed and characterized versioned port. It must never survive an upstream version change implicitly.
