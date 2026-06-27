import type { NormalizedGatewayEvent } from "./gatewayWebSocketClient";
import { logDesktopNativeChatDebug, summarizeDebugText } from "./desktopNativeChatDebug";
import {
  createChatRunState,
  legacyMessagesToTurns,
  reduceAgentEvent,
  turnsToConversationMessages,
  type AgentEventEnvelope,
  type ChatRunState,
} from "./chatRunModel";

export type NativeChatSession = {
  key: string;
  chatId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type NativeChatMessage = {
  role: string;
  content: string;
  reasoningContent: string;
  toolActivities?: NativeChatToolActivity[];
  references?: NativeChatReference[];
  timestamp: string;
  messageId: string;
};

export type NativeChatToolActivity = {
  approvalId?: string;
  id: string;
  name: string;
  argsText: string;
  responseText: string;
  kind: "call" | "result";
  approvalStatus?: string;
  sessionKey?: string;
  status?: string;
};

export type NativeChatReference = {
  kind: "browser" | "memory" | "recent" | "reference";
  title: string;
  detail: string;
  sourcePath?: string;
  sourceLine?: number;
  sourceText?: string;
  rawPath?: string;
  rawLine?: number;
  noteId?: string;
  evidenceId?: string;
  scope?: string;
  type?: string;
};

export type NativeChatState = {
  sessions: NativeChatSession[];
  messages: Map<string, NativeChatMessage[]>;
  chatRuns: ChatRunState;
  activeSessionKey: string;
  activeChatId: string;
  respondingSessionKeys: Set<string>;
  streamMessageKeys: Map<string, string>;
  error: string;
};

export function createNativeChatState(): NativeChatState {
  return {
    sessions: [],
    messages: new Map(),
    chatRuns: createChatRunState(),
    activeSessionKey: "",
    activeChatId: "",
    respondingSessionKeys: new Set(),
    streamMessageKeys: new Map(),
    error: "",
  };
}

export function sessionKeyForChat(chatId: string): string {
  return chatId ? `WebSocket:${chatId}` : "";
}

export function sessionKeyForChatState(state: NativeChatState, chatId: string): string {
  if (!chatId) {
    return "";
  }
  return state.sessions.find((session) => session.chatId === chatId)?.key || sessionKeyForChat(chatId);
}

export function normalizeSessionsPayload(payload: unknown): NativeChatSession[] {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    return [];
  }
  return payload.items.filter(isRecord).map((item) => {
    const chatId = stringValue(item.chat_id) || chatIdFromKey(stringValue(item.key));
    const key = stringValue(item.key) || sessionKeyForChat(chatId);
    return {
      key,
      chatId,
      title: stringValue(item.title) || "New session",
      createdAt: stringValue(item.created_at),
      updatedAt: stringValue(item.updated_at),
    };
  });
}

export function normalizeMessagesPayload(payload: unknown): NativeChatMessage[] {
  if (!isRecord(payload) || !Array.isArray(payload.messages)) {
    return [];
  }
  const messages = payload.messages.filter(isRecord).map((message) => {
    const references = normalizeMessageReferences(message);
    const toolActivities = normalizeToolActivities(message);
    const content = stringValue(message.content ?? message.text);
    return {
      role: stringValue(message.role) || "assistant",
      content: shouldSuppressToolActivityContent(message, toolActivities) ? "" : content,
      reasoningContent: stringValue(message.reasoning_content),
      ...(toolActivities.length ? { toolActivities } : {}),
      ...(references.length ? { references } : {}),
      timestamp: stringValue(message.timestamp),
      messageId: stringValue(message.message_id),
    };
  });
  return coalesceToolActivityMessages(messages);
}

export function setSessions(state: NativeChatState, sessions: NativeChatSession[]) {
  state.sessions = sessions;
  for (const session of sessions) {
    if (!state.messages.has(session.key)) {
      state.messages.set(session.key, []);
    }
  }
}

export function setMessages(state: NativeChatState, sessionKey: string, messages: NativeChatMessage[]) {
  state.messages.set(sessionKey, messages);
  state.chatRuns.legacyMessagesBySession.set(sessionKey, messages);
}

export function resolveNativeChatApproval(
  state: NativeChatState,
  options: { approvalId: string; decision: "approved" | "denied"; sessionKey: string },
): boolean {
  const status = options.decision === "approved" ? "completed" : "failed";
  const resolutionText = options.decision === "approved" ? "Approved." : "Denied.";
  let changed = false;
  const messages = state.messages.get(options.sessionKey) ?? [];
  for (const message of messages) {
    if (!message.toolActivities?.length) {
      continue;
    }
    message.toolActivities = message.toolActivities.map((activity) => {
      if (activity.approvalId !== options.approvalId) {
        return activity;
      }
      changed = true;
      return {
        ...activity,
        approvalStatus: options.decision,
        responseText: shouldReplaceApprovalPlaceholder(activity.responseText) ? resolutionText : activity.responseText,
        status,
      };
    });
  }
  const turns = state.chatRuns.turnsBySession.get(options.sessionKey) ?? [];
  for (const turn of turns) {
    for (const step of turn.steps) {
      if (step.toolCall?.approvalId === options.approvalId) {
        step.status = status;
        step.toolCall.approvalStatus = options.decision;
        if (shouldReplaceApprovalPlaceholder(step.toolCall.resultPreview)) {
          step.toolCall.resultPreview = resolutionText;
        }
        changed = true;
      }
      if (step.approval?.approvalId === options.approvalId) {
        step.status = "completed";
        step.approval.decision = options.decision;
        changed = true;
      }
    }
  }
  if (turns.length && changed) {
    state.messages.set(options.sessionKey, conversationMessagesToNativeMessages(turnsToConversationMessages(turns)));
  }
  return changed;
}

function shouldReplaceApprovalPlaceholder(value: unknown): boolean {
  const text = typeof value === "string" ? value.trim() : "";
  return !text || text === "Waiting for approval.";
}

export function activateChat(state: NativeChatState, chatId: string) {
  const existing = state.sessions.find((session) => session.chatId === chatId);
  activateSession(state, existing?.key || sessionKeyForChat(chatId), chatId);
}

export function activateSession(state: NativeChatState, sessionKey: string, chatId: string) {
  state.activeChatId = chatId;
  state.activeSessionKey = sessionKey || sessionKeyForChat(chatId);
  ensureMessageBucket(state, state.activeSessionKey);
  if (!state.sessions.some((session) => session.key === state.activeSessionKey)) {
    state.sessions = [
      {
        key: state.activeSessionKey,
        chatId,
        title: "New session",
        createdAt: "",
        updatedAt: "",
      },
      ...state.sessions,
    ];
  }
}

export function appendUserMessage(state: NativeChatState, content: string, timestamp = new Date().toISOString()) {
  if (!state.activeSessionKey) {
    return;
  }
  ensureMessageBucket(state, state.activeSessionKey).push({
    role: "user",
    content,
    reasoningContent: "",
    timestamp,
    messageId: "",
  });
  state.respondingSessionKeys.add(state.activeSessionKey);
  const session = state.sessions.find((item) => item.key === state.activeSessionKey);
  if (session && (!session.title || session.title === "New session")) {
    session.title = content.trim().slice(0, 80) || "New session";
  }
}

export function applyChatEvent(state: NativeChatState, event: NormalizedGatewayEvent) {
  logDesktopNativeChatDebug("state.event.before", {
    event: summarizeChatEvent(event),
    state: summarizeNativeChatState(state),
  });
  if (event.kind === "chat.created" || event.kind === "attached") {
    activateChat(state, event.chatId);
    state.error = "";
    logDesktopNativeChatDebug("state.event.after", {
      event: summarizeChatEvent(event),
      state: summarizeNativeChatState(state),
    });
    return;
  }

  if (event.kind === "message.delta") {
    const chatId = event.chatId || state.activeChatId;
    const sessionKey = sessionKeyForChatState(state, chatId);
    if (!sessionKey) {
      logDesktopNativeChatDebug("state.event.after", {
        dropped: "missing session key",
        event: summarizeChatEvent(event),
        state: summarizeNativeChatState(state),
      });
      return;
    }
    const messageId = event.messageId || `stream:${sessionKey}`;
    upsertStreamMessage(state, sessionKey, messageId, event.text, event.reasoning);
    state.respondingSessionKeys.add(sessionKey);
    state.error = "";
    logDesktopNativeChatDebug("state.event.after", {
      event: summarizeChatEvent(event),
      state: summarizeNativeChatState(state),
      targetSessionKey: sessionKey,
    });
    return;
  }

  if (event.kind === "agent.event") {
    const envelope = agentEventEnvelopeFromRaw(event.raw);
    if (!envelope) {
      return;
    }
    const sessionKey = envelope.session_key || sessionKeyForChatState(state, envelope.chat_id || state.activeChatId);
    if (!sessionKey) {
      return;
    }
    if (!state.chatRuns.turnsBySession.has(sessionKey)) {
      const legacyMessages = state.messages.get(sessionKey) ?? [];
      state.chatRuns.turnsBySession.set(sessionKey, legacyMessagesToTurns(sessionKey, legacyMessages));
    }
    const seededTurns = state.chatRuns.turnsBySession.get(sessionKey) ?? [];
    if (!seededTurns.some((turn) => turn.id === envelope.turn_id)) {
      const pendingTurn = seededTurns[seededTurns.length - 1];
      if (pendingTurn && !pendingTurn.finalMessage) {
        pendingTurn.id = envelope.turn_id;
      }
    }
    reduceAgentEvent(state.chatRuns, { ...envelope, session_key: sessionKey });
    const turns = state.chatRuns.turnsBySession.get(sessionKey) ?? [];
    state.messages.set(sessionKey, conversationMessagesToNativeMessages(turnsToConversationMessages(turns)));
    if (
      envelope.event_type === "agent.turn.completed"
      || envelope.event_type === "agent.turn.failed"
      || envelope.event_type === "agent.turn.interrupted"
      || envelope.event_type === "message.completed"
    ) {
      state.respondingSessionKeys.delete(sessionKey);
    } else {
      state.respondingSessionKeys.add(sessionKey);
    }
    return;
  }

  if (event.kind === "message.completed") {
    const sessionKey = sessionKeyForChatState(state, event.chatId || state.activeChatId);
    if (!sessionKey) {
      logDesktopNativeChatDebug("state.event.after", {
        dropped: "missing session key",
        event: summarizeChatEvent(event),
        state: summarizeNativeChatState(state),
      });
      return;
    }
    const toolMessage = nativeToolMessageFromEvent(event);
    const references = normalizeMessageReferences(event.raw);
    const bucket = ensureMessageBucket(state, sessionKey);
    const existingMessage = event.messageId
      ? bucket.find((message) => message.messageId === event.messageId && message.role === "assistant")
      : undefined;
    if (!toolMessage && existingMessage) {
      if (!existingMessage.content && event.text) {
        existingMessage.content = event.text;
      }
      if (references.length) {
        existingMessage.references = [...(existingMessage.references ?? []), ...references];
      }
      state.respondingSessionKeys.delete(sessionKey);
      state.error = "";
      logDesktopNativeChatDebug("state.event.after", {
        event: summarizeChatEvent(event),
        state: summarizeNativeChatState(state),
        targetSessionKey: sessionKey,
      });
      return;
    }
    if (toolMessage && upsertToolActivityMessage(bucket, toolMessage)) {
      state.respondingSessionKeys.delete(sessionKey);
      state.error = "";
      logDesktopNativeChatDebug("state.event.after", {
        event: summarizeChatEvent(event),
        state: summarizeNativeChatState(state),
        targetSessionKey: sessionKey,
      });
      return;
    }
    const nextMessage: NativeChatMessage = {
      role: "assistant",
      content: toolMessage ? "" : event.text,
      reasoningContent: "",
      ...(toolMessage ? { toolActivities: [toolMessage] } : {}),
      ...(references.length ? { references } : {}),
      timestamp: new Date().toISOString(),
      messageId: event.messageId || "",
    };
    if (toolMessage) {
      insertToolActivityMessage(bucket, nextMessage);
    } else {
      bucket.push(nextMessage);
    }
    state.respondingSessionKeys.delete(sessionKey);
    state.error = "";
    logDesktopNativeChatDebug("state.event.after", {
      event: summarizeChatEvent(event),
      state: summarizeNativeChatState(state),
      targetSessionKey: sessionKey,
    });
    return;
  }

  if (event.kind === "message.stream.completed") {
    const sessionKey =
      event.messageId && state.streamMessageKeys.has(event.messageId)
        ? state.streamMessageKeys.get(event.messageId) || ""
        : sessionKeyForChatState(state, event.chatId || state.activeChatId);
    if (sessionKey) {
      state.respondingSessionKeys.delete(sessionKey);
      const references = normalizeMessageReferences(event.raw);
      if (references.length && event.messageId) {
        attachMessageReferences(state, sessionKey, event.messageId, references);
      }
    }
    if (event.messageId) {
      state.streamMessageKeys.delete(event.messageId);
    }
    logDesktopNativeChatDebug("state.event.after", {
      event: summarizeChatEvent(event),
      state: summarizeNativeChatState(state),
      targetSessionKey: sessionKey,
    });
    return;
  }

  if (event.kind === "interrupted") {
    const sessionKey = sessionKeyForChatState(state, event.chatId || state.activeChatId);
    if (sessionKey) {
      state.respondingSessionKeys.delete(sessionKey);
    }
    logDesktopNativeChatDebug("state.event.after", {
      event: summarizeChatEvent(event),
      state: summarizeNativeChatState(state),
      targetSessionKey: sessionKey,
    });
    return;
  }

  if (event.kind === "error") {
    state.error = event.message;
    if (state.activeSessionKey) {
      state.respondingSessionKeys.delete(state.activeSessionKey);
    }
  }
  logDesktopNativeChatDebug("state.event.after", {
    event: summarizeChatEvent(event),
    state: summarizeNativeChatState(state),
  });
}

function upsertStreamMessage(
  state: NativeChatState,
  sessionKey: string,
  messageId: string,
  deltaText: string,
  reasoning: boolean,
) {
  const bucket = ensureMessageBucket(state, sessionKey);
  let message = bucket.find((item) => item.messageId === messageId);
  if (!message) {
    message = {
      role: "assistant",
      content: "",
      reasoningContent: "",
      timestamp: new Date().toISOString(),
      messageId,
    };
    bucket.push(message);
    state.streamMessageKeys.set(messageId, sessionKey);
  }
  if (reasoning) {
    message.reasoningContent += deltaText;
  } else {
    message.content += deltaText;
  }
}

function upsertToolActivityMessage(bucket: NativeChatMessage[], nextActivity: NativeChatToolActivity): boolean {
  const existingMessage = bucket.find((message) => (
    Boolean(message.toolActivities?.some((activity) => activity.id === nextActivity.id))
  ));
  if (!existingMessage?.toolActivities) {
    return false;
  }
  existingMessage.toolActivities = existingMessage.toolActivities.map((activity) => (
    activity.id === nextActivity.id ? mergeToolActivity(activity, nextActivity) : activity
  ));
  return true;
}

function attachMessageReferences(
  state: NativeChatState,
  sessionKey: string,
  messageId: string,
  references: NativeChatReference[],
) {
  const message = ensureMessageBucket(state, sessionKey).find((item) => item.messageId === messageId);
  if (!message) {
    return;
  }
  message.references = [...(message.references ?? []), ...references];
}

function coalesceToolActivityMessages(messages: NativeChatMessage[]): NativeChatMessage[] {
  const coalesced: NativeChatMessage[] = [];
  for (const message of messages) {
    const activities = message.toolActivities ?? [];
    const canCoalesce =
      activities.length > 0
      && !message.reasoningContent.trim()
      && !message.references?.length
      && (
        (message.role === "assistant" && !message.content.trim())
        || message.role === "tool"
        || message.role === "progress"
      );
    if (canCoalesce) {
      let merged = false;
      for (const activity of activities) {
        merged = upsertToolActivityMessage(coalesced, activity) || merged;
      }
      if (merged) {
        continue;
      }
    }
    if (canCoalesce) {
      insertToolActivityMessage(coalesced, message);
      continue;
    }
    coalesced.push(message);
  }
  return coalesced;
}

function insertToolActivityMessage(messages: NativeChatMessage[], message: NativeChatMessage): void {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") {
      break;
    }
    if (isAssistantFinalAnswerMessage(messages[index])) {
      messages.splice(index, 0, message);
      return;
    }
  }
  messages.push(message);
}

function isAssistantFinalAnswerMessage(message: NativeChatMessage): boolean {
  return message.role === "assistant"
    && Boolean(message.content.trim())
    && !message.toolActivities?.length;
}

function mergeToolActivity(
  current: NativeChatToolActivity,
  next: NativeChatToolActivity,
): NativeChatToolActivity {
  return {
    ...current,
    ...next,
    argsText: next.argsText || current.argsText,
    responseText: next.responseText || current.responseText,
  };
}

function ensureMessageBucket(state: NativeChatState, sessionKey: string): NativeChatMessage[] {
  if (!state.messages.has(sessionKey)) {
    state.messages.set(sessionKey, []);
  }
  return state.messages.get(sessionKey) ?? [];
}

function summarizeNativeChatState(state: NativeChatState): Record<string, unknown> {
  return {
    activeChatId: state.activeChatId,
    activeMessageCount: state.messages.get(state.activeSessionKey)?.length ?? 0,
    activeSessionKey: state.activeSessionKey,
    respondingSessionKeys: [...state.respondingSessionKeys],
    sessionCount: state.sessions.length,
    streamMessageKeys: [...state.streamMessageKeys.entries()],
  };
}

function summarizeChatEvent(event: NormalizedGatewayEvent): Record<string, unknown> {
  return {
    chatId: "chatId" in event ? event.chatId : "",
    kind: event.kind,
    messageId: "messageId" in event ? event.messageId : "",
    text: "text" in event ? summarizeDebugText(event.text) : undefined,
  };
}

function agentEventEnvelopeFromRaw(raw: Record<string, unknown>): AgentEventEnvelope | null {
  if (raw.schema_version !== "tinybot.agent_event.v1") {
    return null;
  }
  const eventId = stringValue(raw.event_id);
  const eventType = stringValue(raw.event_type);
  const chatId = stringValue(raw.chat_id);
  const sessionKey = stringValue(raw.session_key);
  const turnId = stringValue(raw.turn_id);
  if (!eventId || !eventType || !turnId) {
    return null;
  }
  return {
    chat_id: chatId,
    created_at: stringValue(raw.created_at) || new Date().toISOString(),
    event_id: eventId,
    event_type: eventType,
    ...(stringValue(raw.parent_step_id) ? { parent_step_id: stringValue(raw.parent_step_id) } : {}),
    payload: isRecord(raw.payload) ? raw.payload : {},
    schema_version: "tinybot.agent_event.v1",
    sequence: numberValue(raw.sequence) ?? 0,
    session_key: sessionKey || sessionKeyForChat(chatId),
    ...(stringValue(raw.step_id) ? { step_id: stringValue(raw.step_id) } : {}),
    turn_id: turnId,
  };
}

function conversationMessagesToNativeMessages(messages: ReturnType<typeof turnsToConversationMessages>): NativeChatMessage[] {
  return messages.filter((message, index) => {
    const next = messages[index + 1];
    return !(
      message.tone === "assistant"
      && message.copyable !== true
      && next?.tone === "assistant"
      && next.copyable === true
      && message.body.join("\n") === next.body.join("\n")
    );
  }).map((message, index) => ({
    role: message.tone,
    content: message.body.join("\n"),
    reasoningContent: message.reasoningContent ?? "",
    ...(message.toolActivities?.length ? {
      toolActivities: message.toolActivities.map((activity) => ({
        approvalId: activity.approvalId,
        approvalStatus: activity.approvalStatus,
        argsText: activity.argsText,
        id: activity.id,
        kind: activity.kind,
        name: activity.name,
        responseText: activity.responseText,
        sessionKey: activity.sessionKey,
        status: activity.status,
      })),
    } : {}),
    ...(message.references.length ? {
      references: message.references.map((reference) => ({
        detail: reference.detail,
        evidenceId: reference.evidenceId,
        kind: nativeReferenceKind(reference.kind),
        noteId: reference.noteId,
        rawLine: reference.rawLine,
        rawPath: reference.rawPath,
        scope: reference.scope,
        sourceLine: reference.sourceLine,
        sourcePath: reference.sourcePath,
        sourceText: reference.sourceText,
        title: reference.title,
        type: reference.type,
      })),
    } : {}),
    timestamp: message.time,
    messageId: `agent-run:${index}`,
  }));
}

function nativeReferenceKind(value: string): NativeChatReference["kind"] {
  return value === "browser" || value === "memory" || value === "recent" || value === "reference"
    ? value
    : "reference";
}

function normalizeMessageReferences(message: Record<string, unknown>): NativeChatReference[] {
  return [
    ...referenceRows(message.browser_references, "browser"),
    ...referenceRows(message.browser_snapshots, "browser"),
    ...referenceRows(message._memory_references, "memory"),
    ...referenceRows(message.memory_references, "memory"),
    ...referenceRows(message.memories, "memory"),
    ...referenceRows(message._recent_context_references, "recent"),
    ...referenceRows(message.recent_context_references, "recent"),
    ...referenceRows(message.references, "reference"),
    ...referenceRows(message.citations, "reference"),
  ];
}

function normalizeToolActivities(message: Record<string, unknown>): NativeChatToolActivity[] {
  const calls = toolCallRows(message.tool_calls ?? message.toolCalls);
  const results = toolResultRows(message.tool_results ?? message.toolResults);
  const usedResultIndexes = new Set<number>();
  const activities = calls.map((call, index) => {
    const resultIndex = results.findIndex((result, candidateIndex) => (
      !usedResultIndexes.has(candidateIndex)
      && Boolean(result.id)
      && result.id === call.id
    ));
    const fallbackIndex = resultIndex === -1
      && results[index]
      && !results[index].id
      && !usedResultIndexes.has(index)
      ? index
      : -1;
    const pairedIndex = resultIndex === -1 ? fallbackIndex : resultIndex;
    const result = pairedIndex === -1 ? null : results[pairedIndex];
    if (pairedIndex !== -1) {
      usedResultIndexes.add(pairedIndex);
    }
    return {
      id: call.id || result?.id || `tool-call-${index + 1}`,
      name: call.name || result?.name || "unknown",
      argsText: call.argsText,
      responseText: result?.responseText || "",
      kind: result?.responseText ? "result" as const : "call" as const,
      ...(call.approvalId || result?.approvalId ? { approvalId: call.approvalId || result?.approvalId } : {}),
      ...(call.approvalStatus || result?.approvalStatus ? { approvalStatus: call.approvalStatus || result?.approvalStatus } : {}),
      ...(call.status || result?.status ? { status: result?.status || call.status } : {}),
    };
  });

  results.forEach((result, index) => {
    if (usedResultIndexes.has(index)) {
      return;
    }
    activities.push({
      id: result.id || `tool-result-${index + 1}`,
      name: result.name || "tool",
      argsText: "",
      responseText: result.responseText,
      kind: "result",
      ...(result.approvalId ? { approvalId: result.approvalId } : {}),
      ...(result.approvalStatus ? { approvalStatus: result.approvalStatus } : {}),
      ...(result.status ? { status: result.status } : {}),
    });
  });

  if (!activities.length && (message.role === "tool" || message.role === "progress")) {
    const responseText = textValue(message.content ?? message.text);
    if (responseText) {
      const status = normalizeToolActivityStatus(message.status ?? message.state ?? message.phase);
      const isResult = message.role === "tool" || booleanValue(message._tool_result);
      activities.push({
        id: stringValue(message.tool_call_id ?? message.toolCallId ?? message._tool_call_id) || stringValue(message.message_id) || "tool-result",
        name: stringValue(message._tool_name ?? message.name) || "tool",
        argsText: "",
        responseText,
        kind: "result",
        ...(stringValue(message._approval_id ?? message.approval_id) ? { approvalId: stringValue(message._approval_id ?? message.approval_id) } : {}),
        ...(stringValue(message._approval_status) ? { approvalStatus: stringValue(message._approval_status) } : {}),
        ...(status || isResult ? { status: status || "completed" } : {}),
      });
    }
  }

  const toolMessage = activities.length ? null : toolActivityFromMessage(message);
  if (toolMessage) {
    activities.push(toolMessage);
  }

  return activities;
}

function nativeToolMessageFromEvent(event: Extract<NormalizedGatewayEvent, { kind: "message.completed" }>): NativeChatToolActivity | null {
  return toolActivityFromMessage({
    ...event.raw,
    content: event.text,
    message_id: event.messageId,
  });
}

function toolActivityFromMessage(message: Record<string, unknown>): NativeChatToolActivity | null {
  const hasToolMetadata = booleanValue(message._tool_hint)
    || booleanValue(message._tool_detail)
    || booleanValue(message._tool_result);
  const isToolRole = message.role === "tool" || message.role === "progress";
  if (!hasToolMetadata && !isToolRole) {
    return null;
  }
  const text = textValue(message.content ?? message.text);
  if (!text) {
    return null;
  }
  const isResult = booleanValue(message._tool_result) || message.role === "tool";
  const status = normalizeToolActivityStatus(message.status ?? message.state ?? message.phase);
  return {
    id: stringValue(message.tool_call_id ?? message.toolCallId ?? message._tool_call_id) || stringValue(message.message_id) || (isResult ? "tool-result" : "tool-detail"),
    name: stringValue(message._tool_name ?? message.name) || inferToolNameFromText(text) || "tool",
    argsText: isResult ? "" : text,
    responseText: isResult ? text : "",
    kind: isResult ? "result" : "call",
    ...(stringValue(message._approval_id ?? message.approval_id) ? { approvalId: stringValue(message._approval_id ?? message.approval_id) } : {}),
    ...(stringValue(message._approval_status ?? message.approval_status) ? { approvalStatus: stringValue(message._approval_status ?? message.approval_status) } : {}),
    ...(status ? { status } : { status: isResult ? "completed" : "running" }),
  };
}

function shouldSuppressToolActivityContent(message: Record<string, unknown>, activities: NativeChatToolActivity[]): boolean {
  return activities.length > 0 && Boolean(
    booleanValue(message._tool_hint)
      || booleanValue(message._tool_detail)
      || booleanValue(message._tool_result),
  );
}

function toolCallRows(value: unknown): Array<Pick<NativeChatToolActivity, "id" | "name" | "argsText"> & { approvalId?: string; approvalStatus?: string; status?: string }> {
  return arrayRows(value).map((row, index) => {
    const functionPayload = isRecord(row.function) ? row.function : {};
    const status = normalizeToolActivityStatus(row.status ?? row.state ?? row.phase);
    return {
      id: stringValue(row.id ?? row.tool_call_id) || `tool-call-${index + 1}`,
      name: stringValue(functionPayload.name ?? row.name) || "unknown",
      argsText: textValue(functionPayload.arguments ?? row.argumentsJson ?? row.arguments ?? row.detail ?? row.path),
      ...(stringValue(row._approval_id ?? row.approval_id) ? { approvalId: stringValue(row._approval_id ?? row.approval_id) } : {}),
      ...(stringValue(row._approval_status ?? row.approval_status) ? { approvalStatus: stringValue(row._approval_status ?? row.approval_status) } : {}),
      ...(status ? { status } : {}),
    };
  });
}

function toolResultRows(value: unknown): Array<Pick<NativeChatToolActivity, "id" | "name" | "responseText"> & { approvalId?: string; approvalStatus?: string; status?: string }> {
  return arrayRows(value).map((row, index) => {
    const responseText = textValue(row.content ?? row.response ?? row.result ?? row.output ?? row.detail ?? row.summary);
    const status = normalizeToolActivityStatus(row.status ?? row.state ?? row.phase) || (responseText ? "completed" : "");
    return {
      id: stringValue(row.tool_call_id ?? row.toolCallId ?? row.id) || `tool-result-${index + 1}`,
      name: stringValue(row.name ?? row.title ?? row.tool_name) || "",
      responseText,
      ...(stringValue(row._approval_id ?? row.approval_id) ? { approvalId: stringValue(row._approval_id ?? row.approval_id) } : {}),
      ...(stringValue(row._approval_status ?? row.approval_status) ? { approvalStatus: stringValue(row._approval_status ?? row.approval_status) } : {}),
      ...(status ? { status } : {}),
    };
  });
}

function normalizeToolActivityStatus(value: unknown): string {
  const normalized = stringValue(value).trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!normalized) {
    return "";
  }
  if (["running", "in_progress", "started", "streaming"].includes(normalized)) {
    return "running";
  }
  if (["pending", "queued", "created", "waiting"].includes(normalized)) {
    return "pending";
  }
  if (["completed", "complete", "success", "succeeded", "done"].includes(normalized)) {
    return "completed";
  }
  if (["failed", "failure", "error", "errored"].includes(normalized)) {
    return "failed";
  }
  if (["blocked", "approval_required", "waiting_approval"].includes(normalized)) {
    return "blocked";
  }
  if (["cancelled", "canceled", "interrupted", "stopped"].includes(normalized)) {
    return "cancelled";
  }
  return normalized;
}

function inferToolNameFromText(value: string): string {
  const match = value.trim().match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*\(/);
  return match?.[1] ?? "";
}

function referenceRows(value: unknown, kind: NativeChatReference["kind"]): NativeChatReference[] {
  return arrayRows(value).map((row) => {
    const title = stringValue(
      row.title ??
        row.name ??
        row.note_id ??
        row.evidence_id ??
        row.id ??
        row.file ??
        row.url,
    ) || kind;
    const detail = stringValue(
      row.detail ??
        row.summary ??
        row.excerpt ??
        row.content ??
        row.path ??
        row.file ??
        row.url,
    );
    const canTraceSource = kind === "memory" || kind === "recent";
    const sourcePath = canTraceSource ? stringValue(row.view_file ?? row.source_file ?? row.file ?? row.path) : "";
    const rawPath = canTraceSource ? stringValue(row.file ?? row.path) : "";
    const sourceLine = numberValue(row.view_line ?? row.line ?? row.cursor);
    const rawLine = numberValue(row.line ?? row.cursor);
    const sourceText = sourcePath || sourceLine
      ? stringValue(row.source_text ?? row.excerpt ?? row.content ?? row.summary ?? row.detail)
      : "";
    const noteId = stringValue(row.note_id);
    const evidenceId = stringValue(row.evidence_id);
    const scope = stringValue(row.scope);
    const type = stringValue(row.type);
    return {
      kind,
      title,
      detail,
      ...(sourcePath ? { sourcePath } : {}),
      ...(sourceLine ? { sourceLine } : {}),
      ...(sourceText ? { sourceText } : {}),
      ...(rawPath && rawPath !== sourcePath ? { rawPath } : {}),
      ...(rawLine && rawLine !== sourceLine ? { rawLine } : {}),
      ...(noteId ? { noteId } : {}),
      ...(evidenceId ? { evidenceId } : {}),
      ...(scope ? { scope } : {}),
      ...(type ? { type } : {}),
    };
  });
}

function arrayRows(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter(isRecord);
  }
  return isRecord(value) ? [value] : [];
}

function chatIdFromKey(key: string): string {
  return key.includes(":") ? key.split(":").slice(1).join(":") : key;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function textValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function booleanValue(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}
