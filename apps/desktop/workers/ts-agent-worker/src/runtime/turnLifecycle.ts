import type { AgentMessage, AgentRunResult, AgentRunSpec } from "../agent/agentRunSpec.ts";
import type { AgentRunnerCheckpoint } from "../agent/agentRunner.ts";
import { RUNTIME_CONTEXT_TAG } from "../agent/contextBuilder.ts";
import { isJsonObject } from "../protocol/messages.ts";
import { sessionCheckpointFromRunner } from "./checkpoint.ts";
import { persistedSessionMessages } from "./persistedMessages.ts";

export type SessionBridge = {
  setCheckpoint(sessionId: string, checkpoint: Record<string, unknown>, traceId: string): Promise<void>;
  clearCheckpoint(sessionId: string, traceId: string): Promise<void>;
  clearSession?(sessionId: string, traceId: string): Promise<ClearSessionResult>;
  appendMessages(sessionId: string, messages: AgentMessage[], traceId: string): Promise<AppendMessagesResult | void>;
  persistTurn?(sessionId: string, turn: PersistTurnRequest, traceId: string): Promise<PersistTurnResult>;
  getCheckpoint(sessionId: string, traceId: string): Promise<Record<string, unknown> | null>;
};

export type MemoryEvidenceBridge = {
  captureEvidence(sessionId: string, request: CaptureEvidenceRequest, traceId: string): Promise<CaptureEvidenceResult>;
};

export type PersistTurnRequest = {
  runId: string;
  messages: AgentMessage[];
  clearCheckpoint: boolean;
  runtimeContextTag?: string;
  contextMetadata?: Record<string, unknown>;
};

export type CaptureEvidenceRequest = {
  messages: AgentMessage[];
  startIndex: number;
};

export type CaptureEvidenceResult = {
  evidence: Array<Record<string, unknown>>;
};

export type PersistTurnResult = {
  sessionId: string;
  messagesBefore: number;
  messagesAfter: number;
  savedMessageCount: number;
  checkpointCleared: boolean;
  duplicateMessageCount: number;
  truncatedToolResultCount: number;
  omittedSideEffects: string[];
};

export type ClearSessionResult = {
  sessionId: string;
  messagesBefore: number;
  messagesAfter: number;
  checkpointCleared: boolean;
};

export type AppendMessagesResult = {
  sessionId: string;
  messagesBefore: number;
  messagesAfter: number;
  savedMessageCount: number;
};

export type TurnLifecycleMetadata = {
  sessionId: string;
  runId: string;
  stopReason: AgentRunResult["stopReason"];
  checkpointCleared: boolean;
  persisted: boolean;
  savedMessageCount: number;
  awaitingInput: boolean;
  evidenceCapturedCount: number;
  omittedSideEffects: string[];
};

export type RestoreCheckpointResult = {
  checkpoint: Record<string, unknown> | null;
  restored: boolean;
  restoredMessageCount: number;
};

export class TurnLifecycle {
  private readonly sessionBridge: SessionBridge | undefined;
  private readonly memoryBridge: MemoryEvidenceBridge | undefined;

  constructor(sessionBridge: SessionBridge | undefined, memoryBridge?: MemoryEvidenceBridge) {
    this.sessionBridge = sessionBridge;
    this.memoryBridge = memoryBridge;
  }

  async writeCheckpoint(
    traceId: string,
    spec: AgentRunSpec,
    checkpoint: AgentRunnerCheckpoint,
  ): Promise<void> {
    if (!this.sessionBridge || !spec.sessionId) {
      return;
    }
    await this.sessionBridge.setCheckpoint(spec.sessionId, sessionCheckpointFromRunner(spec, checkpoint), traceId);
  }

  async clearCheckpoint(traceId: string, spec: AgentRunSpec): Promise<void> {
    if (!this.sessionBridge || !spec.sessionId) {
      return;
    }
    await this.sessionBridge.clearCheckpoint(spec.sessionId, traceId);
  }

  async restoreCheckpoint(traceId: string, sessionId: string): Promise<RestoreCheckpointResult> {
    if (!this.sessionBridge) {
      return { checkpoint: null, restored: false, restoredMessageCount: 0 };
    }
    const checkpoint = await this.sessionBridge.getCheckpoint(sessionId, traceId);
    if (!checkpoint) {
      return { checkpoint, restored: false, restoredMessageCount: 0 };
    }
    const shouldKeepCheckpointForResume = checkpointRequiresUserInputResume(checkpoint);
    const restoredMessages = shouldKeepCheckpointForResume ? [] : materializeCheckpointMessages(checkpoint);
    if (restoredMessages.length > 0) {
      await this.sessionBridge.appendMessages(sessionId, restoredMessages, traceId);
    }
    if (!shouldKeepCheckpointForResume) {
      await this.sessionBridge.clearCheckpoint(sessionId, traceId);
    }
    return {
      checkpoint,
      restored: true,
      restoredMessageCount: restoredMessages.length,
    };
  }

  async finalizeTurn(
    traceId: string,
    spec: AgentRunSpec,
    result: AgentRunResult,
  ): Promise<TurnLifecycleMetadata | undefined> {
    if (!this.sessionBridge || !spec.sessionId) {
      return undefined;
    }
    const messages = sessionAppendMessages(spec, result);
    const clearCheckpoint = !isAwaitingInputResult(result);
    if (this.sessionBridge.persistTurn) {
      const persisted = await this.sessionBridge.persistTurn(spec.sessionId, {
        runId: spec.runId,
        messages,
        clearCheckpoint,
        runtimeContextTag: RUNTIME_CONTEXT_TAG,
        contextMetadata: result.contextMetadata,
      }, traceId);
      const evidenceCapturedCount = await this.captureEvidence(traceId, spec.sessionId, messages, persisted.messagesBefore);
      return lifecycleMetadataFromPersistedTurn(spec, result, persisted, evidenceCapturedCount);
    }
    const appended = await this.sessionBridge.appendMessages(spec.sessionId, messages, traceId);
    if (clearCheckpoint) {
      await this.sessionBridge.clearCheckpoint(spec.sessionId, traceId);
    }
    const messagesBefore = appended?.messagesBefore ?? 0;
    const savedMessageCount = appended?.savedMessageCount ?? messages.length;
    const evidenceCapturedCount = await this.captureEvidence(traceId, spec.sessionId, messages, messagesBefore);
    return {
      sessionId: spec.sessionId,
      runId: spec.runId,
      stopReason: result.stopReason,
      checkpointCleared: clearCheckpoint,
      persisted: true,
      savedMessageCount,
      awaitingInput: isAwaitingInputResult(result),
      evidenceCapturedCount,
      omittedSideEffects: evidenceCapturedCount > 0 ? [] : ["conversation_evidence"],
    };
  }

  private async captureEvidence(
    traceId: string,
    sessionId: string,
    messages: AgentMessage[],
    startIndex: number,
  ): Promise<number> {
    if (!this.memoryBridge || messages.length === 0) {
      return 0;
    }
    try {
      const result = await this.memoryBridge.captureEvidence(sessionId, { messages, startIndex }, traceId);
      return Array.isArray(result.evidence) ? result.evidence.length : 0;
    } catch {
      return 0;
    }
  }
}

function sessionAppendMessages(spec: AgentRunSpec, result: AgentRunResult): AgentMessage[] {
  const contextMessages = internalContextAppendMessages(spec.metadata?._contextSessionAppendMessages);
  const initialMessageCount = spec.metadata?._contextInitialMessageCount;
  const persistenceOptions = typeof spec.toolResultBudget === "number"
    ? { maxToolResultChars: spec.toolResultBudget }
    : {};
  if (!contextMessages || typeof initialMessageCount !== "number") {
    return persistedSessionMessages(result.messages, persistenceOptions);
  }
  return persistedSessionMessages([
    ...contextMessages,
    ...result.messages.slice(initialMessageCount),
  ], persistenceOptions);
}

function lifecycleMetadataFromPersistedTurn(
  spec: AgentRunSpec,
  result: AgentRunResult,
  persisted: PersistTurnResult,
  evidenceCapturedCount: number,
): TurnLifecycleMetadata {
  return {
    sessionId: persisted.sessionId,
    runId: spec.runId,
    stopReason: result.stopReason,
    checkpointCleared: persisted.checkpointCleared,
    persisted: true,
    savedMessageCount: persisted.savedMessageCount,
    awaitingInput: isAwaitingInputResult(result),
    evidenceCapturedCount,
    omittedSideEffects: evidenceCapturedCount > 0
      ? persisted.omittedSideEffects.filter((name) => name !== "conversation_evidence")
      : persisted.omittedSideEffects,
  };
}

function internalContextAppendMessages(value: unknown): AgentMessage[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const messages = value.map((item) => {
    if (!isJsonObject(item) || !isAgentRole(item.role) || typeof item.content !== "string") {
      return null;
    }
    return {
      role: item.role,
      content: item.content,
    };
  });
  return messages.every((message) => message !== null) ? (messages as AgentMessage[]) : null;
}

function isAgentRole(value: unknown): value is AgentMessage["role"] {
  return value === "system" || value === "user" || value === "assistant" || value === "tool";
}

function isAwaitingInputResult(result: AgentRunResult): boolean {
  return result.stopReason === "awaiting_user_input" || result.stopReason === "awaiting_approval" || result.stopReason === "awaiting_form";
}

function materializeCheckpointMessages(checkpoint: Record<string, unknown>): AgentMessage[] {
  const messages: AgentMessage[] = [];
  const assistantMessage = parseCheckpointAgentMessage(checkpoint.assistantMessage ?? checkpoint.assistant_message);
  if (assistantMessage) {
    messages.push(assistantMessage);
  }
  const completedToolResults = checkpoint.completedToolResults ?? checkpoint.completed_tool_results;
  if (Array.isArray(completedToolResults)) {
    for (const message of completedToolResults) {
      const parsed = parseCheckpointAgentMessage(message);
      if (parsed) {
        messages.push(parsed);
      }
    }
  }
  const pendingToolCalls = checkpoint.pendingToolCalls ?? checkpoint.pending_tool_calls;
  if (Array.isArray(pendingToolCalls)) {
    messages.push(...pendingToolCalls.map(pendingToolCallInterruptedMessage).filter((message) => message !== undefined));
  }
  return messages;
}

function parseCheckpointAgentMessage(value: unknown): AgentMessage | undefined {
  try {
    return parseAgentMessage(value);
  } catch {
    return undefined;
  }
}

function parseAgentMessage(value: unknown): AgentMessage {
  if (!isJsonObject(value) || !isAgentRole(value.role)) {
    throw new Error("checkpoint message role is invalid");
  }
  if (typeof value.content !== "string") {
    throw new Error("checkpoint message content must be a string");
  }
  return {
    role: value.role,
    content: value.content,
    reasoningContent: typeof value.reasoningContent === "string"
      ? value.reasoningContent
      : typeof value.reasoning_content === "string"
        ? value.reasoning_content
        : undefined,
    thinkingBlocks: Array.isArray(value.thinkingBlocks)
      ? value.thinkingBlocks.filter(isJsonObject)
      : Array.isArray(value.thinking_blocks)
        ? value.thinking_blocks.filter(isJsonObject)
        : undefined,
    toolCallId: typeof value.toolCallId === "string"
      ? value.toolCallId
      : typeof value.tool_call_id === "string"
        ? value.tool_call_id
        : undefined,
    name: typeof value.name === "string" ? value.name : undefined,
    toolCalls: Array.isArray(value.toolCalls)
      ? value.toolCalls.map(parseToolCallRequest)
      : Array.isArray(value.tool_calls)
        ? value.tool_calls.map(parseToolCallRequest)
        : undefined,
    metadata: isJsonObject(value.metadata) ? value.metadata : undefined,
  };
}

function parseToolCallRequest(value: unknown): { id: string; name: string; argumentsJson: string } {
  if (!isJsonObject(value) || typeof value.id !== "string") {
    throw new Error("checkpoint tool call is invalid");
  }
  const functionPayload = isJsonObject(value.function) ? value.function : {};
  const name = typeof value.name === "string"
    ? value.name
    : typeof functionPayload.name === "string"
      ? functionPayload.name
      : undefined;
  const argumentsJson = typeof value.argumentsJson === "string"
    ? value.argumentsJson
    : typeof value.arguments_json === "string"
      ? value.arguments_json
      : typeof functionPayload.arguments === "string"
        ? functionPayload.arguments
        : undefined;
  if (!name || argumentsJson === undefined) {
    throw new Error("checkpoint tool call is invalid");
  }
  return {
    id: value.id,
    name,
    argumentsJson,
  };
}

function pendingToolCallInterruptedMessage(value: unknown): AgentMessage | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const functionPayload = isJsonObject(value.function) ? value.function : {};
  const toolCallId = typeof value.id === "string" ? value.id : undefined;
  const name = typeof value.name === "string"
    ? value.name
    : typeof functionPayload.name === "string"
      ? functionPayload.name
      : "tool";
  return {
    role: "tool",
    content: "Error: Task interrupted before this tool finished.",
    toolCallId,
    name,
  };
}

function checkpointRequiresUserInputResume(checkpoint: Record<string, unknown>): boolean {
  return checkpointContainsAwaitingInput(checkpoint.messages)
    || checkpointContainsAwaitingInput(checkpoint.completedToolResults ?? checkpoint.completed_tool_results)
    || checkpointContainsAwaitingInput(checkpoint.assistantMessage ?? checkpoint.assistant_message);
}

function checkpointContainsAwaitingInput(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(checkpointContainsAwaitingInput);
  }
  if (!isJsonObject(value)) {
    return false;
  }
  const metadata = isJsonObject(value.metadata) ? value.metadata : {};
  const awaitingUserInput = metadata.awaitingUserInput ?? metadata.awaiting_user_input;
  const stopReason = metadata.stopReason ?? metadata.stop_reason;
  return awaitingUserInput === true
    || stopReason === "awaiting_user_input"
    || stopReason === "awaiting_approval"
    || stopReason === "awaiting_form";
}
