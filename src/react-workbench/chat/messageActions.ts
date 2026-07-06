export type ToolCallSummary = {
  id: string;
  name: string;
  status: "pending" | "running" | "complete" | "failed" | "blocked" | string;
  summary?: string;
};

export type ContextReferenceSummary = {
  id: string;
  kind: string;
  title: string;
  detail?: string;
  sourcePath?: string;
  sourceLine?: number;
};

export type ReactChatMessage = {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  createdAtMs: number;
  text: string;
  status: "streaming" | "complete" | "failed";
  contextReferences?: ContextReferenceSummary[];
  reasoningText?: string;
  toolCalls?: ToolCallSummary[];
};

export type MessageActionContext = {
  sessionRunning: boolean;
};

export type MessageAction = "copy" | "branch";

export function canBranchFromMessage(message: ReactChatMessage, context: MessageActionContext): boolean {
  return message.role === "assistant"
    && message.status === "complete"
    && !context.sessionRunning
    && !message.toolCalls?.length;
}

export function visibleMessageActions(message: ReactChatMessage, context: MessageActionContext): MessageAction[] {
  return canBranchFromMessage(message, context) ? ["copy", "branch"] : ["copy"];
}
