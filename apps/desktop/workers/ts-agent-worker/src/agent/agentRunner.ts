import type { AgentMessage, AgentRunResult, AgentRunSpec } from "./agentRunSpec.ts";
import type { ModelProvider, ModelRequestOptions, TokenUsage, ToolCallRequest } from "../model/provider.ts";
import type { ToolRegistry } from "../tools/toolRegistry.ts";

const EMPTY_FINAL_RESPONSE_MESSAGE =
  "I completed the tool steps but couldn't produce a final answer. Please try again or narrow the task.";
const DEFAULT_MODEL_ERROR_MESSAGE = "Sorry, I encountered an error calling the AI model.";
const FINALIZATION_RETRY_PROMPT =
  "You have already finished the tool work. Do not call any more tools. Using only the conversation and tool results above, provide the final answer for the user now.";
const TOOL_ERROR_RECOVERY_HINT =
  "\n\n[Analyze the error above and try a different approach. Consider using `query_experience` to search for past solutions to similar problems.]";
const MAX_ITERATIONS_MESSAGE = (maxIterations: number): string =>
  `I reached the maximum number of tool call iterations (${maxIterations}) without completing the task. You can try breaking the task into smaller steps.`;

export type AgentRunnerOptions = {
  provider: ModelProvider;
  tools: ToolRegistry;
  emitEvent?: (event: AgentRunnerEvent) => void;
  checkpoint?: (checkpoint: AgentRunnerCheckpoint) => void;
  isCancelled?: () => boolean;
};

export type AgentRunnerEvent = {
  type:
    | "tool_start"
    | "tool_result"
    | "content_delta"
    | "reasoning_delta"
    | "tool_call_delta"
    | "memory_reference"
    | "task_progress";
  payload: Record<string, unknown>;
};

export type AgentRunnerCheckpoint = {
  phase: "awaiting_tools" | "tools_completed" | "final_response";
  iteration: number;
  model: string;
  messages: AgentMessage[];
  assistantMessage: AgentMessage;
  completedToolResults: AgentMessage[];
  pendingToolCalls: ToolCallRequest[];
};

export class AgentRunner {
  private readonly provider: ModelProvider;
  private readonly tools: ToolRegistry;
  private readonly emitEvent: (event: AgentRunnerEvent) => void;
  private readonly checkpoint: (checkpoint: AgentRunnerCheckpoint) => void;
  private readonly isCancelled: () => boolean;

  constructor(options: AgentRunnerOptions) {
    this.provider = options.provider;
    this.tools = options.tools;
    this.emitEvent = options.emitEvent ?? (() => undefined);
    this.checkpoint = options.checkpoint ?? (() => undefined);
    this.isCancelled = options.isCancelled ?? (() => false);
  }

  async run(spec: AgentRunSpec): Promise<AgentRunResult> {
    const messages = spec.messages.map(cloneMessage);
    const toolsUsed: string[] = [];
    let usage: TokenUsage | undefined;

    for (let iteration = 0; iteration < spec.maxIterations; iteration += 1) {
      applyToolResultBudget(spec, messages);
      const messagesForModel = snipHistory(spec, messages);
      const response = await this.provider.complete(messagesForModel.map(cloneMessage), this.requestOptions(spec));
      usage = mergeUsage(usage, response.usage);

      if (this.isCancelled()) {
        return cancelledResult(messages, toolsUsed, usage);
      }

      if (response.toolCalls.length > 0) {
        const assistantMessage: AgentMessage = {
          role: "assistant",
          content: response.content,
          toolCalls: response.toolCalls.map(cloneToolCall),
        };
        messages.push(assistantMessage);
        this.checkpoint({
          phase: "awaiting_tools",
          iteration,
          model: spec.model,
          messages: messages.map(cloneMessage),
          assistantMessage: cloneMessage(assistantMessage),
          completedToolResults: [],
          pendingToolCalls: response.toolCalls.map(cloneToolCall),
        });

        const completedToolResults: AgentMessage[] = [];
        for (const toolCall of response.toolCalls) {
          toolsUsed.push(toolCall.name);
          let args = parseToolArguments(toolCall);
          let result;
          if (!this.tools.has(toolCall.name)) {
            result = { content: `Error: Tool '${toolCall.name}' not found. Available: ${availableToolNames(this.tools)}` };
          } else {
            const prepared = prepareToolArguments(this.tools, toolCall.name, args);
            args = prepared.args;
            if (prepared.errors.length > 0) {
              result = {
                content: `Error: Invalid parameters for tool '${toolCall.name}': ${prepared.errors.join("; ")}`,
              };
            } else {
            this.emitEvent({
              type: "tool_start",
              payload: {
                runId: spec.runId,
                toolCallId: toolCall.id,
                toolName: toolCall.name,
              },
            });
            try {
              result = await this.tools.execute(toolCall.name, args, {
                runId: spec.runId,
                traceId: spec.traceId,
                sessionId: spec.sessionId,
              });
            } catch (error) {
              if (spec.failOnToolError) {
                const finalContent = `Error: ${errorName(error)}: ${errorMessage(error)}`;
                messages.push({ role: "assistant", content: finalContent });
                return {
                  finalContent,
                  messages,
                  toolsUsed,
                  usage,
                  stopReason: "tool_error",
                  error: finalContent,
                };
              }
              result = { content: `Error: ${errorName(error)}: ${errorMessage(error)}${TOOL_ERROR_RECOVERY_HINT}` };
            }
            }
          }
          if (result.content.startsWith("Error")) {
            if (spec.failOnToolError) {
              const finalContent = `Error: RuntimeError: ${result.content}`;
              messages.push({ role: "assistant", content: finalContent });
              return {
                finalContent,
                messages,
                toolsUsed,
                usage,
                stopReason: "tool_error",
                error: finalContent,
              };
            }
            if (!result.content.includes(TOOL_ERROR_RECOVERY_HINT)) {
              result = { ...result, content: `${result.content}${TOOL_ERROR_RECOVERY_HINT}` };
            }
          }
          if (this.isCancelled()) {
            return cancelledResult(messages, toolsUsed, usage);
          }
          this.emitEvent({
            type: "tool_result",
            payload: {
              runId: spec.runId,
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              content: result.content,
            },
          });
          const memoryReferences = memoryReferencesFromMetadata(result.metadata);
          if (memoryReferences) {
            this.emitEvent({
              type: "memory_reference",
              payload: {
                runId: spec.runId,
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                references: memoryReferences,
              },
            });
          }
          const taskProgress = taskProgressFromMetadata(result.metadata);
          if (taskProgress) {
            this.emitEvent({
              type: "task_progress",
              payload: {
                runId: spec.runId,
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                planId: taskProgress.planId,
                progress: taskProgress.progress,
              },
            });
          }
          const toolMessage: AgentMessage = {
            role: "tool",
            content: applyTextBudget(result.content, spec.toolResultBudget),
            toolCallId: toolCall.id,
            name: toolCall.name,
            metadata: result.metadata,
          };
          messages.push(toolMessage);
          completedToolResults.push(toolMessage);
        }
        this.checkpoint({
          phase: "tools_completed",
          iteration,
          model: spec.model,
          messages: messages.map(cloneMessage),
          assistantMessage: cloneMessage(assistantMessage),
          completedToolResults: completedToolResults.map(cloneMessage),
          pendingToolCalls: [],
        });
        const awaitingInput = completedToolResults
          .map((message) => awaitingInputFromMetadata(message.metadata))
          .find((input) => input !== undefined);
        if (awaitingInput) {
          return {
            finalContent: "",
            messages,
            toolsUsed,
            usage,
            stopReason: awaitingInput.stopReason,
            awaitingInput,
          };
        }
        continue;
      }

      let finalContent = response.content;
      if (response.stopReason === "error") {
        finalContent = isBlankText(finalContent) ? DEFAULT_MODEL_ERROR_MESSAGE : finalContent;
        messages.push({ role: "assistant", content: finalContent });
        return {
          finalContent,
          messages,
          toolsUsed,
          usage,
          stopReason: "error",
          error: finalContent,
        };
      }
      if (isBlankText(finalContent)) {
        const retryResponse = await this.provider.complete([
          ...messages.map(cloneMessage),
          { role: "user", content: FINALIZATION_RETRY_PROMPT },
        ]);
        usage = mergeUsage(usage, retryResponse.usage);
        finalContent = retryResponse.content;
      }

      if (isBlankText(finalContent)) {
        messages.push({ role: "assistant", content: EMPTY_FINAL_RESPONSE_MESSAGE });
        return {
          finalContent: EMPTY_FINAL_RESPONSE_MESSAGE,
          messages,
          toolsUsed,
          usage,
          stopReason: "empty_final_response",
          error: EMPTY_FINAL_RESPONSE_MESSAGE,
        };
      }

      const finalMessage: AgentMessage = { role: "assistant", content: finalContent };
      messages.push(finalMessage);
      this.checkpoint({
        phase: "final_response",
        iteration,
        model: spec.model,
        messages: messages.map(cloneMessage),
        assistantMessage: cloneMessage(finalMessage),
        completedToolResults: [],
        pendingToolCalls: [],
      });
      return {
        finalContent,
        messages,
        toolsUsed,
        usage,
        stopReason: "final_response",
      };
    }

    const finalContent = MAX_ITERATIONS_MESSAGE(spec.maxIterations);
    messages.push({ role: "assistant", content: finalContent });
    return {
      finalContent,
      messages,
      toolsUsed,
      usage,
      stopReason: "max_iterations",
    };
  }

  private requestOptions(spec: AgentRunSpec): ModelRequestOptions {
    return {
      tools: this.tools.definitions(),
      onContentDelta: (delta) => {
        if (!spec.stream) {
          return;
        }
        this.emitEvent({
          type: "content_delta",
          payload: { runId: spec.runId, delta },
        });
      },
      onReasoningDelta: (delta) => {
        if (!spec.stream) {
          return;
        }
        this.emitEvent({
          type: "reasoning_delta",
          payload: { runId: spec.runId, delta },
        });
      },
      onToolCallDelta: (delta) => {
        if (!spec.stream) {
          return;
        }
        this.emitEvent({
          type: "tool_call_delta",
          payload: { runId: spec.runId, ...delta },
        });
      },
    };
  }
}

function cancelledResult(messages: AgentMessage[], toolsUsed: string[], usage: TokenUsage | undefined): AgentRunResult {
  return {
    finalContent: "",
    messages,
    toolsUsed,
    usage,
    stopReason: "cancelled",
    error: "cancelled",
  };
}

function parseToolArguments(toolCall: ToolCallRequest): Record<string, unknown> {
  const parsed = JSON.parse(toolCall.argumentsJson);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`tool arguments for ${toolCall.name} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function isBlankText(content: string | undefined): boolean {
  return content === undefined || content.trim().length === 0;
}

function applyToolResultBudget(spec: AgentRunSpec, messages: AgentMessage[]): void {
  if (spec.toolResultBudget === undefined) {
    return;
  }
  for (const message of messages) {
    if (message.role !== "tool") {
      continue;
    }
    message.content = applyTextBudget(message.content, spec.toolResultBudget);
  }
}

function applyTextBudget(content: string, budget: number | undefined): string {
  if (budget === undefined || budget <= 0 || content.length <= budget) {
    return content;
  }
  return `${content.slice(0, budget)}\n... (truncated)`;
}

function awaitingInputFromMetadata(metadata: Record<string, unknown> | undefined): (Record<string, unknown> & { stopReason: "awaiting_user_input" | "awaiting_approval" | "awaiting_form" }) | undefined {
  if (!metadata || metadata.awaitingUserInput !== true) {
    return undefined;
  }
  const stopReason = normalizeAwaitingStopReason(metadata.stopReason);
  return {
    ...metadata,
    stopReason,
  };
}

function memoryReferencesFromMetadata(metadata: Record<string, unknown> | undefined): unknown[] | undefined {
  const references = metadata?._memory_references;
  if (!Array.isArray(references) || references.length === 0) {
    return undefined;
  }
  return references;
}

function taskProgressFromMetadata(
  metadata: Record<string, unknown> | undefined,
): { planId: string | undefined; progress: unknown } | undefined {
  if (!metadata || metadata._task_event !== true || metadata._task_progress === undefined) {
    return undefined;
  }
  return {
    planId: typeof metadata._task_plan_id === "string" ? metadata._task_plan_id : undefined,
    progress: metadata._task_progress,
  };
}

function normalizeAwaitingStopReason(value: unknown): "awaiting_user_input" | "awaiting_approval" | "awaiting_form" {
  if (value === "awaiting_approval" || value === "awaiting_form" || value === "awaiting_user_input") {
    return value;
  }
  return "awaiting_user_input";
}

function snipHistory(spec: AgentRunSpec, messages: AgentMessage[]): AgentMessage[] {
  const budget = spec.contextWindow;
  if (!budget || budget <= 0 || estimateMessages(messages) <= budget) {
    return messages;
  }

  const coreSystem: AgentMessage[] = [];
  const candidates: AgentMessage[] = [];
  let seenCoreSystem = false;
  for (const message of messages) {
    if (message.role === "system" && !seenCoreSystem) {
      coreSystem.push(message);
      seenCoreSystem = true;
      continue;
    }
    candidates.push(message);
  }
  if (candidates.length === 0) {
    return messages;
  }

  const coreSystemCost = estimateMessages(coreSystem);
  const remainingBudget = Math.max(32, budget - coreSystemCost);
  const kept: AgentMessage[] = [];
  let keptCost = 0;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const message = candidates[index];
    const messageCost = estimateMessage(message);
    if (kept.length > 0 && keptCost + messageCost > remainingBudget) {
      break;
    }
    kept.unshift(message);
    keptCost += messageCost;
  }

  const normalizedKept = normalizeSnippedMessages(kept, candidates);
  return [...coreSystem, ...normalizedKept];
}

function normalizeSnippedMessages(kept: AgentMessage[], candidates: AgentMessage[]): AgentMessage[] {
  let normalized = kept;
  if (normalized.length === 0) {
    normalized = candidates.filter((message) => message.role !== "system").slice(-4);
  }
  const keptDynamicSystem = normalized.filter((message) => message.role === "system");
  let keptTurnMessages = normalized.filter((message) => message.role !== "system");
  const firstUserIndex = keptTurnMessages.findIndex((message) => message.role === "user");
  if (firstUserIndex >= 0) {
    keptTurnMessages = keptTurnMessages.slice(firstUserIndex);
  }
  const legalStart = findLegalMessageStart(keptTurnMessages);
  if (legalStart > 0) {
    keptTurnMessages = keptTurnMessages.slice(legalStart);
  }
  return [...keptDynamicSystem, ...keptTurnMessages];
}

function findLegalMessageStart(messages: AgentMessage[]): number {
  const declared = new Set<string>();
  let start = 0;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "assistant") {
      for (const toolCall of message.toolCalls ?? []) {
        declared.add(toolCall.id);
      }
      continue;
    }
    if (message.role === "tool" && message.toolCallId && !declared.has(message.toolCallId)) {
      start = index + 1;
      declared.clear();
      for (const previous of messages.slice(start, index + 1)) {
        if (previous.role !== "assistant") {
          continue;
        }
        for (const toolCall of previous.toolCalls ?? []) {
          declared.add(toolCall.id);
        }
      }
    }
  }
  return start;
}

function estimateMessages(messages: AgentMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessage(message), 0);
}

function estimateMessage(message: AgentMessage): number {
  const parts = [
    message.role,
    message.content,
    message.toolCallId,
    message.name,
    message.toolCalls ? JSON.stringify(message.toolCalls) : "",
  ];
  return parts.reduce((total, part) => total + (part?.length ?? 0), 4);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
}

function availableToolNames(tools: ToolRegistry): string {
  return tools.definitions().map((tool) => tool.name).join(", ");
}

function prepareToolArguments(
  tools: ToolRegistry,
  name: string,
  args: Record<string, unknown>,
): { args: Record<string, unknown>; errors: string[] } {
  const definition = tools.definitions().find((tool) => tool.name === name);
  const schema = asRecord(definition?.parameters);
  if (!schema || schema.type !== "object") {
    return { args, errors: [] };
  }
  const castArgs = castJsonSchemaValue(args, schema);
  const preparedArgs = asRecord(castArgs) ?? args;
  return {
    args: preparedArgs,
    errors: validateJsonSchemaValue(preparedArgs, { ...schema, type: "object" }, ""),
  };
}

function castJsonSchemaValue(value: unknown, schema: Record<string, unknown>): unknown {
  const schemaType = resolveJsonSchemaType(schema.type);
  if (schemaType === "object") {
    const objectValue = asRecord(value);
    if (!objectValue) {
      return value;
    }
    const properties = asRecord(schema.properties) ?? {};
    return Object.fromEntries(
      Object.entries(objectValue).map(([key, childValue]) => {
        const childSchema = asRecord(properties[key]);
        return [key, childSchema ? castJsonSchemaValue(childValue, childSchema) : childValue];
      }),
    );
  }
  if (typeof value === "string" && schemaType === "integer") {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? value : parsed;
  }
  if (typeof value === "string" && schemaType === "number") {
    const parsed = Number.parseFloat(value);
    return Number.isNaN(parsed) ? value : parsed;
  }
  if (typeof value === "string" && schemaType === "boolean") {
    const lower = value.toLowerCase();
    if (lower === "true" || lower === "1" || lower === "yes") {
      return true;
    }
    if (lower === "false" || lower === "0" || lower === "no") {
      return false;
    }
  }
  if (Array.isArray(value) && schemaType === "array") {
    const itemSchema = asRecord(schema.items);
    return itemSchema ? value.map((item) => castJsonSchemaValue(item, itemSchema)) : value;
  }
  if (schemaType === "string" && value !== null && value !== undefined) {
    return String(value);
  }
  return value;
}

function validateJsonSchemaValue(value: unknown, schema: Record<string, unknown>, path: string): string[] {
  const schemaType = resolveJsonSchemaType(schema.type);
  const label = path || "parameter";
  if (schemaType === "object") {
    const objectValue = asRecord(value);
    if (!objectValue) {
      return [`${label} should be object`];
    }
    const errors: string[] = [];
    const properties = asRecord(schema.properties) ?? {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (typeof key === "string" && !(key in objectValue)) {
        errors.push(`missing required ${subpath(path, key)}`);
      }
    }
    for (const [key, childValue] of Object.entries(objectValue)) {
      const childSchema = asRecord(properties[key]);
      if (childSchema) {
        errors.push(...validateJsonSchemaValue(childValue, childSchema, subpath(path, key)));
      }
    }
    return errors;
  }
  if (schemaType === "string" && typeof value !== "string") {
    return [`${label} should be string`];
  }
  if (schemaType === "boolean" && typeof value !== "boolean") {
    return [`${label} should be boolean`];
  }
  if (schemaType === "integer" && (!Number.isInteger(value) || typeof value !== "number")) {
    return [`${label} should be integer`];
  }
  if (schemaType === "number" && typeof value !== "number") {
    return [`${label} should be number`];
  }
  if (schemaType === "array" && !Array.isArray(value)) {
    return [`${label} should be array`];
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return [`${label} must be one of ${formatJsonSchemaEnum(schema.enum)}`];
  }
  return [];
}

function resolveJsonSchemaType(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return value.find((item): item is string => typeof item === "string" && item !== "null");
  }
  return typeof value === "string" ? value : undefined;
}

function subpath(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

function formatJsonSchemaEnum(values: unknown[]): string {
  return `[${values.map((value) => typeof value === "string" ? `'${value}'` : String(value)).join(", ")}]`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mergeUsage(current: TokenUsage | undefined, next: TokenUsage | undefined): TokenUsage | undefined {
  if (!next) {
    return current;
  }
  return {
    inputTokens: sum(current?.inputTokens, next.inputTokens),
    outputTokens: sum(current?.outputTokens, next.outputTokens),
    totalTokens: sum(current?.totalTokens, next.totalTokens),
  };
}

function sum(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }
  return left + right;
}

function cloneMessage(message: AgentMessage): AgentMessage {
  return {
    ...message,
    toolCalls: message.toolCalls?.map(cloneToolCall),
  };
}

function cloneToolCall(toolCall: ToolCallRequest): ToolCallRequest {
  return { ...toolCall };
}
