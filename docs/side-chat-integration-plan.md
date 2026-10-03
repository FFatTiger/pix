# Side chat integration slice

Status: implementation and all four independent reviews passed. Final root gates and real SDK/Chrome desktop/mobile acceptance passed; evidence is recorded in [side-chat-acceptance.md](./side-chat-acceptance.md). Production cutover remains a separate idle-gated operation.

## Product behavior

- Right pane has Files, Agents, and Side chat choices, reusing the existing resizable desktop panel/mobile drawer.
- One side conversation per active parent runtime. No new tabs or selected-text sharing in this slice.
- The real `pi-side-chat@0.4.0` engine carries the feature, through a pinned headless downstream port inside `pi-sdk-adapter`; do not invoke terminal UI or build an unrelated chat path.
- Opening requires an exact live parent with `runtime.side_chat`. Reading a historical session never implicitly starts a Worker.
- Starting snapshots the current main branch/model/thinking/system prompt. Existing side context does not follow later parent model changes; refork captures the current context again.
- Side send runs independently of a parent turn. Main abort and side abort affect only their respective agents.
- Closing the pane retains side state. Reopening or reconnecting to the same Worker restores it from the authoritative runtime snapshot.
- Conversation is ephemeral as upstream: never added to the main JSONL; Worker close/crash/reload or capability disable clears it. UI must explain this lifetime briefly.
- Default discussion mode removes the plugin's built-in write tools; extension tools retain their original permissions. Do not label this a complete read-only security sandbox. Edit mode retains upstream overlap confirmation and heuristic limitations.
- Refork and clear reset discussion mode. Pending overlap confirmation is part of the snapshot, settles on abort/dispose/reset, and stale replies fail `not_found`.

## Package adaptation

Pinned upstream: npm `pi-side-chat@0.4.0`, git `9d59cc042634111c1ed633b7bacb9f74611aebbd`, npm shasum `6e61267ad1473bd051b7d89b73c6fbd566323da9`.

Vendor the reusable headless controller extracted from the actual upstream overlay plus `fork-surgery`, `file-activity-tracker`, and `tool-wrapper`, retaining MIT license and precise source hashes/provenance. Retarget SDK imports to the repository's exact `@earendil-works/pi-*` and `typebox`. Do not vendor terminal rendering or globally patch `ExtensionRunner.prototype`; inject the parent's public extension runner/context/tool surfaces.

The first Pix upgrade away from this pinned upstream 0.4.0 port must remove this vendor and adopt a compatible public controller, or explicitly replace the versioned port with newly characterized code. It must not survive an upstream version change implicitly.

Controller surface: create from fork context/services; getState/subscribe; synchronous submit admission returning runId and a completion promise; setMode; resolveOverlap; abort; bounded idempotent dispose. Streams/events carry conversation and run identity; lifecycle generation fences suppress callbacks from disposed controllers.

## Ownership and wire behavior

- Runtime Core owns bounded side state/message/stream/mode/tool/overlap/error models and constants; Protocol owns wire schemas and the shared state accumulator. No parallel independent vocabulary arrays.
- Stable conversationId/runId and monotonic revision identify replacement state and deltas. Reset starts a new conversation identity. Invalid/stale identities never append to another run.
- Project only bounded display data with explicit truncation. Start with 64 messages, 16,384 characters per message/stream and 262,144 total display characters; keep limits canonical in Runtime Core and prove Protocol parity. Never silently truncate model input or claim truncated display is complete.
- Commands: side_chat_start, side_chat_send, side_chat_reset(refork|clear), side_chat_set_mode, side_chat_overlap_response. Non-start commands target the exact conversationId.
- Independent interrupt: abort_side_chat, targeting exact conversationId.
- All operations require the existing runtime.side_chat token; advertise it only after the real controller seam is available and enabled.
- Send acknowledges admission promptly and never awaits the model completion. Side state is published before its command result; authority-mutating side commands also follow the repository's bounded worker.getSnapshot refresh rule before terminal publication.
- Use existing Host bounded interleaving infrastructure to avoid a long main command blocking side controls. Client owns a separate bounded side command slot with same-commandId same-epoch resend and exact-once teardown on detach/epoch change/capability loss/dispose.
- Side activity blocks idle reclamation and epoch rollover while running or awaiting overlap response. It does not become main isTurnRunning/busySessionIds and cannot block main prompt admission.
- Adapter owns plugin/controller translation and main-write tracking; Worker maps Core to Protocol, sessiond owns lifecycle/journal, Client renders the canonical projection through existing runtime transport.
- Parent main messages/scroll/composer remain independent. Do not mount a second unscoped main Composer or attach a second socket.

## Delivery sequence

1. Finish and independently verify the running-Agent identity/committed-history observation repair already in progress.
2. Implement and characterize the pinned plugin controller plus Core/Protocol contract and shared reducer.
3. Wire Adapter/Worker/sessiond/Host and shared runtime contract tests; update build-contract generations.
4. Add Client side-command lifecycle, right-pane selector, SideChatPanel, built-in setting, translations and deterministic lifecycle/UI tests.
5. Root architecture/typecheck/tests/build, package boundaries/command coverage and relevant Startup/Runtime/Sessions E2E; independent adversarial verification; isolated browser proof and controlled production activation.

The Agent-detail repair remains separate: file-event-driven canonical revision triggers exact read-only child history invalidation, 0 child Worker activation, committed JSONL messages rather than unpersisted token deltas.
