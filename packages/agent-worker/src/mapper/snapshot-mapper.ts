/**
 * Snapshot mapper — Core RuntimeSnapshot → Protocol RuntimeSnapshot.
 *
 * The Core snapshot lacks `cwd`/`projectRoot` (those are worker-context
 * fields); the mapper injects the values saved from `worker.init`. Streaming
 * ids (`streamId`/`messageId`) are also Core-absent and are coordinated with
 * the live {@link StatefulRuntimeMapper}: an active message-stream partial
 * reuses the mapper's ids, or mints fresh ids and seeds the mapper baseline
 * when the snapshot is the first to observe the partial. Inactive snapshots
 * clear any stale mapper stream.
 *
 * No epoch / lastEventId / eventId is ever produced — those are sessiond-owned.
 */
import type { RuntimeSnapshot as ProtocolRuntimeSnapshot } from "@fffattiger/pix-protocol";
import type {
  RuntimeSnapshot,
  StreamingPhase,
  StreamingAgentMessage,
} from "@fffattiger/pix-runtime-core";
import type { StatefulRuntimeMapper } from "./runtime-mapper.js";
import {
  mapCapabilitySet,
  mapRuntimeState,
  mapStreamingMessage,
} from "./core-to-protocol.js";

export interface SnapshotContext {
  readonly cwd: string;
  readonly projectRoot: string;
}

type MessagePhase = "streaming" | "waiting_model" | "running_tools" | "retrying";

function messagePhase(phase: StreamingPhase | undefined): MessagePhase {
  if (phase === "waiting_model" || phase === "running_tools" || phase === "retrying") return phase;
  return "streaming";
}

export class SnapshotMapper {
  constructor(private readonly runtimeMapper: StatefulRuntimeMapper) {}

  map(snapshot: RuntimeSnapshot, ctx: SnapshotContext): ProtocolRuntimeSnapshot {
    const { state } = snapshot;
    const coreStreaming = snapshot.streaming;
    const activeStream = this.runtimeMapper.getActiveStream();
    // Prefer the snapshot partial; fall back to the mapper's live baseline.
    const partial: StreamingAgentMessage | undefined =
      coreStreaming?.partialMessage ?? activeStream?.baseline;

    let streaming: ProtocolRuntimeSnapshot["streaming"];
    if (state.isStreaming) {
      if (partial !== undefined) {
        const ids =
          activeStream !== null
            ? { streamId: activeStream.streamId, messageId: activeStream.messageId }
            : this.runtimeMapper.activateFromPartial(partial);
        streaming = {
          active: true,
          streamId: ids.streamId,
          messageId: ids.messageId,
          partialMessage: mapStreamingMessage(partial),
          phase: messagePhase(coreStreaming?.phase),
          ...(coreStreaming?.toolCallIds === undefined ? {} : { toolCallIds: [...coreStreaming.toolCallIds] }),
        };
      } else {
        // Inconsistent core state (streaming flag without a partial). Emit a
        // best-effort projection; the transport schema gate fails closed.
        streaming = { active: true, phase: "streaming" };
      }
    } else if (state.isBashRunning || state.isCompacting) {
      this.runtimeMapper.clearActiveStream();
      streaming = {
        active: true,
        phase: state.isBashRunning ? "bash" : "compacting",
      };
    } else {
      this.runtimeMapper.clearActiveStream();
      streaming = { active: false, phase: "idle" };
    }

    return {
      sessionId: snapshot.sessionId,
      cwd: ctx.cwd,
      projectRoot: ctx.projectRoot,
      state: mapRuntimeState(state),
      capabilities: mapCapabilitySet(snapshot.capabilities),
      ...(streaming === undefined ? {} : { streaming }),
      // Protocol v2: the snapshot is control/reconnect state only — it never
      // carries completed transcript history. Persisted history comes from the
      // cursor-paginated session context endpoint.
    };
  }
}
