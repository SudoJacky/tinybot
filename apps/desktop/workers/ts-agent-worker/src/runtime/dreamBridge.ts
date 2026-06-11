import type { JsonObject } from "../protocol/messages.ts";
import type { NativeRpcClient } from "../tools/nativeToolProxy.ts";
import type { DreamCommandBridge } from "./agentWorker.ts";
import type { DreamCommandRequest, DreamCommandResult, DreamLogCommandRequest, DreamRestoreCommandRequest } from "../command/commandTypes.ts";

export class NativeDreamBridge implements DreamCommandBridge {
  private readonly rpcClient: NativeRpcClient;

  constructor(rpcClient: NativeRpcClient) {
    this.rpcClient = rpcClient;
  }

  async runDream(request: DreamCommandRequest): Promise<DreamCommandResult> {
    return dreamResult(await this.rpcClient.request(request.traceId, "memory.dream_run", {
      ...sessionParams(request.sessionId),
    }));
  }

  async getDreamLog(request: DreamLogCommandRequest): Promise<DreamCommandResult> {
    return dreamResult(await this.rpcClient.request(request.traceId, "memory.dream_log", {
      ...sessionParams(request.sessionId),
      ...(request.sha ? { sha: request.sha } : {}),
    }));
  }

  async restoreDream(request: DreamRestoreCommandRequest): Promise<DreamCommandResult> {
    return dreamResult(await this.rpcClient.request(request.traceId, "memory.dream_restore", {
      ...sessionParams(request.sessionId),
      ...(request.sha ? { sha: request.sha } : {}),
    }));
  }
}

function sessionParams(sessionId: string | undefined): JsonObject {
  return sessionId ? { session_id: sessionId } : {};
}

function dreamResult(value: unknown): DreamCommandResult {
  if (!isJsonObject(value)) {
    return { content: "Dream command returned an invalid response." };
  }
  return {
    content: typeof value.content === "string" ? value.content : "",
    metadata: isJsonObject(value.metadata) ? value.metadata : undefined,
  };
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
