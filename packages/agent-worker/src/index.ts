/**
 * @fffattiger/pix-agent-worker
 *
 * Single-session agent worker: Protocol ↔ Runtime Core stateful mapper, worker
 * application controller, and NDJSON stdio transport. The executable
 * composition root lives at `@fffattiger/pix-agent-worker/worker-main`.
 *
 * Dependency boundary: production code imports only
 * `@fffattiger/pix-runtime-core`, `@fffattiger/pix-protocol` and the project
 * adapter `@fffattiger/pix-pi-sdk-adapter` — never the Pi SDK directly.
 */
export * from "./mapper/ids.js";
export * from "./mapper/protocol-error.js";
export * from "./mapper/core-to-protocol.js";
export * from "./mapper/message-diff.js";
export * from "./mapper/command-mapper.js";
export * from "./mapper/runtime-mapper.js";
export * from "./mapper/snapshot-mapper.js";
export * from "./controller/worker-controller.js";
export * from "./transport/serial-stdout-writer.js";
export * from "./transport/ndjson-transport.js";
