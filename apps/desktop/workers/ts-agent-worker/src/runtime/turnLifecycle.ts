import type { AgentMessage, AgentRunResult, AgentRunSpec } from "../agent/agentRunSpec.ts";
import { RUNTIME_CONTEXT_TAG } from "../agent/contextBuilder.ts";
import { isJsonObject } from "../protocol/messages.ts";
import { persistedSessionMessages } from "./persistedMessages.ts";

export type SessionBridge = {
  setCheckpoint(sessionId: string, checkpoint: Record<string, unknown>, traceId: string): Promise<void>;
  clearCheckpoint(sessionId: string, traceId: string): Promise<void>;
  appendMessages(sessionId: string, messages: AgentMessage[], traceId: string): Promise<void>;
  persistTurn?(sessionId: string, turn: PersistTurnRequest, traceId: string): Promise<PersistTurnResult>;
  getCheckpoint(sessionId: string, traceId: string): Promise<Record<string, unknown> | null>;
};

export type PersistTurnRequest = {
  runId: string;
  messages: AgentMessage[];
  clearCheckpoint: boolean;
  runtimeContextTag?: string;
  contextMetadata?: Record<string, unknown>;
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

export type TurnLifecycleMetadata = {
  sessionId: string;
  runId: string;
  stopReason: AgentRunResult["stopReason"];
  checkpointCleared: boolean;
  persisted: boolean;
  savedMessageCount: number;
  awaitingInput: boolean;
  omittedSideEffects: string[];
};

export class TurnLifecycle {
  private readonly sessionBridge: SessionBridge | undefined;

  constructor(sessionBridge: SessionBridge | undefined) {
    this.sessionBridge = sessionBridge;
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
      return lifecycleMetadataFromPersistedTurn(spec, result, persisted);
    }
    await this.sessionBridge.appendMessages(spec.sessionId, messages, traceId);
    return {
      sessionId: spec.sessionId,
      runId: spec.runId,
      stopReason: result.stopReason,
      checkpointCleared: clearCheckpoint,
      persisted: true,
      savedMessageCount: messages.length,
      awaitingInput: isAwaitingInputResult(result),
      omittedSideEffects: [],
    };
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
): TurnLifecycleMetadata {
  return {
    sessionId: persisted.sessionId,
    runId: spec.runId,
    stopReason: result.stopReason,
    checkpointCleared: persisted.checkpointCleared,
    persisted: true,
    savedMessageCount: persisted.savedMessageCount,
    awaitingInput: isAwaitingInputResult(result),
    omittedSideEffects: persisted.omittedSideEffects,
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
