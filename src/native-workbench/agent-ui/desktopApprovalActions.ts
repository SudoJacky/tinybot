export type DesktopApprovalAction = "approveOnce" | "approveSession" | "deny";

export type DesktopApprovalGatewayTools = {
  approveApproval(approvalId: string, body: unknown): Promise<unknown> | unknown;
  denyApproval(approvalId: string, body: unknown): Promise<unknown> | unknown;
};

export type SubmitDesktopApprovalActionOptions = {
  action: DesktopApprovalAction;
  approvalId: string;
  gatewayTools: DesktopApprovalGatewayTools;
  invoke?: (command: string, args?: DesktopApprovalResumeArgs) => Promise<unknown> | unknown;
  onGatewayFallback?: (context: DesktopApprovalActionContext) => void;
  onNativeResumeAttempt?: (context: DesktopApprovalActionContext) => void;
  onNativeResumeFailed?: (error: unknown) => void;
  onNativeResumeSucceeded?: (context: DesktopApprovalActionContext, result: unknown) => void;
  preferNativeWorkerResume?: boolean;
  sessionKey: string;
};

export type DesktopApprovalActionContext = {
  action: DesktopApprovalAction;
  approvalId: string;
  approved: boolean;
  scope: "once" | "session";
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

type DesktopApprovalResumeArgs = {
  input: {
    approvalId: string;
    approved: boolean;
    scope: "once" | "session";
    sessionId: string;
  };
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

export type DesktopApprovalResumeResultSummary = {
  hasApproval: boolean;
  hasCheckpoint: boolean;
  hasResult: boolean;
  resultPreview: string;
  resultStopReason: string;
  sessionId: string;
};

export function summarizeDesktopApprovalResumeResult(result: unknown): DesktopApprovalResumeResultSummary {
  const record = isRecord(result) ? result : {};
  const nestedResult = record.result;
  const nestedRecord = isRecord(nestedResult) ? nestedResult : {};
  return {
    hasApproval: Boolean(record.approval),
    hasCheckpoint: Boolean(record.checkpoint),
    hasResult: nestedResult !== undefined && nestedResult !== null,
    resultPreview: summarizeResumeText(resultPreviewValue(nestedResult)),
    resultStopReason: stringValue(nestedRecord.stopReason ?? nestedRecord.stop_reason ?? nestedRecord.status),
    sessionId: stringValue(record.sessionId ?? record.session_id),
  };
}

export async function submitDesktopApprovalAction(options: SubmitDesktopApprovalActionOptions): Promise<unknown> {
  const approved = options.action !== "deny";
  const scope = options.action === "approveSession" ? "session" : "once";
  const compatibleSessionKey = gatewayCompatibleApprovalSessionKey(options.sessionKey);
  const context: DesktopApprovalActionContext = {
    action: options.action,
    approvalId: options.approvalId,
    approved,
    scope,
    sessionKey: compatibleSessionKey,
  };
  if (options.preferNativeWorkerResume && options.invoke) {
    try {
      options.onNativeResumeAttempt?.(context);
      const result = await options.invoke("worker_resume_agent_approval", {
        input: {
          sessionId: compatibleSessionKey,
          approvalId: options.approvalId,
          approved,
          scope,
        },
      });
      options.onNativeResumeSucceeded?.(context, result);
      return result;
    } catch (error) {
      options.onNativeResumeFailed?.(error);
      // Fall through to WebUI/gateway approval routes for non-native approvals.
    }
  }
  const gatewaySessionKey = compatibleSessionKey;
  const gatewayContext = gatewaySessionKey === options.sessionKey
    ? context
    : { ...context, sessionKey: gatewaySessionKey };
  options.onGatewayFallback?.(gatewayContext);
  if (!approved) {
    await options.gatewayTools.denyApproval(options.approvalId, {
      session_key: gatewaySessionKey,
      auto_retry: true,
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

function resultPreviewValue(result: unknown): unknown {
  if (typeof result === "string") {
    return result;
  }
  if (!isRecord(result)) {
    return "";
  }
  return result.finalOutput
    ?? result.final_output
    ?? result.content
    ?? result.message
    ?? result.output
    ?? result.text
    ?? "";
}

function summarizeResumeText(value: unknown): string {
  const text = stringValue(value).trim().replace(/\s+/g, " ");
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
