import { createHash } from "node:crypto";

import type { AgentMessage } from "../agent/agentRunSpec.ts";
import { collectChatCompletionStream, type StreamModelResponse } from "./streamParser.ts";
import type { ModelProvider, ModelRequestOptions, ToolDefinition } from "./provider.ts";

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
};

export class OpenAIProvider implements ModelProvider {
  private readonly client: OpenAIChatCompletionsClient;
  private readonly defaultModel: string;

  constructor(options: OpenAIProviderOptions) {
    this.client = options.client;
    this.defaultModel = options.defaultModel;
  }

  async complete(messages: AgentMessage[], options: ModelRequestOptions = {}): Promise<StreamModelResponse> {
    const request: Record<string, unknown> = {
      model: options.model?.trim() || this.defaultModel,
      messages: toOpenAIMessages(messages),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (options.tools?.length) {
      request.tools = options.tools.map(toOpenAITool);
      request.tool_choice = "auto";
    }
    if (options.temperature !== undefined && supportsTemperature(request.model, options.reasoningEffort)) {
      request.temperature = options.temperature;
    }
    if (options.maxTokens !== undefined) {
      request.max_tokens = Math.max(1, options.maxTokens);
    }
    if (options.reasoningEffort) {
      request.reasoning_effort = options.reasoningEffort;
    }
    let stream: AsyncIterable<unknown>;
    try {
      stream = await this.client.chat.completions.create(request);
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

function toOpenAIMessages(messages: AgentMessage[]): Record<string, unknown>[] {
  const toolCallIds = new Map<string, string>();
  return messages.map((message) => toOpenAIMessage(message, toolCallIds));
}

function toOpenAIMessage(message: AgentMessage, toolCallIds: Map<string, string>): Record<string, unknown> {
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content.length === 0 ? null : message.content,
      ...(message.reasoningContent !== undefined ? { reasoning_content: message.reasoningContent } : {}),
      ...(message.thinkingBlocks ? { thinking_blocks: message.thinkingBlocks } : {}),
      tool_calls: message.toolCalls.map((toolCall) => ({
        id: mapToolCallId(toolCallIds, toolCall.id),
        type: "function",
        function: {
          name: toolCall.name,
          arguments: toolCall.argumentsJson,
        },
      })),
    };
  }
  if (message.role === "tool") {
    return {
      role: "tool",
      content: sanitizedTextContent(message.content),
      tool_call_id: message.toolCallId ? mapToolCallId(toolCallIds, message.toolCallId) : message.toolCallId,
      name: message.name,
    };
  }
  return {
    role: message.role,
    content: sanitizedTextContent(message.content),
    ...(message.role === "assistant" && message.reasoningContent !== undefined
      ? { reasoning_content: message.reasoningContent }
      : {}),
    ...(message.role === "assistant" && message.thinkingBlocks ? { thinking_blocks: message.thinkingBlocks } : {}),
  };
}

function sanitizedTextContent(content: string): string {
  return content.length === 0 ? "(empty)" : content;
}

function mapToolCallId(toolCallIds: Map<string, string>, toolCallId: string): string {
  const existing = toolCallIds.get(toolCallId);
  if (existing) {
    return existing;
  }
  const normalized = normalizeToolCallId(toolCallId);
  toolCallIds.set(toolCallId, normalized);
  return normalized;
}

function normalizeToolCallId(toolCallId: string): string {
  if (toolCallId.length === 9 && /^[a-z0-9]+$/i.test(toolCallId)) {
    return toolCallId;
  }
  return createHash("sha1").update(toolCallId).digest("hex").slice(0, 9);
}

function toOpenAITool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function supportsTemperature(model: unknown, reasoningEffort: string | undefined): boolean {
  if (reasoningEffort && reasoningEffort.toLowerCase() !== "none") {
    return false;
  }
  const modelName = typeof model === "string" ? model.toLowerCase() : "";
  return !["gpt-5", "o1", "o3", "o4"].some((token) => modelName.includes(token));
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
  const body = error.doc ?? (isRecord(error.response) ? error.response.text : undefined);
  return body === undefined || body === null ? "" : String(body).trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
