export type NormalizedToolStatus = {
  approvalStatus?: string;
  pendingApproval: boolean;
  status: string;
};

export type ToolStatusTone = "pending" | "running" | "success" | "error" | "denied";

export function normalizeToolStatus(input: { approvalStatus?: string; status?: string }): NormalizedToolStatus {
  const approvalStatus = normalizeRawStatus(input.approvalStatus);
  const status = normalizeRawStatus(input.status);
  if (["denied", "rejected"].includes(approvalStatus)) {
    return { approvalStatus, pendingApproval: false, status: "denied" };
  }
  if (["cancelled", "canceled"].includes(approvalStatus)) {
    return { approvalStatus, pendingApproval: false, status: "cancelled" };
  }
  if (isPendingApprovalValue(approvalStatus) || status === "blocked") {
    return { approvalStatus, pendingApproval: true, status: "blocked" };
  }
  if (status) {
    return { approvalStatus, pendingApproval: false, status: normalizeExecutionStatus(status) };
  }
  if (approvalStatus === "approved") {
    return { approvalStatus, pendingApproval: false, status: "completed" };
  }
  return { approvalStatus, pendingApproval: false, status: "pending" };
}

export function isPendingToolApproval(input: { approvalStatus?: string; status?: string }): boolean {
  return normalizeToolStatus(input).pendingApproval;
}

export function getToolStatusLabel(status: NormalizedToolStatus): string {
  if (status.pendingApproval) {
    return "Pending approval";
  }
  const labels: Record<string, string> = {
    blocked: "Pending approval",
    cancelled: "Cancelled",
    completed: "Completed",
    denied: "Denied",
    failed: "Failed",
    pending: "Pending",
    running: "Running",
  };
  return labels[status.status] || titleCase(status.status);
}

export function getToolStatusTone(status: NormalizedToolStatus): ToolStatusTone {
  if (status.status === "completed") {
    return "success";
  }
  if (status.status === "failed") {
    return "error";
  }
  if (status.status === "running") {
    return "running";
  }
  if (status.status === "denied" || status.status === "cancelled") {
    return "denied";
  }
  return "pending";
}

export function formatMaybeJson(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return value;
  }
}

function normalizeRawStatus(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
}

function normalizeExecutionStatus(status: string): string {
  if (["running", "in_progress", "started", "streaming"].includes(status)) {
    return "running";
  }
  if (["completed", "complete", "success", "succeeded", "ok", "done", "approved"].includes(status)) {
    return "completed";
  }
  if (["failed", "failure", "error", "errored"].includes(status)) {
    return "failed";
  }
  if (["denied", "rejected"].includes(status)) {
    return "denied";
  }
  if (["cancelled", "canceled", "interrupted", "stopped"].includes(status)) {
    return "cancelled";
  }
  if (["blocked", "approval_required", "waiting_approval", "pending_approval"].includes(status)) {
    return "blocked";
  }
  if (["pending", "queued", "created", "waiting"].includes(status)) {
    return "pending";
  }
  return status;
}

function isPendingApprovalValue(status: string): boolean {
  return ["approval_required", "waiting_approval", "pending_approval"].includes(status);
}

function titleCase(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
