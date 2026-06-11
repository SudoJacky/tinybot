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

export type CommandCapabilities = {
  cancelActiveRunsForSession?: (sessionId: string | undefined) => Promise<CancelActiveRunsResult> | CancelActiveRunsResult;
  getStatusSnapshot?: (context: CommandContext) => Promise<CommandStatusSnapshot> | CommandStatusSnapshot;
  requestRestart?: (request: RestartCommandRequest) => Promise<void> | void;
  clearSession?: (sessionId: string | undefined, traceId: string) => Promise<ClearSessionCommandResult> | ClearSessionCommandResult;
};

export type CommandResult = {
  handled: boolean;
  output?: string;
  metadata?: Record<string, unknown>;
};

export type CommandHandler = (context: CommandContext) => Promise<CommandResult> | CommandResult;
