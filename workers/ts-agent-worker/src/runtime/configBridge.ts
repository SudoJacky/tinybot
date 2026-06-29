import type { JsonObject } from "../protocol/messages.ts";
import type { NativeRpcClient } from "../tools/nativeToolProxy.ts";
import type { ModelResponse } from "../model/provider.ts";
import { applyConfigPatch } from "../config/configPatch.ts";
import { parseTinybotConfig } from "../config/configSchema.ts";
import type { JsonRecord } from "../config/configTypes.ts";
import { createPublicConfigSnapshot } from "../config/configSnapshot.ts";
import type { SecretMaskMode } from "../config/configMasking.ts";
import { probeOpenAICompatibleModels, type JsonFetcher } from "../providers/modelDiscovery.ts";
import { isLocalProvider, listCatalogEntries, type ProviderCatalogEntry } from "../providers/providerCatalog.ts";
import { listProviderModels, validateModelForProvider } from "../providers/providerModels.ts";
import { resolveRuntimeProvider, type ProviderSecretResolution, type TinybotPublicConfig } from "../providers/providerRuntime.ts";
import { modelProviderConfigFromEnv, OPENAI_ENV_DEFAULT_MODEL, type ModelProviderConfig } from "./providerFactory.ts";

const CONFIG_TRACE_ID = "worker-config";

export type NativeConfigPatchApplyResponse = {
  ok: boolean;
  config: JsonRecord;
  updatedFields: string[];
  sideEffects: {
    applied: string[];
    restartRequired: string[];
    warnings: string[];
  };
  error?: string | null;
};

export class NativeConfigBridge {
  private readonly rpcClient: NativeRpcClient;

  constructor(rpcClient: NativeRpcClient) {
    this.rpcClient = rpcClient;
  }

  async get(path: string): Promise<unknown> {
    const result = await this.rpcClient.request(CONFIG_TRACE_ID, "config.get", { path });
    const object = asObject(result);
    return object?.value;
  }

  async snapshotPublic(maskMode: SecretMaskMode = "public-rpc-null"): Promise<TinybotPublicConfig> {
    const result = await this.rpcClient.request(CONFIG_TRACE_ID, "config.snapshot_public", {});
    const object = asObject(result);
    const value = asObject(object?.value);
    if (!value) {
      throw new Error("config.snapshot_public did not return an object snapshot");
    }
    return createPublicConfigSnapshot(value, maskMode);
  }

  async applyPatch(current: JsonRecord, patch: JsonRecord): Promise<NativeConfigPatchApplyResponse> {
    const result = applyConfigPatch(parseTinybotConfig(current), patch);
    return this.rpcClient.request(
      CONFIG_TRACE_ID,
      "config.apply_patch_result",
      result as unknown as JsonObject,
    ) as Promise<NativeConfigPatchApplyResponse>;
  }

  async resolveProviderSecret(input: {
    providerId: string;
    profileName?: string;
    apiKeyEnvVars: string[];
  }): Promise<ProviderSecretResolution | undefined> {
    const result = await this.rpcClient.request(CONFIG_TRACE_ID, "provider.resolve_secret", {
      providerId: input.providerId,
      ...(input.profileName ? { profileName: input.profileName } : {}),
      apiKeyEnvVars: input.apiKeyEnvVars,
    });
    const object = asObject(result);
    const apiKey = asString(object?.apiKey ?? object?.api_key);
    if (!apiKey) {
      return undefined;
    }
    return {
      apiKey,
      apiKeySource: (asString(object?.apiKeySource ?? object?.api_key_source) as ProviderSecretResolution["apiKeySource"]) ?? "config",
    };
  }
}

export async function modelProviderConfigFromNativeConfig(
  configBridge: NativeConfigBridge,
  env: Record<string, string | undefined>,
): Promise<ModelProviderConfig> {
  try {
    const snapshot = await configBridge.snapshotPublic();
    const provider = asString(pathValue(snapshot, ["agents", "defaults", "provider"]));
    if (provider === "fixture") {
      const providerConfig = asObject(pathValue(snapshot, ["providers", "fixture"]));
      return {
        kind: "fixture",
        responses: normalizeFixtureResponses(providerConfig?.responses),
      };
    }
    const resolved = await resolveRuntimeProvider({
      config: snapshot,
      env,
      secretResolver: (input) => configBridge.resolveProviderSecret(input),
    });
    return { kind: "resolved", resolved };
  } catch {
    return legacyModelProviderConfigFromNativeConfig(configBridge, env);
  }
}

export async function providerModelsFromNativeConfig(
  configBridge: NativeConfigBridge,
  env: Record<string, string | undefined>,
  input: {
    providerId?: string;
    profileName?: string;
    model?: string;
    apiKey?: string;
    apiBase?: string;
    manualModelIds?: string[];
    refreshLive?: boolean;
  },
  fetchJson: JsonFetcher = fetchModelDiscoveryJson,
): Promise<Record<string, unknown>> {
  let snapshot: TinybotPublicConfig;
  try {
    snapshot = await configBridge.snapshotPublic();
  } catch (error) {
    if (!hasProviderModelRequestOverrides(input)) {
      throw error;
    }
    snapshot = createPublicConfigSnapshot({});
  }
  const resolved = await resolveRuntimeProvider({
    config: snapshot,
    env,
    provider: input.providerId,
    profileName: input.profileName,
    model: input.model,
    secretResolver: input.apiKey ? undefined : (secretInput) => configBridge.resolveProviderSecret(secretInput),
  });
  const manualModelIds = [...resolved.manualModelIds, ...(input.manualModelIds ?? [])];
  const apiKey = input.apiKey ?? resolved.apiKey;
  const apiBase = input.apiBase ?? resolved.apiBase;
  const modelList = await listProviderModels({
    providerId: resolved.providerId ?? input.providerId ?? "",
    profileModels: resolved.models,
    manualModelIds,
    supportsModelDiscovery: resolved.supportsModelDiscovery,
    apiKey,
    apiBase,
    refreshLive: input.refreshLive,
    discoverer: (discoveryInput) => probeOpenAICompatibleModels({
      apiBase: discoveryInput.apiBase,
      headers: discoveryInput.headers,
      providerId: discoveryInput.providerId,
      fetchJson,
    }),
  });
  const modelSources = Object.fromEntries(modelList.models.map((model) => [model.id, model.sources]));
  return {
    providerId: resolved.providerId ?? input.providerId ?? "",
    model: resolved.model,
    profileName: resolved.profileName ?? null,
    source: resolved.source,
    apiBase: apiBase ?? null,
    apiKeySource: input.apiKey ? "request" : resolved.apiKeySource ?? null,
    supportsModelDiscovery: resolved.supportsModelDiscovery,
    models: modelList.models.map((model) => model.id),
    modelSources,
    sourceCounts: modelList.sourceCounts,
    warning: modelList.warning ?? null,
    url: modelList.url ?? null,
    warnings: resolved.warnings,
  };
}

function hasProviderModelRequestOverrides(input: {
  apiKey?: string;
  apiBase?: string;
  manualModelIds?: string[];
}): boolean {
  return Boolean(input.apiKey || input.apiBase || input.manualModelIds?.length);
}

async function fetchModelDiscoveryJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, {
      headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response.json() as Promise<unknown>;
  } finally {
    clearTimeout(timeout);
  }
}

export function providerCatalogForSettings(
  snapshot: TinybotPublicConfig = {},
  env: Record<string, string | undefined> = {},
): Record<string, unknown> {
  const providersConfig = asObject(snapshot.providers) ?? {};
  const defaults = asObject(asObject(snapshot.agents)?.defaults);
  const activeProvider = asString(defaults?.provider);
  const activeModel = asString(defaults?.model);
  const catalogEntries = listCatalogEntries();
  const catalogIds = new Set(catalogEntries.map((entry) => entry.id));
  const providers = catalogEntries.map((entry) =>
    providerCatalogStatus(entry, asObject(providersConfig[entry.id]), activeProvider, activeModel, env)
  );

  for (const [providerId, rawConfig] of Object.entries(providersConfig)) {
    if (providerId === "profiles" || catalogIds.has(providerId)) {
      continue;
    }
    const providerConfig = asObject(rawConfig);
    if (!providerConfig) {
      continue;
    }
    providers.push(providerCatalogStatus(undefined, providerConfig, activeProvider, activeModel, env, providerId));
  }

  return { providers };
}

export async function providerCatalogFromNativeConfig(
  configBridge: NativeConfigBridge,
  env: Record<string, string | undefined>,
): Promise<Record<string, unknown>> {
  try {
    return providerCatalogForSettings(await configBridge.snapshotPublic("ui-placeholder"), env);
  } catch {
    return providerCatalogForSettings({}, env);
  }
}

function providerCatalogStatus(
  entry: ProviderCatalogEntry | undefined,
  providerConfig: JsonObject | null,
  activeProvider: string | undefined,
  activeModel: string | undefined,
  env: Record<string, string | undefined>,
  customProviderId?: string,
): Record<string, unknown> {
  const providerId = entry?.id ?? customProviderId ?? "custom";
  const baseUrl = asString(configField(providerConfig, "api_base", "apiBase"))
    ?? envValue(env, entry?.apiBaseEnvVars ?? [])
    ?? entry?.defaultApiBase
    ?? null;
  const configuredKey = asString(configField(providerConfig, "api_key", "apiKey"));
  const envKey = envValue(env, entry?.apiKeyEnvVars ?? []);
  const hasCredential = Boolean(configuredKey || envKey || isLocalProvider(entry));
  const enabled = booleanValue(configField(providerConfig, "enabled")) ?? true;
  const models = stringArray(configField(providerConfig, "models"));
  const manualModels = stringArray(configField(providerConfig, "manual_models", "manualModels"));
  const modelCount = new Set([...models, ...manualModels, ...(entry?.curatedModelIds ?? [])]).size;
  const status = providerStatus({ enabled, hasCredential, modelCount, entry, customProviderId });
  const credentialState = isLocalProvider(entry) ? "not_required" : hasCredential ? "configured" : "missing";
  const isDefault = activeProvider === providerId;

  return {
    id: providerId,
    displayName: entry?.displayName ?? providerId,
    aliases: entry?.aliases ?? [],
    categories: entry?.categories ?? ["custom"],
    defaultApiBase: entry?.defaultApiBase ?? null,
    baseUrl,
    apiMode: entry?.apiMode ?? "openai_chat_completions",
    supportsModelDiscovery: booleanValue(configField(providerConfig, "supports_model_discovery", "supportsModelDiscovery"))
      ?? entry?.supportsModelDiscovery
      ?? true,
    curatedModels: entry?.curatedModelIds ?? [],
    modelPrefixes: entry?.modelPrefixes ?? [],
    requestTraits: entry?.requestTraits ?? null,
    ...(customProviderId ? { custom: true } : {}),
    enabled,
    status,
    credential: {
      state: credentialState,
      source: configuredKey ? "config" : envKey ? "env" : null,
    },
    models: {
      count: modelCount,
      sources: {
        curated: entry?.curatedModelIds.length ?? 0,
        profile: 0,
        live: 0,
        manual: manualModels.length + models.length,
      },
      warning: null,
    },
    default: {
      isDefault,
      model: isDefault ? activeModel ?? null : null,
    },
    actions: {
      models: true,
      settings: true,
      refresh: Boolean(baseUrl),
      useAsDefault: status === "ready" || status === "no_models",
    },
  };
}

function providerStatus(input: {
  enabled: boolean;
  hasCredential: boolean;
  modelCount: number;
  entry: ProviderCatalogEntry | undefined;
  customProviderId?: string;
}): string {
  if (!input.enabled) {
    return "disabled";
  }
  if (isLocalProvider(input.entry)) {
    return "ready";
  }
  if (!input.hasCredential) {
    return "needs_key";
  }
  return input.modelCount > 0 && !input.customProviderId ? "ready" : "no_models";
}

export async function providerRuntimeFromNativeConfig(
  configBridge: NativeConfigBridge,
  env: Record<string, string | undefined>,
  input: {
    providerId?: string;
    model?: string;
  },
): Promise<Record<string, unknown>> {
  const snapshot = await configBridge.snapshotPublic();
  const resolved = await resolveRuntimeProvider({
    config: snapshot,
    env,
    provider: input.providerId,
    model: input.model,
    secretResolver: (secretInput) => configBridge.resolveProviderSecret(secretInput),
  });
  return publicProviderRuntime(resolved);
}

export function providerModelValidationResult(input: { providerId: string; model: string }): Record<string, unknown> {
  const result = validateModelForProvider(input);
  return {
    ok: result.ok,
    message: result.message ?? null,
  };
}

async function legacyModelProviderConfigFromNativeConfig(
  configBridge: NativeConfigBridge,
  env: Record<string, string | undefined>,
): Promise<ModelProviderConfig> {
  try {
    const provider = asString(await configBridge.get("agents.defaults.provider"));
    if (provider === "fixture") {
      const providerConfig = asObject(await configBridge.get("providers.fixture"));
      return {
        kind: "fixture",
        responses: normalizeFixtureResponses(providerConfig?.responses),
      };
    }
    if (provider !== "openai" && provider !== "auto") {
      return modelProviderConfigFromEnv(env);
    }

    const secret = env.OPENAI_API_KEY
      ? undefined
      : await configBridge.resolveProviderSecret({
        providerId: "openai",
        apiKeyEnvVars: ["OPENAI_API_KEY"],
      });
    const apiKey = env.OPENAI_API_KEY ?? secret?.apiKey;
    if (!apiKey) {
      return {};
    }

    const model =
      asString(await configBridge.get("agents.defaults.model")) ??
      env.TS_AGENT_OPENAI_MODEL ??
      env.OPENAI_MODEL ??
      OPENAI_ENV_DEFAULT_MODEL;
    const providerConfig = asObject(await configBridge.get("providers.openai"));
    const baseURL = asString(providerConfig?.api_base) ?? asString(providerConfig?.baseURL) ?? env.OPENAI_BASE_URL;
    return { kind: "openai", apiKey, baseURL, model };
  } catch {
    return modelProviderConfigFromEnv(env);
  }
}

function publicProviderRuntime(resolved: Awaited<ReturnType<typeof resolveRuntimeProvider>>): Record<string, unknown> {
  return {
    providerId: resolved.providerId ?? null,
    model: resolved.model,
    profileName: resolved.profileName ?? null,
    source: resolved.source,
    apiMode: resolved.apiMode ?? null,
    apiBase: resolved.apiBase ?? null,
    apiKeySource: resolved.apiKeySource ?? null,
    models: resolved.models,
    manualModelIds: resolved.manualModelIds,
    supportsModelDiscovery: resolved.supportsModelDiscovery,
    requestTraits: resolved.requestTraits,
    extraBody: resolved.extraBody,
    warnings: resolved.warnings,
  };
}

function pathValue(config: TinybotPublicConfig, segments: string[]): unknown {
  let current: unknown = config;
  for (const segment of segments) {
    const object = asObject(current);
    if (!object) {
      return undefined;
    }
    current = object[segment];
  }
  return current;
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function configField(object: Record<string, unknown> | undefined | null, ...names: string[]): unknown {
  if (!object) {
    return undefined;
  }
  for (const name of names) {
    if (name in object) {
      return object[name];
    }
  }
  return undefined;
}

function envValue(env: Record<string, string | undefined>, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value) {
      return value;
    }
  }
  return undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function normalizeFixtureResponses(value: unknown): ModelResponse[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(normalizeFixtureResponse).filter((response): response is ModelResponse => response !== null);
}

function normalizeFixtureResponse(value: unknown): ModelResponse | null {
  const object = asObject(value);
  const content = typeof object?.content === "string" ? object.content : undefined;
  if (!object || content === undefined) {
    return null;
  }
  return {
    content,
    stopReason: asString(object.stopReason) ?? asString(object.stop_reason) ?? "stop",
    toolCalls: normalizeFixtureToolCalls(object.toolCalls ?? object.tool_calls),
    delayMs: numberValue(object.delayMs ?? object.delay_ms),
  };
}

function normalizeFixtureToolCalls(value: unknown): ModelResponse["toolCalls"] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry, index) => {
    const object = asObject(entry);
    if (!object) {
      return null;
    }
    const name = asString(object.name);
    if (!name) {
      return null;
    }
    return {
      id: asString(object.id) ?? `fixture-call-${index}`,
      name,
      argumentsJson: asString(object.argumentsJson) ?? asString(object.arguments_json) ?? "{}",
    };
  }).filter((toolCall): toolCall is ModelResponse["toolCalls"][number] => toolCall !== null);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
