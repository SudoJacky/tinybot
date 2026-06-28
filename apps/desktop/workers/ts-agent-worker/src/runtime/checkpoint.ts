import type { AgentMessage, AgentRunSpec } from "../agent/agentRunSpec.ts";
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

export type ApprovalOperation = {
  runId: string;
  toolName: string;
  arguments: Record<string, unknown>;
};

export type ApprovedToolResultProjection = {
  sessionId: string;
  approvalId: string;
  content: string;
  metadata?: Record<string, unknown>;
};

export type ApprovalProjection = {
  sessionId: string;
  approvalId: string;
};

export type FormProjection = {
  sessionId: string;
  formId: string;
  action: "submitted" | "cancelled";
  values: Record<string, unknown>;
  correlation?: Record<string, unknown>;
};

export type DelegatedApprovalProjection = {
  approvalId: string;
  childCheckpoint: Record<string, unknown>;
  delegateId?: string;
  childRunId?: string;
  childToolCallId?: string;
  toolName?: string;
};

export function approvalOperationFromCheckpoint(
  checkpoint: Record<string, unknown>,
  approvalId: string,
): ApprovalOperation {
  const messages = parseCheckpointMessages(checkpoint.messages);
  const approvalToolIndex = findApprovalToolMessageIndex(messages, approvalId);
  if (approvalToolIndex < 0) {
    throw new Error("approval checkpoint does not contain a matching awaiting approval tool result");
  }
  const operation = parseApprovedOperation(messages[approvalToolIndex].metadata);
  return {
    runId: checkpointRunId(checkpoint),
    ...operation,
  };
}

export function resumedSpecFromApprovedToolResult(
  checkpoint: Record<string, unknown>,
  projection: ApprovedToolResultProjection,
): AgentRunSpec {
  const messages = parseCheckpointMessages(checkpoint.messages);
  const approvalToolIndex = findApprovalToolMessageIndex(messages, projection.approvalId);
  if (approvalToolIndex < 0) {
    throw new Error("approval checkpoint does not contain a matching awaiting approval tool result");
  }
  const approvalToolMessage = messages[approvalToolIndex];
  const replacement: AgentMessage = {
    role: "tool",
    content: projection.content,
    toolCallId: approvalToolMessage.toolCallId,
    name: approvalToolMessage.name,
    ...(projection.metadata ? { metadata: projection.metadata } : {}),
  };
  return resumedSpecFromCheckpoint(
    checkpoint,
    projection.sessionId,
    messages.map((message, index) => (index === approvalToolIndex ? replacement : message)),
  );
}

export function resumedSpecFromDeniedApproval(
  checkpoint: Record<string, unknown>,
  projection: ApprovalProjection,
): AgentRunSpec {
  const messages = parseCheckpointMessages(checkpoint.messages);
  const approvalToolIndex = findApprovalToolMessageIndex(messages, projection.approvalId);
  if (approvalToolIndex < 0) {
    throw new Error("approval checkpoint does not contain a matching awaiting approval tool result");
  }
  const approvalToolMessage = messages[approvalToolIndex];
  const denialMessage: AgentMessage = {
    role: "tool",
    content: `Approval denied: ${projection.approvalId}`,
    toolCallId: approvalToolMessage.toolCallId,
    name: approvalToolMessage.name,
    metadata: {
      approvalId: projection.approvalId,
      approved: false,
      status: "denied",
    },
  };
  return resumedSpecFromCheckpoint(
    checkpoint,
    projection.sessionId,
    messages.map((message, index) => (index === approvalToolIndex ? denialMessage : message)),
  );
}

export function resumedSpecFromSubmittedForm(
  checkpoint: Record<string, unknown>,
  projection: FormProjection,
): AgentRunSpec {
  const messages = parseCheckpointMessages(checkpoint.messages);
  const formToolIndex = findFormToolMessageIndex(messages, projection.formId);
  if (formToolIndex < 0) {
    throw new Error("form checkpoint does not contain a matching awaiting form tool result");
  }
  const formToolMessage = messages[formToolIndex];
  assertFormCorrelationMatches(formToolMessage.metadata, projection.correlation);
  const formResultMessage: AgentMessage = {
    role: "tool",
    content: formatFormSubmissionContent(projection),
    toolCallId: formToolMessage.toolCallId,
    name: formToolMessage.name,
    metadata: {
      formId: projection.formId,
      action: projection.action,
      values: projection.values,
    },
  };
  return resumedSpecFromCheckpoint(
    checkpoint,
    projection.sessionId,
    messages.map((message, index) => (index === formToolIndex ? formResultMessage : message)),
  );
}

export function canResumeApprovalCheckpoint(checkpoint: Record<string, unknown>, approvalId: string): boolean {
  if (!Array.isArray(checkpoint.messages)) {
    return false;
  }
  try {
    return findApprovalToolMessageIndex(parseCheckpointMessages(checkpoint.messages), approvalId) >= 0;
  } catch {
    return false;
  }
}

export function delegatedApprovalFromCheckpoint(
  checkpoint: Record<string, unknown>,
  approvalId: string,
): DelegatedApprovalProjection | null {
  if (!Array.isArray(checkpoint.messages)) {
    return null;
  }
  const messages = parseCheckpointMessages(checkpoint.messages);
  const approvalToolIndex = findApprovalToolMessageIndex(messages, approvalId);
  if (approvalToolIndex < 0) {
    return null;
  }
  const metadata = messages[approvalToolIndex].metadata;
  const childCheckpoint = metadataValue(metadata, "_delegate_child_checkpoint");
  if (!childCheckpoint) {
    return null;
  }
  return {
    approvalId,
    childCheckpoint,
    delegateId: stringMetadata(metadata, "_delegate_id"),
    childRunId: stringMetadata(metadata, "_delegate_child_run_id"),
    childToolCallId: stringMetadata(metadata, "_delegate_child_tool_call_id"),
    toolName: stringMetadata(metadata, "_delegate_child_tool_name"),
  };
}

function resumedSpecFromCheckpoint(
  checkpoint: Record<string, unknown>,
  sessionId: string,
  messages: AgentMessage[],
): AgentRunSpec {
  return {
    runId: checkpointRunId(checkpoint),
    sessionId,
    messages,
    model: checkpointString(checkpoint.model, "checkpoint.model"),
    maxIterations: numberParam(checkpoint, "maxIterations", "max_iterations") ?? 2,
    stream: booleanParam(checkpoint, "stream", "stream") ?? false,
    temperature: numberParam(checkpoint, "temperature", "temperature"),
    maxTokens: numberParam(checkpoint, "maxTokens", "max_tokens"),
    reasoningEffort: stringParam(checkpoint, "reasoningEffort", "reasoning_effort"),
    contextWindow: numberParam(checkpoint, "contextWindow", "context_window"),
    toolResultBudget: numberParam(checkpoint, "toolResultBudget", "tool_result_budget"),
    failOnToolError: booleanParam(checkpoint, "failOnToolError", "fail_on_tool_error"),
  };
}

function parseCheckpointMessages(value: unknown): AgentMessage[] {
  if (!Array.isArray(value)) {
    throw new Error("approval checkpoint requires messages");
  }
  return value.map(parseAgentMessage);
}

function parseAgentMessage(value: unknown): AgentMessage {
  if (!isJsonObject(value) || !isAgentRole(value.role)) {
    throw new Error("checkpoint message role is invalid");
  }
  if (typeof value.content !== "string") {
    throw new Error("checkpoint message content must be a string");
  }
  return {
    role: value.role,
    content: value.content,
    reasoningContent: typeof value.reasoningContent === "string"
      ? value.reasoningContent
      : typeof value.reasoning_content === "string"
        ? value.reasoning_content
        : undefined,
    thinkingBlocks: Array.isArray(value.thinkingBlocks)
      ? value.thinkingBlocks.filter(isJsonObject)
      : Array.isArray(value.thinking_blocks)
        ? value.thinking_blocks.filter(isJsonObject)
        : undefined,
    toolCallId: typeof value.toolCallId === "string"
      ? value.toolCallId
      : typeof value.tool_call_id === "string"
        ? value.tool_call_id
        : undefined,
    name: typeof value.name === "string" ? value.name : undefined,
    toolCalls: Array.isArray(value.toolCalls)
      ? value.toolCalls.map(parseToolCallRequest)
      : Array.isArray(value.tool_calls)
        ? value.tool_calls.map(parseToolCallRequest)
        : undefined,
    metadata: isJsonObject(value.metadata) ? value.metadata : undefined,
  };
}

function parseToolCallRequest(value: unknown): { id: string; name: string; argumentsJson: string } {
  if (!isJsonObject(value) || typeof value.id !== "string") {
    throw new Error("checkpoint tool call is invalid");
  }
  const functionPayload = isJsonObject(value.function) ? value.function : {};
  const name = typeof value.name === "string"
    ? value.name
    : typeof functionPayload.name === "string"
      ? functionPayload.name
      : undefined;
  const argumentsJson = typeof value.argumentsJson === "string"
    ? value.argumentsJson
    : typeof value.arguments_json === "string"
      ? value.arguments_json
      : typeof functionPayload.arguments === "string"
        ? functionPayload.arguments
        : undefined;
  if (!name || argumentsJson === undefined) {
    throw new Error("checkpoint tool call is invalid");
  }
  return {
    id: value.id,
    name,
    argumentsJson,
  };
}

function isAgentRole(value: unknown): value is AgentMessage["role"] {
  return value === "system" || value === "user" || value === "assistant" || value === "tool";
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findApprovalToolMessageIndex(messages: AgentMessage[], approvalId: string): number {
  return messages.findIndex((message) => (
    message.role === "tool" &&
    message.metadata?.awaitingUserInput === true &&
    message.metadata?.stopReason === "awaiting_approval" &&
    message.metadata?.approvalId === approvalId
  ));
}

function findFormToolMessageIndex(messages: AgentMessage[], formId: string): number {
  return messages.findIndex((message) => (
    message.role === "tool" &&
    message.metadata?.awaitingUserInput === true &&
    message.metadata?.stopReason === "awaiting_form" &&
    message.metadata?.formId === formId
  ));
}

function formatFormSubmissionContent(submission: FormProjection): string {
  const formTitle = submission.formId;
  if (submission.action === "cancelled") {
    return `Agent UI form \`${submission.formId}\` was cancelled by the user for ${formTitle}.`;
  }
  return `Agent UI form \`${submission.formId}\` was submitted for ${formTitle}.\n\nStructured values:\n\`\`\`json\n${formatPythonJsonValue(submission.values)}\n\`\`\``;
}

function assertFormCorrelationMatches(
  metadata: Record<string, unknown> | undefined,
  suppliedCorrelation: Record<string, unknown> | undefined,
): void {
  if (!metadata || !suppliedCorrelation) {
    return;
  }
  const expectedCorrelation = isJsonObject(metadata.correlation) ? metadata.correlation : metadata;
  for (const key of ["session_key", "chat_id", "run_id", "message_id", "interaction_id"]) {
    const expected = stringCorrelationValue(expectedCorrelation[key]);
    const supplied = stringCorrelationValue(suppliedCorrelation[key]);
    if (expected && supplied && expected !== supplied) {
      throw new Error("form correlation mismatch");
    }
  }
}

function stringCorrelationValue(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const normalized = String(value);
  return normalized.length > 0 ? normalized : undefined;
}

function formatPythonJsonValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => item === undefined ? "null" : formatPythonJsonValue(item)).join(", ")}]`;
  }
  if (isJsonObject(value)) {
    return formatPythonJsonObject(value);
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "null";
  }
  return "null";
}

function formatPythonJsonObject(value: Record<string, unknown>): string {
  const entries = Object.entries(value)
    .filter(([, entryValue]) => (
      entryValue !== undefined &&
      typeof entryValue !== "function" &&
      typeof entryValue !== "symbol"
    ))
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}: ${formatPythonJsonValue(entryValue)}`)
    .join(", ")}}`;
}

function parseApprovedOperation(metadata: Record<string, unknown> | undefined): { toolName: string; arguments: Record<string, unknown> } {
  const operation = isJsonObject(metadata?.operation) ? metadata.operation : undefined;
  if (!operation || typeof operation.toolName !== "string" || !isJsonObject(operation.arguments)) {
    throw new Error("approval checkpoint does not contain an executable operation");
  }
  return {
    toolName: operation.toolName,
    arguments: operation.arguments,
  };
}

function checkpointRunId(checkpoint: Record<string, unknown>): string {
  return checkpointString(checkpoint.runId ?? checkpoint.run_id, "checkpoint.runId");
}

function metadataValue(metadata: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const value = metadata?.[key];
  return isJsonObject(value) ? value : undefined;
}

function stringMetadata(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function checkpointString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`approval checkpoint requires ${field}`);
  }
  return value;
}

function stringParam(params: Record<string, unknown>, camelKey: string, snakeKey: string): string | undefined {
  const value = params[camelKey] ?? params[snakeKey];
  return typeof value === "string" ? value : undefined;
}

function numberParam(params: Record<string, unknown>, camelKey: string, snakeKey: string): number | undefined {
  const value = params[camelKey] ?? params[snakeKey];
  return typeof value === "number" ? value : undefined;
}

function booleanParam(params: Record<string, unknown>, camelKey: string, snakeKey: string): boolean | undefined {
  const value = params[camelKey] ?? params[snakeKey];
  return typeof value === "boolean" ? value : undefined;
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
