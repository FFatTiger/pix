import type {
  SessiondMethodParams,
  SessiondMethodResult,
  SessiondRpcMethod,
} from "@fffattiger/pix-protocol";
import {
  PROTOCOL_VERSION,
  SessionContextSchema,
  type SessiondRuntimeAttachParams,
} from "@fffattiger/pix-protocol";
import { SessiondError } from "./errors.js";
import type { SessiondRpcContext, SessiondRpcHandler } from "./rpc.js";
import { SessiondService } from "./service.js";

export interface SessiondApplicationOptions {
  /** Optional control-plane shutdown. Invoked by `system.shutdown` after auth. */
  onShutdown?: () => void | Promise<void>;
  instanceId?: string;
}

export class SessiondApplication implements SessiondRpcHandler {
  constructor(
    private readonly service: SessiondService,
    private readonly options: SessiondApplicationOptions = {},
  ) {}

  afterResponse(method: import("@fffattiger/pix-protocol").SessiondRpcMethod): void {
    if (method !== "system.shutdown" || !this.options.onShutdown) return;
    setImmediate(() => {
      void Promise.resolve(this.options.onShutdown!()).catch(() => {});
    });
  }

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
      case "system.shutdown": {
        const input = params as SessiondMethodParams["system.shutdown"];
        if (!this.options.instanceId || input.instanceId !== this.options.instanceId) {
          throw new SessiondError("conflict", "sessiond instanceId does not match");
        }
        if (!this.options.onShutdown) {
          throw new SessiondError("unavailable", "sessiond shutdown control is unavailable");
        }
        return { accepted: true as const, instanceId: this.options.instanceId };
      }
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
        const catalog = this.service.sessionCatalog();
        if (!catalog) throw new SessiondError("unavailable", "session catalog is unavailable");
        const input = params as SessiondMethodParams["sessions.list"];
        const sessions = await catalog.listSessions({ ...(input.cwd === undefined ? {} : { cwd: input.cwd }), ...(input.limit === undefined ? {} : { limit: input.limit }), ...(input.offset === undefined ? {} : { offset: input.offset }) });
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
        const catalog = this.service.sessionCatalog();
        if (!catalog) throw new SessiondError("unavailable", "session catalog is unavailable");
        return { ...await catalog.readSession((params as SessiondMethodParams["sessions.read"]).sessionId) };
      }
      case "sessions.context": {
        const catalog = this.service.sessionCatalog();
        if (!catalog) throw new SessiondError("unavailable", "session catalog is unavailable");
        const input = params as SessiondMethodParams["sessions.context"];
        const context = await catalog.readSessionContext(input.sessionId, input.leafId === undefined ? undefined : { leafId: input.leafId });
        return SessionContextSchema.parse(context);
      }
      case "sessions.rename": {
        const input = params as SessiondMethodParams["sessions.rename"];
        await this.service.renameSession(input.sessionId, input.name);
        return { sessionId: input.sessionId, name: input.name };
      }
      case "sessions.delete": {
        const input = params as SessiondMethodParams["sessions.delete"];
        await this.service.deleteSession(input.sessionId);
        return { sessionId: input.sessionId, deleted: true };
      }
    }
  }
}
