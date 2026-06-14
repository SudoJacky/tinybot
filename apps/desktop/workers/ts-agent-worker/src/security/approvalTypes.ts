export type ApprovalAction = "allow" | "require_approval";

export type ApprovalScope = "once" | "session";

export type ApprovalCategory =
  | "shell"
  | "filesystem_write"
  | "agent_control"
  | "mcp"
  | "persistent_data"
  | "external_message"
  | "tool";

export type ApprovalRisk = "low" | "medium" | "high";

export type ApprovalClassification =
  | { action: "allow" }
  | {
      action: "require_approval";
      category: ApprovalCategory;
      risk: Extract<ApprovalRisk, "medium" | "high">;
      reason: string;
    };

export type RequiredApprovalClassification = Extract<ApprovalClassification, { action: "require_approval" }>;

export type ApprovalRequestPayload = {
  runId: string;
  sessionId?: string;
  operation: {
    toolName: string;
    arguments: Record<string, unknown>;
    toolCallId?: string;
  };
  classification: RequiredApprovalClassification;
  fingerprint: string;
  sessionFingerprint: string;
  summary: string;
};
