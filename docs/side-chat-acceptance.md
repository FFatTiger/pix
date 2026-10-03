# Side chat acceptance

The implementation is validated in an isolated real SDK/Worker/sessiond/Host/Chrome stack. The production daemon and Host now serve the accepted build on local and public origins; the final live-session capability check is still being completed.

## Delivered behavior

- The shared right pane selects Files, Agents or Side chat. Side chat is also a bundled Agent feature in settings.
- The pinned `pi-side-chat@0.4.0` controller supplies the actual agent, captured main context, tool execution, `peek_main`, edit-overlap handling and cancellation. Provenance/license/removal conditions are in `packages/pi-sdk-adapter/src/internal/vendor/pi-side-chat/README.md`.
- Main and side turns can run concurrently; their abort targets are independent. No second Pix Worker or side messages in the parent JSONL.
- Browser refresh and pane close/reopen retain the side conversation in the same Worker. Reloading/stopping the runtime or disabling the feature clears this temporary conversation.
- Discussion mode disables the upstream built-in write tools; extensions retain their configured permissions. Edit-mode bash overlap detection remains heuristic.
- Running Agent details become available when the child identity is validated. Committed child JSONL messages refresh through file events and exact history-query invalidation, without child activation or polling.

## Checks

The final integrated sources passed root `check:architecture`, `typecheck`, `test`, `build`; Client and Adapter boundaries; Adapter command coverage; Startup, Runtime and Sessions E2E; and `git diff --check`.

The Runtime E2E now proves identical full-payload retries replay the accepted result, while same-ID changed content rejects `command_rejected`. Command type-conflict and interrupt dedup/type-conflict assertions remain. This updates the former same-ID/different-text cache-success expectation to the strict fingerprint contract.

Independent reviews passed after adversarial findings were corrected:

- Client operation/draft scopes, capability withdrawal and exact side-abort coalescing.
- Adapter engine system-message authority, abort timeout quarantine and explicit reset recovery.
- Sessiond complete-payload dedup, reload/side lifecycle exclusion, wire ID bounds and snapshot capability consistency.
- Agent artifact watch-plan races, reentrant listener ordering and filesystem-only post-background child identity/revision delivery.

## Real browser acceptance

Run the standalone test after building:

```sh
node tests/e2e/side-chat.mjs
```

The passing run exercised production process composition against an isolated loopback provider. It covered history-only zero-Worker browsing; capability gating; one parent Worker; concurrent main/side streaming; independent abort; pane reopen/browser reload restoration; refork and stale-identity rejection; parent JSONL isolation; switching to another historical parent; and desktop/mobile geometry.

Observed evidence:

- Four provider requests; context message counts `[9, 11, 13, 12]`.
- Served Client JS SHA-256 starts `4f26b9b11efa8e34`; served and disk bytes matched.
- Desktop capture 1440×813; mobile viewport 390×844 with document scroll width 390.
- Owned test processes and temporary state were cleaned up without errors.
- CDP helper tests passed 7/7; the only helper addition is explicit device-metric viewport emulation.

The source checkout includes pre-existing uncommitted changes. The browser test's printed Git HEAD is not a release commit for the complete working tree; the served asset hash identifies the tested Client artifact.

## Production cutover

The idle-gated cutover replaced sessiond with build contracts 7/6/6. Its initial Host invocation failed because the root dispatcher accepts `start` or `cli`, so Host-only startup must use `scripts/product-entry.mjs cli host`. Recovery also restored the original explicit Host environment, including `PIX_ALLOWED_HOSTS`, after the default host allowlist rejected the public origin. No product source change was needed for these deployment-script errors.

The recovered Host uses the existing production state directories and login configuration. Local `http://127.0.0.1:30145/v1/health` and public `https://m.huu.im:30145/v1/health` both return HTTP 200 with `sessiond: up`. Both origins serve the accepted JS (`4f26b9b11efa8e3470c351e3dd264f6358579660a8d41372f34916ce4df6af5f`) and CSS (`461a97381e110818405817462ea380bf619581f7d163f1601952bd8dc732be65`). Unauthenticated settings requests remain rejected by the login gate.
