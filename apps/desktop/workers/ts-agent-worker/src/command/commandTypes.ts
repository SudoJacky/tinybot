export type CommandContext = {
  traceId: string;
  sessionId?: string;
  runId?: string;
  raw: string;
  command: string;
  args: string;
  priority: boolean;
};

export type CancelActiveRunsResult = {
  cancelledCount: number;
  runIds: string[];
};

export type CommandStatusSnapshot = {
  activeRunCount: number;
  activeSessionRunCount: number;
  sessionId?: string;
};

export type RestartCommandRequest = {
  traceId: string;
  sessionId?: string;
  runId?: string;
};

export type ClearSessionCommandResult = {
  sessionId: string;
  messagesBefore: number;
  messagesAfter: number;
  checkpointCleared: boolean;
};

export type PendingApprovalSummary = {
  id: string;
  summary: string;
  risk: string;
  category: string;
  reason: string;
};

export type PendingApprovalListResult = {
  approvals: PendingApprovalSummary[];
};

export type ResolvePendingApprovalRequest = {
  traceId: string;
  sessionId: string | undefined;
  approvalId: string;
  approved: boolean;
  scope?: "once" | "session";
};

export type ResolvePendingApprovalResult = {
  resolved: boolean;
  approvalId: string;
  approved: boolean;
  summary?: string;
  scope?: "once" | "session";
};

export type CommandCapabilities = {
  cancelActiveRunsForSession?: (sessionId: string | undefined) => Promise<CancelActiveRunsResult> | CancelActiveRunsResult;
  getStatusSnapshot?: (context: CommandContext) => Promise<CommandStatusSnapshot> | CommandStatusSnapshot;
  requestRestart?: (request: RestartCommandRequest) => Promise<void> | void;
  clearSession?: (sessionId: string | undefined, traceId: string) => Promise<ClearSessionCommandResult> | ClearSessionCommandResult;
  listPendingApprovals?: (sessionId: string | undefined, traceId: string) => Promise<PendingApprovalListResult> | PendingApprovalListResult;
  resolvePendingApproval?: (request: ResolvePendingApprovalRequest) => Promise<ResolvePendingApprovalResult> | ResolvePendingApprovalResult;
};

export type CommandResult = {
  handled: boolean;
  output?: string;
  metadata?: Record<string, unknown>;
};

export type CommandHandler = (context: CommandContext) => Promise<CommandResult> | CommandResult;
