import type { AgentMessage } from "../agent/agentRunSpec.ts";

const MODEL_ENCODING_HINTS: Array<[string, string]> = [
  ["gpt-4.1", "o200k_base"],
  ["gpt-4o", "o200k_base"],
  ["gpt-5", "o200k_base"],
  ["o1", "o200k_base"],
  ["o3", "o200k_base"],
  ["o4", "o200k_base"],
  ["claude", "cl100k_base"],
  ["deepseek", "cl100k_base"],
  ["gemini", "cl100k_base"],
  ["glm", "cl100k_base"],
  ["qwen", "cl100k_base"],
  ["moonshot", "cl100k_base"],
  ["mistral", "cl100k_base"],
  ["minimax", "cl100k_base"],
];

const REASONING_MODEL_HINTS = [
  "reasoner",
  "reasoning",
  "deepseek-r1",
  "thinking",
  "flash-thinking",
  "o1",
  "o3",
  "o4",
];

const REASONING_RISK_MULTIPLIER = 1.12;

export type TokenEstimate = {
  tokens: number;
  source: string;
  estimated: boolean;
  encodingName?: string;
};

export type PromptTokenCounter = (
  messages: Array<Record<string, unknown>>,
  tools?: Array<Record<string, unknown>>,
  model?: string,
) => number | [number, string] | { tokens: number; source?: string; estimated?: boolean };

export function resolveEncodingName(model: string | undefined | null): string {
  const normalized = normalizeModelName(model);
  for (const [hint, encodingName] of MODEL_ENCODING_HINTS) {
    if (normalized.includes(hint)) {
      return encodingName;
    }
  }
  return "cl100k_base";
}

export function isReasoningModel(model: string | undefined | null): boolean {
  const normalized = normalizeModelName(model);
  return normalized.length > 0 && REASONING_MODEL_HINTS.some((hint) => normalized.includes(hint));
}

export function applyReasoningRiskBuffer(tokens: number, model: string | undefined | null): number {
  if (tokens <= 0) {
    return 0;
  }
  if (!isReasoningModel(model)) {
    return tokens;
  }
  return Math.max(tokens, Math.ceil(tokens * REASONING_RISK_MULTIPLIER));
}

export function estimateMessageTokens(message: AgentMessage | Record<string, unknown>, model?: string): number {
  const payload = iterMessageParts(message).join("\n");
  if (payload.length === 0) {
    return 4;
  }
  return Math.max(4, estimatePayloadTokens(payload, model) + 4);
}

export function estimateMessages(messages: AgentMessage[], model?: string): number {
  return messages.reduce((total, message) => total + estimateMessage(message, model), 0);
}

export function estimateMessage(message: AgentMessage, _model?: string): number {
  const parts = [
    message.role,
    message.content,
    message.reasoningContent,
    message.thinkingBlocks ? JSON.stringify(message.thinkingBlocks) : "",
    message.toolCallId,
    message.name,
    message.toolCalls ? JSON.stringify(message.toolCalls) : "",
  ];
  return parts.reduce((total, part) => total + (part?.length ?? 0), 4);
}

export function estimatePromptTokens(
  messages: Array<AgentMessage | Record<string, unknown>>,
  options: {
    tools?: Array<Record<string, unknown>>;
    model?: string;
    calibrationFactor?: number;
  } = {},
): TokenEstimate {
  const parts: string[] = [];
  for (const message of messages) {
    parts.push(...iterMessageParts(message));
  }
  if (options.tools && options.tools.length > 0) {
    parts.push(JSON.stringify(options.tools));
  }
  const perMessageOverhead = messages.length * 4;
  const raw = estimatePayloadTokens(parts.join("\n"), options.model) + perMessageOverhead;
  const tokens = applyCalibration(raw, options.calibrationFactor ?? 1.0);
  return {
    tokens,
    source: tokens > 0 ? "heuristic" : "none",
    estimated: true,
    encodingName: resolveEncodingName(options.model),
  };
}

export function estimatePromptTokensChain(input: {
  provider?: { estimatePromptTokens?: PromptTokenCounter };
  model?: string;
  messages: Array<AgentMessage | Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
}): TokenEstimate {
  const providerCounter = input.provider?.estimatePromptTokens;
  if (providerCounter) {
    try {
      const providerResult = providerCounter(
        input.messages as Array<Record<string, unknown>>,
        input.tools,
        input.model,
      );
      const normalized = normalizeProviderResult(providerResult);
      if (normalized.tokens > 0) {
        return withReasoningBuffer(normalized, input.model, false);
      }
    } catch {
      // Fall through to the deterministic heuristic below.
    }
  }

  const estimate = estimatePromptTokens(input.messages, { tools: input.tools, model: input.model });
  if (estimate.tokens <= 0) {
    return { tokens: 0, source: "none", estimated: true };
  }
  return withReasoningBuffer(estimate, input.model, true);
}

function withReasoningBuffer(estimate: TokenEstimate, model: string | undefined, estimated: boolean): TokenEstimate {
  const adjusted = applyReasoningRiskBuffer(estimate.tokens, model);
  const suffix = adjusted !== estimate.tokens ? "+reasoning_buffer" : "";
  return {
    tokens: adjusted,
    source: `${estimate.source || "provider_counter"}${suffix}`,
    estimated,
    ...(estimate.encodingName ? { encodingName: estimate.encodingName } : {}),
  };
}

function normalizeProviderResult(value: ReturnType<PromptTokenCounter>): TokenEstimate {
  if (typeof value === "number") {
    return { tokens: value, source: "provider_counter", estimated: false };
  }
  if (Array.isArray(value)) {
    return { tokens: Number(value[0] ?? 0), source: String(value[1] || "provider_counter"), estimated: false };
  }
  return {
    tokens: Number(value.tokens ?? 0),
    source: value.source ?? "provider_counter",
    estimated: value.estimated ?? false,
  };
}

function iterMessageParts(message: AgentMessage | Record<string, unknown>): string[] {
  const record = message as Record<string, unknown>;
  const parts: string[] = [];
  appendContent(parts, record.content);
  appendString(parts, typeof record.name === "string" ? record.name : undefined);
  appendString(parts, stringField(record, "toolCallId") ?? stringField(record, "tool_call_id"));
  const toolCalls = record.toolCalls ?? record.tool_calls;
  if (toolCalls !== undefined) {
    parts.push(JSON.stringify(toolCalls));
  }
  appendString(parts, stringField(record, "reasoningContent") ?? stringField(record, "reasoning_content"));
  return parts;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function appendContent(parts: string[], content: unknown): void {
  if (typeof content === "string") {
    appendString(parts, content);
    return;
  }
  if (Array.isArray(content)) {
    for (const item of content) {
      if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
        appendString(parts, item.text);
      } else {
        parts.push(JSON.stringify(item));
      }
    }
    return;
  }
  if (content !== undefined && content !== null) {
    parts.push(JSON.stringify(content));
  }
}

function appendString(parts: string[], value: unknown): void {
  if (typeof value === "string" && value.length > 0) {
    parts.push(value);
  }
}

function estimatePayloadTokens(payload: string, model: string | undefined): number {
  if (payload.length === 0) {
    return 0;
  }
  const divisor = resolveEncodingName(model) === "o200k_base" ? 4.2 : 4;
  return Math.max(1, Math.ceil(payload.length / divisor));
}

function applyCalibration(tokens: number, calibrationFactor: number): number {
  if (tokens <= 0) {
    return 0;
  }
  const factor = calibrationFactor > 0 ? calibrationFactor : 1.0;
  return Math.max(1, Math.ceil(tokens * factor));
}

function normalizeModelName(model: string | undefined | null): string {
  return String(model ?? "").trim().toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
