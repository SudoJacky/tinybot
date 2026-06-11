import type { CommandContext, CommandHandler, CommandResult } from "./commandTypes.ts";

export type DispatchCommandOptions = {
  traceId: string;
  sessionId?: string;
  runId?: string;
};

type CommandEntry = {
  command: string;
  key: string;
  handler: CommandHandler;
};

export class CommandRouter {
  private readonly priorityHandlers = new Map<string, CommandEntry>();
  private readonly exactHandlers = new Map<string, CommandEntry>();
  private readonly prefixHandlers: CommandEntry[] = [];
  private interceptor?: CommandHandler;

  priority(command: string, handler: CommandHandler): void {
    const normalized = normalizeCommand(command);
    this.priorityHandlers.set(normalized.key, { ...normalized, handler });
  }

  exact(command: string, handler: CommandHandler): void {
    const normalized = normalizeCommand(command);
    this.exactHandlers.set(normalized.key, { ...normalized, handler });
  }

  prefix(command: string, handler: CommandHandler): void {
    const normalized = normalizeCommand(command);
    this.prefixHandlers.push({ ...normalized, handler });
    this.prefixHandlers.sort((left, right) => right.key.length - left.key.length);
  }

  intercept(handler: CommandHandler): void {
    this.interceptor = handler;
  }

  isPriority(input: string): boolean {
    const parsed = parseCommandInput(input);
    return parsed ? this.priorityHandlers.has(parsed.commandKey) : false;
  }

  async dispatch(input: string, options: DispatchCommandOptions): Promise<CommandResult> {
    const parsed = parseCommandInput(input);
    if (!parsed) {
      return { handled: false };
    }

    const priority = this.priorityHandlers.get(parsed.commandKey);
    if (priority) {
      return priority.handler(contextFor(priority.command, parsed, options, true));
    }

    const exact = this.exactHandlers.get(parsed.commandKey);
    if (exact) {
      return exact.handler(contextFor(parsed.command, parsed, options, false));
    }

    const prefix = this.prefixHandlers.find((entry) => prefixMatches(parsed.rawKey, entry.key));
    if (prefix) {
      return prefix.handler(contextFor(prefix.command, parsed, options, false));
    }

    if (this.interceptor) {
      return this.interceptor(contextFor(parsed.command, parsed, options, false));
    }
    return { handled: false };
  }
}

function contextFor(
  command: string,
  parsed: ParsedCommandInput,
  options: DispatchCommandOptions,
  priority: boolean,
): CommandContext {
  const args = parsed.raw.trim().slice(command.length).trim();
  return {
    traceId: options.traceId,
    sessionId: options.sessionId,
    runId: options.runId,
    raw: parsed.raw,
    command,
    args,
    priority,
  };
}

type ParsedCommandInput = {
  raw: string;
  rawKey: string;
  command: string;
  commandKey: string;
};

function parseCommandInput(input: string): ParsedCommandInput | undefined {
  const raw = input.trim();
  if (!raw.startsWith("/")) {
    return undefined;
  }
  const command = raw.split(/\s+/, 1)[0] ?? "";
  if (command.length <= 1) {
    return undefined;
  }
  return {
    raw,
    rawKey: raw.toLocaleLowerCase(),
    command,
    commandKey: command.toLocaleLowerCase(),
  };
}

function normalizeCommand(command: string): { command: string; key: string } {
  const normalized = command.trim();
  if (!normalized.startsWith("/") || normalized.length <= 1) {
    throw new Error("command must start with / and include a name");
  }
  return {
    command: normalized,
    key: normalized.toLocaleLowerCase(),
  };
}

function prefixMatches(rawKey: string, prefixKey: string): boolean {
  return rawKey === prefixKey || rawKey.startsWith(`${prefixKey} `);
}
