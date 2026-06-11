import type { AgentMessage } from "../agent/agentRunSpec.ts";
import type { JsonObject } from "../protocol/messages.ts";
import type { NativeRpcClient } from "../tools/nativeToolProxy.ts";
import type { ClearSessionResult, PersistTurnRequest, PersistTurnResult, SessionBridge } from "./agentWorker.ts";

export class NativeSessionBridge implements SessionBridge {
  private readonly rpcClient: NativeRpcClient;

  constructor(rpcClient: NativeRpcClient) {
    this.rpcClient = rpcClient;
  }

  async setCheckpoint(sessionId: string, checkpoint: Record<string, unknown>, traceId: string): Promise<void> {
    await this.rpcClient.request(traceId, "session.set_checkpoint", {
      session_id: sessionId,
      checkpoint: nativeSessionCheckpoint(checkpoint),
    });
  }

  async clearCheckpoint(sessionId: string, traceId: string): Promise<void> {
    await this.rpcClient.request(traceId, "session.clear_checkpoint", {
      session_id: sessionId,
    });
  }

  async clearSession(sessionId: string, traceId: string): Promise<ClearSessionResult> {
    const result = await this.rpcClient.request(traceId, "session.clear", {
      session_id: sessionId,
    });
    return normalizeClearSessionResult(result, sessionId);
  }

  async appendMessages(sessionId: string, messages: AgentMessage[], traceId: string): Promise<void> {
    await this.rpcClient.request(traceId, "session.append_messages", {
      session_id: sessionId,
      messages: messages.filter(persistableSessionMessage).map(nativeSessionMessage),
    });
  }

  async persistTurn(sessionId: string, turn: PersistTurnRequest, traceId: string): Promise<PersistTurnResult> {
    const result = await this.rpcClient.request(traceId, "session.persist_turn", {
      session_id: sessionId,
      run_id: turn.runId,
      messages: turn.messages.filter(persistableSessionMessage).map(nativeSessionMessage),
      clearCheckpoint: turn.clearCheckpoint,
      clear_checkpoint: turn.clearCheckpoint,
      ...(turn.runtimeContextTag
        ? { runtimeContextTag: turn.runtimeContextTag, runtime_context_tag: turn.runtimeContextTag }
        : {}),
      ...(turn.contextMetadata ? { contextMetadata: turn.contextMetadata, context_metadata: turn.contextMetadata } : {}),
    });
    return normalizePersistTurnResult(result, sessionId);
  }

  async getCheckpoint(sessionId: string, traceId: string): Promise<Record<string, unknown> | null> {
    const checkpoint = await this.rpcClient.request(traceId, "session.get_checkpoint", {
      session_id: sessionId,
    });
    if (checkpoint === null) {
      return null;
    }
    return checkpoint as Record<string, unknown>;
  }
}

function normalizePersistTurnResult(result: unknown, fallbackSessionId: string): PersistTurnResult {
  const payload = isJsonObject(result) ? result : {};
  return {
    sessionId: stringField(payload, "sessionId", "session_id") ?? fallbackSessionId,
    messagesBefore: numberField(payload, "messagesBefore", "messages_before"),
    messagesAfter: numberField(payload, "messagesAfter", "messages_after"),
    savedMessageCount: numberField(payload, "savedMessageCount", "saved_message_count"),
    checkpointCleared: booleanField(payload, "checkpointCleared", "checkpoint_cleared"),
    duplicateMessageCount: numberField(payload, "duplicateMessageCount", "duplicate_message_count"),
    truncatedToolResultCount: numberField(payload, "truncatedToolResultCount", "truncated_tool_result_count"),
    omittedSideEffects: stringArrayField(payload, "omittedSideEffects", "omitted_side_effects"),
  };
}

function normalizeClearSessionResult(result: unknown, fallbackSessionId: string): ClearSessionResult {
  const payload = isJsonObject(result) ? result : {};
  return {
    sessionId: stringField(payload, "sessionId", "session_id") ?? fallbackSessionId,
    messagesBefore: numberField(payload, "messagesBefore", "messages_before"),
    messagesAfter: numberField(payload, "messagesAfter", "messages_after"),
    checkpointCleared: booleanField(payload, "checkpointCleared", "checkpoint_cleared"),
  };
}

function nativeSessionCheckpoint(checkpoint: Record<string, unknown>): JsonObject {
  const messages = Array.isArray(checkpoint.messages)
    ? checkpoint.messages.map(nativeSessionCheckpointMessage)
    : undefined;
  const assistantMessage = isAgentMessageLike(checkpoint.assistantMessage)
    ? nativeSessionCheckpointMessage(checkpoint.assistantMessage)
    : undefined;
  const completedToolResults = Array.isArray(checkpoint.completedToolResults)
    ? checkpoint.completedToolResults.map(nativeSessionCheckpointMessage)
    : undefined;
  const pendingToolCalls = Array.isArray(checkpoint.pendingToolCalls)
    ? checkpoint.pendingToolCalls.map(nativeSessionToolCall)
    : undefined;
  return {
    ...checkpoint,
    ...(messages ? { messages } : {}),
    ...(assistantMessage ? { assistantMessage, assistant_message: assistantMessage } : {}),
    ...(completedToolResults ? { completedToolResults, completed_tool_results: completedToolResults } : {}),
    ...(pendingToolCalls ? { pendingToolCalls, pending_tool_calls: pendingToolCalls } : {}),
  } as JsonObject;
}

function nativeSessionCheckpointMessage(value: unknown): unknown {
  if (!isAgentMessageLike(value)) {
    return value;
  }
  if (hasNativeToolFields(value)) {
    return value;
  }
  return nativeSessionMessage(value);
}

function persistableSessionMessage(message: AgentMessage): boolean {
  if (message.role === "system") {
    return false;
  }
  if (message.role === "assistant" && message.content.trim().length === 0 && !message.toolCalls?.length) {
    return false;
  }
  return true;
}

function nativeSessionMessage(message: AgentMessage): JsonObject {
  return {
    role: message.role,
    content: message.content,
    ...(message.toolCalls?.length
      ? {
          tool_calls: message.toolCalls.map((toolCall) => ({
            id: toolCall.id,
            type: "function",
            function: {
              name: toolCall.name,
              arguments: toolCall.argumentsJson,
            },
          })),
        }
      : {}),
    ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
    ...(message.name ? { name: message.name } : {}),
    ...(message.role === "assistant" && message.reasoningContent !== undefined
      ? { reasoning_content: message.reasoningContent }
      : {}),
    ...(message.role === "assistant" && message.thinkingBlocks
      ? { thinking_blocks: message.thinkingBlocks }
      : {}),
    ...(message.metadata ? { metadata: message.metadata as JsonObject } : {}),
  };
}

function nativeSessionToolCall(value: unknown): unknown {
  if (!isJsonObject(value)) {
    return value;
  }
  if (isJsonObject(value.function)) {
    return value;
  }
  const id = typeof value.id === "string" ? value.id : undefined;
  const name = typeof value.name === "string" ? value.name : undefined;
  const argumentsJson = typeof value.argumentsJson === "string"
    ? value.argumentsJson
    : typeof value.arguments_json === "string"
      ? value.arguments_json
      : undefined;
  if (!id || !name || argumentsJson === undefined) {
    return value;
  }
  return {
    id,
    type: "function",
    function: {
      name,
      arguments: argumentsJson,
    },
  };
}

function isAgentMessageLike(value: unknown): value is AgentMessage {
  if (!isJsonObject(value)) {
    return false;
  }
  return (
    (value.role === "system" || value.role === "user" || value.role === "assistant" || value.role === "tool") &&
    typeof value.content === "string"
  );
}

function hasNativeToolFields(value: Record<string, unknown>): boolean {
  return Array.isArray(value.tool_calls) || typeof value.tool_call_id === "string";
}

function stringField(payload: Record<string, unknown>, camelKey: string, snakeKey: string): string | undefined {
  const value = payload[camelKey] ?? payload[snakeKey];
  return typeof value === "string" ? value : undefined;
}

function numberField(payload: Record<string, unknown>, camelKey: string, snakeKey: string): number {
  const value = payload[camelKey] ?? payload[snakeKey];
  return typeof value === "number" ? value : 0;
}

function booleanField(payload: Record<string, unknown>, camelKey: string, snakeKey: string): boolean {
  const value = payload[camelKey] ?? payload[snakeKey];
  return value === true;
}

function stringArrayField(payload: Record<string, unknown>, camelKey: string, snakeKey: string): string[] {
  const value = payload[camelKey] ?? payload[snakeKey];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
