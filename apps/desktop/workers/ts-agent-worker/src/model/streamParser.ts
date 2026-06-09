import type { ModelResponse, ToolCallRequest, TokenUsage } from "./provider.ts";

export type ToolCallDelta = {
  index: number;
  deltaText: string;
  toolCallId?: string;
  toolName?: string;
};

export type StreamCallbacks = {
  onContentDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
  onToolCallDelta?: (delta: ToolCallDelta) => void;
};

type ToolCallBuffer = {
  id?: string;
  name?: string;
  argumentsJson: string;
};

type JsonObject = Record<string, unknown>;

export type StreamModelResponse = ModelResponse & {
  reasoningContent?: string;
};

export async function collectChatCompletionStream(
  stream: AsyncIterable<unknown>,
  callbacks: StreamCallbacks = {},
): Promise<StreamModelResponse> {
  const contentParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCallBuffers = new Map<number, ToolCallBuffer>();
  let stopReason = "stop";
  let usage: TokenUsage | undefined;

  for await (const chunk of stream) {
    const chunkObject = asObject(chunk);
    if (!chunkObject) {
      continue;
    }
    usage = extractUsage(chunkObject) ?? usage;

    const choices = Array.isArray(chunkObject.choices) ? chunkObject.choices : [];
    for (const choice of choices) {
      const choiceObject = asObject(choice);
      if (!choiceObject) {
        continue;
      }
      if (typeof choiceObject.finish_reason === "string") {
        stopReason = choiceObject.finish_reason;
      }
      const delta = asObject(choiceObject.delta);
      if (!delta) {
        continue;
      }

      const content = textContent(delta.content);
      if (content) {
        contentParts.push(content);
        callbacks.onContentDelta?.(content);
      }

      const reasoning = textContent(delta.reasoning_content);
      if (reasoning) {
        reasoningParts.push(reasoning);
        callbacks.onReasoningDelta?.(reasoning);
      }

      const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const toolCall of toolCalls) {
        collectToolCallDelta(toolCall, toolCallBuffers, callbacks);
      }
    }
  }

  return {
    content: contentParts.join(""),
    reasoningContent: reasoningParts.join("") || undefined,
    toolCalls: Array.from(toolCallBuffers.entries())
      .sort(([left], [right]) => left - right)
      .map(([, buffer], index) => ({
        id: buffer.id ?? `call-${index}`,
        name: buffer.name ?? "",
        argumentsJson: buffer.argumentsJson,
      })),
    usage,
    stopReason,
  };
}

function collectToolCallDelta(
  rawToolCall: unknown,
  buffers: Map<number, ToolCallBuffer>,
  callbacks: StreamCallbacks,
): void {
  const toolCall = asObject(rawToolCall);
  if (!toolCall) {
    return;
  }
  const index = typeof toolCall.index === "number" ? toolCall.index : 0;
  const buffer = buffers.get(index) ?? { argumentsJson: "" };
  const fn = asObject(toolCall.function);
  const id = typeof toolCall.id === "string" ? toolCall.id : undefined;
  const name = typeof fn?.name === "string" ? fn.name : undefined;
  const deltaText = typeof fn?.arguments === "string" ? fn.arguments : "";

  if (id) {
    buffer.id = id;
  }
  if (name) {
    buffer.name = name;
  }
  buffer.argumentsJson += deltaText;
  buffers.set(index, buffer);

  if (deltaText || id || name) {
    callbacks.onToolCallDelta?.({
      index,
      deltaText,
      toolCallId: id,
      toolName: name,
    });
  }
}

function asObject(value: unknown): JsonObject | null {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as JsonObject;
  }
  const dump = typeof value === "object" && value !== null ? (value as { model_dump?: unknown }).model_dump : undefined;
  if (typeof dump === "function") {
    const dumped = dump.call(value);
    if (typeof dumped === "object" && dumped !== null && !Array.isArray(dumped)) {
      return dumped as JsonObject;
    }
  }
  return null;
}

function textContent(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const parts = value.flatMap((entry) => {
    if (typeof entry === "string") {
      return [entry];
    }
    const object = asObject(entry);
    const text = object?.text;
    return typeof text === "string" ? [text] : [];
  });
  return parts.join("") || null;
}

function extractUsage(chunk: JsonObject): TokenUsage | undefined {
  const usage = asObject(chunk.usage);
  if (!usage) {
    return undefined;
  }
  return {
    inputTokens: numberValue(usage.prompt_tokens),
    outputTokens: numberValue(usage.completion_tokens),
    totalTokens: numberValue(usage.total_tokens),
  };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
