import type {
  RuntimeCommand,
  RuntimeInterrupt,
  RuntimeInterruptResult,
  RuntimeSnapshot,
  RuntimeCommandResult,
  SessiondToWorkerMessage,
  WorkerToSessiondMessage,
} from "@fffattiger/pix-protocol";
import type { ProtocolError } from "@fffattiger/pix-protocol";
import type { SessionLocation } from "@fffattiger/pix-runtime-core";

export interface WorkerStartInput {
  activationId: string;
  sessionId: string;
  cwd: string;
  projectRoot: string;
  sessionFile?: string;
  create?: {
    model?: { provider: string; modelId: string };
    thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
    thinkingLevelPinned?: boolean;
    toolNames?: readonly string[];
    name?: string;
  };
}

export interface WorkerConnection {
  readonly pid?: number;
  send(message: SessiondToWorkerMessage): Promise<void>;
  subscribe(listener: (message: WorkerToSessiondMessage) => void): () => void;
  onExit(listener: (exit: WorkerExit) => void): () => void;
  close(): Promise<void>;
}

export interface WorkerExit {
  code?: number;
  signal?: string;
  error?: ProtocolError;
}

export interface WorkerProcessFactory {
  start(input: WorkerStartInput): Promise<WorkerConnection>;
}

export interface SessionResolver {
  locate(sessionId: string): Promise<SessionLocation>;
  resolveCreate(input: { createRequestId: string; cwd: string; projectRoot: string }): Promise<{ provisionalSessionId: string; sessionFile?: string }>;
}

export interface WorkerCommandApi {
  command(sessionId: string, command: RuntimeCommand): Promise<RuntimeCommandResult>;
  interrupt(sessionId: string, interrupt: RuntimeInterrupt): Promise<RuntimeInterruptResult>;
  snapshot(sessionId: string): Promise<RuntimeSnapshot>;
}
