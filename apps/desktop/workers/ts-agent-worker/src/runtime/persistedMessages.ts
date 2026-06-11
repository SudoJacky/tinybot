import type { AgentMessage } from "../agent/agentRunSpec.ts";
import { RUNTIME_CONTEXT_TAG } from "../agent/contextBuilder.ts";
import { truncateText } from "../support/messageHelpers.ts";

export type PersistedSessionMessagesOptions = {
  maxToolResultChars?: number;
};

export function persistedSessionMessages(
  messages: AgentMessage[],
  options: PersistedSessionMessagesOptions = {},
): AgentMessage[] {
  const seen = new Set<string>();
  const persisted: AgentMessage[] = [];
  for (const message of messages) {
    const next = persistedSessionMessage(message, options);
    if (!next) {
      continue;
    }
    const key = persistedMessageKey(next);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    persisted.push(next);
  }
  return persisted;
}

function persistedSessionMessage(
  message: AgentMessage,
  options: PersistedSessionMessagesOptions,
): AgentMessage | null {
  if (message.role === "system") {
    return null;
  }
  if (message.role === "assistant" && isEmptyAssistantWithoutToolCalls(message)) {
    return null;
  }
  if (message.role === "user") {
    const content = stripRuntimeContext(message.content);
    if (content.trim().length === 0) {
      return null;
    }
    return { ...message, content };
  }
  if (message.role === "tool" && options.maxToolResultChars !== undefined) {
    return { ...message, content: truncateText(message.content, options.maxToolResultChars) };
  }
  return { ...message };
}

function persistedMessageKey(message: AgentMessage): string {
  if (message.role === "tool") {
    return stableKey(["tool", message.toolCallId ?? ""]);
  }
  if (message.role === "assistant") {
    return stableKey(["assistant", message.content, message.toolCalls ?? null]);
  }
  if (message.role === "user") {
    return stableKey(["user", message.content]);
  }
  return stableKey([message.role, message.content]);
}

function isEmptyAssistantWithoutToolCalls(message: AgentMessage): boolean {
  return message.content.trim().length === 0 && (!message.toolCalls || message.toolCalls.length === 0);
}

function stripRuntimeContext(content: string): string {
  if (!content.startsWith(`${RUNTIME_CONTEXT_TAG}\n`)) {
    return content;
  }
  const separator = "\n\n";
  const separatorIndex = content.indexOf(separator);
  if (separatorIndex < 0) {
    return "";
  }
  return content.slice(separatorIndex + separator.length);
}

function stableKey(value: unknown): string {
  return JSON.stringify(value);
}
