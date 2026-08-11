/**
 * @fffattiger/pi-web-runtime-core
 *
 * Pi-web agent runtime ports, canonical models and structured errors.
 *
 * This package is the anti-corruption boundary between pi-web and Pi
 * backends. It has zero runtime dependencies: no Protocol, Zod, Pi SDK, Pi
 * RPC, React, Hono or Node process management. Backends (Pi SDK adapter,
 * future Pi RPC adapter) implement these ports; the rest of the system only
 * ever sees these canonical types.
 */

export * from "./capabilities.js";
export * from "./commands.js";
export * from "./errors.js";
export * from "./events.js";
export * from "./extension.js";
export * from "./identity.js";
export * from "./interrupt.js";
export * from "./messages.js";
export * from "./model.js";
export * from "./ports.js";
export * from "./queue.js";
export * from "./resources.js";
export * from "./result.js";
export * from "./session.js";
export * from "./side-chat.js";
export * from "./state.js";
export * from "./trust.js";
export * from "./auth.js";
