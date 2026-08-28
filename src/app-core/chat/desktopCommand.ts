import type { AgentInputReference } from "./agentInputReference";
import type { ReasoningEffort } from "./reasoningEffort";
import type { ThreadCommand, ThreadCommandSource } from "./threadCommand";

export type DesktopChatInput = {
  text: string;
  model?: string;
  provider?: string;
  reasoningEffort?: ReasoningEffort;
  references?: AgentInputReference[];
  selectedSkills?: string[];
  selectedTools?: string[];
};

export type DesktopTurnSubmitCommand = {
  schemaVersion: "tinybot.command.v1";
  commandId: string;
  issuedAt: string;
  kind: "turn.submit";
  source: ThreadCommandSource;
  target: { sessionId: string };
  input: DesktopChatInput;
};

export type DesktopStopCommand = {
  schemaVersion: "tinybot.command.v1";
  commandId: string;
  issuedAt: string;
  kind: "agent.stop";
  source: ThreadCommandSource;
  target: { sessionId: string };
};

export type DesktopCompactCommand = {
  schemaVersion: "tinybot.command.v1";
  commandId: string;
  issuedAt: string;
  kind: "context.compact";
  source: ThreadCommandSource;
  target: { sessionId: string };
};

export type DesktopCommand = DesktopTurnSubmitCommand | DesktopStopCommand | DesktopCompactCommand | ThreadCommand;

export function createDesktopTurnSubmitCommand(input: {
  commandId?: string;
  issuedAt?: string;
  message: DesktopChatInput;
  sessionId: string;
  source: ThreadCommandSource;
}): DesktopTurnSubmitCommand {
  return {
    schemaVersion: "tinybot.command.v1",
    commandId: input.commandId ?? createDesktopCommandId(),
    issuedAt: input.issuedAt ?? new Date().toISOString(),
    kind: "turn.submit",
    source: input.source,
    target: { sessionId: input.sessionId },
    input: input.message,
  };
}

export function createDesktopStopCommand(input: {
  commandId?: string;
  issuedAt?: string;
  sessionId: string;
  source: ThreadCommandSource;
}): DesktopStopCommand {
  return {
    schemaVersion: "tinybot.command.v1",
    commandId: input.commandId ?? createDesktopCommandId(),
    issuedAt: input.issuedAt ?? new Date().toISOString(),
    kind: "agent.stop",
    source: input.source,
    target: { sessionId: input.sessionId },
  };
}

export function createDesktopCompactCommand(input: {
  commandId?: string;
  issuedAt?: string;
  sessionId: string;
  source: ThreadCommandSource;
}): DesktopCompactCommand {
  return {
    schemaVersion: "tinybot.command.v1",
    commandId: input.commandId ?? createDesktopCommandId(),
    issuedAt: input.issuedAt ?? new Date().toISOString(),
    kind: "context.compact",
    source: input.source,
    target: { sessionId: input.sessionId },
  };
}

function createDesktopCommandId(): string {
  return `desktop-command-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
