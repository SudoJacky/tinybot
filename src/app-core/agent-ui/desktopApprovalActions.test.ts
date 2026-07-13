import { describe, expect, test, vi } from "vitest";
import {
  gatewayCompatibleApprovalSessionKey,
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
        sessionId: "websocket:chat-1",
      },
    });
    expect(gatewayTools.approveApproval).not.toHaveBeenCalled();
    expect(gatewayTools.denyApproval).not.toHaveBeenCalled();
    expect(result).toBe(resumeResult);
  });

  test("normalizes synthetic WebSocket approval session keys for native worker resume", async () => {
    const invoke = vi.fn(async () => ({ sessionId: "websocket:chat-1" }));
    const gatewayTools = {
      approveApproval: vi.fn(async () => ({})),
      denyApproval: vi.fn(async () => ({})),
    };
    const onNativeResumeAttempt = vi.fn();

    await submitDesktopApprovalAction({
      action: "approveOnce",
      approvalId: "approval-1",
      gatewayTools,
      invoke,
      onNativeResumeAttempt,
      preferNativeWorkerResume: true,
      sessionKey: "WebSocket:chat-1",
    });

    expect(onNativeResumeAttempt).toHaveBeenCalledWith({
      action: "approveOnce",
      approvalId: "approval-1",
      approved: true,
      scope: "once",
      sessionKey: "websocket:chat-1",
    });
    expect(invoke).toHaveBeenCalledWith("worker_resume_agent_approval", {
      input: {
        approvalId: "approval-1",
        approved: true,
        scope: "once",
        sessionId: "websocket:chat-1",
      },
    });
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
      sessionKey: "websocket:chat-1",
    });
    expect(onNativeResumeFailed).toHaveBeenCalledWith(error);
    expect(onGatewayFallback).toHaveBeenCalledWith({
      action: "deny",
      approvalId: "approval-1",
      approved: false,
      scope: "once",
      sessionKey: "websocket:chat-1",
    });
    expect(gatewayTools.denyApproval).toHaveBeenCalledWith("approval-1", {
      session_key: "websocket:chat-1",
      auto_retry: true,
    });
  });

  test("treats a structured native rejection as a failed resume and falls back", async () => {
    const nativeResult = {
      ok: false,
      status: "not_found",
      error: { message: "pending approval not found" },
    };
    const invoke = vi.fn(async () => nativeResult);
    const gatewayResult = { ok: true, status: "approved" };
    const gatewayTools = {
      approveApproval: vi.fn(async () => gatewayResult),
      denyApproval: vi.fn(async () => ({})),
    };
    const onNativeResumeFailed = vi.fn();

    await expect(submitDesktopApprovalAction({
      action: "approveOnce",
      approvalId: "approval-1",
      gatewayTools,
      invoke,
      onNativeResumeFailed,
      preferNativeWorkerResume: true,
      sessionKey: "websocket:chat-1",
    })).resolves.toBe(gatewayResult);

    expect(onNativeResumeFailed).toHaveBeenCalledWith(expect.objectContaining({
      message: "pending approval not found",
    }));
    expect(gatewayTools.approveApproval).toHaveBeenCalledWith("approval-1", {
      session_key: "websocket:chat-1",
      scope: "once",
      auto_retry: true,
    });
  });

  test("passes denial guidance through native resume and gateway fallback", async () => {
    const error = new Error("native command unavailable");
    const invoke = vi.fn(async () => {
      throw error;
    });
    const gatewayTools = {
      approveApproval: vi.fn(async () => ({})),
      denyApproval: vi.fn(async () => ({})),
    };

    await submitDesktopApprovalAction({
      action: "deny",
      approvalId: "approval-1",
      gatewayTools,
      guidance: "Do not write files; summarize instead.",
      invoke,
      preferNativeWorkerResume: true,
      sessionKey: "WebSocket:chat-1",
    });

    expect(invoke).toHaveBeenCalledWith("worker_resume_agent_approval", {
      input: {
        approvalId: "approval-1",
        approved: false,
        guidance: "Do not write files; summarize instead.",
        scope: "once",
        sessionId: "websocket:chat-1",
      },
    });
    expect(gatewayTools.denyApproval).toHaveBeenCalledWith("approval-1", {
      session_key: "websocket:chat-1",
      auto_retry: true,
      guidance: "Do not write files; summarize instead.",
    });
  });

  test("normalizes synthetic WebSocket approval session keys for gateway-compatible routes", async () => {
    const gatewayTools = {
      approveApproval: vi.fn(async () => ({ approved: true })),
      denyApproval: vi.fn(async () => ({})),
    };

    await submitDesktopApprovalAction({
      action: "approveSession",
      approvalId: "approval-1",
      gatewayTools,
      preferNativeWorkerResume: false,
      sessionKey: "WebSocket:chat-1",
    });

    expect(gatewayCompatibleApprovalSessionKey("WebSocket:chat-1")).toBe("websocket:chat-1");
    expect(gatewayCompatibleApprovalSessionKey("ts-agent:chat-1")).toBe("ts-agent:chat-1");
    expect(gatewayTools.approveApproval).toHaveBeenCalledWith("approval-1", {
      session_key: "websocket:chat-1",
      scope: "session",
      auto_retry: true,
    });
  });

  test("builds native approval refresh options from active chat context", () => {
    expect(nativeApprovalRefreshOptions({
      activeChatId: "chat-1",
      activeSessionKey: "WebSocket:chat-1",
    })).toEqual({ sessionKey: "websocket:chat-1" });
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
