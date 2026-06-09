import type { JsonObject } from "../protocol/messages.ts";
import type { NativeRpcClient } from "../tools/nativeToolProxy.ts";
import type { ApprovalBridge, ApprovalResolutionRequest } from "./agentWorker.ts";

export class NativeApprovalBridge implements ApprovalBridge {
  constructor(private readonly rpcClient: NativeRpcClient) {}

  async resolveApproval(params: ApprovalResolutionRequest, traceId: string): Promise<Record<string, unknown>> {
    const result = await this.rpcClient.request(traceId, "approval.resolve", {
      session_id: params.sessionId,
      approval_id: params.approvalId,
      approved: params.approved,
      scope: params.scope,
    });
    return (typeof result === "object" && result !== null && !Array.isArray(result) ? result : {}) as JsonObject;
  }
}
