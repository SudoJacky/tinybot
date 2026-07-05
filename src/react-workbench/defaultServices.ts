import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createDesktopChatSessionController } from "../app-core/chat/desktopChatSessionController";
import { sessionKeyForChat, type NativeChatMessage, type NativeChatReference, type NativeChatSession } from "../app-core/chat/nativeChat";
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
import { createDesktopNativeThreadsApi } from "../app-core/native/desktopNativeThreads";
import { createDesktopNativeTransportApi } from "../app-core/native/desktopNativeTransport";
import { toDesktopNativeTauriEventName } from "../app-core/native/desktopNativeTauriEvents";
import { createDesktopNativeWebuiApi } from "../app-core/native/desktopNativeWebui";
import { createDesktopNativeWorkspaceApi } from "../app-core/native/desktopNativeWorkspace";
import { startDesktopNativeChannelRuntime } from "../app-core/native/desktopNativeChannelLifecycle";
import { normalizeNativeBackendEventPayload } from "../app-core/native/nativeBackendContract";
import {
  buildDesktopProviderCatalogItems,
  buildDesktopSettingsFormState,
  buildDesktopSettingsPaneModel,
} from "../app-core/settings/desktopSettingsProviders";
import type {
  AppServices,
  ChatModelOption,
  ChatEvent,
  KnowledgeDocumentSummary,
  SessionSummary,
  SkillSummary,
  WorkspaceFileSummary,
} from "./services";
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
  const nativeThreads = nativeMode ? createDesktopNativeThreadsApi({ invoke }) : undefined;
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
    nativeThreads,
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
  let pendingNewSession: SessionSummary | null = null;
  let pendingNewSessionTitle = "";

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
    const titleForCreatedSession = event.kind === "chat.created" ? pendingNewSessionTitle : "";
    await controller.handleGatewayEvent(event);
    if (event.kind === "chat.created") {
      if (titleForCreatedSession) {
        await persistAutoSessionTitle(sessionKeyForChat(event.chatId), titleForCreatedSession);
      }
      pendingNewSessionId = "";
      pendingNewSession = null;
      pendingNewSessionTitle = "";
    }
    notifyAll(chatEventFromGatewayEvent(event));
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

  async function persistAutoSessionTitle(sessionId: string, title: string): Promise<void> {
    if (!title) {
      return;
    }
    await controller.patchSession(sessionId, { title });
  }

  async function loadSettingsSnapshot(): Promise<unknown> {
    return gatewayApi.config.get().catch(async () => nativeConfig?.get().catch(() => null) ?? null);
  }

  async function loadProviderCatalog(): Promise<unknown[]> {
    const payload = await gatewayApi.config.providers().catch(() => []);
    if (Array.isArray(payload)) {
      return payload;
    }
    if (isRecord(payload)) {
      const providers = payloadItems(payload, ["providers", "items", "catalog"]);
      return providers.length ? providers : [payload];
    }
    return [];
  }

  return {
    sessionStore: {
      async list() {
        await initialize();
        const sessions = controller.state.sessions.map((session) => mapSession(session, controller.state.respondingSessionKeys.has(session.key)));
        if (pendingNewSession && !sessions.some((session) => session.id === pendingNewSession?.id)) {
          return [pendingNewSession, ...sessions];
        }
        return sessions;
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
        pendingNewSession = pendingSession;
        notifySession(pendingNewSessionId, { type: "session-created" });
        return pendingSession;
      },
      async delete(id) {
        await initialize();
        if (id.startsWith("pending:")) {
          pendingNewSessionId = "";
          pendingNewSession = null;
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
        if (session && controller.state.activeSessionKey !== session.key) {
          await controller.selectSession(session.key, session.chatId);
        }
        const sessionMessages = controller.state.messages.get(sessionId) ?? [];
        const sessionRunning = controller.state.respondingSessionKeys.has(sessionId);
        return sessionMessages.map((message, index) => mapMessage(message, index, {
          isLatest: index === sessionMessages.length - 1,
          sessionRunning,
        }));
      },
      async send(sessionId, input) {
        await initialize();
        const selectedSessionBeforeSend = controller.state.sessions.find((item) => item.key === sessionId);
        if (sessionId === pendingNewSessionId) {
          controller.state.activeSessionKey = "";
          controller.state.activeChatId = "";
        } else {
          const session = controller.state.sessions.find((item) => item.key === sessionId);
          if (session && controller.state.activeSessionKey !== session.key) {
            await controller.selectSession(session.key, session.chatId);
          }
        }
        const result = controller.submitMessage(input.text, input.usePersistentRag ?? true, input.model);
        const optimisticText = result.status === "sent"
          ? result.content
          : result.status === "creating"
            ? result.pendingContent
            : "";
        const optimisticTitle = autoSessionTitleFromMessage(optimisticText);
        if (result.status === "creating") {
          pendingNewSessionTitle = optimisticTitle;
        } else if (
          result.status === "sent"
          && optimisticTitle
          && shouldPersistAutoSessionTitle(selectedSessionBeforeSend?.title)
        ) {
          await persistAutoSessionTitle(sessionKeyForChat(result.chatId), optimisticTitle);
        }
        notifySession(sessionId, {
          type: "message-sent",
          ...(optimisticText ? { message: createOptimisticUserMessage(optimisticText) } : {}),
        });
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
    workspaceStore: {
      async listFiles() {
        await initialize();
        return normalizeWorkspaceFiles(await gatewayApi.workspace.files());
      },
    },
    knowledgeStore: {
      async listDocuments() {
        await initialize();
        return normalizeKnowledgeDocuments(await gatewayApi.knowledge.documents());
      },
      async stats() {
        await initialize();
        return normalizeStats(await gatewayApi.knowledge.stats());
      },
    },
    toolsStore: {
      async listSkills() {
        await initialize();
        return normalizeSkills(await gatewayApi.skills.list());
      },
    },
    settingsStore: {
      async load() {
        await initialize();
        const snapshot = await loadSettingsSnapshot();
        return normalizeSettingsSummary(snapshot, config);
      },
      async loadChatModels() {
        await initialize();
        const snapshot = await loadSettingsSnapshot();
        if (!isRecord(snapshot)) {
          return [];
        }
        const providerCatalog = buildDesktopProviderCatalogItems(await loadProviderCatalog());
        const state = buildDesktopSettingsFormState(snapshot, providerCatalog);
        const pane = buildDesktopSettingsPaneModel(state, { providerCatalog });
        return normalizeChatModelOptions(pane);
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

function mapMessage(
  message: NativeChatMessage,
  index: number,
  options: { isLatest?: boolean; sessionRunning?: boolean } = {},
): ReactChatMessage {
  const role = message.role === "user" || message.role === "system" || message.role === "tool"
    ? message.role
    : "assistant";
  const toolCalls = (message.toolActivities ?? []).map((activity) => ({
    id: activity.id,
    name: activity.name,
    status: activity.status || activity.approvalStatus || (activity.kind === "result" ? "complete" : "running"),
    summary: activity.responseText || activity.argsText,
  }));
  const streaming = role === "assistant" && Boolean(options.sessionRunning && options.isLatest);
  const contextReferences = (message.references ?? []).map(mapContextReference);
  return {
    id: message.messageId || `${role}:${index}`,
    role,
    createdAtMs: timestampMs(message.timestamp) ?? Date.now(),
    text: message.content || (toolCalls.length ? "Tool activity" : ""),
    status: streaming ? "streaming" : "complete",
    ...(contextReferences.length ? { contextReferences } : {}),
    ...(message.reasoningContent ? { reasoningText: message.reasoningContent } : {}),
    ...(toolCalls.length ? { toolCalls } : {}),
  };
}

function createOptimisticUserMessage(text: string): ReactChatMessage {
  return {
    id: `local:user:${Date.now().toString(36)}`,
    role: "user",
    createdAtMs: Date.now(),
    text,
    status: "complete",
  };
}

function autoSessionTitleFromMessage(text: string): string {
  const firstLine = text.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  return firstLine.slice(0, 80);
}

function shouldPersistAutoSessionTitle(title: string | undefined): boolean {
  const normalized = (title ?? "").trim();
  return !normalized
    || normalized === "New session"
    || normalized.startsWith("Desktop Session websocket:");
}

function mapContextReference(reference: NativeChatReference, index: number) {
  return {
    id: reference.noteId || reference.evidenceId || `${reference.kind}:${index}`,
    kind: reference.kind,
    title: reference.title,
    ...(reference.detail ? { detail: reference.detail } : {}),
    ...(reference.sourcePath ? { sourcePath: reference.sourcePath } : {}),
    ...(typeof reference.sourceLine === "number" ? { sourceLine: reference.sourceLine } : {}),
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
  if (!isRecord(payload)) {
    return null;
  }
  const value = payload.updated_at ?? payload.updatedAt;
  return typeof value === "string" ? timestampMs(value) : null;
}

function normalizeWorkspaceFiles(payload: unknown): WorkspaceFileSummary[] {
  return payloadItems(payload, ["files", "items"]).map((item) => {
    const path = stringValue(item.path ?? item.name ?? item.file ?? item.relative_path);
    return {
      path: path || "Untitled file",
      size: numberValue(item.size ?? item.bytes),
      updatedAtMs: timestampMs(stringValue(item.updated_at ?? item.updatedAt ?? item.modified_at)) ?? undefined,
    };
  });
}

function normalizeKnowledgeDocuments(payload: unknown): KnowledgeDocumentSummary[] {
  return payloadItems(payload, ["documents", "items"]).map((item, index) => {
    const id = stringValue(item.id ?? item.doc_id ?? item.document_id ?? item.path) || `document:${index}`;
    return {
      id,
      title: stringValue(item.title ?? item.name ?? item.path) || id,
      source: stringValue(item.source ?? item.source_path ?? item.path),
      updatedAtMs: timestampMs(stringValue(item.updated_at ?? item.updatedAt ?? item.created_at)) ?? undefined,
    };
  });
}

function normalizeSkills(payload: unknown): SkillSummary[] {
  return payloadItems(payload, ["skills", "items"]).map((item) => {
    const name = stringValue(item.name ?? item.id ?? item.slug);
    return {
      name: name || "Unnamed skill",
      description: stringValue(item.description ?? item.summary),
    };
  });
}

function normalizeStats(payload: unknown): Array<{ label: string; value: string }> {
  if (Array.isArray(payload)) {
    return payload.filter(isRecord).map((item) => ({
      label: labelFromKey(stringValue(item.label ?? item.name ?? item.key)),
      value: stringValue(item.value ?? item.count ?? item.total),
    })).filter((item) => item.label && item.value);
  }
  if (!isRecord(payload)) {
    return [];
  }
  const stats = isRecord(payload.stats) ? payload.stats : payload;
  return Object.entries(stats)
    .filter(([, value]) => value !== null && value !== undefined && typeof value !== "object")
    .map(([key, value]) => ({ label: labelFromKey(key), value: stringValue(value) }));
}

function normalizeSettingsSummary(snapshot: unknown, config: { httpBaseUrl: string; requestTimeoutMs: number; wsUrl: string }) {
  const rows = [
    { label: "Gateway URL", value: config.httpBaseUrl },
    { label: "WebSocket URL", value: config.wsUrl },
    { label: "Request timeout", value: `${config.requestTimeoutMs} ms` },
  ];
  if (!isRecord(snapshot)) {
    return rows;
  }
  const agents = isRecord(snapshot.agents) ? snapshot.agents : {};
  const defaults = isRecord(snapshot.defaults)
    ? snapshot.defaults
    : isRecord(agents.defaults)
      ? agents.defaults
      : agents;
  const model = stringValue(defaults.model ?? defaults.default_model ?? snapshot.model);
  if (model) {
    rows.unshift({ label: "Default model", value: model });
  }
  const providers = payloadItems(snapshot.providers ?? snapshot.llm_providers ?? snapshot.provider_configs, ["items"]);
  if (providers.length) {
    rows.push({ label: "Providers", value: String(providers.length) });
  }
  return rows;
}

function chatEventFromGatewayEvent(event: NormalizedGatewayEvent): ChatEvent {
  if (event.kind !== "agent.event") {
    return { type: event.kind };
  }
  const eventType = stringValue(event.raw.event_type);
  return {
    type: event.kind,
    ...(eventType ? { eventType } : {}),
  };
}

function normalizeChatModelOptions(
  pane: ReturnType<typeof buildDesktopSettingsPaneModel>,
): ChatModelOption[] {
  const defaultModel = stringValue(pane.defaultRouting?.model);
  const defaultProviderId = stringValue(pane.defaultRouting?.providerId);
  const options = new Map<string, ChatModelOption>();
  for (const provider of pane.providerCatalog) {
    if (provider.enabled === false) {
      continue;
    }
    for (const model of provider.models ?? []) {
      if (!model || options.has(model)) {
        continue;
      }
      const isDefault = model === defaultModel;
      options.set(model, {
        id: model,
        label: model,
        description: provider.label || provider.id || "Configured provider",
        providerId: provider.id,
        providerLabel: provider.label,
        ...(isDefault ? { default: true } : {}),
      });
    }
  }
  if (defaultModel && !options.has(defaultModel)) {
    const defaultProvider = pane.providerCatalog.find((provider) => provider.id === defaultProviderId);
    options.set(defaultModel, {
      id: defaultModel,
      label: defaultModel,
      description: defaultProvider?.label || pane.defaultRouting?.providerLabel || "Default model",
      providerId: defaultProvider?.id || defaultProviderId,
      providerLabel: defaultProvider?.label || pane.defaultRouting?.providerLabel,
      default: true,
    });
  }
  return [...options.values()].sort((left, right) => {
    if (left.default) {
      return -1;
    }
    if (right.default) {
      return 1;
    }
    return left.label.localeCompare(right.label);
  });
}

function payloadItems(payload: unknown, keys: string[]): Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    return payload.filter(isRecord);
  }
  if (!isRecord(payload)) {
    return [];
  }
  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value)) {
      return value.filter(isRecord);
    }
  }
  return [];
}

function labelFromKey(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function numberValue(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function hasTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in globalThis;
}
