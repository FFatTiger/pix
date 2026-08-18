import { Duplex } from "node:stream";
import { LocalAuthorityError } from "./contracts.js";
import { loadNativeWindowsBinding, type NativeWindowsBinding } from "./native-windows.js";

/**
 * Node cannot wrap a Windows named-pipe HANDLE as `net.Socket({ fd })`
 * (`ERR_INVALID_FD_TYPE`). This duplex talks to the native handle instead.
 */
export class WindowsNamedPipeDuplex extends Duplex {
  private ended = false;
  private reading = false;

  constructor(
    private readonly handle: bigint,
    private readonly binding: NativeWindowsBinding,
  ) {
    super({ decodeStrings: true });
  }

  override _read(): void {
    if (this.reading || this.ended) return;
    this.reading = true;
    void this.pump();
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this.ended) {
      callback(new LocalAuthorityError("UNSAFE_COMPONENT", "named pipe is closed"));
      return;
    }
    void this.binding.writeNamedPipeHandle(this.handle, chunk).then(
      () => callback(),
      (error: unknown) => callback(mapPipeIoError(error, "write")),
    );
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.ended = true;
    try {
      this.binding.closeNamedPipeHandle(this.handle);
    } catch {
      // Best-effort close of a connection the peer may already have dropped.
    }
    callback(error);
  }

  private async pump(): Promise<void> {
    try {
      while (!this.ended) {
        const chunk = await this.binding.readNamedPipeHandle(this.handle, 65536);
        if (this.ended) return;
        if (chunk.length === 0) {
          this.push(null);
          return;
        }
        if (!this.push(chunk)) return;
      }
    } catch (error) {
      if (!this.ended) this.destroy(mapPipeIoError(error, "read"));
    } finally {
      this.reading = false;
    }
  }
}

function mapPipeIoError(error: unknown, op: "read" | "write"): Error {
  const code = (error as { code?: string }).code;
  if (code === "NATIVE_PIPE_CLOSED") {
    return new LocalAuthorityError("UNSAFE_COMPONENT", `named pipe ${op} closed`);
  }
  if (error instanceof Error) return error;
  return new LocalAuthorityError("UNSAFE_COMPONENT", `named pipe ${op} failed`);
}

export function createWindowsNamedPipeDuplex(handle: bigint): WindowsNamedPipeDuplex {
  if (typeof handle !== "bigint" || handle <= 0n) {
    throw new LocalAuthorityError("INVALID_PATH", "named pipe handle is invalid");
  }
  return new WindowsNamedPipeDuplex(handle, loadNativeWindowsBinding());
}
