import type { JsonObject } from "../protocol/messages.ts";
import type { NativeRpcClient } from "../tools/nativeToolProxy.ts";
import type { ModelResponse } from "../model/provider.ts";
import { applyConfigPatch } from "../config/configPatch.ts";
import { parseTinybotConfig } from "../config/configSchema.ts";
import type { JsonRecord } from "../config/configTypes.ts";
import { createPublicConfigSnapshot } from "../config/configSnapshot.ts";
import { probeOpenAICompatibleModels, type JsonFetcher } from "../providers/modelDiscovery.ts";
import { listCatalogEntries } from "../providers/providerCatalog.ts";
import { listProviderModels, validateModelForProvider } from "../providers/providerModels.ts";
import { resolveRuntimeProvider, type ProviderSecretResolution, type TinybotPublicConfig } from "../providers/providerRuntime.ts";
import { modelProviderConfigFromEnv, type ModelProviderConfig } from "./providerFactory.ts";

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

  async snapshotPublic(): Promise<TinybotPublicConfig> {
    const result = await this.rpcClient.request(CONFIG_TRACE_ID, "config.snapshot_public", {});
    const object = asObject(result);
    const value = asObject(object?.value);
    if (!value) {
      throw new Error("config.snapshot_public did not return an object snapshot");
    }
    return createPublicConfigSnapshot(value);
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
    providerId: string;
    model?: string;
    manualModelIds?: string[];
    refreshLive?: boolean;
  },
  fetchJson: JsonFetcher = fetchModelDiscoveryJson,
): Promise<Record<string, unknown>> {
  const snapshot = await configBridge.snapshotPublic();
  const resolved = await resolveRuntimeProvider({
    config: snapshot,
    env,
    provider: input.providerId,
    model: input.model,
    secretResolver: (secretInput) => configBridge.resolveProviderSecret(secretInput),
  });
  const manualModelIds = [...resolved.manualModelIds, ...(input.manualModelIds ?? [])];
  const modelList = await listProviderModels({
    providerId: resolved.providerId ?? input.providerId,
    profileModels: resolved.models,
    manualModelIds,
    supportsModelDiscovery: resolved.supportsModelDiscovery,
    apiKey: resolved.apiKey,
    apiBase: resolved.apiBase,
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
    providerId: resolved.providerId ?? input.providerId,
    model: resolved.model,
    profileName: resolved.profileName ?? null,
    source: resolved.source,
    apiBase: resolved.apiBase ?? null,
    apiKeySource: resolved.apiKeySource ?? null,
    supportsModelDiscovery: resolved.supportsModelDiscovery,
    models: modelList.models.map((model) => model.id),
    modelSources,
    sourceCounts: modelList.sourceCounts,
    warning: modelList.warning ?? null,
    url: modelList.url ?? null,
    warnings: resolved.warnings,
  };
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

export function providerCatalogForSettings(): Record<string, unknown> {
  return {
    providers: listCatalogEntries().map((entry) => ({
      id: entry.id,
      displayName: entry.displayName,
      aliases: entry.aliases,
      categories: entry.categories,
      defaultApiBase: entry.defaultApiBase ?? null,
      apiMode: entry.apiMode,
      supportsModelDiscovery: entry.supportsModelDiscovery,
      curatedModels: entry.curatedModelIds,
      modelPrefixes: entry.modelPrefixes,
      requestTraits: entry.requestTraits,
    })),
  };
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
    if (provider !== "openai" && !(provider === "auto" && env.OPENAI_API_KEY)) {
      return modelProviderConfigFromEnv(env);
    }

    const apiKey = env.OPENAI_API_KEY;
    if (!apiKey) {
      return {};
    }

    const model =
      asString(await configBridge.get("agents.defaults.model")) ??
      env.TS_AGENT_OPENAI_MODEL ??
      env.OPENAI_MODEL ??
      "gpt-4.1-mini";
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
