import type { JsonObject } from "../protocol/messages.ts";
import type { NativeRpcClient } from "../tools/nativeToolProxy.ts";
import type { ModelResponse } from "../model/provider.ts";
import { resolveRuntimeProvider, type ProviderSecretResolution, type TinybotPublicConfig } from "../providers/providerRuntime.ts";
import { modelProviderConfigFromEnv, type ModelProviderConfig } from "./providerFactory.ts";

const CONFIG_TRACE_ID = "worker-config";

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
    return value;
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
