import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createDesktopChatSessionController } from "../app-core/chat/desktopChatSessionController";
import { sessionKeyForChat, sessionKeyForChatState, type NativeChatReference, type NativeChatSession } from "../app-core/chat/nativeChat";
import { submitDesktopApprovalAction } from "../app-core/agent-ui/desktopApprovalActions";
import {
  AGENT_UI_FORM_STATUSES,
  buildAgentUiFormCancelRequest,
  buildAgentUiFormSubmitRequest,
  createAgentUiEventState,
  normalizeAgentUiEvents,
  reduceAgentUiEventState,
  type AgentUiForm,
} from "../app-core/agent-ui/agentUiEvents";
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
import { applyNativeConfigPatch } from "../app-core/native/desktopNativeConfigPatch";
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
import { saveDesktopSettingsConfig } from "../app-core/settings/desktopSettingsSave";
import { buildAgentDefaultsSettings } from "../app-core/settings/agentDefaultsSettings";
import {
  buildProviderModelsSettings,
  normalizeProviderModelFetchResult,
} from "../app-core/settings/providerModelsSettings";
import type {
  AppServices,
  ChatModelOption,
  ChatEvent,
  KnowledgeDocumentSummary,
  SessionSummary,
  SkillSummary,
  WorkspaceDirectoryPage,
  WorkspaceFileChunk,
  WorkspaceFileSummary,
  WorkspaceQueryError,
  WorkspaceQueryErrorCode,
} from "./services";
import type { ReactChatMessage } from "./chat/messageActions";
import { createTinyOsAgentCancelCommand, type TinyOsCommand } from "../app-core/chat/tinyOsCommandGateway";
import { normalizeTinyOsEffectiveCapabilities } from "../app-core/chat/tinyOsCapabilities";

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
  const agentUiState = createAgentUiEventState();

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
        await listen(toDesktopNativeTauriEventName("agent.timeline.patch"), async (event) => {
          const payload = normalizeNativeBackendEventPayload(event.payload);
          const sessionId = isRecord(payload) ? stringValue(payload.sessionId) : "";
          if (!sessionId) {
            notifyAll({ type: "timeline.error", error: "Canonical timeline patch is missing sessionId" });
            return;
          }
          try {
            const timeline = await controller.applyTimelinePatch(sessionId, payload);
            if (timeline) {
              notifySession(sessionId, { type: "timeline.patch", timeline });
            }
          } catch (error) {
            notifySession(sessionId, {
              type: "timeline.error",
              error: error instanceof Error ? error.message : String(error),
            });
          }
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
    reduceAgentUiEventsFromGatewayEvent(event);
    if (event.kind === "chat.created") {
      pendingNewSessionId = "";
      pendingNewSession = null;
    }
    const chatEvent = chatEventFromGatewayEvent(event);
    const usageSessionId = event.kind === "usage" ? sessionKeyForGatewayEvent(event) : "";
    if (usageSessionId) {
      notifySession(usageSessionId, chatEvent);
    } else {
      notifyAll(chatEvent);
    }
  }

  function sessionKeyForGatewayEvent(event: NormalizedGatewayEvent): string {
    if (event.kind === "usage" && event.chatId) {
      return sessionKeyForChatState(controller.state, event.chatId) || sessionKeyForChat(event.chatId);
    }
    return controller.state.activeSessionKey;
  }

  function reduceAgentUiEventsFromGatewayEvent(event: NormalizedGatewayEvent): void {
    if (event.kind !== "agent-ui.form" && event.kind !== "agent-ui.event" && event.kind !== "browser.frame" && event.kind !== "browser.snapshot") {
      return;
    }
    for (const agentUiEvent of normalizeAgentUiEvents(event.raw)) {
      reduceAgentUiEventState(agentUiState, agentUiEvent);
    }
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

  async function dispatchTinyOsCommand(command: TinyOsCommand): Promise<void> {
    await initialize();
    const session = controller.state.sessions.find((item) => item.key === command.target.sessionId);
    if (session && controller.state.activeSessionKey !== session.key) {
      await controller.selectSession(session.key, session.chatId);
    }
    if (!controller.dispatchCommand(command)) {
      throw new Error(`Cannot dispatch ${command.kind}: target session is not active`);
    }
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
          return {
            schemaVersion: "tinybot.chat_timeline.v1",
            sessionId,
            source: "canonical",
            runRevisions: {},
            turns: [],
            diagnostics: [],
          };
        }
        const session = controller.state.sessions.find((item) => item.key === sessionId);
        if (session && controller.state.activeSessionKey !== session.key) {
          await controller.selectSession(session.key, session.chatId);
        }
        return controller.loadTimeline(sessionId);
      },
      async loadTinyOsCapabilities(sessionId) {
        await initialize();
        return normalizeTinyOsEffectiveCapabilities(
          await gatewayApi.sessions.effectiveCapabilities(sessionId),
          sessionId,
        );
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
        const result = controller.submitMessage(input.text, input.usePersistentRag ?? true, input.model, input.references);
        const optimisticText = result.status === "sent"
          ? result.content
          : result.status === "creating"
            ? result.pendingContent
            : "";
        const optimisticMessage = result.status === "empty"
          ? undefined
          : createOptimisticUserMessage(result.clientEventId, optimisticText, input.references);
        notifySession(sessionId, {
          type: "message-sent",
          ...(optimisticMessage ? { message: optimisticMessage } : {}),
        });
      },
      async dispatchCommand(command) {
        await dispatchTinyOsCommand(command);
      },
      async stop(sessionId) {
        await initialize();
        const timeline = await controller.loadTimeline(sessionId);
        const turn = [...timeline.turns].reverse().find((candidate) => (
          candidate.status === "pending"
          || candidate.status === "running"
          || candidate.status === "awaiting_approval"
          || candidate.status === "awaiting_user"
        ));
        if (!turn) throw new Error("Cannot cancel: the session has no active run");
        const command = createTinyOsAgentCancelCommand({
          runId: turn.id,
          sessionId,
          source: { control: "keyboard-shortcut", surface: "chat" },
          threadId: turn.canonicalItems?.find((item) => item.threadId)?.threadId,
          turnId: turn.id,
        });
        notifySession(sessionId, { command, type: "command.dispatched" });
        await dispatchTinyOsCommand(command);
      },
      async resolveApproval(sessionId, input) {
        await initialize();
        try {
          await submitDesktopApprovalAction({
            action: input.action,
            approvalId: input.approvalId,
            gatewayTools: gatewayApi.tools,
            ...(input.guidance ? { guidance: input.guidance } : {}),
            invoke,
            preferNativeWorkerResume: nativeMode,
            sessionKey: sessionId,
          });
        } finally {
          await controller.reloadTimeline(sessionId);
        }
        await controller.loadSessions();
        notifySession(sessionId, { type: "approval-resolved" });
      },
      async listAgentUiForms(sessionId) {
        await initialize();
        return Array.from(agentUiState.forms.values()).filter((form) => formMatchesSession(form, sessionId));
      },
      async submitAgentUiForm(formId, values) {
        await initialize();
        const form = agentUiState.forms.get(formId);
        if (!form) {
          return;
        }
        const request = buildAgentUiFormSubmitRequest(form, values);
        if (!request) {
          return;
        }
        await gatewayApi.agentUi.submitForm(formId, request);
        agentUiState.forms.set(formId, {
          ...form,
          status: AGENT_UI_FORM_STATUSES.submitted,
          submitting: false,
          values: { ...values },
        });
        notifyAll({ type: "agent-ui.form" });
      },
      async cancelAgentUiForm(formId) {
        await initialize();
        const form = agentUiState.forms.get(formId);
        if (!form) {
          return;
        }
        const request = buildAgentUiFormCancelRequest(form);
        if (!request) {
          return;
        }
        await gatewayApi.agentUi.cancelForm(formId, request);
        agentUiState.forms.set(formId, {
          ...form,
          status: AGENT_UI_FORM_STATUSES.cancelled,
          submitting: false,
        });
        notifyAll({ type: "agent-ui.form" });
      },
      async loadDelegateTrace(selection) {
        await initialize();
        return controller.loadDelegateTrace(selection);
      },
      async loadArtifact(selection) {
        await initialize();
        return controller.loadArtifact(selection);
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
        const timeline = await controller.loadTimeline(sessionId);
        return timeline.turns.flatMap((turn) => [
          `user: ${turn.userMessage.text}`,
          ...(turn.finalMessage ? [`assistant: ${turn.finalMessage.text}`] : []),
        ]).join("\n\n");
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
      async listDirectory(request) {
        await initialize();
        return normalizeWorkspaceDirectoryPage(await gatewayApi.workspace.directory(request));
      },
      async readFile(request) {
        await initialize();
        return normalizeWorkspaceFileChunk(await gatewayApi.workspace.fileChunk(request));
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
      async loadProviderSettings() {
        await initialize();
        return buildProviderModelsSettings(await loadSettingsSnapshot());
      },
      async loadAgentDefaultsSettings() {
        await initialize();
        return buildAgentDefaultsSettings(await loadSettingsSnapshot());
      },
      async saveAgentDefaultsSettings(currentConfig, patch) {
        await initialize();
        const result = await saveDesktopSettingsConfig(currentConfig, patch, {
          applyNativeConfigPatch: nativeMode
            ? (configToPatch, nativePatch) => applyNativeConfigPatch(configToPatch, nativePatch, { invoke })
            : undefined,
          applyGatewayConfigPatch: (gatewayPatch) => gatewayApi.config.patch(gatewayPatch),
        });
        const savedConfig = result.persistedRevision && isRecord(result.config)
          ? { ...result.config, revision: result.persistedRevision }
          : result.config;
        return buildAgentDefaultsSettings(savedConfig);
      },
      async fetchProviderModels(input) {
        await initialize();
        if (input.modelDiscovery.status !== "openai-compatible") {
          return {
            ok: true,
            models: [],
            warning: "This provider uses a static model list.",
            url: null,
            error: null,
          };
        }
        return normalizeProviderModelFetchResult(await gatewayApi.config.providerModels({
          provider: input.providerId,
          profile: input.profileId,
          apiBase: input.apiBase,
          refreshLive: true,
        }));
      },
      async saveProviderSettings(currentConfig, patch) {
        await initialize();
        const result = await saveDesktopSettingsConfig(currentConfig, patch, {
          applyNativeConfigPatch: nativeMode
            ? (configToPatch, nativePatch) => applyNativeConfigPatch(configToPatch, nativePatch, { invoke })
            : undefined,
          applyGatewayConfigPatch: (gatewayPatch) => gatewayApi.config.patch(gatewayPatch),
        });
        const savedConfig = result.persistedRevision && isRecord(result.config)
          ? { ...result.config, revision: result.persistedRevision }
          : result.config;
        return buildProviderModelsSettings(savedConfig);
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

function createOptimisticUserMessage(clientEventId: string, text: string, references: NativeChatReference[] = []): ReactChatMessage {
  return {
    id: clientEventId,
    role: "user",
    createdAtMs: Date.now(),
    text,
    status: "complete",
    ...(references.length ? {
      contextReferences: references.map((reference, index) => ({
        detail: reference.detail,
        id: reference.evidenceId || `reference-${index}`,
        kind: reference.kind,
        sourceLine: reference.sourceLine,
        sourcePath: reference.sourcePath,
        title: reference.title,
      })),
    } : {}),
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

function normalizeWorkspaceDirectoryPage(payload: unknown): WorkspaceDirectoryPage {
  const value = workspaceQueryResult(payload);
  if (!isRecord(value)) throw workspaceQueryError("io_error", "Workspace directory response must be an object.");
  const entries = Array.isArray(value.entries) ? value.entries : [];
  return {
    entries: entries.flatMap((entry): WorkspaceDirectoryPage["entries"] => {
      if (!isRecord(entry)) return [];
      const path = stringValue(entry.path);
      const rawKind = stringValue(entry.kind);
      if (!path || (rawKind !== "dir" && rawKind !== "directory" && rawKind !== "file")) return [];
      const normalizedPath = path.replace(/\\/g, "/");
      const trimmedPath = normalizedPath.replace(/\/$/, "");
      return [{
        kind: rawKind === "file" ? "file" : "directory",
        name: trimmedPath.split("/").filter(Boolean).pop() || trimmedPath,
        path: trimmedPath,
        sizeBytes: numberValue(entry.size_bytes ?? entry.sizeBytes) ?? undefined,
        updatedAt: stringValue(entry.updated_at ?? entry.updatedAt) || undefined,
      }];
    }),
    listingRevision: stringValue(value.listing_revision ?? value.listingRevision),
    nextCursor: stringValue(value.next_cursor ?? value.nextCursor) || undefined,
    path: stringValue(value.path) || ".",
    workspaceKey: stringValue(value.workspace_key ?? value.workspaceKey) || undefined,
  };
}

function normalizeWorkspaceFileChunk(payload: unknown): WorkspaceFileChunk {
  const value = workspaceQueryResult(payload);
  if (!isRecord(value)) throw workspaceQueryError("io_error", "Workspace file response must be an object.");
  const rawContentType = stringValue(value.content_type ?? value.contentType);
  const contentType = rawContentType === "text" || rawContentType === "binary" || rawContentType === "unsupported"
    ? rawContentType
    : "unsupported";
  return {
    content: typeof value.content === "string" ? value.content : undefined,
    contentType,
    lineEnd: numberValue(value.line_end ?? value.lineEnd) ?? undefined,
    lineStart: numberValue(value.line_start ?? value.lineStart) ?? undefined,
    nextCursor: stringValue(value.next_cursor ?? value.nextCursor) || undefined,
    path: stringValue(value.path),
    revision: stringValue(value.revision),
    sizeBytes: numberValue(value.size_bytes ?? value.sizeBytes) ?? 0,
    updatedAt: stringValue(value.updated_at ?? value.updatedAt) || undefined,
  };
}

function workspaceQueryResult(payload: unknown): unknown {
  if (!isRecord(payload)) throw workspaceQueryError("io_error", "Workspace query response must be an object.");
  if (isRecord(payload.error)) {
    const details = isRecord(payload.error.details) ? payload.error.details : {};
    const protocolCode = stringValue(payload.error.code);
    const queryCode = stringValue(details.query_code ?? details.queryCode);
    const code = isWorkspaceQueryErrorCode(queryCode)
      ? queryCode
      : protocolCode === "capability_denied" ? "capability_denied" : "io_error";
    throw workspaceQueryError(
      code,
      stringValue(payload.error.message) || "Workspace query failed.",
      stringValue(details.path) || undefined,
      Boolean(payload.error.retryable),
    );
  }
  if (!("result" in payload)) return payload;
  if (payload.result === undefined || payload.result === null) {
    throw workspaceQueryError("io_error", "Workspace query returned no result.");
  }
  return payload.result;
}

function workspaceQueryError(
  code: WorkspaceQueryErrorCode,
  message: string,
  path?: string,
  retryable = false,
): WorkspaceQueryError {
  return Object.assign(new Error(message), { code, path, retryable });
}

function isWorkspaceQueryErrorCode(value: string): value is WorkspaceQueryErrorCode {
  return [
    "not_configured",
    "capability_denied",
    "root_unavailable",
    "invalid_path",
    "not_found",
    "not_directory",
    "listing_changed",
    "source_changed",
    "io_error",
  ].includes(value);
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

function chatEventFromGatewayEvent(event: NormalizedGatewayEvent, message?: ReactChatMessage): ChatEvent {
  if (event.kind === "agent-ui.event") {
    return {
      type: event.kind,
      ...(event.eventType ? { eventType: event.eventType } : {}),
      ...(message ? { message } : {}),
    };
  }
  if (event.kind !== "agent.event") {
    return {
      type: event.kind,
      ...("commandId" in event && event.commandId ? { commandId: event.commandId } : {}),
      ...(event.kind === "error" && event.message ? { error: event.message } : {}),
      ...(message ? { message } : {}),
    };
  }
  const eventType = stringValue(event.raw.event_type);
  return {
    type: event.kind,
    ...(eventType ? { eventType } : {}),
    ...(message ? { message } : {}),
  };
}

function formMatchesSession(form: AgentUiForm, sessionId: string): boolean {
  const chatId = stringValue(form.chat_id || form.correlation.chat_id);
  const sessionKey = stringValue(form.correlation.session_key ?? form.correlation.sessionKey);
  return sessionKey === sessionId
    || chatId === sessionId
    || (Boolean(chatId) && sessionId.endsWith(`:${chatId}`));
}

function normalizeChatModelOptions(
  pane: ReturnType<typeof buildDesktopSettingsPaneModel>,
): ChatModelOption[] {
  const defaultModel = stringValue(pane.defaultRouting?.model);
  const defaultProviderId = stringValue(pane.defaultRouting?.providerId);
  const defaultProvider = pane.providerCatalog.find((provider) => provider.id === defaultProviderId);
  const providers = defaultProvider
    ? [defaultProvider]
    : pane.providerCatalog.filter((provider) => provider.enabled !== false);
  const options = new Map<string, ChatModelOption>();
  for (const provider of providers) {
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
