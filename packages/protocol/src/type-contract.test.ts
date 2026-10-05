import type {
  SessiondMethodParams,
  SessiondMethodResult,
  SessiondRpcRequest,
  SessiondRpcResponse,
  SessionsListParams,
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
  | Assert<Equal<import("./extension.js").ExtensionUiInputExchange["command"]["method"], "input" | "editor" | "custom">>
  | Assert<Equal<import("./extension.js").ExtensionUiInteractiveMethod, "select" | "confirm" | "input" | "editor" | "custom" | "questionnaire">>
  | Assert<Equal<Extract<import("./extension.js").ExtensionUiRequest, { method: "questionnaire" }> ["questions"][number]["multiSelect"], boolean>>
  | Assert<Equal<Extract<import("./extension.js").ExtensionUiResponseCommand, { responseKind: "questionnaire" }> ["answers"][number]["kind"], "option" | "multi" | "custom">>
  | Assert<Equal<
      Extract<
        import("./extension.js").ExtensionUiRequest,
        { method: "confirm" }
      >["closed"],
      true | undefined
    >>
  | Assert<Equal<SessionsListParams["parentSessionId"], string | undefined>>
  | Assert<Equal<
      Extract<import("./events.js").RuntimeEventData, { type: "built_ins_changed" }> ["type"],
      "built_ins_changed"
    >>
  | Assert<Equal<
      Extract<import("./events.js").RuntimeEventData, { type: "subagents_changed" }> ["type"],
      "subagents_changed"
    >>
  | Assert<Equal<
      Extract<import("./events.js").RuntimeEventData, { type: "todo_changed" }> ["type"],
      "todo_changed"
    >>
  | Assert<Equal<
      Extract<import("./events.js").RuntimeEventData, { type: "subagent_delta" }> ["type"],
      "subagent_delta"
    >>
  | Assert<Equal<
      NonNullable<import("./snapshot.js").RuntimeState["todo"]>["revision"],
      number
    >>
  | Assert<Equal<
      NonNullable<NonNullable<import("./snapshot.js").RuntimeState["subagents"]>["streams"]>,
      Record<string, { partial: import("./messages.js").StreamingAgentMessage; updatedAt: number }>
    >>;

export const protocolTypeAssertions: ProtocolTypeAssertions = true;
