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

export interface DesktopChatSessionControllerApi {
  listSessions(): Promise<unknown>;
  loadMessages(sessionKey: string): Promise<unknown>;
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

export interface DesktopChatSessionController {
  readonly state: NativeChatState;
  loadSessions(): Promise<number>;
  selectSession(sessionKey: string, chatId: string): Promise<void>;
  startNewChat(): void;
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
    const sessions = normalizeSessionsPayload(await api.listSessions());
    setSessions(state, sessions);
    if (!state.activeSessionKey && sessions[0]) {
      await selectSession(sessions[0].key, sessions[0].chatId);
    }
    return sessions.length;
  }

  async function selectSession(sessionKey: string, chatId: string): Promise<void> {
    activateSession(state, sessionKey, chatId);
    const payload = await api.loadMessages(sessionKey);
    setMessages(state, sessionKey, normalizeMessagesPayload(payload));
    sendSocketMessage(createGatewaySocketMessage.attach(chatId));
  }

  function startNewChat(): void {
    sendSocketMessage(createGatewaySocketMessage.newChat());
  }

  function submitMessage(content: string, usePersistentRag = true): ChatSubmitResult {
    const trimmed = content.trim();
    if (!trimmed) {
      return { status: "empty" };
    }

    if (!state.activeChatId) {
      pendingMessage = { content: trimmed, usePersistentRag };
      startNewChat();
      return { status: "creating", pendingContent: trimmed };
    }

    sendActiveChatMessage(trimmed, usePersistentRag);
    return { status: "sent", chatId: state.activeChatId, content: trimmed };
  }

  function interruptActiveChat(): boolean {
    if (!state.activeChatId) {
      return false;
    }
    sendSocketMessage(createGatewaySocketMessage.interrupt(state.activeChatId));
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
      result.reloadedSessions = true;
      if (pendingMessage) {
        const { content, usePersistentRag } = pendingMessage;
        pendingMessage = null;
        sendActiveChatMessage(content, usePersistentRag);
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
    setMessages(state, sessionKey, normalizeMessagesPayload(payload));
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
    submitMessage,
    interruptActiveChat,
    handleGatewayEvent,
    loadMessagesForChat,
  };
}
