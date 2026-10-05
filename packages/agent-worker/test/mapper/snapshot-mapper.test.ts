import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { MAX_RUNTIME_FRAME_BYTES, WorkerToSessiondPushSchema } from "@fffattiger/pix-protocol";
import { createCapabilitySet } from "@fffattiger/pix-runtime-core";
import { SnapshotMapper } from "../../src/mapper/snapshot-mapper.js";
import { StatefulRuntimeMapper } from "../../src/mapper/runtime-mapper.js";

describe("SnapshotMapper image capacity", () => {
  it("preserves a 2.1MB PNG-equivalent partial image under the runtime frame budget", () => {
    const data = Buffer.alloc(2_108_283, 0x41).toString("base64");
    const digest = createHash("sha256").update(data).digest("hex");
    const mapper = new SnapshotMapper(new StatefulRuntimeMapper());
    const snapshot = mapper.map(
      {
        sessionId: "sess-1",
        state: {
          sessionId: "sess-1",
          isStreaming: true,
          isPromptRunning: true,
          isBashRunning: false,
          isCompacting: false,
          model: null,
          messageCount: 1,
        },
        capabilities: createCapabilitySet([]),
        streaming: {
          active: true,
          phase: "running_tools",
          partialMessage: {
            role: "toolResult",
            toolCallId: "t1",
            content: [{ type: "image", source: { type: "base64", data, media_type: "image/png" } }],
          },
        },
      },
      { cwd: "/workspace", projectRoot: "/workspace" },
    );
    const partial = snapshot.streaming?.partialMessage;
    assert.ok(partial && "content" in partial && Array.isArray(partial.content));
    const image = partial.content[0];
    assert.ok(image && image.type === "image" && image.source.type === "base64");
    assert.equal(image.source.media_type, "image/png");
    assert.equal(image.source.data, data);
    assert.equal(createHash("sha256").update(image.source.data).digest("hex"), digest);
    const frame = JSON.stringify({
      type: "worker.snapshot",
      payload: { sessionId: snapshot.sessionId, snapshot },
    });
    assert.equal(WorkerToSessiondPushSchema.safeParse(JSON.parse(frame)).success, true);
    const bytes = Buffer.byteLength(frame, "utf8");
    assert.ok(bytes > 2 * 1024 * 1024);
    assert.ok(bytes <= MAX_RUNTIME_FRAME_BYTES);
  });
});
