import {
  createAgentUiEventState,
  normalizeAgentUiEvents,
  reduceAgentUiEventState,
  type AgentUiForm,
} from "./agentUiEvents";
import {
  createDesktopChatSessionController,
  type ChatSubmitResult,
  type DesktopChatSessionController,
  type DesktopChatSessionControllerApi,
} from "./desktopChatSessionController";
import type { DesktopTaskSourceOperation } from "./desktopTaskCenter";
import { buildDesktopAgentUiApprovalTaskOperations } from "./desktopTaskCenterSources";
import type { DesktopNativeChatModel } from "./desktopWorkbenchShell";
import type { NormalizedGatewayEvent } from "./gatewayWebSocketClient";

export interface DesktopNativeWorkbenchRuntimeOptions {
  api: DesktopChatSessionControllerApi;
  sendSocketMessage(message: unknown): void;
  now?: () => string;
}

export interface DesktopNativeWorkbenchRuntime {
  readonly chat: DesktopNativeChatModel;
  readonly chatController: DesktopChatSessionController;
  readonly agentUiForms: AgentUiForm[];
  readonly approvalOperations: DesktopTaskSourceOperation[];
  loadInitialChatState(): Promise<void>;
  setRuntimeMetadata(metadata: NonNullable<DesktopNativeChatModel["runtime"]>): void;
  selectChatSession(sessionKey: string, chatId: string): Promise<void>;
  startNewChat(): void;
  deleteChatSession(sessionKey: string): Promise<void>;
  setPersistentRag(enabled: boolean): void;
  submitComposerMessage(content: string, usePersistentRag?: boolean): ChatSubmitResult;
  interruptActiveChat(): boolean;
  handleGatewayEvent(event: NormalizedGatewayEvent): Promise<void>;
}

export function createDesktopNativeWorkbenchRuntime({
  api,
  sendSocketMessage,
  now,
}: DesktopNativeWorkbenchRuntimeOptions): DesktopNativeWorkbenchRuntime {
  const chatController = createDesktopChatSessionController({
    api,
    sendSocketMessage,
    now,
  });
  let chatStatus = "Loading sessions.";
  let usePersistentRag = true;
  let composerState: DesktopNativeChatModel["composerState"] = "idle";
  let runtimeMetadata: DesktopNativeChatModel["runtime"] = {};
  const agentUiState = createAgentUiEventState();

  async function loadInitialChatState(): Promise<void> {
    const count = await chatController.loadSessions();
    chatStatus = count ? `Loaded ${count} ${count === 1 ? "session" : "sessions"} from gateway.` : "No sessions yet.";
  }

  async function selectChatSession(sessionKey: string, chatId: string): Promise<void> {
    await chatController.selectSession(sessionKey, chatId);
    chatStatus = "Session loaded from gateway.";
  }

  function startNewChat(): void {
    chatController.startNewChat();
    chatStatus = "Creating chat session.";
  }

  async function deleteChatSession(sessionKey: string): Promise<void> {
    const result = await chatController.deleteSession(sessionKey);
    if (result.status === "deleted") {
      chatStatus = result.nextSessionKey ? "Session deleted. Next chat loaded." : "Session deleted.";
      composerState = "idle";
      return;
    }
    chatStatus = result.status === "unavailable" ? "Session deletion is unavailable." : "Session not found.";
  }

  function setPersistentRag(enabled: boolean): void {
    usePersistentRag = enabled;
    chatStatus = `Persistent RAG ${enabled ? "enabled" : "disabled"}.`;
  }

  function setRuntimeMetadata(metadata: NonNullable<DesktopNativeChatModel["runtime"]>): void {
    runtimeMetadata = { ...runtimeMetadata, ...metadata };
  }

  function submitComposerMessage(content: string, nextUsePersistentRag = usePersistentRag): ChatSubmitResult {
    usePersistentRag = nextUsePersistentRag;
    const result = chatController.submitMessage(content, usePersistentRag);
    if (result.status === "empty") {
      chatStatus = "Enter a message or attach a file before sending.";
      composerState = "idle";
    } else if (result.status === "creating") {
      chatStatus = "Creating chat session before sending.";
      composerState = "queued";
    } else {
      chatStatus = "Message sent.";
      composerState = "sending";
    }
    return result;
  }

  function interruptActiveChat(): boolean {
    const interrupted = chatController.interruptActiveChat();
    chatStatus = interrupted ? "Interrupt requested." : "No active chat to interrupt.";
    return interrupted;
  }

  async function handleGatewayEvent(event: NormalizedGatewayEvent): Promise<void> {
    if (event.kind === "usage") {
      setRuntimeMetadata({ tokenUsage: event.tokenUsage });
      return;
    }

    if (event.kind === "agent-ui.form" || event.kind === "agent-ui.event") {
      for (const agentUiEvent of normalizeAgentUiEvents(event.raw)) {
        reduceAgentUiEventState(agentUiState, agentUiEvent);
      }
      chatStatus = agentUiState.forms.size ? "Agent UI form requested." : "Agent UI event received.";
      return;
    }

    const result = await chatController.handleGatewayEvent(event);
    if (event.kind === "error") {
      chatStatus = event.message;
      composerState = "idle";
      return;
    }
    if (result.pendingMessageSent) {
      chatStatus = "Queued message sent.";
      composerState = "sending";
      return;
    }
    if (result.loadedMessagesForChatId) {
      chatStatus = "Session loaded from gateway.";
      return;
    }
    if (event.kind === "message.delta") {
      composerState = "sending";
      return;
    }
    if (event.kind === "message.completed") {
      composerState = "idle";
      return;
    }
    if (event.kind === "message.stream.completed" || event.kind === "interrupted") {
      composerState = "idle";
      return;
    }
    if (result.reloadedSessions) {
      chatStatus = "Sessions refreshed.";
    }
  }

  return {
    get chat() {
      const state = chatController.state;
      return {
        sessions: state.sessions,
        activeSessionKey: state.activeSessionKey,
        activeChatId: state.activeChatId,
        messages: state.messages.get(state.activeSessionKey) ?? [],
        status: chatStatus || state.error,
        responding: state.activeSessionKey ? state.respondingSessionKeys.has(state.activeSessionKey) : false,
        usePersistentRag,
        composerState,
        runtime: runtimeMetadata,
      };
    },
    chatController,
    get agentUiForms() {
      return [...agentUiState.forms.values()];
    },
    get approvalOperations() {
      return buildDesktopAgentUiApprovalTaskOperations(agentUiState);
    },
    loadInitialChatState,
    setRuntimeMetadata,
    selectChatSession,
    startNewChat,
    deleteChatSession,
    setPersistentRag,
    submitComposerMessage,
    interruptActiveChat,
    handleGatewayEvent,
  };
}
