import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createDesktopChatSessionController } from "../app-core/chat/desktopChatSessionController";
import type { NativeChatReference, NativeChatSession } from "../app-core/chat/nativeChat";
import {
  createAgentUiEventState,
  normalizeAgentUiEvents,
  reduceAgentUiEventState,
  type AgentUiForm,
} from "../app-core/agent-ui/agentUiEvents";
import type { DesktopCommand, DesktopTurnSubmitCommand } from "../app-core/chat/desktopCommand";
import { DEFAULT_GATEWAY_CONFIG, resolveGatewayConfig } from "../app-core/gateway/gatewayConfig";
import { ensureGatewayReady } from "../app-core/gateway/desktopGatewayStartup";
import { createDesktopNativeConfigApi } from "../app-core/native/desktopNativeConfig";
import { applyNativeConfigPatch } from "../app-core/native/desktopNativeConfigPatch";
import { createDesktopNativeSessionsApi } from "../app-core/native/desktopNativeSessions";
import { createDesktopNativeSkillsApi } from "../app-core/native/desktopNativeSkills";
import {
  createDesktopNativeThreadsApi,
  type NativeThreadListResult,
  type NativeThreadRecord,
} from "../app-core/native/desktopNativeThreads";
import { createDesktopNativeHostCommandApi } from "../app-core/native/desktopNativeHostCommand";
import { createDesktopNativeBrowserApi, normalizeNativeBrowserSnapshot } from "../app-core/native/desktopNativeBrowser";
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
  const nativeSessions = nativeMode ? createDesktopNativeSessionsApi({ invoke }) : undefined;
  const nativeSkills = nativeMode ? createDesktopNativeSkillsApi({ invoke }) : undefined;
  const nativeThreads = nativeMode ? createDesktopNativeThreadsApi({ invoke }) : undefined;
  const nativeHostCommands = nativeMode ? createDesktopNativeHostCommandApi({ invoke }) : undefined;
  const nativeBrowser = nativeMode ? createDesktopNativeBrowserApi({ invoke }) : undefined;
  const nativeWebui = nativeMode ? createDesktopNativeWebuiApi({ invoke }) : undefined;
  const nativeWorkspace = nativeMode ? createDesktopNativeWorkspaceApi({ invoke }) : undefined;
  let initialized: Promise<void> | null = null;
  const listeners = new Map<string, Set<Listener>>();
  const notifiedTerminalRuns = new Set<string>();
  const agentUiState = createAgentUiEventState();

  const controller = createDesktopChatSessionController({
    api: {
      listSessions: listConversationThreads,
      listAgentRuns: (sessionKey) => requireNative(nativeSessions, "Session").agentRuns?.(sessionKey) ?? Promise.resolve({ runs: [] }),
      getAgentRunRuntimeState: (sessionKey, runId) => requireNative(nativeSessions, "Session").agentRunRuntimeState?.(sessionKey, runId) ?? Promise.resolve(null),
      deleteSession: (threadId) => requireNative(nativeThreads, "Thread").delete({
        threadId,
        deleteChildren: true,
      }),
      patchSession: (threadId, body) => requireNative(nativeThreads, "Thread").updateMetadata({
        threadId,
        metadata: nativeThreadMetadataPatch(body),
      }),
      submitThreadTurn: (input) => requireNative(nativeThreads, "Thread").submitTurn(input),
    },
  });

  async function listConversationThreads() {
    const threads: NativeThreadRecord[] = [];
    let offset: number | undefined;
    let result: NativeThreadListResult;
    while (true) {
      result = await requireNative(nativeThreads, "Thread").list({
        includeChildThreads: true,
        ...(offset === undefined ? {} : { offset }),
      });
      threads.push(...result.threads.filter((thread) => {
        const parentThreadId = stringValue(thread.parentThreadId ?? thread.parent_thread_id);
        return !parentThreadId || stringValue(thread.source) === "fork";
      }));
      const nextOffset = numberValue(result.nextOffset);
      if (nextOffset === undefined) {
        break;
      }
      if (nextOffset <= (offset ?? -1)) {
        throw new Error("Thread pagination returned a non-advancing next offset");
      }
      offset = nextOffset;
    }
    return {
      ...result,
      threads,
      total: threads.length,
      nextOffset: undefined,
    };
  }

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
      listen("tinyos:browser-snapshot", (event) => {
        try {
          const browserSnapshot = normalizeNativeBrowserSnapshot(event.payload);
          notifySession(browserSnapshot.data.sessionId, { browserSnapshot, type: "browser.snapshot" });
        } catch (error) {
          notifyAll({
            error: error instanceof Error ? error.message : String(error),
            type: "browser.snapshot.error",
          });
        }
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
    let canonicalTimeline: Awaited<ReturnType<typeof controller.reloadTimeline>> | null = null;
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
        commandId: command.commandId,
        scope: command.approval.scope,
        ...(command.approval.guidance ? { guidance: command.approval.guidance } : {}),
      });
      canonicalTimeline = await controller.reloadTimeline(command.target.sessionId);
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
    if (canonicalTimeline) {
      notifySession(command.target.sessionId, { type: "timeline.patch", timeline: canonicalTimeline });
      notifyTerminalTimelineState(command.target.sessionId, canonicalTimeline);
    }
    notifySession(command.target.sessionId, { commandId: command.commandId, type: "command.canonical-updated" });
  }

  async function dispatchTurnSubmit(command: DesktopTurnSubmitCommand): Promise<void> {
    await initialize();
    const sessionId = command.target.sessionId;
    const session = controller.state.sessions.find((item) => item.key === sessionId);
    if (!session) throw new Error(`Cannot send to unknown Thread ${sessionId}`);
    if (controller.state.activeSessionKey !== session.key) {
      await controller.selectSession(session.key, session.chatId);
    }
    const input = command.input;
    const result = await controller.submitMessage(input.text, {
      ...(input.model ? { model: input.model } : {}),
      ...(input.references?.length ? { references: input.references } : {}),
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      clientEventId: command.commandId,
    });
    const optimisticText = result.status === "sent" ? result.content : "";
    const optimisticMessage = result.status === "empty"
      ? undefined
      : createOptimisticUserMessage(result.clientEventId, optimisticText, input.references);
    notifySession(sessionId, {
      type: "message-sent",
      ...(optimisticMessage ? { message: optimisticMessage } : {}),
    });
    if (result.status === "sent") {
      void result.completion
        .then((timeline) => {
          notifySession(sessionId, { type: "timeline.patch", timeline });
          notifyTerminalTimelineState(sessionId, timeline);
        })
        .catch((error) => {
          notifySession(sessionId, {
            type: "timeline.error",
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
  }

  async function dispatchDesktopCommand(command: DesktopCommand): Promise<void> {
    if (command.kind === "turn.submit") {
      await dispatchTurnSubmit(command);
      return;
    }
    if (command.kind === "agent.stop") {
      await initialize();
      const sessionId = command.target.sessionId;
      const timeline = await controller.loadTimeline(sessionId);
      const turn = [...timeline.turns].reverse().find((candidate) => (
        candidate.status === "pending"
        || candidate.status === "running"
        || candidate.status === "awaiting_approval"
        || candidate.status === "awaiting_user"
      ));
      if (!turn) throw new Error("Cannot cancel: the session has no active run");
      const cancelCommand = createTinyOsAgentCancelCommand({
        commandId: command.commandId,
        issuedAt: command.issuedAt,
        runId: turn.id,
        sessionId,
        source: command.source,
        threadId: turn.canonicalItems?.find((item) => item.threadId)?.threadId,
        turnId: turn.id,
      });
      notifySession(sessionId, { command: cancelCommand, type: "command.dispatched" });
      await dispatchTinyOsCommand(cancelCommand);
      return;
    }
    await dispatchTinyOsCommand(command);
  }

  async function resolveForkSequence(threadId: string, itemIds: Set<string>): Promise<number | undefined> {
    let cursor = "";
    const seenCursors = new Set<string>();
    while (true) {
      const payload = await requireNative(nativeThreads, "Thread").read({
        threadId,
        limit: 500,
        ...(cursor ? { cursor } : {}),
      });
      if (!isRecord(payload)) {
        throw new Error(`Thread ${threadId} returned an invalid read result while resolving a fork boundary`);
      }
      const items = Array.isArray(payload.items) ? payload.items : [];
      for (const value of items) {
        if (!isRecord(value)) continue;
        const kind = isRecord(value.kind) ? value.kind : {};
        const itemPayload = isRecord(kind.payload) ? kind.payload : {};
        const itemId = stringValue(value.itemId ?? value.item_id);
        const messageId = stringValue(itemPayload.messageId ?? itemPayload.message_id);
        if (!itemIds.has(itemId) && !itemIds.has(messageId)) continue;
        const sequence = numberValue(value.sequence);
        if (sequence === undefined) {
          throw new Error(`Thread item ${itemId || messageId} is missing its canonical sequence`);
        }
        return sequence;
      }
      const nextCursor = stringValue(
        payload.nextCursor
        ?? payload.next_cursor
        ?? (isRecord(payload.pagination)
          ? payload.pagination.nextCursor ?? payload.pagination.next_cursor
          : undefined),
      );
      if (!nextCursor) return undefined;
      if (seenCursors.has(nextCursor)) {
        throw new Error(`Thread ${threadId} returned a repeated pagination cursor while resolving a fork boundary`);
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
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
      browserRuntime: nativeBrowser,
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
      async dispatch(command) {
        await dispatchDesktopCommand(command);
      },
      async listAgentUiForms(sessionId) {
        await initialize();
        return Array.from(agentUiState.forms.values()).filter((form) => formMatchesSession(form, sessionId));
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
        const sourceSession = controller.state.sessions.find((session) => session.key === sessionId);
        if (!sourceSession) {
          throw new Error(`Cannot branch from unknown Thread ${sessionId}`);
        }
        const timeline = await controller.loadTimeline(sessionId);
        const canonicalItem = timeline.turns
          .flatMap((turn) => turn.canonicalItems ?? [])
          .find((item) => (
            item.itemId === messageId
            || stringValue(item.data.messageId ?? item.data.message_id) === messageId
          ));
        if (!canonicalItem) {
          throw new Error(`Cannot fork Thread ${sessionId} at unknown canonical message ${messageId}`);
        }
        const sourceThreadId = sourceSession.threadId || sourceSession.key;
        const forkAfterSequence = await resolveForkSequence(sourceThreadId, new Set([
          messageId,
          canonicalItem.itemId,
          stringValue(canonicalItem.data.messageId ?? canonicalItem.data.message_id),
        ].filter(Boolean)));
        if (forkAfterSequence === undefined) {
          throw new Error(`Cannot resolve persisted fork boundary for canonical message ${messageId}`);
        }
        const title = `${sourceSession.title} · 分叉`;
        const payload = await requireNative(nativeThreads, "Thread").fork({
          threadId: sourceThreadId,
          clientEventId: `fork:${sourceThreadId}:${messageId}`,
          title,
          forkAfterSequence,
        });
        await controller.loadSessions();
        const payloadRecord = isRecord(payload) ? payload : {};
        const branchKey = stringValue(
          payloadRecord.sessionKey
          ?? payloadRecord.session_key
          ?? payloadRecord.threadId
          ?? payloadRecord.thread_id,
        );
        const branchSession = controller.state.sessions.find((session) => (
          session.key === branchKey || session.threadId === branchKey
        ));
        if (!branchKey || !branchSession) {
          throw new Error(`Forked Thread ${branchKey || "<missing>"} is missing from the Thread list`);
        }
        return mapSession(branchSession, false, payload);
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
