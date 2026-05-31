import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import webUiHtml from "../../../webui/index.html?raw";
import { buildDesktopCoworkSessionRows, buildDesktopCoworkTaskOperations } from "./desktopCowork";
import { installDesktopCommandPalette, type DesktopCommandPaletteInput } from "./desktopCommandPalette";
import { installDesktopMenuCommandRouting } from "./desktopCommandNavigation";
import type { GatewayRuntimeStatus } from "./desktopGatewayStartup";
import { ensureGatewayReady } from "./desktopGatewayStartup";
import { installDesktopGatewayBridge } from "./desktopGatewayBridge";
import { buildDesktopKnowledgeDocumentRows } from "./desktopKnowledgeTraceability";
import { installWebUiRenderGlobals } from "./desktopMarkdownGlobals";
import { installDesktopNavigation } from "./desktopNavigation";
import { createDesktopOsNotificationBridge } from "./desktopOsNotifications";
import { bindStartupRetry, setStartupState } from "./desktopStartupView";
import { buildDesktopTaskCenterItems, type DesktopTaskSourceOperation } from "./desktopTaskCenter";
import { createDesktopTaskNotificationController } from "./desktopTaskNotifications";
import { runDesktopGatewayRuntimeCommand, type DesktopGatewayRuntimeCommand } from "./desktopGatewayRuntimeControls";
import {
  buildDesktopApprovalTaskOperations,
  buildDesktopGatewayTaskOperation,
} from "./desktopTaskCenterSources";
import { buildDesktopSkillRows, buildDesktopToolRows } from "./desktopToolsSkills";
import {
  installDesktopWorkbenchShell,
  updateDesktopGatewayRuntimeStatus,
  updateDesktopTaskCenterItems,
  type DesktopGatewayRuntimeActionEvent,
} from "./desktopWorkbenchShell";
import { installDesktopWorkspaceFileActions } from "./desktopWorkspaceFiles";
import { buildDesktopWorkspaceFileRows } from "./desktopWorkspaceFiles";
import { installWebUiShell } from "./desktopWebUiShell";
import { resolveDesktopWorkbenchStartupMode } from "./desktopWorkbenchGate";
import { installDesktopWindowFrame, setDesktopWindowRuntimeStatus } from "./desktopWindowFrame";
import { DEFAULT_GATEWAY_CONFIG, resolveGatewayConfig } from "./gatewayConfig";
import { createGatewayApiClient } from "./gatewayHttpClient";
import { normalizeSessionsPayload } from "./nativeChat";
import {
  desktopUploadPickerOptions,
  installDesktopFileUploadActions,
  type DesktopPickedUploadFile,
  type DesktopUploadKind,
} from "./desktopFileUpload";

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
  setStartupState(document, "Starting local gateway...", null, false);
  try {
    const status = await ensureGatewayReady(gatewayConfig, { invoke, hasTauriRuntime });
    nativeRuntimeStatus = status;
    updateNativeGatewayTask(buildDesktopGatewayTaskOperation("startup", status));
    const workbenchMode = resolveDesktopWorkbenchStartupMode();
    document.documentElement.dataset.desktopWorkbenchMode = workbenchMode.mode;
    document.documentElement.dataset.desktopWorkbenchRequestedMode = workbenchMode.requestedMode;
    if (workbenchMode.fallbackReason) {
      console.info("Tinybot desktop loading root WebUI fallback", workbenchMode);
    }
    installDesktopGatewayBridge({ config: gatewayConfig });
    installWebUiRenderGlobals();
    if (workbenchMode.mode === "native-workbench") {
      installDesktopWorkbenchShell({
        runtimeStatus: status,
        gatewayHttp: gatewayConfig.httpBaseUrl,
        taskCenterItems: currentNativeTaskCenterItems(),
        gatewayActions: {
          onGatewayRuntimeAction: (event) => {
            void handleNativeGatewayRuntimeAction(event);
          },
        },
      });
      installNativeFileUploadActions();
      installNativeWorkspaceFileActions();
      installNativeCommandPalette();
      installTauriNavigation();
      installTauriMenuCommandRouting();
      installTauriWindowFrame(status);
      void refreshNativeCoworkTasks();
      void refreshNativeApprovalTasks();
      console.info("Tinybot desktop native workbench initialized", status);
      return;
    }
    installWebUiShell(webUiHtml);
    installTauriNavigation();
    installTauriWindowFrame(status);
    await import(/* @vite-ignore */ WEBUI_ENTRY);
    console.info("Tinybot desktop WebUI initialized", status);
  } catch (error) {
    setStartupState(
      document,
      "Tinybot gateway is not ready.",
      `${stringifyError(error)}\n\nGateway: ${gatewayConfig.httpBaseUrl}`,
      true,
    );
  }
}

function installNativeCommandPalette(): void {
  installDesktopCommandPalette({
    gatewayOrigin: gatewayConfig.httpBaseUrl,
    loadData: loadNativeCommandPaletteData,
  });
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
    uploadWorkspaceFile: (path, body) => gatewayApi.workspace.putFile(path, body),
  });
}

function updateNativeKnowledgeTask(operation: DesktopTaskSourceOperation): void {
  nativeKnowledgeTaskOperations.set(operation.id, operation);
  publishNativeTaskCenterItems();
}

function updateNativeFileTask(operation: DesktopTaskSourceOperation): void {
  nativeFileTaskOperations.set(operation.id, operation);
  publishNativeTaskCenterItems();
}

function updateNativeGatewayTask(operation: DesktopTaskSourceOperation): void {
  nativeGatewayTaskOperations.set(operation.id, operation);
  publishNativeTaskCenterItems();
}

async function handleNativeGatewayRuntimeAction(event: DesktopGatewayRuntimeActionEvent): Promise<void> {
  try {
    const nextStatus = await runDesktopGatewayRuntimeCommand(event.action, event.status, {
      runCommand: (command) => invokeGatewayRuntimeCommand(command),
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
  } catch (error) {
    const failedStatus = failedGatewayRuntimeStatus(event.status ?? nativeRuntimeStatus, stringifyError(error));
    nativeRuntimeStatus = failedStatus;
    updateDesktopGatewayRuntimeStatus(document, failedStatus, gatewayConfig.httpBaseUrl, {
      onGatewayRuntimeAction: (nextEvent) => {
        void handleNativeGatewayRuntimeAction(nextEvent);
      },
    });
    setDesktopWindowRuntimeStatus(failedStatus);
    updateNativeGatewayTask(buildDesktopGatewayTaskOperation(gatewayTaskActionForRuntimeAction(event.action), failedStatus));
  }
}

function invokeGatewayRuntimeCommand(command: DesktopGatewayRuntimeCommand): Promise<GatewayRuntimeStatus> {
  return invoke<GatewayRuntimeStatus>(command);
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
  try {
    const payload = await gatewayApi.tools.approvals();
    nativeApprovalTaskOperations.clear();
    for (const operation of buildDesktopApprovalTaskOperations(payload)) {
      nativeApprovalTaskOperations.set(operation.id, operation);
    }
    publishNativeTaskCenterItems();
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
  }
}

async function refreshNativeCoworkTasks(): Promise<void> {
  try {
    const payload = await gatewayApi.cowork.sessions({ includeCompleted: true });
    replaceNativeCoworkTasks(payload);
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
  }
}

function replaceNativeCoworkTasks(payload: unknown): void {
  nativeCoworkTaskOperations.clear();
  for (const operation of buildDesktopCoworkTaskOperations(payload)) {
    nativeCoworkTaskOperations.set(operation.id, operation);
  }
  publishNativeTaskCenterItems();
}

function updateNativeCoworkTask(operation: DesktopTaskSourceOperation): void {
  nativeCoworkTaskOperations.set(operation.id, operation);
  publishNativeTaskCenterItems();
}

function currentNativeTaskCenterItems() {
  return buildDesktopTaskCenterItems({
    knowledgeJobs: Array.from(nativeKnowledgeTaskOperations.values()),
    coworkRuns: Array.from(nativeCoworkTaskOperations.values()),
    providerRefreshes: Array.from(nativeProviderTaskOperations.values()),
    fileOperations: Array.from(nativeFileTaskOperations.values()),
    gatewayOperations: Array.from(nativeGatewayTaskOperations.values()),
    approvals: Array.from(nativeApprovalTaskOperations.values()),
  });
}

function publishNativeTaskCenterItems(): void {
  const items = currentNativeTaskCenterItems();
  updateDesktopTaskCenterItems(document, items);
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
  installDesktopWindowFrame({ currentWindow: getCurrentWindow() });
  if (runtimeStatus !== undefined) {
    setDesktopWindowRuntimeStatus(runtimeStatus);
  }
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
