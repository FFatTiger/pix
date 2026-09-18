/**
 * Controlled localhost OpenAI-compatible provider (LC-00 layer 2 test helper).
 *
 * Serves exactly the surface the Pi SDK's `openai-completions` api uses:
 * POST /v1/chat/completions with SSE streaming responses. Plans let a test
 * pause/release chunk delivery, return fixed HTTP/context errors, or break the
 * stream mid-flight — so real-SDK lifecycle tests can drive bounded failure
 * scenarios without any remote inference.
 *
 * Privacy contract (lifecycle-reassessment §5): the recorder NEVER keeps
 * prompt/history content. Per request it records only counts, sizes, timestamps,
 * model id, and a boolean + sha256 match against the EXACT supplied prompt.
 */

import { createHash } from "node:crypto";
import { createServer } from "node:http";

/**
 * One scripted assistant reply, chunk by chunk.
 * @typedef {{ chunks?: string[], chunkDelayMs?: number, gateAfterChunks?: number,
 *             httpError?: { status: number, body: string },
 *             contextError?: { message: string, type?: string, code?: string },
 *             breakAfterChunks?: number, model?: string, matchPromptHash?: string }} ProviderScript
 */

/**
 * @typedef {{ index: number, receivedAt: number, requestBytes: number, messageCount: number,
 *             model: unknown, exactPrompt: boolean, promptHash: string, roles: string[],
 *             userCount: number, assistantCount: number, toolCount: number, systemCount: number,
 *             otherCount: number, userHashes: string[], hasCompactionSummary: boolean,
 *             parseError: boolean }} ProviderRequestRecord
 */

/**
 * @typedef {{ port: number, reset(): void, plan(...scripts: ProviderScript[]): void, release(): void,
 *             readonly gated: boolean, readonly requests: readonly ProviderRequestRecord[],
 *             report(): Record<string, unknown>, close(): Promise<void> }} ControlledProvider
 */

const DEFAULT_CHUNKS = ["Hello ", "from ", "the ", "stub ", "provider."];
const DEFAULT_MODEL = "stub-model";
const COMPACTION_SUMMARY_MARKER = "The conversation history before this point was compacted into the following summary:";

function sseChunk(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((block) => (typeof block?.text === "string" ? block.text : "")).join("");
  }
  return "";
}

function hashText(text) {
  return createHash("sha256").update(text).digest("hex");
}

function emptyRecord(index, requestBytes, extra = {}) {
  return {
    index,
    receivedAt: Date.now(),
    requestBytes,
    messageCount: 0,
    model: null,
    exactPrompt: false,
    promptHash: hashText(""),
    roles: [],
    userCount: 0,
    assistantCount: 0,
    toolCount: 0,
    systemCount: 0,
    otherCount: 0,
    userHashes: [],
    hasCompactionSummary: false,
    parseError: false,
    ...extra,
  };
}

function selectScript(scripts, record) {
  const hashed = scripts.find((candidate) => candidate?.matchPromptHash === record.promptHash);
  if (hashed) return hashed;
  const generic = scripts.filter((candidate) => candidate?.matchPromptHash === undefined);
  if (generic.length === 0) return {};
  return generic[Math.min(generic.length - 1, record.index)] ?? {};
}

export async function startControlledProvider() {
  const scripts = [];
  const requests = [];
  const sockets = new Set();
  let requestIndex = 0;
  let gate = null;

  const server = createServer((req, res) => {
    if (req.method !== "POST" || !req.url.startsWith("/v1/chat/completions")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `unexpected ${req.method} ${req.url}` } }));
      return;
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("error", () => {
      /* client-side abort; recorded below only if body arrived */
    });
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      let parsed;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        const record = emptyRecord(requestIndex++, body.length, { parseError: true });
        requests.push(record);
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "malformed json", type: "invalid_request_error" } }));
        return;
      }
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      const roles = messages.map((m) => (typeof m?.role === "string" ? m.role : "?"));
      let lastUserText = "";
      const userTexts = [];
      let hasCompactionSummary = false;
      for (const message of messages) {
        const text = messageText(message?.content);
        if (message?.role === "user") {
          userTexts.push(text);
          lastUserText = text;
          if (text.includes(COMPACTION_SUMMARY_MARKER)) hasCompactionSummary = true;
        }
      }
      const record = {
        index: requestIndex++,
        receivedAt: Date.now(),
        requestBytes: body.length,
        messageCount: messages.length,
        model: typeof parsed.model === "string" ? parsed.model : null,
        exactPrompt: false,
        promptHash: hashText(lastUserText),
        roles,
        userCount: roles.filter((role) => role === "user").length,
        assistantCount: roles.filter((role) => role === "assistant").length,
        toolCount: roles.filter((role) => role === "tool").length,
        systemCount: roles.filter((role) => role === "system" || role === "developer").length,
        otherCount: roles.filter((role) => !["user", "assistant", "tool", "system", "developer"].includes(role)).length,
        userHashes: userTexts.map((text) => hashText(text)),
        hasCompactionSummary,
        parseError: false,
      };
      requests.push(record);
      const script = selectScript(scripts, record);
      const model = script.model ?? DEFAULT_MODEL;
      const textChunks = script.chunks ?? DEFAULT_CHUNKS;

      if (script.httpError) {
        res.writeHead(script.httpError.status, { "content-type": "application/json" });
        res.end(script.httpError.body);
        return;
      }
      if (script.contextError) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: script.contextError.message,
              type: script.contextError.type ?? "invalid_request_error",
              code: script.contextError.code ?? "context_length_exceeded",
            },
          }),
        );
        return;
      }

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(
        sseChunk({
          id: `chatcmpl-stub-${record.index}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
        }),
      );
      void (async () => {
        try {
          for (let i = 0; i < textChunks.length; i += 1) {
            if (script.gateAfterChunks !== undefined && i === script.gateAfterChunks) {
              await new Promise((resolveHold) => {
                gate = { resolve: resolveHold, released: false };
              });
              gate = null;
            }
            if (script.breakAfterChunks !== undefined && i === script.breakAfterChunks) {
              res.destroy();
              return;
            }
            res.write(
              sseChunk({
                id: `chatcmpl-stub-${record.index}`,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{ index: 0, delta: { content: textChunks[i] }, finish_reason: null }],
              }),
            );
            await new Promise((r) => setTimeout(r, script.chunkDelayMs ?? 5));
          }
          res.write(
            sseChunk({
              id: `chatcmpl-stub-${record.index}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            }),
          );
          res.write("data: [DONE]\n\n");
          res.end();
        } catch {
          // socket aborted mid-stream is a scripted scenario, not a harness error
          try {
            res.destroy();
          } catch {
            /* already gone */
          }
        }
      })();
    });
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address !== "object") throw new Error("provider failed to bind");
  const port = address.port;

  return {
    port,
    reset() {
      scripts.length = 0;
      requests.length = 0;
      requestIndex = 0;
      if (gate && !gate.released) {
        gate.released = true;
        gate.resolve();
        gate = null;
      }
    },
    plan(...next) {
      scripts.push(...next);
    },
    release() {
      if (gate && !gate.released) {
        gate.released = true;
        gate.resolve();
        gate = null;
      }
    },
    get gated() {
      return gate !== null;
    },
    get requests() {
      return requests;
    },
    report() {
      return {
        port,
        requestCount: requests.length,
        perRequest: requests.map((r) => ({
          index: r.index,
          bytes: r.requestBytes,
          messages: r.messageCount,
          userCount: r.userCount,
          assistantCount: r.assistantCount,
          toolCount: r.toolCount,
          systemCount: r.systemCount,
          otherCount: r.otherCount,
          roles: r.roles.join(","),
          model: r.model,
          exactPrompt: r.exactPrompt,
          hasCompactionSummary: r.hasCompactionSummary,
          parseError: r.parseError,
          promptHash: `${r.promptHash.slice(0, 12)}…`,
        })),
        gated: gate !== null,
      };
    },
    close() {
      this.release();
      for (const socket of sockets) {
        try { socket.destroy(); } catch { /* ignore */ }
      }
      sockets.clear();
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          try { server.close(); } catch { /* ignore */ }
          resolve();
        }, 2_000);
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

/**
 * Mark the exact expected prompt so `exactPrompt` becomes meaningful: call
 * before asserting. Kept separate from the recorder so the server never holds
 * content longer than the comparison itself.
 */
export function markExactPrompt(provider, prompt) {
  const hash = createHash("sha256").update(prompt).digest("hex");
  for (const record of provider.requests) {
    if (record.promptHash === hash) record.exactPrompt = true;
  }
}

/** SHA-256 of a user-message string, for asserting history markers without storing content. */
export function hashPrompt(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function requestHasUserHash(record, text) {
  const hash = hashPrompt(text);
  return record.userHashes.includes(hash);
}
