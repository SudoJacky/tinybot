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
} & GenerationRequestOptions;

export interface ModelProvider {
  complete(messages: AgentMessage[], options?: ModelRequestOptions): Promise<ModelResponse>;
}
