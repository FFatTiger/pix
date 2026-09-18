import { z, type ZodType } from "zod";
import { assertV1Path } from "./urls";

const DEFAULT_TIMEOUT_MS = 15_000;
const ErrorEnvelopeSchema = z.looseObject({
  message: z.string().optional(),
  error: z.string().optional(),
  code: z.string().optional(),
  retryAfterSeconds: z.number().optional(),
});

export type HttpFailureKind = "http" | "network" | "timeout" | "aborted" | "decode";

export class HttpError extends Error {
  readonly kind: HttpFailureKind;
  readonly status: number;
  readonly path: string;
  readonly code?: string;
  readonly body: unknown;
  readonly retryAfterSeconds?: number;

  constructor(input: {
    kind?: HttpFailureKind;
    status?: number;
    path: string;
    message: string;
    code?: string;
    body?: unknown;
    retryAfterSeconds?: number;
    cause?: unknown;
  });
  constructor(status: number, path: string, message: string, body?: unknown);
  constructor(
    inputOrStatus: {
      kind?: HttpFailureKind;
      status?: number;
      path: string;
      message: string;
      code?: string;
      body?: unknown;
      retryAfterSeconds?: number;
      cause?: unknown;
    } | number,
    legacyPath?: string,
    legacyMessage?: string,
    legacyBody?: unknown,
  ) {
    const input = typeof inputOrStatus === "number"
      ? { status: inputOrStatus, path: legacyPath ?? "", message: legacyMessage ?? `HTTP ${inputOrStatus}`, body: legacyBody }
      : inputOrStatus;
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "HttpError";
    this.kind = input.kind ?? "http";
    this.status = input.status ?? 0;
    this.path = input.path;
    this.body = input.body;
    if (input.code !== undefined) this.code = input.code;
    if (input.retryAfterSeconds !== undefined) this.retryAfterSeconds = input.retryAfterSeconds;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type ResponseMode = "json" | "text" | "blob" | "response";

export interface HttpClientOptions {
  onUnauthorized?: (path: string) => void | Promise<void>;
  credentials?: RequestCredentials;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface RequestOptions<T> {
  method?: HttpMethod;
  body?: unknown;
  rawBody?: BodyInit;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  skipAuthRedirect?: boolean;
  schema?: ZodType<T>;
  responseMode?: ResponseMode;
}

function composeSignal(signal: AbortSignal | undefined, timeoutMs: number) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

function parseErrorBody(body: unknown, fallback: string) {
  const parsed = ErrorEnvelopeSchema.safeParse(body);
  if (parsed.success) {
    const message = parsed.data.message?.trim() || parsed.data.error?.trim() || fallback;
    return {
      message,
      ...(parsed.data.code === undefined ? {} : { code: parsed.data.code }),
      ...(parsed.data.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: parsed.data.retryAfterSeconds }),
    };
  }
  if (typeof body === "string" && body.trim()) return { message: body.trim() };
  return { message: fallback };
}

async function readJsonResponse(response: Response, path: string): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new HttpError({
      kind: "decode",
      status: response.status,
      path,
      message: "Host returned malformed JSON",
      body: text,
      cause,
    });
  }
}

function parseWithSchema<T>(schema: ZodType<T>, value: unknown, path: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new HttpError({
    kind: "decode",
    status: 200,
    path,
    code: "INVALID_RESPONSE",
    message: "Host response did not match the expected schema",
    body: result.error.flatten(),
  });
}

export function createHttpClient(options: HttpClientOptions = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const credentials = options.credentials ?? "same-origin";
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let unauthorizedNotified = false;

  async function notifyUnauthorized(path: string): Promise<void> {
    if (!options.onUnauthorized || unauthorizedNotified) return;
    unauthorizedNotified = true;
    await options.onUnauthorized(path);
  }

  async function request<T>(path: string, req: RequestOptions<T> = {}): Promise<T> {
    assertV1Path(path);
    if (req.signal?.aborted) {
      throw new HttpError({ kind: "aborted", path, code: "ABORTED", message: "Request was aborted" });
    }
    if (req.body !== undefined && req.rawBody !== undefined) {
      throw new Error("Request cannot include both body and rawBody");
    }
    const headers: Record<string, string> = { ...req.headers };
    const mode = req.responseMode ?? "json";
    if (mode === "json" && headers.Accept === undefined) headers.Accept = "application/json";

    let body: BodyInit | undefined = req.rawBody;
    if (req.body !== undefined) {
      headers["Content-Type"] ??= "application/json";
      body = JSON.stringify(req.body);
    }

    const timeoutMs = req.timeoutMs ?? defaultTimeoutMs;
    const combinedSignal = composeSignal(req.signal, timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(path, {
        method: req.method ?? "GET",
        headers,
        credentials,
        ...(body === undefined ? {} : { body }),
        signal: combinedSignal,
      });
    } catch (cause) {
      const externallyAborted = req.signal?.aborted === true;
      const timeout = combinedSignal.aborted && !externallyAborted;
      throw new HttpError({
        kind: externallyAborted ? "aborted" : timeout ? "timeout" : "network",
        path,
        code: externallyAborted ? "ABORTED" : timeout ? "TIMEOUT" : "NETWORK_ERROR",
        message: externallyAborted
          ? "Request was aborted"
          : timeout
            ? "Request timed out"
            : "Unable to reach the host",
        cause,
      });
    }

    if (!response.ok) {
      let parsed: unknown;
      try {
        parsed = await readJsonResponse(response, path);
      } catch (error) {
        if (error instanceof HttpError && error.kind === "decode") {
          parsed = error.body;
        } else throw error;
      }
      if (response.status === 401 && !req.skipAuthRedirect) await notifyUnauthorized(path);
      const fallback = response.statusText || `HTTP ${response.status}`;
      const detail = parseErrorBody(parsed, fallback);
      throw new HttpError({
        status: response.status,
        path,
        body: parsed,
        message: detail.message,
        ...(detail.code === undefined ? {} : { code: detail.code }),
        ...(detail.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: detail.retryAfterSeconds }),
      });
    }

    unauthorizedNotified = false;
    if (mode === "response") return response as T;
    if (mode === "text") return (await response.text()) as T;
    if (mode === "blob") return (await response.blob()) as T;
    const parsed = await readJsonResponse(response, path);
    return req.schema === undefined ? (parsed as T) : parseWithSchema(req.schema, parsed, path);
  }

  return {
    request,
    get: <T>(path: string, req?: Omit<RequestOptions<T>, "method" | "body" | "rawBody">) =>
      request<T>(path, { ...req, method: "GET" }),
    post: <T>(path: string, body?: unknown, req?: Omit<RequestOptions<T>, "method" | "body" | "rawBody">) =>
      request<T>(path, { ...req, method: "POST", body }),
    put: <T>(path: string, body?: unknown, req?: Omit<RequestOptions<T>, "method" | "body" | "rawBody">) =>
      request<T>(path, { ...req, method: "PUT", body }),
    patch: <T>(path: string, body?: unknown, req?: Omit<RequestOptions<T>, "method" | "body" | "rawBody">) =>
      request<T>(path, { ...req, method: "PATCH", body }),
    delete: <T>(path: string, body?: unknown, req?: Omit<RequestOptions<T>, "method" | "body" | "rawBody">) =>
      request<T>(path, { ...req, method: "DELETE", body }),
    raw: <T>(path: string, rawBody: BodyInit, req: Omit<RequestOptions<T>, "body" | "rawBody">) =>
      request<T>(path, { ...req, rawBody }),
  };
}

export type HttpClient = ReturnType<typeof createHttpClient>;

export function buildLoginRedirect(nextPath?: string): string {
  const next = nextPath ?? (typeof window === "undefined" ? "/" : `${window.location.pathname}${window.location.search}`);
  const params = new URLSearchParams();
  if (next && next !== "/login" && !next.startsWith("/login?")) params.set("next", next);
  const query = params.toString();
  return query ? `/login?${query}` : "/login";
}

export function redirectToLogin(nextPath?: string): void {
  if (typeof window === "undefined" || window.location.pathname === "/login") return;
  window.location.assign(buildLoginRedirect(nextPath));
}
