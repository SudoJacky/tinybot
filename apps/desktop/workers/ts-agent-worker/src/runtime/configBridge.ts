import type { JsonObject } from "../protocol/messages.ts";
import type { NativeRpcClient } from "../tools/nativeToolProxy.ts";
import type { ModelResponse } from "../model/provider.ts";
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
}

export async function modelProviderConfigFromNativeConfig(
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
    if (provider !== "openai") {
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
  const content = asString(object?.content);
  if (!object || content === undefined) {
    return null;
  }
  return {
    content,
    stopReason: asString(object.stopReason) ?? asString(object.stop_reason) ?? "stop",
    toolCalls: normalizeFixtureToolCalls(object.toolCalls ?? object.tool_calls),
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
