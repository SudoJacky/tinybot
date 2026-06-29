import type { AgentMessage } from "../agent/agentRunSpec.ts";
import type { RequestTraits } from "../providers/providerCatalog.ts";
import { buildOpenAIChatRequest } from "./openaiRequestBuilder.ts";
import { withProviderRetry } from "./providerRetry.ts";
import { collectChatCompletionStream, type StreamModelResponse } from "./streamParser.ts";
import type { ModelProvider, ModelRequestOptions } from "./provider.ts";

export type OpenAIChatCompletionsClient = {
  chat: {
    completions: {
      create: (request: Record<string, unknown>) => Promise<AsyncIterable<unknown>>;
    };
  };
};

export type OpenAIProviderOptions = {
  client: OpenAIChatCompletionsClient;
  defaultModel: string;
  requestTraits?: Partial<RequestTraits>;
  extraBodyDefaults?: Record<string, unknown>;
  enableSearch?: boolean;
};

export class OpenAIProvider implements ModelProvider {
  private readonly client: OpenAIChatCompletionsClient;
  private readonly defaultModel: string;
  private readonly requestTraits?: Partial<RequestTraits>;
  private readonly extraBodyDefaults?: Record<string, unknown>;
  private readonly enableSearch: boolean;

  constructor(options: OpenAIProviderOptions) {
    this.client = options.client;
    this.defaultModel = options.defaultModel;
    this.requestTraits = options.requestTraits;
    this.extraBodyDefaults = options.extraBodyDefaults;
    this.enableSearch = options.enableSearch ?? false;
  }

  async complete(messages: AgentMessage[], options: ModelRequestOptions = {}): Promise<StreamModelResponse> {
    const request = buildOpenAIChatRequest({
      defaultModel: this.defaultModel,
      messages,
      options,
      requestTraits: this.requestTraits,
      extraBodyDefaults: this.extraBodyDefaults,
      enableSearch: this.enableSearch,
    });
    let stream: AsyncIterable<unknown>;
    try {
      stream = await withProviderRetry(
        () => this.client.chat.completions.create(request),
        {
          retryMode: options.retryMode,
          onRetryWait: options.onRetryWait,
        },
      );
    } catch (error) {
      return {
        content: openAIErrorContent(error),
        toolCalls: [],
        stopReason: "error",
      };
    }
    return collectChatCompletionStream(stream, options);
  }
}

function openAIErrorContent(error: unknown): string {
  const body = providerErrorBody(error);
  if (body.length > 0) {
    return `Error: ${body.slice(0, 500)}`;
  }
  if (error instanceof Error) {
    return `Error calling LLM: ${error.message}`;
  }
  return `Error calling LLM: ${String(error)}`;
}

function providerErrorBody(error: unknown): string {
  if (!isRecord(error)) {
    return "";
  }
  const response = isRecord(error.response) ? error.response : undefined;
  const body = error.doc ?? response?.text ?? response?.body;
  return body === undefined || body === null ? "" : String(body).trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
