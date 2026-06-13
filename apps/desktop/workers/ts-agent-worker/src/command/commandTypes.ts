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
  version?: string;
  model?: string;
  startTimeMs?: number;
  nowMs?: number;
  lastUsage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cached_tokens?: number;
  };
  contextWindowTokens?: number;
  sessionMessageCount?: number;
  contextTokensEstimate?: number;
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

export type ArchiveSessionCommandResult = {
  messageCount: number;
  evidenceCount: number;
  skippedReason?: string;
  error?: string;
};

export type ClearTemporaryFilesCommandResult = {
  cleared?: number;
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

export type DreamCommandRequest = {
  traceId: string;
  sessionId: string | undefined;
};

export type DreamLogCommandRequest = DreamCommandRequest & {
  sha?: string;
};

export type DreamRestoreCommandRequest = DreamCommandRequest & {
  sha?: string;
};

export type DreamCommandResult = {
  content: string;
  metadata?: Record<string, unknown>;
};

export type CommandCapabilities = {
  cancelActiveRunsForSession?: (sessionId: string | undefined) => Promise<CancelActiveRunsResult> | CancelActiveRunsResult;
  getStatusSnapshot?: (context: CommandContext) => Promise<CommandStatusSnapshot> | CommandStatusSnapshot;
  requestRestart?: (request: RestartCommandRequest) => Promise<void> | void;
  archiveSessionBeforeClear?: (
    sessionId: string | undefined,
    traceId: string,
  ) => Promise<ArchiveSessionCommandResult> | ArchiveSessionCommandResult;
  clearSession?: (sessionId: string | undefined, traceId: string) => Promise<ClearSessionCommandResult> | ClearSessionCommandResult;
  clearTemporaryFiles?: (
    sessionId: string | undefined,
    traceId: string,
  ) => Promise<ClearTemporaryFilesCommandResult> | ClearTemporaryFilesCommandResult;
  listPendingApprovals?: (sessionId: string | undefined, traceId: string) => Promise<PendingApprovalListResult> | PendingApprovalListResult;
  resolvePendingApproval?: (request: ResolvePendingApprovalRequest) => Promise<ResolvePendingApprovalResult> | ResolvePendingApprovalResult;
  runDream?: (request: DreamCommandRequest) => Promise<DreamCommandResult> | DreamCommandResult;
  getDreamLog?: (request: DreamLogCommandRequest) => Promise<DreamCommandResult> | DreamCommandResult;
  restoreDream?: (request: DreamRestoreCommandRequest) => Promise<DreamCommandResult> | DreamCommandResult;
};

export type CommandResult = {
  handled: boolean;
  output?: string;
  metadata?: Record<string, unknown>;
};

export type CommandHandler = (context: CommandContext) => Promise<CommandResult> | CommandResult;
