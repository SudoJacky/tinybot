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
};

export type ModelResponse = {
  content: string;
  toolCalls: ToolCallRequest[];
  usage?: TokenUsage;
  stopReason?: string;
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

export type ModelRequestOptions = ModelStreamCallbacks & {
  tools?: ToolDefinition[];
};

export interface ModelProvider {
  complete(messages: AgentMessage[], options?: ModelRequestOptions): Promise<ModelResponse>;
}
