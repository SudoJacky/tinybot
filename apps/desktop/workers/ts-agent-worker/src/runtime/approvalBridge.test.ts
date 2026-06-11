import { describe, expect, test } from "vitest";

import { NativeApprovalBridge } from "./approvalBridge";
import type { NativeRpcClient } from "../tools/nativeToolProxy";

function rpcClient(result: unknown): { client: NativeRpcClient; calls: Array<{ traceId: string; method: string; params: Record<string, unknown> }> } {
  const calls: Array<{ traceId: string; method: string; params: Record<string, unknown> }> = [];
  return {
    calls,
    client: {
      request: async (traceId, method, params) => {
        calls.push({ traceId, method, params });
        return result;
      },
    },
  };
}

describe("NativeApprovalBridge", () => {
  test("requests approval using the native pending approval contract", async () => {
    const { client, calls } = rpcClient({
      content: "Waiting for approval.",
      awaitingUserInput: true,
      stopReason: "awaiting_approval",
      approvalId: "approval-123",
      sessionFingerprint: "write_file:notes.md",
    });
    const bridge = new NativeApprovalBridge(client);

    const result = await bridge.requestApproval({
      runId: "run-1",
      sessionId: "session-1",
      operation: {
        toolName: "write_file",
        arguments: { path: "notes.md", content: "hello" },
        toolCallId: "call-1",
      },
      classification: {
        category: "filesystem_write",
        risk: "medium",
        reason: "File write/edit/delete tools can modify workspace state.",
      },
      fingerprint: "write_file:notes.md",
      sessionFingerprint: "write_file:notes.md",
      summary: "write_file path=\"notes.md\"",
    }, "trace-1");

    expect(calls).toEqual([
      {
        traceId: "trace-1",
        method: "approval.request",
        params: {
          run_id: "run-1",
          session_id: "session-1",
          operation: {
            toolName: "write_file",
            arguments: { path: "notes.md", content: "hello" },
            toolCallId: "call-1",
          },
          classification: {
            category: "filesystem_write",
            risk: "medium",
            reason: "File write/edit/delete tools can modify workspace state.",
          },
          fingerprint: "write_file:notes.md",
          session_fingerprint: "write_file:notes.md",
          summary: "write_file path=\"notes.md\"",
        },
      },
    ]);
    expect(result).toEqual({
      content: "Waiting for approval.",
      awaitingUserInput: true,
      stopReason: "awaiting_approval",
      approvalId: "approval-123",
      sessionFingerprint: "write_file:notes.md",
    });
  });

  test("lists pending approvals for a session", async () => {
    const { client, calls } = rpcClient({
      approvals: [
        {
          id: "approval-1",
          summary: "write_file path=\"notes.md\"",
          risk: "medium",
          category: "filesystem_write",
          reason: "File write/edit/delete tools can modify workspace state.",
        },
      ],
    });
    const bridge = new NativeApprovalBridge(client);

    const result = await bridge.listPendingApprovals("session-1", "trace-1");

    expect(calls).toEqual([
      {
        traceId: "trace-1",
        method: "approval.list_pending",
        params: { session_id: "session-1" },
      },
    ]);
    expect(result).toEqual({
      approvals: [
        {
          id: "approval-1",
          summary: "write_file path=\"notes.md\"",
          risk: "medium",
          category: "filesystem_write",
          reason: "File write/edit/delete tools can modify workspace state.",
        },
      ],
    });
  });
});
