import type { AgentMessage } from "../agent/agentRunSpec.ts";
import { taskProgressPayload } from "../task/taskProgress.ts";
import { NativeTaskStoreBridge } from "../task/taskStoreBridge.ts";
import type { TaskPlan } from "../task/taskTypes.ts";
import type { ToolCallRequest } from "../model/provider.ts";
import type { JsonObject } from "../protocol/messages.ts";
import type { NativeRpcClient } from "../tools/nativeToolProxy.ts";
import type {
  WebuiPatchSessionResult,
  WebuiDeleteSessionResult,
  WebuiSessionMessages,
  WebuiSessionMetadata,
  WebuiSessionProfile,
  WebuiSessionTemporaryFiles,
  WebuiTemporaryFileUpload,
  WebuiSessionProvider,
} from "../webui/webuiRoutes.ts";
import type { AppendMessagesResult, ClearSessionResult, PersistTurnRequest, PersistTurnResult, SessionBridge } from "./agentWorker.ts";

export type TrimSessionResult = {
  sessionId: string;
  messagesBefore: number;
  messagesAfter: number;
};

export class NativeSessionBridge implements SessionBridge, WebuiSessionProvider {
  private readonly rpcClient: NativeRpcClient;

  constructor(rpcClient: NativeRpcClient) {
    this.rpcClient = rpcClient;
  }

  async listSessions(traceId: string): Promise<WebuiSessionMetadata[]> {
    return normalizeWebuiSessionMetadata(await this.rpcClient.request(traceId, "session.list_metadata", {}));
  }

  async listWebuiSessions(traceId: string): Promise<WebuiSessionMetadata[]> {
    return this.listSessions(traceId);
  }

  async getSessionMessages(sessionId: string, traceId: string): Promise<WebuiSessionMessages | null> {
    const result = await this.rpcClient.request(traceId, "session.get_metadata", {
      session_id: sessionId,
    });
    return normalizeWebuiSessionMessages(result);
  }

  async getWebuiSessionMessages(sessionId: string, traceId: string): Promise<WebuiSessionMessages | null> {
    return this.getSessionMessages(sessionId, traceId);
  }

  async getTaskProgressCard(planId: string, traceId: string): Promise<Record<string, unknown> | null> {
    const plan = await new NativeTaskStoreBridge(this.rpcClient).getPlan(planId, traceId);
    return plan ? taskProgressCardFromPlan(plan) : null;
  }

  async getSessionProfile(sessionId: string, traceId: string): Promise<WebuiSessionProfile | null> {
    const result = await this.rpcClient.request(traceId, "session.get_metadata", {
      session_id: sessionId,
    });
    return normalizeWebuiSessionProfile(result);
  }

  async getWebuiSessionProfile(sessionId: string, traceId: string): Promise<WebuiSessionProfile | null> {
    return this.getSessionProfile(sessionId, traceId);
  }

  async patchSessionMetadata(
    sessionId: string,
    metadata: Record<string, unknown>,
    traceId: string,
  ): Promise<WebuiPatchSessionResult | null> {
    const result = await this.rpcClient.request(traceId, "session.patch_metadata", {
      session_id: sessionId,
      metadata,
    });
    return normalizeWebuiPatchSessionResult(result);
  }

  async listTemporaryFiles(sessionId: string, traceId: string): Promise<WebuiSessionTemporaryFiles> {
    const result = await this.rpcClient.request(traceId, "knowledge.session_list", {
      session_id: sessionId,
    });
    return normalizeWebuiTemporaryFiles(result, sessionId);
  }

  async uploadTemporaryFile(
    sessionId: string,
    upload: WebuiTemporaryFileUpload,
    traceId: string,
  ): Promise<Record<string, unknown>> {
    const result = await this.rpcClient.request(traceId, "knowledge.session_upload", {
      session_id: sessionId,
      name: upload.name,
      file_type: upload.fileType,
      content: upload.content,
      size_bytes: upload.sizeBytes,
    });
    return isJsonObject(result) ? result : {};
  }

  async clearTemporaryFiles(sessionId: string, traceId: string): Promise<WebuiSessionTemporaryFiles> {
    const result = await this.rpcClient.request(traceId, "knowledge.session_clear", {
      session_id: sessionId,
    });
    return normalizeWebuiTemporaryFiles(result, sessionId);
  }

  async deleteSession(sessionId: string, traceId: string): Promise<WebuiDeleteSessionResult> {
    const result = await this.rpcClient.request(traceId, "session.delete", {
      session_id: sessionId,
    });
    return normalizeDeleteSessionResult(result, sessionId);
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

  async trimSession(sessionId: string, keepRecentMessages: number, traceId: string): Promise<TrimSessionResult> {
    const result = await this.rpcClient.request(traceId, "session.trim", {
      session_id: sessionId,
      keep_recent_messages: keepRecentMessages,
    });
    return normalizeTrimSessionResult(result, sessionId);
  }

  async appendMessages(sessionId: string, messages: AgentMessage[], traceId: string): Promise<AppendMessagesResult> {
    const persistedMessages = messages.filter(persistableSessionMessage).map(nativeSessionMessage);
    const result = await this.rpcClient.request(traceId, "session.append_messages", {
      session_id: sessionId,
      messages: persistedMessages,
    });
    return normalizeAppendMessagesResult(result, sessionId, persistedMessages.length);
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
    savedMessages: agentMessagesField(payload, "savedMessages", "saved_messages"),
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

function normalizeAppendMessagesResult(result: unknown, fallbackSessionId: string, requestedMessageCount: number): AppendMessagesResult {
  const payload = isJsonObject(result) ? result : {};
  const extra = isJsonObject(payload.extra) ? payload.extra : {};
  const messages = Array.isArray(extra.messages) ? extra.messages : [];
  const messagesAfter = optionalNumberField(payload, "messagesAfter", "messages_after") ?? messages.length;
  const savedMessageCount = optionalNumberField(payload, "savedMessageCount", "saved_message_count") ?? requestedMessageCount;
  const messagesBefore = optionalNumberField(payload, "messagesBefore", "messages_before") ?? Math.max(0, messagesAfter - savedMessageCount);
  return {
    sessionId: stringField(payload, "sessionId", "session_id") ?? fallbackSessionId,
    messagesBefore,
    messagesAfter,
    savedMessageCount,
  };
}

function normalizeTrimSessionResult(result: unknown, fallbackSessionId: string): TrimSessionResult {
  const payload = isJsonObject(result) ? result : {};
  return {
    sessionId: stringField(payload, "sessionId", "session_id") ?? fallbackSessionId,
    messagesBefore: numberField(payload, "messagesBefore", "messages_before"),
    messagesAfter: numberField(payload, "messagesAfter", "messages_after"),
  };
}

function normalizeDeleteSessionResult(result: unknown, fallbackSessionId: string): WebuiDeleteSessionResult {
  const payload = isJsonObject(result) ? result : {};
  return {
    sessionId: stringField(payload, "sessionId", "session_id") ?? fallbackSessionId,
    deleted: booleanField(payload, "deleted", "deleted"),
  };
}

function normalizeWebuiSessionMetadata(result: unknown): WebuiSessionMetadata[] {
  if (!Array.isArray(result)) {
    return [];
  }
  return result.filter(isJsonObject).map((payload) => ({
    sessionId: stringField(payload, "sessionId", "session_id") ?? "",
    title: stringField(payload, "title", "title") ?? "",
    createdAt: stringField(payload, "createdAt", "created_at") ?? "",
    updatedAt: stringField(payload, "updatedAt", "updated_at") ?? "",
    extra: isJsonObject(payload.extra) ? payload.extra : {},
  })).filter((session) => session.sessionId.length > 0);
}

function normalizeWebuiSessionMessages(result: unknown): WebuiSessionMessages | null {
  if (!isJsonObject(result)) {
    return null;
  }
  const sessionId = stringField(result, "sessionId", "session_id");
  if (!sessionId) {
    return null;
  }
  const extra = isJsonObject(result.extra) ? result.extra : {};
  return {
    sessionId,
    messages: Array.isArray(extra.messages) ? extra.messages.filter(isJsonObject) : [],
  };
}

function normalizeWebuiSessionProfile(result: unknown): WebuiSessionProfile | null {
  if (!isJsonObject(result)) {
    return null;
  }
  const sessionId = stringField(result, "sessionId", "session_id");
  if (!sessionId) {
    return null;
  }
  const extra = isJsonObject(result.extra) ? result.extra : {};
  const profile = extra.user_profile ?? extra.userProfile ?? result.user_profile ?? result.userProfile;
  return {
    sessionId,
    profile: isJsonObject(profile) ? profile : {},
  };
}

function normalizeWebuiPatchSessionResult(result: unknown): WebuiPatchSessionResult | null {
  if (!isJsonObject(result)) {
    return null;
  }
  const sessionId = stringField(result, "sessionId", "session_id");
  if (!sessionId) {
    return null;
  }
  const extra = isJsonObject(result.extra) ? result.extra : {};
  const metadata = extra.metadata ?? result.metadata;
  return {
    sessionId,
    metadata: isJsonObject(metadata) ? metadata : {},
    updatedAt: stringField(result, "updatedAt", "updated_at") ?? "",
  };
}

function normalizeWebuiTemporaryFiles(result: unknown, fallbackSessionId: string): WebuiSessionTemporaryFiles {
  if (!isJsonObject(result)) {
    return { sessionId: fallbackSessionId, items: [] };
  }
  const sessionId = stringField(result, "sessionId", "session_id") ?? fallbackSessionId;
  const extra = isJsonObject(result.extra) ? result.extra : {};
  const items = extra.temporary_files ?? extra.temporaryFiles ?? result.temporary_files ?? result.temporaryFiles;
  const cleared = optionalNumberField(result, "cleared", "cleared");
  return {
    sessionId,
    items: Array.isArray(items) ? items.filter(isJsonObject) : [],
    ...(cleared !== undefined ? { cleared } : {}),
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

function taskProgressCardFromPlan(plan: TaskPlan): Record<string, unknown> {
  return {
    role: "progress",
    content: `Task Progress: ${plan.title}`,
    timestamp: plan.updatedAt ?? plan.createdAt ?? "",
    _progress: true,
    _tool_name: "task",
    _task_event: true,
    _task_progress: {
      event: "restored",
      plan_id: plan.id,
      plan_title: plan.title,
      plan_status: plan.status,
      progress: taskProgressPayload(plan),
      subtasks: plan.subtasks.map((subtask) => ({
        id: subtask.id,
        title: subtask.title,
        status: subtask.status,
        dependencies: subtask.dependencies,
        parallel_safe: subtask.parallelSafe,
        result: subtask.result ?? null,
        error: subtask.error ?? null,
      })),
    },
    _task_plan_id: plan.id,
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

function agentMessagesField(payload: Record<string, unknown>, camelKey: string, snakeKey: string): AgentMessage[] | undefined {
  const value = payload[camelKey] ?? payload[snakeKey];
  if (!Array.isArray(value)) {
    return undefined;
  }
  const messages = value.map(nativeAgentMessage).filter((message) => message !== undefined);
  return messages.length > 0 ? messages : undefined;
}

function nativeAgentMessage(value: unknown): AgentMessage | undefined {
  if (!isAgentMessageLike(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const reasoningContent = typeof record.reasoningContent === "string"
    ? record.reasoningContent
    : typeof record.reasoning_content === "string"
      ? record.reasoning_content
      : undefined;
  const thinkingBlocks = Array.isArray(record.thinkingBlocks)
    ? record.thinkingBlocks.filter(isJsonObject)
    : Array.isArray(record.thinking_blocks)
      ? record.thinking_blocks.filter(isJsonObject)
      : undefined;
  const toolCalls = Array.isArray(record.toolCalls)
    ? record.toolCalls.map(nativeToolCall).filter((toolCall): toolCall is ToolCallRequest => toolCall !== undefined)
    : Array.isArray(record.tool_calls)
      ? record.tool_calls.map(nativeToolCall).filter((toolCall): toolCall is ToolCallRequest => toolCall !== undefined)
      : undefined;
  const toolCallId = typeof record.toolCallId === "string"
    ? record.toolCallId
    : typeof record.tool_call_id === "string"
      ? record.tool_call_id
      : undefined;
  return {
    role: value.role,
    content: value.content,
    ...(reasoningContent !== undefined ? { reasoningContent } : {}),
    ...(thinkingBlocks && thinkingBlocks.length > 0 ? { thinkingBlocks } : {}),
    ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(typeof record.name === "string" ? { name: record.name } : {}),
    ...(isJsonObject(record.metadata) ? { metadata: record.metadata } : {}),
  };
}

function nativeToolCall(value: unknown): ToolCallRequest | undefined {
  if (!isJsonObject(value) || typeof value.id !== "string") {
    return undefined;
  }
  if (isJsonObject(value.function) && typeof value.function.name === "string" && typeof value.function.arguments === "string") {
    return {
      id: value.id,
      name: value.function.name,
      argumentsJson: value.function.arguments,
    };
  }
  if (typeof value.name === "string") {
    const argumentsJson = typeof value.argumentsJson === "string"
      ? value.argumentsJson
      : typeof value.arguments_json === "string"
        ? value.arguments_json
        : "{}";
    return {
      id: value.id,
      name: value.name,
      argumentsJson,
    };
  }
  return undefined;
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

function optionalNumberField(payload: Record<string, unknown>, camelKey: string, snakeKey: string): number | undefined {
  const value = payload[camelKey] ?? payload[snakeKey];
  return typeof value === "number" ? value : undefined;
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
