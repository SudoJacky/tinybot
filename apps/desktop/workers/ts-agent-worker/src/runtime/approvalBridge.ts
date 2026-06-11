import type { JsonObject } from "../protocol/messages.ts";
import type { ApprovalRequestPayload } from "../security/approvalTypes.ts";
import type { NativeRpcClient } from "../tools/nativeToolProxy.ts";
import type { ApprovalBridge, ApprovalResolutionRequest } from "./agentWorker.ts";

export class NativeApprovalBridge implements ApprovalBridge {
  private readonly rpcClient: NativeRpcClient;

  constructor(rpcClient: NativeRpcClient) {
    this.rpcClient = rpcClient;
  }

  async requestApproval(params: ApprovalRequestPayload, traceId: string): Promise<Record<string, unknown>> {
    const payload: JsonObject = {
      run_id: params.runId,
      operation: params.operation,
      classification: {
        category: params.classification.category,
        risk: params.classification.risk,
        reason: params.classification.reason,
      },
      fingerprint: params.fingerprint,
      session_fingerprint: params.sessionFingerprint,
      summary: params.summary,
    };
    if (params.sessionId) {
      payload.session_id = params.sessionId;
    }
    const result = await this.rpcClient.request(traceId, "approval.request", payload);
    return (typeof result === "object" && result !== null && !Array.isArray(result) ? result : {}) as JsonObject;
  }

  async resolveApproval(params: ApprovalResolutionRequest, traceId: string): Promise<Record<string, unknown>> {
    const result = await this.rpcClient.request(traceId, "approval.resolve", {
      session_id: params.sessionId,
      approval_id: params.approvalId,
      approved: params.approved,
      scope: params.scope,
    });
    return (typeof result === "object" && result !== null && !Array.isArray(result) ? result : {}) as JsonObject;
  }

  async listPendingApprovals(sessionId: string, traceId: string): Promise<Record<string, unknown>> {
    const result = await this.rpcClient.request(traceId, "approval.list_pending", {
      session_id: sessionId,
    });
    return (typeof result === "object" && result !== null && !Array.isArray(result) ? result : {}) as JsonObject;
  }
}
