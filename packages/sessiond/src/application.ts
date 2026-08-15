import type {
  SessiondMethodParams,
  SessiondMethodResult,
  SessiondRpcMethod,
} from "@fffattiger/pix-protocol";
import {
  PROTOCOL_VERSION,
  SessionContextSchema,
  SessionTreeSchema,
  type SessiondRuntimeAttachParams,
} from "@fffattiger/pix-protocol";
import { SessiondError } from "./errors.js";
import type { SessiondRpcContext, SessiondRpcHandler } from "./rpc.js";
import { SessiondService } from "./service.js";

export class SessiondApplication implements SessiondRpcHandler {
  constructor(private readonly service: SessiondService) {}

  attach(params: SessiondRuntimeAttachParams): import("./service.js").PreparedAttachment {
    return this.service.prepareAttach(params);
  }

  async handle<M extends SessiondRpcMethod>(method: M, params: SessiondMethodParams[M], context?: SessiondRpcContext): Promise<SessiondMethodResult[M]> {
    return this.dispatch(method, params, context) as Promise<SessiondMethodResult[M]>;
  }

  private async dispatch(method: SessiondRpcMethod, params: SessiondMethodParams[SessiondRpcMethod], context?: SessiondRpcContext): Promise<SessiondMethodResult[SessiondRpcMethod]> {
    switch (method) {
      case "system.ping": return { pong: true, serverTime: Date.now() };
      case "system.hello": return { protocolVersion: PROTOCOL_VERSION, capabilities: ["runtime.authority", "runtime.resume"] };
      case "system.shutdown":
        // Intercepted by the RPC server (daemon-owned shutdown authority) and
        // never dispatched here. Fail closed if it somehow reaches the app.
        throw new SessiondError("internal", "system.shutdown must be handled by the daemon authority");
      case "runtime.create": return this.service.create(params as SessiondMethodParams["runtime.create"]);
      case "runtime.activate": {
        const input = params as SessiondMethodParams["runtime.activate"];
        return this.service.activate(input.sessionId, input.cwd);
      }
      case "runtime.attach": return this.service.attach(params as SessiondMethodParams["runtime.attach"]).result;
      case "runtime.detach": {
        const input = params as SessiondMethodParams["runtime.detach"];
        this.service.detach(input.sessionId);
        return { sessionId: input.sessionId, detached: true };
      }
      case "runtime.getSnapshot": {
        const input = params as SessiondMethodParams["runtime.getSnapshot"];
        return this.service.getSnapshot(input.sessionId);
      }
      case "runtime.listRunning": return this.service.listRunning();
      case "runtime.command": {
        const input = params as SessiondMethodParams["runtime.command"];
        return this.service.command(input.sessionId, input.command);
      }
      case "runtime.interrupt": {
        const input = params as SessiondMethodParams["runtime.interrupt"];
        return this.service.interrupt(input.sessionId, input.commandId, input.interrupt);
      }
      case "runtime.stop": {
        const input = params as SessiondMethodParams["runtime.stop"];
        return { sessionId: input.sessionId, stopped: await this.service.stop(input.sessionId, input.reason) };
      }
      case "runtime.hasBusyCwd": {
        const input = params as SessiondMethodParams["runtime.hasBusyCwd"];
        return this.service.hasBusyCwd(input.cwd);
      }
      case "runtime.stopByCwd": {
        const input = params as SessiondMethodParams["runtime.stopByCwd"];
        return { cwd: input.cwd, stoppedSessionIds: await this.service.stopByCwd(input.cwd, input.reason) };
      }
      case "sessions.list": {
        const input = params as SessiondMethodParams["sessions.list"];
        // Service wrapper applies the service-owned revisioned title overlay so
        // reads beginning after a confirmed rename observe the new title.
        const sessions = await this.service.listSessions({ ...(input.cwd === undefined ? {} : { cwd: input.cwd }), ...(input.limit === undefined ? {} : { limit: input.limit }), ...(input.offset === undefined ? {} : { offset: input.offset }) });
        return { sessions: sessions.map((item) => ({ ...item })) };
      }
      case "sessions.resolve": {
        const input = params as SessiondMethodParams["sessions.resolve"];
        if (!input.sessionId) throw new SessiondError("invalid_input", "sessionId is required for activation resolution");
        const location = await this.service.locate(input.sessionId);
        const context = await this.service.activationContext(input.sessionId, location, input.cwd);
        return { sessionId: input.sessionId, sessionFile: location.sessionFile, cwd: context.cwd, projectRoot: context.projectRoot };
      }
      case "sessions.read": {
        const input = params as SessiondMethodParams["sessions.read"];
        // Service wrapper applies the service-owned revisioned title overlay.
        return { ...await this.service.readSession(input.sessionId) };
      }
      case "sessions.context": {
        const catalog = this.service.sessionCatalog();
        if (!catalog) throw new SessiondError("unavailable", "session catalog is unavailable");
        const input = params as SessiondMethodParams["sessions.context"];
        const context = await catalog.readSessionContext(input.sessionId, input.leafId === undefined ? undefined : { leafId: input.leafId });
        return SessionContextSchema.parse(context);
      }
      case "sessions.tree": {
        // Read-only normalized branch tree over the SAME persisted-JSONL
        // catalog (zero workers, no runtime activation). Strict-parsed so the
        // RPC boundary only ever releases schema-valid trees.
        const catalog = this.service.sessionCatalog();
        if (!catalog) throw new SessiondError("unavailable", "session catalog is unavailable");
        const input = params as SessiondMethodParams["sessions.tree"];
        const tree = await catalog.readSessionTree(input.sessionId);
        return SessionTreeSchema.parse(tree);
      }
      case "sessions.rename": {
        const input = params as SessiondMethodParams["sessions.rename"];
        // The service canonicalizes the name once (trim / length / controls) and
        // the RPC returns the canonical name, never the raw user string.
        return this.service.renameSession(input.sessionId, input.name);
      }
      case "sessions.delete": {
        const input = params as SessiondMethodParams["sessions.delete"];
        await this.service.deleteSession(input.sessionId);
        return { sessionId: input.sessionId, deleted: true };
      }
    }
  }
}
