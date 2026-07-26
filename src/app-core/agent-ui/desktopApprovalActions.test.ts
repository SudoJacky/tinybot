import { describe, expect, test, vi } from "vitest";
import {
  gatewayCompatibleApprovalSessionKey,
  nativeApprovalRefreshOptions,
  submitDesktopApprovalAction,
} from "./desktopApprovalActions";

describe("desktop approval actions", () => {
  test("submits approvals through the gateway", async () => {
    const gatewayResult = { approved: true };
    const gatewayTools = {
      approveApproval: vi.fn(async () => gatewayResult),
      denyApproval: vi.fn(async () => ({})),
    };

    await expect(submitDesktopApprovalAction({
      action: "approveOnce",
      approvalId: "approval-1",
      gatewayTools,
      sessionKey: "WebSocket:chat-1",
    })).resolves.toBe(gatewayResult);

    expect(gatewayTools.approveApproval).toHaveBeenCalledWith("approval-1", {
      session_key: "websocket:chat-1",
      scope: "once",
      auto_retry: true,
    });
    expect(gatewayTools.denyApproval).not.toHaveBeenCalled();
  });

  test("passes denial guidance through the gateway", async () => {
    const gatewayTools = {
      approveApproval: vi.fn(async () => ({})),
      denyApproval: vi.fn(async () => ({})),
    };

    await submitDesktopApprovalAction({
      action: "deny",
      approvalId: "approval-1",
      gatewayTools,
      guidance: "Do not write files; summarize instead.",
      sessionKey: "WebSocket:chat-1",
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

  test("builds approval refresh options from active chat context", () => {
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
});
