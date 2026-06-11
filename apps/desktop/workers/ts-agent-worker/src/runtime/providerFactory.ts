import OpenAI from "openai";

import { FixtureProvider } from "../model/fixtureProvider.ts";
import type { ModelProvider, ModelResponse } from "../model/provider.ts";
import { OpenAIProvider, type OpenAIChatCompletionsClient } from "../model/openaiProvider.ts";
import { UnconfiguredProvider } from "../model/unconfiguredProvider.ts";
import type { ResolvedRuntimeProvider } from "../providers/providerRuntime.ts";

type OpenAIClientOptions = {
  apiKey: string;
  baseURL?: string;
  maxRetries: number;
};

export type ModelProviderConfig =
  | {
      kind?: undefined;
    }
  | {
      kind: "openai";
      apiKey: string;
      baseURL?: string;
      model: string;
      requestTraits?: ResolvedRuntimeProvider["requestTraits"];
      extraBody?: Record<string, unknown>;
      enableSearch?: boolean;
    }
  | {
      kind: "resolved";
      resolved: ResolvedRuntimeProvider;
    }
  | {
      kind: "fixture";
      responses: ModelResponse[];
    };

export type ModelProviderFactoryDeps = {
  createOpenAIClient?: (options: OpenAIClientOptions) => OpenAIChatCompletionsClient;
};

export function createModelProvider(
  config: ModelProviderConfig,
  deps: ModelProviderFactoryDeps = {},
): ModelProvider {
  if (config.kind !== "openai") {
    if (config.kind === "fixture") {
      return new FixtureProvider(config.responses);
    }
    if (config.kind === "resolved") {
      return createResolvedModelProvider(config.resolved, deps);
    }
    return new UnconfiguredProvider();
  }
  const createOpenAIClient = deps.createOpenAIClient ?? ((options) => adaptOpenAIClient(new OpenAI(options)));
  return new OpenAIProvider({
    client: createOpenAIClient({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      maxRetries: 0,
    }),
    defaultModel: config.model,
    requestTraits: config.requestTraits,
    extraBodyDefaults: config.extraBody,
    enableSearch: config.enableSearch,
  });
}

function createResolvedModelProvider(
  resolved: ResolvedRuntimeProvider,
  deps: ModelProviderFactoryDeps,
): ModelProvider {
  if (resolved.apiMode && resolved.apiMode !== "openai_chat_completions") {
    return new UnconfiguredProvider(`Unsupported provider api_mode: ${resolved.apiMode}`);
  }
  const localProviderIds = new Set(["ollama", "lm_studio"]);
  const apiKey = resolved.apiKey ?? (resolved.providerId && localProviderIds.has(resolved.providerId) ? "tinybot-local-provider" : undefined);
  if (!resolved.providerId || !apiKey) {
    return new UnconfiguredProvider(`model provider is not configured: ${resolved.providerId ?? "unresolved"}`);
  }
  const createOpenAIClient = deps.createOpenAIClient ?? ((options) => adaptOpenAIClient(new OpenAI(options)));
  return new OpenAIProvider({
    client: createOpenAIClient({
      apiKey,
      baseURL: resolved.apiBase,
      maxRetries: 0,
    }),
    defaultModel: resolved.model,
    requestTraits: resolved.requestTraits,
    extraBodyDefaults: resolved.extraBody,
  });
}

function adaptOpenAIClient(client: OpenAI): OpenAIChatCompletionsClient {
  return {
    chat: {
      completions: {
        create: async (request) => {
          const response = await client.chat.completions.create(request as never);
          return response as unknown as AsyncIterable<unknown>;
        },
      },
    },
  };
}

export function modelProviderConfigFromEnv(env: Record<string, string | undefined>): ModelProviderConfig {
  if (env.TS_AGENT_PROVIDER !== "openai") {
    return {};
  }
  const apiKey = env.OPENAI_API_KEY;
  const model = env.TS_AGENT_OPENAI_MODEL ?? env.OPENAI_MODEL ?? "gpt-4.1-mini";
  if (!apiKey) {
    return {};
  }
  return {
    kind: "openai",
    apiKey,
    baseURL: env.OPENAI_BASE_URL,
    model,
  };
}
