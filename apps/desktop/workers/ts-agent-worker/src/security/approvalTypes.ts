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
