export type NativeChatSession = {
  key: string;
  chatId: string;
  threadId?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  pinned?: boolean;
  archived?: boolean;
  status?: string;
  workingDirectory?: string;
};

export type NativeChatReference = {
  kind: "browser" | "memory" | "recent" | "reference";
  title: string;
  detail: string;
  sourcePath?: string;
  sourceLine?: number;
  sourceEndLine?: number;
  sourceText?: string;
  rawPath?: string;
  rawLine?: number;
  noteId?: string;
  evidenceId?: string;
  scope?: string;
  type?: string;
  revision?: string;
};

export type NativeChatState = {
  sessions: NativeChatSession[];
  activeSessionKey: string;
  activeChatId: string;
  respondingSessionKeys: Set<string>;
  error: string;
};

export function createNativeChatState(): NativeChatState {
  return {
    sessions: [],
    activeSessionKey: "",
    activeChatId: "",
    respondingSessionKeys: new Set(),
    error: "",
  };
}

export function normalizeSessionsPayload(payload: unknown): NativeChatSession[] {
  if (!isRecord(payload)) {
    return [];
  }
  const isThreadList = Array.isArray(payload.threads);
  const items = Array.isArray(payload.threads)
    ? payload.threads
    : Array.isArray(payload.items)
      ? payload.items
      : [];
  return items.filter(isRecord).map((item) => {
    const threadId = stringValue(item.threadId ?? item.thread_id);
    const sourceKey = stringValue(item.sessionKey ?? item.session_key ?? item.key) || threadId;
    const chatId = threadId || stringValue(item.chat_id) || chatIdFromKey(sourceKey);
    const key = isThreadList && threadId
      ? threadId
      : canonicalSessionKey(sourceKey, chatId) || chatId;
    const metadata = isRecord(item.metadata) ? item.metadata : {};
    const extra = isRecord(metadata.extra)
      ? metadata.extra
      : isRecord(item.extra) && isRecord(item.extra.metadata)
        ? item.extra.metadata
        : {};
    const workingDirectory = stringValue(metadata.workingDirectory ?? metadata.working_directory);
    return {
      key,
      chatId,
      ...(threadId ? { threadId } : {}),
      title: stringValue(item.title) || "New session",
      createdAt: stringValue(item.createdAt ?? item.created_at),
      updatedAt: stringValue(item.updatedAt ?? item.updated_at),
      ...(booleanValue(extra.pinned) ? { pinned: true } : {}),
      ...(workingDirectory ? { workingDirectory } : {}),
      ...(stringValue(item.status) ? { status: stringValue(item.status) } : {}),
      ...(Boolean(item.archivedAt ?? item.archived_at) || stringValue(item.status) === "archived"
        ? { archived: true }
        : {}),
    };
  });
}

export function setSessions(state: NativeChatState, sessions: NativeChatSession[]) {
  state.activeSessionKey = canonicalSessionKey(state.activeSessionKey, state.activeChatId)
    || state.activeSessionKey;
  state.respondingSessionKeys = new Set(
    [...state.respondingSessionKeys].map((key) => canonicalSessionKey(key) || key),
  );
  state.sessions = sessions.map((session) => ({
    ...session,
    key: canonicalSessionKey(session.key, session.chatId) || session.key,
  }));
}

export function activateSession(state: NativeChatState, sessionKey: string, chatId: string) {
  state.activeChatId = chatId;
  state.activeSessionKey = canonicalSessionKey(sessionKey, chatId) || sessionKey || chatId;
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

export function canonicalSessionKey(key: string, chatId = ""): string {
  if (!key) {
    return chatId;
  }
  const separator = key.indexOf(":");
  if (separator < 0) {
    return key;
  }
  const prefix = key.slice(0, separator).toLowerCase();
  const rest = key.slice(separator + 1);
  return prefix === "websocket" ? `websocket:${rest}` : key;
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

function booleanValue(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}
