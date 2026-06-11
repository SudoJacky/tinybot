export type CommandContext = {
  traceId: string;
  sessionId?: string;
  runId?: string;
  raw: string;
  command: string;
  args: string;
  priority: boolean;
};

export type CommandResult = {
  handled: boolean;
  output?: string;
  metadata?: Record<string, unknown>;
};

export type CommandHandler = (context: CommandContext) => Promise<CommandResult> | CommandResult;
