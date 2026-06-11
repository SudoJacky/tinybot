import type { ModelResponse, ToolCallRequest, TokenUsage } from "./provider.ts";

const MAX_TOOL_CALL_DELTA_TEXT = 8192;

export type ToolCallDelta = {
  index: number;
  toolCallIndex?: number;
  providerCallId?: string;
  sequence?: number;
  deltaText: string;
  toolCallId?: string;
  toolName?: string;
  phase?: "arguments" | "terminal";
  status?: "streaming" | "completed" | "error";
  completed?: boolean;
};

export type StreamCallbacks = {
  onContentDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
  onToolCallDelta?: (delta: ToolCallDelta) => void;
  streamIdleTimeoutMs?: number;
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
  let emittedTerminalToolCalls = false;
  let sequence = 0;
  let lastProviderCallId: string | undefined;

  try {
    const iterator = stream[Symbol.asyncIterator]();
    while (true) {
      const next = await nextStreamChunk(iterator, callbacks.streamIdleTimeoutMs);
      if (next.done) {
        break;
      }
      const chunk = next.value;
      const chunkObject = asObject(chunk);
      if (!chunkObject) {
        continue;
      }
      usage = extractUsage(chunkObject) ?? usage;
      const providerCallId = typeof chunkObject.id === "string" ? chunkObject.id : undefined;
      lastProviderCallId = providerCallId ?? lastProviderCallId;

      const choices = Array.isArray(chunkObject.choices) ? chunkObject.choices : [];
      for (const choice of choices) {
        const choiceObject = asObject(choice);
        if (!choiceObject) {
          continue;
        }
        const finishReason = typeof choiceObject.finish_reason === "string" ? choiceObject.finish_reason : undefined;
        if (finishReason) {
          stopReason = finishReason;
        }
        const delta = asObject(choiceObject.delta);
        if (delta) {
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
            sequence = collectToolCallDelta(toolCall, toolCallBuffers, callbacks, sequence, providerCallId);
          }
        }
        if (finishReason && !emittedTerminalToolCalls) {
          sequence = emitTerminalToolCallDeltas(
            toolCallBuffers,
            callbacks,
            finishReason === "error" ? "error" : "completed",
            sequence,
            providerCallId,
          );
          emittedTerminalToolCalls = true;
        }
      }
    }
  } catch (error) {
    if (!emittedTerminalToolCalls) {
      emitTerminalToolCallDeltas(toolCallBuffers, callbacks, "error", sequence, lastProviderCallId);
    }
    return {
      content: streamErrorContent(error),
      toolCalls: [],
      stopReason: "error",
    };
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
  sequence: number,
  providerCallId?: string,
): number {
  const toolCall = asObject(rawToolCall);
  if (!toolCall) {
    return sequence;
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
    const parts = splitToolCallDeltaText(deltaText);
    sequence += 1;
    callbacks.onToolCallDelta?.({
      index,
      toolCallIndex: index,
      providerCallId,
      sequence,
      deltaText: parts[0] ?? "",
      toolCallId: buffer.id,
      toolName: buffer.name,
      phase: "arguments",
      status: "streaming",
      completed: false,
    });
    for (const part of parts.slice(1)) {
      sequence += 1;
      callbacks.onToolCallDelta?.({
        index,
        toolCallIndex: index,
        providerCallId,
        sequence,
        deltaText: part,
        toolCallId: buffer.id,
        toolName: buffer.name,
        phase: "arguments",
        status: "streaming",
        completed: false,
      });
    }
  }
  return sequence;
}

function splitToolCallDeltaText(deltaText: string): string[] {
  if (deltaText.length === 0) {
    return [""];
  }
  const parts: string[] = [];
  for (let start = 0; start < deltaText.length; start += MAX_TOOL_CALL_DELTA_TEXT) {
    parts.push(deltaText.slice(start, start + MAX_TOOL_CALL_DELTA_TEXT));
  }
  return parts;
}

function emitTerminalToolCallDeltas(
  buffers: Map<number, ToolCallBuffer>,
  callbacks: StreamCallbacks,
  status: "completed" | "error",
  sequence: number,
  providerCallId?: string,
): number {
  for (const [index, buffer] of Array.from(buffers.entries()).sort(([left], [right]) => left - right)) {
    sequence += 1;
    callbacks.onToolCallDelta?.({
      index,
      toolCallIndex: index,
      providerCallId,
      sequence,
      deltaText: "",
      toolCallId: buffer.id,
      toolName: buffer.name,
      phase: "terminal",
      status,
      completed: status === "completed",
    });
  }
  return sequence;
}

function streamErrorContent(error: unknown): string {
  if (error instanceof StreamIdleTimeoutError) {
    return `Error calling LLM: stream stalled for more than ${error.timeoutMs} ms`;
  }
  if (error instanceof Error) {
    return `Error calling LLM: ${error.message}`;
  }
  return `Error calling LLM: ${String(error)}`;
}

class StreamIdleTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`stream stalled for more than ${timeoutMs} ms`);
    this.timeoutMs = timeoutMs;
  }
}

async function nextStreamChunk(
  iterator: AsyncIterator<unknown>,
  idleTimeoutMs: number | undefined,
): Promise<IteratorResult<unknown>> {
  if (!idleTimeoutMs || idleTimeoutMs <= 0) {
    return iterator.next();
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<IteratorResult<unknown>>((_, reject) => {
        timeout = setTimeout(() => reject(new StreamIdleTimeoutError(idleTimeoutMs)), idleTimeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
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
    cachedTokens: cachedTokenValue(usage),
  };
}

function cachedTokenValue(usage: JsonObject): number | undefined {
  const promptTokenDetails = asObject(usage.prompt_tokens_details);
  return (
    numberValue(promptTokenDetails?.cached_tokens) ??
    numberValue(usage.cached_tokens) ??
    numberValue(usage.prompt_cache_hit_tokens)
  );
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
