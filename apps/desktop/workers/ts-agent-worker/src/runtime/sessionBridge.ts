import type { AgentMessage } from "../agent/agentRunSpec.ts";
import type { JsonObject } from "../protocol/messages.ts";
import type { NativeRpcClient } from "../tools/nativeToolProxy.ts";
import type { SessionBridge } from "./agentWorker.ts";

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

  async appendMessages(sessionId: string, messages: AgentMessage[], traceId: string): Promise<void> {
    await this.rpcClient.request(traceId, "session.append_messages", {
      session_id: sessionId,
      messages: messages.map(nativeSessionMessage),
    });
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

function nativeSessionCheckpoint(checkpoint: Record<string, unknown>): JsonObject {
  return {
    ...checkpoint,
    ...(Array.isArray(checkpoint.messages)
      ? { messages: checkpoint.messages.map(nativeSessionCheckpointMessage) }
      : {}),
    ...(isAgentMessageLike(checkpoint.assistantMessage)
      ? { assistantMessage: nativeSessionCheckpointMessage(checkpoint.assistantMessage) }
      : {}),
    ...(Array.isArray(checkpoint.completedToolResults)
      ? { completedToolResults: checkpoint.completedToolResults.map(nativeSessionCheckpointMessage) }
      : {}),
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
    ...(message.metadata ? { metadata: message.metadata as JsonObject } : {}),
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

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
