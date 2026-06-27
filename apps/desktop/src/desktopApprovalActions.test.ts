import { describe, expect, test, vi } from "vitest";
import {
  nativeApprovalRefreshOptions,
  submitDesktopApprovalAction,
  summarizeDesktopApprovalResumeResult,
} from "./desktopApprovalActions";

describe("desktop approval actions", () => {
  test("resumes native worker approvals before using WebUI approval routes", async () => {
    const resumeResult = { sessionId: "WebSocket:chat-1", approval: { id: "approval-1" }, result: { finalOutput: "你好" } };
    const invoke = vi.fn(async () => resumeResult);
    const gatewayTools = {
      approveApproval: vi.fn(async () => ({})),
      denyApproval: vi.fn(async () => ({})),
    };

    const result = await submitDesktopApprovalAction({
      action: "approveOnce",
      approvalId: "approval-1",
      gatewayTools,
      invoke,
      preferNativeWorkerResume: true,
      sessionKey: "WebSocket:chat-1",
    });

    expect(invoke).toHaveBeenCalledWith("worker_resume_agent_approval", {
      input: {
        approvalId: "approval-1",
        approved: true,
        scope: "once",
        sessionId: "WebSocket:chat-1",
      },
    });
    expect(gatewayTools.approveApproval).not.toHaveBeenCalled();
    expect(gatewayTools.denyApproval).not.toHaveBeenCalled();
    expect(result).toBe(resumeResult);
  });

  test("reports native resume attempts and gateway fallback", async () => {
    const error = new Error("native command unavailable");
    const invoke = vi.fn(async () => {
      throw error;
    });
    const gatewayTools = {
      approveApproval: vi.fn(async () => ({})),
      denyApproval: vi.fn(async () => ({})),
    };
    const onNativeResumeAttempt = vi.fn();
    const onNativeResumeFailed = vi.fn();
    const onGatewayFallback = vi.fn();

    await submitDesktopApprovalAction({
      action: "deny",
      approvalId: "approval-1",
      gatewayTools,
      invoke,
      onGatewayFallback,
      onNativeResumeAttempt,
      onNativeResumeFailed,
      preferNativeWorkerResume: true,
      sessionKey: "WebSocket:chat-1",
    });

    expect(onNativeResumeAttempt).toHaveBeenCalledWith({
      action: "deny",
      approvalId: "approval-1",
      approved: false,
      scope: "once",
      sessionKey: "WebSocket:chat-1",
    });
    expect(onNativeResumeFailed).toHaveBeenCalledWith(error);
    expect(onGatewayFallback).toHaveBeenCalledWith({
      action: "deny",
      approvalId: "approval-1",
      approved: false,
      scope: "once",
      sessionKey: "WebSocket:chat-1",
    });
    expect(gatewayTools.denyApproval).toHaveBeenCalledWith("approval-1", {
      session_key: "WebSocket:chat-1",
      auto_retry: true,
    });
  });

  test("builds native approval refresh options from active chat context", () => {
    expect(nativeApprovalRefreshOptions({
      activeChatId: "chat-1",
      activeSessionKey: "WebSocket:chat-1",
    })).toEqual({ sessionKey: "WebSocket:chat-1" });
    expect(nativeApprovalRefreshOptions({
      activeChatId: "chat-1",
      activeSessionKey: "",
    })).toEqual({ chatId: "chat-1", channel: "websocket" });
    expect(nativeApprovalRefreshOptions({
      activeChatId: "",
      activeSessionKey: "",
    })).toBeUndefined();
  });

  test("summarizes native resume results for diagnostics", () => {
    expect(summarizeDesktopApprovalResumeResult({
      sessionId: "WebSocket:chat-1",
      approval: { id: "approval-1" },
      checkpoint: { checkpointId: "checkpoint-1" },
      result: {
        finalOutput: "Subagent said hello",
        stopReason: "stop",
      },
    })).toEqual({
      hasApproval: true,
      hasCheckpoint: true,
      hasResult: true,
      resultPreview: "Subagent said hello",
      resultStopReason: "stop",
      sessionId: "WebSocket:chat-1",
    });
  });
});
