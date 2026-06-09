import type { ToolCallRequest, TokenUsage } from "../model/provider.ts";

export type AgentMessageRole = "system" | "user" | "assistant" | "tool";

export type AgentMessage = {
  role: AgentMessageRole;
  content: string;
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
  model: string;
  maxIterations: number;
  stream: boolean;
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
};
