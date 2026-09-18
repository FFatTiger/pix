import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { createPosixSecureStateBackend, LocalAuthorityError } from "@fffattiger/pix-local-authority";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai";
import {
  makeRuntimeError,
  type AvailableModelProvider,
  type DiscoveredModelConfig,
  type EditableModelConfig,
  type EditableProviderConfig,
  type ModelConfigApi,
  type ModelConfigProviderMutation,
  type ModelConfigStorePort,
  type ModelDiscoveryInput,
  type ModelsConfigMutation,
  type ModelsConfigSnapshot,
} from "@fffattiger/pix-runtime-core";

const MODELS_MAX_BYTES = 1024 * 1024;
const secureState = createPosixSecureStateBackend();
const mutationQueues = new Map<string, Promise<unknown>>();

interface RawModelsJson {
  providers: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

function runtimeError(
  code: "invalid_input" | "unavailable" | "conflict",
  message: string,
): ReturnType<typeof makeRuntimeError> {
  return makeRuntimeError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stripJsonComments(text: string): string {
  return text
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match[0] === '"' ? match : ""))
    .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail: string | undefined) =>
      tail ?? (match[0] === '"' ? match : ""));
}

function parseRawModelsJson(text: string, missing: boolean): RawModelsJson {
  if (missing) return { providers: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(text));
  } catch {
    throw runtimeError("invalid_input", "model configuration is invalid");
  }
  if (!isRecord(parsed) || !isRecord(parsed.providers)) {
    throw runtimeError("invalid_input", "model configuration is invalid");
  }
  for (const [id, provider] of Object.entries(parsed.providers)) {
    if (!id.trim() || !isRecord(provider)) {
      throw runtimeError("invalid_input", "model configuration is invalid");
    }
  }
  return parsed as RawModelsJson;
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asApi(value: unknown): ModelConfigApi | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asPositiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function asCost(value: unknown): EditableModelConfig["cost"] {
  if (!isRecord(value)) return undefined;
  const out: NonNullable<EditableModelConfig["cost"]> = {};
  for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    const raw = value[key];
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) out[key] = raw;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function projectModel(raw: Record<string, unknown>, sourceIndex: number): EditableModelConfig {
  const id = asOptionalString(raw.id);
  if (!id) throw runtimeError("invalid_input", "model configuration is invalid");
  const input = Array.isArray(raw.input)
    ? raw.input.filter((value): value is "text" | "image" => value === "text" || value === "image")
    : undefined;
  const cost = asCost(raw.cost);
  return {
    sourceIndex,
    id,
    ...(asOptionalString(raw.name) ? { name: raw.name as string } : {}),
    ...(asApi(raw.api) ? { api: raw.api as ModelConfigApi } : {}),
    ...(typeof raw.reasoning === "boolean" ? { reasoning: raw.reasoning } : {}),
    ...(input && input.length > 0 ? { input } : {}),
    ...(asPositiveInt(raw.contextWindow) ? { contextWindow: raw.contextWindow as number } : {}),
    ...(asPositiveInt(raw.maxTokens) ? { maxTokens: raw.maxTokens as number } : {}),
    ...(cost === undefined ? {} : { cost }),
  };
}

function projectProvider(id: string, raw: Record<string, unknown>): EditableProviderConfig {
  const modelsRaw = raw.models;
  if (modelsRaw !== undefined && !Array.isArray(modelsRaw)) {
    throw runtimeError("invalid_input", "model configuration is invalid");
  }
  const models = (modelsRaw ?? []).map((model, index) => {
    if (!isRecord(model)) throw runtimeError("invalid_input", "model configuration is invalid");
    return projectModel(model, index);
  });
  return {
    sourceId: id,
    id,
    ...(asOptionalString(raw.baseUrl) ? { baseUrl: raw.baseUrl as string } : {}),
    ...(asApi(raw.api) ? { api: raw.api as ModelConfigApi } : {}),
    apiKeyConfigured: typeof raw.apiKey === "string" && raw.apiKey.length > 0,
    modelsDefined: modelsRaw !== undefined,
    models,
  };
}

async function createOfflineRuntime(modelsPath: string | null): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({
    allowModelNetwork: false,
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath,
  });
  if (runtime.getError()) throw runtimeError("invalid_input", "model configuration is invalid");
  return runtime;
}

function providerMethods(provider: Provider): ("oauth" | "apiKey")[] {
  const methods: ("oauth" | "apiKey")[] = [];
  if (provider.auth.oauth) methods.push("oauth");
  if (provider.auth.apiKey) methods.push("apiKey");
  return methods;
}

async function listAvailableProviders(): Promise<readonly AvailableModelProvider[]> {
  const runtime = await createOfflineRuntime(null);
  const modelCounts = new Map<string, number>();
  for (const model of runtime.getModels()) {
    modelCounts.set(model.provider, (modelCounts.get(model.provider) ?? 0) + 1);
  }
  return runtime.getProviders()
    .map((provider) => ({
      id: provider.id,
      name: provider.name || provider.id,
      methods: providerMethods(provider),
      modelCount: modelCounts.get(provider.id) ?? 0,
    }))
    .filter((provider) => provider.methods.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function readSource(agentDir: string): Promise<{ text: string; raw: RawModelsJson; revision: string }> {
  const modelsPath = join(agentDir, "models.json");
  let result;
  try {
    result = await secureState.readStateDocument(modelsPath, { maxBytes: MODELS_MAX_BYTES });
  } catch (error) {
    if (error instanceof LocalAuthorityError) {
      throw runtimeError("unavailable", "model configuration is unavailable");
    }
    throw error;
  }
  const missing = "missing" in result;
  const text = "content" in result ? result.content : "";
  const raw = parseRawModelsJson(text, missing);
  if (!missing) await createOfflineRuntime(modelsPath);
  return { text, raw, revision: hash(text) };
}

function assertMutation(input: ModelsConfigMutation): void {
  if (!/^[0-9a-f]{64}$/.test(input.expectedRevision)) {
    throw runtimeError("invalid_input", "model configuration input is invalid");
  }
  const ids = new Set<string>();
  for (const provider of input.providers) {
    if (!provider.id.trim() || ids.has(provider.id)) {
      throw runtimeError("invalid_input", "model configuration input is invalid");
    }
    ids.add(provider.id);
    if (provider.api !== undefined && !provider.api.length) {
      throw runtimeError("invalid_input", "model configuration input is invalid");
    }
    if (provider.apiKey.mode === "replace" && !provider.apiKey.value.trim()) {
      throw runtimeError("invalid_input", "model configuration input is invalid");
    }
    const sourceIndexes = new Set<number>();
    const modelIds = new Set<string>();
    for (const model of provider.models) {
      if (!model.id.trim() || modelIds.has(model.id)) {
        throw runtimeError("invalid_input", "model configuration input is invalid");
      }
      modelIds.add(model.id);
      if (model.sourceIndex !== null) {
        if (sourceIndexes.has(model.sourceIndex)) throw runtimeError("invalid_input", "model configuration input is invalid");
        sourceIndexes.add(model.sourceIndex);
      }
      if (model.api !== undefined && !model.api.length) {
        throw runtimeError("invalid_input", "model configuration input is invalid");
      }
    }
  }
}

function setOptional(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined) delete target[key];
  else target[key] = value;
}

function mergeModel(source: unknown, model: ModelConfigProviderMutation["models"][number]): Record<string, unknown> {
  const next = isRecord(source) ? structuredClone(source) : {};
  next.id = model.id;
  setOptional(next, "name", model.name);
  setOptional(next, "api", model.api);
  setOptional(next, "reasoning", model.reasoning);
  setOptional(next, "input", model.input ? [...model.input] : undefined);
  setOptional(next, "contextWindow", model.contextWindow);
  setOptional(next, "maxTokens", model.maxTokens);
  const cost = isRecord(next.cost) ? structuredClone(next.cost) : {};
  for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    const value = model.cost?.[key];
    if (value === undefined) delete cost[key];
    else cost[key] = value;
  }
  setOptional(next, "cost", Object.keys(cost).length > 0 ? cost : undefined);
  return next;
}

function mergeProvider(
  source: Record<string, unknown> | undefined,
  mutation: ModelConfigProviderMutation,
): Record<string, unknown> {
  const next = source ? structuredClone(source) : {};
  setOptional(next, "baseUrl", mutation.baseUrl);
  setOptional(next, "api", mutation.api);
  if (mutation.apiKey.mode === "remove") delete next.apiKey;
  if (mutation.apiKey.mode === "replace") next.apiKey = mutation.apiKey.value;
  if (mutation.apiKey.mode === "preserve" && typeof next.apiKey !== "string") {
    throw runtimeError("invalid_input", "model configuration input is invalid");
  }

  const sourceModels = Array.isArray(source?.models) ? source.models : [];
  const models = mutation.models.map((model) => {
    const sourceModel = model.sourceIndex === null ? undefined : sourceModels[model.sourceIndex];
    if (model.sourceIndex !== null && !isRecord(sourceModel)) {
      throw runtimeError("conflict", "model configuration changed");
    }
    return mergeModel(sourceModel, model);
  });
  if (mutation.modelsDefined || models.length > 0) next.models = models;
  else delete next.models;
  return next;
}

function mergeConfig(raw: RawModelsJson, input: ModelsConfigMutation): RawModelsJson {
  const next = structuredClone(raw);
  const providers: Record<string, Record<string, unknown>> = {};
  const consumed = new Set<string>();
  for (const mutation of input.providers) {
    let source: Record<string, unknown> | undefined;
    if (mutation.sourceId !== null) {
      if (consumed.has(mutation.sourceId)) throw runtimeError("invalid_input", "model configuration input is invalid");
      consumed.add(mutation.sourceId);
      source = raw.providers[mutation.sourceId];
      if (!source) throw runtimeError("conflict", "model configuration changed");
    }
    providers[mutation.id] = mergeProvider(source, mutation);
  }
  next.providers = providers;
  return next;
}

async function validateSerialized(serialized: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pix-model-config-"));
  const file = join(dir, `models-${randomUUID()}.json`);
  try {
    await writeFile(file, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await createOfflineRuntime(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function cleanDiscoveredModel(value: unknown): DiscoveredModelConfig | null {
  if (typeof value === "string") {
    const id = value.trim();
    return id ? { id } : null;
  }
  if (!isRecord(value)) return null;
  const stringValue = (key: string): string | undefined => {
    const candidate = value[key];
    return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
  };
  const rawId = stringValue("id") ?? stringValue("model") ?? stringValue("name");
  if (!rawId) return null;
  const id = rawId.startsWith("models/") ? rawId.slice("models/".length) : rawId;
  if (!id) return null;
  const name = stringValue("display_name") ?? stringValue("displayName")
    ?? ((stringValue("id") || stringValue("model")) ? stringValue("name") : undefined);
  return name && name !== id ? { id, name } : { id };
}

function parseDiscoveredModels(payload: unknown): readonly DiscoveredModelConfig[] {
  let values: unknown[] = [];
  if (Array.isArray(payload)) values = payload;
  else if (isRecord(payload)) {
    for (const key of ["data", "models", "results", "items"] as const) {
      const candidate = payload[key];
      if (Array.isArray(candidate)) { values = candidate; break; }
      if (isRecord(candidate)) { values = Object.values(candidate); break; }
    }
  }
  const seen = new Set<string>();
  const models: DiscoveredModelConfig[] = [];
  for (const value of values) {
    const model = cleanDiscoveredModel(value);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return models.sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id, undefined, { numeric: true, sensitivity: "base" }));
}

function modelsListUrl(baseUrl: string, api: ModelConfigApi): URL {
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    throw runtimeError("invalid_input", "model discovery input is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw runtimeError("invalid_input", "model discovery input is invalid");
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (!/\/models$/i.test(path)) {
    let basePath = path;
    if (api === "anthropic-messages" && !/\/v\d+(?:beta)?$/i.test(basePath)) basePath += "/v1";
    if (api === "google-generative-ai" && !/\/v\d+(?:beta)?$/i.test(basePath)) basePath += "/v1beta";
    url.pathname = `${basePath}/models`.replace(/\/+/g, "/");
  }
  if (api === "anthropic-messages") url.searchParams.set("limit", url.searchParams.get("limit") ?? "1000");
  if (api === "google-generative-ai") url.searchParams.set("pageSize", url.searchParams.get("pageSize") ?? "1000");
  return url;
}

function resolvedDiscoveryKey(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const value = raw.trim();
  if (value.startsWith("!")) {
    throw runtimeError("invalid_input", "model discovery cannot execute API-key commands");
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(value) && process.env[value]) return process.env[value];
  return value;
}

async function discoverFromSource(agentDir: string, input: ModelDiscoveryInput): Promise<readonly DiscoveredModelConfig[]> {
  if (!/^[0-9a-f]{64}$/.test(input.expectedRevision) || !input.providerId.trim() || !input.baseUrl.trim() || !input.api.length) {
    throw runtimeError("invalid_input", "model discovery input is invalid");
  }
  const current = await readSource(agentDir);
  if (current.revision !== input.expectedRevision) throw runtimeError("conflict", "model configuration changed");
  const source = input.sourceId === null ? undefined : current.raw.providers[input.sourceId];
  if (input.sourceId !== null && !source) throw runtimeError("conflict", "model configuration changed");
  // Never replay a persisted credential/header set to an edited endpoint. A
  // changed provider id or Base URL requires a freshly typed one-way key.
  const sourceEndpointMatches = input.sourceId !== null
    && input.providerId === input.sourceId
    && source?.baseUrl === input.baseUrl;
  const apiKey = resolvedDiscoveryKey(input.apiKey ?? (sourceEndpointMatches ? source?.apiKey : undefined));
  const headers = new Headers();
  if (sourceEndpointMatches && isRecord(source?.headers)) {
    for (const [key, value] of Object.entries(source.headers)) {
      if (typeof value === "string") headers.set(key, value);
    }
  }
  headers.set("Accept", "application/json");
  if (apiKey) {
    if (input.api === "anthropic-messages") {
      if (!headers.has("x-api-key")) headers.set("x-api-key", apiKey);
      if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
    } else if (input.api === "google-generative-ai") {
      if (!headers.has("x-goog-api-key")) headers.set("x-goog-api-key", apiKey);
    } else if (!headers.has("authorization")) {
      headers.set("Authorization", `Bearer ${apiKey}`);
    }
  }
  const discoveryUrl = modelsListUrl(input.baseUrl, input.api);
  let response: Response;
  try {
    response = await fetch(discoveryUrl, {
      headers,
      // Discovery is bound to the exact user-configured endpoint. Following an
      // upstream redirect would silently broaden the Host's network authority.
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw runtimeError("unavailable", "model discovery is unavailable");
  }
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > 2 * 1024 * 1024) {
    throw runtimeError("unavailable", "model discovery is unavailable");
  }
  const text = await response.text();
  if (!response.ok || Buffer.byteLength(text, "utf8") > 2 * 1024 * 1024) {
    throw runtimeError("unavailable", "model discovery is unavailable");
  }
  let payload: unknown;
  try { payload = JSON.parse(text); } catch { throw runtimeError("unavailable", "model discovery is unavailable"); }
  const models = parseDiscoveredModels(payload);
  if (models.length === 0) throw runtimeError("unavailable", "model discovery returned no models");
  return models;
}

function withMutationQueue<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(key) ?? Promise.resolve();
  const next = previous.then(run, run);
  mutationQueues.set(key, next.then(() => undefined, () => undefined));
  return next;
}

async function snapshot(agentDir: string): Promise<ModelsConfigSnapshot> {
  const source = await readSource(agentDir);
  return {
    revision: source.revision,
    providers: Object.entries(source.raw.providers).map(([id, provider]) => projectProvider(id, provider)),
    availableProviders: await listAvailableProviders(),
  };
}

export interface PiSdkModelConfigStoreOptions {
  agentDir?: string;
}

/**
 * Full models.json editor store. Secret material is consumed only on writes and
 * is never returned; unchanged secrets are preserved server-side by sourceId.
 */
export function createPiSdkModelConfigStore(options: PiSdkModelConfigStoreOptions = {}): ModelConfigStorePort {
  const configuredAgentDir = resolve(options.agentDir ?? getAgentDir());
  const canonicalAgentDir = () => secureState.canonicalizePath(configuredAgentDir);
  return {
    readConfig: async () => snapshot(await canonicalAgentDir()),
    writeConfig: (input) => withMutationQueue(configuredAgentDir, async () => {
      assertMutation(input);
      const agentDir = await canonicalAgentDir();
      const modelsPath = join(agentDir, "models.json");
      try {
        await mkdir(agentDir, { recursive: true, mode: 0o700 });
        await secureState.ensurePrivateDirectory(agentDir);
      } catch {
        throw runtimeError("unavailable", "model configuration is unavailable");
      }
      let release: (() => Promise<void>) | undefined;
      try {
        release = await lockfile.lock(agentDir, {
          realpath: false,
          lockfilePath: `${modelsPath}.lock`,
          retries: { retries: 9, minTimeout: 20, maxTimeout: 20 },
        });
        const current = await readSource(agentDir);
        if (current.revision !== input.expectedRevision) {
          throw runtimeError("conflict", "model configuration changed");
        }
        const merged = mergeConfig(current.raw, input);
        const serialized = `${JSON.stringify(merged, null, 2)}\n`;
        await validateSerialized(serialized);
        await secureState.writeStateDocument(modelsPath, serialized, { maxBytes: MODELS_MAX_BYTES });
      } catch (error) {
        if (error && typeof error === "object" && "code" in error) throw error;
        throw runtimeError("unavailable", "model configuration could not be saved");
      } finally {
        await release?.().catch(() => {});
      }
      return snapshot(agentDir);
    }),
    discoverModels: async (input) => discoverFromSource(await canonicalAgentDir(), input),
  };
}
