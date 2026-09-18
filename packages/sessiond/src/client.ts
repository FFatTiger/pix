/**
 * @fffattiger/pix-sessiond/client
 *
 * Narrow client surface for host composition. Only re-exports the RPC client
 * and its options/subscription types — nothing from service/application/
 * daemon/testing internals. Host code MUST import the sessiond client from this
 * subpath so the host package boundary can keep the foundation (gate/types)
 * free of sessiond internals.
 */
export { SessiondRpcClient } from "./rpc.js";
export type { SessiondRpcClientOptions, SessiondRpcSubscription } from "./rpc.js";
