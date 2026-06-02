export type DesktopTaskSource =
  | "chat"
  | "knowledge"
  | "cowork"
  | "provider"
  | "file"
  | "gateway"
  | "approval"
  | "failure";

export type DesktopTaskState = "active" | "completed" | "failed" | "canceled" | "blocked";
export type DesktopTaskTone = "normal" | "attention" | "danger" | "complete" | "muted";
export type DesktopTaskActionId = "retry" | "cancel" | "open" | "inspect" | "dismiss" | "copyDiagnostics";
export type DesktopTaskDestinationModule =
  | "chat"
  | "knowledge"
  | "cowork"
  | "settings"
  | "workspace"
  | "gateway"
  | "approvals";

export interface DesktopTaskDestination {
  module: DesktopTaskDestinationModule;
  entityId?: string;
  href?: string;
}

export type DesktopTaskRelatedResourceKind =
  | "file"
  | "evidence"
  | "tool"
  | "log"
  | "artifact"
  | "provider"
  | "coworkEntity"
  | "diagnostic";

export interface DesktopTaskRelatedResourceInput {
  kind: DesktopTaskRelatedResourceKind;
  id: string;
  title: string;
  detail?: string;
  route: DesktopTaskDestination;
}

export interface DesktopTaskProgress {
  completed?: number;
  total?: number;
  percent?: number;
}

export interface DesktopTaskSourceOperation {
  id: string;
  title: string;
  status: string;
  detail?: string;
  progress?: DesktopTaskProgress;
  canonical: DesktopTaskDestination;
  retryable?: boolean;
  cancelable?: boolean;
  diagnostics?: string;
  relatedResources?: DesktopTaskRelatedResourceInput[];
  outputs?: DesktopTaskRelatedResourceInput[];
  updatedAt?: string;
}

export interface DesktopTaskProjectionInput {
  chatStreams?: DesktopTaskSourceOperation[];
  knowledgeJobs?: DesktopTaskSourceOperation[];
  coworkRuns?: DesktopTaskSourceOperation[];
  providerRefreshes?: DesktopTaskSourceOperation[];
  fileOperations?: DesktopTaskSourceOperation[];
  gatewayOperations?: DesktopTaskSourceOperation[];
  approvals?: DesktopTaskSourceOperation[];
  failures?: DesktopTaskSourceOperation[];
}

export interface DesktopTaskCenterAction {
  id: DesktopTaskActionId;
  label: string;
}

export interface DesktopTaskCenterItem {
  id: string;
  source: DesktopTaskSource;
  title: string;
  state: DesktopTaskState;
  status: string;
  tone: DesktopTaskTone;
  detail: string;
  progress: DesktopTaskProgress | null;
  progressLabel: string;
  destination: DesktopTaskDestination;
  diagnostics: string;
  relatedResources: DesktopTaskRelatedResourceInput[];
  outputs: DesktopTaskRelatedResourceInput[];
  actions: DesktopTaskCenterAction[];
  updatedAt: string;
}

const ACTIVE_STATUSES = new Set(["active", "running", "streaming", "indexing", "starting", "refreshing", "saving", "uploading", "exporting", "pending"]);
const BLOCKED_STATUSES = new Set(["blocked", "waiting", "requires_approval", "approval_required", "requires-approval", "approval-needed", "paused", "intervention-needed", "intervention_needed", "needs_intervention", "needs-intervention"]);
const FAILED_STATUSES = new Set(["failed", "error", "conflict", "rejected", "timeout"]);
const COMPLETED_STATUSES = new Set(["completed", "complete", "done", "success", "succeeded", "saved", "indexed"]);
const CANCELED_STATUSES = new Set(["canceled", "cancelled", "aborted", "stopped"]);
const ACTION_LABELS: Record<DesktopTaskActionId, string> = {
  retry: "Retry",
  cancel: "Cancel",
  open: "Open",
  inspect: "Inspect",
  dismiss: "Dismiss",
  copyDiagnostics: "Copy diagnostics",
};
const SOURCE_ORDER: DesktopTaskSource[] = ["approval", "cowork", "file", "chat", "gateway", "knowledge", "provider", "failure"];
const STATE_ORDER: DesktopTaskState[] = ["blocked", "failed", "active", "canceled", "completed"];

export function buildDesktopTaskCenterItems(input: DesktopTaskProjectionInput): DesktopTaskCenterItem[] {
  return [
    ...projectOperations("chat", input.chatStreams),
    ...projectOperations("knowledge", input.knowledgeJobs),
    ...projectOperations("cowork", input.coworkRuns),
    ...projectOperations("provider", input.providerRefreshes),
    ...projectOperations("file", input.fileOperations),
    ...projectOperations("gateway", input.gatewayOperations),
    ...projectOperations("approval", input.approvals),
    ...projectOperations("failure", input.failures),
  ].sort(compareTaskItems);
}

function projectOperations(source: DesktopTaskSource, operations: DesktopTaskSourceOperation[] = []): DesktopTaskCenterItem[] {
  return operations.map((operation) => {
    const state = normalizeTaskState(operation.status);
    return {
      id: operation.id,
      source,
      title: operation.title,
      state,
      status: operation.status,
      tone: taskTone(state),
      detail: operation.detail ?? "",
      progress: operation.progress ?? null,
      progressLabel: progressLabel(operation.progress),
      destination: operation.canonical,
      diagnostics: operation.diagnostics ?? "",
      relatedResources: operation.relatedResources ?? [],
      outputs: operation.outputs ?? [],
      actions: taskActions(state, operation),
      updatedAt: operation.updatedAt ?? "",
    };
  });
}

function normalizeTaskState(status: string): DesktopTaskState {
  const value = status.trim().toLowerCase();
  if (BLOCKED_STATUSES.has(value)) {
    return "blocked";
  }
  if (FAILED_STATUSES.has(value)) {
    return "failed";
  }
  if (COMPLETED_STATUSES.has(value)) {
    return "completed";
  }
  if (CANCELED_STATUSES.has(value)) {
    return "canceled";
  }
  if (ACTIVE_STATUSES.has(value) || value) {
    return "active";
  }
  return "active";
}

function taskTone(state: DesktopTaskState): DesktopTaskTone {
  if (state === "failed") {
    return "danger";
  }
  if (state === "blocked") {
    return "attention";
  }
  if (state === "completed") {
    return "complete";
  }
  if (state === "canceled") {
    return "muted";
  }
  return "normal";
}

function taskActions(state: DesktopTaskState, operation: DesktopTaskSourceOperation): DesktopTaskCenterAction[] {
  const actions: DesktopTaskActionId[] = [];
  if ((state === "failed" || state === "canceled") && operation.retryable) {
    actions.push("retry");
  }
  if (state === "active" && operation.cancelable) {
    actions.push("cancel");
  }
  actions.push("open");
  if (state !== "completed" && state !== "canceled") {
    actions.push("inspect");
  }
  if (operation.diagnostics) {
    actions.push("copyDiagnostics");
  }
  if (state !== "active" && state !== "blocked") {
    actions.push("dismiss");
  }
  return actions.map((id) => ({ id, label: ACTION_LABELS[id] }));
}

function progressLabel(progress: DesktopTaskProgress | undefined): string {
  if (!progress) {
    return "";
  }
  if (typeof progress.completed === "number" && typeof progress.total === "number") {
    return `${progress.completed}/${progress.total}`;
  }
  if (typeof progress.percent === "number") {
    return `${Math.round(progress.percent)}%`;
  }
  return "";
}

function compareTaskItems(left: DesktopTaskCenterItem, right: DesktopTaskCenterItem): number {
  const state = STATE_ORDER.indexOf(left.state) - STATE_ORDER.indexOf(right.state);
  if (state !== 0) {
    return state;
  }
  const source = SOURCE_ORDER.indexOf(left.source) - SOURCE_ORDER.indexOf(right.source);
  if (source !== 0) {
    return source;
  }
  return left.title.localeCompare(right.title);
}
