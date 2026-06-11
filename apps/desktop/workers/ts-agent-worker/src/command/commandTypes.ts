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

export type CommandCapabilities = {
  cancelActiveRunsForSession?: (sessionId: string | undefined) => Promise<CancelActiveRunsResult> | CancelActiveRunsResult;
  getStatusSnapshot?: (context: CommandContext) => Promise<CommandStatusSnapshot> | CommandStatusSnapshot;
};

export type CommandResult = {
  handled: boolean;
  output?: string;
  metadata?: Record<string, unknown>;
};

export type CommandHandler = (context: CommandContext) => Promise<CommandResult> | CommandResult;
