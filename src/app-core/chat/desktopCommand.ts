import type { NativeChatReference } from "./nativeChat";
import type { TinyOsCommand, TinyOsCommandSource } from "./tinyOsCommandGateway";

export type DesktopChatInput = {
  text: string;
  model?: string;
  references?: NativeChatReference[];
  usePersistentRag?: boolean;
};

export type DesktopTurnSubmitCommand = {
  schemaVersion: "tinybot.command.v1";
  commandId: string;
  issuedAt: string;
  kind: "turn.submit";
  source: TinyOsCommandSource;
  target: { sessionId: string };
  input: DesktopChatInput;
};

export type DesktopStopCommand = {
  schemaVersion: "tinybot.command.v1";
  commandId: string;
  issuedAt: string;
  kind: "agent.stop";
  source: TinyOsCommandSource;
  target: { sessionId: string };
};

export type DesktopCommand = DesktopTurnSubmitCommand | DesktopStopCommand | TinyOsCommand;

export function createDesktopTurnSubmitCommand(input: {
  commandId?: string;
  issuedAt?: string;
  message: DesktopChatInput;
  sessionId: string;
  source: TinyOsCommandSource;
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
  source: TinyOsCommandSource;
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

function createDesktopCommandId(): string {
  return `desktop-command-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
