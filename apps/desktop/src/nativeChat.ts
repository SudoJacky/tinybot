import type { NormalizedGatewayEvent } from "./gatewayWebSocketClient";

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
  references?: NativeChatReference[];
  timestamp: string;
  messageId: string;
};

export type NativeChatReference = {
  kind: "tool" | "browser" | "memory" | "reference";
  title: string;
  detail: string;
};

export type NativeChatState = {
  sessions: NativeChatSession[];
  messages: Map<string, NativeChatMessage[]>;
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
  return payload.messages.filter(isRecord).map((message) => {
    const references = normalizeMessageReferences(message);
    return {
      role: stringValue(message.role) || "assistant",
      content: stringValue(message.content ?? message.text),
      reasoningContent: stringValue(message.reasoning_content),
      ...(references.length ? { references } : {}),
      timestamp: stringValue(message.timestamp),
      messageId: stringValue(message.message_id),
    };
  });
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
}

export function activateChat(state: NativeChatState, chatId: string) {
  state.activeChatId = chatId;
  state.activeSessionKey = sessionKeyForChat(chatId);
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
  if (event.kind === "chat.created" || event.kind === "attached") {
    activateChat(state, event.chatId);
    state.error = "";
    return;
  }

  if (event.kind === "message.delta") {
    const chatId = event.chatId || state.activeChatId;
    const sessionKey = sessionKeyForChat(chatId);
    if (!sessionKey) {
      return;
    }
    const messageId = event.messageId || `stream:${sessionKey}`;
    upsertStreamMessage(state, sessionKey, messageId, event.text, event.reasoning);
    state.respondingSessionKeys.add(sessionKey);
    state.error = "";
    return;
  }

  if (event.kind === "message.completed") {
    const sessionKey = sessionKeyForChat(event.chatId || state.activeChatId);
    if (!sessionKey) {
      return;
    }
    ensureMessageBucket(state, sessionKey).push({
      role: "assistant",
      content: event.text,
      reasoningContent: "",
      timestamp: new Date().toISOString(),
      messageId: event.messageId || "",
    });
    state.respondingSessionKeys.delete(sessionKey);
    state.error = "";
    return;
  }

  if (event.kind === "message.stream.completed") {
    const sessionKey =
      event.messageId && state.streamMessageKeys.has(event.messageId)
        ? state.streamMessageKeys.get(event.messageId) || ""
        : sessionKeyForChat(event.chatId || state.activeChatId);
    if (sessionKey) {
      state.respondingSessionKeys.delete(sessionKey);
    }
    if (event.messageId) {
      state.streamMessageKeys.delete(event.messageId);
    }
    return;
  }

  if (event.kind === "interrupted") {
    const sessionKey = sessionKeyForChat(event.chatId || state.activeChatId);
    if (sessionKey) {
      state.respondingSessionKeys.delete(sessionKey);
    }
    return;
  }

  if (event.kind === "error") {
    state.error = event.message;
    if (state.activeSessionKey) {
      state.respondingSessionKeys.delete(state.activeSessionKey);
    }
  }
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

function ensureMessageBucket(state: NativeChatState, sessionKey: string): NativeChatMessage[] {
  if (!state.messages.has(sessionKey)) {
    state.messages.set(sessionKey, []);
  }
  return state.messages.get(sessionKey) ?? [];
}

function normalizeMessageReferences(message: Record<string, unknown>): NativeChatReference[] {
  return [
    ...referenceRows(message.tool_calls, "tool"),
    ...referenceRows(message.tool_results, "tool"),
    ...referenceRows(message.browser_references, "browser"),
    ...referenceRows(message.browser_snapshots, "browser"),
    ...referenceRows(message.memory_references, "memory"),
    ...referenceRows(message.memories, "memory"),
    ...referenceRows(message.references, "reference"),
    ...referenceRows(message.citations, "reference"),
  ];
}

function referenceRows(value: unknown, kind: NativeChatReference["kind"]): NativeChatReference[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord).map((row) => ({
    kind,
    title: stringValue(row.title ?? row.name ?? row.id ?? row.url) || kind,
    detail: stringValue(row.detail ?? row.summary ?? row.path ?? row.url ?? row.content),
  }));
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
