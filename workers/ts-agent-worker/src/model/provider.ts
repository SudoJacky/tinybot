import type { AgentMessage } from "../agent/agentRunSpec.ts";
import type { ToolCallDelta } from "./streamParser.ts";

export type ToolCallRequest = {
  id: string;
  name: string;
  argumentsJson: string;
};

export type TokenUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
};

export type ModelResponse = {
  content: string;
  reasoningContent?: string;
  thinkingBlocks?: Array<Record<string, unknown>>;
  toolCalls: ToolCallRequest[];
  usage?: TokenUsage;
  stopReason?: string;
  delayMs?: number;
};

export type ModelStreamCallbacks = {
  onContentDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
  onToolCallDelta?: (delta: ToolCallDelta) => void;
  streamIdleTimeoutMs?: number;
};

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type GenerationRequestOptions = {
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: string;
};

export type ModelRequestOptions = ModelStreamCallbacks & {
  model?: string;
  tools?: ToolDefinition[];
  toolChoice?: "auto" | "required" | Record<string, unknown>;
  retryMode?: "standard" | "persistent";
  extraBody?: Record<string, unknown>;
  onRetryWait?: (event: { attempt: number; delaySeconds: number; message: string }) => void;
} & GenerationRequestOptions;

export interface ModelProvider {
  complete(messages: AgentMessage[], options?: ModelRequestOptions): Promise<ModelResponse>;
}
