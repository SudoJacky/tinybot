import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import webUiHtml from "../../../webui/index.html?raw";
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
import { installDesktopNavigation } from "./desktopNavigation";
import { createDesktopOsNotificationBridge } from "./desktopOsNotifications";
import {
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
  updateDesktopCoworkPane,
  updateDesktopKnowledgePane,
  updateDesktopSettingsPane,
  updateDesktopTaskCenterItems,
  updateDesktopToolsSkillsPane,
  type DesktopCoworkActionEvent,
  type DesktopCoworkPaneModel,
  type DesktopGatewayRuntimeActionEvent,
  type DesktopKnowledgeActionEvent,
  type DesktopSettingsActionEvent,
  type DesktopToolsSkillsActionEvent,
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
      const settingsPane = await loadNativeSettingsPane();
      const knowledgePane = await loadNativeKnowledgePane();
      const toolsSkillsPane = await loadNativeToolsSkillsPane();
      const coworkPane = await loadNativeCoworkPane();
      installDesktopWorkbenchShell({
        runtimeStatus: status,
        gatewayHttp: gatewayConfig.httpBaseUrl,
        taskCenterItems: currentNativeTaskCenterItems(),
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

async function loadNativeKnowledgePane(
  options: { queryResultPayload?: unknown; selectedDocumentId?: string | null } = {},
): Promise<DesktopKnowledgePaneModel> {
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
  return nativeKnowledgePane;
}

async function loadNativeCoworkPane(
  options: { selectedSessionId?: string | null; actionStatus?: string; summaryText?: string } = {},
): Promise<DesktopCoworkPaneModel> {
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
    return nativeCoworkPane;
  }
  const session = await gatewayApi.cowork.session(selectedSessionId).catch(() => null);
  nativeCoworkPane = {
    sessionRows,
    cockpitView: session ? buildDesktopCoworkCockpitView(session) : null,
    actionStatus: options.actionStatus,
    summaryText: options.summaryText,
  };
  return nativeCoworkPane;
}

async function handleNativeCoworkAction(event: DesktopCoworkActionEvent): Promise<void> {
  const sessionId = event.sessionId || nativeCoworkSelectedSessionId;
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
    setNativeCoworkPane({
      ...event.pane,
      actionStatus: `Cowork ${event.action} failed: ${stringifyError(error)}`,
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
    }
  } catch (error) {
    updateNativeKnowledgeTask({
      id: `knowledge:action:${event.action}`,
      title: `Knowledge ${event.action}`,
      status: "failed",
      detail: "Knowledge action failed",
      canonical: { module: "knowledge", entityId: event.pane.selectedDocument?.id, href: "/knowledge" },
      diagnostics: stringifyError(error),
      retryable: true,
      updatedAt: new Date().toISOString(),
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
  return nativeToolsSkillsPane;
}

async function handleNativeToolsSkillsAction(event: DesktopToolsSkillsActionEvent): Promise<void> {
  const skill = event.pane.selectedSkill;
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
    return;
  }
  const draft = skill.editor.draft;
  try {
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
  } catch (error) {
    setNativeToolsSkillsPane(buildNativeToolsSkillsPaneFromEditor(skill, {
      saveStatus: "failed",
      saveError: `Skill action failed: ${stringifyError(error)}`,
    }));
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
    return;
  }
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
  } catch (error) {
    updateNativeSettingsPane("failed", `Failed to save settings: ${stringifyError(error)}`);
  }
}

async function refreshNativeProviderModels(): Promise<void> {
  if (!nativeSettingsState) {
    return;
  }
  const request = buildDesktopProviderModelRequest(nativeSettingsState);
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
  } catch (error) {
    const message = stringifyError(error);
    updateNativeSettingsPane("failed", `Failed to refresh provider models: ${message}`);
    updateNativeProviderTask(buildDesktopProviderModelDiscoveryTaskOperation({
      provider: request.provider,
      profile: request.profile,
      status: "failed",
      error: message,
    }));
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

function updateNativeProviderTask(operation: DesktopTaskSourceOperation): void {
  nativeProviderTaskOperations.set(operation.id, operation);
  publishNativeTaskCenterItems();
}

function updateNativeGatewayTask(operation: DesktopTaskSourceOperation): void {
  nativeGatewayTaskOperations.set(operation.id, operation);
  publishNativeTaskCenterItems();
}

async function handleNativeGatewayRuntimeAction(event: DesktopGatewayRuntimeActionEvent): Promise<void> {
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

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}
