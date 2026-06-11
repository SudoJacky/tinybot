import type { AgentMessage } from "../agent/agentRunSpec.ts";
import { RUNTIME_CONTEXT_TAG } from "../agent/contextBuilder.ts";

export function persistedSessionMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.flatMap((message) => {
    const persisted = persistedSessionMessage(message);
    return persisted ? [persisted] : [];
  });
}

function persistedSessionMessage(message: AgentMessage): AgentMessage | null {
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
  return { ...message };
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
