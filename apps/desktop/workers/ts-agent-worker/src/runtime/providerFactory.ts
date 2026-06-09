import OpenAI from "openai";

import type { ModelProvider } from "../model/provider.ts";
import { OpenAIProvider, type OpenAIChatCompletionsClient } from "../model/openaiProvider.ts";
import { UnconfiguredProvider } from "../model/unconfiguredProvider.ts";

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
    };

export type ModelProviderFactoryDeps = {
  createOpenAIClient?: (options: OpenAIClientOptions) => OpenAIChatCompletionsClient;
};

export function createModelProvider(
  config: ModelProviderConfig,
  deps: ModelProviderFactoryDeps = {},
): ModelProvider {
  if (config.kind !== "openai") {
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
