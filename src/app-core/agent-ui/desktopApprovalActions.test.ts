import { describe, expect, test, vi } from "vitest";
import {
  nativeApprovalRefreshOptions,
  normalizeApprovalSessionKey,
  submitDesktopApprovalAction,
} from "./desktopApprovalActions";

describe("desktop approval actions", () => {
  test("submits approvals through the approval tools", async () => {
    const approvalResult = { approved: true };
    const tools = {
      approveApproval: vi.fn(async () => approvalResult),
      denyApproval: vi.fn(async () => ({})),
    };

    await expect(submitDesktopApprovalAction({
      action: "approveOnce",
      approvalId: "approval-1",
      tools,
      sessionKey: "WebSocket:chat-1",
    })).resolves.toBe(approvalResult);

    expect(tools.approveApproval).toHaveBeenCalledWith("approval-1", {
      session_key: "websocket:chat-1",
      scope: "once",
      auto_retry: true,
    });
    expect(tools.denyApproval).not.toHaveBeenCalled();
  });

  test("passes denial guidance through the approval tools", async () => {
    const tools = {
      approveApproval: vi.fn(async () => ({})),
      denyApproval: vi.fn(async () => ({})),
    };

    await submitDesktopApprovalAction({
      action: "deny",
      approvalId: "approval-1",
      tools,
      guidance: "Do not write files; summarize instead.",
      sessionKey: "WebSocket:chat-1",
    });

    expect(tools.denyApproval).toHaveBeenCalledWith("approval-1", {
      session_key: "websocket:chat-1",
      auto_retry: true,
      guidance: "Do not write files; summarize instead.",
    });
  });

  test("normalizes synthetic WebSocket approval session keys for compatible routes", async () => {
    const tools = {
      approveApproval: vi.fn(async () => ({ approved: true })),
      denyApproval: vi.fn(async () => ({})),
    };

    await submitDesktopApprovalAction({
      action: "approveSession",
      approvalId: "approval-1",
      tools,
      sessionKey: "WebSocket:chat-1",
    });

    expect(normalizeApprovalSessionKey("WebSocket:chat-1")).toBe("websocket:chat-1");
    expect(normalizeApprovalSessionKey("ts-agent:chat-1")).toBe("ts-agent:chat-1");
    expect(tools.approveApproval).toHaveBeenCalledWith("approval-1", {
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
