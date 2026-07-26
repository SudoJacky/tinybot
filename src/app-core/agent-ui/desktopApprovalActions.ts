export type DesktopApprovalAction = "approveOnce" | "approveSession" | "deny";

export type DesktopApprovalGatewayTools = {
  approveApproval(approvalId: string, body: unknown): Promise<unknown> | unknown;
  denyApproval(approvalId: string, body: unknown): Promise<unknown> | unknown;
};

export type SubmitDesktopApprovalActionOptions = {
  action: DesktopApprovalAction;
  approvalId: string;
  gatewayTools: DesktopApprovalGatewayTools;
  guidance?: string;
  sessionKey: string;
};

export type DesktopApprovalRefreshOptions = {
  channel?: string;
  chatId?: string;
  sessionKey?: string;
};

export type DesktopApprovalRefreshContext = {
  activeChatId?: string;
  activeSessionKey?: string;
};

export function nativeApprovalRefreshOptions(context: DesktopApprovalRefreshContext): DesktopApprovalRefreshOptions | undefined {
  if (context.activeSessionKey) {
    return { sessionKey: gatewayCompatibleApprovalSessionKey(context.activeSessionKey) };
  }
  if (context.activeChatId) {
    return { chatId: context.activeChatId, channel: "websocket" };
  }
  return undefined;
}

export async function submitDesktopApprovalAction(options: SubmitDesktopApprovalActionOptions): Promise<unknown> {
  const approved = options.action !== "deny";
  const scope = options.action === "approveSession" ? "session" : "once";
  const gatewaySessionKey = gatewayCompatibleApprovalSessionKey(options.sessionKey);
  if (!approved) {
    const guidance = guidanceValue(options.guidance);
    await options.gatewayTools.denyApproval(options.approvalId, {
      session_key: gatewaySessionKey,
      auto_retry: true,
      ...(guidance ? { guidance } : {}),
    });
    return undefined;
  }
  return await options.gatewayTools.approveApproval(options.approvalId, {
    session_key: gatewaySessionKey,
    scope,
    auto_retry: true,
  });
}

export function gatewayCompatibleApprovalSessionKey(sessionKey: string): string {
  return sessionKey.startsWith("WebSocket:")
    ? `websocket:${sessionKey.slice("WebSocket:".length)}`
    : sessionKey;
}

function guidanceValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
