import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createDesktopChatSessionController } from "../app-core/chat/desktopChatSessionController";
import type { NativeChatReference, NativeChatSession } from "../app-core/chat/nativeChat";
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
import { ensureGatewayReady } from "../app-core/gateway/desktopGatewayStartup";
import { createDesktopNativeConfigApi } from "../app-core/native/desktopNativeConfig";
import { applyNativeConfigPatch } from "../app-core/native/desktopNativeConfigPatch";
import { createDesktopNativeKnowledgeApi } from "../app-core/native/desktopNativeKnowledge";
import { createDesktopNativeSessionsApi } from "../app-core/native/desktopNativeSessions";
import { createDesktopNativeSkillsApi } from "../app-core/native/desktopNativeSkills";
import { createDesktopNativeThreadsApi } from "../app-core/native/desktopNativeThreads";
import { createDesktopNativeHostCommandApi } from "../app-core/native/desktopNativeHostCommand";
import { toDesktopNativeTauriEventName } from "../app-core/native/desktopNativeTauriEvents";
import { createDesktopNativeWebuiApi } from "../app-core/native/desktopNativeWebui";
import { createDesktopNativeWorkspaceApi } from "../app-core/native/desktopNativeWorkspace";
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
  McpServerSummary,
  SessionSummary,
  SkillSummary,
  ToolCatalogSummary,
  ToolSummary,
  WorkspaceDirectoryPage,
  WorkspaceFileChunk,
  WorkspaceFileSummary,
  WorkspaceQueryError,
  WorkspaceQueryErrorCode,
} from "./services";
import type { ReactChatMessage } from "./chat/messageActions";
import {
  createTinyOsAgentCancelCommand,
  toNativeTinyOsHostCommandFrame,
  type TinyOsCommand,
  type TinyOsHostCommand,
} from "../app-core/chat/tinyOsCommandGateway";
import { normalizeTinyOsEffectiveCapabilities } from "../app-core/chat/tinyOsCapabilities";

type Listener = (event: ChatEvent) => void;

export function createDesktopAppServices(): AppServices {
  const config = resolveGatewayConfig(DEFAULT_GATEWAY_CONFIG);
  const nativeMode = hasTauriRuntime();
  const nativeConfig = nativeMode ? createDesktopNativeConfigApi({ invoke }) : undefined;
  const nativeKnowledge = nativeMode ? createDesktopNativeKnowledgeApi({ invoke }) : undefined;
  const nativeSessions = nativeMode ? createDesktopNativeSessionsApi({ invoke }) : undefined;
  const nativeSkills = nativeMode ? createDesktopNativeSkillsApi({ invoke }) : undefined;
  const nativeThreads = nativeMode ? createDesktopNativeThreadsApi({ invoke }) : undefined;
  const nativeHostCommands = nativeMode ? createDesktopNativeHostCommandApi({ invoke }) : undefined;
  const nativeWebui = nativeMode ? createDesktopNativeWebuiApi({ invoke }) : undefined;
  const nativeWorkspace = nativeMode ? createDesktopNativeWorkspaceApi({ invoke }) : undefined;
  let initialized: Promise<void> | null = null;
  const listeners = new Map<string, Set<Listener>>();
  const notifiedTerminalRuns = new Set<string>();
  const agentUiState = createAgentUiEventState();

  const controller = createDesktopChatSessionController({
    api: {
      listSessions: () => requireNative(nativeThreads, "Thread").list(),
      listAgentRuns: (sessionKey) => requireNative(nativeSessions, "Session").agentRuns?.(sessionKey) ?? Promise.resolve({ runs: [] }),
      getAgentRunRuntimeState: (sessionKey, runId) => requireNative(nativeSessions, "Session").agentRunRuntimeState?.(sessionKey, runId) ?? Promise.resolve(null),
      deleteSession: (threadId) => requireNative(nativeThreads, "Thread").delete({ threadId }),
      patchSession: (threadId, body) => requireNative(nativeThreads, "Thread").updateMetadata({
        threadId,
        metadata: nativeThreadMetadataPatch(body),
      }),
      submitThreadTurn: (input) => requireNative(nativeThreads, "Thread").submitTurn(input),
    },
  });

  async function initialize(): Promise<void> {
    initialized ??= (async () => {
      if (!nativeMode) {
        throw new Error("Tinybot chat requires the Tauri native runtime");
      }
      await ensureGatewayReady(config, { invoke, hasTauriRuntime });
      await registerNativeChatEvents();
      await controller.loadSessions();
    })();
    return initialized;
  }

  async function registerNativeChatEvents(): Promise<void> {
    await Promise.all([
      listen(toDesktopNativeTauriEventName("agent.timeline.patch"), async (event) => {
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
            notifyTerminalTimelineState(sessionId, timeline);
          }
        } catch (error) {
          notifySession(sessionId, {
            type: "timeline.error",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
      listen(toDesktopNativeTauriEventName("agent.awaiting_form"), (event) => {
        reduceNativeAgentFormEvent(normalizeNativeBackendEventPayload(event.payload));
      }),
    ]);
  }

  function notifyTerminalTimelineState(sessionId: string, timeline: Awaited<ReturnType<typeof controller.applyTimelinePatch>>): void {
    const turn = timeline?.turns[timeline.turns.length - 1];
    if (!turn || !["completed", "failed", "interrupted"].includes(turn.status)) return;
    const key = `${sessionId}:${turn.id}:${turn.status}`;
    if (notifiedTerminalRuns.has(key)) return;
    notifiedTerminalRuns.add(key);
    const eventType = turn.status === "completed"
      ? "agent.turn.completed"
      : turn.status === "failed" ? "agent.turn.failed" : "agent.turn.interrupted";
    notifySession(sessionId, { type: "agent.event", eventType });
  }

  function reduceNativeAgentFormEvent(payload: unknown): void {
    if (!isRecord(payload)) return;
    const form = isRecord(payload.form) ? payload.form : payload;
    const traceContext = isRecord(payload.traceContext) ? payload.traceContext : {};
    const formId = stringValue(payload.formId ?? payload.form_id ?? form.formId ?? form.form_id);
    const threadId = stringValue(traceContext.threadId ?? traceContext.thread_id);
    const runId = stringValue(traceContext.runId ?? traceContext.run_id);
    if (!formId || !threadId) return;
    const correlation = isRecord(form.correlation) ? form.correlation : {};
    for (const agentUiEvent of normalizeAgentUiEvents({
      event: "agent_ui_event",
      agent_ui_event: {
        event_type: "ui.form.requested",
        run_id: runId,
        payload: {
          ...form,
          form_id: formId,
          correlation: {
            ...correlation,
            form_id: formId,
            run_id: runId,
            session_key: threadId,
            thread_id: threadId,
          },
        },
      },
    })) {
      reduceAgentUiEventState(agentUiState, agentUiEvent);
    }
    notifySession(threadId, { type: "agent-ui.form" });
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
    return requireNative(nativeConfig, "Config").get();
  }

  async function loadProviderCatalog(): Promise<unknown[]> {
    const payload = await requireNative(nativeWebui, "WebUI").route({ method: "GET", path: "/api/providers" }).catch(() => []);
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
    const threadId = session?.threadId || command.target.threadId || command.target.sessionId;
    if (command.kind === "agent.cancel") {
      await requireNative(nativeThreads, "Thread").interrupt({
        threadId,
        runId: command.target.runId,
        clientEventId: command.commandId,
        reason: "user_requested",
      });
    } else if (command.kind === "approval.resolve") {
      await requireNative(nativeThreads, "Thread").resolveApproval({
        threadId,
        approvalId: command.approval.approvalId,
        approved: command.approval.approved,
        scope: command.approval.scope,
        ...(command.approval.guidance ? { guidance: command.approval.guidance } : {}),
      });
    } else if (command.kind === "form.submit" || command.kind === "form.cancel") {
      await requireNative(nativeThreads, "Thread").submitForm({
        threadId,
        formId: command.form.formId,
        values: command.kind === "form.submit" ? command.form.values : {},
        action: command.kind === "form.submit" ? "submit" : "cancel",
      });
    } else {
      await requireNative(nativeHostCommands, "Host command").dispatch({
        clientId: "desktop-native",
        attachedChatId: command.target.sessionId,
        runId: command.target.runId,
        frame: toNativeTinyOsHostCommandFrame(command.target.sessionId, command as TinyOsHostCommand),
      });
    }
    notifySession(command.target.sessionId, { commandId: command.commandId, type: "command.accepted" });
    notifySession(command.target.sessionId, { commandId: command.commandId, type: "command.canonical-updated" });
  }

  return {
    sessionStore: {
      async list() {
        await initialize();
        return controller.state.sessions.map((session) => mapSession(session, controller.state.respondingSessionKeys.has(session.key)));
      },
      async create(input) {
        await initialize();
        const thread = await requireNative(nativeThreads, "Thread").create({
          title: input?.title || "New session",
          source: "desktop",
        });
        await controller.loadSessions();
        const sessionId = thread.threadId;
        const session = controller.state.sessions.find((candidate) => candidate.key === sessionId);
        if (!session) throw new Error(`Created Thread ${thread.threadId} is missing from the Thread list`);
        await controller.selectSession(session.key, session.chatId);
        const created = mapSession(session, false);
        notifySession(created.id, { type: "session-created" });
        return created;
      },
      async delete(id) {
        await initialize();
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
        const session = controller.state.sessions.find((candidate) => candidate.key === id);
        if (!session) throw new Error(`Cannot archive unknown Thread ${id}`);
        await requireNative(nativeThreads, "Thread").archive({
          threadId: session.threadId || session.key,
          archived: true,
        });
        await controller.loadSessions();
        notifySession(id, { type: "session-archived" });
      },
    },
    chatStore: {
      async load(sessionId) {
        await initialize();
        const session = controller.state.sessions.find((item) => item.key === sessionId);
        if (session && controller.state.activeSessionKey !== session.key) {
          await controller.selectSession(session.key, session.chatId);
        }
        return controller.loadTimeline(sessionId);
      },
      async loadTinyOsCapabilities(sessionId) {
        await initialize();
        return normalizeTinyOsEffectiveCapabilities(
          await requireNative(nativeSessions, "Session").effectiveCapabilities?.(sessionId),
          sessionId,
        );
      },
      async send(sessionId, input) {
        await initialize();
        const session = controller.state.sessions.find((item) => item.key === sessionId);
        if (!session) throw new Error(`Cannot send to unknown Thread ${sessionId}`);
        if (controller.state.activeSessionKey !== session.key) {
          await controller.selectSession(session.key, session.chatId);
        }
        const result = await controller.submitMessage(input.text, input.usePersistentRag ?? true, input.model, input.references);
        const optimisticText = result.status === "sent" ? result.content : "";
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
          const session = controller.state.sessions.find((candidate) => candidate.key === sessionId);
          if (!session) throw new Error(`Cannot resolve approval for unknown Thread ${sessionId}`);
          await requireNative(nativeThreads, "Thread").resolveApproval({
            threadId: session.threadId || session.key,
            approvalId: input.approvalId,
            approved: input.action !== "deny",
            scope: input.action === "approveSession" ? "session" : "once",
            ...(input.guidance ? { guidance: input.guidance } : {}),
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
        await requireNative(nativeThreads, "Thread").submitForm({
          threadId: threadIdForForm(form),
          formId,
          values: request.values,
          action: "submit",
        });
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
        await requireNative(nativeThreads, "Thread").submitForm({
          threadId: threadIdForForm(form),
          formId,
          values: {},
          action: "cancel",
        });
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
        const payload = await requireNative(nativeSessions, "Session").branch?.({ session_key: sessionId, message_id: messageId });
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
        return normalizeWorkspaceFiles(await requireNative(nativeWorkspace, "Workspace").files());
      },
      async listDirectory(request) {
        await initialize();
        return normalizeWorkspaceDirectoryPage(await requireNative(nativeWorkspace, "Workspace").directory(request));
      },
      async readFile(request) {
        await initialize();
        return normalizeWorkspaceFileChunk(await requireNative(nativeWorkspace, "Workspace").fileChunk(request));
      },
    },
    knowledgeStore: {
      async listDocuments() {
        await initialize();
        return normalizeKnowledgeDocuments(await requireNative(nativeKnowledge, "Knowledge").documents());
      },
      async stats() {
        await initialize();
        return normalizeStats(await requireNative(nativeKnowledge, "Knowledge").stats());
      },
    },
    toolsStore: {
      async loadCatalog() {
        await initialize();
        return normalizeToolCatalog(await requireNative(nativeWebui, "WebUI").route({ method: "GET", path: "/api/tools" }));
      },
      async listSkills() {
        await initialize();
        return normalizeSkills(await requireNative(nativeSkills, "Skills").list());
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
      async loadDesktopConfigSettings() {
        await initialize();
        const currentConfig = await loadSettingsSnapshot();
        const providerCatalog = buildDesktopProviderCatalogItems(await loadProviderCatalog());
        const formState = buildDesktopSettingsFormState(currentConfig, providerCatalog);
        return {
          currentConfig,
          formState,
          pane: buildDesktopSettingsPaneModel(formState, { providerCatalog }),
        };
      },
      async saveDesktopConfigSettings(currentConfig, patch) {
        await initialize();
        const result = await saveDesktopSettingsConfig(currentConfig, patch, {
          applyNativeConfigPatch: nativeMode
            ? (configToPatch, nativePatch) => applyNativeConfigPatch(configToPatch, nativePatch, { invoke })
            : undefined,
        });
        const savedConfig = result.persistedRevision && isRecord(result.config)
          ? { ...result.config, revision: result.persistedRevision }
          : result.config;
        const providerCatalog = buildDesktopProviderCatalogItems(await loadProviderCatalog());
        const formState = buildDesktopSettingsFormState(savedConfig, providerCatalog);
        const saveDetails = {
          transport: result.transport,
          persistedRevision: result.persistedRevision,
          updatedFields: result.updatedFields,
          applied: result.applied,
          restartRequired: result.restartRequired,
          reloadRequired: result.reloadRequired,
          warnings: result.warnings,
        };
        return {
          currentConfig: savedConfig,
          formState,
          pane: buildDesktopSettingsPaneModel(formState, {
            providerCatalog,
            saveStatus: "saved",
            saveDetails,
          }),
          saveDetails,
        };
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
        return normalizeProviderModelFetchResult(await requireNative(nativeWebui, "WebUI").route({
          method: "POST",
          path: "/api/provider-models",
          body: {
            provider: input.providerId,
            profile: input.profileId,
            apiBase: input.apiBase,
            refreshLive: true,
          },
        }));
      },
      async saveProviderSettings(currentConfig, patch) {
        await initialize();
        const result = await saveDesktopSettingsConfig(currentConfig, patch, {
          applyNativeConfigPatch: nativeMode
            ? (configToPatch, nativePatch) => applyNativeConfigPatch(configToPatch, nativePatch, { invoke })
            : undefined,
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
  const threadStatus = session.status;
  return {
    id: session.key,
    chatId: session.chatId,
    title: session.title || "New session",
    updatedAtMs: timestampMs(session.updatedAt) ?? timestampFromPayload(fallbackPayload) ?? Date.now(),
    ...(session.pinned ? { pinned: true } : {}),
    ...(session.archived ? { archived: true } : {}),
    status: responding || threadStatus === "running" || threadStatus === "cancelling"
      ? "running"
      : threadStatus === "waiting_for_approval"
        ? "waiting_approval"
        : threadStatus === "failed" ? "failed" : "idle",
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
      source: stringValue(item.source) || undefined,
      enabled: typeof item.enabled === "boolean" ? item.enabled : undefined,
      available: typeof item.available === "boolean" ? item.available : undefined,
      always: item.always === true,
      effective: typeof item.effective === "boolean" ? item.effective : undefined,
      reason: stringValue(item.reason) || undefined,
    };
  });
}

function normalizeToolCatalog(payload: unknown): ToolCatalogSummary {
  return {
    tools: payloadItems(payload, ["tools", "items"]).map(normalizeToolSummary),
    mcpServers: payloadItems(payload, ["mcpServers", "servers"]).map(normalizeMcpServerSummary),
  };
}

function normalizeToolSummary(item: Record<string, unknown>): ToolSummary {
  const approval = isRecord(item.approval) ? item.approval : {};
  const name = stringValue(item.name ?? item.id);
  return {
    id: stringValue(item.id) || name,
    name,
    displayName: stringValue(item.displayName ?? item.title) || name,
    description: stringValue(item.description),
    source: stringValue(item.source) || "builtin",
    serverId: stringValue(item.serverId) || undefined,
    enabled: item.enabled !== false,
    available: item.available !== false,
    reason: stringValue(item.reason) || undefined,
    approvalRequired: approval.required === true,
  };
}

function normalizeMcpServerSummary(item: Record<string, unknown>): McpServerSummary {
  const status = isRecord(item.status) ? item.status : {};
  return {
    id: stringValue(item.id),
    enabled: item.enabled !== false,
    transport: stringValue(item.transport) || "stdio",
    state: stringValue(status.state) || (item.enabled === false ? "disabled" : "unknown"),
    toolCount: numberValue(item.toolCount ?? status.toolCount) ?? 0,
    error: stringValue(item.error ?? status.lastError) || undefined,
  };
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

function formMatchesSession(form: AgentUiForm, sessionId: string): boolean {
  const chatId = stringValue(form.chat_id || form.correlation.chat_id);
  const sessionKey = stringValue(form.correlation.session_key ?? form.correlation.sessionKey);
  return sessionKey === sessionId
    || chatId === sessionId
    || (Boolean(chatId) && sessionId.endsWith(`:${chatId}`));
}

function threadIdForForm(form: AgentUiForm): string {
  const threadId = stringValue(
    form.correlation.thread_id
    ?? form.correlation.threadId
    ?? form.correlation.session_key
    ?? form.correlation.sessionKey,
  );
  if (!threadId) throw new Error(`Agent UI form ${form.form_id} is missing thread correlation`);
  return threadId;
}

function nativeThreadMetadataPatch(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) return {};
  const metadata = isRecord(body.metadata) ? body.metadata : {};
  return {
    ...(typeof body.title === "string" ? { title: body.title } : {}),
    ...(Object.keys(metadata).length ? { extra: metadata } : {}),
  };
}

function requireNative<T>(value: T | undefined, capability: string): T {
  if (!value) throw new Error(`${capability} Native API is unavailable outside the Tauri runtime`);
  return value;
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
