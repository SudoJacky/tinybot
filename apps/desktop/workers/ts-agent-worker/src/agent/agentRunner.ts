import type { AgentMessage, AgentRunResult, AgentRunSpec } from "./agentRunSpec.ts";
import type { ModelProvider, ModelRequestOptions, TokenUsage, ToolCallRequest, ToolDefinition } from "../model/provider.ts";
import type { Tool, ToolResult } from "../tools/tool.ts";
import type { ToolRegistry } from "../tools/toolRegistry.ts";
import { buildApprovalToolRequest } from "../security/approvalRuntime.ts";
import { estimateMessage, estimateMessages } from "../support/tokenEstimator.ts";
import {
  EMPTY_FINAL_RESPONSE_MESSAGE,
  FINALIZATION_RETRY_PROMPT,
  isBlankText,
  normalizeToolResultContent,
} from "../support/runtimeHelpers.ts";

const DEFAULT_MODEL_ERROR_MESSAGE = "Sorry, I encountered an error calling the AI model.";
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
    | "task_progress"
    | "usage";
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
      this.emitContextUsage(spec, messagesForModel, iteration, "before_request");
      const response = await this.provider.complete(messagesForModel.map(cloneMessage), this.requestOptions(spec));
      usage = mergeUsage(usage, response.usage);
      this.emitActualUsage(spec, response.usage, iteration, "after_response");

      if (this.isCancelled()) {
        return cancelledResult(messages, toolsUsed, usage);
      }

      if (response.toolCalls.length > 0) {
        const assistantMessage: AgentMessage = {
          ...assistantMessageFromResponse(response.content, response),
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
          let args: Record<string, unknown> = {};
          let result: ToolResult | undefined;
          try {
            args = parseToolArguments(toolCall);
          } catch (error) {
            result = { content: `Error: Invalid arguments for tool '${toolCall.name}': ${errorMessage(error)}` };
          }
          if (!result && (!this.toolAllowed(spec, toolCall.name) || !this.tools.has(toolCall.name))) {
            result = { content: `Error: Tool '${toolCall.name}' not found. Available: ${availableToolNames(spec, this.tools)}` };
          }
          if (!result) {
            const prepared = this.tools.prepareCall(toolCall.name, args);
            args = prepared.args;
            if (!prepared.ok) {
              result = { content: prepared.content };
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
                const context = {
                  runId: spec.runId,
                  traceId: spec.traceId,
                  sessionId: spec.sessionId,
                };
                result = prepared.tool.requiresApproval
                  ? await this.requestToolApproval(prepared.tool, prepared.args, context)
                  : await prepared.tool.execute(prepared.args, context);
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
            content: normalizeToolResultContent(toolCall.name, result.content, spec.toolResultBudget),
            toolCallId: toolCall.id,
            name: toolCall.name,
            metadata: result.metadata,
          };
          messages.push(toolMessage);
          completedToolResults.push(toolMessage);
          if (this.isCancelled()) {
            return cancelledResult(messages, toolsUsed, usage);
          }
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

      let finalResponse = response;
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
        const retryMessages: AgentMessage[] = [
          ...messages.map(cloneMessage),
          { role: "user", content: FINALIZATION_RETRY_PROMPT },
        ];
        this.emitContextUsage(spec, retryMessages, iteration, "before_finalization_retry");
        const retryResponse = await this.provider.complete(retryMessages, this.finalizationRequestOptions(spec));
        usage = mergeUsage(usage, retryResponse.usage);
        this.emitActualUsage(spec, retryResponse.usage, iteration, "after_finalization_retry");
        finalResponse = retryResponse;
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

      const finalMessage: AgentMessage = assistantMessageFromResponse(finalContent, finalResponse);
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

  private async requestToolApproval(
    tool: Tool,
    args: Record<string, unknown>,
    context: { runId: string; traceId?: string; sessionId?: string },
  ): Promise<ToolResult> {
    const prepared = this.tools.prepareCall("request_approval", {
      ...buildApprovalToolRequest(tool, args),
    });
    if (!prepared.ok) {
      return { content: prepared.content };
    }
    return prepared.tool.execute(prepared.args, context);
  }

  private requestOptions(spec: AgentRunSpec): ModelRequestOptions {
    return {
      model: spec.model,
      tools: this.toolDefinitions(spec),
      ...generationRequestOptions(spec),
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

  private finalizationRequestOptions(spec: AgentRunSpec): ModelRequestOptions {
    return {
      model: spec.model,
      ...generationRequestOptions(spec),
    };
  }

  private toolDefinitions(spec: AgentRunSpec): ToolDefinition[] {
    return spec.tools?.map((tool) => ({ ...tool, parameters: { ...tool.parameters } })) ?? this.tools.definitions();
  }

  private toolAllowed(spec: AgentRunSpec, name: string): boolean {
    return spec.tools === undefined || spec.tools.some((tool) => tool.name === name);
  }

  private emitContextUsage(
    spec: AgentRunSpec,
    messages: AgentMessage[],
    iteration: number,
    phase: "before_request" | "before_finalization_retry",
  ): void {
    const tokens = estimateMessages(messages);
    if (tokens <= 0) {
      return;
    }
    const budget = contextInputBudget(spec);
    this.emitEvent({
      type: "usage",
      payload: {
        runId: spec.runId,
        phase,
        iteration,
        tokens,
        source: "heuristic",
        ...(budget && budget > 0 ? { budget } : {}),
        messageCount: messages.length,
        estimated: true,
      },
    });
  }

  private emitActualUsage(
    spec: AgentRunSpec,
    usage: TokenUsage | undefined,
    iteration: number,
    phase: "after_response" | "after_finalization_retry",
  ): void {
    const tokens = usage?.inputTokens ?? 0;
    if (tokens <= 0) {
      return;
    }
    this.emitEvent({
      type: "usage",
      payload: {
        runId: spec.runId,
        phase,
        iteration,
        tokens,
        source: "provider_usage",
        estimated: false,
      },
    });
  }
}

function generationRequestOptions(spec: AgentRunSpec): Pick<ModelRequestOptions, "temperature" | "maxTokens" | "reasoningEffort"> {
  return {
    ...(spec.temperature !== undefined ? { temperature: spec.temperature } : {}),
    ...(spec.maxTokens !== undefined ? { maxTokens: spec.maxTokens } : {}),
    ...(spec.reasoningEffort !== undefined ? { reasoningEffort: spec.reasoningEffort } : {}),
  };
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

function assistantMessageFromResponse(
  content: string,
  response: { reasoningContent?: string; thinkingBlocks?: Array<Record<string, unknown>> },
): AgentMessage {
  return {
    role: "assistant",
    content,
    ...(response.reasoningContent !== undefined || response.thinkingBlocks
      ? { reasoningContent: response.reasoningContent ?? "" }
      : {}),
    ...(response.thinkingBlocks ? { thinkingBlocks: response.thinkingBlocks } : {}),
  };
}

function parseToolArguments(toolCall: ToolCallRequest): Record<string, unknown> {
  const parsed = JSON.parse(toolCall.argumentsJson);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`tool arguments for ${toolCall.name} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function applyToolResultBudget(spec: AgentRunSpec, messages: AgentMessage[]): void {
  for (const message of messages) {
    if (message.role !== "tool") {
      continue;
    }
    message.content = normalizeToolResultContent(message.name ?? "tool", message.content, spec.toolResultBudget);
  }
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
  const budget = contextInputBudget(spec);
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

function contextInputBudget(spec: AgentRunSpec): number | undefined {
  if (!spec.contextWindow || spec.contextWindow <= 0) {
    return undefined;
  }
  if (!spec.maxTokens || spec.maxTokens <= 0) {
    return spec.contextWindow;
  }
  return spec.contextWindow - spec.maxTokens;
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

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
}

function availableToolNames(spec: AgentRunSpec, tools: ToolRegistry): string {
  return (spec.tools ?? tools.definitions()).map((tool) => tool.name).join(", ");
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
    cachedTokens: sum(current?.cachedTokens, next.cachedTokens),
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
