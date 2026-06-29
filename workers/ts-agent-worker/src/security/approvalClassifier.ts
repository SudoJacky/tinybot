import type { ApprovalCategory, ApprovalClassification, ApprovalRisk } from "./approvalTypes.ts";
import { isLowRiskExec } from "./approvalPolicy.ts";

export type ToolApprovalMetadata = {
  toolName: string;
  args: Record<string, unknown>;
  readOnly?: boolean;
  requiresApproval?: boolean;
  approvalCategory?: ApprovalCategory;
  approvalRisk?: ApprovalRisk;
};

export function classifyToolCall(metadata: ToolApprovalMetadata): ApprovalClassification {
  const { toolName, args } = metadata;

  if (toolName.startsWith("mcp_")) {
    return requireApproval("mcp", "high", "MCP tools are externally supplied capabilities and may have side effects.");
  }

  if (toolName === "request_form") {
    return { action: "allow" };
  }

  if (metadata.readOnly === true) {
    return { action: "allow" };
  }

  if (toolName === "exec") {
    const command = String(args.command ?? "");
    if (isLowRiskExec(command)) {
      return { action: "allow" };
    }
    return requireApproval("shell", "high", "Shell execution can modify files, run programs, or access the network.");
  }

  if (toolName === "write_file" || toolName === "edit_file" || toolName === "delete_file") {
    return requireApproval("filesystem_write", "medium", "File write/edit/delete tools can modify workspace state.");
  }

  if (toolName === "cron" || toolName === "task" || toolName === "spawn") {
    return requireApproval("agent_control", "high", "Agent control tools can create background or delegated execution.");
  }

  if (
    toolName === "add_document" ||
    toolName === "delete_document" ||
    toolName === "delete_experience" ||
    toolName === "save_experience"
  ) {
    return requireApproval("persistent_data", "medium", "This tool modifies persistent agent data.");
  }

  if (toolName === "message") {
    return requireApproval("external_message", "medium", "Message tool can send content to an external channel.");
  }

  if (metadata.requiresApproval === true) {
    return requireApproval(
      metadata.approvalCategory ?? "tool",
      riskRequiringApproval(metadata.approvalRisk),
      "This tool requires user approval before execution.",
    );
  }

  return requireApproval("tool", "medium", "This tool is not marked read-only and may have side effects.");
}

function requireApproval(
  category: ApprovalCategory,
  risk: Extract<ApprovalRisk, "medium" | "high">,
  reason: string,
): ApprovalClassification {
  return {
    action: "require_approval",
    category,
    risk,
    reason,
  };
}

function riskRequiringApproval(risk: ApprovalRisk | undefined): Extract<ApprovalRisk, "medium" | "high"> {
  return risk === "high" ? "high" : "medium";
}
