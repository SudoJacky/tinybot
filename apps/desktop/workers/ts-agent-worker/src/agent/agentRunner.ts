import type { AgentMessage, AgentRunResult, AgentRunSpec } from "./agentRunSpec.ts";
import type { ModelProvider, ModelRequestOptions, TokenUsage, ToolCallRequest } from "../model/provider.ts";
import type { ToolRegistry } from "../tools/toolRegistry.ts";

const EMPTY_FINAL_RESPONSE_MESSAGE =
  "I completed the tool steps but couldn't produce a final answer. Please try again or narrow the task.";
const FINALIZATION_RETRY_PROMPT =
  "You have already finished the tool work. Do not call any more tools. Using only the conversation and tool results above, provide the final answer for the user now.";

export type AgentRunnerOptions = {
  provider: ModelProvider;
  tools: ToolRegistry;
  emitEvent?: (event: AgentRunnerEvent) => void;
  checkpoint?: (checkpoint: AgentRunnerCheckpoint) => void;
};

export type AgentRunnerEvent = {
  type: "tool_start" | "tool_result" | "content_delta" | "reasoning_delta" | "tool_call_delta";
  payload: Record<string, unknown>;
};

export type AgentRunnerCheckpoint = {
  phase: "awaiting_tools" | "tools_completed" | "final_response";
  iteration: number;
  model: string;
  assistantMessage: AgentMessage;
  completedToolResults: AgentMessage[];
  pendingToolCalls: ToolCallRequest[];
};

export class AgentRunner {
  private readonly provider: ModelProvider;
  private readonly tools: ToolRegistry;
  private readonly emitEvent: (event: AgentRunnerEvent) => void;
  private readonly checkpoint: (checkpoint: AgentRunnerCheckpoint) => void;

  constructor(options: AgentRunnerOptions) {
    this.provider = options.provider;
    this.tools = options.tools;
    this.emitEvent = options.emitEvent ?? (() => undefined);
    this.checkpoint = options.checkpoint ?? (() => undefined);
  }

  async run(spec: AgentRunSpec): Promise<AgentRunResult> {
    const messages = spec.messages.map(cloneMessage);
    const toolsUsed: string[] = [];
    let usage: TokenUsage | undefined;

    for (let iteration = 0; iteration < spec.maxIterations; iteration += 1) {
      const response = await this.provider.complete(messages.map(cloneMessage), this.requestOptions(spec));
      usage = mergeUsage(usage, response.usage);

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
          assistantMessage: cloneMessage(assistantMessage),
          completedToolResults: [],
          pendingToolCalls: response.toolCalls.map(cloneToolCall),
        });

        const completedToolResults: AgentMessage[] = [];
        for (const toolCall of response.toolCalls) {
          toolsUsed.push(toolCall.name);
          const args = parseToolArguments(toolCall);
          this.emitEvent({
            type: "tool_start",
            payload: {
              runId: spec.runId,
              toolCallId: toolCall.id,
              toolName: toolCall.name,
            },
          });
          let result;
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
            result = { content: `Error: ${errorMessage(error)}` };
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
          const toolMessage: AgentMessage = {
            role: "tool",
            content: result.content,
            toolCallId: toolCall.id,
            name: toolCall.name,
          };
          messages.push(toolMessage);
          completedToolResults.push(toolMessage);
        }
        this.checkpoint({
          phase: "tools_completed",
          iteration,
          model: spec.model,
          assistantMessage: cloneMessage(assistantMessage),
          completedToolResults: completedToolResults.map(cloneMessage),
          pendingToolCalls: [],
        });
        continue;
      }

      let finalContent = response.content;
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

    return {
      finalContent: "",
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

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
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
