import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createDesktopChatSessionController } from "../app-core/chat/desktopChatSessionController";
import type { AgentInputReference } from "../app-core/chat/agentInputReference";
import type { DesktopCommand, DesktopTurnSubmitCommand } from "../app-core/chat/desktopCommand";
import { createDesktopNativeConfigApi } from "../app-core/native/desktopNativeConfig";
import { createDesktopNativeAgentGraphsApi } from "../app-core/native/desktopNativeAgentGraphs";
import { applyNativeConfigPatch } from "../app-core/native/desktopNativeConfigPatch";
import { createDesktopNativePluginsApi } from "../app-core/native/desktopNativePlugins";
import {
  createDesktopNativeThreadsApi,
  type NativeThreadListResult,
  type NativeThreadRecord,
} from "../app-core/native/desktopNativeThreads";
import { createDesktopNativeHostCommandApi } from "../app-core/native/desktopNativeHostCommand";
import { createDesktopNativeMemoryApi } from "../app-core/native/desktopNativeMemory";
import { createDesktopNativeHooksApi } from "../app-core/native/desktopNativeHooks";
import { createDesktopNativeProjectGroupsApi } from "../app-core/native/desktopNativeProjectGroups";
import { createDesktopNativeBrowserApi } from "../app-core/native/desktopNativeBrowser";
import { createDesktopNativeTerminalApi } from "../app-core/native/desktopNativeTerminal";
import { createDesktopNativeWebuiApi } from "../app-core/native/desktopNativeWebui";
import { createDesktopNativeWorkspaceApi } from "../app-core/native/desktopNativeWorkspace";
import { createDesktopNativePerformanceTraceApi } from "../app-core/native/desktopNativePerformanceTrace";
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
import type { ReactChatMessage } from "./chat/messageActions";
import {
  createTinyOsAgentCancelCommand,
  toNativeTinyOsHostCommandFrame,
  type TinyOsCommand,
  type TinyOsHostCommand,
} from "../app-core/chat/tinyOsCommand";
import {
  readCurrentChatModelPreference,
} from "../app-core/chat/chatModelPreference";
import { normalizeTinyOsEffectiveCapabilities } from "../app-core/chat/tinyOsCapabilities";

type Listener = (event: ChatEvent) => void;

export function createDesktopAppServices(): AppServices {
  const nativeMode = hasTauriRuntime();
  const nativeConfig = nativeMode ? createDesktopNativeConfigApi({ invoke }) : undefined;
  const nativeAgentGraphs = nativeMode ? createDesktopNativeAgentGraphsApi({ invoke }) : undefined;
  const nativePlugins = nativeMode ? createDesktopNativePluginsApi({ invoke }) : undefined;
  const nativeThreads = nativeMode ? createDesktopNativeThreadsApi({ invoke }) : undefined;
  const nativeHostCommands = nativeMode ? createDesktopNativeHostCommandApi({ invoke }) : undefined;
  const nativeMemory = nativeMode ? createDesktopNativeMemoryApi({ invoke }) : undefined;
  const nativeHooks = nativeMode ? createDesktopNativeHooksApi({ invoke }) : undefined;
  const nativeProjectGroups = nativeMode ? createDesktopNativeProjectGroupsApi({ invoke }) : undefined;
  const nativeBrowser = nativeMode ? createDesktopNativeBrowserApi({ invoke }) : undefined;
  const nativeTerminal = nativeMode ? createDesktopNativeTerminalApi({ invoke }) : undefined;
  const nativeWebui = nativeMode ? createDesktopNativeWebuiApi({ invoke }) : undefined;
  const nativeWorkspace = nativeMode ? createDesktopNativeWorkspaceApi({ invoke }) : undefined;
  const nativePerformanceTrace = nativeMode ? createDesktopNativePerformanceTraceApi({ invoke }) : undefined;
  let initialized: Promise<void> | null = null;
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
    let offset: number | undefined;
    let result: NativeThreadListResult;
    while (true) {
      result = await requireNative(nativeThreads, "Thread").list({
        includeChildThreads: true,
        ...(offset === undefined ? {} : { offset }),
      });
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
      await nativeEvents.register();
      await controller.loadSessions();
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

  async function dispatchTinyOsCommand(command: TinyOsCommand): Promise<void> {
    await initialize();
    const thread = controller.state.threads.find((item) => item.threadId === command.target.sessionId);
    if (thread && controller.state.activeThreadId !== thread.threadId) {
      await controller.selectSession(thread.threadId);
    }
    const threadId = thread?.threadId || command.target.threadId || command.target.sessionId;
    if (command.kind === "agent.cancel") {
      await requireNative(nativeThreads, "Thread").interrupt({
        threadId,
        turnId: command.target.turnId,
        clientEventId: command.commandId,
        reason: "user_requested",
      });
    } else if (command.kind === "form.submit" || command.kind === "form.cancel") {
      await requireNative(nativeThreads, "Thread").submitForm({
        threadId,
        formId: command.form.formId,
        values: command.kind === "form.submit" ? command.form.values : {},
        action: command.kind === "form.submit" ? "submit" : "cancel",
      });
    } else {
      const hostCommand = command as TinyOsHostCommand;
      await requireNative(nativeHostCommands, "Host command").dispatch({
        clientId: "desktop-native",
        attachedChatId: command.target.sessionId,
        frame: toNativeTinyOsHostCommandFrame(command.target.sessionId, hostCommand),
      });
    }
    notifySession(command.target.sessionId, { commandId: command.commandId, type: "command.accepted" });
    notifySession(command.target.sessionId, { commandId: command.commandId, type: "command.canonical-updated" });
  }

  async function dispatchTurnSubmit(command: DesktopTurnSubmitCommand): Promise<void> {
    await initialize();
    const sessionId = command.target.sessionId;
    const thread = controller.state.threads.find((item) => item.threadId === sessionId);
    if (!thread) throw new Error(`Cannot send to unknown Thread ${sessionId}`);
    if (controller.state.activeThreadId !== thread.threadId) {
      await controller.selectSession(thread.threadId);
    }
    const input = command.input;
    const preference = readCurrentChatModelPreference();
    const threadExtra = isRecord(thread.metadata?.extra) ? thread.metadata.extra : {};
    const threadModel = stringValue(thread.metadata?.model);
    const threadProvider = stringValue(threadExtra.modelProvider);
    const model = stringValue(input.model) || threadModel || preference?.modelId || "";
    const provider = stringValue(input.provider)
      || (model === threadModel ? threadProvider : "")
      || (model === preference?.modelId ? preference.providerId ?? "" : "");
    if (model && (model !== threadModel || provider !== threadProvider)) {
      await controller.patchSession(sessionId, {
        model,
        metadata: withModelProvider(threadExtra, provider),
      });
    }
    const result = await controller.submitMessage(input.text, {
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      ...(input.references?.length ? { references: input.references } : {}),
      ...(input.selectedSkills?.length ? { selectedSkills: input.selectedSkills } : {}),
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
          nativeEvents.notifyTerminalTimelineState(sessionId, timeline);
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
        || candidate.status === "awaiting_user"
      ));
      if (!turn) throw new Error("Cannot cancel: the session has no active turn");
      const cancelCommand = createTinyOsAgentCancelCommand({
        commandId: command.commandId,
        issuedAt: command.issuedAt,
        sessionId,
        source: command.source,
        threadId: turn.canonicalItems?.find((item) => item.threadId)?.threadId,
        turnId: turn.id,
      });
      notifySession(sessionId, { command: cancelCommand, type: "command.dispatched" });
      await dispatchTinyOsCommand(cancelCommand);
      return;
    }
    if (command.kind === "context.compact") {
      await initialize();
      const sessionId = command.target.sessionId;
      const thread = controller.state.threads.find((candidate) => candidate.threadId === sessionId);
      if (!thread) throw new Error(`Cannot compact unknown Thread ${sessionId}`);
      if (controller.state.activeThreadId !== sessionId) {
        await controller.selectSession(sessionId);
      }
      await requireNative(nativeThreads, "Thread").compact({
        threadId: sessionId,
        clientEventId: command.commandId,
      });
      const timeline = await controller.loadTimeline(sessionId);
      notifySession(sessionId, { type: "timeline.patch", timeline });
      nativeEvents.notifyTerminalTimelineState(sessionId, timeline);
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
      async create(input) {
        await initialize();
        const preference = readCurrentChatModelPreference();
        const model = stringValue(input?.model) || preference?.modelId || "";
        const modelProvider = stringValue(input?.modelProvider)
          || (model === preference?.modelId ? preference.providerId ?? "" : "");
        const extra = {
          ...(modelProvider ? { modelProvider } : {}),
          ...(input?.projectGroupId ? { projectGroupId: input.projectGroupId } : {}),
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
      async loadTinyOsCapabilities(threadId) {
        await initialize();
        return normalizeTinyOsEffectiveCapabilities(
          await requireNative(nativeThreads, "Thread").getEffectiveCapabilities(threadId),
          threadId,
        );
      },
      async dispatch(command) {
        await dispatchDesktopCommand(command);
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
      async branchFromMessage(sessionId, messageId) {
        await initialize();
        const sourceThread = controller.state.threads.find((thread) => thread.threadId === sessionId);
        if (!sourceThread) {
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
        const sourceThreadId = sourceThread.threadId;
        const forkAfterSequence = await resolveForkSequence(sourceThreadId, new Set([
          messageId,
          canonicalItem.itemId,
          stringValue(canonicalItem.data.messageId ?? canonicalItem.data.message_id),
        ].filter(Boolean)));
        if (forkAfterSequence === undefined) {
          throw new Error(`Cannot resolve persisted fork boundary for canonical message ${messageId}`);
        }
        const title = `${sourceThread.title} · 分叉`;
        const forkedThread = await requireNative(nativeThreads, "Thread").fork({
          threadId: sourceThreadId,
          clientEventId: `fork:${sourceThreadId}:${messageId}`,
          title,
          forkAfterSequence,
        });
        await controller.loadSessions();
        const branchThread = controller.state.threads.find((thread) => (
          thread.threadId === forkedThread.threadId
        ));
        if (!branchThread) {
          throw new Error(`Forked Thread ${forkedThread.threadId} is missing from the Thread list`);
        }
        return mapSession(branchThread, false, forkedThread);
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
    workspaceStore: createDesktopWorkspaceStore({ initialize, nativeWorkspace }),
    memoryStore: {
      async load() {
        await initialize();
        return requireNative(nativeMemory, "Memory").snapshot();
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
      nativeWebui,
      nativeWorkspace,
      applyNativeConfigPatch: nativeMode
        ? (configToPatch, nativePatch) => applyNativeConfigPatch(configToPatch, nativePatch, { invoke })
        : undefined,
    }),
    performanceStore: {
      async load() {
        await initialize();
        return requireNative(nativePerformanceTrace, "Performance trace").snapshot();
      },
      async exportDiagnosticBundle() {
        await initialize();
        return requireNative(nativePerformanceTrace, "Performance trace").exportDiagnosticBundle({
          diagnosticModeEnabled: isRendererDiagnosticModeEnabled(),
          locale: navigator.language || undefined,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || undefined,
          rendererLogs: rendererLogSnapshot(),
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

function createOptimisticUserMessage(clientEventId: string, text: string, references: AgentInputReference[] = []): ReactChatMessage {
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
        presentation: reference.type === "tinyos.file" && Boolean(reference.rawPath) && !reference.sourcePath
          ? "attachment"
          : "context",
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
