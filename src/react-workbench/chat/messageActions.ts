import type { TokenUsage } from "../../app-core/chat/chatRunModel";

export type ToolCallSummary = {
  approvalId?: string;
  approvalStatus?: string;
  argsText?: string;
  childRunId?: string;
  delegateId?: string;
  delegateTask?: string;
  delegateTitle?: string;
  delegateType?: string;
  finalOutput?: string;
  id: string;
  name: string;
  parentRunId?: string;
  parentTurnId?: string;
  responseText?: string;
  sessionKey?: string;
  status: "pending" | "running" | "complete" | "failed" | "blocked" | string;
  summary?: string;
  traceRef?: string;
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
  turnId?: string;
  turnStatus?: string;
  usage?: TokenUsage;
};

export type MessageActionContext = {
  sessionRunning: boolean;
};

export type MessageAction = "copy" | "branch";

export function canCopyMessage(message: ReactChatMessage, context: MessageActionContext): boolean {
  if (!message.text.trim()) {
    return false;
  }
  if (message.role !== "assistant") {
    return true;
  }
  if (message.turnStatus) {
    return message.status === "complete" && message.turnStatus === "completed";
  }
  return message.status === "complete" && !context.sessionRunning;
}

export function canBranchFromMessage(message: ReactChatMessage, context: MessageActionContext): boolean {
  if (message.role !== "assistant" || !canCopyMessage(message, context) || message.toolCalls?.length) {
    return false;
  }
  if (message.turnStatus) {
    return message.turnStatus === "completed";
  }
  return !context.sessionRunning;
}

export function visibleMessageActions(message: ReactChatMessage, context: MessageActionContext): MessageAction[] {
  if (!canCopyMessage(message, context)) {
    return [];
  }
  return canBranchFromMessage(message, context) ? ["copy", "branch"] : ["copy"];
}
