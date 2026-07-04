import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createDesktopChatSessionController } from "../app-core/chat/desktopChatSessionController";
import type { NativeChatMessage, NativeChatSession } from "../app-core/chat/nativeChat";
import { DEFAULT_GATEWAY_CONFIG, resolveGatewayConfig } from "../app-core/gateway/gatewayConfig";
import { installDesktopGatewayBridge } from "../app-core/gateway/desktopGatewayBridge";
import { ensureGatewayReady } from "../app-core/gateway/desktopGatewayStartup";
import {
  checkGatewayHealth,
  createGatewayApiClient,
  DEFAULT_TS_COWORK_RUNTIME_ROLLOUT,
} from "../app-core/gateway/gatewayHttpClient";
import {
  flushGatewaySocketQueue,
  openGatewaySocket,
  sendGatewaySocketJson,
  type NormalizedGatewayEvent,
} from "../app-core/gateway/gatewayWebSocketClient";
import { createDesktopNativeConfigApi } from "../app-core/native/desktopNativeConfig";
import { createDesktopNativeCoworkApi } from "../app-core/native/desktopNativeCowork";
import { createDesktopNativeKnowledgeApi } from "../app-core/native/desktopNativeKnowledge";
import { createDesktopNativeSessionsApi } from "../app-core/native/desktopNativeSessions";
import { createDesktopNativeSkillsApi } from "../app-core/native/desktopNativeSkills";
import { createDesktopNativeTransportApi } from "../app-core/native/desktopNativeTransport";
import { toDesktopNativeTauriEventName } from "../app-core/native/desktopNativeTauriEvents";
import { createDesktopNativeWebuiApi } from "../app-core/native/desktopNativeWebui";
import { createDesktopNativeWorkspaceApi } from "../app-core/native/desktopNativeWorkspace";
import { startDesktopNativeChannelRuntime } from "../app-core/native/desktopNativeChannelLifecycle";
import { normalizeNativeBackendEventPayload } from "../app-core/native/nativeBackendContract";
import type { AppServices, ChatEvent, SessionSummary } from "./services";
import type { ReactChatMessage } from "./chat/messageActions";

type Listener = (event: ChatEvent) => void;

export function createDesktopAppServices(): AppServices {
  const config = resolveGatewayConfig(DEFAULT_GATEWAY_CONFIG);
  const nativeMode = hasTauriRuntime();
  const nativeConfig = nativeMode ? createDesktopNativeConfigApi({ invoke }) : undefined;
  const nativeCowork = nativeMode ? createDesktopNativeCoworkApi({ invoke }) : undefined;
  const nativeKnowledge = nativeMode ? createDesktopNativeKnowledgeApi({ invoke }) : undefined;
  const nativeSessions = nativeMode ? createDesktopNativeSessionsApi({ invoke }) : undefined;
  const nativeSkills = nativeMode ? createDesktopNativeSkillsApi({ invoke }) : undefined;
  const nativeTransport = nativeMode ? createDesktopNativeTransportApi({ invoke }) : undefined;
  const nativeWebui = nativeMode ? createDesktopNativeWebuiApi({ invoke }) : undefined;
  const nativeWorkspace = nativeMode ? createDesktopNativeWorkspaceApi({ invoke }) : undefined;
  const gatewayApi = createGatewayApiClient({
    config,
    nativeConfig,
    nativeCowork,
    nativeKnowledge,
    nativeSessions,
    nativeSkills,
    nativeWebui,
    nativeWorkspace,
    tsCoworkRuntime: DEFAULT_TS_COWORK_RUNTIME_ROLLOUT,
  });
  let initialized: Promise<void> | null = null;
  let socket: WebSocket | null = null;
  let wsUrl = config.wsUrl;
  const pendingSocketMessages: unknown[] = [];
  const listeners = new Map<string, Set<Listener>>();
  let pendingNewSessionId = "";

  const controller = createDesktopChatSessionController({
    api: {
      listSessions: () => gatewayApi.sessions.list(),
      loadMessages: (sessionKey) => gatewayApi.sessions.messages(sessionKey),
      listAgentRuns: (sessionKey) => gatewayApi.sessions.agentRuns?.(sessionKey) ?? Promise.resolve({ runs: [] }),
      getAgentRunRuntimeState: (sessionKey, runId) => gatewayApi.sessions.agentRunRuntimeState?.(sessionKey, runId) ?? Promise.resolve(null),
      deleteSession: (sessionKey) => gatewayApi.sessions.delete(sessionKey),
      patchSession: (sessionKey, body) => gatewayApi.sessions.patch(sessionKey, body),
    },
    sendSocketMessage,
  });

  async function initialize(): Promise<void> {
    initialized ??= (async () => {
      if (nativeMode && nativeTransport && nativeWebui) {
        await ensureGatewayReady(config, { invoke, hasTauriRuntime });
        await startDesktopNativeChannelRuntime({ nativeTransport });
        installDesktopGatewayBridge({
          config,
          nativeTransport,
          nativeWebui,
          resolveNativeWebSocketSessionExists,
          listenToNativeAgentEvent: (eventName, handler) => listen(toDesktopNativeTauriEventName(eventName), (event) => {
            handler(normalizeNativeBackendEventPayload(event.payload));
          }),
        });
      }
      const health = await checkGatewayHealth({ config }).catch(() => null);
      wsUrl = health?.tokenReady ? health.wsUrl : config.wsUrl;
      ensureSocket();
      await controller.loadSessions();
    })();
    return initialized;
  }

  async function resolveNativeWebSocketSessionExists(sessionId: string): Promise<boolean | undefined> {
    try {
      await gatewayApi.sessions.messages(sessionId);
      return true;
    } catch {
      return undefined;
    }
  }

  function ensureSocket(): void {
    if (socket && socket.readyState <= WebSocket.OPEN) {
      return;
    }
    socket = openGatewaySocket(resolveGatewayConfig({ ...config, wsUrl }), {
      onOpen: () => {
        flushGatewaySocketQueue(socket, pendingSocketMessages);
        notifyAll({ type: "socket-open" });
      },
      onClose: () => notifyAll({ type: "socket-close" }),
      onError: () => notifyAll({ type: "socket-error" }),
      onEvent: (event) => {
        void handleGatewayEvent(event);
      },
    });
  }

  function sendSocketMessage(message: unknown): void {
    ensureSocket();
    sendGatewaySocketJson(socket, message, pendingSocketMessages);
  }

  async function handleGatewayEvent(event: NormalizedGatewayEvent): Promise<void> {
    await controller.handleGatewayEvent(event);
    if (event.kind === "chat.created") {
      pendingNewSessionId = "";
    }
    notifyAll({ type: event.kind });
  }

  function notifyAll(event: ChatEvent): void {
    for (const callbacks of listeners.values()) {
      for (const callback of callbacks) {
        callback(event);
      }
    }
  }

  function notifySession(sessionId: string, event: ChatEvent): void {
    for (const callback of listeners.get(sessionId) ?? []) {
      callback(event);
    }
  }

  return {
    sessionStore: {
      async list() {
        await initialize();
        return controller.state.sessions.map((session) => mapSession(session, controller.state.respondingSessionKeys.has(session.key)));
      },
      async create(input) {
        await initialize();
        pendingNewSessionId = `pending:${Date.now().toString(36)}`;
        controller.state.activeSessionKey = "";
        controller.state.activeChatId = "";
        controller.startNewChat();
        const pendingSession = {
          id: pendingNewSessionId,
          title: input?.title || "New session",
          updatedAtMs: Date.now(),
          status: "running" as const,
        };
        notifySession(pendingNewSessionId, { type: "session-created" });
        return pendingSession;
      },
      async delete(id) {
        await initialize();
        if (id.startsWith("pending:")) {
          pendingNewSessionId = "";
          return;
        }
        await controller.deleteSession(id);
        notifyAll({ type: "session-deleted" });
      },
      async rename(id, title) {
        await initialize();
        await controller.patchSession(id, { title });
        notifySession(id, { type: "session-renamed" });
      },
      async pin(id, pinned) {
        await initialize();
        await controller.patchSession(id, { metadata: { pinned } });
        notifySession(id, { type: "session-pinned" });
      },
      async archive(id) {
        await initialize();
        await controller.patchSession(id, { archived: true });
        notifySession(id, { type: "session-archived" });
      },
    },
    chatStore: {
      async load(sessionId) {
        await initialize();
        if (sessionId.startsWith("pending:")) {
          return [];
        }
        const session = controller.state.sessions.find((item) => item.key === sessionId);
        if (session) {
          await controller.selectSession(session.key, session.chatId);
        }
        return (controller.state.messages.get(sessionId) ?? []).map((message, index) => mapMessage(message, index));
      },
      async send(sessionId, input) {
        await initialize();
        if (sessionId === pendingNewSessionId) {
          controller.state.activeSessionKey = "";
          controller.state.activeChatId = "";
        } else {
          const session = controller.state.sessions.find((item) => item.key === sessionId);
          if (session && controller.state.activeSessionKey !== session.key) {
            await controller.selectSession(session.key, session.chatId);
          }
        }
        controller.submitMessage(input.text, true);
        notifySession(sessionId, { type: "message-sent" });
      },
      async stop() {
        await initialize();
        controller.interruptActiveChat();
        notifyAll({ type: "chat-stopped" });
      },
      async branchFromMessage(sessionId, messageId) {
        await initialize();
        const payload = await gatewayApi.sessions.branch?.({ session_key: sessionId, message_id: messageId });
        await controller.loadSessions();
        return mapSession(controller.state.sessions[0] ?? {
          key: sessionId,
          chatId: "",
          title: "Branch",
          createdAt: "",
          updatedAt: new Date().toISOString(),
        }, false, payload);
      },
      async copyMarkdown(sessionId) {
        await initialize();
        const messages = controller.state.messages.get(sessionId) ?? [];
        return messages.map((message) => `${message.role}: ${message.content}`).join("\n\n");
      },
      subscribe(sessionId, listener) {
        const callbacks = listeners.get(sessionId) ?? new Set<Listener>();
        callbacks.add(listener);
        listeners.set(sessionId, callbacks);
        return () => {
          callbacks.delete(listener);
          if (!callbacks.size) {
            listeners.delete(sessionId);
          }
        };
      },
    },
  };
}

function mapSession(session: NativeChatSession, responding: boolean, fallbackPayload?: unknown): SessionSummary {
  return {
    id: session.key,
    chatId: session.chatId,
    title: session.title || "New session",
    updatedAtMs: timestampMs(session.updatedAt) ?? timestampFromPayload(fallbackPayload) ?? Date.now(),
    ...(session.pinned ? { pinned: true } : {}),
    status: responding ? "running" : "idle",
  };
}

function mapMessage(message: NativeChatMessage, index: number): ReactChatMessage {
  const role = message.role === "user" || message.role === "system" || message.role === "tool"
    ? message.role
    : "assistant";
  const toolCalls = (message.toolActivities ?? []).map((activity) => ({
    id: activity.id,
    name: activity.name,
    status: activity.status || activity.approvalStatus || (activity.kind === "result" ? "complete" : "running"),
    summary: activity.responseText || activity.argsText,
  }));
  return {
    id: message.messageId || `${role}:${index}`,
    role,
    createdAtMs: timestampMs(message.timestamp) ?? Date.now(),
    text: message.content || message.reasoningContent || (toolCalls.length ? "Tool activity" : ""),
    status: "complete",
    ...(toolCalls.length ? { toolCalls } : {}),
  };
}

function timestampMs(value: string): number | null {
  if (!value) {
    return null;
  }
  if (value.startsWith("unix-ms:")) {
    const parsed = Number(value.slice("unix-ms:".length));
    return Number.isFinite(parsed) ? parsed : null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function timestampFromPayload(payload: unknown): number | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const value = record.updated_at ?? record.updatedAt;
  return typeof value === "string" ? timestampMs(value) : null;
}

function hasTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in globalThis;
}
