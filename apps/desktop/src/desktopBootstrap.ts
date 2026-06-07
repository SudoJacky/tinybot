import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { defaultWindowIcon } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import webUiHtml from "../../../webui/index.html?raw";
import {
  buildAgentUiFormCancelRequest,
  buildAgentUiFormSubmitRequest,
  validateAgentUiFormValues,
} from "./agentUiEvents";
import {
  buildDesktopCoworkActionRequest,
  buildDesktopCoworkCockpitView,
  buildDesktopCoworkSessionRows,
  buildDesktopCoworkTaskOperations,
} from "./desktopCowork";
import { installDesktopCommandPalette, type DesktopCommandPaletteInput } from "./desktopCommandPalette";
import { installDesktopMenuCommandRouting } from "./desktopCommandNavigation";
import type { GatewayRuntimeStatus } from "./desktopGatewayStartup";
import { ensureGatewayReady } from "./desktopGatewayStartup";
import { installDesktopGatewayBridge } from "./desktopGatewayBridge";
import {
  buildDesktopKnowledgeDocumentRows,
  buildDesktopKnowledgePaneModel,
  buildDesktopKnowledgeTaskOperation,
  type DesktopKnowledgePaneModel,
} from "./desktopKnowledgeTraceability";
import { installWebUiRenderGlobals } from "./desktopMarkdownGlobals";
import { logDesktopNativeChatDebug, logDesktopNativeDebug, summarizeDebugText } from "./desktopNativeChatDebug";
import { installDesktopNavigation } from "./desktopNavigation";
import { applyDesktopWorkbenchRouteState } from "./desktopEntityFocus";
import {
  createDesktopNativeWorkbenchRuntime,
  type DesktopNativeWorkbenchRuntime,
} from "./desktopNativeWorkbenchRuntime";
import { createDesktopOsNotificationBridge } from "./desktopOsNotifications";
import {
  applyDesktopSettingsFieldEdit,
  applyDesktopProviderModels,
  buildDesktopProviderCatalogItems,
  buildDesktopProviderModelRequest,
  buildDesktopSettingsFormState,
  buildDesktopSettingsPaneModel,
  createDesktopSettingsPatch,
  type DesktopSettingsFormState,
  type DesktopSettingsPaneModel,
} from "./desktopSettingsProviders";
import { bindStartupRetry, setStartupState } from "./desktopStartupView";
import { buildDesktopTaskCenterItems, type DesktopTaskSourceOperation } from "./desktopTaskCenter";
import { createDesktopTaskNotificationController } from "./desktopTaskNotifications";
import { runDesktopGatewayRuntimeCommand, type DesktopGatewayRuntimeCommand, type DesktopGatewayRuntimeCommandPayload } from "./desktopGatewayRuntimeControls";
import {
  buildDesktopApprovalTaskOperations,
  buildDesktopGatewayTaskOperation,
  buildDesktopProviderModelDiscoveryTaskOperation,
} from "./desktopTaskCenterSources";
import { buildDesktopSkillRows, buildDesktopToolRows } from "./desktopToolsSkills";
import {
  buildDesktopToolsSkillsPaneModel,
  updateDesktopSkillEditorDraft,
  type DesktopToolsSkillsPaneModel,
} from "./desktopToolsSkills";
import {
  installDesktopWorkbenchShell,
  updateDesktopGatewayRuntimeStatus,
  updateDesktopAgentUiForms,
  updateDesktopCoworkPane,
  updateDesktopKnowledgePane,
  updateDesktopNativeChat,
  updateDesktopSettingsPane,
  updateDesktopTaskCenterItems,
  updateDesktopToolsSkillsPane,
  type DesktopCoworkActionEvent,
  type DesktopCoworkPaneModel,
  type DesktopAgentUiFormActionEvent,
  type DesktopGatewayRuntimeActionEvent,
  type DesktopKnowledgeActionEvent,
  type DesktopSettingsActionEvent,
  type DesktopTaskCenterActionEvent,
  type DesktopToolsSkillsActionEvent,
} from "./desktopWorkbenchShell";
import { installDesktopWorkspaceFileActions } from "./desktopWorkspaceFiles";
import { buildDesktopWorkspaceFileRows } from "./desktopWorkspaceFiles";
import { installDesktopRootWebUiWorkbenchAdapter } from "./desktopRootWebUiWorkbench";
import { installWebUiShell } from "./desktopWebUiShell";
import { resolveDesktopWorkbenchStartupMode } from "./desktopWorkbenchGate";
import { installDesktopWindowFrame, setDesktopWindowRuntimeStatus } from "./desktopWindowFrame";
import { DEFAULT_GATEWAY_CONFIG, resolveGatewayConfig } from "./gatewayConfig";
import { checkGatewayHealth, createGatewayApiClient } from "./gatewayHttpClient";
import { normalizeSessionsPayload } from "./nativeChat";
import {
  flushGatewaySocketQueue,
  openGatewaySocket,
  sendGatewaySocketJson,
  type NormalizedGatewayEvent,
} from "./gatewayWebSocketClient";
import {
  desktopUploadPickerOptions,
  installDesktopFileUploadActions,
  type DesktopPickedUploadFile,
  type DesktopUploadKind,
} from "./desktopFileUpload";
import { installDesktopWebUiCommandBridge } from "./desktopWebUiCommandBridge";
import { installDesktopWebUiFilePickerBridge } from "./desktopWebUiFilePickerBridge";
import { installDesktopWebUiNotificationBridge } from "./desktopWebUiNotificationBridge";
import {
  buildDesktopCommandEntriesFromSidebar,
  buildNativeWorkbenchSidebarModel,
  buildRootWebUiSidebarModel,
} from "./desktopSharedModels";

const gatewayConfig = resolveGatewayConfig(DEFAULT_GATEWAY_CONFIG);
const gatewayApi = createGatewayApiClient({ config: gatewayConfig });
const WEBUI_ENTRY = "/assets/src/main.js";
const nativeKnowledgeTaskOperations = new Map<string, DesktopTaskSourceOperation>();
const nativeCoworkTaskOperations = new Map<string, DesktopTaskSourceOperation>();
const nativeProviderTaskOperations = new Map<string, DesktopTaskSourceOperation>();
const nativeFileTaskOperations = new Map<string, DesktopTaskSourceOperation>();
const nativeGatewayTaskOperations = new Map<string, DesktopTaskSourceOperation>();
const nativeApprovalTaskOperations = new Map<string, DesktopTaskSourceOperation>();
let nativeRuntimeStatus: GatewayRuntimeStatus | null = null;
let nativeSettingsConfig: unknown = {};
let nativeSettingsState: DesktopSettingsFormState | null = null;
let nativeSettingsLastSavedState: DesktopSettingsFormState | null = null;
let nativeSettingsProviderCatalog: ReturnType<typeof buildDesktopProviderCatalogItems> = [];
let nativeSkillsPayload: unknown = {};
let nativeToolsPayload: unknown = {};
let nativeToolsSkillsConfig: unknown = {};
let nativeToolsSkillsPane: DesktopToolsSkillsPaneModel | null = null;
let nativeKnowledgePane: DesktopKnowledgePaneModel | null = null;
let nativeKnowledgeQueryResult: unknown = {};
let nativeCoworkPane: DesktopCoworkPaneModel | null = null;
let nativeCoworkSelectedSessionId = "";
let nativeWorkbenchRuntime: DesktopNativeWorkbenchRuntime | null = null;
let nativeChatSocket: WebSocket | null = null;
let nativeChatWsUrl = gatewayConfig.wsUrl;
let nativeChatRuntimeActionsInstalled = false;
const nativePendingSocketMessages: unknown[] = [];
const nativeOsNotifications = createDesktopOsNotificationBridge({
  hasTauriRuntime,
  loadApi: async () => {
    const api = await import("@tauri-apps/plugin-notification");
    return {
      isPermissionGranted: api.isPermissionGranted,
      requestPermission: api.requestPermission,
      sendNotification: api.sendNotification,
    };
  },
});
const nativeTaskNotifications = createDesktopTaskNotificationController({
  enabled: true,
  isFocused: () => document.hasFocus(),
  canNotify: nativeOsNotifications.canNotify,
  notify: nativeOsNotifications.notify,
});

document.addEventListener("DOMContentLoaded", () => {
  installTauriWindowFrame();
  bindStartupRetry(document, () => {
    void bootDesktopWebUi();
  });
  void bootDesktopWebUi();
});

async function bootDesktopWebUi(): Promise<void> {
  logDesktopNativeDebug("bootstrap.start", {
    gatewayHttp: gatewayConfig.httpBaseUrl,
    hasTauriRuntime,
  });
  setStartupState(document, "Starting local gateway...", null, false);
  try {
    const status = await ensureGatewayReady(gatewayConfig, { invoke, hasTauriRuntime });
    nativeRuntimeStatus = status;
    updateNativeGatewayTask(buildDesktopGatewayTaskOperation("startup", status));
    const workbenchMode = resolveDesktopWorkbenchStartupMode();
    document.documentElement.dataset.desktopWorkbenchMode = workbenchMode.mode;
    document.documentElement.dataset.desktopWorkbenchRequestedMode = workbenchMode.requestedMode;
    if (workbenchMode.fallbackReason) {
      logDesktopNativeDebug("bootstrap.fallback", {
        fallbackReason: workbenchMode.fallbackReason,
        mode: workbenchMode.mode,
        requestedMode: workbenchMode.requestedMode,
      });
      console.info("Tinybot desktop loading root WebUI fallback", workbenchMode);
    }
    installDesktopGatewayBridge({ config: gatewayConfig });
    installWebUiRenderGlobals();
    if (workbenchMode.mode === "native-workbench") {
      const nativeChatRuntime = await loadNativeChatRuntime();
      const settingsPane = await loadNativeSettingsPane();
      syncNativeRuntimeMetadata();
      const knowledgePane = await loadNativeKnowledgePane();
      const toolsSkillsPane = await loadNativeToolsSkillsPane();
      const coworkPane = await loadNativeCoworkPane();
      installDesktopWorkbenchShell({
        runtimeStatus: status,
        chat: nativeChatRuntime.chat,
        chatActions: nativeChatActions(),
        agentUiForms: nativeChatRuntime.agentUiForms,
        agentUiActions: nativeAgentUiActions(),
        gatewayHttp: gatewayConfig.httpBaseUrl,
        taskCenterItems: currentNativeTaskCenterItems(),
        taskActions: nativeTaskActions(),
        settingsPane,
        settingsActions: {
          onSettingsAction: (event) => {
            void handleNativeSettingsAction(event);
          },
        },
        knowledgePane,
        knowledgeActions: {
          onKnowledgeAction: (event) => {
            void handleNativeKnowledgeAction(event);
          },
        },
        toolsSkillsPane,
        toolsSkillsActions: {
          onToolsSkillsAction: (event) => {
            void handleNativeToolsSkillsAction(event);
          },
        },
        coworkPane,
        coworkActions: {
          onCoworkAction: (event) => {
            void handleNativeCoworkAction(event);
          },
        },
        gatewayActions: {
          onGatewayRuntimeAction: (event) => {
            void handleNativeGatewayRuntimeAction(event);
          },
        },
      });
      installNativeChatRuntimeActions();
      installNativeFileUploadActions();
      installNativeWorkspaceFileActions();
      installNativeCommandPalette();
      installTauriNavigation();
      installTauriMenuCommandRouting();
      installTauriWindowFrame(status);
      void refreshNativeCoworkTasks();
      void refreshNativeApprovalTasks();
      logDesktopNativeDebug("bootstrap.native.initialized", {
        gatewayHttp: gatewayConfig.httpBaseUrl,
        mode: workbenchMode.mode,
        runtimeState: status?.state ?? "",
      });
      console.info("Tinybot desktop native workbench initialized", status);
      return;
    }
    installWebUiShell(webUiHtml);
    await import(/* @vite-ignore */ WEBUI_ENTRY);
    installDesktopRootWebUiWorkbenchAdapter();
    installDesktopCommandPalette({
      gatewayOrigin: gatewayConfig.httpBaseUrl,
      desktopCommands: buildRootWebUiDesktopCommands(),
      loadData: loadRootWebUiCommandPaletteData,
    });
    installRootWebUiDesktopAdapters();
    installTauriNavigation();
    installTauriWindowFrame(status);
    logDesktopNativeDebug("bootstrap.webui.initialized", {
      gatewayHttp: gatewayConfig.httpBaseUrl,
      mode: workbenchMode.mode,
      runtimeState: status?.state ?? "",
    });
    console.info("Tinybot desktop WebUI initialized", status);
  } catch (error) {
    logDesktopNativeDebug("bootstrap.failed", {
      error: stringifyError(error),
      gatewayHttp: gatewayConfig.httpBaseUrl,
    });
    setStartupState(
      document,
      "Tinybot gateway is not ready.",
      `${stringifyError(error)}\n\nGateway: ${gatewayConfig.httpBaseUrl}`,
      true,
    );
  }
}

async function loadNativeChatRuntime(): Promise<DesktopNativeWorkbenchRuntime> {
  logDesktopNativeDebug("bootstrap.nativeChat.load.start", {
    gatewayHttp: gatewayConfig.httpBaseUrl,
  });
  const runtime = createDesktopNativeWorkbenchRuntime({
    api: {
      listSessions: () => gatewayApi.sessions.list(),
      loadMessages: (sessionKey) => gatewayApi.sessions.messages(sessionKey),
      deleteSession: (sessionKey) => gatewayApi.sessions.delete(sessionKey),
    },
    sendSocketMessage: (message) => sendNativeChatSocketMessage(message),
  });
  nativeWorkbenchRuntime = runtime;
  const health = await checkGatewayHealth({ config: gatewayConfig }).catch(() => null);
  nativeChatWsUrl = health?.tokenReady ? health.wsUrl : gatewayConfig.wsUrl;
  runtime.setRuntimeMetadata({
    gatewayHttp: gatewayConfig.httpBaseUrl,
    webSocket: health?.webSocket.ok ? "Connected" : health?.webSocket.ok === false ? health.webSocket.error : "Pending",
    tokenReady: health?.tokenReady === true,
  });
  ensureNativeChatSocket(runtime);
  try {
    await runtime.loadInitialChatState();
  } catch (error) {
    logDesktopNativeDebug("bootstrap.nativeChat.load.failed", {
      error: stringifyError(error),
    });
    console.warn("Tinybot desktop failed to load native chat state", error);
  }
  logDesktopNativeDebug("bootstrap.nativeChat.load.complete", {
    activeSessionKey: runtime.chat.activeSessionKey,
    sessionCount: runtime.chat.sessions.length,
  });
  return runtime;
}

function ensureNativeChatSocket(runtime = nativeWorkbenchRuntime): void {
  if (!runtime || (nativeChatSocket && nativeChatSocket.readyState <= WebSocket.OPEN)) {
    return;
  }
  logDesktopNativeDebug("socket.ensure", {
    wsUrl: nativeChatWsUrl,
  });
  nativeChatSocket = openGatewaySocket(resolveGatewayConfig({ ...gatewayConfig, wsUrl: nativeChatWsUrl }), {
    onOpen: () => {
      logDesktopNativeChatDebug("socket.open", {
        pendingMessages: nativePendingSocketMessages.length,
        wsUrl: nativeChatWsUrl,
      });
      flushGatewaySocketQueue(nativeChatSocket, nativePendingSocketMessages);
      runtime.setRuntimeMetadata({ webSocket: "Connected" });
      updateDesktopNativeChat(document, runtime.chat, gatewayConfig.httpBaseUrl, nativeChatActions());
    },
    onClose: () => {
      logDesktopNativeChatDebug("socket.close", { wsUrl: nativeChatWsUrl });
      runtime.setRuntimeMetadata({ webSocket: "Disconnected" });
      updateDesktopNativeChat(document, runtime.chat, gatewayConfig.httpBaseUrl, nativeChatActions());
    },
    onError: () => {
      logDesktopNativeChatDebug("socket.error", { wsUrl: nativeChatWsUrl });
      runtime.setRuntimeMetadata({ webSocket: "Connection failed" });
      updateDesktopNativeChat(document, runtime.chat, gatewayConfig.httpBaseUrl, nativeChatActions());
    },
    onEvent: (event) => {
      void handleNativeChatGatewayEvent(event);
    },
  });
}

function sendNativeChatSocketMessage(message: unknown): void {
  ensureNativeChatSocket();
  sendGatewaySocketJson(nativeChatSocket, message, nativePendingSocketMessages);
}

function syncNativeRuntimeMetadata(): void {
  if (!nativeWorkbenchRuntime) {
    return;
  }
  nativeWorkbenchRuntime.setRuntimeMetadata({
    provider: nativeSettingsState?.agent.provider || undefined,
    model: nativeSettingsState?.agent.model || undefined,
    gatewayHttp: gatewayConfig.httpBaseUrl,
  });
  updateDesktopNativeChat(document, nativeWorkbenchRuntime.chat, gatewayConfig.httpBaseUrl, nativeChatActions());
}

async function handleNativeChatGatewayEvent(event: NormalizedGatewayEvent): Promise<void> {
  if (!nativeWorkbenchRuntime) {
    logDesktopNativeChatDebug("gateway.event", {
      dropped: "native runtime unavailable",
      event: summarizeNativeGatewayEvent(event),
    });
    return;
  }
  logDesktopNativeChatDebug("gateway.event", {
    event: summarizeNativeGatewayEvent(event),
  });
  logDesktopNativeChatDebug("runtime.before", summarizeNativeChatModel(nativeWorkbenchRuntime.chat));
  await nativeWorkbenchRuntime.handleGatewayEvent(event);
  logDesktopNativeChatDebug("runtime.after", summarizeNativeChatModel(nativeWorkbenchRuntime.chat));
  updateDesktopNativeChat(document, nativeWorkbenchRuntime.chat, gatewayConfig.httpBaseUrl, nativeChatActions());
  refreshNativeAgentUiForms();
  publishNativeTaskCenterItems();
}

function nativeChatActions() {
  return {
    onComposerSubmit: (event: { content: string; usePersistentRag: boolean }) => {
      if (!nativeWorkbenchRuntime) {
        return;
      }
      const result = nativeWorkbenchRuntime.submitComposerMessage(event.content, event.usePersistentRag);
      if (result.status !== "empty") {
        const input = document.getElementById("desktop-native-composer-input") as HTMLTextAreaElement | null;
        if (input) {
          input.value = "";
        }
      }
      updateDesktopNativeChat(document, nativeWorkbenchRuntime.chat, gatewayConfig.httpBaseUrl, nativeChatActions());
    },
    onInterrupt: () => {
      if (!nativeWorkbenchRuntime) {
        return;
      }
      nativeWorkbenchRuntime.interruptActiveChat();
      updateDesktopNativeChat(document, nativeWorkbenchRuntime.chat, gatewayConfig.httpBaseUrl, nativeChatActions());
    },
    onAttachSessionFile: () => {
      document.getElementById("desktop-session-file-upload")?.click();
    },
    onNewChat: () => {
      if (!nativeWorkbenchRuntime) {
        return;
      }
      nativeWorkbenchRuntime.startNewChat();
      updateDesktopNativeChat(document, nativeWorkbenchRuntime.chat, gatewayConfig.httpBaseUrl, nativeChatActions());
    },
    onDeleteSession: (event: { sessionKey: string; title: string }) => {
      if (!nativeWorkbenchRuntime) {
        return Promise.resolve();
      }
      return nativeWorkbenchRuntime.deleteChatSession(event.sessionKey).then(() => {
        if (nativeWorkbenchRuntime) {
          updateDesktopNativeChat(document, nativeWorkbenchRuntime.chat, gatewayConfig.httpBaseUrl, nativeChatActions());
        }
      }).catch((error) => {
        console.warn("Tinybot desktop session delete failed", error);
        throw error;
      });
    },
    onPersistentRagChange: (enabled: boolean) => {
      if (!nativeWorkbenchRuntime) {
        return;
      }
      nativeWorkbenchRuntime.setPersistentRag(enabled);
      updateDesktopNativeChat(document, nativeWorkbenchRuntime.chat, gatewayConfig.httpBaseUrl, nativeChatActions());
    },
  };
}

function summarizeNativeGatewayEvent(event: NormalizedGatewayEvent): Record<string, unknown> {
  return {
    chatId: "chatId" in event ? event.chatId : "",
    kind: event.kind,
    messageId: "messageId" in event ? event.messageId : "",
    text: "text" in event ? summarizeDebugText(event.text) : undefined,
  };
}

function summarizeNativeChatModel(chat: DesktopNativeWorkbenchRuntime["chat"]): Record<string, unknown> {
  return {
    activeChatId: chat.activeChatId,
    activeSessionKey: chat.activeSessionKey,
    composerState: chat.composerState,
    messageCount: chat.messages.length,
    responding: chat.responding === true,
    sessionCount: chat.sessions.length,
    status: chat.status,
  };
}

function nativeAgentUiActions() {
  return {
    onAgentUiFormAction: (event: DesktopAgentUiFormActionEvent) => {
      void handleNativeAgentUiFormAction(event);
    },
  };
}

function nativeTaskActions() {
  return {
    onTaskAction: (event: DesktopTaskCenterActionEvent) => {
      void handleNativeTaskAction(event);
    },
  };
}

async function handleNativeTaskAction(event: DesktopTaskCenterActionEvent): Promise<void> {
  if (!["approveOnce", "approveSession", "deny"].includes(event.action)) {
    logDesktopNativeDebug("task.action.ignored", summarizeTaskCenterAction(event));
    return;
  }
  const approvalId = event.item.approval?.approvalId || event.item.destination.entityId || "";
  const sessionKey = event.item.approval?.sessionKey || nativeWorkbenchRuntime?.chat.activeSessionKey || "";
  logDesktopNativeDebug("task.action.start", {
    ...summarizeTaskCenterAction(event),
    approvalId,
    hasSessionKey: Boolean(sessionKey),
  });
  if (!approvalId || !sessionKey) {
    nativeApprovalTaskOperations.set(event.item.id, {
      id: event.item.id,
      title: event.item.title,
      status: "failed",
      detail: event.item.detail,
      canonical: event.item.destination,
      diagnostics: "Approval id or session key is missing.",
      retryable: true,
      updatedAt: new Date().toISOString(),
      ...(event.item.approval ? { approval: event.item.approval } : {}),
    });
    publishNativeTaskCenterItems();
    logDesktopNativeDebug("task.action.missingApprovalContext", summarizeTaskCenterAction(event));
    return;
  }
  try {
    if (event.action === "deny") {
      await gatewayApi.tools.denyApproval(approvalId, {
        session_key: sessionKey,
        auto_retry: true,
      });
    } else {
      await gatewayApi.tools.approveApproval(approvalId, {
        session_key: sessionKey,
        scope: event.action === "approveSession" ? "session" : "once",
        auto_retry: true,
      });
    }
    nativeApprovalTaskOperations.delete(event.item.id);
    publishNativeTaskCenterItems();
    await refreshNativeApprovalTasks();
    logDesktopNativeDebug("task.action.complete", summarizeTaskCenterAction(event));
  } catch (error) {
    nativeApprovalTaskOperations.set(event.item.id, {
      id: event.item.id,
      title: event.item.title,
      status: "failed",
      detail: event.item.detail,
      canonical: event.item.destination,
      diagnostics: stringifyError(error),
      retryable: true,
      updatedAt: new Date().toISOString(),
      ...(event.item.approval ? { approval: event.item.approval } : {}),
    });
    publishNativeTaskCenterItems();
    logDesktopNativeDebug("task.action.failed", {
      ...summarizeTaskCenterAction(event),
      error: stringifyError(error),
    });
  }
}

function refreshNativeAgentUiForms(): void {
  if (!nativeWorkbenchRuntime) {
    return;
  }
  updateDesktopAgentUiForms(document, nativeWorkbenchRuntime.agentUiForms, nativeAgentUiActions());
}

async function handleNativeAgentUiFormAction(event: DesktopAgentUiFormActionEvent): Promise<void> {
  const form = event.form;
  logDesktopNativeDebug("agentUi.form.action.start", summarizeAgentUiFormAction(event));
  if (event.action === "submit") {
    const values = event.values ?? {};
    try {
      validateAgentUiFormValues(form, values);
      const request = buildAgentUiFormSubmitRequest(form, values);
      if (!request) {
        return;
      }
      form.values = values;
      form.errors = {};
      form.submitting = true;
      refreshNativeAgentUiForms();
      await gatewayApi.agentUi.submitForm(form.form_id, request);
      form.submitting = false;
      refreshNativeAgentUiForms();
      publishNativeTaskCenterItems();
      logDesktopNativeDebug("agentUi.form.submit.complete", summarizeAgentUiFormAction(event));
    } catch (error) {
      form.values = values;
      form.submitting = false;
      form.errors = { ...(form.errors ?? {}), form: stringifyError(error) };
      refreshNativeAgentUiForms();
      publishNativeTaskCenterItems();
      logDesktopNativeDebug("agentUi.form.submit.failed", {
        ...summarizeAgentUiFormAction(event),
        error: stringifyError(error),
      });
    }
    return;
  }

  try {
    const request = buildAgentUiFormCancelRequest(form);
    if (!request) {
      return;
    }
    form.submitting = true;
    refreshNativeAgentUiForms();
    await gatewayApi.agentUi.cancelForm(form.form_id, request);
    form.submitting = false;
    refreshNativeAgentUiForms();
    publishNativeTaskCenterItems();
    logDesktopNativeDebug("agentUi.form.cancel.complete", summarizeAgentUiFormAction(event));
  } catch (error) {
    form.submitting = false;
    form.errors = { ...(form.errors ?? {}), form: stringifyError(error) };
    refreshNativeAgentUiForms();
    publishNativeTaskCenterItems();
    logDesktopNativeDebug("agentUi.form.cancel.failed", {
      ...summarizeAgentUiFormAction(event),
      error: stringifyError(error),
    });
  }
}

function installNativeChatRuntimeActions(): void {
  if (nativeChatRuntimeActionsInstalled) {
    return;
  }
  nativeChatRuntimeActionsInstalled = true;
  logDesktopNativeDebug("runtime.actions.install");
  document.addEventListener("tinybot:desktop-stop-generation", () => {
    logDesktopNativeDebug("runtime.actions.stopGeneration");
    nativeChatActions().onInterrupt();
  });
  document.addEventListener("desktop-tool-approval-action", (event) => {
    void handleNativeInlineApprovalAction((event as CustomEvent).detail);
  });
  window.addEventListener("tinybot:desktop-route", (event) => {
    const target = (event as CustomEvent<{ href?: unknown }>).detail;
    const href = typeof target?.href === "string" ? target.href : "";
    if (!href) {
      return;
    }
    const path = new URL(href, window.location.origin).pathname;
    logDesktopNativeDebug("route.request", {
      path,
    });
    applyDesktopWorkbenchRouteState(document, path);
    if (path === "/chat/new") {
      nativeChatActions().onNewChat();
      return;
    }
    if (path.startsWith("/chat/")) {
      void selectNativeChatFromRoute(path);
    }
  });
}

async function handleNativeInlineApprovalAction(detail: unknown): Promise<void> {
  const record = asRecord(detail);
  if (!Object.keys(record).length) {
    logDesktopNativeDebug("inlineApproval.empty");
    return;
  }
  const action = typeof record.action === "string" ? record.action : "";
  if (!["approveOnce", "approveSession", "deny"].includes(action)) {
    logDesktopNativeDebug("inlineApproval.ignored", { action });
    return;
  }
  const approvalId = typeof record.approvalId === "string" ? record.approvalId : "";
  const sessionKey = typeof record.sessionKey === "string" && record.sessionKey
    ? record.sessionKey
    : nativeWorkbenchRuntime?.chat.activeSessionKey || "";
  const toolName = typeof record.toolName === "string" && record.toolName ? record.toolName : "tool";
  const taskId = `approval:${approvalId || toolName}`;
  logDesktopNativeDebug("inlineApproval.start", {
    action,
    approvalId,
    hasSessionKey: Boolean(sessionKey),
    toolName,
  });
  if (!approvalId || !sessionKey) {
    nativeApprovalTaskOperations.set(taskId, {
      id: taskId,
      title: `Approve ${toolName}`,
      status: "failed",
      detail: "Approval id or session key is missing.",
      canonical: { module: "approvals", entityId: approvalId || toolName, href: "/chat" },
      diagnostics: "Approval id or session key is missing.",
      retryable: true,
      updatedAt: new Date().toISOString(),
      approval: { approvalId, sessionKey },
    });
    publishNativeTaskCenterItems();
    logDesktopNativeDebug("inlineApproval.missingContext", { action, approvalId, toolName });
    return;
  }
  try {
    if (action === "deny") {
      await gatewayApi.tools.denyApproval(approvalId, {
        session_key: sessionKey,
        auto_retry: true,
      });
    } else {
      await gatewayApi.tools.approveApproval(approvalId, {
        session_key: sessionKey,
        scope: action === "approveSession" ? "session" : "once",
        auto_retry: true,
      });
    }
    nativeApprovalTaskOperations.delete(taskId);
    publishNativeTaskCenterItems();
    await refreshNativeApprovalTasks();
    logDesktopNativeDebug("inlineApproval.complete", { action, approvalId, toolName });
  } catch (error) {
    nativeApprovalTaskOperations.set(taskId, {
      id: taskId,
      title: `Approve ${toolName}`,
      status: "failed",
      detail: "Inline approval action failed.",
      canonical: { module: "approvals", entityId: approvalId, href: `/chat/${encodeURIComponent(sessionKey)}` },
      diagnostics: stringifyError(error),
      retryable: true,
      updatedAt: new Date().toISOString(),
      approval: { approvalId, sessionKey },
    });
    publishNativeTaskCenterItems();
    logDesktopNativeDebug("inlineApproval.failed", {
      action,
      approvalId,
      error: stringifyError(error),
      toolName,
    });
  }
}

async function selectNativeChatFromRoute(path: string): Promise<void> {
  if (!nativeWorkbenchRuntime) {
    logDesktopNativeDebug("route.chatSelect.skipped", { path, reason: "runtime unavailable" });
    return;
  }
  const chatId = decodeURIComponent(path.replace(/^\/chat\//, ""));
  const session = nativeWorkbenchRuntime.chat.sessions.find((item) => item.chatId === chatId || item.key === chatId);
  if (!session) {
    logDesktopNativeDebug("route.chatSelect.missing", { chatId, path });
    return;
  }
  logDesktopNativeDebug("route.chatSelect.start", { chatId, path, sessionKey: session.key });
  await nativeWorkbenchRuntime.selectChatSession(session.key, session.chatId);
  updateDesktopNativeChat(document, nativeWorkbenchRuntime.chat, gatewayConfig.httpBaseUrl, nativeChatActions());
  logDesktopNativeDebug("route.chatSelect.complete", { chatId, path, sessionKey: session.key });
}

async function loadNativeKnowledgePane(
  options: { queryResultPayload?: unknown; selectedDocumentId?: string | null } = {},
): Promise<DesktopKnowledgePaneModel> {
  logDesktopNativeDebug("knowledge.load.start", {
    hasQueryResult: options.queryResultPayload !== undefined,
    selectedDocumentId: options.selectedDocumentId ?? "",
  });
  const [stats, documents, config, graph, graphrag] = await Promise.all([
    gatewayApi.knowledge.stats().catch(() => ({})),
    gatewayApi.knowledge.documents().catch(() => ({ documents: [] })),
    gatewayApi.config.get().catch(() => ({})),
    gatewayApi.knowledge.graph().catch(() => ({})),
    gatewayApi.knowledge.graphrag().catch(() => ({})),
  ]);
  nativeKnowledgeQueryResult = options.queryResultPayload ?? nativeKnowledgeQueryResult;
  nativeKnowledgePane = buildDesktopKnowledgePaneModel({
    statsPayload: stats,
    config,
    documentsPayload: documents,
    selectedDocumentId: options.selectedDocumentId,
    queryDraft: nativeKnowledgePane?.query.draft,
    queryResultPayload: nativeKnowledgeQueryResult,
    graphPayload: mergeNativeKnowledgeGraphPayload(graph, graphrag),
  });
  logDesktopNativeDebug("knowledge.load.complete", {
    documentCount: nativeKnowledgePane.documentRows.length,
    hasQueryResult: nativeKnowledgePane.query.results.rows.length > 0,
    selectedDocumentId: nativeKnowledgePane.selectedDocument?.id ?? "",
  });
  return nativeKnowledgePane;
}

async function loadNativeCoworkPane(
  options: { selectedSessionId?: string | null; actionStatus?: string; summaryText?: string } = {},
): Promise<DesktopCoworkPaneModel> {
  logDesktopNativeDebug("cowork.load.start", {
    selectedSessionId: options.selectedSessionId ?? nativeCoworkSelectedSessionId,
  });
  const sessionsPayload = await gatewayApi.cowork.sessions({ includeCompleted: true }).catch(() => ({ sessions: [] }));
  replaceNativeCoworkTasks(sessionsPayload);
  const sessionRows = buildDesktopCoworkSessionRows(sessionsPayload);
  const requestedSessionId = options.selectedSessionId === null ? "" : options.selectedSessionId || nativeCoworkSelectedSessionId;
  const selectedSessionId = sessionRows.find((row) => row.id === requestedSessionId)?.id || sessionRows[0]?.id || "";
  nativeCoworkSelectedSessionId = selectedSessionId;
  if (!selectedSessionId) {
    nativeCoworkPane = {
      sessionRows,
      cockpitView: null,
      actionStatus: options.actionStatus,
      summaryText: options.summaryText,
    };
    logDesktopNativeDebug("cowork.load.complete", {
      hasCockpit: false,
      selectedSessionId,
      sessionCount: sessionRows.length,
    });
    return nativeCoworkPane;
  }
  const session = await gatewayApi.cowork.session(selectedSessionId).catch(() => null);
  nativeCoworkPane = {
    sessionRows,
    cockpitView: session ? buildDesktopCoworkCockpitView(session) : null,
    actionStatus: options.actionStatus,
    summaryText: options.summaryText,
  };
  logDesktopNativeDebug("cowork.load.complete", {
    hasCockpit: Boolean(nativeCoworkPane.cockpitView),
    selectedSessionId,
    sessionCount: sessionRows.length,
  });
  return nativeCoworkPane;
}

async function handleNativeCoworkAction(event: DesktopCoworkActionEvent): Promise<void> {
  const sessionId = event.sessionId || nativeCoworkSelectedSessionId;
  let outcome: "complete" | "blocked" | "failed" = "complete";
  let errorMessage = "";
  logDesktopNativeDebug("cowork.action.start", summarizeCoworkAction(event, sessionId));
  try {
    if (event.action === "validateBlueprint") {
      const blueprint = parseNativeCoworkBlueprint(event.blueprintText ?? "");
      const request = buildDesktopCoworkActionRequest({
        action: "validateBlueprint",
        blueprint,
        preview: event.preview,
      });
      const payload = await gatewayApi.cowork.validateBlueprint(requestBody(request), { preview: event.preview });
      const previewGraph = event.preview ? asRecord(payload).graph_preview : null;
      const cockpitView = previewGraph && event.pane.cockpitView
        ? buildDesktopCoworkCockpitView({
            ...asRecord(event.pane.cockpitView.raw),
            graph: previewGraph,
          })
        : event.pane.cockpitView;
      setNativeCoworkPane({
        ...event.pane,
        cockpitView,
        actionStatus: event.preview ? "Cowork blueprint preview loaded." : "Cowork blueprint validated.",
        blueprintDiagnostics: formatNativeCoworkBlueprintDiagnostics(payload),
      });
      return;
    }
    if (event.action === "createSession") {
      const request = buildDesktopCoworkActionRequest({
        action: "createSession",
        goal: event.goal,
        autoRun: true,
      });
      const created = await gatewayApi.cowork.create(requestBody(request));
      const selectedSessionId = extractCoworkSessionId(created);
      setNativeCoworkPane(await loadNativeCoworkPane({
        selectedSessionId,
        actionStatus: "Cowork session created.",
      }));
      return;
    }
    if (!sessionId) {
      outcome = "blocked";
      setNativeCoworkPane({
        ...event.pane,
        actionStatus: "Select a Cowork session before running this action.",
      });
      return;
    }
    if (event.action === "runSession") {
      const request = buildDesktopCoworkActionRequest({ action: "runSession", sessionId });
      await gatewayApi.cowork.run(sessionId, requestBody(request));
      setNativeCoworkPane(await loadNativeCoworkPane({ selectedSessionId: sessionId, actionStatus: "Cowork run started." }));
      return;
    }
    if (event.action === "pauseSession" || event.action === "resumeSession" || event.action === "emergencyStopSession") {
      const apiAction = event.action === "emergencyStopSession"
        ? "emergency-stop"
        : event.action === "pauseSession"
          ? "pause"
          : "resume";
      await gatewayApi.cowork.action(sessionId, apiAction);
      setNativeCoworkPane(await loadNativeCoworkPane({ selectedSessionId: sessionId, actionStatus: `Cowork ${apiAction} requested.` }));
      return;
    }
    if (event.action === "deleteSession") {
      await gatewayApi.cowork.delete(sessionId);
      nativeCoworkSelectedSessionId = "";
      setNativeCoworkPane(await loadNativeCoworkPane({
        selectedSessionId: null,
        actionStatus: "Cowork session deleted.",
      }));
      return;
    }
    if (event.action === "sendMessage") {
      await gatewayApi.cowork.message(sessionId, {
        content: event.message ?? "",
        recipient_ids: [],
      });
      setNativeCoworkPane(await loadNativeCoworkPane({ selectedSessionId: sessionId, actionStatus: "Cowork message sent." }));
      return;
    }
    if (event.action === "loadSummary") {
      const summaryPayload = await gatewayApi.cowork.summary(sessionId);
      setNativeCoworkPane(await loadNativeCoworkPane({
        selectedSessionId: sessionId,
        actionStatus: "Cowork summary loaded.",
        summaryText: extractCoworkSummary(summaryPayload),
      }));
      return;
    }
    if (event.action === "addTask") {
      const request = buildDesktopCoworkActionRequest({
        action: "addTask",
        sessionId,
        title: event.taskTitle ?? "",
        assignedAgentId: event.assignedAgentId ?? "",
      });
      await gatewayApi.cowork.addTask(sessionId, requestBody(request));
      setNativeCoworkPane(await loadNativeCoworkPane({ selectedSessionId: sessionId, actionStatus: "Cowork task added." }));
      return;
    }
    if (event.action === "task" && event.taskId && event.taskAction) {
      const request = buildDesktopCoworkActionRequest({
        action: "task",
        sessionId,
        taskId: event.taskId,
        taskAction: event.taskAction,
        assignedAgentId: event.assignedAgentId,
      });
      await gatewayApi.cowork.taskAction(sessionId, event.taskId, event.taskAction, requestBody(request));
      setNativeCoworkPane(await loadNativeCoworkPane({ selectedSessionId: sessionId, actionStatus: `Cowork task ${event.taskAction} requested.` }));
      return;
    }
    if (event.action === "workUnit" && event.workUnitId && event.workUnitAction) {
      const request = buildDesktopCoworkActionRequest({
        action: "workUnit",
        sessionId,
        workUnitId: event.workUnitId,
        workUnitAction: event.workUnitAction,
        reason: `${event.workUnitAction} from desktop`,
      });
      await gatewayApi.cowork.workUnitAction(sessionId, event.workUnitId, event.workUnitAction, requestBody(request));
      setNativeCoworkPane(await loadNativeCoworkPane({ selectedSessionId: sessionId, actionStatus: `Cowork work unit ${event.workUnitAction} requested.` }));
      return;
    }
    if (event.action === "selectBranch" && event.branchId) {
      await gatewayApi.cowork.selectBranch(sessionId, event.branchId);
      setNativeCoworkPane(await loadNativeCoworkPane({ selectedSessionId: sessionId, actionStatus: "Cowork branch selected." }));
      return;
    }
    if (event.action === "selectBranchResult" && event.branchId && event.resultId) {
      const request = buildDesktopCoworkActionRequest({
        action: "selectBranchResult",
        sessionId,
        branchId: event.branchId,
        resultId: event.resultId,
      });
      await gatewayApi.cowork.selectBranchResult(sessionId, event.branchId, requestBody(request));
      setNativeCoworkPane(await loadNativeCoworkPane({ selectedSessionId: sessionId, actionStatus: "Cowork final branch result selected." }));
      return;
    }
    if (event.action === "mergeBranchResults") {
      const branchIds = event.branchIds ?? [];
      if (branchIds.length < 2) {
        outcome = "blocked";
        setNativeCoworkPane({
          ...event.pane,
          actionStatus: "Select at least two Cowork branch results before merging.",
        });
        return;
      }
      const request = buildDesktopCoworkActionRequest({
        action: "mergeBranchResults",
        sessionId,
        branchIds,
      });
      await gatewayApi.cowork.mergeBranchResults(sessionId, requestBody(request));
      setNativeCoworkPane(await loadNativeCoworkPane({ selectedSessionId: sessionId, actionStatus: "Cowork branch results merged." }));
    }
  } catch (error) {
    outcome = "failed";
    errorMessage = stringifyError(error);
    setNativeCoworkPane({
      ...event.pane,
      actionStatus: `Cowork ${event.action} failed: ${errorMessage}`,
    });
  } finally {
    logDesktopNativeDebug(`cowork.action.${outcome}`, {
      ...summarizeCoworkAction(event, sessionId),
      ...(errorMessage ? { error: errorMessage } : {}),
    });
  }
}

function setNativeCoworkPane(pane: DesktopCoworkPaneModel): void {
  nativeCoworkPane = pane;
  updateDesktopCoworkPane(document, pane, {
    onCoworkAction: (event) => {
      void handleNativeCoworkAction(event);
    },
  });
  publishNativeTaskCenterItems();
}

function requestBody(request: ReturnType<typeof buildDesktopCoworkActionRequest>): Record<string, unknown> {
  return "body" in request ? request.body ?? {} : {};
}

function parseNativeCoworkBlueprint(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Blueprint JSON is required.");
  }
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`Blueprint JSON is invalid: ${stringifyError(error)}`);
  }
}

function formatNativeCoworkBlueprintDiagnostics(payload: unknown): string {
  const record = asRecord(payload);
  const diagnostics = asArrayValue(record.diagnostics).map(asRecord);
  const errors = diagnostics.filter((item) => stringValue(item.severity) === "error").length;
  const warnings = diagnostics.filter((item) => stringValue(item.severity) === "warning").length;
  if (record.ok === true) {
    return `Valid${warnings ? ` / ${warnings} warning(s)` : ""}`;
  }
  const firstMessage = stringValue(diagnostics[0]?.message) || stringValue(record.error);
  return `${errors || diagnostics.length || 1} error(s)${firstMessage ? `: ${firstMessage}` : ""}`;
}

function extractCoworkSessionId(payload: unknown): string | null {
  const record = asRecord(payload);
  const direct = stringValue(record.id) || stringValue(record.session_id);
  if (direct) {
    return direct;
  }
  const session = asRecord(record.session);
  return stringValue(session.id) || null;
}

function extractCoworkSummary(payload: unknown): string {
  const record = asRecord(payload);
  return stringValue(record.summary) || stringValue(record.text) || JSON.stringify(record, null, 2);
}

async function handleNativeKnowledgeAction(event: DesktopKnowledgeActionEvent): Promise<void> {
  let outcome: "complete" | "failed" | "ignored" = "complete";
  let errorMessage = "";
  logDesktopNativeDebug("knowledge.action.start", summarizeKnowledgeAction(event));
  try {
    if (event.action === "uploadDocument") {
      document.getElementById("desktop-knowledge-upload")?.click();
      return;
    }
    if (event.action === "runQuery" && event.pane.actions.query) {
      const result = await gatewayApi.knowledge.query(event.pane.query.request);
      const pane = await loadNativeKnowledgePane({
        queryResultPayload: result,
        selectedDocumentId: event.pane.selectedDocument?.id,
      });
      setNativeKnowledgePane(pane);
      return;
    }
    if (event.action === "refreshGraph") {
      const pane = await loadNativeKnowledgePane({
        queryResultPayload: nativeKnowledgeQueryResult,
        selectedDocumentId: event.pane.selectedDocument?.id,
      });
      setNativeKnowledgePane(pane);
      return;
    }
    if (event.action === "rebuildIndex") {
      const result = await gatewayApi.knowledge.rebuildIndex("all");
      const operation = buildDesktopKnowledgeTaskOperation(result);
      if (operation) {
        updateNativeKnowledgeTask(operation);
      }
      const pane = await loadNativeKnowledgePane({
        queryResultPayload: nativeKnowledgeQueryResult,
        selectedDocumentId: event.pane.selectedDocument?.id,
      });
      setNativeKnowledgePane(pane);
      return;
    }
    if (event.action === "deleteDocument" && event.pane.selectedDocument) {
      await gatewayApi.knowledge.deleteDocument(event.pane.selectedDocument.id);
      const pane = await loadNativeKnowledgePane({ queryResultPayload: nativeKnowledgeQueryResult });
      setNativeKnowledgePane(pane);
      return;
    }
    outcome = "ignored";
  } catch (error) {
    outcome = "failed";
    errorMessage = stringifyError(error);
    updateNativeKnowledgeTask({
      id: `knowledge:action:${event.action}`,
      title: `Knowledge ${event.action}`,
      status: "failed",
      detail: "Knowledge action failed",
      canonical: { module: "knowledge", entityId: event.pane.selectedDocument?.id, href: "/knowledge" },
      diagnostics: errorMessage,
      retryable: true,
      updatedAt: new Date().toISOString(),
    });
  } finally {
    logDesktopNativeDebug(`knowledge.action.${outcome}`, {
      ...summarizeKnowledgeAction(event),
      ...(errorMessage ? { error: errorMessage } : {}),
    });
  }
}

function setNativeKnowledgePane(pane: DesktopKnowledgePaneModel): void {
  nativeKnowledgePane = pane;
  updateDesktopKnowledgePane(document, pane, {
    onKnowledgeAction: (event) => {
      void handleNativeKnowledgeAction(event);
    },
  });
}

function mergeNativeKnowledgeGraphPayload(graphPayload: unknown, graphragPayload: unknown): unknown {
  const graph = asRecord(graphPayload);
  const graphrag = asRecord(graphragPayload);
  if (graphrag.object === "graphrag_index") {
    return graphrag;
  }
  return {
    ...graph,
    communities: asArrayValue(graph.communities).length ? graph.communities : graphrag.communities,
    reports: asArrayValue(graph.reports).length ? graph.reports : graphrag.community_reports,
    claims: asArrayValue(graph.claims).length ? graph.claims : graphrag.covariates,
    conflicts: asArrayValue(graph.conflicts).length ? graph.conflicts : graphrag.conflicts,
  };
}

async function loadNativeToolsSkillsPane(
  selectedSkillName?: string,
  selectedSkillDetail?: unknown,
): Promise<DesktopToolsSkillsPaneModel> {
  logDesktopNativeDebug("toolsSkills.load.start", {
    selectedSkillName: selectedSkillName ?? "",
  });
  const [tools, skills, config] = await Promise.all([
    gatewayApi.tools.list(),
    gatewayApi.skills.list(),
    gatewayApi.config.get(),
  ]);
  nativeToolsPayload = tools;
  nativeSkillsPayload = skills;
  nativeToolsSkillsConfig = config;
  const firstSkill = selectedSkillName || buildDesktopSkillRows(skills, config)[0]?.name;
  const detail = selectedSkillDetail ?? (firstSkill ? await gatewayApi.skills.detail(firstSkill).catch(() => null) : null);
  nativeToolsSkillsPane = buildDesktopToolsSkillsPaneModel({
    toolsPayload: tools,
    skillsPayload: skills,
    config,
    selectedSkillName: firstSkill,
    selectedSkillDetail: detail,
  });
  logDesktopNativeDebug("toolsSkills.load.complete", {
    selectedSkillName: nativeToolsSkillsPane.selectedSkill?.name ?? "",
    skillCount: nativeToolsSkillsPane.skillRows.length,
    toolCount: nativeToolsSkillsPane.toolRows.length,
  });
  return nativeToolsSkillsPane;
}

async function handleNativeToolsSkillsAction(event: DesktopToolsSkillsActionEvent): Promise<void> {
  const skill = event.pane.selectedSkill;
  let outcome: "complete" | "failed" | "ignored" = "complete";
  let errorMessage = "";
  logDesktopNativeDebug("toolsSkills.action.start", summarizeToolsSkillsAction(event));
  try {
  if (event.action === "createSkill") {
    setNativeToolsSkillsPane(buildDesktopToolsSkillsPaneModel({
      toolsPayload: nativeToolsPayload,
      skillsPayload: nativeSkillsPayload,
      config: nativeToolsSkillsConfig,
      skillEditor: { mode: "create" },
    }));
    return;
  }
  if (event.action === "editSkill" && skill && event.field) {
    setNativeToolsSkillsPane(updateDesktopSkillEditorDraft(event.pane, event.field, event.value ?? ""));
    return;
  }
  if (!skill) {
    outcome = "ignored";
    return;
  }
  const draft = skill.editor.draft;
    if (event.action === "validateSkill") {
      const result = await gatewayApi.skills.validate(skill.name);
      setNativeToolsSkillsPane(buildNativeToolsSkillsPaneFromEditor(skill, {
        validation: desktopSkillValidationFromPayload(result),
      }));
      return;
    } else if (event.action === "deleteSkill" && skill.deletable) {
      await gatewayApi.skills.delete(skill.name);
      await refreshNativeToolsSkillsPane();
      return;
    } else if (event.action === "saveSkill") {
      setNativeToolsSkillsPane(buildNativeToolsSkillsPaneFromEditor(skill, { saveStatus: "saving" }));
      if (skill.editor.mode === "create") {
        await gatewayApi.skills.create({
          name: draft.name,
          description: draft.description,
          content: draft.content,
          always: draft.always,
        });
        await refreshNativeToolsSkillsPane(draft.name);
        return;
      }
      await gatewayApi.skills.update(skill.name, {
        description: draft.description,
        content: draft.content,
        always: draft.always,
      });
      await refreshNativeToolsSkillsPane(skill.name);
      return;
    } else if (event.action === "toggleAlways") {
      await gatewayApi.skills.update(skill.name, {
        description: draft.description,
        content: draft.content,
        always: !draft.always,
      });
      await refreshNativeToolsSkillsPane(skill.name);
      return;
    }
    outcome = "ignored";
  } catch (error) {
    outcome = "failed";
    errorMessage = stringifyError(error);
    if (skill) {
      setNativeToolsSkillsPane(buildNativeToolsSkillsPaneFromEditor(skill, {
        saveStatus: "failed",
        saveError: `Skill action failed: ${errorMessage}`,
      }));
    }
  } finally {
    logDesktopNativeDebug(`toolsSkills.action.${outcome}`, {
      ...summarizeToolsSkillsAction(event),
      ...(errorMessage ? { error: errorMessage } : {}),
    });
  }
}

async function refreshNativeToolsSkillsPane(selectedSkillName?: string): Promise<void> {
  const pane = await loadNativeToolsSkillsPane(selectedSkillName);
  setNativeToolsSkillsPane(pane);
}

function setNativeToolsSkillsPane(pane: DesktopToolsSkillsPaneModel): void {
  nativeToolsSkillsPane = pane;
  updateDesktopToolsSkillsPane(document, pane, {
    onToolsSkillsAction: (event) => {
      void handleNativeToolsSkillsAction(event);
    },
  });
}

function buildNativeToolsSkillsPaneFromEditor(
  skill: NonNullable<DesktopToolsSkillsPaneModel["selectedSkill"]>,
  editor: NonNullable<Parameters<typeof buildDesktopToolsSkillsPaneModel>[0]>["skillEditor"],
): DesktopToolsSkillsPaneModel {
  return buildDesktopToolsSkillsPaneModel({
    toolsPayload: nativeToolsPayload,
    skillsPayload: nativeSkillsPayload,
    config: nativeToolsSkillsConfig,
    selectedSkillName: skill.editor.mode === "create" ? null : skill.name,
    selectedSkillDetail: {
      name: skill.editor.draft.name,
      content: skill.editor.draft.content,
      tinybot_meta: {
        description: skill.editor.draft.description,
        always: skill.editor.draft.always,
      },
    },
    skillEditor: {
      mode: skill.editor.mode,
      draft: skill.editor.draft,
      lastSaved: skill.editor.lastSaved,
      ...editor,
    },
  });
}

function desktopSkillValidationFromPayload(payload: unknown): { state: "valid" | "invalid"; message: string } {
  const result = asRecord(payload);
  const valid = result.valid === true;
  return {
    state: valid ? "valid" : "invalid",
    message: stringValue(result.message) || (valid ? "Skill valid" : "Skill invalid"),
  };
}

async function loadNativeSettingsPane(): Promise<DesktopSettingsPaneModel> {
  try {
    const [config, providersPayload] = await Promise.all([
      gatewayApi.config.get(),
      gatewayApi.config.providers(),
    ]);
    const providerCatalog = buildDesktopProviderCatalogItems(providersPayload);
    const state = buildDesktopSettingsFormState(config, providerCatalog);
    nativeSettingsConfig = config;
    nativeSettingsState = state;
    nativeSettingsLastSavedState = state;
    nativeSettingsProviderCatalog = providerCatalog;
    return buildDesktopSettingsPaneModel(state, {
      lastSavedState: state,
      providerCatalog,
      saveStatus: "idle",
    });
  } catch (error) {
    const fallbackState = buildDesktopSettingsFormState({});
    nativeSettingsConfig = {};
    nativeSettingsState = fallbackState;
    nativeSettingsLastSavedState = fallbackState;
    nativeSettingsProviderCatalog = [];
    return buildDesktopSettingsPaneModel(fallbackState, {
      lastSavedState: fallbackState,
      saveStatus: "failed",
      saveError: `Failed to load settings: ${stringifyError(error)}`,
    });
  }
}

async function handleNativeSettingsAction(event: DesktopSettingsActionEvent): Promise<void> {
  if (!nativeSettingsState) {
    logDesktopNativeDebug("settings.action.skipped", { action: event.action, reason: "state unavailable" });
    return;
  }
  logDesktopNativeDebug("settings.action.start", {
    action: event.action,
    fieldId: "fieldId" in event ? event.fieldId : undefined,
  });
  if (event.action === "edit") {
    nativeSettingsState = applyDesktopSettingsFieldEdit(nativeSettingsState, event.fieldId, event.value);
    updateNativeSettingsPane("idle");
    logDesktopNativeDebug("settings.action.complete", { action: event.action, fieldId: event.fieldId });
    return;
  }
  if (event.action === "save") {
    await saveNativeSettingsPane();
    return;
  }
  await refreshNativeProviderModels();
}

async function saveNativeSettingsPane(): Promise<void> {
  if (!nativeSettingsState) {
    logDesktopNativeDebug("settings.save.skipped", { reason: "state unavailable" });
    return;
  }
  logDesktopNativeDebug("settings.save.start");
  updateNativeSettingsPane("saving");
  try {
    const patch = createDesktopSettingsPatch(
      nativeSettingsState,
      nativeSettingsConfig,
      nativeSettingsProviderCatalog,
    );
    nativeSettingsConfig = await gatewayApi.config.patch(patch);
    nativeSettingsState = buildDesktopSettingsFormState(nativeSettingsConfig, nativeSettingsProviderCatalog);
    nativeSettingsLastSavedState = nativeSettingsState;
    updateNativeSettingsPane("saved");
    logDesktopNativeDebug("settings.save.complete");
  } catch (error) {
    const message = stringifyError(error);
    updateNativeSettingsPane("failed", `Failed to save settings: ${message}`);
    logDesktopNativeDebug("settings.save.failed", { error: message });
  }
}

async function refreshNativeProviderModels(): Promise<void> {
  if (!nativeSettingsState) {
    logDesktopNativeDebug("settings.providerModels.skipped", { reason: "state unavailable" });
    return;
  }
  const request = buildDesktopProviderModelRequest(nativeSettingsState);
  logDesktopNativeDebug("settings.providerModels.start", {
    profile: request.profile,
    provider: request.provider,
  });
  updateNativeProviderTask(buildDesktopProviderModelDiscoveryTaskOperation({
    provider: request.provider,
    profile: request.profile,
    status: "refreshing",
  }));
  try {
    const result = await gatewayApi.config.providerModels(request);
    const applied = applyDesktopProviderModels(nativeSettingsState, result);
    nativeSettingsState = applied.state;
    updateNativeSettingsPane("idle");
    updateNativeProviderTask(buildDesktopProviderModelDiscoveryTaskOperation({
      provider: request.provider,
      profile: request.profile,
      status: applied.status === "failed" ? "failed" : "completed",
      models: applied.models,
      error: applied.status === "failed" ? applied.message : "",
    }));
    logDesktopNativeDebug("settings.providerModels.complete", {
      modelCount: applied.models.length,
      profile: request.profile,
      provider: request.provider,
      status: applied.status,
    });
  } catch (error) {
    const message = stringifyError(error);
    updateNativeSettingsPane("failed", `Failed to refresh provider models: ${message}`);
    updateNativeProviderTask(buildDesktopProviderModelDiscoveryTaskOperation({
      provider: request.provider,
      profile: request.profile,
      status: "failed",
      error: message,
    }));
    logDesktopNativeDebug("settings.providerModels.failed", {
      error: message,
      profile: request.profile,
      provider: request.provider,
    });
  }
}

function updateNativeSettingsPane(
  saveStatus: "idle" | "saving" | "saved" | "failed",
  saveError?: string,
): void {
  if (!nativeSettingsState) {
    return;
  }
  updateDesktopSettingsPane(document, buildDesktopSettingsPaneModel(nativeSettingsState, {
    lastSavedState: nativeSettingsLastSavedState,
    providerCatalog: nativeSettingsProviderCatalog,
    saveStatus,
    saveError,
  }), {
    onSettingsAction: (event) => {
      void handleNativeSettingsAction(event);
    },
  });
  syncNativeRuntimeMetadata();
}

function installNativeCommandPalette(): void {
  installDesktopCommandPalette({
    gatewayOrigin: gatewayConfig.httpBaseUrl,
    desktopCommands: buildNativeWorkbenchDesktopCommands(),
    loadData: loadNativeCommandPaletteData,
  });
}

function buildRootWebUiDesktopCommands(): ReturnType<typeof buildDesktopCommandEntriesFromSidebar> {
  return buildDesktopCommandEntriesFromSidebar(buildRootWebUiSidebarModel());
}

function buildNativeWorkbenchDesktopCommands(): ReturnType<typeof buildDesktopCommandEntriesFromSidebar> {
  return buildDesktopCommandEntriesFromSidebar(buildNativeWorkbenchSidebarModel());
}

async function loadRootWebUiCommandPaletteData(): Promise<DesktopCommandPaletteInput> {
  return {
    ...await loadNativeCommandPaletteData(),
    desktopCommands: buildRootWebUiDesktopCommands(),
  };
}

async function loadNativeCommandPaletteData(): Promise<DesktopCommandPaletteInput> {
  const [sessions, workspaceFiles, knowledgeDocuments, config, tools, skills, coworkSessions] = await Promise.all([
    gatewayApi.sessions.list(),
    gatewayApi.workspace.files(),
    gatewayApi.knowledge.documents(),
    gatewayApi.config.get(),
    gatewayApi.tools.list(),
    gatewayApi.skills.list(),
    gatewayApi.cowork.sessions(),
  ]);
  replaceNativeCoworkTasks(coworkSessions);
  return {
    desktopCommands: buildNativeWorkbenchDesktopCommands(),
    sessions: { loaded: true, rows: normalizeSessionsPayload(sessions) },
    workspaceFiles: { loaded: true, rows: buildDesktopWorkspaceFileRows(workspaceFiles) },
    knowledgeDocuments: { loaded: true, rows: buildDesktopKnowledgeDocumentRows(knowledgeDocuments) },
    tools: { loaded: true, rows: buildDesktopToolRows(tools, config) },
    skills: { loaded: true, rows: buildDesktopSkillRows(skills, config) },
    coworkSessions: { loaded: true, rows: buildDesktopCoworkSessionRows(coworkSessions) },
  };
}

function installNativeWorkspaceFileActions(): void {
  installDesktopWorkspaceFileActions({
    listWorkspaceFiles: () => gatewayApi.workspace.files(),
    loadWorkspaceFile: (path) => gatewayApi.workspace.file(path),
    saveWorkspaceFile: (path, body) => gatewayApi.workspace.putFile(path, body),
    revealWorkspaceFile: (path) => invoke("reveal_workspace_file", { path }),
    exportWorkspaceFile: (options) => invoke("save_export_file", { options }),
    onFileTaskUpdated: updateNativeFileTask,
  });
}

function installNativeFileUploadActions(): void {
  installDesktopFileUploadActions({
    pickFile: (kind: DesktopUploadKind) =>
      invoke<DesktopPickedUploadFile | null>("pick_upload_file", {
        options: desktopUploadPickerOptions(kind),
    }),
    uploadKnowledgeDocument: (form) => gatewayApi.knowledge.uploadDocument(form),
    onKnowledgeTaskUpdated: updateNativeKnowledgeTask,
    uploadSessionTemporaryFile: (sessionKey, form) => gatewayApi.sessions.uploadTemporaryFile(sessionKey, form),
    listSessionTemporaryFiles: (sessionKey) => gatewayApi.sessions.temporaryFiles(sessionKey),
    getSessionKey: () => nativeWorkbenchRuntime?.chat.activeSessionKey ?? "",
    uploadWorkspaceFile: (path, body) => gatewayApi.workspace.putFile(path, body),
  });
}

function installRootWebUiDesktopAdapters(): void {
  if (!hasTauriRuntime()) {
    return;
  }
  installDesktopWebUiCommandBridge({
    listenToMenuCommand: (handler) =>
      listen<{ id: string }>("desktop-menu-command", (event) => {
        handler(event.payload.id);
      }),
  });
  installDesktopWebUiFilePickerBridge({
    pickFile: (kind: DesktopUploadKind) =>
      invoke<DesktopPickedUploadFile | null>("pick_upload_file", {
        options: desktopUploadPickerOptions(kind),
      }),
  });
  installDesktopWebUiNotificationBridge({
    isFocused: () => document.hasFocus(),
    canNotify: nativeOsNotifications.canNotify,
    notify: nativeOsNotifications.notify,
  });
}

function updateNativeKnowledgeTask(operation: DesktopTaskSourceOperation): void {
  nativeKnowledgeTaskOperations.set(operation.id, operation);
  logDesktopNativeDebug("task.operation.update", summarizeTaskOperation("knowledge", operation));
  publishNativeTaskCenterItems();
}

function updateNativeFileTask(operation: DesktopTaskSourceOperation): void {
  nativeFileTaskOperations.set(operation.id, operation);
  logDesktopNativeDebug("task.operation.update", summarizeTaskOperation("files", operation));
  publishNativeTaskCenterItems();
}

function updateNativeProviderTask(operation: DesktopTaskSourceOperation): void {
  nativeProviderTaskOperations.set(operation.id, operation);
  logDesktopNativeDebug("task.operation.update", summarizeTaskOperation("providers", operation));
  publishNativeTaskCenterItems();
}

function updateNativeGatewayTask(operation: DesktopTaskSourceOperation): void {
  nativeGatewayTaskOperations.set(operation.id, operation);
  logDesktopNativeDebug("task.operation.update", summarizeTaskOperation("gateway", operation));
  publishNativeTaskCenterItems();
}

async function handleNativeGatewayRuntimeAction(event: DesktopGatewayRuntimeActionEvent): Promise<void> {
  logDesktopNativeDebug("gatewayRuntime.action.start", {
    action: event.action,
    currentState: event.status?.state ?? nativeRuntimeStatus?.state ?? "",
  });
  try {
    const nextStatus = await runDesktopGatewayRuntimeCommand(event.action, event.status, {
      runCommand: (command, payload) => invokeGatewayRuntimeCommand(command, payload),
    });
    if (!nextStatus) {
      return;
    }
    nativeRuntimeStatus = nextStatus;
    updateDesktopGatewayRuntimeStatus(document, nextStatus, gatewayConfig.httpBaseUrl, {
      onGatewayRuntimeAction: (nextEvent) => {
        void handleNativeGatewayRuntimeAction(nextEvent);
      },
    });
    setDesktopWindowRuntimeStatus(nextStatus);
    updateNativeGatewayTask(buildDesktopGatewayTaskOperation(gatewayTaskActionForRuntimeAction(event.action), nextStatus));
    logDesktopNativeDebug("gatewayRuntime.action.complete", {
      action: event.action,
      nextState: nextStatus.state,
    });
  } catch (error) {
    const message = stringifyError(error);
    const failedStatus = failedGatewayRuntimeStatus(event.status ?? nativeRuntimeStatus, message);
    nativeRuntimeStatus = failedStatus;
    updateDesktopGatewayRuntimeStatus(document, failedStatus, gatewayConfig.httpBaseUrl, {
      onGatewayRuntimeAction: (nextEvent) => {
        void handleNativeGatewayRuntimeAction(nextEvent);
      },
    });
    setDesktopWindowRuntimeStatus(failedStatus);
    updateNativeGatewayTask(buildDesktopGatewayTaskOperation(gatewayTaskActionForRuntimeAction(event.action), failedStatus));
    logDesktopNativeDebug("gatewayRuntime.action.failed", {
      action: event.action,
      error: message,
    });
  }
}

function invokeGatewayRuntimeCommand(
  command: DesktopGatewayRuntimeCommand,
  payload?: DesktopGatewayRuntimeCommandPayload,
): Promise<GatewayRuntimeStatus> {
  return invoke<GatewayRuntimeStatus>(command, payload);
}

function gatewayTaskActionForRuntimeAction(action: DesktopGatewayRuntimeActionEvent["action"]): "startup" | "restart" | "stop" {
  if (action === "restart") {
    return "restart";
  }
  if (action === "stop") {
    return "stop";
  }
  return "startup";
}

function failedGatewayRuntimeStatus(
  previousStatus: GatewayRuntimeStatus | null,
  message: string,
): GatewayRuntimeStatus {
  return {
    state: "offline",
    owner: previousStatus?.owner ?? "none",
    http_ok: false,
    gateway_http: previousStatus?.gateway_http ?? gatewayConfig.httpBaseUrl,
    gateway_ws: previousStatus?.gateway_ws ?? gatewayConfig.wsUrl,
    command: previousStatus?.command ?? "uv run tinybot gateway",
    port: previousStatus?.port ?? 18790,
    repo_root: previousStatus?.repo_root ?? "",
    logs: [...(previousStatus?.logs ?? []), `error: ${message}`].slice(-12),
    last_error: message,
    exit_policy: previousStatus?.exit_policy ?? "stop_on_exit",
  };
}

async function refreshNativeApprovalTasks(): Promise<void> {
  logDesktopNativeDebug("approvals.refresh.start");
  try {
    const payload = await gatewayApi.tools.approvals();
    nativeApprovalTaskOperations.clear();
    for (const operation of buildDesktopApprovalTaskOperations(payload)) {
      nativeApprovalTaskOperations.set(operation.id, operation);
    }
    publishNativeTaskCenterItems();
    logDesktopNativeDebug("approvals.refresh.complete", {
      count: nativeApprovalTaskOperations.size,
    });
  } catch (error) {
    nativeApprovalTaskOperations.set("approval:load", {
      id: "approval:load",
      title: "Load pending approvals",
      status: "failed",
      detail: "Pending approvals unavailable",
      canonical: { module: "approvals", href: "/chat" },
      diagnostics: stringifyError(error),
      retryable: true,
      updatedAt: new Date().toISOString(),
    });
    publishNativeTaskCenterItems();
    logDesktopNativeDebug("approvals.refresh.failed", {
      error: stringifyError(error),
    });
  }
}

async function refreshNativeCoworkTasks(): Promise<void> {
  logDesktopNativeDebug("cowork.tasks.refresh.start");
  try {
    const payload = await gatewayApi.cowork.sessions({ includeCompleted: true });
    replaceNativeCoworkTasks(payload);
    logDesktopNativeDebug("cowork.tasks.refresh.complete", {
      count: nativeCoworkTaskOperations.size,
    });
  } catch (error) {
    updateNativeCoworkTask({
      id: "cowork:load",
      title: "Load Cowork task state",
      status: "failed",
      detail: "Cowork sessions unavailable",
      canonical: { module: "cowork", href: "/cowork" },
      diagnostics: stringifyError(error),
      retryable: true,
      updatedAt: new Date().toISOString(),
    });
    logDesktopNativeDebug("cowork.tasks.refresh.failed", {
      error: stringifyError(error),
    });
  }
}

function replaceNativeCoworkTasks(payload: unknown): void {
  nativeCoworkTaskOperations.clear();
  for (const operation of buildDesktopCoworkTaskOperations(payload)) {
    nativeCoworkTaskOperations.set(operation.id, operation);
  }
  logDesktopNativeDebug("task.operations.replace", {
    count: nativeCoworkTaskOperations.size,
    source: "cowork",
  });
  publishNativeTaskCenterItems();
}

function updateNativeCoworkTask(operation: DesktopTaskSourceOperation): void {
  nativeCoworkTaskOperations.set(operation.id, operation);
  logDesktopNativeDebug("task.operation.update", summarizeTaskOperation("cowork", operation));
  publishNativeTaskCenterItems();
}

function currentNativeTaskCenterItems() {
  return buildDesktopTaskCenterItems({
    knowledgeJobs: Array.from(nativeKnowledgeTaskOperations.values()),
    coworkRuns: Array.from(nativeCoworkTaskOperations.values()),
    providerRefreshes: Array.from(nativeProviderTaskOperations.values()),
    fileOperations: Array.from(nativeFileTaskOperations.values()),
    gatewayOperations: Array.from(nativeGatewayTaskOperations.values()),
    approvals: [
      ...Array.from(nativeApprovalTaskOperations.values()),
      ...(nativeWorkbenchRuntime?.approvalOperations ?? []),
    ],
  });
}

function publishNativeTaskCenterItems(): void {
  const items = currentNativeTaskCenterItems();
  updateDesktopTaskCenterItems(document, items, nativeTaskActions());
  void nativeTaskNotifications.update(items);
}

function hasTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

function installTauriMenuCommandRouting(): void {
  if (!hasTauriRuntime()) {
    return;
  }
  installDesktopMenuCommandRouting({
    gatewayOrigin: gatewayConfig.httpBaseUrl,
    listenToMenuCommand: (handler) =>
      listen<{ id: string }>("desktop-menu-command", (event) => {
        handler(event.payload.id);
      }),
    openExternal: (href) => openUrl(href),
  });
}

function installTauriNavigation(): void {
  if (!hasTauriRuntime()) {
    return;
  }
  installDesktopNavigation({
    gatewayOrigin: gatewayConfig.httpBaseUrl,
    openExternal: (href) => openUrl(href),
  });
}

function installTauriWindowFrame(runtimeStatus?: GatewayRuntimeStatus | null): void {
  if (!hasTauriRuntime()) {
    return;
  }
  installDesktopWindowFrame({ currentWindow: getCurrentWindow(), defaultWindowIcon });
  if (runtimeStatus !== undefined) {
    setDesktopWindowRuntimeStatus(runtimeStatus);
  }
}

function summarizeTaskCenterAction(event: DesktopTaskCenterActionEvent): Record<string, unknown> {
  return {
    action: event.action,
    destinationEntityId: event.item.destination.entityId ?? "",
    destinationModule: event.item.destination.module,
    itemId: event.item.id,
    source: event.item.source,
    state: event.item.state,
    status: event.item.status,
  };
}

function summarizeAgentUiFormAction(event: DesktopAgentUiFormActionEvent): Record<string, unknown> {
  return {
    action: event.action,
    fieldCount: Object.keys(event.values ?? {}).length,
    formId: event.form.form_id,
    title: event.form.title ?? "",
  };
}

function summarizeCoworkAction(
  event: DesktopCoworkActionEvent,
  sessionId: string,
): Record<string, unknown> {
  return {
    action: event.action,
    assignedAgentId: event.assignedAgentId ?? "",
    blueprintLength: event.blueprintText?.length ?? 0,
    branchCount: event.branchIds?.length ?? 0,
    branchId: event.branchId ?? "",
    goalLength: event.goal?.length ?? 0,
    messageLength: event.message?.length ?? 0,
    preview: event.preview === true,
    resultId: event.resultId ?? "",
    sessionId,
    taskAction: event.taskAction ?? "",
    taskId: event.taskId ?? "",
    taskTitleLength: event.taskTitle?.length ?? 0,
    workUnitAction: event.workUnitAction ?? "",
    workUnitId: event.workUnitId ?? "",
  };
}

function summarizeKnowledgeAction(event: DesktopKnowledgeActionEvent): Record<string, unknown> {
  return {
    action: event.action,
    queryLength: event.pane.query.draft.query.length,
    resultCount: event.pane.query.results.rows.length,
    selectedDocumentId: event.pane.selectedDocument?.id ?? "",
  };
}

function summarizeToolsSkillsAction(event: DesktopToolsSkillsActionEvent): Record<string, unknown> {
  return {
    action: event.action,
    field: event.field ?? "",
    selectedSkillName: event.pane.selectedSkill?.name ?? "",
    selectedToolName: event.pane.selectedTool?.name ?? "",
    valueKind: typeof event.value,
    valueLength: typeof event.value === "string" ? event.value.length : 0,
  };
}

function summarizeTaskOperation(source: string, operation: DesktopTaskSourceOperation): Record<string, unknown> {
  return {
    destinationEntityId: operation.canonical.entityId ?? "",
    destinationModule: operation.canonical.module,
    id: operation.id,
    progressPercent: operation.progress?.percent,
    retryable: operation.retryable === true,
    source,
    status: operation.status,
    title: operation.title,
  };
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}
