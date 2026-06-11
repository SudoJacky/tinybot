import type { ToolCallRequest, ToolDefinition, TokenUsage } from "../model/provider.ts";
import type { ContextBuildMetadata, ContextBridgeMetadata } from "./contextTypes.ts";

export type AgentMessageRole = "system" | "user" | "assistant" | "tool";

export type AgentMessage = {
  role: AgentMessageRole;
  content: string;
  reasoningContent?: string;
  thinkingBlocks?: Array<Record<string, unknown>>;
  toolCalls?: ToolCallRequest[];
  toolCallId?: string;
  name?: string;
  metadata?: Record<string, unknown>;
};

export type AgentStopReason =
  | "final_response"
  | "max_iterations"
  | "error"
  | "tool_error"
  | "empty_final_response"
  | "cancelled"
  | "awaiting_user_input"
  | "awaiting_approval"
  | "awaiting_form";

export type AgentRunSpec = {
  runId: string;
  traceId?: string;
  sessionId?: string;
  messages: AgentMessage[];
  tools?: ToolDefinition[];
  model: string;
  maxIterations: number;
  stream: boolean;
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: string;
  contextWindow?: number;
  toolResultBudget?: number;
  failOnToolError?: boolean;
  metadata?: Record<string, unknown>;
};

export type AgentRunResult = {
  finalContent: string;
  messages: AgentMessage[];
  toolsUsed: string[];
  usage?: TokenUsage;
  stopReason: AgentStopReason;
  error?: string;
  awaitingInput?: Record<string, unknown>;
  contextMetadata?: ContextBuildMetadata & { bridge?: ContextBridgeMetadata };
};
