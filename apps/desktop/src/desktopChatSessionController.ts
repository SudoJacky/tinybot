import {
  appendUserMessage,
  applyChatEvent,
  createNativeChatState,
  activateSession,
  normalizeMessagesPayload,
  normalizeSessionsPayload,
  setMessages,
  setSessions,
  sessionKeyForChat,
  type NativeChatState,
} from "./nativeChat";
import { createGatewaySocketMessage, type NormalizedGatewayEvent } from "./gatewayWebSocketClient";
import { logDesktopNativeDebug, summarizeDebugText } from "./desktopNativeChatDebug";

export interface DesktopChatSessionControllerApi {
  listSessions(): Promise<unknown>;
  loadMessages(sessionKey: string): Promise<unknown>;
  deleteSession?: (sessionKey: string) => Promise<unknown>;
}

export interface DesktopChatSessionControllerOptions {
  api: DesktopChatSessionControllerApi;
  sendSocketMessage(message: unknown): void;
  now?: () => string;
}

export type ChatSubmitResult =
  | { status: "empty" }
  | { status: "creating"; pendingContent: string }
  | { status: "sent"; chatId: string; content: string };

export type ChatGatewayEventResult = {
  pendingMessageSent: boolean;
  loadedMessagesForChatId: string;
  reloadedSessions: boolean;
};

export type ChatDeleteSessionResult =
  | { status: "missing"; deletedSessionKey: string; nextSessionKey: "" }
  | { status: "unavailable"; deletedSessionKey: string; nextSessionKey: "" }
  | { status: "deleted"; deletedSessionKey: string; nextSessionKey: string };

export interface DesktopChatSessionController {
  readonly state: NativeChatState;
  loadSessions(): Promise<number>;
  selectSession(sessionKey: string, chatId: string): Promise<void>;
  startNewChat(): void;
  deleteSession(sessionKey: string): Promise<ChatDeleteSessionResult>;
  submitMessage(content: string, usePersistentRag?: boolean): ChatSubmitResult;
  interruptActiveChat(): boolean;
  handleGatewayEvent(event: NormalizedGatewayEvent): Promise<ChatGatewayEventResult>;
  loadMessagesForChat(chatId: string): Promise<boolean>;
}

export function createDesktopChatSessionController({
  api,
  sendSocketMessage,
  now = () => new Date().toISOString(),
}: DesktopChatSessionControllerOptions): DesktopChatSessionController {
  const state = createNativeChatState();
  let pendingMessage: { content: string; usePersistentRag: boolean } | null = null;

  async function loadSessions(): Promise<number> {
    logDesktopNativeDebug("session.load.start", summarizeSessionState());
    const sessions = normalizeSessionsPayload(await api.listSessions());
    setSessions(state, sessions);
    if (!state.activeSessionKey && sessions[0]) {
      await selectSession(sessions[0].key, sessions[0].chatId);
    }
    logDesktopNativeDebug("session.load.complete", {
      ...summarizeSessionState(),
      loadedCount: sessions.length,
    });
    return sessions.length;
  }

  async function selectSession(sessionKey: string, chatId: string): Promise<void> {
    logDesktopNativeDebug("session.select.start", {
      ...summarizeSessionState(),
      chatId,
      sessionKey,
    });
    activateSession(state, sessionKey, chatId);
    const payload = await api.loadMessages(sessionKey);
    const messages = normalizeMessagesPayload(payload);
    setMessages(state, sessionKey, messages);
    sendSocketMessage(createGatewaySocketMessage.attach(chatId));
    logDesktopNativeDebug("session.select.complete", {
      ...summarizeSessionState(),
      chatId,
      messageCount: messages.length,
      sessionKey,
    });
  }

  function startNewChat(): void {
    logDesktopNativeDebug("session.new.request", summarizeSessionState());
    sendSocketMessage(createGatewaySocketMessage.newChat());
  }

  async function deleteSession(sessionKey: string): Promise<ChatDeleteSessionResult> {
    const deletedSessionKey = sessionKey;
    const target = state.sessions.find((session) => session.key === sessionKey);
    logDesktopNativeDebug("session.delete.start", {
      ...summarizeSessionState(),
      found: Boolean(target),
      sessionKey,
    });
    if (!target) {
      logDesktopNativeDebug("session.delete.missing", { sessionKey });
      return { status: "missing", deletedSessionKey, nextSessionKey: "" };
    }
    if (!api.deleteSession) {
      logDesktopNativeDebug("session.delete.unavailable", { sessionKey });
      return { status: "unavailable", deletedSessionKey, nextSessionKey: "" };
    }

    await deleteGatewaySession(target);
    state.messages.delete(sessionKey);
    state.respondingSessionKeys.delete(sessionKey);
    for (const [messageId, messageSessionKey] of state.streamMessageKeys) {
      if (messageSessionKey === sessionKey) {
        state.streamMessageKeys.delete(messageId);
      }
    }

    const sessions = normalizeSessionsPayload(await api.listSessions());
    setSessions(state, sessions);
    if (state.activeSessionKey === sessionKey) {
      const next = sessions[0];
      if (next) {
        await selectSession(next.key, next.chatId);
      } else {
        state.activeSessionKey = "";
        state.activeChatId = "";
      }
    }
    logDesktopNativeDebug("session.delete.complete", {
      ...summarizeSessionState(),
      deletedSessionKey,
      nextSessionKey: state.activeSessionKey,
    });
    return {
      status: "deleted",
      deletedSessionKey,
      nextSessionKey: state.activeSessionKey,
    };
  }

  async function deleteGatewaySession(target: NativeChatState["sessions"][number]): Promise<void> {
    if (!api.deleteSession) {
      return;
    }
    try {
      await api.deleteSession(target.key);
      logDesktopNativeDebug("session.delete.gateway", {
        key: target.key,
        mode: "primary",
      });
      return;
    } catch (error) {
      const fallbackKey = sessionKeyForChat(target.chatId);
      if (!fallbackKey || fallbackKey === target.key) {
        logDesktopNativeDebug("session.delete.failed", {
          error: error instanceof Error ? error.message : String(error),
          key: target.key,
        });
        throw error;
      }
      logDesktopNativeDebug("session.delete.retry", {
        fallbackKey,
        key: target.key,
      });
      await api.deleteSession(fallbackKey);
      logDesktopNativeDebug("session.delete.gateway", {
        key: fallbackKey,
        mode: "fallback",
      });
    }
  }

  function submitMessage(content: string, usePersistentRag = true): ChatSubmitResult {
    const trimmed = content.trim();
    if (!trimmed) {
      logDesktopNativeDebug("session.message.empty", summarizeSessionState());
      return { status: "empty" };
    }

    if (!state.activeChatId) {
      pendingMessage = { content: trimmed, usePersistentRag };
      startNewChat();
      logDesktopNativeDebug("session.message.queued", {
        ...summarizeSessionState(),
        content: summarizeDebugText(trimmed),
        usePersistentRag,
      });
      return { status: "creating", pendingContent: trimmed };
    }

    sendActiveChatMessage(trimmed, usePersistentRag);
    logDesktopNativeDebug("session.message.sent", {
      ...summarizeSessionState(),
      content: summarizeDebugText(trimmed),
      usePersistentRag,
    });
    return { status: "sent", chatId: state.activeChatId, content: trimmed };
  }

  function interruptActiveChat(): boolean {
    if (!state.activeChatId) {
      logDesktopNativeDebug("session.interrupt.skipped", summarizeSessionState());
      return false;
    }
    sendSocketMessage(createGatewaySocketMessage.interrupt(state.activeChatId));
    logDesktopNativeDebug("session.interrupt.request", summarizeSessionState());
    return true;
  }

  async function handleGatewayEvent(event: NormalizedGatewayEvent): Promise<ChatGatewayEventResult> {
    const result: ChatGatewayEventResult = {
      pendingMessageSent: false,
      loadedMessagesForChatId: "",
      reloadedSessions: false,
    };

    applyChatEvent(state, event);

    if (event.kind === "chat.created") {
      await loadSessions();
      if (!state.sessions.some((session) => session.chatId === event.chatId)) {
        activateSession(state, sessionKeyForChat(event.chatId), event.chatId);
      }
      result.reloadedSessions = true;
      if (pendingMessage) {
        const { content, usePersistentRag } = pendingMessage;
        pendingMessage = null;
        sendActiveChatMessage(content, usePersistentRag);
        logDesktopNativeDebug("session.message.queued.sent", {
          ...summarizeSessionState(),
          content: summarizeDebugText(content),
          usePersistentRag,
        });
        result.pendingMessageSent = true;
      }
    }

    if (event.kind === "attached") {
      const loaded = await loadMessagesForChat(event.chatId);
      result.loadedMessagesForChatId = loaded ? event.chatId : "";
    }

    return result;
  }

  async function loadMessagesForChat(chatId: string): Promise<boolean> {
    const sessionKey = sessionKeyForChat(chatId);
    if (!sessionKey) {
      return false;
    }
    const payload = await api.loadMessages(sessionKey);
    const messages = normalizeMessagesPayload(payload);
    setMessages(state, sessionKey, messages);
    logDesktopNativeDebug("session.messages.loaded", {
      chatId,
      messageCount: messages.length,
      sessionKey,
    });
    return true;
  }

  function sendActiveChatMessage(content: string, usePersistentRag = true): void {
    appendUserMessage(state, content, now());
    sendSocketMessage(createGatewaySocketMessage.message(state.activeChatId, content, usePersistentRag));
  }

  return {
    state,
    loadSessions,
    selectSession,
    startNewChat,
    deleteSession,
    submitMessage,
    interruptActiveChat,
    handleGatewayEvent,
    loadMessagesForChat,
  };

  function summarizeSessionState(): Record<string, unknown> {
    return {
      activeChatId: state.activeChatId,
      activeSessionKey: state.activeSessionKey,
      pendingMessage: Boolean(pendingMessage),
      sessionCount: state.sessions.length,
    };
  }
}
