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
      model: this.defaultModel,
      messages: messages.map(toOpenAIMessage),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (options.tools?.length) {
      request.tools = options.tools.map(toOpenAITool);
      request.tool_choice = "auto";
    }
    const stream = await this.client.chat.completions.create(request);
    return collectChatCompletionStream(stream, options);
  }
}

function toOpenAIMessage(message: AgentMessage): Record<string, unknown> {
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content,
      tool_calls: message.toolCalls.map((toolCall) => ({
        id: toolCall.id,
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
      content: message.content,
      tool_call_id: message.toolCallId,
      name: message.name,
    };
  }
  return {
    role: message.role,
    content: message.content,
  };
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
