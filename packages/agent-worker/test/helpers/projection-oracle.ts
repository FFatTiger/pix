// Test-only reverse-oracle helpers: the REAL sessiond SnapshotProjection is the
// authority that consumes Protocol deltas. Mapper tests project deltas through
// it (avoiding a second, drifting projection implementation) and assert that
// the reconstructed streaming message is equivalent to the Core cumulative.
import { SnapshotProjection } from "@fffattiger/pix-sessiond";
import type { RuntimeSnapshot } from "@fffattiger/pix-protocol";
import type { StreamingAgentMessage } from "@fffattiger/pix-runtime-core";

export function createOracle(sessionId: string): SnapshotProjection {
  const base: RuntimeSnapshot = {
    sessionId,
    cwd: "/workspace",
    projectRoot: "/workspace",
    state: {
      sessionId,
      isStreaming: false,
      isPromptRunning: false,
      isBashRunning: false,
      isCompacting: false,
      model: null,
      messageCount: 0,
    },
    capabilities: { capabilities: [], version: 1 },
    streaming: { active: false, phase: "idle" },
  };
  return new SnapshotProjection(base);
}

/**
 * A structural view shared by both Core and Protocol streaming messages so the
 * oracle helpers accept either representation without a double implementation.
 */
export interface StreamLike {
  role: StreamingAgentMessage["role"];
  content?: unknown;
}

/** Textual projection of a streaming message (text/thinking concatenation). */
export function textOf(message: StreamLike): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const item = block as { type?: string; text?: string; thinking?: string };
      if (item.type === "text") return item.text ?? "";
      if (item.type === "thinking") return item.thinking ?? "";
      return "";
    })
    .join("");
}

/** toolCall sequences in order, for structural correlation checks. */
export function toolCallsOf(message: StreamLike): { toolCallId: string; toolName: string }[] {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
  return (message.content as { type?: string; toolCallId?: string; toolName?: string }[])
    .filter((block) => block.type === "toolCall")
    .map((block) => ({ toolCallId: block.toolCallId ?? "", toolName: block.toolName ?? "" }));
}

/** Image block count, for image-correlation checks. */
export function imageCount(message: StreamLike): number {
  if (!Array.isArray(message.content)) return 0;
  return (message.content as { type?: string }[]).filter((block) => block.type === "image").length;
}
