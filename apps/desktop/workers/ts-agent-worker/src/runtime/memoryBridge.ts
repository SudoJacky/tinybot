import type { AgentMessage } from "../agent/agentRunSpec.ts";
import type { JsonObject } from "../protocol/messages.ts";
import type { NativeRpcClient } from "../tools/nativeToolProxy.ts";
import type { CaptureEvidenceRequest, CaptureEvidenceResult, MemoryEvidenceBridge } from "./turnLifecycle.ts";

export class NativeMemoryBridge implements MemoryEvidenceBridge {
  private readonly rpcClient: NativeRpcClient;

  constructor(rpcClient: NativeRpcClient) {
    this.rpcClient = rpcClient;
  }

  async captureEvidence(sessionId: string, request: CaptureEvidenceRequest, traceId: string): Promise<CaptureEvidenceResult> {
    const result = await this.rpcClient.request(traceId, "memory.capture_evidence", {
      session_key: sessionId,
      start_index: request.startIndex,
      messages: request.messages.map(nativeEvidenceMessage),
    });
    const payload = isJsonObject(result) ? result : {};
    return {
      evidence: Array.isArray(payload.evidence) ? payload.evidence.filter(isJsonObject) : [],
    };
  }
}

function nativeEvidenceMessage(message: AgentMessage): JsonObject {
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
  };
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
