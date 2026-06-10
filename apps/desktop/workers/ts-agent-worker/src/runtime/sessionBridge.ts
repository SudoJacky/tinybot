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
      checkpoint: checkpoint as JsonObject,
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
      messages: messages as unknown as JsonObject[],
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
