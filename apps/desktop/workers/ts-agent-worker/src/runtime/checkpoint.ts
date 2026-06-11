import type { AgentRunSpec } from "../agent/agentRunSpec.ts";
import type { AgentRunnerCheckpoint } from "../agent/agentRunner.ts";

export type SessionCheckpoint = {
  version: 1;
  runId: string;
  run_id: string;
  phase: AgentRunnerCheckpoint["phase"];
  iteration: number;
  model: string;
  maxIterations: number;
  max_iterations: number;
  stream: boolean;
  temperature?: number;
  maxTokens?: number;
  max_tokens?: number;
  reasoningEffort?: string;
  reasoning_effort?: string;
  contextWindow?: number;
  context_window?: number;
  toolResultBudget?: number;
  tool_result_budget?: number;
  failOnToolError?: boolean;
  fail_on_tool_error?: boolean;
  messages: AgentRunnerCheckpoint["messages"];
  assistantMessage: AgentRunnerCheckpoint["assistantMessage"];
  assistant_message: AgentRunnerCheckpoint["assistantMessage"];
  completedToolResults: AgentRunnerCheckpoint["completedToolResults"];
  completed_tool_results: AgentRunnerCheckpoint["completedToolResults"];
  pendingToolCalls: AgentRunnerCheckpoint["pendingToolCalls"];
  pending_tool_calls: AgentRunnerCheckpoint["pendingToolCalls"];
};

export function sessionCheckpointFromRunner(
  spec: AgentRunSpec,
  checkpoint: AgentRunnerCheckpoint,
): SessionCheckpoint {
  return {
    version: 1,
    runId: spec.runId,
    run_id: spec.runId,
    phase: checkpoint.phase,
    iteration: checkpoint.iteration,
    model: checkpoint.model,
    maxIterations: spec.maxIterations,
    max_iterations: spec.maxIterations,
    stream: spec.stream,
    ...optionalNumberAliases("temperature", "temperature", spec.temperature),
    ...optionalNumberAliases("maxTokens", "max_tokens", spec.maxTokens),
    ...optionalStringAliases("reasoningEffort", "reasoning_effort", spec.reasoningEffort),
    ...optionalNumberAliases("contextWindow", "context_window", spec.contextWindow),
    ...optionalNumberAliases("toolResultBudget", "tool_result_budget", spec.toolResultBudget),
    ...optionalBooleanAliases("failOnToolError", "fail_on_tool_error", spec.failOnToolError),
    messages: checkpoint.messages,
    assistantMessage: checkpoint.assistantMessage,
    assistant_message: checkpoint.assistantMessage,
    completedToolResults: checkpoint.completedToolResults,
    completed_tool_results: checkpoint.completedToolResults,
    pendingToolCalls: checkpoint.pendingToolCalls,
    pending_tool_calls: checkpoint.pendingToolCalls,
  };
}

function optionalNumberAliases<Camel extends string, Snake extends string>(
  camelKey: Camel,
  snakeKey: Snake,
  value: number | undefined,
): Partial<Record<Camel | Snake, number>> {
  return typeof value === "number" ? { [camelKey]: value, [snakeKey]: value } as Record<Camel | Snake, number> : {};
}

function optionalStringAliases<Camel extends string, Snake extends string>(
  camelKey: Camel,
  snakeKey: Snake,
  value: string | undefined,
): Partial<Record<Camel | Snake, string>> {
  return typeof value === "string" ? { [camelKey]: value, [snakeKey]: value } as Record<Camel | Snake, string> : {};
}

function optionalBooleanAliases<Camel extends string, Snake extends string>(
  camelKey: Camel,
  snakeKey: Snake,
  value: boolean | undefined,
): Partial<Record<Camel | Snake, boolean>> {
  return typeof value === "boolean" ? { [camelKey]: value, [snakeKey]: value } as Record<Camel | Snake, boolean> : {};
}
