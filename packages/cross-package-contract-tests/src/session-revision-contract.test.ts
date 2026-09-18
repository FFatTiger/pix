/**
 * Phase 5A session-revision vocabulary ownership — cross-package contract.
 *
 * `SessionRevision` is a WIRE-ONLY vocabulary (AGENTS.md §7: wire-only
 * vocabularies live in Protocol). It pairs the two wire cursor fields every
 * Protocol event/snapshot already carries (epoch + eventId) into one strict,
 * comparable fence and is deliberately NOT mirrored into runtime-core:
 * runtime-core events intentionally carry "session identity plus product
 * semantics only" (no epochs / resume cursors — that is the Protocol layer's
 * job). This test pins that ownership boundary so a future "helpful" mirror
 * fails a contract instead of forking the revision semantics.
 *
 * It also pins the DISJOINT domains that are easy to confuse:
 *  - `TurnStatus.revision` is a per-turn status sequence (nonnegative, from 0);
 *  - `SessionRevision.eventId` is a journal event id (positive);
 *  - the two never validate as each other and never interconvert.
 *
 * Finally it pins the Phase 5A `session_changed` BRIDGE parity: the canonical
 * runtime-core event (cwd + optional leafId, product semantics only) projects
 * field-for-field onto the existing Protocol `SessionChangedEventData` frame.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as protocol from "@fffattiger/pix-protocol";
import * as runtimeCore from "@fffattiger/pix-runtime-core";

test("SessionRevision is a Protocol-owned wire-only vocabulary (no runtime-core mirror)", () => {
  // The comparable fence + comparability helpers live in Protocol and nowhere else.
  assert.equal(typeof protocol.SessionRevisionSchema, "object");
  assert.equal(typeof protocol.compareSessionRevisions, "function");
  assert.equal(typeof protocol.isSameSessionRevision, "function");
  assert.equal(typeof protocol.isNextSessionRevision, "function");
  // No runtime-core mirror may ever fork the revision semantics.
  for (const forbidden of [
    "SessionRevision",
    "SessionRevisionSchema",
    "compareSessionRevisions",
    "isSameSessionRevision",
    "isNextSessionRevision",
  ]) {
    assert.equal(
      (runtimeCore as Record<string, unknown>)[forbidden],
      undefined,
      `runtime-core must not mirror the Protocol session-revision vocabulary (${forbidden})`,
    );
  }
});

test("session revision and turn status revision stay disjoint domains", () => {
  const revision = protocol.SessionRevisionSchema.parse({ epoch: "e1", eventId: 1 });
  const status = protocol.TurnStatusSchema.parse({
    sessionId: "s1",
    epoch: "e1",
    operationId: "op-1",
    turnId: "turn-1",
    revision: 0,
    state: "admitted",
  });
  // Turn status revision 0 is a legal STATUS sequence and an illegal journal id.
  assert.equal(status.revision, 0);
  assert.equal(protocol.SessionRevisionSchema.safeParse({ epoch: status.epoch, eventId: status.revision }).success, false);
  // A session revision is not a turn status payload.
  assert.equal(protocol.TurnStatusSchema.safeParse(revision).success, false);
});

test("comparability is same-epoch only, never cross-epoch (frozen projection)", () => {
  assert.equal(protocol.compareSessionRevisions({ epoch: "e1", eventId: 1 }, { epoch: "e1", eventId: 2 }), "before");
  assert.equal(protocol.compareSessionRevisions({ epoch: "e1", eventId: 2 }, { epoch: "e1", eventId: 1 }), "after");
  assert.equal(protocol.compareSessionRevisions({ epoch: "e1", eventId: 2 }, { epoch: "e1", eventId: 2 }), "equal");
  assert.equal(protocol.compareSessionRevisions({ epoch: "e1", eventId: 1 }, { epoch: "e2", eventId: 1 }), "incomparable");
  assert.equal(protocol.isNextSessionRevision({ epoch: "e1", eventId: 1 }, { epoch: "e1", eventId: 2 }), true);
  assert.equal(protocol.isNextSessionRevision({ epoch: "e1", eventId: 1 }, { epoch: "e1", eventId: 3 }), false);
  assert.equal(protocol.isNextSessionRevision({ epoch: "e1", eventId: 1 }, { epoch: "e2", eventId: 2 }), false);
});

test("Phase 5A session_changed bridge: runtime-core event ↔ Protocol frame parity (cwd + leafId only)", () => {
  // The canonical runtime-core event (product semantics only — no cursor).
  const coreEvent: import("@fffattiger/pix-runtime-core").SessionChangedEvent = {
    type: "session_changed",
    sessionId: "s1",
    cwd: "/workspace",
    leafId: "entry-2",
  };
  // Projects field-for-field onto the EXISTING Protocol wire frame (the worker
  // mapper owns the translation); sessiond stamps epoch/eventId downstream.
  const parsed = protocol.SessionChangedEventDataSchema.safeParse({ ...coreEvent });
  assert.equal(parsed.success, true, parsed.success ? "" : String(parsed.error));
  // The wire frame is strict: a blank cwd or an unknown extra field fails closed.
  assert.equal(protocol.SessionChangedEventDataSchema.safeParse({ ...coreEvent, cwd: "" }).success, false);
  assert.equal(protocol.SessionChangedEventDataSchema.safeParse({ ...coreEvent, extra: 1 }).success, false);
  // leafId is optional on both sides (fresh session / backend exposes none).
  assert.equal(protocol.SessionChangedEventDataSchema.safeParse({ type: "session_changed", sessionId: "s1", cwd: "/w" }).success, true);
  // The core event is part of the canonical RuntimeEvent vocabulary every
  // adapter emits on the ordinary subscribe channel (Phase 5A contract).
  const asEvent: import("@fffattiger/pix-runtime-core").RuntimeEvent = coreEvent;
  assert.equal(asEvent.type, "session_changed");
});
