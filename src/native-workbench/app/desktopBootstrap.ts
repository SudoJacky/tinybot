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
} from "../agent-ui/agentUiEvents";
import {
  buildDesktopCoworkActionRequest,
  buildDesktopCoworkCockpitView,
  buildDesktopCoworkSessionRows,
  buildDesktopCoworkTaskOperations,
} from "../cowork/desktopCowork";
import { installDesktopCommandPalette, type DesktopCommandPaletteInput } from "../command/desktopCommandPalette";
import { installDesktopMenuCommandRouting } from "../command/desktopCommandNavigation";
import type { GatewayRuntimeStatus } from "../gateway/desktopGatewayStartup";
import { ensureGatewayReady } from "../gateway/desktopGatewayStartup";
import { installDesktopGatewayBridge } from "../gateway/desktopGatewayBridge";
import {
  buildDesktopKnowledgeDocumentRows,
  buildDesktopKnowledgePaneModel,
  buildDesktopKnowledgeQueryRequest,
  buildDesktopKnowledgeTaskOperation,
  hasRunnableKnowledgeQueryDraft,
  type DesktopKnowledgeQueryRequestInput,
  type DesktopKnowledgePaneModel,
} from "../knowledge/desktopKnowledgeTraceability";
import { installWebUiRenderGlobals } from "../shell/desktopMarkdownGlobals";
import {
  createDesktopNativeStartupTrace,
  logDesktopNativeChatDebug,
  logDesktopNativeDebug,
  summarizeDebugText,
  traceDesktopNativeDebugAsync,
  type DesktopNativeStartupTrace,
} from "../native/desktopNativeChatDebug";
import { applyNativeConfigPatch } from "../native/desktopNativeConfigPatch";
import {
  applyDesktopSettingsLocalPreferences,
  clearDesktopSettingsLocalPreferences,
  loadDesktopSettingsLocalPreferences,
  saveDesktopSettingsLocalPreferences,
} from "../settings/desktopSettingsLocalPreferences";
import { saveDesktopSettingsConfig, type DesktopSettingsSaveResult } from "../settings/desktopSettingsSave";
import { buildDesktopTsAgentFormSubmissionInput } from "../agent-ui/desktopTsAgentFormActions";
import {
  nativeApprovalRefreshOptions,
  submitDesktopApprovalAction,
  summarizeDesktopApprovalResumeResult,
} from "../agent-ui/desktopApprovalActions";
import { installDesktopNavigation } from "../shell/desktopNavigation";
import { applyDesktopWorkbenchRouteState } from "../shell/desktopEntityFocus";
import {
  createDesktopNativeWorkbenchRuntime,
  type DesktopTsAgentWorkerEventName,
  type DesktopNativeWorkbenchRuntime,
} from "../native/desktopNativeWorkbenchRuntime";
import { createDesktopOsNotificationBridge } from "../native/desktopOsNotifications";
import {
  applyDesktopSettingsFieldEdit,
  applyDesktopProviderModels,
  buildDesktopProviderCatalogItems,
  buildDesktopProviderModelRequest,
  buildDesktopSettingsFormState,
  buildDesktopSettingsPaneModel,
  buildDesktopSettingsSavePatch,
  reconcileDesktopSettingsSavedState,
  type DesktopSettingsFormState,
  type DesktopSettingsPaneModel,
  type DesktopSettingsPaneSaveDetails,
} from "../settings/desktopSettingsProviders";
import { bindStartupRetry, setStartupState } from "../shell/desktopStartupView";
import { buildDesktopTaskCenterItems, type DesktopTaskSourceOperation } from "../tasks/desktopTaskCenter";
import { createDesktopTaskNotificationController } from "../tasks/desktopTaskNotifications";
import { runDesktopGatewayRuntimeCommand, type DesktopGatewayRuntimeCommand, type DesktopGatewayRuntimeCommandPayload } from "../gateway/desktopGatewayRuntimeControls";
import {
  buildDesktopApprovalTaskOperations,
  buildDesktopGatewayTaskOperation,
  buildDesktopProviderModelDiscoveryTaskOperation,
} from "../tasks/desktopTaskCenterSources";
import { buildDesktopSkillRows, buildDesktopToolRows } from "../tools-skills/desktopToolsSkills";
import {
  buildDesktopToolsSkillsPaneModel,
  updateDesktopSkillEditorDraft,
  type DesktopToolsSkillsPaneModel,
} from "../tools-skills/desktopToolsSkills";
import {
  installDesktopWorkbenchShell,
  syncDesktopWorkbenchRouteSidebar,
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
} from "../shell/desktopWorkbenchShell";
import { installDesktopWorkspaceFileActions } from "../workspace/desktopWorkspaceFiles";
import { buildDesktopWorkspaceFileRows } from "../workspace/desktopWorkspaceFiles";
import { installDesktopRootWebUiWorkbenchAdapter } from "../root-webui/desktopRootWebUiWorkbench";
import { installWebUiShell } from "../root-webui/desktopWebUiShell";
import { resolveDesktopWorkbenchStartupMode } from "../shell/desktopWorkbenchGate";
import { installDesktopWindowFrame, setDesktopWindowRuntimeStatus } from "../shell/desktopWindowFrame";
import { DEFAULT_GATEWAY_CONFIG, resolveGatewayConfig } from "../gateway/gatewayConfig";
import {
  DEFAULT_TS_COWORK_RUNTIME_ROLLOUT,
  checkGatewayHealth,
  createGatewayApiClient,
  resolveTsCoworkRuntimeRollout,
  type TsCoworkRuntimeRollout,
} from "../gateway/gatewayHttpClient";
import { createDesktopNativeCoworkApi } from "../native/desktopNativeCowork";
import { createDesktopNativeSessionsApi } from "../native/desktopNativeSessions";
import { createDesktopNativeSkillsApi } from "../native/desktopNativeSkills";
import { createDesktopNativeWebuiApi } from "../native/desktopNativeWebui";
import { createDesktopNativeWorkspaceApi } from "../native/desktopNativeWorkspace";
import { startDesktopNativeChannelRuntime } from "../native/desktopNativeChannelLifecycle";
import { createDesktopNativeTransportApi } from "../native/desktopNativeTransport";
import { toDesktopNativeTauriEventName } from "../native/desktopNativeTauriEvents";
import { normalizeNativeBackendEventPayload } from "../native/nativeBackendContract";
import { normalizeSessionsPayload } from "../chat/nativeChat";
import {
  flushGatewaySocketQueue,
  openGatewaySocket,
  sendGatewaySocketJson,
  type NormalizedGatewayEvent,
} from "../gateway/gatewayWebSocketClient";
import {
  desktopUploadPickerOptions,
  installDesktopFileUploadActions,
  type DesktopFileUploadActions,
  type DesktopPickedUploadFile,
  type DesktopUploadKind,
} from "../workspace/desktopFileUpload";
import { installDesktopWebUiCommandBridge } from "../root-webui/desktopWebUiCommandBridge";
import { installDesktopWebUiFilePickerBridge } from "../root-webui/desktopWebUiFilePickerBridge";
import { installDesktopWebUiNotificationBridge } from "../root-webui/desktopWebUiNotificationBridge";
import {
  buildDesktopCommandEntriesFromSidebar,
  buildNativeWorkbenchSidebarModel,
  buildRootWebUiSidebarModel,
} from "../shell/desktopSharedModels";
import { resolveDesktopAgentRoute } from "../../desktopAgentRoute";

const gatewayConfig = resolveGatewayConfig(DEFAULT_GATEWAY_CONFIG);
const gatewayClientOptions: {
  config: typeof gatewayConfig;
  nativeCowork: ReturnType<typeof createDesktopNativeCoworkApi>;
  nativeSessions: ReturnType<typeof createDesktopNativeSessionsApi>;
  nativeSkills: ReturnType<typeof createDesktopNativeSkillsApi>;
  nativeWebui: ReturnType<typeof createDesktopNativeWebuiApi>;
  nativeWorkspace: ReturnType<typeof createDesktopNativeWorkspaceApi>;
  nativeTransport: ReturnType<typeof createDesktopNativeTransportApi>;
  tsCoworkRuntime: TsCoworkRuntimeRollout;
} = {
  config: gatewayConfig,
  nativeCowork: createDesktopNativeCoworkApi({ invoke }),
  nativeSessions: createDesktopNativeSessionsApi({ invoke }),
  nativeSkills: createDesktopNativeSkillsApi({ invoke }),
  nativeWebui: createDesktopNativeWebuiApi({ invoke }),
  nativeWorkspace: createDesktopNativeWorkspaceApi({ invoke }),
  nativeTransport: createDesktopNativeTransportApi({ invoke }),
  tsCoworkRuntime: DEFAULT_TS_COWORK_RUNTIME_ROLLOUT,
};
const gatewayApi = createGatewayApiClient(gatewayClientOptions);
const WEBUI_ENTRY = "/assets/src/main.js";
const nativeKnowledgeTaskOperations = new Map<string, DesktopTaskSourceOperation>();
const nativeCoworkTaskOperations = new Map<string, DesktopTaskSourceOperation>();
const nativeProviderTaskOperations = new Map<string, DesktopTaskSourceOperation>();
const nativeFileTaskOperations = new Map<string, DesktopTaskSourceOperation>();
const nativeGatewayTaskOperations = new Map<string, DesktopTaskSourceOperation>();
const nativeApprovalTaskOperations = new Map<string, DesktopTaskSourceOperation>();
let nativeRuntimeStatus: GatewayRuntimeStatus | null = null;
let nativeRuntimeStatusEventsInstalled = false;
let nativeRuntimeStatusRefreshTimer: number | null = null;
let nativeRuntimeStatusRefreshInFlight = false;
let nativeRuntimeStatusRefreshPending = false;
let nativeSettingsConfig: unknown = {};
let nativeSettingsState: DesktopSettingsFormState | null = null;
let nativeSettingsLastSavedState: DesktopSettingsFormState | null = null;
let nativeSettingsProviderCatalog: ReturnType<typeof buildDesktopProviderCatalogItems> = [];

type NativeConfigEditorSnapshot = {
  configPath?: string;
  config_path?: string;
  revision?: string;
  explicitPublicConfig?: unknown;
  explicit_public_config?: unknown;
  effectivePublicConfig?: unknown;
  effective_public_config?: unknown;
  origins?: unknown;
  diagnostics?: unknown;
  secretPresence?: unknown;
  secret_presence?: unknown;
};
let nativeSkillsPayload: unknown = {};
let nativeToolsPayload: unknown = {};
let nativeToolsSkillsConfig: unknown = {};
let nativeToolsSkillsPane: DesktopToolsSkillsPaneModel | null = null;
let nativeKnowledgePane: DesktopKnowledgePaneModel | null = null;
let nativeKnowledgeQueryResult: unknown = {};
let nativeCoworkPane: DesktopCoworkPaneModel | null = null;
let nativeCoworkSelectedSessionId = "";
let nativeWorkbenchRuntime: DesktopNativeWorkbenchRuntime | null = null;
let nativeAgentRoute: "gateway" | "ts-agent" = "gateway";
let nativeChatSocket: WebSocket | null = null;
let nativeChatWsUrl = gatewayConfig.wsUrl;
let nativeChatRuntimeActionsInstalled = false;
let nativeTsAgentListenersInstalled = false;
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
  const startupTrace = createDesktopNativeStartupTrace();
  startupTrace.mark("boot.invoked", {
    gatewayHttp: gatewayConfig.httpBaseUrl,
    hasTauriRuntime: hasTauriRuntime(),
  });
  logDesktopNativeDebug("bootstrap.start", {
    gatewayHttp: gatewayConfig.httpBaseUrl,
    hasTauriRuntime: hasTauriRuntime(),
  });
  setStartupState(document, "Starting local gateway...", null, false);
  try {
    startupTrace.start("gatewayReady", {
      gatewayHttp: gatewayConfig.httpBaseUrl,
    });
    const status = await ensureGatewayReady(gatewayConfig, { invoke, hasTauriRuntime });
    startupTrace.complete("gatewayReady", {
      owner: status?.owner ?? "",
      runtimeState: status?.state ?? "",
    });
    nativeRuntimeStatus = status;
    installNativeRuntimeStatusEventRouting();
    updateNativeGatewayTask(buildDesktopGatewayTaskOperation("startup", status));
    startupTrace.start("channelRuntime");
    await startDesktopNativeChannelRuntime({
      nativeTransport: gatewayClientOptions.nativeTransport,
      logDebug: logDesktopNativeDebug,
    });
    startupTrace.complete("channelRuntime");
    startupTrace.start("startupMode");
    const workbenchMode = resolveDesktopWorkbenchStartupMode();
    document.documentElement.dataset.desktopWorkbenchMode = workbenchMode.mode;
    document.documentElement.dataset.desktopWorkbenchRequestedMode = workbenchMode.requestedMode;
    startupTrace.complete("startupMode", {
      fallbackReason: workbenchMode.fallbackReason ?? "",
      mode: workbenchMode.mode,
      requestedMode: workbenchMode.requestedMode,
    });
    if (workbenchMode.fallbackReason) {
      logDesktopNativeDebug("bootstrap.fallback", {
        fallbackReason: workbenchMode.fallbackReason,
        mode: workbenchMode.mode,
        requestedMode: workbenchMode.requestedMode,
      });
      console.info("Tinybot desktop loading root WebUI fallback", workbenchMode);
    }
    startupTrace.start("gatewayBridge");
    installDesktopGatewayBridge({
      config: gatewayConfig,
      nativeTransport: gatewayClientOptions.nativeTransport,
      nativeWebui: gatewayClientOptions.nativeWebui,
      resolveNativeWebSocketSessionExists,
      listenToNativeAgentEvent: (eventName, handler) => listen(toDesktopNativeTauriEventName(eventName), (event) => {
        handler(normalizeNativeBackendEventPayload(event.payload));
      }),
    });
    installWebUiRenderGlobals();
    startupTrace.complete("gatewayBridge");
    if (workbenchMode.mode === "native-workbench") {
      startupTrace.start("nativeChatRuntime");
      const nativeChatRuntime = await loadNativeChatRuntime();
      startupTrace.complete("nativeChatRuntime", {
        activeSessionKey: nativeChatRuntime.chat.activeSessionKey ?? "",
        sessionCount: nativeChatRuntime.chat.sessions.length,
      });
      startupTrace.start("initialPaneModels");
      const settingsPane = await loadNativeSettingsPane();
      nativeChatRuntime.setRuntimeMetadata(nativeRuntimeMetadataFromSettings());
      const knowledgePane = buildInitialNativeKnowledgePane();
      const toolsSkillsPane = buildInitialNativeToolsSkillsPane();
      const coworkPane = buildInitialNativeCoworkPane();
      startupTrace.complete("initialPaneModels");
      startupTrace.start("nativeShellInstall");
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
      startupTrace.complete("nativeShellInstall");
      startupTrace.start("nativeChromeBindings");
      installNativeChatRuntimeActions();
      installNativeFileUploadActions();
      installNativeCommandPalette();
      installTauriNavigation({ routeDocsInWorkbench: true });
      installTauriMenuCommandRouting({ routeDocsInWorkbench: true });
      installNativeRouteHydration(startupTrace);
      installTauriWindowFrame(status);
      syncNativeRuntimeMetadata();
      startupTrace.complete("nativeChromeBindings");
      hydrateNativeStartupPanes(startupTrace);
      void ensureNativeCoworkRuntimeRolloutSynced(startupTrace);
      scheduleNativeApprovalTasksRefresh(startupTrace);
      startupTrace.mark("native.ready", {
        gatewayHttp: gatewayConfig.httpBaseUrl,
        mode: workbenchMode.mode,
        runtimeState: status?.state ?? "",
      });
      logDesktopNativeDebug("bootstrap.native.initialized", {
        gatewayHttp: gatewayConfig.httpBaseUrl,
        mode: workbenchMode.mode,
        runtimeState: status?.state ?? "",
      });
      console.info("Tinybot desktop native workbench initialized", status);
      return;
    }
    startupTrace.start("webUiShell");
    installWebUiShell(webUiHtml);
    startupTrace.complete("webUiShell");
    startupTrace.start("webUiEntryImport");
    await import(/* @vite-ignore */ WEBUI_ENTRY);
    startupTrace.complete("webUiEntryImport");
    startupTrace.start("rootWorkbenchAdapter");
    installDesktopRootWebUiWorkbenchAdapter();
    installDesktopCommandPalette({
      gatewayOrigin: gatewayConfig.httpBaseUrl,
      desktopCommands: buildRootWebUiDesktopCommands(),
      loadData: loadRootWebUiCommandPaletteData,
    });
    installRootWebUiDesktopAdapters();
    installTauriNavigation();
    installTauriWindowFrame(status);
    startupTrace.complete("rootWorkbenchAdapter");
    startupTrace.mark("webui.ready", {
      gatewayHttp: gatewayConfig.httpBaseUrl,
      mode: workbenchMode.mode,
      runtimeState: status?.state ?? "",
    });
    logDesktopNativeDebug("bootstrap.webui.initialized", {
      gatewayHttp: gatewayConfig.httpBaseUrl,
      mode: workbenchMode.mode,
      runtimeState: status?.state ?? "",
    });
    console.info("Tinybot desktop WebUI initialized", status);
  } catch (error) {
    startupTrace.fail("boot", error, {
      gatewayHttp: gatewayConfig.httpBaseUrl,
    });
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

function buildInitialNativeKnowledgePane(): DesktopKnowledgePaneModel {
  nativeKnowledgePane = buildDesktopKnowledgePaneModel();
  return nativeKnowledgePane;
}

function buildInitialNativeToolsSkillsPane(): DesktopToolsSkillsPaneModel {
  nativeToolsPayload = {};
  nativeSkillsPayload = {};
  nativeToolsSkillsConfig = {};
  nativeToolsSkillsPane = buildDesktopToolsSkillsPaneModel();
  return nativeToolsSkillsPane;
}

function buildInitialNativeCoworkPane(): DesktopCoworkPaneModel {
  nativeCoworkPane = {
    sessionRows: [],
    cockpitView: null,
  };
  return nativeCoworkPane;
}

function hydrateNativeStartupPanes(startupTrace?: DesktopNativeStartupTrace): void {
  startupTrace?.mark("hydration.scheduled");
  startupTrace?.mark("settingsPaneHydration.skipped", {
    reason: "deferred-until-opened",
  });
  startupTrace?.mark("knowledgePaneHydration.skipped", {
    reason: "deferred-until-opened",
  });
  startupTrace?.mark("toolsSkillsPaneHydration.skipped", {
    reason: "deferred-until-opened",
  });
  startupTrace?.mark("coworkPaneHydration.skipped", {
    reason: "deferred-until-opened",
  });
  startupTrace?.mark("workspaceFilesHydration.skipped", {
    reason: "deferred-until-opened",
  });
  startupTrace?.mark("coworkTasksRefresh.skipped", {
    reason: "deferred-until-opened",
  });
}

const nativeRouteHydratedModules = new Set<string>();
let nativeCoworkRuntimeRolloutSyncPromise: Promise<void> | null = null;
const DESKTOP_COWORK_STANDALONE_AVAILABLE = false;

function installNativeRouteHydration(startupTrace?: DesktopNativeStartupTrace): void {
  window.addEventListener("tinybot:desktop-route", (event) => {
    const href = routeHydrationHref(event);
    if (!href) {
      return;
    }
    hydrateNativeRouteTarget(href, startupTrace);
  });
}

function routeHydrationHref(event: Event): string {
  const detail = event instanceof CustomEvent ? event.detail : null;
  return typeof detail?.href === "string" ? detail.href : "";
}

function hydrateNativeRouteTarget(href: string, startupTrace?: DesktopNativeStartupTrace): void {
  const pathname = new URL(href, window.location.href).pathname;
  if (pathname.startsWith("/settings")) {
    hydrateNativeSettingsPaneOnce(startupTrace);
    return;
  }
  if (pathname.startsWith("/knowledge")) {
    hydrateNativeKnowledgePaneOnce(startupTrace);
    return;
  }
  if (pathname.startsWith("/tools") || pathname.startsWith("/skills")) {
    hydrateNativeToolsSkillsPaneOnce(startupTrace);
    return;
  }
  if (pathname.startsWith("/cowork")) {
    if (!DESKTOP_COWORK_STANDALONE_AVAILABLE) {
      startupTrace?.mark("coworkPaneHydration.skipped", {
        reason: "under-construction",
      });
      startupTrace?.mark("coworkTasksRefresh.skipped", {
        reason: "under-construction",
      });
      return;
    }
    hydrateNativeCoworkPaneOnce(startupTrace);
    traceNativeRouteBackgroundOnce("coworkTasksRefresh", () => refreshNativeCoworkTasks(), startupTrace);
    return;
  }
  if (pathname.startsWith("/files")) {
    hydrateNativeWorkspaceFilesOnce(startupTrace);
  }
}

function hydrateNativeSettingsPaneOnce(startupTrace?: DesktopNativeStartupTrace): void {
  traceNativeRouteBackgroundOnce("settingsPaneHydration", async () => {
    const pane = await loadNativeSettingsPane();
    updateDesktopSettingsPane(document, pane, {
      onSettingsAction: (event) => {
        void handleNativeSettingsAction(event);
      },
    });
    syncNativeRuntimeMetadata();
    logDesktopNativeDebug("settings.load.lazy.complete", {
      groupCount: pane.groups.length,
    });
  }, startupTrace);
}

function hydrateNativeKnowledgePaneOnce(startupTrace?: DesktopNativeStartupTrace): void {
  traceNativeRouteBackgroundOnce("knowledgePaneHydration", async () => {
    const pane = await loadNativeKnowledgePane();
    setNativeKnowledgePane(pane);
    logDesktopNativeDebug("knowledge.load.lazy.complete", {
      documentCount: pane.documentRows.length,
    });
  }, startupTrace);
}

function hydrateNativeToolsSkillsPaneOnce(startupTrace?: DesktopNativeStartupTrace): void {
  traceNativeRouteBackgroundOnce("toolsSkillsPaneHydration", async () => {
    const pane = await loadNativeToolsSkillsPane();
    setNativeToolsSkillsPane(pane);
    logDesktopNativeDebug("toolsSkills.load.lazy.complete", {
      skillCount: pane.skillRows.length,
      toolCount: pane.toolRows.length,
    });
  }, startupTrace);
}

function hydrateNativeCoworkPaneOnce(startupTrace?: DesktopNativeStartupTrace): void {
  traceNativeRouteBackgroundOnce("coworkPaneHydration", async () => {
    await ensureNativeCoworkRuntimeRolloutSynced(startupTrace);
    const pane = await loadNativeCoworkPane();
    setNativeCoworkPane(pane);
    logDesktopNativeDebug("cowork.load.lazy.complete", {
      sessionCount: pane.sessionRows.length,
    });
  }, startupTrace);
}

function scheduleNativeApprovalTasksRefresh(startupTrace?: DesktopNativeStartupTrace): void {
  traceNativeRouteBackgroundOnce("approvalTasksRefresh", () => refreshNativeApprovalTasks(), startupTrace);
}

function hydrateNativeWorkspaceFilesOnce(startupTrace?: DesktopNativeStartupTrace): void {
  traceNativeRouteBackgroundOnce("workspaceFilesHydration", async () => {
    await installNativeWorkspaceFileActions();
  }, startupTrace);
}

function traceNativeRouteBackgroundOnce(
  phase: string,
  run: () => Promise<void>,
  startupTrace?: DesktopNativeStartupTrace,
): void {
  if (nativeRouteHydratedModules.has(phase)) {
    return;
  }
  nativeRouteHydratedModules.add(phase);
  startupTrace?.start(phase);
  void run().then(() => {
    startupTrace?.complete(phase);
  }).catch((error) => {
    nativeRouteHydratedModules.delete(phase);
    startupTrace?.fail(phase, error);
    logDesktopNativeDebug(`${phase}.lazy.failed`, {
      error: stringifyError(error),
    });
  });
}

function ensureNativeCoworkRuntimeRolloutSynced(startupTrace?: DesktopNativeStartupTrace): Promise<void> {
  if (nativeCoworkRuntimeRolloutSyncPromise) {
    return nativeCoworkRuntimeRolloutSyncPromise;
  }
  startupTrace?.start("coworkRolloutSync");
  nativeCoworkRuntimeRolloutSyncPromise = gatewayApi.config.get().then((config) => {
    syncTsCoworkRuntimeRollout(config);
    startupTrace?.complete("coworkRolloutSync");
  }).catch((error) => {
    nativeCoworkRuntimeRolloutSyncPromise = null;
    startupTrace?.fail("coworkRolloutSync", error);
    logDesktopNativeDebug("cowork.rollout.sync.failed", {
      error: stringifyError(error),
    });
  });
  return nativeCoworkRuntimeRolloutSyncPromise;
}

async function resolveNativeWebSocketSessionExists(sessionId: string): Promise<boolean | undefined> {
  try {
    await gatewayApi.sessions.messages(sessionId);
    return true;
  } catch (error) {
    return isGatewayNotFoundError(error) ? false : undefined;
  }
}

function isGatewayNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\bHTTP 404\b/.test(message) || message.toLowerCase().includes("session not found");
}

async function loadNativeChatRuntime(): Promise<DesktopNativeWorkbenchRuntime> {
  logDesktopNativeDebug("bootstrap.nativeChat.load.start", {
    gatewayHttp: gatewayConfig.httpBaseUrl,
  });
  const agentRoute = resolveDesktopAgentRoute({
    search: window.location.search,
    storedRoute: readDesktopAgentRoutePreference(),
  });
  nativeAgentRoute = agentRoute;
  const runtime = createDesktopNativeWorkbenchRuntime({
    api: {
      listSessions: () => gatewayApi.sessions.list(),
      loadMessages: (sessionKey) => gatewayApi.sessions.messages(sessionKey),
      listTraceEvents: agentRoute === "ts-agent"
        ? (filter) => invoke("worker_background_trace_list", { input: { filter } })
        : undefined,
      getDelegateTrace: agentRoute === "ts-agent"
        ? (filter) => invoke("worker_background_trace_get_delegate_trace", { input: { filter } })
        : undefined,
      getArtifact: agentRoute === "ts-agent"
        ? (filter) => invoke("worker_background_trace_get_artifact", { input: { filter } })
        : undefined,
      deleteSession: (sessionKey) => gatewayApi.sessions.delete(sessionKey),
    },
    sendSocketMessage: (message) => sendNativeChatSocketMessage(message),
    agentRoute,
    runTsAgent: agentRoute === "ts-agent"
      ? (spec) => invoke("worker_run_agent", { input: { spec } })
      : undefined,
    cancelTsAgent: agentRoute === "ts-agent"
      ? (runId) => invoke("worker_cancel_agent", { input: { runId } })
      : undefined,
    restoreTsAgentCheckpoint: agentRoute === "ts-agent"
      ? (sessionId) => invoke("worker_restore_agent_checkpoint", { input: { sessionId } })
      : undefined,
  });
  nativeWorkbenchRuntime = runtime;
  installNativeTsAgentEventListeners();
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

function installNativeTsAgentEventListeners(): void {
  if (nativeTsAgentListenersInstalled) {
    return;
  }
  nativeTsAgentListenersInstalled = true;
  for (const eventName of [
    "agent.delta",
    "agent.reasoning_delta",
    "agent.tool_call.delta",
    "agent.tool.start",
    "agent.tool.result",
    "agent.usage",
    "agent.checkpoint",
    "agent.awaiting_form",
    "agent.awaiting_approval",
    "agent.memory_reference",
    "agent.task_progress",
    "agent.delegate.started",
    "agent.delegate.running",
    "agent.delegate.message_queued",
    "agent.delegate.awaiting_approval",
    "agent.delegate.tool.approval_required",
    "agent.delegate.tool.completed",
    "agent.delegate.trace.updated",
    "agent.delegate.completed",
    "agent.delegate.failed",
    "agent.delegate.interrupted",
    "agent.delegate.closed",
    "heartbeat.delivery",
    "agent.cancelled",
    "agent.done",
    "agent.error",
  ] as const) {
    void listen(toDesktopNativeTauriEventName(eventName), (event) => {
      handleNativeTsAgentWorkerEvent(eventName, event.payload);
    });
  }
}

function handleNativeTsAgentWorkerEvent(eventName: DesktopTsAgentWorkerEventName, payload: unknown): void {
  if (!nativeWorkbenchRuntime) {
    return;
  }
  nativeWorkbenchRuntime.handleTsAgentWorkerEvent(eventName, normalizeNativeBackendEventPayload(payload));
  updateDesktopNativeChat(document, nativeWorkbenchRuntime.chat, gatewayConfig.httpBaseUrl, nativeChatActions());
}

function readDesktopAgentRoutePreference(): string | null {
  try {
    return window.localStorage.getItem("tinybot.desktop.agentRoute");
  } catch {
    return null;
  }
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
  nativeWorkbenchRuntime.setRuntimeMetadata(nativeRuntimeMetadataFromSettings());
  updateDesktopNativeChat(document, nativeWorkbenchRuntime.chat, gatewayConfig.httpBaseUrl, nativeChatActions());
}

function nativeRuntimeMetadataFromSettings(): NonNullable<DesktopNativeWorkbenchRuntime["chat"]["runtime"]> {
  return {
    provider: nativeSettingsState?.agent.provider || undefined,
    model: nativeSettingsState?.agent.model || undefined,
    modelOptions: nativeSettingsState ? nativeComposerModelOptions(nativeSettingsState) : undefined,
    contextWindowTokens: nativeSettingsState?.agent.contextWindowTokens ?? undefined,
    maxToolIterations: nativeSettingsState?.agent.maxToolIterations ?? undefined,
    gatewayHttp: gatewayConfig.httpBaseUrl,
  };
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
    onArtifactLoad: (selection: { sessionKey: string; delegateId?: string; traceRef?: string; artifactId: string }) => {
      if (!nativeWorkbenchRuntime) {
        return Promise.resolve(null);
      }
      return nativeWorkbenchRuntime.loadArtifact(selection);
    },
    onDelegateTraceLoad: (selection: { sessionKey: string; delegateId?: string; traceRef?: string }) => {
      if (!nativeWorkbenchRuntime) {
        return Promise.resolve(null);
      }
      return nativeWorkbenchRuntime.loadDelegateTrace(selection);
    },
    onSelectModel: (model: string) => {
      void selectNativeComposerModel(model);
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

async function selectNativeComposerModel(selectedModel: string): Promise<void> {
  if (!nativeWorkbenchRuntime) {
    return;
  }
  if (!nativeSettingsState) {
    await loadNativeSettingsPane();
  }
  if (!nativeSettingsState) {
    return;
  }
  const nextModel = selectedModel.trim();
  if (!nextModel) {
    return;
  }
  const currentModel = nativeSettingsState.agent.model || nativeWorkbenchRuntime.chat.runtime?.model || "";
  if (nextModel === currentModel) {
    return;
  }
  nativeSettingsState = applyDesktopSettingsFieldEdit(nativeSettingsState, "model", nextModel);
  syncNativeRuntimeMetadata();
  await saveNativeSettingsPane();
}

function nativeComposerModelOptions(state: DesktopSettingsFormState): string[] {
  const providerId = state.agent.provider && state.agent.provider !== "auto"
    ? state.agent.provider
    : state.providerEditor.selectedProvider;
  const provider = state.providerSummaries.find((summary) => summary.id === providerId);
  const rawModels = provider?.modelsText || state.providerEditor.modelsText;
  const models = rawModels
    .split(/\r?\n|,/)
    .map((model) => model.trim())
    .filter(Boolean);
  if (state.agent.model && !models.includes(state.agent.model)) {
    models.unshift(state.agent.model);
  }
  return Array.from(new Set(models));
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
    await submitNativeApprovalAction(approvalId, sessionKey, event.action);
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
      await submitNativeAgentUiFormAction(form, request, "submit");
      if (nativeAgentRoute === "ts-agent") {
        form.status = "submitted";
      }
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
    await submitNativeAgentUiFormAction(form, request, "cancel");
    if (nativeAgentRoute === "ts-agent") {
      form.status = "cancelled";
    }
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

async function submitNativeAgentUiFormAction(
  form: DesktopAgentUiFormActionEvent["form"],
  request: { values?: Record<string, unknown>; correlation?: Record<string, unknown> },
  action: "submit" | "cancel",
): Promise<void> {
  if (nativeAgentRoute === "ts-agent") {
    const input = buildDesktopTsAgentFormSubmissionInput(
      form,
      request,
      action,
      nativeWorkbenchRuntime?.chat.activeSessionKey ?? "",
    );
    await invoke("worker_submit_agent_form", { input });
    return;
  }
  if (action === "submit") {
    await gatewayApi.agentUi.submitForm(form.form_id, request);
    return;
  }
  await gatewayApi.agentUi.cancelForm(form.form_id, request);
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
    const detail = (event as CustomEvent).detail;
    const record = asRecord(detail);
    logDesktopNativeDebug("runtime.actions.approvalEvent", {
      action: typeof record.action === "string" ? record.action : "",
      approvalId: typeof record.approvalId === "string" ? record.approvalId : "",
      hasSessionKey: typeof record.sessionKey === "string" && Boolean(record.sessionKey),
      toolActivityId: typeof record.toolActivityId === "string" ? record.toolActivityId : "",
      toolName: typeof record.toolName === "string" ? record.toolName : "",
    });
    void handleNativeInlineApprovalAction(detail);
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
    const activeModule = applyDesktopWorkbenchRouteState(document, path);
    syncDesktopWorkbenchRouteSidebar(document, activeModule, {
      chat: nativeWorkbenchRuntime?.chat ?? null,
      chatActions: nativeChatActions(),
      settingsPane: currentNativeSettingsPane(),
      settingsActions: {
        onSettingsAction: (nextEvent) => {
          void handleNativeSettingsAction(nextEvent);
        },
      },
    });
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
    const resumeResult = await submitNativeApprovalAction(approvalId, sessionKey, action);
    const resumeSummary = summarizeDesktopApprovalResumeResult(resumeResult);
    const decision = action === "deny" ? "denied" : "approved";
    const resolvedLocally = nativeWorkbenchRuntime?.resolveApproval(approvalId, decision, sessionKey) ?? false;
    logDesktopNativeDebug("inlineApproval.localResolve", {
      action,
      approvalId,
      decision,
      resolvedLocally,
      sessionKeyPrefix: sessionKey.split(":")[0] || "",
      toolName,
    });
    if (nativeWorkbenchRuntime && resolvedLocally) {
      updateDesktopNativeChat(document, nativeWorkbenchRuntime.chat, gatewayConfig.httpBaseUrl, nativeChatActions());
    }
    nativeApprovalTaskOperations.delete(taskId);
    publishNativeTaskCenterItems();
    await refreshNativeApprovalTasks();
    logDesktopNativeDebug("inlineApproval.complete", {
      action,
      approvalId,
      resolvedLocally,
      resume: resumeSummary,
      toolName,
    });
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

async function submitNativeApprovalAction(
  approvalId: string,
  sessionKey: string,
  action: string,
): Promise<unknown> {
  if (!["approveOnce", "approveSession", "deny"].includes(action)) {
    return undefined;
  }
  const preferNativeWorkerResume = true;
  logDesktopNativeDebug("approvalAction.route", {
    action,
    approvalId,
    hasSessionKey: Boolean(sessionKey),
    hasTauriRuntime: hasTauriRuntime(),
    nativeAgentRoute,
    preferNativeWorkerResume,
    sessionKeyPrefix: sessionKey.split(":")[0] || "",
  });
  return await submitDesktopApprovalAction({
    action: action as "approveOnce" | "approveSession" | "deny",
    approvalId,
    gatewayTools: gatewayApi.tools,
    invoke,
    onGatewayFallback: () => {
      logDesktopNativeDebug("approvalAction.gatewayFallback", {
        action,
        approvalId,
      });
    },
    onNativeResumeAttempt: () => {
      logDesktopNativeDebug("approvalAction.nativeResume.start", {
        action,
        approvalId,
      });
    },
    onNativeResumeFailed: (error) => {
      logDesktopNativeDebug("approvalAction.nativeResume.failed", {
        action,
        approvalId,
        error: stringifyError(error),
      });
    },
    onNativeResumeSucceeded: (_context, result) => {
      logDesktopNativeDebug("approvalAction.nativeResume.complete", {
        action,
        approvalId,
        resume: summarizeDesktopApprovalResumeResult(result),
      });
    },
    preferNativeWorkerResume,
    sessionKey,
  });
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
  options: {
    queryDraft?: Partial<DesktopKnowledgeQueryRequestInput>;
    queryResultPayload?: unknown;
    selectedDocumentId?: string | null;
  } = {},
): Promise<DesktopKnowledgePaneModel> {
  logDesktopNativeDebug("knowledge.load.start", {
    hasQueryResult: options.queryResultPayload !== undefined,
    selectedDocumentId: options.selectedDocumentId ?? "",
  });
  const [stats, documents, config, documentGraph, entityGraph, graphrag] = await Promise.all([
    gatewayApi.knowledge.stats().catch(() => ({})),
    gatewayApi.knowledge.documents().catch(() => ({ documents: [] })),
    gatewayApi.config.get().catch(() => ({})),
    gatewayApi.knowledge.graph({ graphType: "document" }).catch(() => ({})),
    gatewayApi.knowledge.graph({ graphType: "entity" }).catch(() => ({})),
    gatewayApi.knowledge.graphrag().catch(() => ({})),
  ]);
  nativeKnowledgeQueryResult = options.queryResultPayload ?? nativeKnowledgeQueryResult;
  nativeKnowledgePane = buildDesktopKnowledgePaneModel({
    statsPayload: stats,
    config,
    documentsPayload: documents,
    selectedDocumentId: options.selectedDocumentId,
    queryDraft: options.queryDraft ?? nativeKnowledgePane?.query.draft,
    queryResultPayload: nativeKnowledgeQueryResult,
    graphPayload: mergeNativeKnowledgeGraphPayload(selectNativeKnowledgeGraphPayload(entityGraph, documentGraph), graphrag),
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
      const request = buildDesktopCoworkActionRequest({
        action: "runSession",
        sessionId,
        architecture: selectedCoworkSessionArchitecture(event.pane, sessionId),
      });
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
      const request = buildDesktopCoworkActionRequest({ action: event.action, sessionId });
      await gatewayApi.cowork.action(sessionId, apiAction, "body" in request ? request.body : undefined);
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
      const request = buildDesktopCoworkActionRequest({
        action: "sendMessage",
        sessionId,
        content: event.message ?? "",
        recipientIds: [],
        architecture: selectedCoworkSessionArchitecture(event.pane, sessionId),
        threadId: event.threadId,
        topic: event.topic,
        eventType: event.eventType,
      });
      await gatewayApi.cowork.message(sessionId, requestBody(request));
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
    if (event.action === "loadBlueprint") {
      await gatewayApi.cowork.blueprint(sessionId);
      setNativeCoworkPane(await loadNativeCoworkPane({ selectedSessionId: sessionId, actionStatus: "Cowork blueprint loaded." }));
      return;
    }
    if (event.action === "loadTrace") {
      await gatewayApi.cowork.trace(sessionId);
      setNativeCoworkPane(await loadNativeCoworkPane({ selectedSessionId: sessionId, actionStatus: "Cowork trace loaded." }));
      return;
    }
    if (event.action === "loadDag") {
      await gatewayApi.cowork.dag(sessionId);
      setNativeCoworkPane(await loadNativeCoworkPane({ selectedSessionId: sessionId, actionStatus: "Cowork DAG loaded." }));
      return;
    }
    if (event.action === "loadArtifacts") {
      await gatewayApi.cowork.artifacts(sessionId);
      setNativeCoworkPane(await loadNativeCoworkPane({ selectedSessionId: sessionId, actionStatus: "Cowork artifacts loaded." }));
      return;
    }
    if (event.action === "loadOrganization") {
      await gatewayApi.cowork.organization(sessionId);
      setNativeCoworkPane(await loadNativeCoworkPane({ selectedSessionId: sessionId, actionStatus: "Cowork organization loaded." }));
      return;
    }
    if (event.action === "loadQueues") {
      await gatewayApi.cowork.queues(sessionId);
      setNativeCoworkPane(await loadNativeCoworkPane({ selectedSessionId: sessionId, actionStatus: "Cowork queues loaded." }));
      return;
    }
    if (event.action === "loadBranches") {
      await gatewayApi.cowork.branches(sessionId);
      setNativeCoworkPane(await loadNativeCoworkPane({ selectedSessionId: sessionId, actionStatus: "Cowork branches loaded." }));
      return;
    }
    if (event.action === "loadAgentActivity" && event.agentId) {
      await gatewayApi.cowork.agentActivity(sessionId, event.agentId, { limit: event.limit });
      setNativeCoworkPane(await loadNativeCoworkPane({ selectedSessionId: sessionId, actionStatus: "Cowork agent activity loaded." }));
      return;
    }
    if (event.action === "loadObservation" && event.detailRef) {
      await gatewayApi.cowork.observation(sessionId, event.detailRef, { requesterAgentId: event.requesterAgentId });
      setNativeCoworkPane(await loadNativeCoworkPane({ selectedSessionId: sessionId, actionStatus: "Cowork observation loaded." }));
      return;
    }
    if (event.action === "updateBudget") {
      if (!event.maxRounds) {
        outcome = "blocked";
        setNativeCoworkPane({
          ...event.pane,
          actionStatus: "Enter a positive Cowork max rounds value before updating the budget.",
        });
        return;
      }
      const request = buildDesktopCoworkActionRequest({
        action: "updateBudget",
        sessionId,
        body: { max_rounds: event.maxRounds },
      });
      const method = request.method === "PATCH" ? "PATCH" : "POST";
      await gatewayApi.cowork.updateBudget(sessionId, requestBody(request), { method });
      setNativeCoworkPane(await loadNativeCoworkPane({ selectedSessionId: sessionId, actionStatus: "Cowork budget updated." }));
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
      const request = buildDesktopCoworkActionRequest({
        action: "selectBranch",
        sessionId,
        branchId: event.branchId,
        architecture: selectedCoworkBranchArchitecture(event.pane, event.branchId),
      });
      await gatewayApi.cowork.selectBranch(
        sessionId,
        event.branchId,
        "body" in request ? request.body : undefined,
      );
      setNativeCoworkPane(await loadNativeCoworkPane({ selectedSessionId: sessionId, actionStatus: "Cowork branch selected." }));
      return;
    }
    if (event.action === "deriveBranch" && (event.sourceBranchId || event.branchId)) {
      const sourceBranchId = event.sourceBranchId || event.branchId || null;
      const request = buildDesktopCoworkActionRequest({
        action: "deriveBranch",
        sessionId,
        sourceBranchId,
        body: { target_architecture: event.targetArchitecture || "swarm" },
      });
      await gatewayApi.cowork.deriveBranch(sessionId, sourceBranchId, requestBody(request));
      setNativeCoworkPane(await loadNativeCoworkPane({ selectedSessionId: sessionId, actionStatus: "Cowork branch derived." }));
      return;
    }
    if (event.action === "selectBranchResult" && event.branchId && event.resultId) {
      const request = buildDesktopCoworkActionRequest({
        action: "selectBranchResult",
        sessionId,
        branchId: event.branchId,
        resultId: event.resultId,
        architecture: selectedCoworkBranchArchitecture(event.pane, event.branchId),
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
      return;
    }
    if (event.action === "selectFinalResult" && event.branchId && event.resultId) {
      const request = buildDesktopCoworkActionRequest({
        action: "selectFinalResult",
        sessionId,
        body: { branch_id: event.branchId, result_id: event.resultId },
      });
      await gatewayApi.cowork.selectFinalResult(sessionId, requestBody(request));
      setNativeCoworkPane(await loadNativeCoworkPane({ selectedSessionId: sessionId, actionStatus: "Cowork final result selected." }));
      return;
    }
    if (event.action === "mergeFinalResult") {
      const branchIds = event.branchIds ?? [];
      if (branchIds.length < 2) {
        outcome = "blocked";
        setNativeCoworkPane({
          ...event.pane,
          actionStatus: "Select at least two Cowork final result branches before merging.",
        });
        return;
      }
      const request = buildDesktopCoworkActionRequest({
        action: "mergeFinalResult",
        sessionId,
        body: { branch_ids: branchIds },
      });
      await gatewayApi.cowork.mergeFinalResult(sessionId, requestBody(request));
      setNativeCoworkPane(await loadNativeCoworkPane({ selectedSessionId: sessionId, actionStatus: "Cowork final results merged." }));
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

function selectedCoworkSessionArchitecture(pane: DesktopCoworkPaneModel, sessionId: string): string {
  const cockpitSession = asRecord(pane.cockpitView?.raw);
  const cockpitArchitecture = stringValue(cockpitSession.architecture).trim()
    || stringValue(cockpitSession.workflow_mode).trim();
  if (cockpitArchitecture) {
    return cockpitArchitecture;
  }
  const row = pane.sessionRows.find((item) => item.id === sessionId);
  const rowSession = asRecord(row?.raw);
  return stringValue(rowSession.architecture).trim() || stringValue(rowSession.workflow_mode).trim();
}

function selectedCoworkBranchArchitecture(pane: DesktopCoworkPaneModel, branchId: string): string {
  const branch = pane.cockpitView?.branches.find((item) => item.branchId === branchId || item.resultId === branchId);
  const raw = asRecord(branch?.raw);
  return stringValue(raw.architecture).trim()
    || stringValue(raw.workflow_mode).trim()
    || stringValue(raw.target_architecture).trim();
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
    if (event.action === "runQuery") {
      const queryDraft = event.queryDraft ?? event.pane.query.draft;
      if (!hasRunnableKnowledgeQueryDraft(queryDraft)) {
        outcome = "ignored";
        return;
      }
      const result = await gatewayApi.knowledge.query(buildDesktopKnowledgeQueryRequest(queryDraft));
      const pane = await loadNativeKnowledgePane({
        queryDraft,
        queryResultPayload: result,
        selectedDocumentId: event.pane.selectedDocument?.id,
      });
      setNativeKnowledgePane(pane);
      return;
    }
    if (event.action === "refreshAll") {
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
    if (event.action === "extractGraph") {
      const documentId = event.documentId || event.pane.selectedDocument?.id;
      if (!documentId) {
        outcome = "ignored";
        return;
      }
      const estimate = asRecord(await gatewayApi.knowledge.extractGraph({ docId: documentId, dryRun: true }));
      const tokenEstimate = asRecord(estimate.token_estimate);
      const totalTokens = stringValue(tokenEstimate.total_tokens || tokenEstimate.totalTokens || "");
      const maxTokens = stringValue(tokenEstimate.max_tokens || tokenEstimate.maxTokens || "");
      const budgetText = totalTokens && maxTokens ? ` Estimated tokens: ${totalTokens} / ${maxTokens}.` : "";
      const confirmed = window.confirm(`Extract an LLM entity graph for this document?${budgetText} This can spend model tokens.`);
      if (!confirmed) {
        outcome = "ignored";
        return;
      }
      updateNativeKnowledgeTask(buildDesktopKnowledgeGraphExtractionTaskOperation({
        documentId,
        documentName: stringValue(estimate.doc_name || estimate.docName || event.pane.selectedDocument?.title),
        status: "running",
        stage: "llm_extraction",
        detail: "Extracting entity graph",
        completed: 6,
        total: 8,
        tokenEstimate,
        extractionScope: asRecord(estimate.extraction_scope || estimate.extractionScope),
      }));
      const result = await gatewayApi.knowledge.extractGraph({ docId: documentId });
      const operation = buildDesktopKnowledgeTaskOperation(result);
      if (operation) {
        updateNativeKnowledgeTask(operation);
        const resultRecord = asRecord(result);
        const jobId = stringValue(resultRecord.job_id || resultRecord.jobId || asRecord(resultRecord.job)?.id);
        if (jobId) {
          void pollNativeKnowledgeGraphExtractionJob(jobId, documentId);
        }
      } else {
        const resultRecord = asRecord(result);
        const skipped = resultRecord.skipped === true;
        const skippedDocs = Array.isArray(resultRecord.skipped_docs) ? resultRecord.skipped_docs.map(asRecord) : [];
        const skippedReason = stringValue(resultRecord.skipped_reason || skippedDocs[0]?.reason);
        updateNativeKnowledgeTask(buildDesktopKnowledgeGraphExtractionTaskOperation({
          documentId,
          documentName: stringValue(estimate.doc_name || estimate.docName || event.pane.selectedDocument?.title),
          status: "completed",
          stage: skipped ? "skipped_existing_graph" : "completed",
          detail: skipped ? "Knowledge graph extraction skipped" : "Knowledge graph extraction finished",
          completed: 8,
          total: 8,
          tokenEstimate,
          extractionScope: asRecord(estimate.extraction_scope || estimate.extractionScope),
          diagnostics: skippedReason,
        }));
      }
      const pane = await loadNativeKnowledgePane({
        queryResultPayload: nativeKnowledgeQueryResult,
        selectedDocumentId: documentId,
      });
      setNativeKnowledgePane(pane);
      return;
    }
    if (event.action === "deleteDocument") {
      const documentId = event.documentId || event.pane.selectedDocument?.id;
      if (!documentId) {
        outcome = "ignored";
        return;
      }
      const confirmed = window.confirm("Delete this knowledge document? This will remove it from the global knowledge base.");
      if (!confirmed) {
        outcome = "ignored";
        return;
      }
      await gatewayApi.knowledge.deleteDocument(documentId);
      const pane = await loadNativeKnowledgePane({ queryResultPayload: nativeKnowledgeQueryResult });
      setNativeKnowledgePane(pane);
      return;
    }
    outcome = "ignored";
  } catch (error) {
    outcome = "failed";
    errorMessage = stringifyError(error);
    if (event.action === "extractGraph") {
      const documentId = event.documentId || event.pane.selectedDocument?.id;
      if (documentId) {
        updateNativeKnowledgeTask(buildDesktopKnowledgeGraphExtractionTaskOperation({
          documentId,
          documentName: stringValue(event.pane.selectedDocument?.title),
          status: "failed",
          stage: "failed",
          detail: "Knowledge graph extraction failed",
          completed: 0,
          total: 8,
          diagnostics: errorMessage,
        }));
        return;
      }
    }
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
  }, currentNativeKnowledgeTaskCenterItems());
  refreshNativeFileUploadActions();
}

function selectNativeKnowledgeGraphPayload(entityGraphPayload: unknown, documentGraphPayload: unknown): unknown {
  const entityGraph = asRecord(entityGraphPayload);
  if (asArrayValue(entityGraph.nodes).length || asArrayValue(entityGraph.edges).length) {
    return entityGraphPayload;
  }
  return documentGraphPayload;
}

function mergeNativeKnowledgeGraphPayload(graphPayload: unknown, graphragPayload: unknown): unknown {
  const graph = asRecord(graphPayload);
  const graphrag = asRecord(graphragPayload);
  const mergedGraph = {
    ...graph,
    communities: asArrayValue(graph.communities).length ? graph.communities : graphrag.communities,
    reports: asArrayValue(graph.reports).length ? graph.reports : graphrag.community_reports,
    claims: asArrayValue(graph.claims).length ? graph.claims : graphrag.covariates,
    conflicts: asArrayValue(graph.conflicts).length ? graph.conflicts : graphrag.conflicts,
  };
  if (asArrayValue(graph.nodes).length || asArrayValue(graph.edges).length) {
    return mergedGraph;
  }
  if (graphrag.object === "graphrag_index") {
    return graphrag;
  }
  return mergedGraph;
}

async function loadNativeToolsSkillsPane(
  selectedSkillName?: string,
  selectedSkillDetail?: unknown,
): Promise<DesktopToolsSkillsPaneModel> {
  logDesktopNativeDebug("toolsSkills.load.start", {
    selectedSkillName: selectedSkillName ?? "",
  });
  const [tools, skills, config] = await Promise.all([
    traceDesktopNativeDebugAsync("toolsSkills.load.tools.list", () => gatewayApi.tools.list(), {
      selectedSkillName: selectedSkillName ?? "",
    }),
    traceDesktopNativeDebugAsync("toolsSkills.load.skills.list", () => gatewayApi.skills.list(), {
      selectedSkillName: selectedSkillName ?? "",
    }),
    traceDesktopNativeDebugAsync("toolsSkills.load.config.get", () => gatewayApi.config.get(), {
      selectedSkillName: selectedSkillName ?? "",
    }),
  ]);
  nativeToolsPayload = tools;
  nativeSkillsPayload = skills;
  nativeToolsSkillsConfig = config;
  const skillRows = await traceDesktopNativeDebugAsync(
    "toolsSkills.load.skillRows.build",
    async () => buildDesktopSkillRows(skills, config),
    {
      selectedSkillName: selectedSkillName ?? "",
    },
  );
  const firstSkill = selectedSkillName || skillRows[0]?.name;
  const detail = selectedSkillDetail ?? (firstSkill
    ? await traceDesktopNativeDebugAsync(
      "toolsSkills.load.skills.detail",
      () => gatewayApi.skills.detail(firstSkill),
      { selectedSkillName: firstSkill },
    ).catch(() => null)
    : null);
  nativeToolsSkillsPane = await traceDesktopNativeDebugAsync(
    "toolsSkills.load.model.build",
    async () => buildDesktopToolsSkillsPaneModel({
      toolsPayload: tools,
      skillsPayload: skills,
      config,
      selectedSkillName: firstSkill,
      selectedSkillDetail: detail,
    }),
    {
      selectedSkillName: firstSkill ?? "",
    },
  );
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
      loadNativeSettingsConfig(),
      gatewayApi.config.providers(),
    ]);
    const providerCatalog = buildDesktopProviderCatalogItems(providersPayload);
    const state = applyDesktopSettingsLocalPreferences(
      buildDesktopSettingsFormState(config, providerCatalog),
      loadDesktopSettingsLocalPreferences(),
    );
    nativeSettingsConfig = config;
    syncTsCoworkRuntimeRollout(config);
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

async function loadNativeSettingsConfig(): Promise<unknown> {
  try {
    const snapshot = await invoke<NativeConfigEditorSnapshot>("get_config_editor_snapshot");
    const publicConfig = snapshot.effectivePublicConfig
      ?? snapshot.effective_public_config
      ?? snapshot.explicitPublicConfig
      ?? snapshot.explicit_public_config
      ?? {};
    return attachNativeConfigSnapshotMetadata(publicConfig, snapshot);
  } catch (error) {
    logDesktopNativeDebug("settings.configSnapshot.fallback", { error: stringifyError(error) });
    return gatewayApi.config.get();
  }
}

function attachNativeConfigSnapshotMetadata(config: unknown, snapshot: NativeConfigEditorSnapshot): unknown {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return config;
  }
  const revision = typeof snapshot.revision === "string" && snapshot.revision.trim()
    ? snapshot.revision
    : undefined;
  const configPath = typeof snapshot.configPath === "string"
    ? snapshot.configPath
    : typeof snapshot.config_path === "string"
      ? snapshot.config_path
      : undefined;
  return {
    ...(config as Record<string, unknown>),
    ...(revision ? { revision } : {}),
    configMetadata: {
      ...(revision ? { revision } : {}),
      ...(configPath ? { configPath } : {}),
      origins: snapshot.origins,
      diagnostics: snapshot.diagnostics,
      secretPresence: snapshot.secretPresence ?? snapshot.secret_presence,
    },
  };
}

async function handleNativeSettingsAction(event: DesktopSettingsActionEvent): Promise<void> {
  if (event.action === "retryLoad") {
    await retryLoadNativeSettingsPane();
    return;
  }
  if (event.action === "copyDiagnostics") {
    await copyNativeSettingsDiagnostics(event.pane.diagnostics?.runtimeSummary || event.pane.save.diagnostics || event.pane.save.message);
    return;
  }
  if (event.action === "restartGateway") {
    await handleNativeGatewayRuntimeAction({
      action: "restart",
      status: nativeRuntimeStatus,
      diagnostics: "",
    });
    return;
  }
  if (event.action === "reloadWorkspace") {
    await retryLoadNativeSettingsPane();
    scheduleNativeRuntimeStatusRefresh("settings.workspace.reload");
    logDesktopNativeDebug("settings.workspace.reload.requested");
    return;
  }
  if (event.action === "testProviderConnection") {
    logDesktopNativeDebug("settings.provider.test.requested", { providerId: event.providerId });
    return;
  }
  if (["chooseWorkspace", "openWorkspace", "openSessionFiles", "openKnowledgeDocuments"].includes(event.action)) {
    logDesktopNativeDebug("settings.files.action.requested", { action: event.action });
    return;
  }
  if (event.action === "setupChannelIntegrations") {
    logDesktopNativeDebug("settings.channels.action.requested", { action: event.action });
    return;
  }
  if (event.action === "resetLocalUiState") {
    clearDesktopSettingsLocalPreferences();
    if (nativeSettingsState) {
      nativeSettingsState = buildDesktopSettingsFormState(nativeSettingsConfig, nativeSettingsProviderCatalog);
      nativeSettingsLastSavedState = nativeSettingsState;
      updateNativeSettingsPane("idle");
    }
    logDesktopNativeDebug("settings.diagnostics.action.requested", { action: event.action });
    return;
  }
  if (["openDiagnosticsLogs", "exportDiagnosticsBundle", "clearDiagnosticsLogs"].includes(event.action)) {
    logDesktopNativeDebug("settings.diagnostics.action.requested", { action: event.action });
    return;
  }
  if (event.action === "setDiagnosticsLogLevel") {
    logDesktopNativeDebug("settings.diagnostics.log_level.requested", { logLevel: event.logLevel });
    return;
  }
  if (!nativeSettingsState) {
    logDesktopNativeDebug("settings.action.skipped", { action: event.action, reason: "state unavailable" });
    return;
  }
  logDesktopNativeDebug("settings.action.start", {
    action: event.action,
    fieldId: "fieldId" in event ? event.fieldId : undefined,
  });
  if (event.action === "edit") {
    if (event.fieldId === "selectedProvider") {
      saveDesktopSettingsLocalPreferences({ providerEditorSelectedProvider: String(event.value) });
    }
    nativeSettingsState = applyDesktopSettingsFieldEdit(nativeSettingsState, event.fieldId, event.value);
    if (event.commitMode === "auto") {
      updateNativeSettingsPane("idle");
      await saveNativeSettingsPane();
      logDesktopNativeDebug("settings.action.complete", { action: event.action, fieldId: event.fieldId, commitMode: event.commitMode });
      return;
    }
    updateNativeSettingsPane("idle");
    logDesktopNativeDebug("settings.action.complete", { action: event.action, fieldId: event.fieldId });
    return;
  }
  if (event.action === "reset") {
    nativeSettingsState = nativeSettingsLastSavedState;
    updateNativeSettingsPane("idle");
    logDesktopNativeDebug("settings.action.complete", { action: event.action });
    return;
  }
  if (event.action === "save") {
    await saveNativeSettingsPane();
    return;
  }
  if (event.action === "discoverModels") {
    await refreshNativeProviderModels(event.providerId);
  }
}

async function retryLoadNativeSettingsPane(): Promise<void> {
  logDesktopNativeDebug("settings.load.retry.start");
  const pane = await loadNativeSettingsPane();
  updateDesktopSettingsPane(document, pane, {
    onSettingsAction: (event) => {
      void handleNativeSettingsAction(event);
    },
  });
  syncNativeRuntimeMetadata();
  logDesktopNativeDebug("settings.load.retry.complete", { status: pane.save.status });
}

async function copyNativeSettingsDiagnostics(diagnostics: string): Promise<void> {
  const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  if (!clipboard?.writeText) {
    logDesktopNativeDebug("settings.diagnostics.copy.skipped", { reason: "clipboard unavailable" });
    return;
  }
  await clipboard.writeText(diagnostics || "No settings diagnostics");
  logDesktopNativeDebug("settings.diagnostics.copy.complete");
}

async function saveNativeSettingsPane(): Promise<void> {
  if (!nativeSettingsState) {
    logDesktopNativeDebug("settings.save.skipped", { reason: "state unavailable" });
    return;
  }
  logDesktopNativeDebug("settings.save.start");
  updateNativeSettingsPane("saving");
  try {
    const savePatch = buildDesktopSettingsSavePatch(
      nativeSettingsState,
      nativeSettingsConfig,
      nativeSettingsProviderCatalog,
    );
    if (!savePatch.ok) {
      const invalidFields = savePatch.validationErrors.map((error) => error.field).join(", ");
      updateNativeSettingsPane("failed", `Settings validation failed: ${invalidFields}`);
      logDesktopNativeDebug("settings.save.validationFailed", { fields: savePatch.validationErrors.map((error) => error.field) });
      return;
    }
    const saveResult = await saveDesktopSettingsConfig(nativeSettingsConfig, savePatch.patch, {
      applyNativeConfigPatch,
      applyGatewayConfigPatch: (fallbackPatch) => gatewayApi.config.patch(fallbackPatch),
      onNativeFallback: (fallbackError) => {
        logDesktopNativeDebug("settings.save.nativeFallback", { error: stringifyError(fallbackError) });
      },
    });
    const effectiveConfig = saveResult.config;
    const reconciled = reconcileDesktopSettingsSavedState(nativeSettingsState, effectiveConfig, nativeSettingsProviderCatalog);
    if (!reconciled.ok) {
      updateNativeSettingsPane("failed", `Saved settings did not apply: ${reconciled.mismatchedPaths.join(", ")}`);
      logDesktopNativeDebug("settings.save.reconcileFailed", { paths: reconciled.mismatchedPaths });
      return;
    }
    nativeSettingsConfig = attachPersistedConfigRevision(effectiveConfig, saveResult.persistedRevision);
    syncTsCoworkRuntimeRollout(nativeSettingsConfig);
    nativeSettingsState = reconciled.state;
    nativeSettingsLastSavedState = nativeSettingsState;
    updateNativeSettingsPane("saved", undefined, buildNativeSettingsPaneSaveDetails(saveResult));
    logDesktopNativeDebug("settings.save.complete", {
      transport: saveResult.transport,
      updatedFields: saveResult.updatedFields,
      applied: saveResult.applied,
      restartRequired: saveResult.restartRequired,
      reloadRequired: saveResult.reloadRequired,
      warnings: saveResult.warnings,
    });
  } catch (error) {
    const message = stringifyError(error);
    updateNativeSettingsPane("failed", `Failed to save settings: ${message}`);
    logDesktopNativeDebug("settings.save.failed", { error: message });
  }
}

function attachPersistedConfigRevision(config: unknown, revision: string | undefined): unknown {
  if (!revision || !config || typeof config !== "object" || Array.isArray(config)) {
    return config;
  }
  const record = config as Record<string, unknown>;
  const existingMetadata = record.configMetadata;
  return {
    ...record,
    revision,
    configMetadata: {
      ...(existingMetadata && typeof existingMetadata === "object" && !Array.isArray(existingMetadata)
        ? existingMetadata as Record<string, unknown>
        : {}),
      revision,
    },
  };
}

async function refreshNativeProviderModels(providerId?: string): Promise<void> {
  if (!nativeSettingsState) {
    logDesktopNativeDebug("settings.providerModels.skipped", { reason: "state unavailable" });
    return;
  }
  const nextProviderId = providerId?.trim();
  if (nextProviderId && nextProviderId !== nativeSettingsState.providerEditor.selectedProvider) {
    saveDesktopSettingsLocalPreferences({ providerEditorSelectedProvider: nextProviderId });
    nativeSettingsState = applyDesktopSettingsFieldEdit(nativeSettingsState, "selectedProvider", nextProviderId);
    updateNativeSettingsPane("idle");
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

function syncTsCoworkRuntimeRollout(config: unknown): void {
  gatewayClientOptions.tsCoworkRuntime = resolveTsCoworkRuntimeRollout(config);
  logDesktopNativeDebug("cowork.rollout.sync", gatewayClientOptions.tsCoworkRuntime);
}

function updateNativeSettingsPane(
  saveStatus: "idle" | "saving" | "saved" | "failed",
  saveError?: string,
  saveDetails?: DesktopSettingsPaneSaveDetails | null,
): void {
  if (!nativeSettingsState) {
    return;
  }
  updateDesktopSettingsPane(document, buildDesktopSettingsPaneModel(nativeSettingsState, {
    lastSavedState: nativeSettingsLastSavedState,
    providerCatalog: nativeSettingsProviderCatalog,
    saveStatus,
    saveError,
    saveDetails,
  }), {
    onSettingsAction: (event) => {
      void handleNativeSettingsAction(event);
    },
  });
  syncNativeRuntimeMetadata();
}

function currentNativeSettingsPane(): DesktopSettingsPaneModel | null {
  if (!nativeSettingsState) {
    return null;
  }
  return buildDesktopSettingsPaneModel(nativeSettingsState, {
    lastSavedState: nativeSettingsLastSavedState,
    providerCatalog: nativeSettingsProviderCatalog,
    saveStatus: "idle",
  });
}

function buildNativeSettingsPaneSaveDetails(saveResult: DesktopSettingsSaveResult): DesktopSettingsPaneSaveDetails {
  return {
    transport: saveResult.transport,
    persistedRevision: saveResult.persistedRevision,
    updatedFields: saveResult.updatedFields,
    applied: saveResult.applied,
    restartRequired: saveResult.restartRequired,
    reloadRequired: saveResult.reloadRequired,
    warnings: saveResult.warnings,
  };
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

function installNativeWorkspaceFileActions(): Promise<void> {
  return installDesktopWorkspaceFileActions({
    listWorkspaceFiles: () => gatewayApi.workspace.files(),
    loadWorkspaceFile: (path) => gatewayApi.workspace.file(path),
    saveWorkspaceFile: (path, body) => gatewayApi.workspace.putFile(path, body),
    revealWorkspaceFile: (path) => invoke("reveal_workspace_file", { path }),
    exportWorkspaceFile: (options) => invoke("save_export_file", { options }),
    onFileTaskUpdated: updateNativeFileTask,
  });
}

let nativeFileUploadActions: DesktopFileUploadActions | null = null;

function installNativeFileUploadActions(): void {
  nativeFileUploadActions = {
    pickFile: (kind: DesktopUploadKind) =>
      invoke<DesktopPickedUploadFile | null>("pick_upload_file", {
        options: desktopUploadPickerOptions(kind),
    }),
    uploadKnowledgeDocument: (form) => gatewayApi.knowledge.uploadDocument(form),
    onKnowledgeTaskUpdated: updateNativeKnowledgeTask,
    onKnowledgeUploaded: async () => {
      const pane = await loadNativeKnowledgePane({
        queryResultPayload: nativeKnowledgeQueryResult,
        selectedDocumentId: nativeKnowledgePane?.selectedDocument?.id,
      });
      setNativeKnowledgePane(pane);
    },
    uploadSessionTemporaryFile: (sessionKey, form) => gatewayApi.sessions.uploadTemporaryFile(sessionKey, form),
    listSessionTemporaryFiles: (sessionKey) => gatewayApi.sessions.temporaryFiles(sessionKey),
    getSessionKey: () => nativeWorkbenchRuntime?.chat.activeSessionKey ?? "",
    uploadWorkspaceFile: (path, body) => gatewayApi.workspace.putFile(path, body),
  };
  refreshNativeFileUploadActions();
}

function refreshNativeFileUploadActions(): void {
  if (!nativeFileUploadActions) {
    return;
  }
  installDesktopFileUploadActions(nativeFileUploadActions);
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

async function pollNativeKnowledgeGraphExtractionJob(jobId: string, selectedDocumentId: string): Promise<void> {
  for (let attempt = 0; attempt < 1800; attempt += 1) {
    try {
      const job = await gatewayApi.knowledge.job(jobId);
      const operation = buildDesktopKnowledgeTaskOperation(job);
      if (operation) {
        updateNativeKnowledgeTask(operation);
      }
      const jobRecord = asRecord(job);
      const status = stringValue(jobRecord.status || asRecord(jobRecord.job)?.status);
      if (status === "completed" || status === "failed" || status === "cancelled") {
        const pane = await loadNativeKnowledgePane({
          queryResultPayload: nativeKnowledgeQueryResult,
          selectedDocumentId,
        });
        setNativeKnowledgePane(pane);
        return;
      }
    } catch (error) {
      logDesktopNativeDebug("knowledge.graph_extract.poll.failed", {
        jobId,
        selectedDocumentId,
        error: stringifyError(error),
      });
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 2000));
  }
  logDesktopNativeDebug("knowledge.graph_extract.poll.timeout", { jobId, selectedDocumentId });
}

function buildDesktopKnowledgeGraphExtractionTaskOperation(input: {
  documentId: string;
  documentName: string;
  status: string;
  stage: string;
  detail: string;
  completed: number;
  total: number;
  tokenEstimate?: Record<string, unknown>;
  extractionScope?: Record<string, unknown>;
  diagnostics?: string;
}): DesktopTaskSourceOperation {
  const name = input.documentName || input.documentId;
  const tokenTotal = stringValue(input.tokenEstimate?.total_tokens || input.tokenEstimate?.totalTokens);
  const tokenMax = stringValue(input.tokenEstimate?.max_tokens || input.tokenEstimate?.maxTokens);
  const chunkCount = stringValue(input.extractionScope?.chunk_count || input.extractionScope?.chunkCount);
  const originalChunkCount = stringValue(input.extractionScope?.original_chunk_count || input.extractionScope?.originalChunkCount);
  const diagnostics = input.diagnostics || [
    `${name}: ${input.stage}`,
    `${input.completed}/${input.total} stages`,
    tokenTotal && tokenMax ? `${tokenTotal}/${tokenMax} tokens` : "",
    chunkCount && originalChunkCount ? `${chunkCount}/${originalChunkCount} chunks` : "",
  ].filter(Boolean).join(", ");
  return {
    id: `knowledge:kjob_extract_graph_${input.documentId}`,
    title: "Extract knowledge graph",
    status: input.status,
    detail: `${input.detail} / ${input.stage} / 1 document: ${input.completed}/${input.total} stages`,
    progress: { completed: input.completed, total: input.total },
    canonical: { module: "knowledge", entityId: input.documentId, href: "/knowledge" },
    diagnostics,
    retryable: false,
    updatedAt: "",
  };
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

function installNativeRuntimeStatusEventRouting(): void {
  if (!hasTauriRuntime() || nativeRuntimeStatusEventsInstalled) {
    return;
  }
  nativeRuntimeStatusEventsInstalled = true;
  void listen(toDesktopNativeTauriEventName("diagnostics.log"), () => {
    scheduleNativeRuntimeStatusRefresh("diagnostics.log");
  });
  void listen(toDesktopNativeTauriEventName("worker.status"), () => {
    scheduleNativeRuntimeStatusRefresh("worker.status");
  });
}

function scheduleNativeRuntimeStatusRefresh(reason: string): void {
  if (nativeRuntimeStatusRefreshTimer !== null) {
    nativeRuntimeStatusRefreshPending = true;
    return;
  }
  nativeRuntimeStatusRefreshTimer = window.setTimeout(() => {
    nativeRuntimeStatusRefreshTimer = null;
    void refreshNativeRuntimeStatus(reason);
  }, 250);
}

async function refreshNativeRuntimeStatus(reason: string): Promise<void> {
  if (nativeRuntimeStatusRefreshInFlight) {
    nativeRuntimeStatusRefreshPending = true;
    return;
  }
  nativeRuntimeStatusRefreshInFlight = true;
  try {
    const nextStatus = await invokeGatewayRuntimeCommand("gateway_status");
    nativeRuntimeStatus = nextStatus;
    updateDesktopGatewayRuntimeStatus(document, nextStatus, gatewayConfig.httpBaseUrl, {
      onGatewayRuntimeAction: (nextEvent) => {
        void handleNativeGatewayRuntimeAction(nextEvent);
      },
    });
    setDesktopWindowRuntimeStatus(nextStatus);
    updateNativeGatewayTask(buildDesktopGatewayTaskOperation("startup", nextStatus));
    logDesktopNativeDebug("gatewayRuntime.status.refresh", {
      reason,
      workerDiagnostics: nextStatus.worker_runtime?.diagnostics?.length ?? 0,
      runtimeLogs: nextStatus.logs.length,
    });
  } catch (error) {
    logDesktopNativeDebug("gatewayRuntime.status.refresh.failed", {
      reason,
      error: stringifyError(error),
    });
  } finally {
    nativeRuntimeStatusRefreshInFlight = false;
    if (nativeRuntimeStatusRefreshPending) {
      nativeRuntimeStatusRefreshPending = false;
      scheduleNativeRuntimeStatusRefresh(reason);
    }
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
    command: previousStatus?.command ?? "node workers/ts-agent-worker/src/index.ts",
    port: previousStatus?.port ?? 18790,
    repo_root: previousStatus?.repo_root ?? "",
    logs: [...(previousStatus?.logs ?? []), `error: ${message}`].slice(-12),
    last_error: message,
    exit_policy: previousStatus?.exit_policy ?? "stop_on_exit",
  };
}

async function refreshNativeApprovalTasks(): Promise<void> {
  const approvalOptions = nativeApprovalRefreshOptions({
    activeChatId: nativeWorkbenchRuntime?.chat.activeChatId,
    activeSessionKey: nativeWorkbenchRuntime?.chat.activeSessionKey,
  });
  logDesktopNativeDebug("approvals.refresh.start", {
    activeChatId: nativeWorkbenchRuntime?.chat.activeChatId ?? "",
    hasSessionKey: Boolean(nativeWorkbenchRuntime?.chat.activeSessionKey),
    mode: approvalOptions ? "session" : "skipped",
  });
  if (!approvalOptions) {
    logDesktopNativeDebug("approvals.refresh.skipped", {
      reason: "missing active chat context",
    });
    return;
  }
  try {
    const payload = await gatewayApi.tools.approvals(approvalOptions);
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

function currentNativeKnowledgeTaskCenterItems() {
  return currentNativeTaskCenterItems().filter((item) => item.destination.module === "knowledge");
}

function publishNativeTaskCenterItems(): void {
  const items = currentNativeTaskCenterItems();
  updateDesktopTaskCenterItems(document, items, nativeTaskActions());
  void nativeTaskNotifications.update(items);
}

function hasTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

function installTauriMenuCommandRouting(
  options: { routeDocsInWorkbench?: boolean } = {},
): void {
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
    routeDocsInWorkbench: options.routeDocsInWorkbench,
  });
}

function installTauriNavigation(
  options: { routeDocsInWorkbench?: boolean } = {},
): void {
  if (!hasTauriRuntime()) {
    return;
  }
  installDesktopNavigation({
    gatewayOrigin: gatewayConfig.httpBaseUrl,
    openExternal: (href) => openUrl(href),
    routeDocsInWorkbench: options.routeDocsInWorkbench,
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
