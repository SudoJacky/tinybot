import { createDesktopChatCommands } from "./chat/desktopChatCommands";
import { invoke } from "@tauri-apps/api/core";
import { rendererPerformanceSnapshot } from "../app-core/native/rendererPerformance";
import { listen } from "@tauri-apps/api/event";
import { createDesktopChatSessionController } from "../app-core/chat/desktopChatSessionController";
import { createDesktopNativeConfigApi } from "../app-core/native/desktopNativeConfig";
import { createDesktopNativeAgentGraphsApi } from "../app-core/native/desktopNativeAgentGraphs";
import { createDesktopNativeAgentGraphRuntime } from "../app-core/native/desktopNativeAgentGraphRuntime";
import { applyNativeConfigPatch } from "../app-core/native/desktopNativeConfigPatch";
import { createDesktopNativePluginsApi } from "../app-core/native/desktopNativePlugins";
import {
  createDesktopNativeThreadsApi,
  type NativeThreadListResult,
  type NativeThreadRecord,
} from "../app-core/native/desktopNativeThreads";
import { createDesktopNativeMemoryApi } from "../app-core/native/desktopNativeMemory";
import { createDesktopNativeTokenUsageApi } from "../app-core/native/desktopNativeTokenUsage";
import { createDesktopNativeHooksApi } from "../app-core/native/desktopNativeHooks";
import { createDesktopNativeProjectGroupsApi } from "../app-core/native/desktopNativeProjectGroups";
import { createDesktopNativeWorkspaceRegistryApi } from "../app-core/native/desktopNativeWorkspaceRegistry";
import { createDesktopNativeBrowserApi } from "../app-core/native/desktopNativeBrowser";
import { createDesktopNativeTerminalApi } from "../app-core/native/desktopNativeTerminal";
import { createDesktopNativeWebuiApi } from "../app-core/native/desktopNativeWebui";
import { createDesktopNativeWorkspaceApi } from "../app-core/native/desktopNativeWorkspace";
import {
  createDesktopNativePerformanceTraceApi,
  mergeRendererStartupTrace,
} from "../app-core/native/desktopNativePerformanceTrace";
import type { DesktopNativeStartupTrace } from "../app-core/native/desktopNativeChatDebug";
import { createDesktopNativePetHost } from "../app-core/native/desktopNativePet";
import { createDesktopNativePetQuickChatHost } from "../app-core/native/desktopNativePetQuickChat";
import {
  isRendererDiagnosticModeEnabled,
  rendererLogSnapshot,
} from "../app-core/native/rendererLogger";
import type {
  AppServices,
  ChatEvent,
  PluginMigrationSession,
  SessionSummary,
} from "./services";
import { createDesktopNativeEventBridge } from "./adapters/desktopNativeEventBridge";
import { createDesktopSettingsStore } from "./adapters/desktopSettingsStore";
import { createDesktopToolsStore } from "./adapters/desktopToolsStore";
import { createDesktopWorkspaceStore } from "./adapters/desktopWorkspaceStore";
import {
  readDefaultChatModelPreference,
} from "../app-core/chat/chatModelPreference";
import { normalizeThreadEffectiveCapabilities } from "../app-core/chat/threadCapabilities";

type Listener = (event: ChatEvent) => void;

export function createDesktopAppServices(
  { startupTrace }: { startupTrace?: DesktopNativeStartupTrace } = {},
): AppServices {
  startupTrace?.mark("services.created");
  const nativeMode = hasTauriRuntime();
  const desktopPetHost = createDesktopNativePetHost();
  const desktopPetQuickChatHost = createDesktopNativePetQuickChatHost();
  const nativeConfig = nativeMode ? createDesktopNativeConfigApi({ invoke }) : undefined;
  const nativeAgentGraphs = nativeMode ? createDesktopNativeAgentGraphsApi({ invoke }) : undefined;
  const nativeAgentGraphRuntime = nativeMode ? createDesktopNativeAgentGraphRuntime({ invoke }) : undefined;
  const nativePlugins = nativeMode ? createDesktopNativePluginsApi({ invoke }) : undefined;
  const nativeThreads = nativeMode ? createDesktopNativeThreadsApi({ invoke }) : undefined;
  const nativeMemory = nativeMode ? createDesktopNativeMemoryApi({ invoke }) : undefined;
  const nativeTokenUsage = nativeMode ? createDesktopNativeTokenUsageApi({ invoke }) : undefined;
  const nativeHooks = nativeMode ? createDesktopNativeHooksApi({ invoke }) : undefined;
  const nativeProjectGroups = nativeMode ? createDesktopNativeProjectGroupsApi({ invoke }) : undefined;
  const nativeWorkspaceRegistry = nativeMode ? createDesktopNativeWorkspaceRegistryApi({ invoke }) : undefined;
  const nativeBrowser = nativeMode ? createDesktopNativeBrowserApi({ invoke }) : undefined;
  const nativeTerminal = nativeMode ? createDesktopNativeTerminalApi({ invoke }) : undefined;
  const nativeWebui = nativeMode ? createDesktopNativeWebuiApi({ invoke }) : undefined;
  const nativeWorkspace = nativeMode ? createDesktopNativeWorkspaceApi({ invoke }) : undefined;
  const nativePerformanceTrace = nativeMode ? createDesktopNativePerformanceTraceApi({ invoke }) : undefined;
  let initialized: Promise<void> | null = null;
  let conversationThreadPageCount = 0;
  const listeners = new Map<string, Set<Listener>>();

  const controller = createDesktopChatSessionController({
    api: {
      listThreads: listConversationThreads,
      listTurns: (threadId) => requireNative(nativeThreads, "Thread").listTurns(threadId),
      getAgentTurnRuntimeState: (threadId, turnId) => requireNative(nativeThreads, "Thread").getTurnRuntimeState(threadId, turnId),
      deleteThread: (threadId) => requireNative(nativeThreads, "Thread").delete({
        threadId,
        deleteChildren: true,
      }),
      patchThread: (threadId, body) => requireNative(nativeThreads, "Thread").updateMetadata({
        threadId,
        metadata: nativeThreadMetadataPatch(body),
      }),
      submitThreadTurn: (input) => requireNative(nativeThreads, "Thread").submitTurn(input),
    },
  });
  const nativeEvents = createDesktopNativeEventBridge({
    controller,
    listen: (eventName, handler) => listen(eventName, (event) => handler(event)),
    notifyAll,
    notifySession,
  });

  async function listConversationThreads() {
    const threads: NativeThreadRecord[] = [];
    let pageCount = 0;
    let offset: number | undefined;
    let result: NativeThreadListResult;
    while (true) {
      result = await requireNative(nativeThreads, "Thread").list({
        includeChildThreads: true,
        ...(offset === undefined ? {} : { offset }),
      });
      pageCount += 1;
      threads.push(...result.threads.filter((thread) => {
        const parentThreadId = stringValue(thread.parentThreadId ?? thread.parent_thread_id);
        const source = stringValue(thread.source);
        return source !== "agent_graph"
          && (!parentThreadId || source === "fork" || source === "workspace_thread");
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
    conversationThreadPageCount = pageCount;
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
      startupTrace?.start("events.register");
      try {
        await nativeEvents.register();
        startupTrace?.complete("events.register");
      } catch (error) {
        startupTrace?.fail("events.register", error);
        throw error;
      }
      startupTrace?.start("sessions.load");
      try {
        await controller.loadSessions();
        startupTrace?.complete("sessions.load", {
          pageCount: conversationThreadPageCount,
          sessionCount: controller.state.threads.length,
        });
      } catch (error) {
        startupTrace?.fail("sessions.load", error);
        throw error;
      }
      startupTrace?.mark("services.ready");
    })();
    return initialized;
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

  const chatCommands = createDesktopChatCommands({
    initialize, controller, notifySession, mapSession,
    nativeThreads: () => requireNative(nativeThreads, "Thread"),
    notifyTerminalTimelineState: nativeEvents.notifyTerminalTimelineState,
  });

  return {
    desktopPetHost,
    desktopPetQuickChatHost,
    agentGraphRuntime: {
      async list(input) {
        await initialize();
        return requireNative(nativeAgentGraphRuntime, "Agent Graph Runtime").list(input);
      },
      async start(input) {
        await initialize();
        return requireNative(nativeAgentGraphRuntime, "Agent Graph Runtime").start(input);
      },
    },
    agentGraphStore: {
      async list(workspacePath) {
        await initialize();
        return requireNative(nativeAgentGraphs, "Agent Graph").list(workspacePath);
      },
      async save(input) {
        await initialize();
        return requireNative(nativeAgentGraphs, "Agent Graph").save(input);
      },
      async delete(input) {
        await initialize();
        await requireNative(nativeAgentGraphs, "Agent Graph").delete(input);
      },
    },
    sessionStore: {
      async list() {
        await initialize();
        return controller.state.threads.map((thread) => mapSession(
          thread,
          controller.state.respondingThreadIds.has(thread.threadId),
        ));
      },
      async refresh() {
        await initialize();
        await controller.loadSessions();
        return controller.state.threads.map((thread) => mapSession(
          thread,
          controller.state.respondingThreadIds.has(thread.threadId),
        ));
      },
      async create(input) {
        await initialize();
        const preference = readDefaultChatModelPreference();
        const model = stringValue(input?.model) || preference?.modelId || "";
        const modelProvider = stringValue(input?.modelProvider)
          || (model === preference?.modelId ? preference.providerId ?? "" : "");
        const extra = {
          ...(modelProvider ? { modelProvider } : {}),
          ...(input?.projectGroupId ? { projectGroupId: input.projectGroupId } : {}),
          ...(input?.entryPoint ? { entryPoint: input.entryPoint } : {}),
          ...(input?.pluginMigration ? { pluginMigration: input.pluginMigration } : {}),
        };
        const metadata = {
          ...(input?.workingDirectory ? { workingDirectory: input.workingDirectory } : {}),
          ...(model ? { model } : {}),
          ...(Object.keys(extra).length ? { extra } : {}),
        };
        const thread = await requireNative(nativeThreads, "Thread").create({
          title: input?.title || "New session",
          source: input?.projectCoordinator ? "project_coordinator" : "desktop",
          ...(Object.keys(metadata).length ? { metadata } : {}),
        });
        await controller.loadSessions();
        const sessionId = thread.threadId;
        const createdThread = controller.state.threads.find((candidate) => candidate.threadId === sessionId);
        if (!createdThread) throw new Error(`Created Thread ${thread.threadId} is missing from the Thread list`);
        await controller.selectSession(createdThread.threadId);
        const created = mapSession(createdThread, false);
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
      async setModel(id, model, provider) {
        await initialize();
        const thread = controller.state.threads.find((candidate) => candidate.threadId === id);
        if (!thread) throw new Error(`Cannot set the model for unknown Thread ${id}`);
        const extra = isRecord(thread.metadata?.extra) ? thread.metadata.extra : {};
        const patched = await controller.patchSession(id, {
          model,
          metadata: withModelProvider(extra, provider),
        });
        if (!patched) throw new Error(`Cannot set the model for unknown Thread ${id}`);
        notifySession(id, { type: "session-model-changed" });
      },
      async markPluginMigrationInstalled(id, pluginName, enabled, cleanupWarning) {
        await initialize();
        const thread = controller.state.threads.find((candidate) => candidate.threadId === id);
        if (!thread) throw new Error(`Cannot update migration state for unknown Thread ${id}`);
        const extra = isRecord(thread.metadata?.extra) ? thread.metadata.extra : {};
        const current = normalizePluginMigrationSession(extra.pluginMigration);
        if (!current) throw new Error(`Thread ${id} is not associated with a plugin migration`);
        const patched = await controller.patchSession(id, {
          metadata: {
            ...extra,
            pluginMigration: {
              ...current,
              status: "installed",
              installedPluginName: pluginName,
              installedPluginEnabled: enabled,
              ...(cleanupWarning ? { cleanupWarning } : {}),
            },
          },
        });
        if (!patched) throw new Error(`Cannot update migration state for unknown Thread ${id}`);
        notifySession(id, { type: "plugin-migration-installed" });
      },
      async pin(id, pinned) {
        await initialize();
        await controller.patchSession(id, { metadata: { pinned } });
        notifySession(id, { type: "session-pinned" });
      },
      async archive(id) {
        await initialize();
        const thread = controller.state.threads.find((candidate) => candidate.threadId === id);
        if (!thread) throw new Error(`Cannot archive unknown Thread ${id}`);
        await requireNative(nativeThreads, "Thread").archive({
          threadId: thread.threadId,
          archived: true,
        });
        await controller.loadSessions();
        notifySession(id, { type: "session-archived" });
      },
    },
    chatStore: {
      browserRuntime: nativeBrowser,
      terminalRuntime: nativeTerminal,
      async load(sessionId) {
        await initialize();
        const thread = controller.state.threads.find((item) => item.threadId === sessionId);
        if (thread && controller.state.activeThreadId !== thread.threadId) {
          await controller.selectSession(thread.threadId);
          return controller.loadTimeline(sessionId);
        }
        return controller.reloadTimeline(sessionId);
      },
      async loadEffectiveCapabilities(threadId) {
        await initialize();
        return normalizeThreadEffectiveCapabilities(
          await requireNative(nativeThreads, "Thread").getEffectiveCapabilities(threadId),
          threadId,
        );
      },
      async dispatch(command) {
        await chatCommands.dispatch(command);
      },
      async listAgentUiForms(sessionId) {
        await initialize();
        return nativeEvents.listAgentUiForms(sessionId);
      },
      async loadDelegateTrace(selection) {
        await initialize();
        return controller.loadDelegateTrace(selection);
      },
      async loadArtifact(selection) {
        await initialize();
        return controller.loadArtifact(selection);
      },
      branchFromMessage: chatCommands.branchFromMessage,
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
    workspaceStore: createDesktopWorkspaceStore({ initialize, nativeWorkspace }),
    memoryStore: {
      async load() {
        await initialize();
        return requireNative(nativeMemory, "Memory").snapshot();
      },
      async mutate(request) {
        await initialize();
        return requireNative(nativeMemory, "Memory").mutate(request);
      },
    },
    projectGroupStore: {
      async list() {
        await initialize();
        return (await requireNative(nativeProjectGroups, "Project group").list()).groups;
      },
      async save(input) {
        await initialize();
        return requireNative(nativeProjectGroups, "Project group").save(input);
      },
      async delete(projectGroupId) {
        await initialize();
        await requireNative(nativeProjectGroups, "Project group").delete(projectGroupId);
      },
    },
    workspaceRegistryStore: {
      async list() {
        return (await requireNative(nativeWorkspaceRegistry, "Workspace registry").list()).workspaces;
      },
      async register(path) {
        return requireNative(nativeWorkspaceRegistry, "Workspace registry").register(path);
      },
      async rename(path, name) {
        return requireNative(nativeWorkspaceRegistry, "Workspace registry").rename(path, name);
      },
      async forget(path) {
        await requireNative(nativeWorkspaceRegistry, "Workspace registry").forget(path);
      },
    },
    toolsStore: createDesktopToolsStore({ initialize, nativePlugins, nativeWebui }),
    hooksStore: nativeHooks ? {
      async load(workspacePath) {
        await initialize();
        return nativeHooks.snapshot(workspacePath);
      },
      async setTrusted(input) {
        await initialize();
        return nativeHooks.setTrusted(input);
      },
      async saveManaged(input) {
        await initialize();
        return nativeHooks.saveManaged(input);
      },
      async testManaged(input) {
        await initialize();
        return nativeHooks.testManaged(input);
      },
      async archiveManaged(input) {
        await initialize();
        return nativeHooks.archiveManaged(input);
      },
      async readManagedScript(input) {
        await initialize();
        return nativeHooks.readManagedScript(input);
      },
      async saveManagedScript(input) {
        await initialize();
        return nativeHooks.saveManagedScript(input);
      },
    } : undefined,
    settingsStore: createDesktopSettingsStore({
      initialize,
      nativeConfig,
      nativeTokenUsage,
      nativeWebui,
      nativeWorkspace,
      applyNativeConfigPatch: nativeMode
        ? (configToPatch, nativePatch) => applyNativeConfigPatch(configToPatch, nativePatch, { invoke })
        : undefined,
    }),
    performanceStore: {
      async load() {
        const snapshot = await requireNative(nativePerformanceTrace, "Performance trace").snapshot();
        return { ...mergeRendererStartupTrace(snapshot, rendererLogSnapshot()), rendererPerformance: rendererPerformanceSnapshot() };
      },
      async sampleMemory() {
        return requireNative(nativePerformanceTrace, "Performance trace").memorySnapshot();
      },
      async exportSnapshot(snapshot) {
        return requireNative(nativePerformanceTrace, "Performance trace").exportSnapshot(snapshot);
      },
      async exportDiagnosticBundle(memorySamples) {
        return requireNative(nativePerformanceTrace, "Performance trace").exportDiagnosticBundle({
          diagnosticModeEnabled: isRendererDiagnosticModeEnabled(),
          locale: navigator.language || undefined,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || undefined,
          rendererLogs: rendererLogSnapshot(),
          rendererPerformance: rendererPerformanceSnapshot(),
          memorySamples,
        });
      },
    },
  };
}

function mapSession(thread: NativeThreadRecord, responding: boolean, fallbackPayload?: unknown): SessionSummary {
  const extra = isRecord(thread.metadata?.extra) ? thread.metadata.extra : {};
  const pluginMigration = normalizePluginMigrationSession(extra.pluginMigration);
  return {
    id: thread.threadId,
    chatId: thread.threadId,
    title: thread.title || "New session",
    updatedAtMs: timestampMs(thread.updatedAt) ?? timestampFromPayload(fallbackPayload) ?? Date.now(),
    ...(extra.pinned === true ? { pinned: true } : {}),
    ...(thread.archivedAt || thread.status === "archived" ? { archived: true } : {}),
    ...(thread.metadata?.workingDirectory ? { workingDirectory: thread.metadata.workingDirectory } : {}),
    ...(stringValue(thread.metadata?.model) ? { model: stringValue(thread.metadata?.model) } : {}),
    ...(stringValue(extra.modelProvider) ? { modelProvider: stringValue(extra.modelProvider) } : {}),
    ...(stringValue(extra.projectGroupId) ? { projectGroupId: stringValue(extra.projectGroupId) } : {}),
    ...(stringValue(thread.source) === "project_coordinator" ? { projectCoordinator: true } : {}),
    ...(pluginMigration ? { pluginMigration } : {}),
    status: responding || thread.status === "running" || thread.status === "cancelling"
      ? "running"
      : thread.status === "failed" ? "failed" : "idle",
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

function nativeThreadMetadataPatch(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) return {};
  const metadata = isRecord(body.metadata) ? body.metadata : {};
  const model = stringValue(body.model ?? metadata.model);
  const workingDirectory = stringValue(body.workingDirectory ?? metadata.workingDirectory);
  const extra = Object.fromEntries(Object.entries(metadata).filter(([key]) => (
    key !== "model" && key !== "workingDirectory"
  )));
  return {
    ...(typeof body.title === "string" ? { title: body.title } : {}),
    ...(model ? { model } : {}),
    ...(workingDirectory ? { workingDirectory } : {}),
    ...(Object.keys(extra).length ? { extra } : {}),
  };
}

function normalizePluginMigrationSession(value: unknown): PluginMigrationSession | undefined {
  if (!isRecord(value)) return undefined;
  const jobId = stringValue(value.jobId);
  const workingDirectory = stringValue(value.workingDirectory);
  const sourceDirectory = stringValue(value.sourceDirectory);
  const outputDirectory = stringValue(value.outputDirectory);
  if (!jobId || !workingDirectory || !sourceDirectory || !outputDirectory) return undefined;
  const status = value.status === "installed" ? "installed" : "pending";
  return {
    jobId,
    workingDirectory,
    sourceDirectory,
    outputDirectory,
    detectedArtifacts: Array.isArray(value.detectedArtifacts)
      ? value.detectedArtifacts.flatMap((artifact) => typeof artifact === "string" ? [artifact] : [])
      : [],
    status,
    ...(stringValue(value.installedPluginName) ? { installedPluginName: stringValue(value.installedPluginName) } : {}),
    ...(typeof value.installedPluginEnabled === "boolean" ? { installedPluginEnabled: value.installedPluginEnabled } : {}),
    ...(stringValue(value.cleanupWarning) ? { cleanupWarning: stringValue(value.cleanupWarning) } : {}),
  };
}

function requireNative<T>(value: T | undefined, capability: string): T {
  if (!value) throw new Error(`${capability} Native API is unavailable outside the Tauri runtime`);
  return value;
}

function withModelProvider(extra: Record<string, unknown>, provider?: string): Record<string, unknown> {
  const next = { ...extra };
  delete next.modelProvider;
  if (provider?.trim()) {
    next.modelProvider = provider.trim();
  }
  return next;
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
