import type {
  SessiondMethodParams,
  SessiondMethodResult,
  SessiondRpcRequest,
  SessiondRpcResponse,
} from "./sessiond.js";
import type { RuntimeCommandOutcome, RuntimeInterruptResult } from "./results.js";
import type { WsClientMessage, WsHostMessage } from "./ws.js";

/** Compile-time assertions for method/payload/result discrimination. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;

type CreateRequest = Extract<SessiondRpcRequest, { method: "runtime.create" }>;
type AttachRequest = Extract<SessiondRpcRequest, { method: "runtime.attach" }>;
type CreateSuccess = Extract<SessiondRpcResponse, { ok: true; method: "runtime.create" }>;
type CommandSuccess = Extract<SessiondRpcResponse, { ok: true; method: "runtime.command" }>;
type AttachFailure = Extract<SessiondRpcResponse, { ok: false; method: "runtime.attach" }>;
type WsCreate = Extract<WsClientMessage, { type: "create" }>;
type WsAttach = Extract<WsClientMessage, { type: "attach" }>;
type WsInterrupt = Extract<WsClientMessage, { type: "interrupt" }>;
type WsInterruptResult = Extract<WsHostMessage, { type: "interrupt_result" }>;

export type ProtocolTypeAssertions =
  | Assert<Equal<CreateRequest["params"], SessiondMethodParams["runtime.create"]>>
  | Assert<Equal<AttachRequest["params"], SessiondMethodParams["runtime.attach"]>>
  | Assert<Equal<CreateSuccess["result"], SessiondMethodResult["runtime.create"]>>
  | Assert<Equal<CommandSuccess["result"], SessiondMethodResult["runtime.command"]>>
  | Assert<Equal<AttachFailure["method"], "runtime.attach">>
  | Assert<Equal<Extract<RuntimeCommandOutcome, { ok: true; type: "fork" }>["forkedSessionId"], string>>
  | Assert<Equal<Extract<RuntimeInterruptResult, { ok: false }>["error"]["retryable"], boolean>>
  | Assert<Equal<WsCreate["payload"]["createRequestId"], string>>
  | Assert<Equal<Extract<WsAttach["payload"], { epoch: string }>["lastEventId"], number>>
  | Assert<Equal<WsInterrupt["payload"]["commandId"], string>>
  | Assert<Equal<WsInterruptResult["payload"]["interruptType"], RuntimeInterruptResult["type"]>>
  | Assert<Equal<import("./extension.js").ExtensionUiResponseExchange["command"]["type"], "extension_ui_response">>
  | Assert<Equal<import("./extension.js").ExtensionUiInputExchange["command"]["method"], "input" | "editor">>;

export const protocolTypeAssertions: ProtocolTypeAssertions = true;
