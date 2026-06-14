import { createHash } from "node:crypto";

import type { AgentMessage } from "../agent/agentRunSpec.ts";
import type { RequestTraits } from "../providers/providerCatalog.ts";
import type { ModelRequestOptions, ToolDefinition } from "./provider.ts";

export type BuildOpenAIChatRequestInput = {
  defaultModel: string;
  messages: AgentMessage[];
  options: ModelRequestOptions;
  requestTraits?: Partial<RequestTraits>;
  extraBodyDefaults?: Record<string, unknown>;
  enableSearch?: boolean;
};

const DEFAULT_REQUEST_TRAITS: RequestTraits = {
  tokenParameter: "max_tokens",
  temperaturePolicy: "omit_for_reasoning",
  stripModelPrefix: false,
  extraBodyDefaults: {},
  supportsPromptCaching: false,
};

export function buildOpenAIChatRequest(input: BuildOpenAIChatRequestInput): Record<string, unknown> {
  const requestTraits = { ...DEFAULT_REQUEST_TRAITS, ...(input.requestTraits ?? {}) };
  const modelName = input.options.model?.trim() || input.defaultModel;
  let messages = toOpenAIMessages(input.messages);
  let tools = input.options.tools?.length ? input.options.tools.map(toOpenAITool) : undefined;
  if (requestTraits.supportsPromptCaching) {
    ({ messages, tools } = applyPromptCacheControl(messages, tools));
  }
  const request: Record<string, unknown> = {
    model: requestTraits.stripModelPrefix ? stripModelPrefix(modelName) : modelName,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (tools?.length) {
    request.tools = tools;
    request.tool_choice = input.options.toolChoice ?? "auto";
  }
  if (input.options.temperature !== undefined && supportsTemperature(String(request.model), input.options.reasoningEffort, requestTraits.temperaturePolicy)) {
    request.temperature = input.options.temperature;
  }
  if (input.options.maxTokens !== undefined) {
    request[requestTraits.tokenParameter] = Math.max(1, input.options.maxTokens);
  }
  if (input.options.reasoningEffort) {
    request.reasoning_effort = input.options.reasoningEffort;
  }
  const extraBody = {
    ...requestTraits.extraBodyDefaults,
    ...(input.extraBodyDefaults ?? {}),
    ...(input.enableSearch ? { enable_search: true } : {}),
    ...(input.options.extraBody ?? {}),
  };
  if (Object.keys(extraBody).length > 0) {
    request.extra_body = extraBody;
  }
  return request;
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

function applyPromptCacheControl(
  messages: Record<string, unknown>[],
  tools: Record<string, unknown>[] | undefined,
): { messages: Record<string, unknown>[]; tools: Record<string, unknown>[] | undefined } {
  const markedMessages = [...messages];
  if (markedMessages[0]?.role === "system") {
    markedMessages[0] = markMessageContent(markedMessages[0]);
  }
  if (markedMessages.length >= 3) {
    markedMessages[markedMessages.length - 2] = markMessageContent(markedMessages[markedMessages.length - 2]);
  }
  const markedTools = tools ? [...tools] : undefined;
  if (markedTools?.length) {
    markedTools[markedTools.length - 1] = {
      ...markedTools[markedTools.length - 1],
      cache_control: { type: "ephemeral" },
    };
  }
  return { messages: markedMessages, tools: markedTools };
}

function markMessageContent(message: Record<string, unknown>): Record<string, unknown> {
  const content = message.content;
  if (typeof content === "string") {
    return {
      ...message,
      content: [{ type: "text", text: content, cache_control: { type: "ephemeral" } }],
    };
  }
  if (Array.isArray(content) && content.length > 0) {
    const nextContent = [...content];
    const last = nextContent[nextContent.length - 1];
    if (last && typeof last === "object") {
      nextContent[nextContent.length - 1] = {
        ...(last as Record<string, unknown>),
        cache_control: { type: "ephemeral" },
      };
      return { ...message, content: nextContent };
    }
  }
  return message;
}

function supportsTemperature(model: string, reasoningEffort: string | undefined, policy: RequestTraits["temperaturePolicy"]): boolean {
  if (policy === "omit") {
    return false;
  }
  if (policy === "omit_for_reasoning" && reasoningEffort && reasoningEffort.toLowerCase() !== "none") {
    return false;
  }
  const modelName = model.toLowerCase();
  if (policy === "omit_for_reasoning") {
    return !["gpt-5", "o1", "o3", "o4"].some((token) => modelName.includes(token));
  }
  return true;
}

function stripModelPrefix(modelName: string): string {
  const parts = modelName.split("/");
  return parts.at(-1)?.trim() || modelName;
}
