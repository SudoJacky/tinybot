import hljs from "highlight.js";
import { marked } from "marked";
import { isAgentUiFormSubmittable, type AgentUiForm, type AgentUiFormField } from "../agent-ui/agentUiEvents";
import type { GatewayRuntimeStatus } from "../gateway/desktopGatewayStartup";
import {
  buildDesktopGatewayRuntimeActions,
  buildDesktopGatewayRuntimeDiagnostics,
  buildDesktopGatewayRuntimeRows,
  type DesktopGatewayRuntimeActionId,
} from "../gateway/desktopGatewayRuntimeControls";
import {
  DESKTOP_SHORTCUT_HELP_ITEMS,
  buildDesktopPageHelpText,
  resolveDesktopVisibleHelpTargets,
} from "./desktopHelp";
import {
  buildDesktopCoworkTaskOperation,
  buildDesktopCoworkCockpitView,
  DEFAULT_COWORK_AGENT_ACTIVITY_LIMIT,
  type DesktopCoworkCockpitView,
  type DesktopCoworkActionInput,
  type DesktopCoworkSelectionType,
  type DesktopCoworkSessionRow,
} from "../cowork/desktopCowork";
import type { DesktopKnowledgePaneModel } from "../knowledge/desktopKnowledgeTraceability";
import type { DesktopSettingsPaneModel } from "../settings/desktopSettingsProviders";
import type { DesktopSkillEditorField, DesktopToolsSkillsPaneModel } from "../tools-skills/desktopToolsSkills";
import {
  buildDesktopRunChainSummary,
  createDesktopRunChainInspectorView,
  type DesktopInspectorView,
  type DesktopRunChainItem,
} from "./desktopRunChainInspector";
import {
  buildDesktopTaskCenterItems,
  type DesktopTaskActionId,
  type DesktopTaskCenterAction,
  type DesktopTaskCenterItem,
  type DesktopTaskSource,
} from "../tasks/desktopTaskCenter";
import {
  buildDesktopWorkLensProjection,
  DesktopWorkLensActionId,
  type DesktopWorkLensProjection,
  type DesktopWorkLensRelatedResource,
} from "./desktopWorkLens";
import type { WorkbenchLayoutState, WorkbenchPanelId, WorkbenchPanelState } from "./desktopWorkbenchLayout";
import { loadWorkbenchLayout } from "./desktopWorkbenchLayout";
import { installDesktopDesignTokens } from "./desktopDesignTokens";
import { logDesktopNativeChatDebug, logDesktopNativeDebug, summarizeDebugText } from "../native/desktopNativeChatDebug";
import { createNativeChatState, type NativeChatMessage, type NativeChatSession } from "../chat/nativeChat";
import { projectNativeChatState, type ChatUiProjection, type LiveSubagent, type SubagentStatus } from "../chat/chatUiProjection";
import { mountAgentUiFormActionsIsland } from "../components/agent-ui/agentUiFormActionsIsland";
import { mountAgentUiFormCardIsland } from "../components/agent-ui/agentUiFormCardIsland";
import { mountAgentUiFormFieldIsland } from "../components/agent-ui/agentUiFormFieldIsland";
import { mountAgentUiFormsSurfaceIsland } from "../components/agent-ui/agentUiFormsSurfaceIsland";
import { mountBottomRegionIsland } from "../components/shell/bottomRegionIsland";
import { mountActivityRailIsland } from "../components/shell/activityRailIsland";
import { mountChatMenuActionIsland } from "../components/chat/chatMenuActionIsland";
import { mountChatMenuButtonIsland } from "../components/chat/chatMenuButtonIsland";
import { mountChatMenuEmptyIsland } from "../components/chat/chatMenuEmptyIsland";
import { mountChatMenuPopoverIsland } from "../components/chat/chatMenuPopoverIsland";
import { mountChatTitleIsland } from "../components/chat/chatTitleIsland";
import { mountChatSurface } from "../components/chat/chatSurface";
import { mountChatWorkbenchIsland } from "../components/chat/chatWorkbenchIsland";
import { mountCommandPaletteIsland } from "../components/shared/commandPaletteIsland";
import { mountComposerAttachButtonIsland } from "../components/chat/composerAttachButtonIsland";
import { mountComposerModelControlIsland } from "../components/chat/composerModelControlIsland";
import { mountComposerRuntimeIsland } from "../components/chat/composerRuntimeIsland";
import { mountComposerSendButtonIsland } from "../components/chat/composerSendButtonIsland";
import { mountOrUpdateComposerSurfaceIsland } from "../components/chat/composerSurfaceIsland";
import { mountConversationAttachmentIsland } from "../components/chat/conversationAttachmentIsland";
import { mountConversationBodyIsland } from "../components/chat/conversationBodyIsland";
import { mountConversationMessageIsland } from "../components/chat/conversationMessageIsland";
import { mountConversationMetaIsland } from "../components/chat/conversationMetaIsland";
import { mountConversationReasoningIsland } from "../components/chat/conversationReasoningIsland";
import { mountConversationReferenceIsland } from "../components/chat/conversationReferenceIsland";
import {
  type ConversationCoworkRunOptions,
  type DelegateArtifactLoadSelection,
  type DelegateTraceLoadSelection,
} from "../components/chat/conversationThreadIsland";
import { mountCoworkActionsIsland } from "../components/cowork/coworkActionsIsland";
import { mountCoworkDataRowIsland } from "../components/cowork/coworkDataRowIsland";
import { mountCoworkGraphIsland } from "../components/cowork/coworkGraphIsland";
import { mountCoworkHeaderIsland } from "../components/cowork/coworkHeaderIsland";
import { mountCoworkInspectorIsland } from "../components/cowork/coworkInspectorIsland";
import { mountCoworkLimitStatusIsland } from "../components/cowork/coworkLimitStatusIsland";
import { mountCoworkObservabilityIsland } from "../components/cowork/coworkObservabilityIsland";
import { mountCoworkPaneIsland } from "../components/cowork/coworkPaneIsland";
import { mountCoworkSessionsIsland } from "../components/cowork/coworkSessionsIsland";
import { mountCoworkTaskFeedIsland } from "../components/cowork/coworkTaskFeedIsland";
import { mountFileActionsSurfaceIsland } from "../components/workspace/fileActionsSurfaceIsland";
import { mountFileImportCardIsland } from "../components/workspace/fileImportCardIsland";
import { mountFileOperationStatusIsland } from "../components/workspace/fileOperationStatusIsland";
import { mountFileUploadStatusIsland } from "../components/workspace/fileUploadStatusIsland";
import { mountFormatChipListIsland } from "../components/shell/formatChipListIsland";
import { mountGatewayRuntimeIsland } from "../components/gateway/gatewayRuntimeIsland";
import { mountHelpSurfaceIsland } from "../components/shell/helpSurfaceIsland";
import { mountInspectorRegionIsland } from "../components/shell/inspectorRegionIsland";
import { mountInspectorViewIsland } from "../components/shell/inspectorViewIsland";
import { mountKnowledgeDocumentDetailIsland } from "../components/knowledge/knowledgeDocumentDetailIsland";
import { mountKnowledgeDocumentsIsland } from "../components/knowledge/knowledgeDocumentsIsland";
import { mountKnowledgeGraphIsland } from "../components/knowledge/knowledgeGraphIsland";
import { mountKnowledgePaneIsland } from "../components/knowledge/knowledgePaneIsland";
import { mountKnowledgeReadinessIsland } from "../components/knowledge/knowledgeReadinessIsland";
import { mountMainUtilitiesRegionIsland } from "../components/shell/mainUtilitiesRegionIsland";
import { mountModuleWorkSectionIsland } from "../components/shell/moduleWorkSectionIsland";
import { mountPersistentRagToggleIsland } from "../components/knowledge/persistentRagToggleIsland";
import { mountRecentChatRowIsland } from "../components/chat/recentChatRowIsland";
import { mountRunChainInspectorIsland } from "../components/shell/runChainInspectorIsland";
import { mountRunChainOverviewIsland } from "../components/shell/runChainOverviewIsland";
import { mountSidebarActionsIsland } from "../components/shell/sidebarActionsIsland";
import { mountSidebarContentIsland } from "../components/shell/sidebarContentIsland";
import { mountSidebarRecentChatsIsland, type SidebarRecentChatRow } from "../components/shell/sidebarRecentChatsIsland";
import { mountSidebarRowIsland } from "../components/shell/sidebarRowIsland";
import { mountSidebarSectionHeadingIsland } from "../components/shell/sidebarSectionHeadingIsland";
import { mountOrUpdateSettingsPaneIsland } from "../components/settings/settingsPaneIsland";
import { mountSettingsPaneIsland } from "../components/settings/settingsPaneIsland";
import { mountOrUpdateSessionFileListIsland } from "../components/chat/sessionFileListIsland";
import { mountSessionUploadCardIsland } from "../components/chat/sessionUploadCardIsland";
import { mountShortcutHelpDialogIsland } from "../components/shell/shortcutHelpDialogIsland";
import { mountSkillEditorIsland } from "../components/tools-skills/skillEditorIsland";
import { mountSkillDetailSummaryIsland } from "../components/tools-skills/skillDetailSummaryIsland";
import { mountSkillsListIsland } from "../components/tools-skills/skillsListIsland";
import { mountStatusStripIsland } from "../components/shell/statusStripIsland";
import { mountTaskActionIsland } from "../components/tasks/taskActionIsland";
import { mountTaskCenterIsland } from "../components/tasks/taskCenterIsland";
import { mountTaskStateBadgeIsland } from "../components/tasks/taskStateBadgeIsland";
import { mountToolDetailIsland } from "../components/tools-skills/toolDetailIsland";
import { mountToolActivitiesIsland } from "../components/tools-skills/toolActivitiesIsland";
import { mountToolActivityIsland } from "../components/tools-skills/toolActivityIsland";
import type { ToolActivityIslandOptions } from "../components/tools-skills/toolActivityIsland";
import {
  getToolStatusLabel,
  getToolStatusTone,
  isPendingToolApproval as isPendingToolApprovalState,
  normalizeToolStatus as normalizeToolStatusModel,
} from "../components/tools-skills/toolActivityStatus";
import { mountToolsListIsland } from "../components/tools-skills/toolsListIsland";
import { mountToolsSkillsActionsIsland, type ToolsSkillsActionId } from "../components/tools-skills/toolsSkillsActionsIsland";
import { mountToolsSkillsPaneIsland } from "../components/tools-skills/toolsSkillsPaneIsland";
import { mountTokenUsageOrbIsland } from "../components/shell/tokenUsageOrbIsland";
import { mountWorkLensIsland } from "../components/shell/workLensIsland";
import { mountWorkbenchPanelIsland } from "../components/shell/workbenchPanelIsland";

const desktopPinnedChatSessions = new WeakMap<Document, Set<string>>();
const DESKTOP_COWORK_STANDALONE_AVAILABLE = false;

type ConversationToolActivityRenderOptions = ToolActivityIslandOptions;

export interface DesktopTaskCenterActionEvent {
  action: DesktopTaskActionId;
  item: DesktopTaskCenterItem;
}

interface DesktopTaskCenterActionOptions {
  onTaskAction?: (event: DesktopTaskCenterActionEvent) => void;
  copyText?: (text: string) => void | Promise<void>;
}

export interface DesktopGatewayRuntimeActionEvent {
  action: DesktopGatewayRuntimeActionId;
  status: GatewayRuntimeStatus | null;
  diagnostics: string;
}

interface DesktopGatewayRuntimeActionOptions {
  onGatewayRuntimeAction?: (event: DesktopGatewayRuntimeActionEvent) => void;
  copyText?: (text: string) => void | Promise<void>;
}

export interface DesktopWorkLensActionEvent {
  action: DesktopWorkLensActionId;
  workLens: DesktopWorkLensProjection;
}

interface DesktopWorkLensActionOptions {
  onWorkLensAction?: (event: DesktopWorkLensActionEvent) => void;
  copyText?: (text: string) => void | Promise<void>;
}

export interface DesktopNativeChatComposerSubmitEvent {
  content: string;
  usePersistentRag: boolean;
}

export interface DesktopNativeChatDeleteSessionEvent {
  sessionKey: string;
  chatId: string;
  title: string;
}

export interface DesktopNativeChatPinSessionEvent {
  sessionKey: string;
  chatId: string;
  title: string;
  pinned: boolean;
}

export interface DesktopNativeChatRenameSessionEvent {
  sessionKey: string;
  chatId: string;
  title: string;
}

interface DesktopNativeChatActionOptions {
  onComposerSubmit?: (event: DesktopNativeChatComposerSubmitEvent) => void;
  onInterrupt?: () => void;
  onAttachSessionFile?: () => void;
  onArtifactLoad?: (selection: DelegateArtifactLoadSelection) => Promise<unknown>;
  onDelegateTraceLoad?: (selection: DelegateTraceLoadSelection) => Promise<unknown>;
  onNewChat?: () => void;
  onDeleteSession?: (event: DesktopNativeChatDeleteSessionEvent) => unknown | Promise<unknown>;
  onPinSession?: (event: DesktopNativeChatPinSessionEvent) => void;
  onRenameSession?: (event: DesktopNativeChatRenameSessionEvent) => void;
  onSelectModel?: (model: string) => void;
  onPersistentRagChange?: (enabled: boolean) => void;
}

export interface DesktopAgentUiFormActionEvent {
  action: "submit" | "cancel";
  form: AgentUiForm;
  values?: Record<string, unknown>;
}

interface DesktopAgentUiFormActionOptions {
  onAgentUiFormAction?: (event: DesktopAgentUiFormActionEvent) => void;
}

export type DesktopSettingsActionId = "save" | "discoverModels" | "retryLoad" | "copyDiagnostics" | "restartGateway" | "reloadWorkspace" | "reset" | "testProviderConnection" | "chooseWorkspace" | "openWorkspace" | "openSessionFiles" | "openKnowledgeDocuments" | "setupChannelIntegrations" | "openDiagnosticsLogs" | "exportDiagnosticsBundle" | "clearDiagnosticsLogs" | "resetLocalUiState" | "setDiagnosticsLogLevel" | "edit";

export type DesktopSettingsActionEvent =
  | {
      action: "save" | "discoverModels" | "retryLoad" | "copyDiagnostics" | "restartGateway" | "reloadWorkspace" | "reset" | "chooseWorkspace" | "openWorkspace" | "openSessionFiles" | "openKnowledgeDocuments" | "setupChannelIntegrations" | "openDiagnosticsLogs" | "exportDiagnosticsBundle" | "clearDiagnosticsLogs" | "resetLocalUiState";
      pane: DesktopSettingsPaneModel;
      providerId?: string;
    }
  | {
      action: "setDiagnosticsLogLevel";
      pane: DesktopSettingsPaneModel;
      logLevel: string;
    }
  | {
      action: "testProviderConnection";
      pane: DesktopSettingsPaneModel;
      providerId: string;
    }
  | {
      action: "edit";
      pane: DesktopSettingsPaneModel;
      fieldId: string;
      value: string | boolean;
      commitMode?: "manual" | "auto";
    };

interface DesktopSettingsActionOptions {
  onSettingsAction?: (event: DesktopSettingsActionEvent) => void;
}

export type DesktopKnowledgeActionId = "refreshAll" | "runQuery" | "extractGraph" | "rebuildIndex" | "deleteDocument" | "uploadDocument";

export interface DesktopKnowledgeActionEvent {
  action: DesktopKnowledgeActionId;
  pane: DesktopKnowledgePaneModel;
  documentId?: string;
  queryDraft?: DesktopKnowledgePaneModel["query"]["draft"];
}

interface DesktopKnowledgeActionOptions {
  onKnowledgeAction?: (event: DesktopKnowledgeActionEvent) => void;
}

export type DesktopToolsSkillsActionId = "createSkill" | "editSkill" | "saveSkill" | "deleteSkill" | "validateSkill" | "toggleAlways";

export interface DesktopToolsSkillsActionEvent {
  action: DesktopToolsSkillsActionId;
  pane: DesktopToolsSkillsPaneModel;
  field?: DesktopSkillEditorField;
  value?: string | boolean;
}

interface DesktopToolsSkillsActionOptions {
  onToolsSkillsAction?: (event: DesktopToolsSkillsActionEvent) => void;
}

export type DesktopCoworkActionId = Extract<
  DesktopCoworkActionInput["action"],
  | "createSession"
  | "runSession"
  | "pauseSession"
  | "resumeSession"
  | "emergencyStopSession"
  | "deleteSession"
  | "sendMessage"
  | "loadSummary"
  | "loadBlueprint"
  | "loadTrace"
  | "loadDag"
  | "loadArtifacts"
  | "loadOrganization"
  | "loadQueues"
  | "loadBranches"
  | "loadAgentActivity"
  | "loadObservation"
  | "validateBlueprint"
  | "addTask"
  | "updateBudget"
  | "task"
  | "workUnit"
  | "deriveBranch"
  | "selectBranch"
  | "selectBranchResult"
  | "mergeBranchResults"
  | "selectFinalResult"
  | "mergeFinalResult"
>;

export interface DesktopCoworkActionEvent {
  action: DesktopCoworkActionId;
  pane: DesktopCoworkPaneModel;
  sessionId?: string;
  goal?: string;
  message?: string;
  threadId?: string;
  topic?: string;
  eventType?: string;
  blueprintText?: string;
  preview?: boolean;
  taskTitle?: string;
  assignedAgentId?: string;
  maxRounds?: number;
  taskId?: string;
  taskAction?: Extract<DesktopCoworkActionInput, { action: "task" }>["taskAction"];
  workUnitId?: string;
  workUnitAction?: Extract<DesktopCoworkActionInput, { action: "workUnit" }>["workUnitAction"];
  sourceBranchId?: string;
  targetArchitecture?: string;
  branchId?: string;
  resultId?: string;
  branchIds?: string[];
  agentId?: string;
  limit?: number;
  detailRef?: string;
  requesterAgentId?: string;
}

interface DesktopCoworkActionOptions {
  onCoworkAction?: (event: DesktopCoworkActionEvent) => void;
}

interface InstallDesktopWorkbenchShellOptions {
  targetDocument?: Document;
  layout?: WorkbenchLayoutState;
  runtimeStatus?: GatewayRuntimeStatus | null;
  chat?: DesktopNativeChatModel | null;
  chatActions?: DesktopNativeChatActionOptions;
  agentUiForms?: AgentUiForm[];
  agentUiActions?: DesktopAgentUiFormActionOptions;
  taskCenterItems?: DesktopTaskCenterItem[];
  gatewayHttp: string;
  settingsPane?: DesktopSettingsPaneModel | null;
  settingsActions?: DesktopSettingsActionOptions;
  knowledgePane?: DesktopKnowledgePaneModel | null;
  knowledgeActions?: DesktopKnowledgeActionOptions;
  toolsSkillsPane?: DesktopToolsSkillsPaneModel | null;
  toolsSkillsActions?: DesktopToolsSkillsActionOptions;
  coworkPane?: DesktopCoworkPaneModel | null;
  coworkActions?: DesktopCoworkActionOptions;
  runChainItems?: DesktopRunChainItem[];
  selectedRunChainItemKey?: string | null;
  workLens?: DesktopWorkLensProjection | null;
  workLensActions?: DesktopWorkLensActionOptions;
  taskActions?: DesktopTaskCenterActionOptions;
  gatewayActions?: DesktopGatewayRuntimeActionOptions;
}

export interface DesktopCoworkPaneModel {
  sessionRows: DesktopCoworkSessionRow[];
  cockpitView?: DesktopCoworkCockpitView | null;
  actionStatus?: string;
  summaryText?: string;
  blueprintDiagnostics?: string;
}

export interface DesktopNativeChatModel {
  sessions: NativeChatSession[];
  activeSessionKey: string;
  activeChatId: string;
  messages: NativeChatMessage[];
  status?: string;
  responding?: boolean;
  usePersistentRag?: boolean;
  composerState?: "idle" | "queued" | "sending";
  runtime?: {
    provider?: string;
    model?: string;
    modelOptions?: string[];
    temperature?: number | null;
    maxTokens?: number | null;
    reasoningEffort?: string | null;
    contextWindowTokens?: number | null;
    maxToolIterations?: number | null;
    toolResultBudget?: number | null;
    webSocket?: string;
    tokenReady?: boolean;
    tokenUsage?: string;
    tsAgentCheckpoint?: string;
    gatewayHttp?: string;
  };
}

const SHELL_ID = "desktop-workbench-shell";
const STYLE_ID = "desktop-workbench-shell-style";
const WORK_LENS_INLINE_ID = "desktop-work-lens-inline";
const COWORK_GRAPH_NODE_LIMIT = 24;
const COWORK_GRAPH_EDGE_LIMIT = 12;
const COWORK_OBSERVABILITY_ROW_LIMIT = 24;
const COWORK_TASK_FEED_LIMIT = 20;
const DESKTOP_SIDEBAR_MIN_SIZE = 220;
const DESKTOP_SIDEBAR_MAX_SIZE = 300;
const DESKTOP_SIDEBAR_COLLAPSE_OVERSHOOT = DESKTOP_SIDEBAR_MIN_SIZE * 0.5;
type DesktopPanelControlId = "sidebar" | "inspector" | "bottom";
interface DesktopWorkbenchLiveState {
  runChainItems: DesktopRunChainItem[];
  taskCenterItems: DesktopTaskCenterItem[];
}

const desktopWorkbenchLiveStates = new WeakMap<Document, DesktopWorkbenchLiveState>();
const desktopRuntimeStatusSnapshots = new WeakMap<Document, {
  gatewayHttp: string;
  runtimeStatus: GatewayRuntimeStatus | null;
}>();
const desktopNativeChatModels = new WeakMap<Document, DesktopNativeChatModel>();
const desktopPanelFrameEventDocuments = new WeakSet<Document>();
const desktopChatTimelineContexts = new WeakMap<Document, {
  agentUiActions: DesktopAgentUiFormActionOptions;
  agentUiForms: AgentUiForm[];
  chatActions: DesktopNativeChatActionOptions;
  coworkActions: DesktopCoworkActionOptions;
  coworkPane: DesktopCoworkPaneModel | null;
}>();

export function installDesktopWorkbenchShell({
  targetDocument = document,
  layout = loadWorkbenchLayout(),
  runtimeStatus = null,
  chat = null,
  chatActions = {},
  agentUiForms = [],
  agentUiActions = {},
  taskCenterItems = [],
  gatewayHttp,
  settingsPane = null,
  settingsActions = {},
  knowledgePane = null,
  knowledgeActions = {},
  toolsSkillsPane = null,
  toolsSkillsActions = {},
  coworkPane = null,
  coworkActions = {},
  runChainItems = [],
  selectedRunChainItemKey = null,
  workLens = null,
  workLensActions = {},
  taskActions = {},
  gatewayActions = {},
}: InstallDesktopWorkbenchShellOptions): void {
  installDesktopDesignTokens(targetDocument);
  ensureDesktopWorkbenchShellStyle(targetDocument);
  if (chat) {
    desktopNativeChatModels.set(targetDocument, chat);
  }
  desktopChatTimelineContexts.set(targetDocument, {
    agentUiActions,
    agentUiForms,
    chatActions,
    coworkActions,
    coworkPane,
  });
  targetDocument.body.classList.add("desktop-native-workbench");
  desktopRuntimeStatusSnapshots.set(targetDocument, { gatewayHttp, runtimeStatus });
  desktopWorkbenchLiveStates.set(targetDocument, {
    runChainItems,
    taskCenterItems,
  });
  installDesktopPanelFrameEventBridge(targetDocument);
  targetDocument.body.replaceChildren(createWorkbenchShell(targetDocument, layout, runtimeStatus, chat, chatActions, agentUiForms, agentUiActions, gatewayHttp, taskCenterItems, settingsPane, settingsActions, knowledgePane, knowledgeActions, toolsSkillsPane, toolsSkillsActions, coworkPane, coworkActions, runChainItems, selectedRunChainItemKey, workLens, workLensActions, taskActions, gatewayActions));
  if (chat) {
    syncNativeChatDocumentState(targetDocument, chat);
  }
  installDesktopHelpEventRouting(targetDocument);
}

export function updateDesktopTaskCenterItems(
  targetDocument: Document = document,
  items: DesktopTaskCenterItem[],
  taskActions: DesktopTaskCenterActionOptions = {},
): void {
  const taskCenter = targetDocument.getElementById("desktop-task-center");
  if (!taskCenter) {
    return;
  }
  const next = createTaskCenterSurface(targetDocument, items, taskActions);
  taskCenter.replaceChildren(...Array.from(next.children));
  const liveState = desktopWorkbenchLiveStates.get(targetDocument);
  if (liveState) {
    liveState.taskCenterItems = items;
    refreshRunChainOverviewFromTaskCenter(targetDocument, liveState);
  }
  refreshVisibleWorkLensFromTaskCenter(targetDocument, items);
}

export function updateDesktopGatewayRuntimeStatus(
  targetDocument: Document = document,
  runtimeStatus: GatewayRuntimeStatus | null,
  gatewayHttp: string,
  gatewayActions: DesktopGatewayRuntimeActionOptions = {},
): void {
  desktopRuntimeStatusSnapshots.set(targetDocument, { gatewayHttp, runtimeStatus });
  refreshOpenDesktopBackendLogs(targetDocument, runtimeStatus, gatewayHttp);
  const runtime = targetDocument.querySelector<HTMLElement>(".desktop-gateway-runtime");
  if (!runtime) {
    return;
  }
  const next = createGatewayRuntimeSurface(targetDocument, runtimeStatus, gatewayHttp, gatewayActions);
  runtime.replaceChildren(...Array.from(next.children));
}

function refreshOpenDesktopBackendLogs(
  targetDocument: Document,
  runtimeStatus: GatewayRuntimeStatus | null,
  gatewayHttp: string,
): void {
  const existing = targetDocument.getElementById("desktop-backend-logs-dialog") as HTMLElement | null;
  if (!existing || existing.hidden) {
    return;
  }
  const logText = formatDesktopBackendLogs(runtimeStatus, gatewayHttp);
  existing.replaceChildren(createDesktopBackendLogsPanel(targetDocument, existing, logText));
}

export function updateDesktopSettingsPane(
  targetDocument: Document = document,
  settingsPane: DesktopSettingsPaneModel,
  settingsActions: DesktopSettingsActionOptions = {},
): void {
  const pane = targetDocument.querySelector<HTMLElement>(".desktop-settings-pane");
  if (!pane) {
    return;
  }
  const activeGroupId = getCurrentDesktopSettingsActiveGroupId(pane, settingsPane);
  if (canMountVueIsland(pane) && pane.getAttribute("data-desktop-vue-island") === "settings-pane") {
    mountOrUpdateSettingsPaneIsland(pane, {
      pane: settingsPane,
      initialActiveGroupId: activeGroupId,
      mode: "content",
      onSettingsAction: settingsActions.onSettingsAction,
      promptProviderId: () => promptForSettingsProviderId(targetDocument),
      onFocusSettingsControl: (fieldId) => focusDesktopSettingsControl(targetDocument, fieldId),
    });
    updateDesktopSettingsSidebar(targetDocument, settingsPane, settingsActions, activeGroupId);
    return;
  }
  const next = createSettingsProvidersPane(targetDocument, settingsPane, settingsActions, activeGroupId);
  pane.replaceChildren(...Array.from(next.children));
  updateDesktopSettingsSidebar(targetDocument, settingsPane, settingsActions, activeGroupId);
}

export function syncDesktopWorkbenchRouteSidebar(
  targetDocument: Document = document,
  activeModule: string = getDesktopActiveWorkbenchModule(targetDocument),
  options: {
    chat?: DesktopNativeChatModel | null;
    chatActions?: DesktopNativeChatActionOptions;
    settingsPane?: DesktopSettingsPaneModel | null;
    settingsActions?: DesktopSettingsActionOptions;
  } = {},
): void {
  if (activeModule !== "chat" && activeModule !== "settings") {
    return;
  }
  const sidebarPanel = targetDocument.querySelector<HTMLElement>('[data-workbench-region="sidebar"]');
  if (!sidebarPanel) {
    return;
  }
  const nextContent = activeModule === "settings" && options.settingsPane
    ? createSettingsWorkbenchSidebar(targetDocument, options.settingsPane, options.settingsActions ?? {})
    : createSidebar(targetDocument, options.chat ?? null, options.chatActions ?? {});
  replaceDesktopWorkbenchSidebarContent(sidebarPanel, nextContent);
}

function replaceDesktopWorkbenchSidebarContent(sidebarPanel: HTMLElement, content: HTMLElement): void {
  const contentHost = sidebarPanel.querySelector<HTMLElement>(".desktop-workbench-panel-content");
  if (contentHost) {
    contentHost.replaceChildren(content);
    return;
  }
  const resizer = sidebarPanel.querySelector<HTMLElement>("[data-desktop-sidebar-resizer]");
  if (resizer) {
    sidebarPanel.replaceChildren(content, resizer);
    return;
  }
  sidebarPanel.replaceChildren(content);
}

function updateDesktopSettingsSidebar(
  targetDocument: Document,
  settingsPane: DesktopSettingsPaneModel,
  settingsActions: DesktopSettingsActionOptions,
  activeGroupId: DesktopSettingsPaneGroup["id"],
): void {
  const sidebar = targetDocument.querySelector<HTMLElement>(".desktop-settings-sidebar");
  if (!sidebar) {
    return;
  }
  if (canMountVueIsland(sidebar) && sidebar.getAttribute("data-desktop-vue-island") === "settings-sidebar") {
    mountOrUpdateSettingsPaneIsland(sidebar, {
      pane: settingsPane,
      initialActiveGroupId: activeGroupId,
      mode: "sidebar",
      onSettingsAction: settingsActions.onSettingsAction,
      promptProviderId: () => promptForSettingsProviderId(targetDocument),
      onFocusSettingsControl: (fieldId) => focusDesktopSettingsControl(targetDocument, fieldId),
    });
    return;
  }
  const next = createSettingsWorkbenchSidebar(targetDocument, settingsPane, settingsActions, activeGroupId);
  sidebar.replaceChildren(...Array.from(next.children));
}

export function updateDesktopKnowledgePane(
  targetDocument: Document = document,
  knowledgePane: DesktopKnowledgePaneModel,
  knowledgeActions: DesktopKnowledgeActionOptions = {},
  workItems: DesktopTaskCenterItem[] = [],
): void {
  const pane = targetDocument.querySelector<HTMLElement>(".desktop-knowledge-pane");
  if (!pane) {
    return;
  }
  const next = createKnowledgePane(targetDocument, knowledgePane, knowledgeActions, workItems);
  pane.replaceChildren(...Array.from(next.children));
}

export function updateDesktopToolsSkillsPane(
  targetDocument: Document = document,
  toolsSkillsPane: DesktopToolsSkillsPaneModel,
  toolsSkillsActions: DesktopToolsSkillsActionOptions = {},
): void {
  const pane = targetDocument.querySelector<HTMLElement>(".desktop-tools-skills-pane");
  if (!pane) {
    return;
  }
  const next = createToolsSkillsPane(targetDocument, toolsSkillsPane, toolsSkillsActions);
  pane.replaceChildren(...Array.from(next.children));
}

export function updateDesktopAgentUiForms(
  targetDocument: Document = document,
  forms: AgentUiForm[],
  agentUiActions: DesktopAgentUiFormActionOptions = {},
): void {
  updateDesktopChatTimelineContext(targetDocument, {
    agentUiActions,
    agentUiForms: forms,
  });
  const surface = targetDocument.querySelector<HTMLElement>(".desktop-agent-ui-forms");
  if (!surface) {
    return;
  }
  const next = createAgentUiFormsSurface(targetDocument, forms, agentUiActions);
  surface.replaceChildren(...Array.from(next.children));
  updateInlineAgentUiForms(targetDocument, forms, agentUiActions);
}

function updateInlineAgentUiForms(
  targetDocument: Document,
  _forms: AgentUiForm[],
  _agentUiActions: DesktopAgentUiFormActionOptions,
): void {
  const thread = targetDocument.querySelector<HTMLElement>(".desktop-conversation-thread");
  const chat = desktopNativeChatModels.get(targetDocument);
  if (!thread || !chat) {
    return;
  }
  mountRebuiltChatSurface(thread, chat);
}

export function updateDesktopCoworkPane(
  targetDocument: Document = document,
  coworkPane: DesktopCoworkPaneModel,
  coworkActions: DesktopCoworkActionOptions = {},
): void {
  updateDesktopChatTimelineContext(targetDocument, {
    coworkActions,
    coworkPane,
  });
  const pane = targetDocument.querySelector<HTMLElement>(".desktop-cowork-cockpit");
  if (!pane) {
    return;
  }
  const next = createCoworkCockpitPane(targetDocument, coworkPane, coworkActions);
  pane.replaceChildren(...Array.from(next.children));
  const thread = targetDocument.querySelector<HTMLElement>(".desktop-conversation-thread");
  const chat = desktopNativeChatModels.get(targetDocument);
  if (thread && chat) {
    mountRebuiltChatSurface(thread, chat);
  }
}

function updateDesktopChatTimelineContext(
  targetDocument: Document,
  patch: Partial<{
    agentUiActions: DesktopAgentUiFormActionOptions;
    agentUiForms: AgentUiForm[];
    chatActions: DesktopNativeChatActionOptions;
    coworkActions: DesktopCoworkActionOptions;
    coworkPane: DesktopCoworkPaneModel | null;
  }>,
): void {
  const current = desktopChatTimelineContexts.get(targetDocument) ?? {
    agentUiActions: {},
    agentUiForms: [],
    chatActions: {},
    coworkActions: {},
    coworkPane: null,
  };
  desktopChatTimelineContexts.set(targetDocument, { ...current, ...patch });
}

export function updateDesktopNativeChat(
  targetDocument: Document = document,
  chat: DesktopNativeChatModel,
  _gatewayHttp = "",
  chatActions: DesktopNativeChatActionOptions = {},
): void {
  desktopNativeChatModels.set(targetDocument, chat);
  updateDesktopChatTimelineContext(targetDocument, { chatActions });
  logDesktopNativeChatDebug("shell.update", {
    chat: summarizeDesktopNativeChatForDebug(chat),
    dom: summarizeNativeChatDomForDebug(targetDocument),
  });
  syncNativeChatDocumentState(targetDocument, chat);
  const header = targetDocument.querySelector<HTMLElement>(".desktop-chat-header");
  if (header) {
    const next = createChatHeader(targetDocument, chat, chatActions);
    header.replaceChildren(...Array.from(next.children));
  }

  const thread = targetDocument.querySelector<HTMLElement>(".desktop-conversation-thread");
  if (thread) {
    const scrollState = captureConversationThreadScroll(thread);
    mountRebuiltChatSurface(thread, chat);
    restoreConversationThreadScroll(thread, scrollState);
    queueConversationThreadScrollRestore(thread, scrollState);
  }

  syncChatWorkbenchChrome(targetDocument, chat);

  const recentChats = targetDocument.querySelector<HTMLElement>(".desktop-recent-chat-list");
  const recentChatsSection = targetDocument.querySelector<HTMLElement>(".desktop-sidebar-list-section-recent");
  if (recentChatsSection && canMountVueIsland(recentChatsSection)) {
    mountSidebarRecentChatsVueIsland(recentChatsSection, recentChatRowsForChat(targetDocument, chat), chatActions);
  } else if (recentChats) {
    const next = createSidebarRecentChats(targetDocument, chat, chatActions).querySelector<HTMLElement>(".desktop-recent-chat-list");
    recentChats.replaceChildren(...Array.from(next?.children ?? []));
  }

  const composer = targetDocument.getElementById("desktop-native-composer");
  if (composer) {
    composer.setAttribute("data-active-session-key", chat.activeSessionKey);
    composer.setAttribute("data-desktop-composer-responding", String(chat.responding === true));
    composer.setAttribute("data-desktop-composer-rag", String(chat.usePersistentRag !== false));
    composer.setAttribute("data-desktop-composer-state", nativeComposerState(chat));
    if (canMountVueIsland(composer)) {
      mountComposerSurfaceVueIsland(composer, chat, chatActions);
    } else {
      const next = createNativeComposerSurface(targetDocument, chat, chatActions);
      composer.replaceChildren(...Array.from(next.children));
    }
  }
  syncSessionFileUploadKey(targetDocument, chat.activeSessionKey);
}

function syncChatWorkbenchChrome(targetDocument: Document, chat: DesktopNativeChatModel): void {
  const workbench = targetDocument.querySelector<HTMLElement>(".desktop-chat-workbench");
  if (!workbench) {
    return;
  }
  const header = workbench.querySelector<HTMLElement>(".desktop-chat-header");
  const thread = workbench.querySelector<HTMLElement>(".desktop-conversation-thread");
  const workLens = workbench.querySelector<HTMLElement>(".desktop-work-lens-inline");
  const composer = workbench.querySelector<HTMLElement>("#desktop-native-composer");
  const children = [header, thread].filter((child): child is HTMLElement => Boolean(child));
  if (!hasChatTimelineContent(targetDocument, chat)) {
    children.push(createChatWorkbenchEmptyState(targetDocument, []));
  }
  if (workLens) {
    children.push(workLens);
  }
  if (composer) {
    children.push(composer);
  }
  workbench.replaceChildren(...children);
}

function syncNativeChatDocumentState(targetDocument: Document, chat: DesktopNativeChatModel): void {
  const documentElement = (targetDocument as Document & { documentElement?: HTMLElement }).documentElement;
  if (!documentElement) {
    return;
  }
  documentElement.dataset.desktopActiveGeneration = String(chat.responding === true);
  documentElement.dataset.desktopActiveChatId = chat.activeChatId;
  documentElement.dataset.desktopActiveSessionKey = chat.activeSessionKey;
}

export function captureConversationThreadScroll(thread: HTMLElement): { bottomOffset: number; scrollTop: number; wasNearBottom: boolean } {
  const scrollElement = conversationThreadScrollElement(thread);
  const scrollTop = Number(scrollElement.scrollTop || 0);
  const bottomOffset = Math.max(0, Number(scrollElement.scrollHeight || 0) - scrollTop - Number(scrollElement.clientHeight || 0));
  return {
    bottomOffset,
    scrollTop,
    wasNearBottom: bottomOffset < 24,
  };
}

function restoreConversationThreadScroll(
  thread: HTMLElement,
  scrollState: { bottomOffset: number; scrollTop: number; wasNearBottom: boolean },
): void {
  const scrollElement = conversationThreadScrollElement(thread);
  if (scrollState.wasNearBottom) {
    scrollElement.scrollTop = boundedScrollTop(
      scrollElement,
      Number(scrollElement.scrollHeight || 0) - Number(scrollElement.clientHeight || 0) - scrollState.bottomOffset,
    );
    return;
  }
  scrollElement.scrollTop = boundedScrollTop(scrollElement, scrollState.scrollTop);
}

function conversationThreadScrollElement(thread: HTMLElement): HTMLElement {
  const timeline = thread.querySelector<HTMLElement>(".desktop-conversation-timeline");
  if (!timeline) {
    return thread;
  }
  const timelineScrollTop = Number(timeline.scrollTop || 0);
  const timelineScrollableHeight = Number(timeline.scrollHeight || 0) - Number(timeline.clientHeight || 0);
  return timelineScrollTop > 0 || timelineScrollableHeight > 0 ? timeline : thread;
}

function summarizeDesktopNativeChatForDebug(chat: DesktopNativeChatModel): Record<string, unknown> {
  return {
    activeChatId: chat.activeChatId,
    activeSessionKey: chat.activeSessionKey,
    composerState: nativeComposerState(chat),
    hasVisibleMessages: hasVisibleConversationMessages(chat),
    messageCount: chat.messages.length,
    responding: chat.responding === true,
    sessionCount: chat.sessions.length,
    status: chat.status,
    visibleMessagePreview: chat.messages.slice(-2).map((message) => ({
      content: summarizeDebugText(message.content),
      messageId: message.messageId,
      reasoning: summarizeDebugText(message.reasoningContent),
      role: message.role,
      toolActivities: message.toolActivities?.length ?? 0,
    })),
  };
}

function summarizeNativeChatDomForDebug(targetDocument: Document): Record<string, unknown> {
  const composer = targetDocument.getElementById("desktop-native-composer");
  const input = targetDocument.getElementById("desktop-native-composer-input") as HTMLTextAreaElement | null;
  const send = targetDocument.getElementById("desktop-native-composer-send") as HTMLButtonElement | null;
  const thread = targetDocument.querySelector<HTMLElement>(".desktop-conversation-thread");
  return {
    composerMounted: Boolean(composer),
    composerState: composer?.getAttribute("data-desktop-composer-state") ?? "",
    input: input ? summarizeDebugText(input.value) : undefined,
    inputFocused: input ? targetDocument.activeElement === input : false,
    sendDisabled: send?.disabled ?? null,
    threadMounted: Boolean(thread),
    threadText: thread ? summarizeDebugText(thread.textContent ?? "") : undefined,
    vueComposer: composer?.getAttribute("data-desktop-vue-island") ?? "",
    vueThread: thread?.getAttribute("data-desktop-vue-island") ?? "",
  };
}

function queueConversationThreadScrollRestore(
  thread: HTMLElement,
  scrollState: { bottomOffset: number; scrollTop: number; wasNearBottom: boolean },
): void {
  const queue = thread.ownerDocument.defaultView?.queueMicrotask ?? globalThis.queueMicrotask;
  if (typeof queue !== "function") {
    return;
  }
  queue(() => restoreConversationThreadScroll(thread, scrollState));
}

function boundedScrollTop(element: HTMLElement, value: number): number {
  const maxScrollTop = Math.max(0, Number(element.scrollHeight || 0) - Number(element.clientHeight || 0));
  return Math.min(Math.max(0, Number.isFinite(value) ? value : 0), maxScrollTop);
}

function createWorkbenchShell(
  targetDocument: Document,
  layout: WorkbenchLayoutState,
  runtimeStatus: GatewayRuntimeStatus | null,
  chat: DesktopNativeChatModel | null,
  chatActions: DesktopNativeChatActionOptions,
  agentUiForms: AgentUiForm[],
  agentUiActions: DesktopAgentUiFormActionOptions,
  gatewayHttp: string,
  taskCenterItems: DesktopTaskCenterItem[],
  settingsPane: DesktopSettingsPaneModel | null,
  settingsActions: DesktopSettingsActionOptions,
  _knowledgePane: DesktopKnowledgePaneModel | null,
  knowledgeActions: DesktopKnowledgeActionOptions,
  _toolsSkillsPane: DesktopToolsSkillsPaneModel | null,
  toolsSkillsActions: DesktopToolsSkillsActionOptions,
  _coworkPane: DesktopCoworkPaneModel | null,
  coworkActions: DesktopCoworkActionOptions,
  runChainItems: DesktopRunChainItem[],
  selectedRunChainItemKey: string | null,
  workLens: DesktopWorkLensProjection | null,
  workLensActions: DesktopWorkLensActionOptions,
  taskActions: DesktopTaskCenterActionOptions,
  gatewayActions: DesktopGatewayRuntimeActionOptions,
): HTMLElement {
  const inspectorContent = createInspector(targetDocument, runChainItems, taskCenterItems, selectedRunChainItemKey, workLens, workLensActions);
  const inspectorState = hasInspectorContent(inspectorContent)
    ? layout.inspector
    : { ...layout.inspector, visible: false };
  const activeModule = getDesktopActiveWorkbenchModule(targetDocument);
  const shouldShowSidebar = activeModule === "chat" || (activeModule === "settings" && settingsPane !== null);
  const sidebarState = shouldShowSidebar
    ? layout.sidebar
    : { ...layout.sidebar, visible: false };
  const sidebarContent = activeModule === "settings" && settingsPane !== null
    ? createSettingsWorkbenchSidebar(targetDocument, settingsPane, settingsActions)
    : createSidebar(targetDocument, chat, chatActions);
  const shell = targetDocument.createElement("main");
  shell.id = SHELL_ID;
  shell.className = "desktop-workbench-shell";
  shell.setAttribute("data-sidebar-visible", String(sidebarState.visible));
  shell.setAttribute("data-inspector-visible", String(inspectorState.visible));
  shell.setAttribute("data-bottom-visible", String(layout.bottom.visible));
  shell.style.setProperty("--desktop-sidebar-size", `${sidebarState.size}px`);
  shell.style.setProperty("--desktop-inspector-size", `${inspectorState.size}px`);
  shell.style.setProperty("--desktop-bottom-size", `${layout.bottom.size}px`);

  shell.append(
    createActivityRail(targetDocument),
    createPanel(targetDocument, "sidebar", sidebarState, sidebarContent),
    createMainRegion(targetDocument, gatewayHttp, layout, chat, chatActions, agentUiForms, agentUiActions, taskCenterItems, settingsPane, settingsActions, null, knowledgeActions, null, toolsSkillsActions, null, coworkActions, workLens, workLensActions),
    createPanel(targetDocument, "inspector", inspectorState, inspectorContent),
    createPanel(targetDocument, "bottom", layout.bottom, createBottomRegion(targetDocument, runtimeStatus, gatewayHttp, taskCenterItems, taskActions, gatewayActions)),
  );

  return shell;
}

function getDesktopActiveWorkbenchModule(targetDocument: Document): string {
  const routeModule = targetDocument.documentElement?.getAttribute("data-desktop-active-workbench-module")?.trim();
  if (routeModule) {
    return routeModule;
  }
  return "chat";
}

function createActivityRail(targetDocument: Document): HTMLElement {
  const rail = targetDocument.createElement("nav");
  if (canMountVueIsland(rail)) {
    mountActivityRailIsland(rail);
    return rail;
  }

  rail.className = "desktop-activity-rail";
  rail.setAttribute("data-workbench-region", "activity");
  rail.setAttribute("aria-label", "Desktop workbench modules");
  const activeModule = getDesktopActiveWorkbenchModule(targetDocument);

  const primary = targetDocument.createElement("div");
  primary.className = "desktop-activity-primary";
  for (const [index, [label, href, module]] of [
    ["Chat", "/chat", "chat"],
    ["Docs", "/docs", "docs"],
    ["GitHub", "https://github.com/SudoJacky/tinybot", "gateway"],
  ].entries()) {
    const item = targetDocument.createElement("a");
    item.className = "desktop-activity-button";
    item.setAttribute("href", href);
    item.textContent = label;
    item.setAttribute("aria-label", label);
    item.setAttribute("title", label);
    item.setAttribute("data-desktop-module-target", module);
    if (module === activeModule) {
      item.setAttribute("data-active", "true");
      item.setAttribute("aria-current", "page");
    }
    item.setAttribute("data-focus-order", `activity-${index + 1}`);
    primary.append(item);
  }

  const secondary = targetDocument.createElement("div");
  secondary.className = "desktop-activity-secondary";
  for (const [label, href, module] of [
    ["Settings", "/settings", "settings"],
  ]) {
    const item = targetDocument.createElement("a");
    item.className = "desktop-activity-secondary-button";
    item.setAttribute("href", href);
    item.textContent = label;
    item.setAttribute("aria-label", label);
    item.setAttribute("title", label);
    item.setAttribute("data-desktop-module-target", module);
    if (module === activeModule) {
      item.setAttribute("data-active", "true");
      item.setAttribute("aria-current", "page");
    }
    secondary.append(item);
  }

  rail.append(primary, secondary);
  return rail;
}

function createSidebar(
  targetDocument: Document,
  chat: DesktopNativeChatModel | null,
  chatActions: DesktopNativeChatActionOptions,
): HTMLElement {
  const sidebar = targetDocument.createElement("div");
  sidebar.className = "desktop-sidebar-content";
  sidebar.append(
    createSidebarActions(targetDocument),
    createSidebarRecentChats(targetDocument, chat, chatActions),
  );
  if (chat) {
    mountSidebarContentVueIsland(sidebar, targetDocument, chat);
  }
  return sidebar;
}

function createSettingsWorkbenchSidebar(
  targetDocument: Document,
  pane: DesktopSettingsPaneModel,
  settingsActions: DesktopSettingsActionOptions = {},
  initialActiveGroupId?: DesktopSettingsPaneGroup["id"],
): HTMLElement {
  const activeGroupId = getDesktopSettingsActiveGroup(pane, initialActiveGroupId)?.id ?? "general";
  const sidebar = targetDocument.createElement("aside");
  sidebar.className = "desktop-settings-sidebar";
  sidebar.setAttribute("aria-label", "Settings navigation");
  if (canMountVueIsland(sidebar)) {
    mountSettingsPaneVueIsland(sidebar, targetDocument, pane, settingsActions, activeGroupId, "sidebar");
    return sidebar;
  }
  return createSettingsSidebar(
    targetDocument,
    pane,
    (groupId) => renderFallbackSettingsContent(targetDocument, pane, settingsActions, groupId),
    activeGroupId,
  );
}

function mountSidebarContentVueIsland(
  sidebar: HTMLElement,
  targetDocument: Document,
  chat: DesktopNativeChatModel,
): void {
  if (!canMountVueIsland(sidebar)) {
    return;
  }
  const pinnedSessionKeys = pinnedSessionKeysForDocument(targetDocument);
  const recentChats = sortPinnedSessionsFirst(chat.sessions, pinnedSessionKeys).map((session) => recentChatRowModel(
    session,
    session.key === chat.activeSessionKey,
    pinnedSessionKeys.has(session.key),
  ));
  mountSidebarContentIsland(sidebar, {
    commandItems: [],
    recentChats,
    resourceItems: [],
    targetDocument,
  });
}

function createSidebarActions(targetDocument: Document): HTMLElement {
  const section = targetDocument.createElement("section");
  section.className = "desktop-sidebar-actions";

  const newChat = createWorkbenchLink(targetDocument, "+  New chat", "/chat/new", "desktop-sidebar-primary-action");
  newChat.setAttribute("aria-label", "New chat");
  const shortcut = targetDocument.createElement("span");
  shortcut.className = "desktop-sidebar-shortcut";
  shortcut.textContent = "Ctrl N";
  newChat.append(shortcut);

  const search = targetDocument.createElement("input");
  search.className = "desktop-sidebar-search";
  search.setAttribute("type", "search");
  search.setAttribute("aria-label", "Search");
  search.setAttribute("placeholder", "Search");

  section.append(newChat, search);
  mountSidebarActionsVueIsland(section);
  return section;
}

function mountSidebarActionsVueIsland(section: HTMLElement): void {
  if (!canMountVueIsland(section)) {
    return;
  }
  mountSidebarActionsIsland(section);
}

function createSidebarRecentChats(
  targetDocument: Document,
  chat: DesktopNativeChatModel | null,
  chatActions: DesktopNativeChatActionOptions = {},
): HTMLElement {
  const section = targetDocument.createElement("section");
  section.className = "desktop-sidebar-list-section desktop-sidebar-list-section-recent";
  section.append(createSidebarSectionHeading(targetDocument, "Recent chats"));

  const list = targetDocument.createElement("div");
  list.className = "desktop-recent-chat-list";
  list.setAttribute("role", "list");
  if (chat) {
    const pinnedSessionKeys = pinnedSessionKeysForDocument(targetDocument);
    const sessions = chat.sessions.length
      ? sortPinnedSessionsFirst(chat.sessions, pinnedSessionKeys)
      : [];
    for (const session of sessions) {
      const routeId = desktopChatRouteId(session);
      list.append(createRecentChatRow(
        targetDocument,
        session,
        session.key === chat.activeSessionKey,
        chatActions,
        routeId,
        pinnedSessionKeys.has(session.key),
      ));
    }
    if (!sessions.length) {
      list.append(createText(targetDocument, "p", "No recent chats."));
    }
    section.append(list);
    mountSidebarRecentChatsVueIsland(section, recentChatRowsForChat(targetDocument, chat), chatActions);
    return section;
  }

  const fallbackRows = [
    ["Design native workbench", "Just now"],
    ["修复会话加载问题", "2h ago"],
    ["实现文件上传功能", "Yesterday"],
    ["项目启动优化", "2d ago"],
    ["自动化脚本建议", "3d ago"],
  ] as const;
  for (const [name, meta] of fallbackRows) {
    list.append(createSidebarRow(targetDocument, name, meta, false, "chat"));
  }

  section.append(list);
  mountSidebarRecentChatsVueIsland(section, fallbackRows.map(([name, meta]) => ({
    active: false,
    chatId: name,
    href: `/chat/${encodeURIComponent(name)}`,
    pinned: false,
    routeId: name,
    sessionKey: name,
    title: name,
    updatedLabel: meta,
  })), chatActions);
  return section;
}

function recentChatRowModel(
  session: NativeChatSession,
  active: boolean,
  pinned: boolean,
): SidebarRecentChatRow {
  const routeId = desktopChatRouteId(session);
  const title = session.title || "New session";
  return {
    active,
    chatId: session.chatId,
    href: `/chat/${encodeURIComponent(routeId)}`,
    pinned,
    routeId,
    sessionKey: session.key,
    title,
    updatedLabel: formatSessionRelativeTime(session.updatedAt || session.createdAt) || session.chatId,
  };
}

function recentChatRowsForChat(targetDocument: Document, chat: DesktopNativeChatModel): SidebarRecentChatRow[] {
  const pinnedSessionKeys = pinnedSessionKeysForDocument(targetDocument);
  return sortPinnedSessionsFirst(chat.sessions, pinnedSessionKeys).map((session) => recentChatRowModel(
    session,
    session.key === chat.activeSessionKey,
    pinnedSessionKeys.has(session.key),
  ));
}

function mountSidebarRecentChatsVueIsland(
  section: HTMLElement,
  rows: Array<{
    active: boolean;
    chatId: string;
    href: string;
    pinned: boolean;
    routeId: string;
    sessionKey: string;
    title: string;
    updatedLabel: string;
  }>,
  chatActions: DesktopNativeChatActionOptions,
): void {
  if (!canMountVueIsland(section)) {
    return;
  }
  mountSidebarRecentChatsIsland(section, {
    rows,
    onDeleteSession: chatActions.onDeleteSession,
  });
}

function desktopChatRouteId(session: NativeChatSession): string {
  if (session.key && !session.key.startsWith("WebSocket:")) {
    return session.key;
  }
  return session.chatId || session.key;
}

function sortPinnedSessionsFirst(sessions: NativeChatSession[], pinnedSessionKeys: Set<string>): NativeChatSession[] {
  return [...sessions].sort(
    (left, right) => Number(pinnedSessionKeys.has(right.key)) - Number(pinnedSessionKeys.has(left.key)),
  );
}

function createRecentChatRow(
  targetDocument: Document,
  session: NativeChatSession,
  active: boolean,
  chatActions: DesktopNativeChatActionOptions,
  routeId = desktopChatRouteId(session),
  pinned = false,
): HTMLElement {
  const row = targetDocument.createElement("div");
  row.className = "desktop-sidebar-chat-row";
  row.setAttribute("role", "listitem");
  row.setAttribute("data-active", String(active));
  row.setAttribute("data-sidebar-row-kind", "chat");
  row.setAttribute("data-desktop-session-key", session.key);
  row.setAttribute("data-desktop-chat-id", session.chatId);
  row.setAttribute("data-desktop-route-id", routeId);
  row.setAttribute("data-pinned", String(pinned));

  const title = session.title || "New session";
  const href = `/chat/${encodeURIComponent(routeId)}`;
  const updatedLabel = formatSessionRelativeTime(session.updatedAt || session.createdAt) || session.chatId;

  const link = targetDocument.createElement("a");
  link.className = "desktop-sidebar-row desktop-sidebar-row-main";
  link.setAttribute("href", href);
  link.setAttribute("data-active", String(active));
  link.setAttribute("data-sidebar-row-kind", "chat");
  link.setAttribute("data-desktop-entity-module", "chat");
  link.setAttribute("data-desktop-entity-id", routeId);

  const titleWrap = targetDocument.createElement("span");
  titleWrap.className = "desktop-sidebar-row-title";
  const label = targetDocument.createElement("span");
  label.className = "desktop-sidebar-row-label";
  label.textContent = title;
  titleWrap.append(label);
  setSessionRowPinIcon(targetDocument, titleWrap, pinned);
  const time = targetDocument.createElement("span");
  time.className = "desktop-sidebar-row-meta";
  time.textContent = updatedLabel;
  link.append(titleWrap, time);

  const deleteButton = targetDocument.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "desktop-sidebar-delete-session";
  deleteButton.setAttribute("data-desktop-chat-delete", session.key);
  deleteButton.setAttribute("aria-label", `Delete chat ${title}`);
  deleteButton.textContent = "x";
  let confirmDelete = false;
  deleteButton.addEventListener("click", (event) => {
    event.preventDefault?.();
    event.stopPropagation?.();
    if (!confirmDelete) {
      confirmDelete = true;
      deleteButton.setAttribute("aria-label", `Confirm delete chat ${title}`);
      deleteButton.setAttribute("data-confirming", "true");
      deleteButton.textContent = "确认";
      return;
    }
    deleteButton.setAttribute("disabled", "");
    deleteButton.setAttribute("data-deleting", "true");
    deleteButton.textContent = "删除中";
    chatActions.onDeleteSession?.({
      sessionKey: session.key,
      chatId: session.chatId,
      title,
    });
  });

  row.append(link, deleteButton);
  mountRecentChatRowVueIsland(row, {
    active,
    chatId: session.chatId,
    href,
    onDeleteSession: chatActions.onDeleteSession,
    pinned,
    routeId,
    sessionKey: session.key,
    title,
    updatedLabel,
  });
  return row;
}

function mountRecentChatRowVueIsland(
  row: HTMLElement,
  options: {
    active: boolean;
    chatId: string;
    href: string;
    onDeleteSession?: (event: { chatId: string; sessionKey: string; title: string }) => unknown | Promise<unknown>;
    pinned: boolean;
    routeId: string;
    sessionKey: string;
    title: string;
    updatedLabel: string;
  },
): void {
  if (!canMountVueIsland(row)) {
    return;
  }
  mountRecentChatRowIsland(row, options);
}

function createSidebarSectionHeading(targetDocument: Document, title: string, action?: string): HTMLElement {
  const heading = targetDocument.createElement("div");
  heading.className = "desktop-sidebar-section-heading";
  const label = targetDocument.createElement("h2");
  label.textContent = title;
  heading.append(label);
  if (action) {
    const button = targetDocument.createElement("button");
    button.type = "button";
    button.className = "desktop-sidebar-section-action";
    button.setAttribute("aria-label", `${title} action`);
    button.textContent = action;
    heading.append(button);
  }
  mountSidebarSectionHeadingVueIsland(heading, title, action);
  return heading;
}

function mountSidebarSectionHeadingVueIsland(heading: HTMLElement, title: string, action?: string): void {
  if (!canMountVueIsland(heading)) {
    return;
  }
  mountSidebarSectionHeadingIsland(heading, { title, action });
}

function createSidebarRow(
  targetDocument: Document,
  title: string,
  meta: string,
  active: boolean,
  kind: "folder" | "chat",
  entityModule?: string,
  entityId?: string,
): HTMLElement {
  const row = targetDocument.createElement("a");
  row.className = "desktop-sidebar-row";
  const href = kind === "folder"
    ? "/files"
    : entityId
      ? `/chat/${encodeURIComponent(entityId)}`
      : "/chat";
  row.setAttribute("href", href);
  row.setAttribute("role", "listitem");
  row.setAttribute("data-active", String(active));
  row.setAttribute("data-sidebar-row-kind", kind);
  if (entityModule) {
    row.setAttribute("data-desktop-entity-module", entityModule);
  }
  if (entityId) {
    row.setAttribute("data-desktop-entity-id", entityId);
  }
  const label = targetDocument.createElement("span");
  label.className = "desktop-sidebar-row-label";
  label.textContent = title;
  const time = targetDocument.createElement("span");
  time.className = "desktop-sidebar-row-meta";
  time.textContent = meta;
  row.append(label, time);
  mountSidebarRowVueIsland(row, { active, entityId, entityModule, href, kind, meta, title });
  return row;
}

function mountSidebarRowVueIsland(
  row: HTMLAnchorElement,
  options: {
    active: boolean;
    entityId?: string;
    entityModule?: string;
    href: string;
    kind: "folder" | "chat";
    meta: string;
    title: string;
  },
): void {
  if (!canMountVueIsland(row)) {
    return;
  }
  mountSidebarRowIsland(row, options);
}

function createMainRegion(
  targetDocument: Document,
  gatewayHttp: string,
  layout: WorkbenchLayoutState,
  chat: DesktopNativeChatModel | null,
  chatActions: DesktopNativeChatActionOptions,
  agentUiForms: AgentUiForm[],
  agentUiActions: DesktopAgentUiFormActionOptions,
  taskCenterItems: DesktopTaskCenterItem[],
  settingsPane: DesktopSettingsPaneModel | null,
  settingsActions: DesktopSettingsActionOptions,
  _knowledgePane: DesktopKnowledgePaneModel | null,
  knowledgeActions: DesktopKnowledgeActionOptions,
  _toolsSkillsPane: DesktopToolsSkillsPaneModel | null,
  toolsSkillsActions: DesktopToolsSkillsActionOptions,
  _coworkPane: DesktopCoworkPaneModel | null,
  coworkActions: DesktopCoworkActionOptions,
  workLens: DesktopWorkLensProjection | null,
  workLensActions: DesktopWorkLensActionOptions,
): HTMLElement {
  const main = targetDocument.createElement("section");
  main.className = "desktop-workbench-main";
  main.setAttribute("data-workbench-region", "main");
  main.setAttribute("aria-label", "Primary desktop work area");
  const chatWorkItems = moduleWorkItems(taskCenterItems, "chat");
  const showEmptySession = chat ? !hasChatTimelineContent(targetDocument, chat) : false;

  const workbench = targetDocument.createElement("div");
  workbench.className = "desktop-empty-session desktop-chat-workbench";
  const workbenchChildren = [
    createChatHeader(targetDocument, chat, chatActions),
    createConversationThread(targetDocument, chat),
  ];
  if (showEmptySession) {
    workbenchChildren.push(createChatWorkbenchEmptyState(targetDocument, chatWorkItems));
  }
  workbenchChildren.push(createWorkLensInlineHost(targetDocument, layout.inspector.visible ? null : workLens, workLensActions));
  workbenchChildren.push(createNativeComposerSurface(targetDocument, chat, chatActions));
  workbench.append(...workbenchChildren);

  const utilities = targetDocument.createElement("div");
  utilities.className = "desktop-utility-surfaces";
  utilities.append(
    createCommandPalette(targetDocument),
    createFileActions(targetDocument, chat),
    createDesktopHelpSurface(targetDocument),
    createAgentUiFormsSurface(targetDocument, agentUiForms, agentUiActions),
    ...(settingsPane ? [createSettingsProvidersPane(targetDocument, settingsPane, settingsActions)] : []),
  );
  mountMainUtilitiesRegionVueIsland(
    utilities,
    targetDocument,
    chat,
    agentUiForms,
    agentUiActions,
    taskCenterItems,
    settingsPane,
    settingsActions,
    null,
    knowledgeActions,
    null,
    toolsSkillsActions,
    null,
    coworkActions,
  );

  const status = targetDocument.createElement("div");
  status.className = "desktop-status-strip";
  status.setAttribute("data-desktop-route-status", "");
  status.textContent = `No workspace file selected · Gateway ${gatewayHttp}`;

  status.textContent = `Chat ready - Gateway ${gatewayHttp}`;
  if (canMountVueIsland(status)) {
    mountStatusStripIsland(status, { message: status.textContent });
  }
  main.append(workbench, utilities, status);
  return main;
}

function hasVisibleConversationMessages(chat: DesktopNativeChatModel): boolean {
  if (!chat.activeSessionKey) {
    return false;
  }
  return chat.messages.some((message) => Boolean(
    message.content?.trim()
      || message.reasoningContent?.trim()
      || message.toolActivities?.length
      || message.references?.length,
  ));
}

function hasChatTimelineContent(targetDocument: Document, chat: DesktopNativeChatModel): boolean {
  return hasVisibleConversationMessages(chat)
    || activeChatAgentUiForms(chat, desktopChatTimelineContexts.get(targetDocument)?.agentUiForms ?? []).length > 0
    || chatCoworkRuns(targetDocument, chat).length > 0;
}

function activeChatAgentUiForms(chat: DesktopNativeChatModel | null, forms: AgentUiForm[]): AgentUiForm[] {
  if (!chat?.activeChatId) {
    return [];
  }
  return forms.filter((form) => agentUiFormChatId(form) === chat.activeChatId);
}

function chatCoworkRuns(targetDocument: Document, chat: DesktopNativeChatModel | null): ConversationCoworkRunOptions[] {
  const coworkPane = desktopChatTimelineContexts.get(targetDocument)?.coworkPane;
  if (!chat?.activeChatId || !coworkPane) {
    return [];
  }
  const rows = coworkPane.sessionRows.filter((row) => coworkSessionOriginChatId(row.raw) === chat.activeChatId);
  const visible = rows.sort(compareCoworkRowsForChat)[0];
  if (!visible) {
    return [];
  }
  const cockpit = coworkPane.cockpitView?.header.id === visible.id ? coworkPane.cockpitView : null;
  return [{
    activeAgentCount: visible.activeAgentCount,
    agentCount: visible.agentCount,
    agents: (cockpit?.agents ?? []).map((agent) => ({
      attentionLabel: agent.attention.label,
      id: agent.id,
      label: agent.label,
      latestActivity: agent.latestActivity,
      roleOrTask: agent.roleOrTask,
      status: agent.status,
    })),
    attentionLabel: visible.attention.label,
    finalOutput: visible.finalOutput,
    id: visible.id,
    status: visible.status,
    taskProgress: visible.taskProgress.total
      ? `${visible.taskProgress.completed}/${visible.taskProgress.total}`
      : "0/0",
    title: visible.title,
    workflow: visible.workflow,
  }];
}

function coworkSessionOriginChatId(raw: Record<string, unknown> | null | undefined): string {
  if (!raw) {
    return "";
  }
  const runtimeState = raw.runtime_state && typeof raw.runtime_state === "object" && !Array.isArray(raw.runtime_state)
    ? raw.runtime_state as Record<string, unknown>
    : null;
  const value = runtimeState?.origin_chat_id
    ?? runtimeState?.originChatId
    ?? raw.origin_chat_id
    ?? raw.originChatId
    ?? raw.source_chat_id
    ?? raw.chat_id;
  return typeof value === "string" ? value : "";
}

function compareCoworkRowsForChat(left: DesktopCoworkSessionRow, right: DesktopCoworkSessionRow): number {
  const leftActive = isActiveCoworkStatus(left.status) ? 1 : 0;
  const rightActive = isActiveCoworkStatus(right.status) ? 1 : 0;
  if (leftActive !== rightActive) {
    return rightActive - leftActive;
  }
  return Date.parse(right.updatedAt || "") - Date.parse(left.updatedAt || "");
}

function isActiveCoworkStatus(status: string): boolean {
  return ["active", "running", "paused", "blocked"].includes(status.toLowerCase());
}

function agentUiFormChatId(form: AgentUiForm): string {
  const correlated = form.correlation?.chat_id;
  return form.chat_id || (typeof correlated === "string" ? correlated : "");
}

function createChatWorkbenchEmptyState(targetDocument: Document, chatWorkItems: DesktopTaskCenterItem[]): HTMLElement {
  const workbenchChrome = targetDocument.createElement("div");
  workbenchChrome.className = "desktop-chat-workbench-chrome";
  workbenchChrome.append(
    createText(targetDocument, "h2", "Start a new session"),
    createText(targetDocument, "p", "Ask Tinybot about the workspace, inspect files, or create a task."),
    ...(chatWorkItems.length ? [createModuleWorkSection(targetDocument, "Chat runs", chatWorkItems)] : []),
  );
  mountChatWorkbenchVueIsland(workbenchChrome, targetDocument, chatWorkItems);
  return workbenchChrome;
}

function mountChatWorkbenchVueIsland(
  workbenchChrome: HTMLElement,
  targetDocument: Document,
  chatWorkItems: DesktopTaskCenterItem[],
): void {
  if (!canMountVueIsland(workbenchChrome)) {
    return;
  }
  mountChatWorkbenchIsland(workbenchChrome, {
    moduleWorkItems: chatWorkItems,
    onInspectWorkItem: (item) => inspectModuleWorkItem(targetDocument, item),
  });
}

function mountMainUtilitiesRegionVueIsland(
  utilities: HTMLElement,
  targetDocument: Document,
  chat: DesktopNativeChatModel | null,
  agentUiForms: AgentUiForm[],
  agentUiActions: DesktopAgentUiFormActionOptions,
  taskCenterItems: DesktopTaskCenterItem[],
  settingsPane: DesktopSettingsPaneModel | null,
  settingsActions: DesktopSettingsActionOptions,
  knowledgePane: DesktopKnowledgePaneModel | null,
  knowledgeActions: DesktopKnowledgeActionOptions,
  toolsSkillsPane: DesktopToolsSkillsPaneModel | null,
  toolsSkillsActions: DesktopToolsSkillsActionOptions,
  coworkPane: DesktopCoworkPaneModel | null,
  coworkActions: DesktopCoworkActionOptions,
): void {
  if (!canMountVueIsland(utilities)) {
    return;
  }
  mountMainUtilitiesRegionIsland(utilities, {
    activeSessionKey: chat?.activeSessionKey ?? null,
    agentUiForms,
    coworkPane,
    knowledgePane,
    knowledgeWorkItems: moduleWorkItems(taskCenterItems, "knowledge"),
    settingsPane,
    toolsSkillsPane,
    onAgentUiCancel: (form) => {
      agentUiActions.onAgentUiFormAction?.({ action: "cancel", form });
    },
    onAgentUiSubmit: (form, values) => {
      agentUiActions.onAgentUiFormAction?.({ action: "submit", form, values });
    },
    onCoworkAction: (event) => {
      coworkActions.onCoworkAction?.(event);
    },
    onCoworkGraphSelect: (selection) => {
      setRouteStatus(targetDocument, `Inspecting Cowork ${selection.label}`);
    },
    onCoworkObservabilityPanelSelected: (panel) => {
      setRouteStatus(targetDocument, `Viewing Cowork ${panel.label}`);
    },
    onCoworkSessionSelect: (session) => {
      const [item] = buildDesktopTaskCenterItems({ coworkRuns: [buildDesktopCoworkTaskOperation(session.raw)] });
      if (!item) {
        return;
      }
      const renderedWorkLens = renderTaskWorkLens(targetDocument, item);
      setRouteStatus(targetDocument, renderedWorkLens ? `Inspecting ${item.title} in Work Lens` : `Inspecting ${item.title}`);
    },
    onFocusSettingsControl: (fieldId) => focusDesktopSettingsControl(targetDocument, fieldId),
    onHelpAction: (action) => {
      if (action === "shortcut-help") {
        renderDesktopShortcutHelp(targetDocument);
      } else if (action === "page-help") {
        renderDesktopPageHelp(targetDocument, "Page help");
      } else if (action === "help-tour") {
        renderDesktopPageHelp(targetDocument, "Desktop help tour");
      }
    },
    onInspectKnowledgeWorkItem: (item) => inspectModuleWorkItem(targetDocument, item),
    onKnowledgeAction: (event) => {
      knowledgeActions.onKnowledgeAction?.(event);
    },
    onSettingsAction: settingsActions.onSettingsAction,
    onToolsSkillsAction: (event) => {
      toolsSkillsActions.onToolsSkillsAction?.(event);
    },
    promptProviderId: () => promptForSettingsProviderId(targetDocument),
  });
}

function createChatHeader(
  targetDocument: Document,
  chat: DesktopNativeChatModel | null,
  chatActions: DesktopNativeChatActionOptions = {},
): HTMLElement {
  const header = targetDocument.createElement("header");
  header.className = "desktop-chat-header";

  const titleRow = targetDocument.createElement("div");
  titleRow.className = "desktop-chat-title-row";

  const activeSession = activeChatSession(chat);
  const titleGroup = targetDocument.createElement("div");
  titleGroup.className = "desktop-chat-title-group";
  const context = targetDocument.createElement("span");
  context.className = "desktop-chat-context";
  context.textContent = "tinybot";
  const title = targetDocument.createElement("h1");
  title.className = "desktop-chat-title";
  title.textContent = activeChatTitle(chat);
  if (canMountVueIsland(title)) {
    mountChatTitleIsland(title, { title: activeChatTitle(chat) });
  }
  titleGroup.append(context, title);
  const headerStatus = createChatHeaderStatus(targetDocument, chat, chatActions);
  if (headerStatus) {
    titleGroup.append(headerStatus);
  }
  const menu = targetDocument.createElement("button");
  menu.type = "button";
  menu.className = "desktop-chat-menu";
  menu.setAttribute("data-desktop-chat-menu", "more");
  menu.setAttribute("aria-haspopup", "menu");
  menu.setAttribute("aria-expanded", "false");
  menu.setAttribute("aria-label", "More chat actions");
  menu.textContent = "...";

  const popover = createChatMenuPopover(targetDocument, chat, activeSession, title, menu, chatActions);
  mountChatMenuButtonVueIsland(menu, popover);
  targetDocument.addEventListener("click", (event) => {
    if (popover.hidden) {
      return;
    }
    const target = "target" in event ? event.target : null;
    if (isEventTargetInsideElement(target, menu) || isEventTargetInsideElement(target, popover)) {
      return;
    }
    closeChatMenuPopover(menu, popover);
  });

  titleRow.append(titleGroup, menu, popover);

  const actions = targetDocument.createElement("div");
  actions.className = "desktop-chat-header-actions";

  header.append(titleRow, actions);
  return header;
}

function createChatHeaderStatus(
  targetDocument: Document,
  chat: DesktopNativeChatModel | null,
  chatActions: DesktopNativeChatActionOptions,
): HTMLElement | null {
  if (chat?.responding !== true && chat?.composerState !== "sending" && chat?.composerState !== "queued") {
    return null;
  }
  const status = targetDocument.createElement("div");
  status.className = "desktop-chat-header-status";
  status.setAttribute("aria-label", "Chat response controls");
  status.setAttribute("data-desktop-chat-region", "header-status");
  const stop = targetDocument.createElement("button");
  stop.type = "button";
  stop.className = "desktop-chat-header-stop";
  stop.setAttribute("aria-label", "Stop current response");
  stop.setAttribute("data-desktop-chat-action", "stop");
  stop.textContent = "Stop";
  stop.addEventListener("click", () => chatActions.onInterrupt?.());
  status.append(stop);
  return status;
}

function mountChatMenuButtonVueIsland(menu: HTMLElement, popover: HTMLElement): void {
  const toggle = () => toggleChatMenuPopover(menu, popover);
  const installFallback = () => {
    menu.addEventListener("click", toggle);
  };
  if (!canMountVueIsland(menu)) {
    installFallback();
    return;
  }
  mountChatMenuButtonIsland(menu, {
    expanded: menu.getAttribute("aria-expanded") === "true",
    onToggle: toggle,
  });
}

function toggleChatMenuPopover(menu: HTMLElement, popover: HTMLElement): void {
  const expanded = menu.getAttribute("aria-expanded") === "true";
  menu.setAttribute("aria-expanded", String(!expanded));
  popover.hidden = expanded;
}

function closeChatMenuPopover(menu: HTMLElement, popover: HTMLElement): void {
  menu.setAttribute("aria-expanded", "false");
  popover.hidden = true;
}

function isEventTargetInsideElement(target: EventTarget | null, element: HTMLElement): boolean {
  return typeof Node !== "undefined" && target instanceof Node && (target === element || element.contains(target));
}

function activeChatSession(chat: DesktopNativeChatModel | null): NativeChatSession | null {
  if (!chat?.activeSessionKey) {
    return null;
  }
  return chat.sessions.find((session) => session.key === chat.activeSessionKey) ?? null;
}

function createChatMenuPopover(
  targetDocument: Document,
  chat: DesktopNativeChatModel | null,
  session: NativeChatSession | null,
  titleElement: HTMLElement,
  trigger: HTMLElement,
  chatActions: DesktopNativeChatActionOptions,
): HTMLElement {
  const popover = targetDocument.createElement("div");
  popover.className = "desktop-chat-menu-popover";
  popover.setAttribute("role", "menu");
  popover.setAttribute("aria-label", "Chat session actions");
  popover.hidden = true;

  const close = () => {
    popover.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
  };

  const popoverActions: Array<{
    action: string;
    disabled: boolean;
    label: string;
    onAction: () => string | void;
  }> = [];

  const appendAction = (action: string, label: string, handler: (button: HTMLElement) => void, disabled = false) => {
    const button = targetDocument.createElement("button");
    button.type = "button";
    button.className = "desktop-chat-menu-action";
    button.setAttribute("role", "menuitem");
    button.setAttribute("data-desktop-chat-menu-action", action);
    button.textContent = label;
    if (disabled) {
      button.setAttribute("disabled", "");
    }
    button.addEventListener("click", (event) => {
      event.preventDefault?.();
      event.stopPropagation?.();
      if (disabled) {
        return;
      }
      handler(button);
      close();
    });
    mountChatMenuActionVueIsland(button, { action, disabled, label });
    popover.append(button);
    popoverActions.push({
      action,
      disabled,
      label,
      onAction: () => {
        if (disabled) {
          return;
        }
        handler(button);
        close();
        return button.textContent ?? undefined;
      },
    });
    return button;
  };

  const initialPinned = session ? isSessionPinned(targetDocument, session.key) : false;
  appendAction(
    "pin",
    initialPinned ? "Unpin session" : "Pin session",
    (button) => {
      if (!session) {
        return;
      }
      const pinned = toggleActiveSessionPinned(targetDocument, session);
      button.textContent = pinned ? "Unpin session" : "Pin session";
      chatActions.onPinSession?.({
        sessionKey: session.key,
        chatId: session.chatId,
        title: session.title || "New session",
        pinned,
      });
    },
    !session,
  );
  appendAction(
    "rename",
    "Rename session",
    () => {
      if (!session) {
        return;
      }
      startInlineSessionRename(targetDocument, session, titleElement, chatActions);
    },
    !session,
  );
  appendAction("new-chat", "New chat", () => chatActions.onNewChat?.(), !chatActions.onNewChat);

  if (!chat?.sessions.length) {
    const empty = createText(targetDocument, "span", "No active session");
    empty.className = "desktop-chat-menu-empty";
    mountChatMenuEmptyVueIsland(empty, "No active session");
    popover.append(empty);
  }

  mountChatMenuPopoverVueIsland(popover, {
    actions: popoverActions,
    emptyMessage: !chat?.sessions.length ? "No active session" : "",
  });
  return popover;
}

function mountChatMenuPopoverVueIsland(
  popover: HTMLElement,
  options: {
    actions: Array<{
      action: string;
      disabled: boolean;
      label: string;
      onAction: () => string | void;
    }>;
    emptyMessage: string;
  },
): void {
  if (!canMountVueIsland(popover)) {
    return;
  }
  mountChatMenuPopoverIsland(popover, options);
}

function mountChatMenuEmptyVueIsland(empty: HTMLElement, message: string): void {
  if (!canMountVueIsland(empty)) {
    return;
  }
  mountChatMenuEmptyIsland(empty, { message });
}

function mountChatMenuActionVueIsland(
  button: HTMLElement,
  options: { action: string; disabled: boolean; label: string },
): void {
  if (!canMountVueIsland(button)) {
    return;
  }
  mountChatMenuActionIsland(button, options);
}

function pinnedSessionKeysForDocument(targetDocument: Document): Set<string> {
  let keys = desktopPinnedChatSessions.get(targetDocument);
  if (!keys) {
    keys = new Set<string>();
    desktopPinnedChatSessions.set(targetDocument, keys);
  }
  return keys;
}

function isSessionPinned(targetDocument: Document, sessionKey: string): boolean {
  return pinnedSessionKeysForDocument(targetDocument).has(sessionKey);
}

function setSessionPinned(targetDocument: Document, sessionKey: string, pinned: boolean): void {
  const keys = pinnedSessionKeysForDocument(targetDocument);
  if (pinned) {
    keys.add(sessionKey);
    return;
  }
  keys.delete(sessionKey);
}

function toggleActiveSessionPinned(targetDocument: Document, session: NativeChatSession): boolean {
  const row = findSessionRow(targetDocument, session.key);
  const pinned = !isSessionPinned(targetDocument, session.key);
  setSessionPinned(targetDocument, session.key, pinned);
  row?.setAttribute("data-pinned", String(pinned));
  syncSessionRowPinIcon(targetDocument, session.key, pinned);
  if (pinned) {
    const list = targetDocument.querySelector<HTMLElement>(".desktop-recent-chat-list");
    if (list && row) {
      const rows = Array.from(list.children).filter((child) => child !== row);
      list.replaceChildren(row, ...rows);
    }
  }
  return pinned;
}

function startInlineSessionRename(
  targetDocument: Document,
  session: NativeChatSession,
  titleElement: HTMLElement,
  chatActions: DesktopNativeChatActionOptions,
): void {
  const existingEditor = titleElement.querySelector<HTMLInputElement>(".desktop-chat-title-editor");
  if (existingEditor) {
    focusSessionTitleEditor(existingEditor);
    return;
  }

  const currentTitle = session.title || "New session";
  const editor = targetDocument.createElement("input");
  editor.type = "text";
  editor.className = "desktop-chat-title-editor";
  editor.setAttribute("aria-label", "Rename session");
  editor.value = currentTitle;

  let closed = false;
  const closeEditor = (nextTitle = currentTitle) => {
    closed = true;
    titleElement.replaceChildren();
    titleElement.textContent = nextTitle;
  };
  const commit = () => {
    if (closed) {
      return;
    }
    const renamedTitle = editor.value.trim();
    if (!renamedTitle || renamedTitle === currentTitle) {
      closeEditor();
      return;
    }
    session.title = renamedTitle;
    updateSessionRowTitle(targetDocument, session.key, renamedTitle);
    closeEditor(renamedTitle);
    chatActions.onRenameSession?.({
      sessionKey: session.key,
      chatId: session.chatId,
      title: renamedTitle,
    });
  };
  const cancel = () => {
    if (!closed) {
      closeEditor();
    }
  };

  editor.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  });
  editor.addEventListener("blur", commit);

  titleElement.textContent = "";
  titleElement.replaceChildren(editor);
  focusSessionTitleEditor(editor);
}

function focusSessionTitleEditor(editor: HTMLInputElement): void {
  editor.focus?.({ preventScroll: true });
  editor.setSelectionRange?.(0, editor.value.length);
}

function updateSessionRowTitle(targetDocument: Document, sessionKey: string, title: string): void {
  const row = findSessionRow(targetDocument, sessionKey);
  const label = row?.querySelector<HTMLElement>(".desktop-sidebar-row-label");
  if (label) {
    label.textContent = title;
  }
}

function syncSessionRowPinIcon(targetDocument: Document, sessionKey: string, pinned: boolean): void {
  const row = findSessionRow(targetDocument, sessionKey);
  const titleWrap = row?.querySelector<HTMLElement>(".desktop-sidebar-row-title");
  if (titleWrap) {
    setSessionRowPinIcon(targetDocument, titleWrap, pinned);
  }
}

function setSessionRowPinIcon(targetDocument: Document, titleWrap: HTMLElement, pinned: boolean): void {
  const label = titleWrap.querySelector<HTMLElement>(".desktop-sidebar-row-label");
  if (!label) {
    return;
  }
  if (!pinned) {
    titleWrap.replaceChildren(label);
    return;
  }
  const icon = targetDocument.createElement("span");
  icon.className = "desktop-sidebar-pin-icon";
  icon.setAttribute("data-desktop-session-pin-icon", "");
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "📌";
  titleWrap.replaceChildren(icon, label);
}

function findSessionRow(targetDocument: Document, sessionKey: string): HTMLElement | null {
  return Array.from(targetDocument.querySelectorAll<HTMLElement>("[data-desktop-session-key]"))
    .find((row) => row.getAttribute("data-desktop-session-key") === sessionKey) ?? null;
}

function createConversationThread(
  targetDocument: Document,
  chat: DesktopNativeChatModel | null,
  _inlineForms: AgentUiForm[] = [],
  _agentUiActions: DesktopAgentUiFormActionOptions = {},
): HTMLElement {
  const thread = targetDocument.createElement("section");
  thread.className = "desktop-conversation-thread";
  thread.setAttribute("aria-label", "Message Timeline");
  thread.setAttribute("aria-live", "polite");
  thread.setAttribute("data-desktop-chat-region", "message-timeline");
  thread.setAttribute("role", "log");
  if (chat) {
    mountRebuiltChatSurface(thread, chat);
    return thread;
  }
  thread.append(
    createConversationMessage(targetDocument, {
      author: "You",
      time: "10:28 AM",
      tone: "user",
      body: ["这是目前的 native 界面，我希望你帮我设计一个更接近 codex 风格的界面。"],
    }),
    createConversationMessage(targetDocument, {
      author: "Tinybot",
      time: "10:28 AM",
      tone: "assistant",
      body: [
        "好的，根据你的需求，我为 Tinybot native workbench 设计了一个更统一、简洁、专业的界面方向。",
        "三栏布局：左侧导航 + 主会话区 + 右侧运行链面板",
        "采用轻量配色与更清晰的层级，提升可读性和信息密度",
        "底部 Composer 贴合 Codex 风格，支持附件与模型选择",
        "运行链面板提供上下文、文件与任务的快速访问",
      ],
      attachment: "tinybot_native_workbench_design.png",
    }),
  );
  return thread;
}

function mountRebuiltChatSurface(thread: HTMLElement, chat: DesktopNativeChatModel): void {
  mountChatSurface(thread, {
    projection: projectDesktopNativeChat(thread.ownerDocument, chat),
  });
}

function projectDesktopNativeChat(targetDocument: Document, chat: DesktopNativeChatModel): ChatUiProjection {
  const projection = projectNativeChatState(desktopNativeChatToProjectionState(chat));
  projection.liveSubagents.push(...chatCoworkRuns(targetDocument, chat).flatMap(coworkRunToLiveSubagents));
  return projection;
}

function desktopNativeChatToProjectionState(chat: DesktopNativeChatModel) {
  const state = createNativeChatState();
  state.sessions = chat.sessions;
  state.activeSessionKey = chat.activeSessionKey;
  state.activeChatId = chat.activeChatId;
  if (chat.activeSessionKey) {
    state.messages.set(chat.activeSessionKey, chat.messages);
    if (chat.responding === true) {
      state.respondingSessionKeys.add(chat.activeSessionKey);
    }
  }
  return state;
}

function coworkRunToLiveSubagents(run: ConversationCoworkRunOptions): LiveSubagent[] {
  if (!run.agents.length) {
    return [{
      id: run.id,
      sessionKey: run.id,
      name: run.title,
      task: run.workflow,
      status: coworkStatusToSubagentStatus(run.status),
      latestActivity: run.finalOutput || run.attentionLabel || run.taskProgress,
      capabilities: ["partial_transcript"],
      transcript: {
        id: run.id,
        sessionKey: run.id,
        capability: "partial_transcript",
        messages: run.finalOutput ? [{
          id: `${run.id}:summary`,
          role: "assistant",
          content: run.finalOutput,
        }] : [],
        toolSummaries: [],
      },
    }];
  }
  return run.agents.map((agent) => ({
    id: agent.id,
    sessionKey: run.id,
    name: agent.label,
    task: agent.roleOrTask || run.title,
    status: coworkStatusToSubagentStatus(agent.status),
    latestActivity: agent.latestActivity || agent.attentionLabel || run.attentionLabel,
    capabilities: ["partial_transcript"],
    transcript: {
      id: agent.id,
      sessionKey: run.id,
      capability: "partial_transcript",
      messages: agent.latestActivity ? [{
        id: `${agent.id}:activity`,
        role: "assistant",
        content: agent.latestActivity,
      }] : [],
      toolSummaries: [],
    },
  }));
}

function coworkStatusToSubagentStatus(status: string): SubagentStatus {
  switch (status.toLowerCase()) {
    case "active":
    case "running":
      return "running";
    case "blocked":
    case "paused":
      return "waiting_user";
    case "completed":
    case "done":
    case "succeeded":
      return "completed";
    default:
      return "idle";
  }
}

function createConversationMessage(
  targetDocument: Document,
  options: {
    attachment?: string;
    author: string;
    body: string[];
    copyable?: boolean;
    references?: NativeChatMessage["references"];
    reasoningContent?: string;
    time: string;
    tone: "user" | "assistant";
    toolActivities?: ConversationToolActivityRenderOptions[];
  },
): HTMLElement {
  const article = targetDocument.createElement("article");
  article.className = "desktop-conversation-message";
  article.setAttribute("data-message-tone", options.tone);

  const content = targetDocument.createElement("div");
  content.className = options.tone === "user"
    ? "desktop-conversation-content desktop-user-message-bubble"
    : "desktop-conversation-content";
  if (options.tone === "assistant") {
    const header = targetDocument.createElement("div");
    header.className = "desktop-conversation-header";
    const meta = targetDocument.createElement("div");
    meta.className = "desktop-conversation-meta";
    const separator = createText(targetDocument, "span", " · ");
    separator.className = "desktop-conversation-meta-separator";
    separator.textContent = " · ";
    separator.setAttribute("aria-hidden", "true");
    meta.append(createText(targetDocument, "strong", options.author), separator, createText(targetDocument, "span", options.time));
    mountConversationMetaVueIsland(meta, { author: options.author, time: options.time });
    header.append(meta);
    content.append(header);
  }
  if (options.reasoningContent?.trim()) {
    content.append(createConversationReasoning(targetDocument, options.reasoningContent));
  }
  if (options.toolActivities?.length) {
    content.append(createToolActivities(targetDocument, options.toolActivities));
  }
  content.append(createConversationBody(targetDocument, options.body, options.tone));
  const referenceGroups = createConversationReferenceGroups(targetDocument, options.references ?? []);
  if (referenceGroups) {
    content.append(referenceGroups);
  }
  if (options.attachment) {
    const attachment = targetDocument.createElement("div");
    attachment.className = "desktop-conversation-attachment";
    attachment.textContent = conversationAttachmentText(options.attachment, "1.2 MB");
    mountConversationAttachmentVueIsland(attachment, {
      name: options.attachment,
      sizeLabel: "1.2 MB",
    });
    content.append(attachment);
  }
  if (options.tone === "assistant") {
    const actions = targetDocument.createElement("div");
    actions.className = "desktop-message-actions";
    actions.append(createConversationCopyButton(targetDocument, options.body));
    content.append(actions);
  }
  article.append(content);
  mountConversationMessageVueIsland(article, {
    attachment: options.attachment,
    author: options.author,
    body: options.body,
    references: (options.references ?? []).map((reference) => ({
      detail: reference.detail ?? "",
      evidenceId: reference.evidenceId,
      kind: reference.kind,
      noteId: reference.noteId,
      rawLine: reference.rawLine,
      rawPath: reference.rawPath,
      scope: reference.scope,
      sourceLine: reference.sourceLine,
      sourcePath: reference.sourcePath,
      sourceText: reference.sourceText,
      title: reference.title,
      type: reference.type,
    })),
    reasoningContent: options.reasoningContent,
    time: options.time,
    tone: options.tone,
    toolActivities: (options.toolActivities ?? []).map((activity) => ({
      approvalId: activity.approvalId,
      argsText: activity.argsText || "",
      approvalStatus: activity.approvalStatus || "",
      id: activity.id || "",
      kind: activity.kind,
      name: activity.name || "",
      responseText: activity.responseText || "",
      runChainItemKey: activity.runChainItemKey,
      sessionKey: activity.sessionKey,
      status: activity.status,
    })),
  });
  return article;
}

function mountConversationMessageVueIsland(
  message: HTMLElement,
  options: {
    attachment?: string;
    author: string;
    body: string[];
    references: Array<{ detail: string; kind: string; title: string }>;
    reasoningContent?: string;
    time: string;
    tone: "assistant" | "user";
    toolActivities: Array<{
      approvalId?: string;
      argsText: string;
      approvalStatus: string;
      id: string;
      kind: "call" | "result";
      name: string;
      responseText: string;
      runChainItemKey?: string;
      sessionKey?: string;
      status?: string;
    }>;
  },
): void {
  if (!canMountVueIsland(message)) {
    return;
  }
    mountConversationMessageIsland(message, options);
}

function mountConversationMetaVueIsland(meta: HTMLElement, options: { author: string; time: string }): void {
  if (!canMountVueIsland(meta)) {
    return;
  }
  mountConversationMetaIsland(meta, options);
}

function createConversationCopyButton(targetDocument: Document, body: string[]): HTMLElement {
  const button = targetDocument.createElement("button");
  button.type = "button";
  button.className = "desktop-message-copy-button";
  button.setAttribute("aria-label", "Copy message");
  button.setAttribute("title", "Copy message");
  const icon = targetDocument.createElement("span");
  icon.className = "desktop-message-copy-icon";
  icon.setAttribute("aria-hidden", "true");
  button.append(icon);
  button.addEventListener("click", () => {
    const copyAttempt = copyDesktopText(body.filter((line) => line.trim()).join("\n\n"), targetDocument);
    button.setAttribute("aria-label", "Copied");
    button.setAttribute("title", "Copied");
    void copyAttempt
      .catch(() => {
        button.setAttribute("aria-label", "Failed");
        button.setAttribute("title", "Failed");
      });
  });
  return button;
}

function createConversationReferenceGroups(
  targetDocument: Document,
  references: Array<{ detail?: string; kind: string; title: string }>,
): HTMLElement | null {
  const groups = groupConversationReferences(references);
  if (!groups.length) {
    return null;
  }
  const wrapper = targetDocument.createElement("div");
  wrapper.className = "desktop-message-references";
  for (const group of groups) {
    const details = targetDocument.createElement("details");
    details.className = `desktop-message-reference-group desktop-message-reference-group-${group.id}`;
    const summary = targetDocument.createElement("summary");
    summary.className = "desktop-message-references-summary";
    const title = createText(targetDocument, "span", group.label);
    title.className = "desktop-message-references-title";
    const count = createText(targetDocument, "span", `${group.references.length} ${group.references.length === 1 ? "source" : "sources"}`);
    count.className = "desktop-message-references-count";
    summary.append(title, count);
    const list = targetDocument.createElement("div");
    list.className = "desktop-message-reference-list";
    for (const reference of group.references) {
      const item = targetDocument.createElement("article");
      item.className = "desktop-message-reference-item desktop-conversation-reference";
      item.setAttribute("data-desktop-vue-island", "conversation-reference");
      item.setAttribute("data-desktop-reference-island", mountConversationReferenceIsland.name);
      item.setAttribute("data-desktop-reference-kind", reference.kind);
      const kind = createText(targetDocument, "span", `${reference.kind}: `);
      kind.className = "desktop-message-reference-kind";
      const referenceTitle = createText(targetDocument, "strong", reference.title);
      referenceTitle.className = "desktop-message-reference-title";
      item.append(kind, referenceTitle);
      if (reference.detail) {
        const detail = createText(targetDocument, "span", reference.detail);
        detail.className = "desktop-message-reference-detail";
        item.append(detail);
      }
      list.append(item);
    }
    details.append(summary, list);
    wrapper.append(details);
  }
  return wrapper;
}

function groupConversationReferences(
  references: Array<{ detail?: string; kind: string; title: string }>,
): Array<{ id: string; label: string; references: Array<{ detail?: string; kind: string; title: string }> }> {
  const groups: Array<{ id: string; label: string; references: Array<{ detail?: string; kind: string; title: string }> }> = [];
  for (const reference of references) {
    const id = normalizeConversationReferenceKind(reference.kind);
    const group = groups.find((candidate) => candidate.id === id);
    if (group) {
      group.references.push(reference);
    } else {
      groups.push({ id, label: conversationReferenceGroupLabel(id), references: [reference] });
    }
  }
  return groups;
}

function normalizeConversationReferenceKind(kind: string): string {
  const normalized = kind.toLowerCase();
  if (normalized.includes("memory")) {
    return "memory";
  }
  if (normalized.includes("recent")) {
    return "recent";
  }
  if (normalized.includes("browser")) {
    return "browser";
  }
  if (normalized.includes("file") || normalized.includes("reference")) {
    return "file";
  }
  return "reference";
}

function conversationReferenceGroupLabel(kind: string): string {
  if (kind === "memory") {
    return "Memory references";
  }
  if (kind === "recent") {
    return "Recent context";
  }
  if (kind === "browser") {
    return "Browser references";
  }
  if (kind === "file") {
    return "File references";
  }
  return "References";
}

function conversationAttachmentText(name: string, sizeLabel: string): string {
  return `${name}${sizeLabel ? `  ${sizeLabel}` : ""}`;
}

function mountConversationAttachmentVueIsland(
  attachment: HTMLElement,
  options: { name: string; sizeLabel: string },
): void {
  if (!canMountVueIsland(attachment)) {
    return;
  }
  mountConversationAttachmentIsland(attachment, options);
}

function createConversationReasoning(targetDocument: Document, reasoningContent: string): HTMLElement {
  const details = targetDocument.createElement("details");
  details.className = "desktop-message-reasoning";
  const summary = targetDocument.createElement("summary");
  summary.className = "desktop-message-reasoning-summary";
  summary.append(createText(targetDocument, "span", "Thinking complete"));
  const body = createText(targetDocument, "div", reasoningContent);
  body.className = "desktop-message-reasoning-body";
  details.append(summary, body);
  mountConversationReasoningVueIsland(details, reasoningContent);
  return details;
}

function mountConversationReasoningVueIsland(reasoning: HTMLElement, content: string): void {
  if (!canMountVueIsland(reasoning)) {
    return;
  }
  mountConversationReasoningIsland(reasoning, { content });
}

function createToolActivities(
  targetDocument: Document,
  activities: ConversationToolActivityRenderOptions[],
): HTMLElement {
  const wrapper = targetDocument.createElement("div");
  wrapper.className = "desktop-tool-activities";
  wrapper.setAttribute("aria-label", "Tool Timeline");
  wrapper.setAttribute("data-desktop-chat-region", "tool-timeline");
  for (const activity of activities) {
    wrapper.append(createToolActivity(targetDocument, activity));
  }
  mountToolActivitiesVueIsland(wrapper, activities.map((activity) => ({
    approvalId: activity.approvalId,
    argsText: activity.argsText || "",
    approvalStatus: activity.approvalStatus || "",
    id: activity.id || "",
    kind: activity.kind,
    name: activity.name || "",
    responseText: activity.responseText || "",
    runChainItemKey: activity.runChainItemKey,
    sessionKey: activity.sessionKey,
    status: activity.status,
  })));
  return wrapper;
}

function mountToolActivitiesVueIsland(
  wrapper: HTMLElement,
  activities: Array<{
    approvalId?: string;
    argsText: string;
    approvalStatus: string;
    id: string;
    kind: "call" | "result";
    name: string;
    responseText: string;
    runChainItemKey?: string;
    sessionKey?: string;
    status?: string;
  }>,
): void {
  if (!canMountVueIsland(wrapper)) {
    return;
  }
  mountToolActivitiesIsland(wrapper, { activities });
}

function createToolActivity(
  targetDocument: Document,
  activity: ConversationToolActivityRenderOptions,
): HTMLElement {
  const wrapper = targetDocument.createElement("div");
  wrapper.className = "desktop-tool-activity";
  wrapper.setAttribute("data-desktop-tool-activity-kind", activity.kind);
  const activityStatus = normalizeToolStatusModel(activity);
  wrapper.setAttribute("data-desktop-tool-activity-status", activityStatus.status);
  wrapper.setAttribute("data-desktop-tool-status", activityStatus.status);
  wrapper.setAttribute("data-desktop-tool-status-tone", getToolStatusTone(activityStatus));
  if (isPendingToolApprovalState(activity)) {
    wrapper.setAttribute("data-desktop-approval-status", activity.approvalStatus || "");
  }
  if (activity.id) {
    wrapper.setAttribute("data-desktop-tool-activity-id", activity.id);
  }
  if (activity.runChainItemKey) {
    wrapper.setAttribute("data-desktop-run-chain-item-key", activity.runChainItemKey);
  }

  const row = targetDocument.createElement("button");
  row.className = "desktop-tool-activity-row";
  row.type = "button";
  row.setAttribute("aria-label", `Open ${activity.name || "unknown"} tool details, ${getToolStatusLabel(activityStatus)}`);
  row.setAttribute("aria-selected", "false");
  row.addEventListener("click", () => {
    if (activity.runChainItemKey) {
      inspectRunChainItemFromConversation(targetDocument, activity.runChainItemKey);
      dispatchDesktopCustomEvent(targetDocument, "desktop-run-chain-inspect", { itemKey: activity.runChainItemKey });
    }
    dispatchDesktopCustomEvent(targetDocument, "desktop-tool-detail-open", {
      activity,
      normalizedStatus: activityStatus,
    });
  });
  const dot = targetDocument.createElement("span");
  dot.className = "desktop-tool-activity-status-dot";
  dot.setAttribute("aria-hidden", "true");
  dot.setAttribute("data-tool-status-tone", getToolStatusTone(activityStatus));
  const kind = createText(targetDocument, "span", "Tool");
  kind.className = "desktop-tool-activity-kind";
  const separatorOne = createText(targetDocument, "span", "·");
  separatorOne.className = "desktop-tool-activity-separator";
  separatorOne.setAttribute("aria-hidden", "true");
  const main = targetDocument.createElement("span");
  main.className = "desktop-tool-activity-main";
  const title = createText(targetDocument, "span", activity.name || "unknown");
  title.className = "desktop-tool-activity-title";
  main.append(title);
  const separatorTwo = createText(targetDocument, "span", "·");
  separatorTwo.className = "desktop-tool-activity-separator";
  separatorTwo.setAttribute("aria-hidden", "true");
  const status = createText(targetDocument, "span", getToolStatusLabel(activityStatus));
  status.className = "desktop-tool-activity-status-label";
  status.setAttribute("data-tool-status-tone", getToolStatusTone(activityStatus));
  row.append(dot, kind, separatorOne, main, separatorTwo, status);
  wrapper.append(row);
  if (isPendingToolApprovalState(activity)) {
    wrapper.append(createToolApprovalCard(targetDocument, activity));
  }
  mountToolActivityVueIsland(wrapper, {
    approvalId: activity.approvalId,
    argsText: activity.argsText || "",
    approvalStatus: activity.approvalStatus || "",
    id: activity.id || "",
    kind: activity.kind,
    name: activity.name || "",
    responseText: activity.responseText || "",
    runChainItemKey: activity.runChainItemKey,
    sessionKey: activity.sessionKey,
    status: activity.status,
  });
  return wrapper;
}

function createToolApprovalCard(
  targetDocument: Document,
  activity: ConversationToolActivityRenderOptions,
): HTMLElement {
  const card = targetDocument.createElement("section");
  card.className = "desktop-tool-approval-card";
  card.setAttribute("aria-label", `Approval required for ${activity.name || "tool"}`);
  card.setAttribute("data-desktop-chat-region", "approval-card");
  card.setAttribute("role", "group");

  const header = targetDocument.createElement("div");
  header.className = "desktop-tool-approval-card-header";
  const title = createText(targetDocument, "strong", "Approval required");
  title.className = "desktop-tool-approval-title";
  const tool = createText(targetDocument, "span", activity.name || "unknown");
  tool.className = "desktop-tool-approval-tool";
  header.append(title, tool);

  const command = createText(targetDocument, "pre", summarizeToolText(activity.argsText || activity.responseText));
  command.className = "desktop-tool-approval-command";

  const actions = targetDocument.createElement("div");
  actions.className = "desktop-tool-approval-actions";
  if (activity.approvalId) {
    actions.append(
      createToolApprovalActionButton(targetDocument, activity, "approveOnce", "Approve once"),
      createToolApprovalActionButton(targetDocument, activity, "approveSession", "Allow session"),
      createToolApprovalActionButton(targetDocument, activity, "deny", "Deny"),
    );
  }
  const action = createText(targetDocument, "button", activity.approvalId ? "Review details" : "Review approval") as HTMLButtonElement;
  action.className = "desktop-tool-approval-action desktop-tool-approval-action-review";
  action.setAttribute("data-desktop-approval-action", "review");
  action.type = "button";
  action.addEventListener("click", () => {
    if (activity.runChainItemKey) {
      inspectRunChainItemFromConversation(targetDocument, activity.runChainItemKey);
      dispatchDesktopCustomEvent(targetDocument, "desktop-run-chain-inspect", { itemKey: activity.runChainItemKey });
    }
  });
  actions.append(action);

  card.append(header, command, actions);
  return card;
}

function createToolApprovalActionButton(
  targetDocument: Document,
  activity: ConversationToolActivityRenderOptions,
  action: "approveOnce" | "approveSession" | "deny",
  label: string,
): HTMLButtonElement {
  const button = createText(targetDocument, "button", label) as HTMLButtonElement;
  button.className = `desktop-tool-approval-action desktop-tool-approval-action-${action}`;
  button.setAttribute("data-desktop-approval-action", action);
  button.type = "button";
  button.addEventListener("click", () => {
    if (!activity.approvalId) {
      return;
    }
    dispatchDesktopCustomEvent(targetDocument, "desktop-tool-approval-action", {
      action,
      approvalId: activity.approvalId,
      runChainItemKey: activity.runChainItemKey,
      sessionKey: activity.sessionKey,
      toolActivityId: activity.id,
      toolName: activity.name || "unknown",
    });
  });
  return button;
}

function mountToolActivityVueIsland(
  activity: HTMLElement,
  options: {
    approvalId?: string;
    argsText: string;
    approvalStatus: string;
    id: string;
    kind: "call" | "result";
    name: string;
    responseText: string;
    runChainItemKey?: string;
    sessionKey?: string;
    status?: string;
  },
): void {
  if (!canMountVueIsland(activity)) {
    return;
  }
  mountToolActivityIsland(activity, options);
}

function summarizeToolText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "No details";
  }
  return normalized.length > 96 ? `${normalized.slice(0, 93)}...` : normalized;
}

function createConversationBody(
  targetDocument: Document,
  body: string[],
  tone: "user" | "assistant",
): HTMLElement {
  const node = targetDocument.createElement("div");
  node.className = "desktop-conversation-body";
  const content = body.filter((line) => line.trim()).join("\n\n");
  if (tone === "assistant") {
    renderConversationMarkdown(node, content);
    mountConversationBodyVueIsland(node, { body, tone });
    return node;
  }
  for (const line of body) {
    node.append(createText(targetDocument, "p", line));
  }
  mountConversationBodyVueIsland(node, { body, tone });
  return node;
}

function mountConversationBodyVueIsland(
  body: HTMLElement,
  options: { body: string[]; tone: "assistant" | "user" },
): void {
  if (!canMountVueIsland(body)) {
    return;
  }
  mountConversationBodyIsland(body, options);
}

function renderConversationMarkdown(target: HTMLElement, content: string): void {
  target.textContent = "";
  if (!content.trim()) {
    return;
  }
  try {
    const html = marked.parse(content, { breaks: true, gfm: true, async: false });
    target.innerHTML = addMarkdownLinkAttributes(typeof html === "string" ? html : content);
    target.querySelectorAll("pre code").forEach((block) => {
      hljs.highlightElement(block as HTMLElement);
    });
    addConversationCodeCopyButtons(target);
  } catch {
    target.textContent = content;
  }
}

function addMarkdownLinkAttributes(html: string): string {
  return html.replace(/<a\s+(?![^>]*\btarget=)([^>]*href=)/gi, '<a target="_blank" rel="noreferrer" $1');
}

function addConversationCodeCopyButtons(target: HTMLElement): void {
  target.querySelectorAll("pre").forEach((pre) => {
    const button = target.ownerDocument.createElement("button");
    button.type = "button";
    button.className = "desktop-code-copy-button";
    button.setAttribute("aria-label", "Copy code");
    button.textContent = "Copy";
    button.addEventListener("click", () => {
      const code = pre.querySelector("code");
      const copyAttempt = copyDesktopText((code?.textContent ?? pre.textContent ?? "").trimEnd(), target.ownerDocument);
      button.textContent = "Copied";
      void copyAttempt
        .catch(() => {
          button.textContent = "Failed";
        });
    });
    pre.append(button);
  });
}

function createNativeComposerSurface(
  targetDocument: Document,
  chat: DesktopNativeChatModel | null,
  chatActions: DesktopNativeChatActionOptions = {},
): HTMLElement {
  const composer = targetDocument.createElement("form");
  composer.id = "desktop-native-composer";
  composer.className = "desktop-native-composer";
  composer.setAttribute("aria-label", "Native desktop composer");
  if (chat?.activeSessionKey) {
    composer.setAttribute("data-active-session-key", chat.activeSessionKey);
  }
  composer.setAttribute("data-desktop-composer-responding", String(chat?.responding === true));
  composer.setAttribute("data-desktop-composer-rag", String(chat?.usePersistentRag !== false));
  composer.setAttribute("data-desktop-composer-state", nativeComposerState(chat));

  const attach = targetDocument.createElement("button");
  attach.id = "desktop-native-composer-attach";
  attach.type = "button";
  attach.className = "desktop-native-composer-action";
  attach.setAttribute("data-desktop-composer-action", "attach");
  attach.setAttribute("aria-label", "Attach temporary file to current session");
  attach.textContent = "+";
  mountComposerAttachButtonVueIsland(attach, chatActions);

  const input = targetDocument.createElement("textarea");
  input.id = "desktop-native-composer-input";
  input.className = "desktop-native-composer-input";
  input.setAttribute("aria-label", "Native composer input");
  input.setAttribute("placeholder", "Ask Tinybot");
  input.setAttribute("rows", "1");
  input.setAttribute("data-max-rows", "3");
  (input as HTMLTextAreaElement).rows = 1;
  resizeNativeComposerInput(input as HTMLTextAreaElement);

  const send = targetDocument.createElement("button");
  send.id = "desktop-native-composer-send";
  send.type = "button";
  send.className = "desktop-native-composer-send";
  send.setAttribute("data-desktop-composer-action", "send");
  send.setAttribute("aria-label", "Send message");
  send.replaceChildren(createComposerSendIcon(targetDocument));
  updateNativeComposerSendState(input as HTMLTextAreaElement, send as HTMLButtonElement, chat);
  input.addEventListener("input", () => {
    resizeNativeComposerInput(input as HTMLTextAreaElement);
    updateNativeComposerSendState(input as HTMLTextAreaElement, send as HTMLButtonElement, chat);
  });
  mountComposerSendButtonVueIsland(send, input as HTMLTextAreaElement, chat, chatActions);

  const runtime = targetDocument.createElement("div");
  runtime.id = "desktop-native-composer-runtime";
  runtime.className = "desktop-native-composer-runtime";
  runtime.setAttribute("data-desktop-composer-region", "runtime-status");
  runtime.setAttribute("aria-label", "Runtime status");
  runtime.append(
    createComposerModelControl(targetDocument, chat, chatActions),
    createPersistentRagToggle(targetDocument, chat, chatActions),
    createTokenUsageOrb(targetDocument, chat?.runtime?.tokenUsage || "-"),
  );
  mountComposerRuntimeVueIsland(runtime, chat, chatActions);

  composer.append(input, attach, runtime, send);
  mountComposerSurfaceVueIsland(composer, chat, chatActions);
  return composer;
}

function resizeNativeComposerInput(input: HTMLTextAreaElement): void {
  const lineHeight = 24;
  const maxHeight = lineHeight * 3;
  input.style.height = "auto";
  input.style.height = `${Math.min(Math.max(input.scrollHeight || lineHeight, lineHeight), maxHeight)}px`;
}

function createComposerSendIcon(targetDocument: Document): SVGElement {
  const icon = targetDocument.createElement("svg") as unknown as SVGElement;
  icon.setAttribute("data-desktop-composer-send-icon", "true");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("viewBox", "0 0 20 20");
  icon.setAttribute("focusable", "false");
  const path = targetDocument.createElement("path") as unknown as SVGPathElement;
  path.setAttribute("d", "M3 10h12m0 0-5-5m5 5-5 5");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "2");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  icon.append(path);
  return icon;
}

function mountComposerSurfaceVueIsland(
  composer: HTMLElement,
  chat: DesktopNativeChatModel | null,
  chatActions: DesktopNativeChatActionOptions,
): void {
  if (!canMountVueIsland(composer)) {
    return;
  }
  mountOrUpdateComposerSurfaceIsland(composer, {
    activeSessionKey: chat?.activeSessionKey || null,
    composerState: nativeComposerState(chat),
    model: chat?.runtime?.model || null,
    modelOptions: chat?.runtime?.modelOptions || [],
    responding: chat?.responding === true,
    tokenUsage: chat?.runtime?.tokenUsage || "-",
    usePersistentRag: chat?.usePersistentRag !== false,
    onAttach: () => chatActions.onAttachSessionFile?.(),
    onModelSelect: (model) => chatActions.onSelectModel?.(model),
    onPersistentRagChange: (enabled) => chatActions.onPersistentRagChange?.(enabled),
    onSend: (event) => chatActions.onComposerSubmit?.(event),
  });
}

function mountComposerSendButtonVueIsland(
  button: HTMLElement,
  input: HTMLTextAreaElement,
  chat: DesktopNativeChatModel | null,
  chatActions: DesktopNativeChatActionOptions,
): void {
  const submit = () => submitNativeComposerMessage(button as HTMLButtonElement, input, chat, chatActions);
  const installFallback = () => {
    button.addEventListener("click", submit);
  };
  if (!canMountVueIsland(button)) {
    installFallback();
    return;
  }
  mountComposerSendButtonIsland(button, {
    disabled: (button as HTMLButtonElement).disabled,
    onSend: submit,
  });
}

function submitNativeComposerMessage(
  send: HTMLButtonElement,
  input: HTMLTextAreaElement,
  chat: DesktopNativeChatModel | null,
  chatActions: DesktopNativeChatActionOptions,
): void {
  if (send.disabled || !input.value.trim()) {
    return;
  }
  chatActions.onComposerSubmit?.({
    content: input.value,
    usePersistentRag: chat?.usePersistentRag !== false,
  });
}

function mountComposerAttachButtonVueIsland(
  button: HTMLElement,
  chatActions: DesktopNativeChatActionOptions,
): void {
  const installFallback = () => {
    button.addEventListener("click", () => {
      chatActions.onAttachSessionFile?.();
    });
  };
  if (!canMountVueIsland(button)) {
    installFallback();
    return;
  }
  mountComposerAttachButtonIsland(button, {
    onAttach: () => chatActions.onAttachSessionFile?.(),
  });
}

function mountComposerRuntimeVueIsland(
  runtime: HTMLElement,
  chat: DesktopNativeChatModel | null,
  chatActions: DesktopNativeChatActionOptions,
): void {
  if (!canMountVueIsland(runtime)) {
    return;
  }
  mountComposerRuntimeIsland(runtime, {
    model: chat?.runtime?.model || null,
    modelOptions: chat?.runtime?.modelOptions || [],
    persistentRag: chat?.usePersistentRag !== false,
    tokenUsage: chat?.runtime?.tokenUsage || "-",
    onModelSelect: (model) => chatActions.onSelectModel?.(model),
    onPersistentRagChange: (enabled) => chatActions.onPersistentRagChange?.(enabled),
  });
}

function updateNativeComposerSendState(
  input: HTMLTextAreaElement,
  send: HTMLButtonElement,
  chat: DesktopNativeChatModel | null,
): void {
  const canSend = nativeComposerState(chat) === "idle" && Boolean(input.value.trim());
  send.disabled = !canSend;
  if (canSend) {
    send.removeAttribute("disabled");
  } else {
    send.setAttribute("disabled", "");
  }
}

function activeChatTitle(chat: DesktopNativeChatModel | null): string {
  if (!chat) {
    return "Design native workbench";
  }
  return chat.sessions.find((session) => session.key === chat.activeSessionKey)?.title || "New chat";
}

function nativeComposerState(chat: DesktopNativeChatModel | null): NonNullable<DesktopNativeChatModel["composerState"]> {
  return chat?.composerState ?? (chat?.responding ? "sending" : "idle");
}

function formatSessionRelativeTime(value: string): string {
  const timestamp = parseSessionTimestampMs(value);
  if (timestamp === null) {
    return "";
  }
  const elapsedMs = Math.max(0, Date.now() - timestamp);
  const minuteMs = 60_000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  const weekMs = 7 * dayMs;
  const monthMs = 30 * dayMs;
  if (elapsedMs < hourMs) {
    return `${Math.max(1, Math.floor(elapsedMs / minuteMs))}分`;
  }
  if (elapsedMs < dayMs) {
    return `${Math.max(1, Math.floor(elapsedMs / hourMs))}小时`;
  }
  if (elapsedMs < weekMs) {
    return `${Math.max(1, Math.floor(elapsedMs / dayMs))}天`;
  }
  if (elapsedMs < monthMs) {
    return `${Math.max(1, Math.floor(elapsedMs / weekMs))}周`;
  }
  return `${Math.max(1, Math.floor(elapsedMs / monthMs))}月`;
}

function parseSessionTimestampMs(value: string): number | null {
  if (!value) {
    return null;
  }
  const unixMs = value.match(/^unix-ms:(\d+)$/);
  if (unixMs) {
    const timestamp = Number(unixMs[1]);
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function createComposerModelControl(
  targetDocument: Document,
  chat: DesktopNativeChatModel | null = null,
  chatActions: DesktopNativeChatActionOptions = {},
): HTMLElement {
  const button = targetDocument.createElement("button");
  const currentModel = chat?.runtime?.model || "Tinybot Pro";
  const modelOptions = normalizeComposerModelOptions(currentModel, chat?.runtime?.modelOptions);
  button.type = "button";
  button.className = "desktop-native-composer-model";
  button.setAttribute("data-desktop-composer-action", "model-select");
  button.setAttribute("aria-label", "Select model");
  button.textContent = currentModel;
  mountComposerModelControlVueIsland(button, chat?.runtime?.model || null, modelOptions, chatActions);
  return button;
}

function mountComposerModelControlVueIsland(
  button: HTMLElement,
  model: string | null,
  modelOptions: string[],
  chatActions: DesktopNativeChatActionOptions,
): void {
  if (!canMountVueIsland(button)) {
    installFallbackComposerModelMenu(button, model || "Tinybot Pro", modelOptions, chatActions);
    return;
  }
  mountComposerModelControlIsland(button, {
    model,
    modelOptions,
    onModelSelect: (selectedModel) => chatActions.onSelectModel?.(selectedModel),
  });
}

function installFallbackComposerModelMenu(
  button: HTMLElement,
  currentModel: string,
  modelOptions: string[],
  chatActions: DesktopNativeChatActionOptions,
): void {
  const targetDocument = button.ownerDocument;
  const label = targetDocument.createElement("span");
  label.className = "desktop-native-composer-model-label";
  label.textContent = currentModel;
  button.textContent = "";
  button.replaceChildren(label);
  button.addEventListener("click", () => {
    const existingMenu = button.querySelector('[role="listbox"]');
    if (existingMenu) {
      existingMenu.remove();
      return;
    }
    button.append(createFallbackComposerModelMenu(targetDocument, currentModel, modelOptions, chatActions));
  });
}

function createFallbackComposerModelMenu(
  targetDocument: Document,
  currentModel: string,
  modelOptions: string[],
  chatActions: DesktopNativeChatActionOptions,
): HTMLElement {
  const menu = targetDocument.createElement("span");
  menu.className = "desktop-native-composer-model-menu";
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-label", "Model");
  menu.addEventListener("click", (event) => {
    (event as { stopPropagation?: () => void }).stopPropagation?.();
  });

  const title = targetDocument.createElement("span");
  title.className = "desktop-native-composer-model-menu-title";
  title.textContent = "Model";
  menu.append(title);

  for (const optionModel of normalizeComposerModelOptions(currentModel, modelOptions)) {
    const option = targetDocument.createElement("span");
    option.className = "desktop-native-composer-model-option";
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", String(optionModel === currentModel));
    option.setAttribute("data-desktop-composer-model-option", optionModel);

    const optionLabel = targetDocument.createElement("span");
    optionLabel.className = "desktop-native-composer-model-option-label";
    optionLabel.textContent = optionModel;
    option.append(optionLabel);
    if (optionModel === currentModel) {
      option.append(createComposerModelCheckIcon(targetDocument));
    }
    option.addEventListener("click", (event) => {
      (event as { stopPropagation?: () => void }).stopPropagation?.();
      menu.remove();
      chatActions.onSelectModel?.(optionModel);
    });
    menu.append(option);
  }
  return menu;
}

function normalizeComposerModelOptions(currentModel: string, modelOptions: string[] | undefined): string[] {
  const options = (modelOptions ?? [])
    .map((option) => option.trim())
    .filter(Boolean);
  if (currentModel && !options.includes(currentModel)) {
    options.unshift(currentModel);
  }
  return Array.from(new Set(options));
}

function createComposerModelCheckIcon(targetDocument: Document): SVGElement {
  const icon = targetDocument.createElement("svg") as unknown as SVGElement;
  icon.setAttribute("class", "desktop-native-composer-model-check");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("viewBox", "0 0 20 20");
  icon.setAttribute("focusable", "false");
  const path = targetDocument.createElement("path") as unknown as SVGPathElement;
  path.setAttribute("d", "M16.5 5.5 8.25 13.75 4 9.5");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "2");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  icon.append(path);
  return icon;
}

function createPersistentRagToggle(
  targetDocument: Document,
  chat: DesktopNativeChatModel | null,
  chatActions: DesktopNativeChatActionOptions,
): HTMLElement {
  const enabled = chat?.usePersistentRag !== false;
  const button = targetDocument.createElement("button");
  button.type = "button";
  button.className = "desktop-native-composer-model desktop-native-composer-rag-toggle";
  button.setAttribute("data-desktop-composer-action", "rag-toggle");
  button.setAttribute("aria-label", "Toggle persistent RAG");
  button.setAttribute("aria-pressed", String(enabled));
  button.textContent = "RAG";
  mountPersistentRagToggleVueIsland(button, enabled, chatActions);
  return button;
}

function mountPersistentRagToggleVueIsland(
  button: HTMLElement,
  enabled: boolean,
  chatActions: DesktopNativeChatActionOptions,
): void {
  const installFallback = () => {
    button.addEventListener("click", () => {
      chatActions.onPersistentRagChange?.(!enabled);
    });
  };
  if (!canMountVueIsland(button)) {
    installFallback();
    return;
  }
  mountPersistentRagToggleIsland(button, {
    enabled,
    onToggle: (nextEnabled) => chatActions.onPersistentRagChange?.(nextEnabled),
  });
}

function createTokenUsageOrb(targetDocument: Document, tokenUsage: string): HTMLElement {
  const percent = parseTokenUsagePercent(tokenUsage);
  const orb = targetDocument.createElement("span");
  orb.className = "desktop-native-token-orb";
  orb.setAttribute("role", "meter");
  orb.setAttribute("aria-label", `Token usage ${percent}%`);
  orb.setAttribute("aria-valuemin", "0");
  orb.setAttribute("aria-valuemax", "100");
  orb.setAttribute("aria-valuenow", String(percent));
  orb.setAttribute("data-token-usage", String(percent));
  orb.style.setProperty("--token-usage-fill", `${percent}%`);
  orb.textContent = `${percent}%`;
  mountTokenUsageOrbVueIsland(orb, tokenUsage);
  return orb;
}

function mountTokenUsageOrbVueIsland(orb: HTMLElement, tokenUsage: string): void {
  if (!canMountVueIsland(orb)) {
    return;
  }
  mountTokenUsageOrbIsland(orb, { tokenUsage });
}

function parseTokenUsagePercent(tokenUsage: string): number {
  const match = tokenUsage.match(/\d+(?:\.\d+)?/);
  if (!match) {
    return 0;
  }
  const value = Number(match[0]);
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}

function createWorkLensInlineHost(
  targetDocument: Document,
  workLens: DesktopWorkLensProjection | null,
  workLensActions: DesktopWorkLensActionOptions,
): HTMLElement {
  const host = targetDocument.createElement("section");
  host.id = WORK_LENS_INLINE_ID;
  host.className = "desktop-work-lens-inline";
  host.setAttribute("aria-label", "Inline Work Lens");
  if (workLens) {
    host.append(createWorkLensPane(targetDocument, workLens, workLensActions, "inline"));
  }
  return host;
}

function moduleWorkItems(items: DesktopTaskCenterItem[], source: DesktopTaskSource): DesktopTaskCenterItem[] {
  return items.filter((item) => item.source === source && item.actions.some((action) => action.id === "inspect"));
}

function createModuleWorkSection(targetDocument: Document, title: string, items: DesktopTaskCenterItem[]): HTMLElement {
  const section = targetDocument.createElement("section");
  section.className = "desktop-module-work";
  section.setAttribute("aria-label", title);
  section.append(createText(targetDocument, "h2", title));

  for (const item of items) {
    const row = targetDocument.createElement("button");
    row.type = "button";
    row.className = "desktop-module-work-row";
    row.setAttribute("data-desktop-module-work", item.id);
    row.setAttribute("data-desktop-module-work-source", item.source);
    row.setAttribute("aria-label", `Inspect ${item.title} in Work Lens`);
    row.textContent = `${item.title}: ${[item.status, item.detail, item.progressLabel].filter(Boolean).join(" / ")}`;
    row.addEventListener("click", () => inspectModuleWorkItem(targetDocument, item));
    section.append(row);
  }

  mountModuleWorkSectionVueIsland(section, targetDocument, title, items);
  return section;
}

function mountModuleWorkSectionVueIsland(
  section: HTMLElement,
  targetDocument: Document,
  title: string,
  items: DesktopTaskCenterItem[],
): void {
  if (!canMountVueIsland(section)) {
    return;
  }
  mountModuleWorkSectionIsland(section, {
    title,
    items,
    onInspect: (item) => inspectModuleWorkItem(targetDocument, item),
  });
}

function inspectModuleWorkItem(targetDocument: Document, item: DesktopTaskCenterItem): void {
  const renderedWorkLens = renderTaskWorkLens(targetDocument, item);
  setRouteStatus(targetDocument, renderedWorkLens ? `Inspecting ${item.title} in Work Lens` : `Inspecting ${item.title}`);
}

function createAgentUiFormsSurface(
  targetDocument: Document,
  forms: AgentUiForm[],
  agentUiActions: DesktopAgentUiFormActionOptions = {},
): HTMLElement {
  const section = targetDocument.createElement("section");
  section.className = "desktop-workbench-section desktop-agent-ui-forms";
  section.setAttribute("data-desktop-module-surface", "chat");
  section.setAttribute("aria-label", "Agent UI forms");
  section.append(createText(targetDocument, "h2", "Agent UI forms"));

  if (!forms.length) {
    section.append(createText(targetDocument, "p", "No pending Agent UI forms."));
    mountAgentUiFormsSurfaceVueIsland(section, { agentUiActions, forms });
    return section;
  }

  for (const form of forms) {
    section.append(createAgentUiFormCard(targetDocument, form, agentUiActions));
  }
  mountAgentUiFormsSurfaceVueIsland(section, { agentUiActions, forms });
  return section;
}

function mountAgentUiFormsSurfaceVueIsland(
  section: HTMLElement,
  options: {
    agentUiActions: DesktopAgentUiFormActionOptions;
    forms: AgentUiForm[];
  },
): void {
  if (!canMountVueIsland(section)) {
    return;
  }
  mountAgentUiFormsSurfaceIsland(section, {
    forms: options.forms,
    onCancel: (form) => {
      options.agentUiActions.onAgentUiFormAction?.({ action: "cancel", form });
    },
    onSubmit: (form, values) => {
      options.agentUiActions.onAgentUiFormAction?.({
        action: "submit",
        form,
        values,
      });
    },
  });
}

function createAgentUiFormCard(
  targetDocument: Document,
  form: AgentUiForm,
  agentUiActions: DesktopAgentUiFormActionOptions,
): HTMLElement {
  const card = targetDocument.createElement("article");
  card.className = "desktop-agent-ui-form-card";
  card.setAttribute("data-agent-ui-form-id", form.form_id);
  card.setAttribute("data-agent-ui-form-status", form.status ?? "pending");
  setDesktopEntityHook(card, "approvals", form.form_id);

  const title = createText(targetDocument, "h2", form.title || form.form_id);
  const status = createText(targetDocument, "p", form.status ?? "pending");
  status.className = "desktop-agent-ui-form-status";
  card.append(title, status);
  if (form.description) {
    card.append(createText(targetDocument, "p", form.description));
  }

  const formElement = targetDocument.createElement("form");
  formElement.className = "desktop-agent-ui-form";
  formElement.setAttribute("data-agent-ui-form-id", form.form_id);
  for (const field of form.fields) {
    formElement.append(createAgentUiFormField(targetDocument, form, field));
  }

  if (form.errors?.form) {
    const error = createText(targetDocument, "p", form.errors.form);
    error.className = "desktop-agent-ui-form-error";
    formElement.append(error);
  }

  if (isAgentUiFormSubmittable(form)) {
    const actions = targetDocument.createElement("div");
    actions.className = "desktop-agent-ui-form-actions";
    const submit = targetDocument.createElement("button");
    submit.type = "button";
    submit.setAttribute("data-agent-ui-form-action", "submit");
    submit.textContent = form.submit_label || "Submit";
    submit.addEventListener("click", () => {
      agentUiActions.onAgentUiFormAction?.({
        action: "submit",
        form,
        values: collectAgentUiFormValues(form, formElement),
      });
    });
    const cancel = targetDocument.createElement("button");
    cancel.type = "button";
    cancel.setAttribute("data-agent-ui-form-action", "cancel");
    cancel.textContent = form.cancel_label || "Cancel";
    cancel.addEventListener("click", () => {
      agentUiActions.onAgentUiFormAction?.({ action: "cancel", form });
    });
    actions.append(submit, cancel);
    mountAgentUiFormActionsVueIsland(actions, {
      cancelLabel: form.cancel_label || "Cancel",
      onCancel: () => {
        agentUiActions.onAgentUiFormAction?.({ action: "cancel", form });
      },
      onSubmit: () => {
        agentUiActions.onAgentUiFormAction?.({
          action: "submit",
          form,
          values: collectAgentUiFormValues(form, formElement),
        });
      },
      submitLabel: form.submit_label || "Submit",
    });
    formElement.append(actions);
  }

  card.append(formElement);
  mountAgentUiFormCardVueIsland(card, {
    form,
    onCancel: (nextForm) => {
      agentUiActions.onAgentUiFormAction?.({ action: "cancel", form: nextForm });
    },
    onSubmit: (nextForm, values) => {
      agentUiActions.onAgentUiFormAction?.({
        action: "submit",
        form: nextForm,
        values,
      });
    },
  });
  return card;
}

function mountAgentUiFormCardVueIsland(
  card: HTMLElement,
  options: {
    form: AgentUiForm;
    onCancel: (form: AgentUiForm) => void;
    onSubmit: (form: AgentUiForm, values: Record<string, unknown>) => void;
  },
): void {
  if (!canMountVueIsland(card)) {
    return;
  }
  mountAgentUiFormCardIsland(card, options);
}

function mountAgentUiFormActionsVueIsland(
  actions: HTMLElement,
  options: {
    cancelLabel: string;
    onCancel: () => void;
    onSubmit: () => void;
    submitLabel: string;
  },
): void {
  if (!canMountVueIsland(actions)) {
    return;
  }
  mountAgentUiFormActionsIsland(actions, options);
}

function createAgentUiFormField(targetDocument: Document, form: AgentUiForm, field: AgentUiFormField): HTMLElement {
  const wrapper = targetDocument.createElement("label");
  wrapper.className = "desktop-agent-ui-form-field";
  wrapper.append(createText(targetDocument, "span", field.label || field.name));
  const control = createAgentUiFieldControl(targetDocument, form, field);
  wrapper.append(control);
  if (field.help) {
    wrapper.append(createText(targetDocument, "span", field.help));
  }
  const error = form.errors?.[field.name];
  if (error) {
    const errorNode = createText(targetDocument, "span", error);
    errorNode.className = "desktop-agent-ui-form-error";
    wrapper.append(errorNode);
  }
  mountAgentUiFormFieldVueIsland(wrapper, {
    disabled: !isAgentUiFormSubmittable(form),
    error,
    field,
    value: agentUiFieldValue(form, field),
  });
  return wrapper;
}

function mountAgentUiFormFieldVueIsland(
  wrapper: HTMLElement,
  options: {
    disabled: boolean;
    error?: string;
    field: AgentUiFormField;
    value: unknown;
  },
): void {
  if (!canMountVueIsland(wrapper)) {
    return;
  }
  mountAgentUiFormFieldIsland(wrapper, options);
}

function agentUiFieldValue(form: AgentUiForm, field: AgentUiFormField): unknown {
  return form.values?.[field.name] ?? form.initial_values?.[field.name] ?? field.default ?? "";
}

function createAgentUiFieldControl(targetDocument: Document, form: AgentUiForm, field: AgentUiFormField): HTMLElement {
  const value = agentUiFieldValue(form, field);
  const disabled = !isAgentUiFormSubmittable(form);
  if (field.type === "textarea") {
    const textarea = targetDocument.createElement("textarea");
    textarea.setAttribute("data-agent-ui-form-field", field.name);
    textarea.setAttribute("name", field.name);
    textarea.value = String(value ?? "");
    if (disabled) {
      textarea.setAttribute("disabled", "");
    }
    return textarea;
  }
  if (field.type === "select" || field.type === "radio") {
    const select = targetDocument.createElement("select");
    select.setAttribute("data-agent-ui-form-field", field.name);
    select.setAttribute("name", field.name);
    for (const option of field.options ?? []) {
      const optionNode = targetDocument.createElement("option");
      optionNode.setAttribute("value", String(option.value));
      optionNode.textContent = option.label;
      if (String(option.value) === String(value)) {
        optionNode.setAttribute("selected", "");
      }
      select.append(optionNode);
    }
    select.value = String(value ?? "");
    if (disabled) {
      select.setAttribute("disabled", "");
    }
    return select;
  }
  const input = targetDocument.createElement("input");
  input.setAttribute("data-agent-ui-form-field", field.name);
  input.setAttribute("name", field.name);
  input.setAttribute("type", field.type === "checkbox" ? "checkbox" : field.type === "number" ? "number" : "text");
  if (field.type === "checkbox") {
    input.checked = value === true;
  } else {
    input.value = String(value ?? "");
  }
  if (disabled) {
    input.setAttribute("disabled", "");
  }
  return input;
}

function collectAgentUiFormValues(form: AgentUiForm, formElement: HTMLElement): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of form.fields) {
    const control = formElement.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[data-agent-ui-form-field="${field.name}"]`);
    if (!control) {
      continue;
    }
    if (field.type === "checkbox") {
      values[field.name] = (control as HTMLInputElement).checked === true;
    } else if (field.type === "number") {
      const numeric = Number(control.value);
      values[field.name] = Number.isFinite(numeric) ? numeric : control.value;
    } else {
      values[field.name] = control.value;
    }
  }
  return values;
}

function createToolsSkillsPane(
  targetDocument: Document,
  pane: DesktopToolsSkillsPaneModel,
  toolsSkillsActions: DesktopToolsSkillsActionOptions = {},
): HTMLElement {
  const section = targetDocument.createElement("section");
  section.className = "desktop-workbench-section desktop-tools-skills-pane";
  section.setAttribute("data-desktop-module-surface", "tools skills");
  section.setAttribute("aria-label", "Tools and skills");
  section.append(createText(targetDocument, "h2", "Tools and skills"), createText(targetDocument, "p", pane.status));

  const tools = targetDocument.createElement("section");
  tools.className = "desktop-tools-list";
  tools.append(createText(targetDocument, "h2", "Tools"));
  for (const tool of pane.toolRows) {
    const row = createText(targetDocument, "p", `${tool.displayName}: ${tool.meta}`);
    setDesktopEntityHook(row, "tools", tool.name);
    tools.append(row);
  }
  mountToolsListVueIsland(tools, pane);
  section.append(tools);

  if (pane.selectedTool) {
    const detail = targetDocument.createElement("section");
    detail.className = "desktop-tool-detail";
    detail.append(
      createText(targetDocument, "h2", `Tool detail: ${pane.selectedTool.title}`),
      createText(targetDocument, "p", pane.selectedTool.description),
      createText(targetDocument, "p", `Config: ${pane.selectedTool.configHint || "ready"}`),
    );
    const fields = pane.selectedTool.schemaFields.length
      ? pane.selectedTool.schemaFields
      : [{ name: "parameters", type: "none", required: false, description: pane.selectedTool.emptySchemaText, defaultValue: "", enumValues: [] }];
    for (const field of fields) {
      detail.append(createText(
        targetDocument,
        "p",
        `${field.name}: ${field.type}${field.required ? " required" : ""}${field.description ? ` - ${field.description}` : ""}`,
      ));
    }
    mountToolDetailVueIsland(detail, pane.selectedTool);
    section.append(detail);
  }

  const skills = targetDocument.createElement("section");
  skills.className = "desktop-skills-list";
  skills.append(createText(targetDocument, "h2", "Skills"));
  for (const skill of pane.skillRows) {
    const row = createText(targetDocument, "p", `${skill.name}: ${skill.meta}`);
    setDesktopEntityHook(row, "skills", skill.name);
    skills.append(row);
  }
  mountSkillsListVueIsland(skills, pane);
  section.append(skills);

  if (pane.selectedSkill) {
    const detail = targetDocument.createElement("section");
    detail.className = "desktop-skill-detail";
    const summary = targetDocument.createElement("section");
    summary.className = "desktop-skill-detail-summary";
    summary.append(
      createText(targetDocument, "h2", `Skill detail: ${pane.selectedSkill.name}`),
      createText(targetDocument, "p", pane.selectedSkill.description),
      createText(targetDocument, "p", `Source: ${pane.selectedSkill.source}`),
      createText(targetDocument, "p", `Always load: ${pane.selectedSkill.always ? "Enabled" : "Disabled"}`),
      createText(targetDocument, "p", `Save state: ${pane.selectedSkill.editor.saveMessage}`),
      createText(
        targetDocument,
        "p",
        `Validation: ${pane.selectedSkill.editor.validation.message || pane.selectedSkill.editor.validation.state}`,
      ),
    );
    mountSkillDetailSummaryVueIsland(summary, pane.selectedSkill);
    detail.append(summary, createDesktopSkillEditor(targetDocument, pane, toolsSkillsActions));
    const actions: Array<[ToolsSkillsActionId, string, boolean]> = [
      ["createSkill", "Create skill", pane.selectedSkill.actions.create],
      ["saveSkill", "Save skill", pane.selectedSkill.actions.save],
      ["validateSkill", "Validate skill", pane.selectedSkill.actions.validate],
      ["deleteSkill", "Delete skill", pane.selectedSkill.actions.delete],
      ["toggleAlways", "Toggle always-load", pane.selectedSkill.actions.toggleAlways],
    ];
    const actionRow = targetDocument.createElement("div");
    actionRow.className = "desktop-tools-skills-actions";
    for (const [action, label, enabled] of actions) {
      const button = targetDocument.createElement("button");
      button.setAttribute("type", "button");
      button.setAttribute("data-desktop-tools-skills-action", action);
      if (!enabled) {
        button.setAttribute("disabled", "true");
      }
      button.textContent = label;
      button.addEventListener("click", () => {
        toolsSkillsActions.onToolsSkillsAction?.({ action, pane });
      });
      actionRow.append(button);
    }
    mountToolsSkillsActionsVueIsland(actionRow, actions, pane, toolsSkillsActions);
    detail.append(actionRow);
    section.append(detail);
  }
  mountToolsSkillsPaneVueIsland(section, pane, toolsSkillsActions);
  return section;
}

function mountToolsSkillsPaneVueIsland(
  section: HTMLElement,
  pane: DesktopToolsSkillsPaneModel,
  toolsSkillsActions: DesktopToolsSkillsActionOptions,
): void {
  if (!canMountVueIsland(section)) {
    return;
  }
  mountToolsSkillsPaneIsland(section, {
    pane,
    onToolsSkillsAction: (event) => {
      toolsSkillsActions.onToolsSkillsAction?.(event);
    },
  });
}

function mountToolsSkillsActionsVueIsland(
  actionRow: HTMLElement,
  actions: Array<[ToolsSkillsActionId, string, boolean]>,
  pane: DesktopToolsSkillsPaneModel,
  toolsSkillsActions: DesktopToolsSkillsActionOptions,
): void {
  if (!canMountVueIsland(actionRow)) {
    return;
  }
  mountToolsSkillsActionsIsland(actionRow, {
    actions: actions.map(([action, label, enabled]) => ({ action, label, enabled })),
    onAction: (action) => {
      toolsSkillsActions.onToolsSkillsAction?.({ action, pane });
    },
  });
}

function mountToolsListVueIsland(
  tools: HTMLElement,
  pane: DesktopToolsSkillsPaneModel,
): void {
  if (!canMountVueIsland(tools)) {
    return;
  }
  mountToolsListIsland(tools, { tools: pane.toolRows });
}

function mountSkillsListVueIsland(
  skills: HTMLElement,
  pane: DesktopToolsSkillsPaneModel,
): void {
  if (!canMountVueIsland(skills)) {
    return;
  }
  mountSkillsListIsland(skills, { skills: pane.skillRows });
}

function mountToolDetailVueIsland(
  detail: HTMLElement,
  tool: NonNullable<DesktopToolsSkillsPaneModel["selectedTool"]>,
): void {
  if (!canMountVueIsland(detail)) {
    return;
  }
  mountToolDetailIsland(detail, { tool });
}

function mountSkillDetailSummaryVueIsland(
  summary: HTMLElement,
  skill: NonNullable<DesktopToolsSkillsPaneModel["selectedSkill"]>,
): void {
  if (!canMountVueIsland(summary)) {
    return;
  }
  mountSkillDetailSummaryIsland(summary, { skill });
}

function createKnowledgePane(
  targetDocument: Document,
  pane: DesktopKnowledgePaneModel,
  knowledgeActions: DesktopKnowledgeActionOptions = {},
  workItems: DesktopTaskCenterItem[] = [],
): HTMLElement {
  const section = targetDocument.createElement("section");
  section.className = "desktop-workbench-section desktop-knowledge-pane";
  section.setAttribute("data-desktop-module-surface", "knowledge");
  section.setAttribute("aria-label", "Knowledge workbench");

  const createKnowledgeButton = (
    action: DesktopKnowledgeActionId,
    label: string,
    enabled: boolean,
    variant: "primary" | "secondary",
  ): HTMLButtonElement => {
    const button = targetDocument.createElement("button");
    button.className = `desktop-knowledge-action-button desktop-knowledge-action-button-${variant}`;
    button.setAttribute("type", "button");
    button.setAttribute("data-desktop-knowledge-action", action);
    if (!enabled) {
      button.setAttribute("disabled", "true");
    }
    button.textContent = label;
    button.addEventListener("click", () => {
      knowledgeActions.onKnowledgeAction?.({ action, pane });
    });
    return button;
  };

  const header = targetDocument.createElement("div");
  header.className = "desktop-knowledge-header";
  const titleBlock = targetDocument.createElement("div");
  titleBlock.className = "desktop-knowledge-title-block";
  titleBlock.append(
    createText(targetDocument, "h2", "Knowledge Base"),
    createText(targetDocument, "p", "Manage your knowledge base, monitor ingestion, and explore the knowledge graph."),
  );
  const toolbar = targetDocument.createElement("div");
  toolbar.className = "desktop-knowledge-toolbar";
  toolbar.append(
    createKnowledgeButton("refreshAll", "Refresh All", true, "secondary"),
  );
  header.append(titleBlock, toolbar);
  section.append(header);

  const grid = targetDocument.createElement("div");
  grid.className = "desktop-knowledge-management-grid";
  grid.setAttribute("data-desktop-knowledge-layout", "source-left-graph-right");
  const sourceColumn = targetDocument.createElement("div");
  sourceColumn.className = "desktop-knowledge-source-column";
  sourceColumn.setAttribute("data-desktop-knowledge-column", "source");
  const inspectorColumn = targetDocument.createElement("div");
  inspectorColumn.className = "desktop-knowledge-inspector-column";
  inspectorColumn.setAttribute("data-desktop-knowledge-column", "inspector");
  grid.append(sourceColumn, inspectorColumn);

  const overview = targetDocument.createElement("section");
  overview.className = "desktop-knowledge-region desktop-knowledge-overview";
  overview.setAttribute("data-desktop-knowledge-region", "overview");
  overview.setAttribute("aria-label", "Knowledge base overview");
  const metrics: Array<[string, string, string]> = [
    ["Documents", String(pane.documentRows.length), "Uploaded sources"],
    ["Readiness", `${pane.readiness.score}%`, `${pane.documentRows.reduce((total, row) => total + row.chunkCount, 0)} indexed chunks`],
    ["Graph Nodes", String(pane.graph.view.nodes.length), `${pane.graph.evidence.length} evidence`],
    ["Relations", String(pane.graph.view.edges.length), "Graph edges"],
  ];
  for (const [label, value, detail] of metrics) {
    const metric = targetDocument.createElement("article");
    metric.className = "desktop-knowledge-metric";
    metric.append(
      createText(targetDocument, "span", label, "desktop-knowledge-metric-label"),
      createText(targetDocument, "strong", value),
      createText(targetDocument, "span", detail, "desktop-knowledge-metric-detail"),
    );
    overview.append(metric);
  }
  sourceColumn.append(overview);

  const uploadRegion = targetDocument.createElement("section");
  uploadRegion.className = "desktop-knowledge-region desktop-knowledge-upload-region";
  uploadRegion.setAttribute("data-desktop-knowledge-region", "upload");
  uploadRegion.setAttribute("aria-label", "Upload knowledge documents");
  const uploadHeader = createKnowledgeRegionHeader(
    targetDocument,
    "Upload Documents",
    "Add files to your knowledge base. We'll parse, chunk, and index them.",
  );
  uploadHeader.append(createKnowledgeButton("uploadDocument", "Upload Documents", pane.actions.upload, "primary"));
  const dropZone = targetDocument.createElement("div");
  dropZone.className = "desktop-knowledge-drop-zone";
  dropZone.setAttribute("data-desktop-drop-target", "knowledge-document");
  dropZone.append(
    createText(targetDocument, "strong", "Drag & drop files here or click to browse"),
    createText(targetDocument, "span", "PDF, DOCX, MD, TXT, CSV, JSON"),
    createText(targetDocument, "small", "Max 200MB per file"),
  );
  uploadRegion.append(uploadHeader, dropZone, createKnowledgeUploadControl(targetDocument));
  sourceColumn.append(uploadRegion);

  if (workItems.length) {
    const queue = targetDocument.createElement("section");
    queue.className = "desktop-knowledge-region desktop-knowledge-queue-region";
    queue.setAttribute("data-desktop-knowledge-region", "queue");
    queue.setAttribute("aria-label", "Knowledge jobs");
    queue.append(createKnowledgeRegionHeader(
      targetDocument,
      `Knowledge Jobs (${workItems.length})`,
      "Track active indexing, rebuild, upload, and graph extraction jobs.",
    ));
    queue.append(createModuleWorkSection(targetDocument, "Knowledge jobs", workItems));
    sourceColumn.append(queue);
  }

  const documentsRegion = targetDocument.createElement("section");
  documentsRegion.className = "desktop-knowledge-region desktop-knowledge-documents-region";
  documentsRegion.setAttribute("data-desktop-knowledge-region", "documents");
  documentsRegion.setAttribute("aria-label", "Knowledge documents");
  documentsRegion.append(createKnowledgeRegionHeader(
    targetDocument,
    `Documents (${pane.documentRows.length})`,
    "Search, inspect, and delete knowledge sources.",
  ));

  const documents = targetDocument.createElement("section");
  documents.className = "desktop-knowledge-documents";
  const documentToolbar = targetDocument.createElement("div");
  documentToolbar.className = "desktop-knowledge-documents-toolbar";
  const search = targetDocument.createElement("input");
  search.setAttribute("type", "search");
  search.setAttribute("placeholder", "Search documents...");
  search.setAttribute("data-desktop-knowledge-document-search", "");
  documentToolbar.append(search);
  const documentList = targetDocument.createElement("div");
  documentList.className = "desktop-knowledge-documents-list";
  documentList.setAttribute("data-desktop-knowledge-documents-list", "");
  for (const document of pane.documentRows) {
    const row = targetDocument.createElement("article");
    row.className = "desktop-knowledge-document-row";
    setDesktopEntityHook(row, "knowledge", document.id || document.path);
    const summary = targetDocument.createElement("div");
    summary.className = "desktop-knowledge-document-summary";
    summary.append(
      createText(targetDocument, "strong", document.title),
      createText(targetDocument, "span", document.meta, "desktop-knowledge-document-meta"),
    );
    const attributes = targetDocument.createElement("div");
    attributes.className = "desktop-knowledge-document-attributes";
    const documentAttributes = [document.typeLabel || document.category || "DOC", document.sizeLabel, document.addedLabel]
      .filter((value): value is string => Boolean(value));
    for (const attribute of documentAttributes) {
      attributes.append(createText(targetDocument, "span", attribute, "desktop-knowledge-document-attribute"));
    }
    attributes.append(createText(targetDocument, "span", document.status || "unknown", "desktop-knowledge-document-status"));
    const deleteButton = targetDocument.createElement("button");
    deleteButton.className = "desktop-knowledge-action-button desktop-knowledge-action-button-secondary";
    deleteButton.setAttribute("type", "button");
    deleteButton.setAttribute("data-desktop-knowledge-action", "deleteDocument");
    deleteButton.setAttribute("data-desktop-knowledge-document-action", "deleteDocument");
    if (!pane.actions.deleteDocument) {
      deleteButton.setAttribute("disabled", "true");
    }
    deleteButton.textContent = "Delete";
    deleteButton.addEventListener("click", () => {
      knowledgeActions.onKnowledgeAction?.({ action: "deleteDocument", pane, documentId: document.id || document.path });
    });
    row.append(summary, attributes, deleteButton);
    documentList.append(row);
  }
  search.addEventListener("input", () => {
    const query = search.value.trim().toLowerCase();
    for (const row of Array.from(documentList.querySelectorAll<HTMLElement>(".desktop-knowledge-document-row"))) {
      row.hidden = Boolean(query) && !row.textContent?.toLowerCase().includes(query);
    }
  });
  documents.append(documentToolbar, documentList);
  mountKnowledgeDocumentsVueIsland(documents, pane);
  documentsRegion.append(documents);

  if (pane.selectedDocument) {
    const detail = targetDocument.createElement("section");
    detail.className = "desktop-knowledge-document-detail";
    detail.append(
      createText(targetDocument, "h2", `Document detail: ${pane.selectedDocument.title}`),
      createText(targetDocument, "p", pane.selectedDocument.detail),
      createText(targetDocument, "p", `Tags: ${pane.selectedDocument.tags.join(", ") || "none"}`),
    );
    mountKnowledgeDocumentDetailVueIsland(detail, pane.selectedDocument);
    const documentActions = targetDocument.createElement("div");
    documentActions.className = "desktop-knowledge-action-row";
    documentActions.append(createKnowledgeButton("deleteDocument", "Delete Document", pane.actions.deleteDocument, "secondary"));
    documentsRegion.append(detail, documentActions);
  }
  sourceColumn.append(documentsRegion);

  const queryRegion = targetDocument.createElement("section");
  queryRegion.className = "desktop-knowledge-region desktop-knowledge-query-region";
  queryRegion.setAttribute("data-desktop-knowledge-region", "query");
  queryRegion.setAttribute("aria-label", "Knowledge query");
  queryRegion.append(createKnowledgeRegionHeader(
    targetDocument,
    "Knowledge Query",
    "Search the knowledge base and inspect retrieval context.",
  ));
  const querySurface = targetDocument.createElement("section");
  querySurface.className = "desktop-knowledge-query";
  const queryControls = targetDocument.createElement("div");
  queryControls.className = "desktop-knowledge-query-controls";
  const queryInput = targetDocument.createElement("input");
  queryInput.setAttribute("aria-label", "Knowledge query");
  queryInput.setAttribute("data-desktop-knowledge-query-input", "");
  queryInput.setAttribute("placeholder", "Ask your knowledge base...");
  queryInput.setAttribute("type", "search");
  queryInput.value = pane.query.draft.query;
  const modeSelect = targetDocument.createElement("select");
  modeSelect.setAttribute("aria-label", "Knowledge query mode");
  modeSelect.setAttribute("data-desktop-knowledge-query-mode", "");
  for (const [value, label] of [["hybrid", "Hybrid"], ["local", "Local"], ["global", "Global"]]) {
    const option = targetDocument.createElement("option");
    option.value = value;
    option.textContent = label;
    modeSelect.append(option);
  }
  modeSelect.value = pane.query.draft.mode;
  const topKInput = targetDocument.createElement("input");
  topKInput.setAttribute("aria-label", "Knowledge query top K");
  topKInput.setAttribute("data-desktop-knowledge-query-top-k", "");
  topKInput.setAttribute("min", "1");
  topKInput.setAttribute("step", "1");
  topKInput.setAttribute("type", "number");
  topKInput.value = String(pane.query.draft.topK);
  const runQueryButton = targetDocument.createElement("button");
  runQueryButton.setAttribute("data-desktop-knowledge-action", "runQuery");
  runQueryButton.setAttribute("type", "button");
  runQueryButton.textContent = "Run Query";
  runQueryButton.addEventListener("click", () => {
    knowledgeActions.onKnowledgeAction?.({
      action: "runQuery",
      pane,
      queryDraft: {
        query: queryInput.value.trim(),
        mode: modeSelect.value,
        topK: Number(topKInput.value),
      },
    });
  });
  queryControls.append(queryInput, modeSelect, topKInput, runQueryButton);
  const queryPanel = targetDocument.createElement("div");
  queryPanel.className = "desktop-knowledge-query-panel";
  const querySummary = targetDocument.createElement("p");
  querySummary.className = "desktop-knowledge-query-summary";
  querySummary.append(
    createText(targetDocument, "span", `Mode: ${pane.query.draft.mode} / top ${pane.query.draft.topK}`),
    createText(targetDocument, "span", `Results: ${pane.query.results.summary.count}`),
  );
  queryPanel.append(queryControls, querySummary);
  for (const result of pane.query.results.rows.slice(0, 4)) {
    queryPanel.append(createText(targetDocument, "p", `${result.docName}: ${result.content}`));
  }
  querySurface.append(queryPanel);
  queryRegion.append(querySurface);
  sourceColumn.append(queryRegion);

  const graph = targetDocument.createElement("section");
  graph.className = "desktop-knowledge-region desktop-knowledge-graph-region";
  graph.setAttribute("data-desktop-knowledge-region", "graph");
  graph.setAttribute("aria-label", "Knowledge graph");
  const graphHeader = createKnowledgeRegionHeader(
    targetDocument,
    "Knowledge Graph",
    "Explore entities and their relationships.",
  );
  const graphActions = targetDocument.createElement("div");
  graphActions.className = "desktop-knowledge-action-row";
  graphActions.append(
    createKnowledgeButton("extractGraph", "Extract Graph", pane.actions.rebuild && Boolean(pane.selectedDocument?.id), "primary"),
    createKnowledgeButton("rebuildIndex", "Rebuild Index", pane.actions.rebuild, "secondary"),
  );
  graphHeader.append(graphActions);
  const graphSurface = targetDocument.createElement("section");
  graphSurface.className = "desktop-knowledge-graph";
  graphSurface.append(createText(targetDocument, "h2", `Graph: ${pane.graph.summary}`));
  appendKnowledgeReferenceRows(targetDocument, graphSurface, "Community", pane.graph.communities);
  appendKnowledgeReferenceRows(targetDocument, graphSurface, "Report", pane.graph.reports);
  appendKnowledgeReferenceRows(targetDocument, graphSurface, "Claim", pane.graph.claims);
  appendKnowledgeReferenceRows(targetDocument, graphSurface, "Relation", pane.graph.relations);
  appendKnowledgeReferenceRows(targetDocument, graphSurface, "Conflict", pane.graph.conflicts);
  for (const evidence of pane.graph.evidence.slice(0, 4)) {
    graphSurface.append(createText(targetDocument, "p", `Evidence: ${evidence.title} / ${evidence.docName}`));
  }
  mountKnowledgeGraphVueIsland(graphSurface, pane);
  graph.append(graphHeader, graphSurface);
  inspectorColumn.append(graph);

  const pipeline = targetDocument.createElement("section");
  pipeline.className = "desktop-knowledge-region desktop-knowledge-pipeline";
  pipeline.setAttribute("data-desktop-knowledge-region", "pipeline");
  pipeline.setAttribute("aria-label", "Knowledge indexing pipeline");
  pipeline.append(createKnowledgeRegionHeader(
    targetDocument,
    "Indexing Pipeline",
    "Track ingestion and indexing progress.",
  ));
  const readiness = targetDocument.createElement("section");
  readiness.className = "desktop-knowledge-readiness";
  for (const step of ["Upload", "Parse", "Chunk", "Embed", "Graph Build", "Complete"]) {
    readiness.append(createText(targetDocument, "span", step));
  }
  readiness.append(createText(targetDocument, "p", `${pane.readiness.score >= 100 ? 6 : Math.max(1, Math.round((pane.readiness.score / 100) * 6))} / 6 steps`));
  for (const hint of pane.configHints) {
    readiness.append(createText(targetDocument, "p", hint));
  }
  for (const row of pane.readiness.rows) {
    readiness.append(createText(targetDocument, "p", `${row.id}: ${row.tone}`));
  }
  mountKnowledgeReadinessVueIsland(readiness, pane);
  pipeline.append(readiness);
  sourceColumn.append(pipeline);
  section.append(grid);

  mountKnowledgePaneVueIsland(section, targetDocument, pane, knowledgeActions, workItems);
  return section;
}

function createKnowledgeRegionHeader(targetDocument: Document, title: string, detail: string): HTMLElement {
  const header = targetDocument.createElement("div");
  header.className = "desktop-knowledge-region-header";
  const text = targetDocument.createElement("div");
  text.append(
    createText(targetDocument, "h3", title),
    createText(targetDocument, "p", detail),
  );
  header.append(text);
  return header;
}

function createKnowledgeUploadControl(targetDocument: Document): HTMLButtonElement {
  const control = targetDocument.createElement("button");
  control.id = "desktop-knowledge-upload";
  control.className = "desktop-knowledge-upload-control";
  control.setAttribute("type", "button");
  control.setAttribute("tabindex", "-1");
  control.setAttribute("aria-hidden", "true");
  control.setAttribute("data-desktop-file-upload", "knowledge-document");
  control.textContent = "Upload knowledge document";
  return control;
}

function mountKnowledgePaneVueIsland(
  section: HTMLElement,
  targetDocument: Document,
  pane: DesktopKnowledgePaneModel,
  knowledgeActions: DesktopKnowledgeActionOptions,
  workItems: DesktopTaskCenterItem[],
): void {
  if (!canMountVueIsland(section)) {
    return;
  }
  mountKnowledgePaneIsland(section, {
    pane,
    workItems,
    onInspectWorkItem: (item) => renderTaskWorkLens(targetDocument, item),
    onKnowledgeAction: (event) => {
      knowledgeActions.onKnowledgeAction?.(event);
    },
  });
}

function mountKnowledgeReadinessVueIsland(
  readiness: HTMLElement,
  pane: DesktopKnowledgePaneModel,
): void {
  if (!canMountVueIsland(readiness)) {
    return;
  }
  mountKnowledgeReadinessIsland(readiness, {
    readiness: pane.readiness,
    configHints: pane.configHints,
  });
}

function mountKnowledgeDocumentsVueIsland(
  documents: HTMLElement,
  pane: DesktopKnowledgePaneModel,
): void {
  if (!canMountVueIsland(documents)) {
    return;
  }
  mountKnowledgeDocumentsIsland(documents, { documents: pane.documentRows });
}

function mountKnowledgeDocumentDetailVueIsland(
  detail: HTMLElement,
  document: NonNullable<DesktopKnowledgePaneModel["selectedDocument"]>,
): void {
  if (!canMountVueIsland(detail)) {
    return;
  }
  mountKnowledgeDocumentDetailIsland(detail, { document });
}

function mountKnowledgeGraphVueIsland(
  graph: HTMLElement,
  pane: DesktopKnowledgePaneModel,
): void {
  if (!canMountVueIsland(graph)) {
    return;
  }
  mountKnowledgeGraphIsland(graph, { graph: pane.graph });
}

function createCoworkCockpitPane(
  targetDocument: Document,
  pane: DesktopCoworkPaneModel,
  coworkActions: DesktopCoworkActionOptions = {},
): HTMLElement {
  if (!DESKTOP_COWORK_STANDALONE_AVAILABLE) {
    const section = createCoworkUnavailablePane(targetDocument);
    mountCoworkPaneVueIsland(section, targetDocument, pane, coworkActions);
    return section;
  }

  const section = targetDocument.createElement("section");
  section.className = "desktop-workbench-section desktop-cowork-cockpit";
  section.setAttribute("data-desktop-module-surface", "cowork");
  section.setAttribute("aria-label", "Cowork cockpit");
  section.append(createText(targetDocument, "h2", "Cowork"));

  const sessions = targetDocument.createElement("section");
  sessions.className = "desktop-cowork-sessions";
  sessions.append(createText(targetDocument, "h2", "Sessions"));
  if (!pane.sessionRows.length) {
    sessions.append(createText(targetDocument, "p", "No Cowork sessions loaded."));
  }
  for (const session of pane.sessionRows) {
    const row = targetDocument.createElement("button");
    row.type = "button";
    row.className = "desktop-cowork-session-row";
    row.setAttribute("data-desktop-cowork-session", session.id);
    setDesktopEntityHook(row, "cowork", session.id);
    row.textContent = `${session.title}: ${session.meta}`;
    row.addEventListener("click", () => {
      const [item] = buildDesktopTaskCenterItems({ coworkRuns: [buildDesktopCoworkTaskOperation(session.raw)] });
      if (!item) {
        return;
      }
      const renderedWorkLens = renderTaskWorkLens(targetDocument, item);
      setRouteStatus(targetDocument, renderedWorkLens ? `Inspecting ${item.title} in Work Lens` : `Inspecting ${item.title}`);
    });
    sessions.append(row);
  }
  mountCoworkSessionsVueIsland(sessions, targetDocument, pane.sessionRows);
  section.append(sessions);
  section.append(createCoworkActionControls(targetDocument, pane, coworkActions));

  if (!pane.cockpitView) {
    section.append(createText(targetDocument, "p", "Select a Cowork session to open the cockpit."));
    mountCoworkPaneVueIsland(section, targetDocument, pane, coworkActions);
    return section;
  }

  const view = pane.cockpitView;
  const header = targetDocument.createElement("section");
  header.className = "desktop-cowork-header";
  header.append(
    createText(targetDocument, "h2", view.header.title),
    createText(targetDocument, "p", view.header.goal || "No goal provided."),
    createText(targetDocument, "p", `${view.header.status} / ${view.header.workflow}${view.header.updatedAt ? ` / ${view.header.updatedAt}` : ""}`),
  );
  mountCoworkHeaderVueIsland(header, view.header);
  section.append(header);

  const inspector = createCoworkInspectorPane(targetDocument, view, pane, coworkActions);
  section.append(createCoworkGraphPane(targetDocument, view, inspector, pane, coworkActions));
  section.append(createCoworkObservabilityPane(targetDocument, view));
  section.append(inspector);
  section.append(createCoworkTaskFeed(targetDocument, view));

  mountCoworkPaneVueIsland(section, targetDocument, pane, coworkActions);
  return section;
}

function createCoworkUnavailablePane(targetDocument: Document): HTMLElement {
  const section = targetDocument.createElement("section");
  section.className = "desktop-workbench-section desktop-cowork-cockpit";
  section.setAttribute("data-desktop-module-surface", "cowork");
  section.setAttribute("aria-label", "Cowork unavailable");
  const placeholder = targetDocument.createElement("section");
  placeholder.className = "desktop-cowork-unavailable";
  placeholder.append(
    createText(targetDocument, "p", "Cowork", "desktop-cowork-unavailable-kicker"),
    createText(targetDocument, "h2", "Cowork is under construction"),
    createText(targetDocument, "p", "This page is temporarily unavailable."),
    createText(targetDocument, "p", "暂不开放"),
  );
  section.append(placeholder);
  return section;
}

function mountCoworkPaneVueIsland(
  section: HTMLElement,
  targetDocument: Document,
  pane: DesktopCoworkPaneModel,
  coworkActions: DesktopCoworkActionOptions,
): void {
  if (!canMountVueIsland(section)) {
    return;
  }
  mountCoworkPaneIsland(section, {
    pane,
    onCoworkAction: (event) => {
      coworkActions.onCoworkAction?.(event);
    },
    onGraphSelect: (selection) => {
      setRouteStatus(targetDocument, `Inspecting Cowork ${selection.label}`);
    },
    onObservabilityPanelSelected: (panel) => {
      setRouteStatus(targetDocument, `Viewing Cowork ${panel.label}`);
    },
    onSessionSelect: (session) => {
      const [item] = buildDesktopTaskCenterItems({ coworkRuns: [buildDesktopCoworkTaskOperation(session.raw)] });
      if (!item) {
        return;
      }
      const renderedWorkLens = renderTaskWorkLens(targetDocument, item);
      setRouteStatus(targetDocument, renderedWorkLens ? `Inspecting ${item.title} in Work Lens` : `Inspecting ${item.title}`);
    },
  });
}

function mountCoworkHeaderVueIsland(
  header: HTMLElement,
  viewHeader: DesktopCoworkCockpitView["header"],
): void {
  if (!canMountVueIsland(header)) {
    return;
  }
  mountCoworkHeaderIsland(header, { header: viewHeader });
}

function mountCoworkSessionsVueIsland(
  sessions: HTMLElement,
  targetDocument: Document,
  sessionRows: DesktopCoworkSessionRow[],
): void {
  if (!canMountVueIsland(sessions)) {
    return;
  }
  mountCoworkSessionsIsland(sessions, {
    sessions: sessionRows,
    onSelect: (session) => {
      const [item] = buildDesktopTaskCenterItems({ coworkRuns: [buildDesktopCoworkTaskOperation(session.raw)] });
      if (!item) {
        return;
      }
      const renderedWorkLens = renderTaskWorkLens(targetDocument, item);
      setRouteStatus(targetDocument, renderedWorkLens ? `Inspecting ${item.title} in Work Lens` : `Inspecting ${item.title}`);
    },
  });
}

function createCoworkActionControls(
  targetDocument: Document,
  pane: DesktopCoworkPaneModel,
  coworkActions: DesktopCoworkActionOptions,
): HTMLElement {
  const actions = targetDocument.createElement("section");
  actions.className = "desktop-cowork-actions";
  actions.setAttribute("aria-label", "Cowork actions");

  const goal = targetDocument.createElement("textarea");
  goal.className = "desktop-cowork-action-input";
  goal.setAttribute("aria-label", "Cowork goal");
  goal.setAttribute("data-desktop-cowork-input", "goal");
  (goal as HTMLTextAreaElement).value = "";

  const message = targetDocument.createElement("textarea");
  message.className = "desktop-cowork-action-input";
  message.setAttribute("aria-label", "Cowork message");
  message.setAttribute("data-desktop-cowork-input", "message");
  (message as HTMLTextAreaElement).value = "";

  const blueprint = targetDocument.createElement("textarea");
  blueprint.className = "desktop-cowork-action-input desktop-cowork-blueprint-input";
  blueprint.setAttribute("aria-label", "Cowork blueprint JSON");
  blueprint.setAttribute("data-desktop-cowork-input", "blueprint");
  (blueprint as HTMLTextAreaElement).value = "";

  const taskTitle = targetDocument.createElement("input");
  taskTitle.className = "desktop-cowork-action-input";
  taskTitle.setAttribute("aria-label", "Cowork task title");
  taskTitle.setAttribute("data-desktop-cowork-input", "taskTitle");
  (taskTitle as HTMLInputElement).value = "";

  const assignedAgentId = targetDocument.createElement("input");
  assignedAgentId.className = "desktop-cowork-action-input";
  assignedAgentId.setAttribute("aria-label", "Cowork assigned agent id");
  assignedAgentId.setAttribute("data-desktop-cowork-input", "assignedAgentId");
  (assignedAgentId as HTMLInputElement).value = pane.cockpitView?.agents[0]?.id ?? "";

  const budgetMaxRounds = targetDocument.createElement("input");
  budgetMaxRounds.className = "desktop-cowork-action-input";
  budgetMaxRounds.setAttribute("aria-label", "Cowork max rounds");
  budgetMaxRounds.setAttribute("data-desktop-cowork-input", "budgetMaxRounds");
  budgetMaxRounds.setAttribute("type", "number");
  budgetMaxRounds.setAttribute("min", "1");
  (budgetMaxRounds as HTMLInputElement).value = coworkBudgetMaxRoundsValue(pane);

  const sessionId = pane.cockpitView?.header.id ?? "";
  const rows: Array<[string, string, DesktopCoworkActionId, boolean]> = [
    ["create", "Create session", "createSession", true],
    ["run", "Run", "runSession", Boolean(sessionId)],
    ["pause", "Pause", "pauseSession", Boolean(sessionId)],
    ["resume", "Resume", "resumeSession", Boolean(sessionId)],
    ["emergencyStop", "Emergency stop", "emergencyStopSession", Boolean(sessionId)],
    ["delete", "Delete", "deleteSession", Boolean(sessionId)],
    ["message", "Message", "sendMessage", Boolean(sessionId)],
    ["summary", "Summary", "loadSummary", Boolean(sessionId)],
    ["blueprint", "Blueprint", "loadBlueprint", Boolean(sessionId)],
    ["trace", "Trace", "loadTrace", Boolean(sessionId)],
    ["dag", "DAG", "loadDag", Boolean(sessionId)],
    ["artifacts", "Artifacts", "loadArtifacts", Boolean(sessionId)],
    ["organization", "Organization", "loadOrganization", Boolean(sessionId)],
    ["queues", "Queues", "loadQueues", Boolean(sessionId)],
    ["branches", "Branches", "loadBranches", Boolean(sessionId)],
    ["updateBudget", "Update budget", "updateBudget", Boolean(sessionId)],
  ];
  actions.append(goal, message, blueprint, taskTitle, assignedAgentId, budgetMaxRounds);
  if (pane.actionStatus) {
    const status = createText(targetDocument, "p", pane.actionStatus);
    status.className = "desktop-cowork-action-status";
    actions.append(status);
  }
  if (pane.summaryText) {
    const summary = createText(targetDocument, "p", `Summary: ${pane.summaryText}`);
    summary.className = "desktop-cowork-action-summary";
    actions.append(summary);
  }
  if (pane.blueprintDiagnostics) {
    const diagnostics = createText(targetDocument, "p", `Blueprint: ${pane.blueprintDiagnostics}`);
    diagnostics.className = "desktop-cowork-blueprint-diagnostics";
    actions.append(diagnostics);
  }
  for (const [action, label, preview] of [
    ["blueprintValidate", "Validate blueprint", false],
    ["blueprintPreview", "Preview blueprint", true],
  ] as const) {
    const button = targetDocument.createElement("button");
    button.type = "button";
    button.className = "desktop-cowork-action";
    button.setAttribute("data-desktop-cowork-action", action);
    button.textContent = label;
    button.addEventListener("click", () => {
      coworkActions.onCoworkAction?.({
        action: "validateBlueprint",
        pane,
        blueprintText: (blueprint as HTMLTextAreaElement).value.trim(),
        preview,
      });
    });
    actions.append(button);
  }
  for (const [action, label, eventAction, enabled] of rows) {
    const button = targetDocument.createElement("button");
    button.type = "button";
    button.className = "desktop-cowork-action";
    button.setAttribute("data-desktop-cowork-action", action);
    if (!enabled) {
      button.setAttribute("disabled", "true");
    }
    button.textContent = label;
    button.addEventListener("click", () => {
      if (!enabled) {
        return;
      }
      coworkActions.onCoworkAction?.({
        action: eventAction,
        pane,
        sessionId: eventAction === "createSession" ? undefined : sessionId || undefined,
        goal: eventAction === "createSession" ? (goal as HTMLTextAreaElement).value.trim() : undefined,
        message: eventAction === "sendMessage" ? (message as HTMLTextAreaElement).value.trim() : undefined,
        maxRounds: eventAction === "updateBudget" ? parseCoworkPositiveInteger((budgetMaxRounds as HTMLInputElement).value) : undefined,
      });
    });
    actions.append(button);
  }
  const addTask = targetDocument.createElement("button");
  addTask.type = "button";
  addTask.className = "desktop-cowork-action";
  addTask.setAttribute("data-desktop-cowork-action", "addTask");
  if (!sessionId) {
    addTask.setAttribute("disabled", "true");
  }
  addTask.textContent = "Add task";
  addTask.addEventListener("click", () => {
    if (!sessionId) {
      return;
    }
    coworkActions.onCoworkAction?.({
      action: "addTask",
      pane,
      sessionId,
      taskTitle: (taskTitle as HTMLInputElement).value.trim(),
      assignedAgentId: (assignedAgentId as HTMLInputElement).value.trim(),
    });
  });
  actions.append(addTask);
  mountCoworkActionsVueIsland(actions, pane, coworkActions);
  return actions;
}

function mountCoworkActionsVueIsland(
  actions: HTMLElement,
  pane: DesktopCoworkPaneModel,
  coworkActions: DesktopCoworkActionOptions,
): void {
  if (!canMountVueIsland(actions)) {
    return;
  }
  mountCoworkActionsIsland(actions, {
    sessionId: pane.cockpitView?.header.id ?? "",
    agents: pane.cockpitView?.agents ?? [],
    budgetMaxRounds: coworkBudgetMaxRoundsValue(pane),
    actionStatus: pane.actionStatus,
    summaryText: pane.summaryText,
    blueprintDiagnostics: pane.blueprintDiagnostics,
    onAction: (event) => {
      coworkActions.onCoworkAction?.({ ...event, pane });
    },
  });
}

function createCoworkGraphPane(
  targetDocument: Document,
  view: DesktopCoworkCockpitView,
  inspector: HTMLElement,
  pane: DesktopCoworkPaneModel,
  coworkActions: DesktopCoworkActionOptions,
): HTMLElement {
  const graph = targetDocument.createElement("section");
  graph.className = "desktop-cowork-graph";
  graph.append(createText(targetDocument, "h2", "Graph"), createText(targetDocument, "p", view.graph.caption));
  const visibleNodes = view.graph.nodes.slice(0, COWORK_GRAPH_NODE_LIMIT);
  for (const node of visibleNodes) {
    const row = targetDocument.createElement("button");
    row.type = "button";
    row.className = "desktop-cowork-graph-node";
    row.setAttribute("data-desktop-cowork-entity", node.id);
    row.setAttribute("data-desktop-cowork-kind", node.kind);
    row.textContent = `${node.label}: ${node.kind}${node.status ? ` / ${node.status}` : ""}`;
    row.addEventListener("click", () => {
      const type = coworkSelectionTypeForKind(node.kind);
      if (!type) {
        return;
      }
      const selectedView = buildDesktopCoworkCockpitView(view.raw, {
        selected: { type, id: node.id },
      });
      const selectedInspector = createCoworkInspectorPane(targetDocument, selectedView, pane, coworkActions);
      inspector.replaceChildren(...Array.from(selectedInspector.children));
      for (const graphNode of Array.from(graph.querySelectorAll(".desktop-cowork-graph-node"))) {
        graphNode.setAttribute(
          "aria-selected",
          graphNode.getAttribute("data-desktop-cowork-entity") === node.id ? "true" : "false",
        );
      }
      setRouteStatus(targetDocument, `Inspecting Cowork ${node.label}`);
    });
    graph.append(row);
  }
  graph.append(createCoworkLimitStatus(targetDocument, visibleNodes.length, view.graph.nodes.length, "node", "nodes"));
  const visibleEdges = view.graph.edges.slice(0, COWORK_GRAPH_EDGE_LIMIT);
  for (const edge of visibleEdges) {
    graph.append(createText(targetDocument, "p", `${edge.source} -> ${edge.target}${edge.label ? ` / ${edge.label}` : ""}`));
  }
  graph.append(createCoworkLimitStatus(targetDocument, visibleEdges.length, view.graph.edges.length, "edge", "edges"));
  mountCoworkGraphVueIsland(graph, targetDocument, view, inspector, pane, coworkActions);
  return graph;
}

function mountCoworkGraphVueIsland(
  graph: HTMLElement,
  targetDocument: Document,
  view: DesktopCoworkCockpitView,
  inspector: HTMLElement,
  pane: DesktopCoworkPaneModel,
  coworkActions: DesktopCoworkActionOptions,
): void {
  if (!canMountVueIsland(graph)) {
    return;
  }
  mountCoworkGraphIsland(graph, {
    graph: view.graph,
    onSelect: ({ type, id, label }) => {
      const selectedView = buildDesktopCoworkCockpitView(view.raw, {
        selected: { type, id },
      });
      const selectedInspector = createCoworkInspectorPane(targetDocument, selectedView, pane, coworkActions);
      inspector.replaceChildren(...Array.from(selectedInspector.children));
      setRouteStatus(targetDocument, `Inspecting Cowork ${label}`);
    },
  });
}

function coworkSelectionTypeForKind(kind: string): DesktopCoworkSelectionType {
  const value = kind.toLowerCase();
  if (value.includes("agent")) {
    return "agent";
  }
  if (value.includes("task")) {
    return "task";
  }
  if (value.includes("mail")) {
    return "mailbox";
  }
  if (value.includes("thread")) {
    return "thread";
  }
  if (value.includes("trace")) {
    return "trace";
  }
  if (value.includes("artifact")) {
    return "artifact";
  }
  if (value.includes("work") || value.includes("unit")) {
    return "workUnit";
  }
  if (value.includes("branch")) {
    return "branch";
  }
  return "";
}

function createCoworkObservabilityPane(targetDocument: Document, view: DesktopCoworkCockpitView): HTMLElement {
  const section = targetDocument.createElement("section");
  section.className = "desktop-cowork-observability";
  section.setAttribute("aria-label", "Cowork observability");

  const tabs = targetDocument.createElement("div");
  tabs.className = "desktop-cowork-observability-tabs";
  tabs.setAttribute("role", "tablist");

  const panelHost = targetDocument.createElement("section");
  panelHost.className = "desktop-cowork-observability-panel";

  const filter = targetDocument.createElement("input");
  filter.className = "desktop-cowork-observability-filter";
  filter.setAttribute("type", "search");
  filter.setAttribute("aria-label", "Filter Cowork observability rows");
  filter.setAttribute("placeholder", "Filter current panel");
  filter.setAttribute("data-desktop-cowork-filter", "observability");

  const renderPanel = (panelId: string): void => {
    const selectedPanel = view.observabilityPanels.find((panel) => panel.id === panelId) ?? view.observabilityPanels[0];
    if (!selectedPanel) {
      panelHost.replaceChildren(createText(targetDocument, "p", "No Cowork observability data."));
      return;
    }
    for (const tab of Array.from(tabs.children)) {
      tab.setAttribute("aria-selected", tab.getAttribute("data-desktop-cowork-panel") === selectedPanel.id ? "true" : "false");
    }
    const query = (filter as HTMLInputElement).value.trim().toLowerCase();
    const matchedRows = query
      ? selectedPanel.rows.filter((row) => `${row.label} ${row.value}`.toLowerCase().includes(query))
      : selectedPanel.rows;
    const visibleRows = matchedRows.slice(0, COWORK_OBSERVABILITY_ROW_LIMIT);
    const content = targetDocument.createElement("section");
    content.append(createText(targetDocument, "h2", selectedPanel.label), createText(targetDocument, "p", selectedPanel.summary));
    content.append(createCoworkFilteredLimitStatus(targetDocument, visibleRows.length, matchedRows.length, selectedPanel.rows.length, "row", "rows", Boolean(query)));
    for (const row of visibleRows) {
      content.append(createCoworkDataRow(targetDocument, "desktop-cowork-observability-row", `${row.label}: ${row.value}`));
    }
    panelHost.replaceChildren(...Array.from(content.children));
    setRouteStatus(targetDocument, `Viewing Cowork ${selectedPanel.label}`);
  };

  for (const [index, panel] of view.observabilityPanels.entries()) {
    const tab = targetDocument.createElement("button");
    tab.type = "button";
    tab.className = "desktop-cowork-observability-tab";
    tab.setAttribute("role", "tab");
    tab.setAttribute("data-desktop-cowork-panel", panel.id);
    tab.setAttribute("aria-selected", index === 0 ? "true" : "false");
    tab.textContent = panel.label;
    tab.addEventListener("click", () => {
      renderPanel(panel.id);
    });
    tabs.append(tab);
  }
  filter.addEventListener("input", () => {
    const selectedPanelId = Array.from(tabs.children).find((tab) => tab.getAttribute("aria-selected") === "true")?.getAttribute("data-desktop-cowork-panel") ?? "";
    renderPanel(selectedPanelId);
  });
  section.append(createText(targetDocument, "h2", "Observability"), tabs, filter, panelHost);
  renderPanel(view.observabilityPanels[0]?.id ?? "");
  mountCoworkObservabilityVueIsland(section, targetDocument, view);
  return section;
}

function mountCoworkObservabilityVueIsland(
  section: HTMLElement,
  targetDocument: Document,
  view: DesktopCoworkCockpitView,
): void {
  if (!canMountVueIsland(section)) {
    return;
  }
  mountCoworkObservabilityIsland(section, {
    panels: view.observabilityPanels,
    onPanelSelected: (panel) => {
      setRouteStatus(targetDocument, `Viewing Cowork ${panel.label}`);
    },
  });
}

function createCoworkInspectorPane(
  targetDocument: Document,
  view: DesktopCoworkCockpitView,
  pane: DesktopCoworkPaneModel,
  coworkActions: DesktopCoworkActionOptions,
): HTMLElement {
  const inspector = targetDocument.createElement("section");
  inspector.className = "desktop-cowork-inspector";
  inspector.append(
    createText(targetDocument, "h2", `Selected: ${view.inspector.title}`),
    createText(targetDocument, "p", view.inspector.body || `${view.inspector.type || "entity"} ${view.inspector.id || ""}`.trim()),
  );
  for (const row of view.inspector.rows) {
    inspector.append(createText(targetDocument, "p", `${row.label}: ${row.value}`));
  }
  if (view.inspector.payloadText) {
    inspector.append(createText(targetDocument, "p", `Payload: ${view.inspector.payloadText}`));
  }
  appendCoworkSelectedActions(targetDocument, inspector, view, pane, coworkActions);
  mountCoworkInspectorVueIsland(inspector, view, pane, coworkActions);
  return inspector;
}

function mountCoworkInspectorVueIsland(
  inspector: HTMLElement,
  view: DesktopCoworkCockpitView,
  pane: DesktopCoworkPaneModel,
  coworkActions: DesktopCoworkActionOptions,
): void {
  if (!canMountVueIsland(inspector)) {
    return;
  }
  mountCoworkInspectorIsland(inspector, {
    view,
    onAction: (event) => {
      coworkActions.onCoworkAction?.({ ...event, pane });
    },
  });
}

function appendCoworkSelectedActions(
  targetDocument: Document,
  inspector: HTMLElement,
  view: DesktopCoworkCockpitView,
  pane: DesktopCoworkPaneModel,
  coworkActions: DesktopCoworkActionOptions,
): void {
  const sessionId = view.header.id;
  const type = view.inspector.type;
  const id = view.inspector.id;
  if (!sessionId || !type || !id) {
    return;
  }
  const actions = targetDocument.createElement("div");
  actions.className = "desktop-cowork-selected-actions";

  if (type === "task") {
    const agent = targetDocument.createElement("input");
    agent.className = "desktop-cowork-action-input";
    agent.setAttribute("aria-label", "Assign task to agent");
    agent.setAttribute("data-desktop-cowork-input", "assignedAgentId");
    (agent as HTMLInputElement).value = view.agents[0]?.id ?? "";
    actions.append(agent);
    for (const [action, label, taskAction] of [
      ["assignTask", "Assign", "assign"],
      ["retryTask", "Retry", "retry"],
      ["reviewTask", "Review", "review"],
    ] as const) {
      const button = createCoworkSelectedActionButton(targetDocument, action, label);
      button.addEventListener("click", () => {
        coworkActions.onCoworkAction?.({
          action: "task",
          pane,
          sessionId,
          taskId: id,
          taskAction,
          assignedAgentId: taskAction === "assign" ? (agent as HTMLInputElement).value.trim() : undefined,
        });
      });
      actions.append(button);
    }
  } else if (type === "agent") {
    const button = createCoworkSelectedActionButton(targetDocument, "loadAgentActivity", "Activity");
    button.addEventListener("click", () => {
      coworkActions.onCoworkAction?.({
        action: "loadAgentActivity",
        pane,
        sessionId,
        agentId: id,
        limit: DEFAULT_COWORK_AGENT_ACTIVITY_LIMIT,
      });
    });
    actions.append(button);
    const detailRef = latestAgentObservationDetailRef(view, id);
    if (detailRef) {
      const observation = createCoworkSelectedActionButton(targetDocument, "loadObservation", "Observation");
      observation.addEventListener("click", () => {
        coworkActions.onCoworkAction?.({
          action: "loadObservation",
          pane,
          sessionId,
          detailRef,
          requesterAgentId: id,
        });
      });
      actions.append(observation);
    }
  } else if (type === "workUnit") {
    for (const [action, label, workUnitAction] of [
      ["retryWorkUnit", "Retry", "retry"],
      ["skipWorkUnit", "Skip", "skip"],
      ["cancelWorkUnit", "Cancel", "cancel"],
    ] as const) {
      const button = createCoworkSelectedActionButton(targetDocument, action, label);
      button.addEventListener("click", () => {
        coworkActions.onCoworkAction?.({
          action: "workUnit",
          pane,
          sessionId,
          workUnitId: id,
          workUnitAction,
        });
      });
      actions.append(button);
    }
  } else if (type === "branch") {
    const branch = view.branches.find((item) => item.branchId === id || item.resultId === id);
    for (const [action, label] of [
      ["selectBranch", "Select branch"],
      ["deriveBranch", "Derive branch"],
      ["selectBranchResult", "Set final"],
      ["mergeBranchResults", "Merge results"],
      ["selectFinalResult", "Select final"],
      ["mergeFinalResult", "Merge final"],
    ] as const) {
      const button = createCoworkSelectedActionButton(targetDocument, action, label);
      button.addEventListener("click", () => {
        if (action === "mergeBranchResults" || action === "mergeFinalResult") {
          coworkActions.onCoworkAction?.({
            action,
            pane,
            sessionId,
            branchIds: view.branches.map((item) => item.branchId).filter(Boolean),
          });
          return;
        }
        coworkActions.onCoworkAction?.({
          action,
          pane,
          sessionId,
          sourceBranchId: action === "deriveBranch" ? branch?.branchId || id : undefined,
          targetArchitecture: action === "deriveBranch" ? "swarm" : undefined,
          branchId: action === "deriveBranch" ? undefined : branch?.branchId || id,
          resultId: action === "selectBranchResult" || action === "selectFinalResult" ? branch?.resultId : undefined,
        });
      });
      actions.append(button);
    }
  }

  if (actions.children.length) {
    inspector.append(actions);
  }
}

function createCoworkSelectedActionButton(targetDocument: Document, action: string, label: string): HTMLButtonElement {
  const button = targetDocument.createElement("button");
  button.type = "button";
  button.className = "desktop-cowork-action";
  button.setAttribute("data-desktop-cowork-entity-action", action);
  button.textContent = label;
  return button as HTMLButtonElement;
}

function latestAgentObservationDetailRef(view: DesktopCoworkCockpitView, agentId: string): string {
  const raw = recordValue(view.raw);
  const steps = arrayValue(raw.agent_steps).map(recordValue).filter((step) => String(step.agent_id ?? "") === agentId);
  for (const step of [...steps].reverse()) {
    const observations = [
      ...arrayValue(step.tool_observations),
      ...arrayValue(step.browser_observations),
    ].map(recordValue).reverse();
    for (const observation of observations) {
      const detailRef = String(
        observation.detail_ref
        ?? observation.detailRef
        ?? observation.detail_id
        ?? observation.detailId
        ?? "",
      ).trim();
      if (detailRef) {
        return detailRef;
      }
    }
  }
  return "";
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function coworkBudgetMaxRoundsValue(pane: DesktopCoworkPaneModel): string {
  const raw = pane.cockpitView?.raw as Record<string, unknown> | undefined;
  const budgetState = raw?.budget_state as Record<string, unknown> | undefined;
  const budget = raw?.budget as Record<string, unknown> | undefined;
  const value = budgetState?.max_rounds ?? budget?.max_rounds;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? String(value) : "";
}

function parseCoworkPositiveInteger(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function createCoworkTaskFeed(targetDocument: Document, view: DesktopCoworkCockpitView): HTMLElement {
  const feed = targetDocument.createElement("section");
  feed.className = "desktop-cowork-task-feed";
  feed.append(createText(targetDocument, "h2", "Task feed"));
  const visibleItems = view.taskCenterItems.slice(0, COWORK_TASK_FEED_LIMIT);
  for (const item of visibleItems) {
    feed.append(createCoworkDataRow(targetDocument, "desktop-cowork-task-feed-row", `${item.title}: ${item.status} / ${item.detail}`));
  }
  feed.append(createCoworkLimitStatus(targetDocument, visibleItems.length, view.taskCenterItems.length, "task status item", "task status items"));
  feed.append(createText(targetDocument, "p", `${view.agents.length} agents / ${view.tasks.length} tasks / ${view.mailbox.length} mailbox / ${view.artifacts.length} artifacts`));
  mountCoworkTaskFeedVueIsland(feed, view);
  return feed;
}

function mountCoworkTaskFeedVueIsland(feed: HTMLElement, view: DesktopCoworkCockpitView): void {
  if (!canMountVueIsland(feed)) {
    return;
  }
  mountCoworkTaskFeedIsland(feed, {
    items: view.taskCenterItems,
    totals: {
      agents: view.agents.length,
      tasks: view.tasks.length,
      mailbox: view.mailbox.length,
      artifacts: view.artifacts.length,
    },
  });
}

function createCoworkDataRow(targetDocument: Document, className: string, text: string): HTMLElement {
  const row = createText(targetDocument, "p", text);
  row.className = className;
  mountCoworkDataRowVueIsland(row, className, text);
  return row;
}

function mountCoworkDataRowVueIsland(row: HTMLElement, className: string, text: string): void {
  if (!canMountVueIsland(row)) {
    return;
  }
  mountCoworkDataRowIsland(row, { className, text });
}

function createCoworkLimitStatus(targetDocument: Document, visible: number, total: number, singular: string, plural: string): HTMLElement {
  const noun = total === 1 ? singular : plural;
  const text = `Showing ${visible} of ${total} ${noun}`;
  const status = createText(targetDocument, "p", text);
  status.className = "desktop-cowork-limit-status";
  mountCoworkLimitStatusVueIsland(status, text);
  return status;
}

function mountCoworkLimitStatusVueIsland(status: HTMLElement, text: string): void {
  if (!canMountVueIsland(status)) {
    return;
  }
  mountCoworkLimitStatusIsland(status, { text });
}

function createCoworkFilteredLimitStatus(
  targetDocument: Document,
  visible: number,
  matched: number,
  total: number,
  singular: string,
  plural: string,
  filtered: boolean,
): HTMLElement {
  if (!filtered) {
    return createCoworkLimitStatus(targetDocument, visible, total, singular, plural);
  }
  const noun = plural || singular;
  const text = `Showing ${visible} of ${matched} matching ${noun} (${total} total)`;
  const status = createText(targetDocument, "p", text);
  status.className = "desktop-cowork-limit-status";
  mountCoworkLimitStatusVueIsland(status, text);
  return status;
}

function appendKnowledgeReferenceRows(
  targetDocument: Document,
  section: HTMLElement,
  label: string,
  rows: Array<{ title: string; meta: string; text: string }>,
): void {
  for (const row of rows.slice(0, 4)) {
    section.append(createText(targetDocument, "p", knowledgeReferenceRowText(label, row)));
  }
}

function knowledgeReferenceRowText(label: string, row: { title: string; text: string }): string {
  return `${label}: ${row.title}${row.text ? ` - ${row.text}` : ""}`;
}

function createDesktopSkillEditor(
  targetDocument: Document,
  pane: DesktopToolsSkillsPaneModel,
  toolsSkillsActions: DesktopToolsSkillsActionOptions,
): HTMLElement {
  const detail = pane.selectedSkill;
  const editor = targetDocument.createElement("div");
  editor.className = "desktop-skill-editor";
  if (!detail) {
    return editor;
  }

  editor.append(
    createDesktopSkillInput(targetDocument, "name", "Skill name", detail.editor.draft.name, !detail.nameEditable, pane, toolsSkillsActions),
    createDesktopSkillInput(targetDocument, "description", "Description", detail.editor.draft.description, false, pane, toolsSkillsActions),
    createDesktopSkillCheckbox(targetDocument, "always", "Always load", detail.editor.draft.always, pane, toolsSkillsActions),
    createDesktopSkillTextArea(targetDocument, "content", "Skill content", detail.editor.draft.content, pane, toolsSkillsActions),
  );
  mountSkillEditorVueIsland(editor, pane, toolsSkillsActions);
  return editor;
}

function mountSkillEditorVueIsland(
  editor: HTMLElement,
  pane: DesktopToolsSkillsPaneModel,
  toolsSkillsActions: DesktopToolsSkillsActionOptions,
): void {
  if (!canMountVueIsland(editor) || !pane.selectedSkill) {
    return;
  }
  mountSkillEditorIsland(editor, {
    skill: pane.selectedSkill!,
    onEdit: (field, value) => {
      toolsSkillsActions.onToolsSkillsAction?.({
        action: "editSkill",
        pane,
        field,
        value,
      });
    },
  });
}

function createDesktopSkillInput(
  targetDocument: Document,
  field: Extract<DesktopSkillEditorField, "name" | "description">,
  label: string,
  value: string,
  disabled: boolean,
  pane: DesktopToolsSkillsPaneModel,
  toolsSkillsActions: DesktopToolsSkillsActionOptions,
): HTMLElement {
  const input = targetDocument.createElement("input");
  input.className = "desktop-skill-editor-field";
  input.setAttribute("aria-label", label);
  input.setAttribute("data-desktop-skill-editor-field", field);
  input.setAttribute("value", value);
  if (disabled) {
    input.setAttribute("disabled", "true");
  }
  (input as HTMLInputElement).value = value;
  input.addEventListener("input", (event) => {
    toolsSkillsActions.onToolsSkillsAction?.({
      action: "editSkill",
      pane,
      field,
      value: String((event.target as HTMLInputElement | null)?.value ?? ""),
    });
  });
  return input;
}

function createDesktopSkillCheckbox(
  targetDocument: Document,
  field: Extract<DesktopSkillEditorField, "always">,
  label: string,
  checked: boolean,
  pane: DesktopToolsSkillsPaneModel,
  toolsSkillsActions: DesktopToolsSkillsActionOptions,
): HTMLElement {
  const input = targetDocument.createElement("input");
  input.className = "desktop-skill-editor-field";
  input.setAttribute("type", "checkbox");
  input.setAttribute("aria-label", label);
  input.setAttribute("data-desktop-skill-editor-field", field);
  if (checked) {
    input.setAttribute("checked", "true");
  }
  (input as HTMLInputElement).checked = checked;
  input.addEventListener("change", (event) => {
    toolsSkillsActions.onToolsSkillsAction?.({
      action: "editSkill",
      pane,
      field,
      value: (event.target as HTMLInputElement | null)?.checked === true,
    });
  });
  return input;
}

function createDesktopSkillTextArea(
  targetDocument: Document,
  field: Extract<DesktopSkillEditorField, "content">,
  label: string,
  value: string,
  pane: DesktopToolsSkillsPaneModel,
  toolsSkillsActions: DesktopToolsSkillsActionOptions,
): HTMLElement {
  const textarea = targetDocument.createElement("textarea");
  textarea.className = "desktop-skill-editor-field desktop-skill-editor-content";
  textarea.setAttribute("aria-label", label);
  textarea.setAttribute("data-desktop-skill-editor-field", field);
  (textarea as HTMLTextAreaElement).value = value;
  textarea.addEventListener("input", (event) => {
    toolsSkillsActions.onToolsSkillsAction?.({
      action: "editSkill",
      pane,
      field,
      value: String((event.target as HTMLTextAreaElement | null)?.value ?? ""),
    });
  });
  return textarea;
}

function createSettingsProvidersPane(
  targetDocument: Document,
  pane: DesktopSettingsPaneModel,
  settingsActions: DesktopSettingsActionOptions = {},
  initialActiveGroupId?: DesktopSettingsPaneGroup["id"],
): HTMLElement {
  const section = targetDocument.createElement("section");
  section.className = "desktop-workbench-section desktop-settings-pane";
  section.setAttribute("data-desktop-module-surface", "settings");
  section.setAttribute("data-settings-layout", "section-pages");
  section.setAttribute("aria-label", "Settings and providers");
  const activeGroupId = getDesktopSettingsActiveGroup(pane, initialActiveGroupId)?.id ?? "general";
  if (canMountVueIsland(section)) {
    mountSettingsPaneVueIsland(section, targetDocument, pane, settingsActions, activeGroupId, "content");
    return section;
  }

  const content = targetDocument.createElement("div");
  content.className = "desktop-settings-content";

  const renderActiveGroup = (groupId: DesktopSettingsPaneGroup["id"]) => {
    setDesktopSettingsActiveNav(targetDocument, groupId);
    content.replaceChildren(
      createSettingsLocalNavigationFallback(targetDocument, pane, groupId, renderActiveGroup),
      ...createSettingsActivePage(targetDocument, pane, settingsActions, groupId),
    );
  };

  renderActiveGroup(activeGroupId);
  section.append(content);
  return section;
}

function renderFallbackSettingsContent(
  targetDocument: Document,
  pane: DesktopSettingsPaneModel,
  settingsActions: DesktopSettingsActionOptions,
  activeGroupId: DesktopSettingsPaneGroup["id"],
): void {
  const content = targetDocument.querySelector<HTMLElement>(".desktop-settings-content");
  if (!content) {
    return;
  }
  setDesktopSettingsActiveNav(targetDocument, activeGroupId);
  const renderActiveGroup = (groupId: DesktopSettingsPaneGroup["id"]) => {
    renderFallbackSettingsContent(targetDocument, pane, settingsActions, groupId);
  };
  content.replaceChildren(
    createSettingsLocalNavigationFallback(targetDocument, pane, activeGroupId, renderActiveGroup),
    ...createSettingsActivePage(targetDocument, pane, settingsActions, activeGroupId),
  );
}

function createSettingsLocalNavigationFallback(
  targetDocument: Document,
  pane: DesktopSettingsPaneModel,
  activeGroupId: DesktopSettingsPaneGroup["id"],
  onSelectGroup: (groupId: DesktopSettingsPaneGroup["id"]) => void,
): HTMLElement {
  const activeGroup = getDesktopSettingsActiveGroup(pane, activeGroupId);
  const nav = targetDocument.createElement("nav");
  nav.className = "desktop-settings-local-nav";
  nav.setAttribute("aria-label", "Settings navigation fallback");

  const menu = targetDocument.createElement("details");
  menu.className = "desktop-settings-local-nav-menu";
  const summary = createText(targetDocument, "summary", activeGroup?.label ?? "Settings");
  summary.className = "desktop-settings-local-nav-current";
  const list = targetDocument.createElement("div");
  list.className = "desktop-settings-local-nav-list";

  for (const group of pane.groups) {
    const item = targetDocument.createElement("a");
    item.className = "desktop-settings-nav-item";
    item.setAttribute("href", "#");
    item.setAttribute("data-desktop-settings-nav", group.id);
    if (group.id === activeGroupId) {
      item.setAttribute("data-active", "true");
      item.setAttribute("aria-current", "page");
    }
    item.textContent = getSettingsNavLabel(group.id);
    item.addEventListener("click", (event) => {
      selectDesktopSettingsGroup(event, targetDocument, group.id, onSelectGroup);
      menu.removeAttribute("open");
    });
    list.append(item);
  }

  menu.append(summary, list);
  const restore = targetDocument.createElement("button");
  restore.className = "desktop-settings-local-nav-restore";
  restore.setAttribute("type", "button");
  restore.setAttribute("data-desktop-settings-action", "showSidebarNav");
  restore.textContent = "Show settings nav";
  restore.addEventListener("click", () => {
    setDesktopPanelVisible(targetDocument, "sidebar", true);
  });
  nav.append(menu, restore);
  return nav;
}

function createSettingsActivePage(
  targetDocument: Document,
  pane: DesktopSettingsPaneModel,
  settingsActions: DesktopSettingsActionOptions,
  activeGroupId: DesktopSettingsPaneGroup["id"],
): HTMLElement[] {
  const activeGroup = getDesktopSettingsActiveGroup(pane, activeGroupId);
  const nodes = [createSettingsPageHeader(targetDocument, pane, settingsActions, activeGroup)];
  if (activeGroup?.id === "general") {
    nodes.push(createGeneralSettingsPage(targetDocument, pane, activeGroup, settingsActions));
    return nodes;
  }
  if (activeGroup?.id === "provider-models") {
    nodes.push(createProviderModelsSettingsPage(targetDocument, pane, activeGroup, settingsActions));
    return nodes;
  }
  if (activeGroup?.id === "knowledge") {
    nodes.push(createKnowledgeSettingsPage(targetDocument, pane, activeGroup, settingsActions));
    return nodes;
  }
  if (activeGroup) {
    const grid = targetDocument.createElement("div");
    grid.className = "desktop-settings-grid";
    const groupSection = createSettingsGroupSection(targetDocument, pane, activeGroup, settingsActions);
    if (groupSection) {
      grid.append(groupSection);
      nodes.push(grid);
    }
  }
  return nodes;
}

function createSettingsPageHeader(
  targetDocument: Document,
  pane: DesktopSettingsPaneModel,
  settingsActions: DesktopSettingsActionOptions,
  group: DesktopSettingsPaneGroup | null,
): HTMLElement {
  const header = targetDocument.createElement("header");
  header.className = "desktop-settings-header";
  const breadcrumb = targetDocument.createElement("div");
  breadcrumb.className = "desktop-settings-breadcrumb";
  breadcrumb.append(createText(targetDocument, "h2", group?.label ?? "General"));
  if (group) {
    const description = createText(targetDocument, "p", getSettingsGroupDescription(group.id));
    description.className = "desktop-settings-header-description";
    breadcrumb.append(description);
  }
  header.append(breadcrumb);
  const saveButton = createSettingsSaveButton(targetDocument, pane, settingsActions);
  if (saveButton) {
    header.append(saveButton);
  }
  return header;
}

function createSettingsSaveButton(
  targetDocument: Document,
  pane: DesktopSettingsPaneModel,
  settingsActions: DesktopSettingsActionOptions,
): HTMLElement | null {
  if (!pane.dirty && !pane.save.canSave && pane.save.status !== "saving" && pane.save.status !== "failed") {
    return null;
  }
  const save = targetDocument.createElement("button");
  save.className = "desktop-settings-save-status-button";
  save.setAttribute("type", "button");
  save.setAttribute("data-desktop-settings-action", "save");
  if (!pane.save.canSave) {
    save.setAttribute("disabled", "true");
  }
  save.textContent = getDesktopSettingsSaveLabel(pane);
  save.addEventListener("click", () => {
    settingsActions.onSettingsAction?.({ action: "save", pane });
  });
  return save;
}

function getDesktopSettingsSaveLabel(pane: DesktopSettingsPaneModel): string {
  if (pane.save.status === "saving") {
    return "保存中";
  }
  if (pane.save.status === "saved" || !pane.dirty) {
    return "已保存";
  }
  return "保存设置";
}

function createSettingsGroupSection(
  targetDocument: Document,
  pane: DesktopSettingsPaneModel,
  group: DesktopSettingsPaneGroup,
  settingsActions: DesktopSettingsActionOptions,
): HTMLElement | null {
  const fields = getSettingsGroupDisplayFields(group);
  if (!fields.length) {
    return null;
  }
  const groupSection = targetDocument.createElement("section");
  groupSection.className = "desktop-settings-group";
  groupSection.setAttribute("id", `desktop-settings-group-${group.id}`);
  groupSection.setAttribute("data-desktop-settings-group", group.id);
  groupSection.append(createText(targetDocument, "h2", group.label));
  const description = getSettingsGroupDescription(group.id);
  if (description) {
    const copy = createText(targetDocument, "p", description);
    copy.className = "desktop-settings-group-description";
    groupSection.append(copy);
  }
  const primaryFields = fields.filter((field) => !field.advanced);
  const advancedFields = fields.filter((field) => field.advanced);
  for (const field of primaryFields) {
    groupSection.append(createDesktopSettingsFieldRow(targetDocument, pane, group, field, settingsActions));
  }
  if (advancedFields.length) {
    const details = targetDocument.createElement("details");
    details.className = "desktop-settings-advanced-fields";
    details.append(createText(targetDocument, "summary", "Advanced"));
    for (const field of advancedFields) {
      details.append(createDesktopSettingsFieldRow(targetDocument, pane, group, field, settingsActions));
    }
    groupSection.append(details);
  }
  return groupSection;
}

function mountSettingsPaneVueIsland(
  section: HTMLElement,
  targetDocument: Document,
  pane: DesktopSettingsPaneModel,
  settingsActions: DesktopSettingsActionOptions,
  initialActiveGroupId: DesktopSettingsPaneGroup["id"],
  mode: "full" | "content" | "sidebar" = "full",
): void {
  if (!canMountVueIsland(section)) {
    return;
  }
  mountSettingsPaneIsland(section, {
    pane,
    initialActiveGroupId,
    mode,
    onSettingsAction: settingsActions.onSettingsAction,
    promptProviderId: () => promptForSettingsProviderId(targetDocument),
    onFocusSettingsControl: (fieldId) => focusDesktopSettingsControl(targetDocument, fieldId),
  });
}

function createSettingsSectionHeading(
  targetDocument: Document,
  title: string,
  description: string,
  badge?: string,
): HTMLElement {
  const header = targetDocument.createElement("header");
  header.className = "desktop-settings-section-heading";
  const copy = targetDocument.createElement("div");
  copy.append(createText(targetDocument, "h2", title), createText(targetDocument, "p", description));
  header.append(copy);
  if (badge) {
    const tag = createText(targetDocument, "span", badge);
    tag.className = "desktop-settings-section-badge";
    header.append(tag);
  }
  return header;
}

function createGeneralSettingsPage(
  targetDocument: Document,
  pane: DesktopSettingsPaneModel,
  group: DesktopSettingsPaneGroup,
  settingsActions: DesktopSettingsActionOptions,
): HTMLElement {
  const page = targetDocument.createElement("div");
  page.className = "desktop-settings-task-page desktop-settings-general-page";
  page.setAttribute("data-desktop-settings-task-page", "general");

  const defaultAi = targetDocument.createElement("section");
  defaultAi.className = "desktop-settings-task-card desktop-settings-default-ai-section";
  defaultAi.setAttribute("data-desktop-settings-page-section", "default-ai");
  defaultAi.append(createSettingsSectionHeading(targetDocument, "Default AI", "Choose the provider and model used when a task has no explicit override.", "Auto routing"));
  const defaultLayout = targetDocument.createElement("div");
  defaultLayout.className = "desktop-settings-default-ai-layout";
  const fields = targetDocument.createElement("div");
  fields.className = "desktop-settings-field-pair";
  const provider = findSettingsPaneField(pane, "general", "provider");
  const model = findSettingsPaneField(pane, "general", "model");
  if (provider) fields.append(createSettingsControlField(targetDocument, pane, provider, provider.label, settingsActions));
  if (model) fields.append(createSettingsControlField(targetDocument, pane, model, model.label, settingsActions));
  const resolved = targetDocument.createElement("aside");
  resolved.className = "desktop-settings-status-card desktop-settings-resolved-route-card";
  resolved.setAttribute("data-desktop-settings-auto-resolution", "");
  resolved.append(
    createText(targetDocument, "span", "Resolved route"),
    createText(targetDocument, "strong", `${pane.defaultRouting?.providerLabel ?? provider?.inputValue ?? "Auto"} / ${pane.defaultRouting?.model ?? model?.inputValue ?? "Not configured"}`),
  );
  defaultLayout.append(fields, resolved);
  defaultAi.append(defaultLayout, createText(targetDocument, "p", "Agents can still override this default per task."));

  const profileLocale = targetDocument.createElement("section");
  profileLocale.className = "desktop-settings-task-card desktop-settings-profile-locale-section";
  profileLocale.setAttribute("data-desktop-settings-page-section", "profile-locale");
  profileLocale.append(createSettingsSectionHeading(targetDocument, "Locale", "Time settings used throughout the desktop app."));
  const localeFields = targetDocument.createElement("div");
  localeFields.className = "desktop-settings-field-pair";
  for (const id of ["timezone"]) {
    const field = findSettingsPaneField(pane, "general", id);
    if (field) localeFields.append(createDesktopSettingsFieldRow(targetDocument, pane, group, field, settingsActions));
  }
  profileLocale.append(localeFields);

  const responseDefaults = targetDocument.createElement("section");
  responseDefaults.className = "desktop-settings-task-card desktop-settings-response-defaults-section";
  responseDefaults.setAttribute("data-desktop-settings-page-section", "response-defaults");
  responseDefaults.append(createSettingsSectionHeading(targetDocument, "Response defaults", "Balanced defaults for quality, speed, and context usage."));
  const responseGrid = targetDocument.createElement("div");
  responseGrid.className = "desktop-settings-response-grid";
  for (const id of ["temperature", "maxTokens", "contextWindowTokens", "reasoningEffort", "maxToolIterations"]) {
    const field = findSettingsPaneField(pane, "general", id);
    if (field) responseGrid.append(createDesktopSettingsFieldRow(targetDocument, pane, group, field, settingsActions));
  }
  responseGrid.append(createText(targetDocument, "aside", "Recommended baseline: Good for everyday desktop work."));
  responseDefaults.append(responseGrid);

  page.append(defaultAi, profileLocale, responseDefaults);
  return page;
}

function createProviderModelsSettingsPage(
  targetDocument: Document,
  pane: DesktopSettingsPaneModel,
  group: DesktopSettingsPaneGroup,
  settingsActions: DesktopSettingsActionOptions,
): HTMLElement {
  const page = targetDocument.createElement("div");
  page.className = "desktop-settings-task-page desktop-settings-provider-page";
  page.setAttribute("data-desktop-settings-task-page", "provider-models");
  page.append(createProviderManagementSection(targetDocument, pane, settingsActions));

  const selected = getProviderCards(pane).find((provider) => provider.id === pane.providerEditor.selectedProvider) ?? getProviderCards(pane)[0];
  const detail = targetDocument.createElement("aside");
  detail.className = "desktop-settings-task-card desktop-settings-provider-detail-panel";
  detail.setAttribute("data-desktop-settings-provider-detail", selected?.id ?? "");
  detail.append(createSettingsSectionHeading(targetDocument, `Edit ${selected?.label ?? pane.providerEditor.selectedProvider}`, "Changes apply to the selected profile.", selected?.statusLabel));

  const connection = targetDocument.createElement("section");
  connection.className = "desktop-settings-provider-detail-section";
  connection.setAttribute("data-desktop-settings-provider-detail-section", "connection");
  connection.append(createText(targetDocument, "h3", "Connection"));
  for (const id of ["profileId", "apiKey", "apiBase"]) {
    const field = findSettingsPaneField(pane, "provider-models", id);
    if (field) connection.append(createDesktopSettingsFieldRow(targetDocument, pane, group, field, settingsActions));
  }

  const models = targetDocument.createElement("section");
  models.className = "desktop-settings-provider-detail-section";
  models.setAttribute("data-desktop-settings-provider-detail-section", "models");
  models.append(createText(targetDocument, "h3", "Model catalog"));
  const modelField = findSettingsPaneField(pane, "provider-models", "models");
  if (modelField) models.append(createDesktopSettingsFieldRow(targetDocument, pane, group, modelField, settingsActions));
  const modelActions = targetDocument.createElement("div");
  modelActions.className = "desktop-settings-provider-model-actions";
  const autoFetch = createText(targetDocument, "button", "Auto fetch models");
  autoFetch.setAttribute("type", "button");
  autoFetch.setAttribute("data-desktop-settings-action", "discoverModels");
  autoFetch.setAttribute("data-desktop-settings-provider-action", "autoFetchModels");
  autoFetch.setAttribute("aria-label", `Auto fetch models for ${selected?.id ?? pane.providerEditor.selectedProvider}`);
  if (!pane.providerEditor.canDiscoverModels) {
    autoFetch.setAttribute("disabled", "true");
  }
  autoFetch.addEventListener("click", () => {
    requestSettingsProviderModels(pane, settingsActions, selected?.id ?? pane.providerEditor.selectedProvider);
  });
  modelActions.append(autoFetch);
  models.append(modelActions);
  detail.append(connection, models);

  page.append(detail);
  return page;
}

function createKnowledgeSettingsPage(
  targetDocument: Document,
  pane: DesktopSettingsPaneModel,
  group: DesktopSettingsPaneGroup,
  settingsActions: DesktopSettingsActionOptions,
): HTMLElement {
  const page = targetDocument.createElement("div");
  page.className = "desktop-settings-task-page desktop-settings-knowledge-page";
  page.setAttribute("data-desktop-settings-task-page", "knowledge");

  const toolbar = targetDocument.createElement("div");
  toolbar.className = "desktop-settings-knowledge-toolbar";
  const enabled = findSettingsPaneField(pane, "knowledge", "enabled");
  const enabledLabel = targetDocument.createElement("label");
  enabledLabel.className = "desktop-settings-knowledge-enabled";
  enabledLabel.setAttribute("data-desktop-settings-knowledge-enabled", "");
  enabledLabel.append(createText(targetDocument, "span", "Knowledge enabled"));
  if (enabled) enabledLabel.append(createDesktopSettingsControl(targetDocument, pane, enabled, settingsActions));
  const openDocuments = createText(targetDocument, "button", "Open documents");
  openDocuments.setAttribute("type", "button");
  openDocuments.setAttribute("data-desktop-settings-knowledge-action", "openDocuments");
  openDocuments.addEventListener("click", () => settingsActions.onSettingsAction?.({ action: "openKnowledgeDocuments", pane }));
  toolbar.append(enabledLabel, openDocuments);

  const pipeline = targetDocument.createElement("section");
  pipeline.className = "desktop-settings-task-card desktop-settings-knowledge-pipeline";
  pipeline.setAttribute("data-desktop-settings-page-section", "knowledge-pipeline");
  pipeline.append(createSettingsSectionHeading(targetDocument, "Knowledge pipeline", "Retrieval is available. Advanced enrichment remains optional.", "Ready"));
  const stages = targetDocument.createElement("ol");
  stages.className = "desktop-settings-knowledge-stages";
  for (const stage of ["documents", "chunking", "embeddings", "retrieval", "rerank", "graph"]) {
    const item = createText(targetDocument, "li", stage);
    item.setAttribute("data-desktop-settings-knowledge-stage", stage);
    stages.append(item);
  }
  pipeline.append(stages);

  const retrieval = targetDocument.createElement("section");
  retrieval.className = "desktop-settings-task-card desktop-settings-retrieval-defaults";
  retrieval.setAttribute("data-desktop-settings-page-section", "retrieval-defaults");
  retrieval.append(createSettingsSectionHeading(targetDocument, "Retrieval defaults", "The settings used when a chat requests knowledge."));
  for (const id of ["autoRetrieve", "retrievalMode", "maxChunks"]) {
    const field = findSettingsPaneField(pane, "knowledge", id);
    if (field) retrieval.append(createDesktopSettingsFieldRow(targetDocument, pane, group, field, settingsActions));
  }

  const presets = targetDocument.createElement("section");
  presets.className = "desktop-settings-task-card desktop-settings-quality-presets";
  presets.setAttribute("data-desktop-settings-page-section", "quality-presets");
  presets.append(createSettingsSectionHeading(targetDocument, "Quality preset", "A shortcut mapped to existing settings."));
  for (const preset of ["fast", "balanced", "deep"]) {
    const button = createText(targetDocument, "button", preset);
    button.setAttribute("type", "button");
    button.setAttribute("data-desktop-settings-quality-preset", preset);
    button.addEventListener("click", () => {
      const deep = preset === "deep";
      settingsActions.onSettingsAction?.({ action: "edit", pane, fieldId: "rerankEnabled", value: deep });
      settingsActions.onSettingsAction?.({ action: "edit", pane, fieldId: "graphExtractionEnabled", value: deep });
    });
    presets.append(button);
  }

  const layers = targetDocument.createElement("section");
  layers.className = "desktop-settings-task-card desktop-settings-quality-layers";
  layers.setAttribute("data-desktop-settings-page-section", "quality-layers");
  layers.append(createSettingsSectionHeading(targetDocument, "Indexing & quality layers", "Tune source preparation and optional quality improvements."));
  for (const id of ["chunkSize", "chunkOverlap", "rerankEnabled", "rerankTopN", "graphExtractionEnabled", "graphExtractionModel"]) {
    const field = findSettingsPaneField(pane, "knowledge", id);
    if (field) layers.append(createDesktopSettingsFieldRow(targetDocument, pane, group, field, settingsActions));
  }

  page.append(toolbar, pipeline, retrieval, presets, layers);
  return page;
}

function createProviderManagementSection(
  targetDocument: Document,
  pane: DesktopSettingsPaneModel,
  settingsActions: DesktopSettingsActionOptions,
): HTMLElement {
  const section = targetDocument.createElement("section");
  section.className = "desktop-settings-provider-section";
  section.setAttribute("aria-label", "Provider management");

  const header = targetDocument.createElement("header");
  header.className = "desktop-settings-provider-header";
  const title = targetDocument.createElement("div");
  title.append(
    createText(targetDocument, "h2", "Connected providers"),
    createText(targetDocument, "p", "Select a card to edit its connection and models."),
  );
  title.querySelector("p")?.classList.add("desktop-settings-group-description");

  const tools = targetDocument.createElement("div");
  tools.className = "desktop-settings-provider-tools";
  const search = targetDocument.createElement("input");
  search.className = "desktop-settings-provider-search";
  search.setAttribute("type", "search");
  search.setAttribute("placeholder", "Search providers...");
  search.setAttribute("aria-label", "Search providers");
  tools.append(search);

  const refresh = targetDocument.createElement("button");
  refresh.className = "desktop-settings-provider-icon-button";
  refresh.setAttribute("type", "button");
  refresh.setAttribute("data-desktop-settings-action", "discoverModels");
  refresh.setAttribute("aria-label", "Refresh provider models");
  if (!pane.providerEditor.canDiscoverModels) {
    refresh.setAttribute("disabled", "true");
  }
  refresh.textContent = "Refresh models";
  refresh.addEventListener("click", () => {
    requestSettingsProviderModels(pane, settingsActions, pane.providerEditor.selectedProvider);
  });

  const allProviders = getProviderCards(pane);
  const readyCount = allProviders.filter((provider) => provider.connected || /ready|connected/i.test(provider.statusLabel)).length;
  const modelCount = pane.providerCatalog.reduce((total, provider) => total + (provider.models?.length ?? 0), 0);
  for (const [summary, label] of [
    ["total", `${allProviders.length} ${allProviders.length === 1 ? "provider" : "providers"}`],
    ["ready", `${readyCount} ready`],
    ["models", `${modelCount} ${modelCount === 1 ? "model" : "models"}`],
  ] as const) {
    const chip = createText(targetDocument, "span", label);
    chip.className = "desktop-settings-provider-summary";
    chip.setAttribute("data-desktop-settings-provider-summary", summary);
    tools.append(chip);
  }

  const add = targetDocument.createElement("button");
  add.className = "desktop-settings-provider-add";
  add.setAttribute("type", "button");
  add.setAttribute("data-desktop-settings-action", "addProvider");
  add.addEventListener("click", () => {
    const providerId = promptForSettingsProviderId(targetDocument);
    if (providerId) {
      selectSettingsProvider(pane, settingsActions, providerId);
      focusDesktopSettingsControl(targetDocument, "selectedProvider");
    }
  });
  add.textContent = "+ Add provider";
  tools.append(refresh, add);
  header.append(title, tools);

  const cards = targetDocument.createElement("div");
  cards.className = "desktop-settings-provider-grid";
  for (const provider of getProviderCards(pane)) {
    cards.append(createProviderManagementCard(targetDocument, pane, provider, settingsActions));
  }
  search.addEventListener("input", () => {
    filterSettingsProviderCards(cards, search.value);
  });

  section.append(header, cards);
  return section;
}

function createSettingsControlField(
  targetDocument: Document,
  pane: DesktopSettingsPaneModel,
  field: DesktopSettingsPaneModel["groups"][number]["fields"][number],
  labelText: string,
  settingsActions: DesktopSettingsActionOptions,
): HTMLElement {
  const wrapper = targetDocument.createElement("label");
  wrapper.className = "desktop-settings-inline-field";
  wrapper.append(createText(targetDocument, "span", labelText));
  wrapper.append(field.id === "model" && getDefaultLlmModelOptions(pane).length > 0
    ? createDesktopSettingsModelSelect(targetDocument, pane, field, settingsActions)
    : createDesktopSettingsControl(targetDocument, pane, field, settingsActions));
  return wrapper;
}

function createDesktopSettingsModelSelect(
  targetDocument: Document,
  pane: DesktopSettingsPaneModel,
  field: DesktopSettingsPaneField,
  settingsActions: DesktopSettingsActionOptions,
): HTMLElement {
  const select = targetDocument.createElement("select");
  select.setAttribute("id", `desktop-settings-${field.id}`);
  select.setAttribute("data-desktop-settings-control", field.id);
  select.setAttribute("data-state", field.state);
  if (field.state === "invalid") {
    select.setAttribute("aria-invalid", "true");
  }
  const optionValues = field.options?.map((option) => option.value) ?? getDefaultLlmModelOptions(pane);
  const values = [field.inputValue, ...optionValues].filter(Boolean);
  const uniqueValues = Array.from(new Set(values));
  if (!uniqueValues.length) {
    uniqueValues.push("");
  }
  for (const value of uniqueValues) {
    const option = targetDocument.createElement("option");
    option.setAttribute("value", value);
    option.textContent = value || "暂未选择模型";
    if (value === field.inputValue) {
      option.setAttribute("selected", "true");
    }
    select.append(option);
  }
  select.addEventListener("change", (event) => {
    settingsActions.onSettingsAction?.({
      action: "edit",
      pane,
      fieldId: field.id,
      value: String((event.target as HTMLSelectElement | null)?.value ?? ""),
    });
  });
  return select;
}

function getDefaultLlmModelOptions(pane: DesktopSettingsPaneModel): string[] {
  const defaultProvider = findSettingsPaneField(pane, "general", "provider")?.inputValue;
  if (!defaultProvider || defaultProvider === "auto") {
    return pane.providerEditor.models;
  }
  return pane.providerCatalog.find((provider) => provider.id === defaultProvider)?.models ?? [];
}

function createProviderManagementCard(
  targetDocument: Document,
  pane: DesktopSettingsPaneModel,
  provider: DesktopProviderCardModel,
  settingsActions: DesktopSettingsActionOptions,
): HTMLElement {
  const card = targetDocument.createElement("article");
  card.className = "desktop-settings-provider-card";
  card.setAttribute("data-desktop-settings-provider-card", provider.id);
  if (provider.badge) {
    card.setAttribute("data-selected", "true");
  }

  const header = targetDocument.createElement("header");
  header.className = "desktop-settings-provider-card-header";
  const identity = targetDocument.createElement("div");
  identity.className = "desktop-settings-provider-identity";
  const mark = createText(targetDocument, "span", provider.initials);
  mark.className = "desktop-settings-provider-mark";
  mark.setAttribute("aria-hidden", "true");
  mark.setAttribute("data-provider-id", provider.id);
  const title = targetDocument.createElement("div");
  title.className = "desktop-settings-provider-title";
  title.append(createText(targetDocument, "h3", provider.label));
  const statusRow = targetDocument.createElement("div");
  statusRow.className = "desktop-settings-provider-status-row";
  if (provider.badge) {
    const badge = createText(targetDocument, "span", provider.badge);
    badge.className = "desktop-settings-provider-badge";
    statusRow.append(badge);
  }
  const status = createText(targetDocument, "span", provider.statusLabel);
  status.className = "desktop-settings-provider-status";
  statusRow.append(status);
  title.append(statusRow);
  identity.append(mark, title);
  const toggle = targetDocument.createElement("button");
  toggle.className = "desktop-settings-provider-switch";
  toggle.setAttribute("type", "button");
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("aria-checked", provider.connected ? "true" : "false");
  toggle.setAttribute("aria-label", `${provider.connected ? "Disable" : "Enable"} ${provider.label}`);
  toggle.setAttribute("data-desktop-settings-provider-action", "toggle");
  toggle.setAttribute("data-state", provider.connected ? "on" : "off");
  toggle.addEventListener("click", () => {
    settingsActions.onSettingsAction?.({
      action: "edit",
      pane,
      fieldId: `providerEnabled:${provider.id}`,
      value: !provider.connected,
    });
  });
  header.append(identity, toggle);

  const details = targetDocument.createElement("div");
  details.className = "desktop-settings-provider-details";
  details.append(
    createSettingsProviderDetail(targetDocument, "Base URL", provider.baseUrl),
    createSettingsProviderDetail(targetDocument, "API Key", provider.apiKey),
    createSettingsProviderDetail(targetDocument, "Model", provider.models),
  );

  const advanced = targetDocument.createElement("button");
  advanced.className = "desktop-settings-provider-advanced";
  advanced.setAttribute("type", "button");
  advanced.setAttribute("data-desktop-settings-provider-action", "settings");
  advanced.append(createText(targetDocument, "span", "Advanced settings"), createText(targetDocument, "span", "v"));
  advanced.addEventListener("click", () => {
    handleSettingsProviderCardAction(targetDocument, pane, settingsActions, provider.id, "settings");
  });

  const actions = targetDocument.createElement("div");
  actions.className = "desktop-settings-provider-card-actions";
  const modelAction = createText(targetDocument, "button", "Models");
  modelAction.setAttribute("type", "button");
  modelAction.setAttribute("data-desktop-settings-provider-action", "models");
  modelAction.addEventListener("click", () => {
    handleSettingsProviderCardAction(targetDocument, pane, settingsActions, provider.id, "models");
  });
  const settingsAction = createText(targetDocument, "button", "\u8bbe\u7f6e");
  settingsAction.setAttribute("type", "button");
  settingsAction.setAttribute("data-desktop-settings-provider-action", "settings");
  settingsAction.addEventListener("click", () => {
    handleSettingsProviderCardAction(targetDocument, pane, settingsActions, provider.id, "settings");
  });
  actions.replaceChildren(modelAction, settingsAction);

  card.append(header, details, advanced, actions);
  return card;
}

function createSettingsProviderDetail(targetDocument: Document, label: string, value: string): HTMLElement {
  const row = targetDocument.createElement("label");
  row.className = "desktop-settings-provider-detail";
  const input = targetDocument.createElement("input");
  input.setAttribute("readonly", "true");
  input.setAttribute("tabindex", "-1");
  input.setAttribute("value", value);
  input.setAttribute("aria-label", `${label}: ${value}`);
  (input as HTMLInputElement).value = value;
  const text = createText(targetDocument, "span", `${label}: ${value}`);
  text.className = "desktop-settings-provider-detail-text";
  row.append(createText(targetDocument, "span", `${label}: `), input, text);
  return row;
}

function filterSettingsProviderCards(cards: HTMLElement, query: string): void {
  const normalizedQuery = query.trim().toLowerCase();
  for (const card of cards.querySelectorAll<HTMLElement>(".desktop-settings-provider-card")) {
    const haystack = `${card.getAttribute("data-desktop-settings-provider-card") ?? ""} ${card.textContent ?? ""}`.toLowerCase();
    card.hidden = Boolean(normalizedQuery) && !haystack.includes(normalizedQuery);
  }
}

function promptForSettingsProviderId(targetDocument: Document): string | null {
  const providerId = targetDocument.defaultView?.prompt("Provider ID", "")?.trim() ?? "";
  return providerId || null;
}

function handleSettingsProviderCardAction(
  targetDocument: Document,
  pane: DesktopSettingsPaneModel,
  settingsActions: DesktopSettingsActionOptions,
  providerId: string,
  target: "models" | "settings",
): void {
  if (providerId !== pane.providerEditor.selectedProvider) {
    selectSettingsProvider(pane, settingsActions, providerId);
    focusDesktopSettingsControl(targetDocument, target === "models" ? "models" : "apiBase");
    if (target === "models") {
      requestSettingsProviderModels(pane, settingsActions, providerId);
    }
    return;
  }
  focusDesktopSettingsControl(targetDocument, target === "models" ? "models" : "apiBase");
  if (target === "models") {
    requestSettingsProviderModels(pane, settingsActions, providerId);
  }
}

function selectSettingsProvider(
  pane: DesktopSettingsPaneModel,
  settingsActions: DesktopSettingsActionOptions,
  providerId: string,
): void {
  settingsActions.onSettingsAction?.({
    action: "edit",
    pane,
    fieldId: "selectedProvider",
    value: providerId,
  });
}

function requestSettingsProviderModels(
  pane: DesktopSettingsPaneModel,
  settingsActions: DesktopSettingsActionOptions,
  providerId: string,
): void {
  settingsActions.onSettingsAction?.({
    action: "discoverModels",
    pane,
    providerId,
  });
}

function focusDesktopSettingsControl(targetDocument: Document, fieldId: string): void {
  targetDocument.querySelector<HTMLElement>(`[data-desktop-settings-control="${fieldId}"]`)?.focus();
}

type DesktopSettingsPaneGroup = DesktopSettingsPaneModel["groups"][number];
type DesktopSettingsPaneField = DesktopSettingsPaneGroup["fields"][number];

interface DesktopProviderCardModel {
  id: string;
  label: string;
  badge: string;
  initials: string;
  connected: boolean;
  statusLabel: string;
  baseUrl: string;
  apiKey: string;
  models: string;
}

function findSettingsPaneField(
  pane: DesktopSettingsPaneModel,
  groupId: DesktopSettingsPaneGroup["id"],
  fieldId: string,
): DesktopSettingsPaneField | null {
  return pane.groups.find((group) => group.id === groupId)?.fields.find((field) => field.id === fieldId) ?? null;
}

function getSettingsGroupDisplayFields(group: DesktopSettingsPaneGroup): DesktopSettingsPaneField[] {
  if (group.id === "general") {
    return group.fields.filter((field) => !["model", "provider"].includes(field.id));
  }
  if (group.id === "provider-models") {
    return group.fields.filter((field) => !["selectedProvider"].includes(field.id));
  }
  return group.fields;
}

function getProviderCards(pane: DesktopSettingsPaneModel): DesktopProviderCardModel[] {
  const selectedProvider = pane.providerEditor.selectedProvider || "provider";
  const catalog = pane.providerCatalog.length
    ? pane.providerCatalog
    : [{
      id: selectedProvider,
      label: selectedProvider,
      profileId: selectedProvider,
      status: "not_configured",
      enabled: false,
      baseUrl: null,
      apiKey: { value: "", displayValue: "", masked: false, empty: true },
      models: [],
      canDiscoverModels: true,
    }];
  return catalog.map((provider) => {
    const isSelected = provider.id === selectedProvider;
    const providerModels = provider.models ?? (isSelected ? pane.providerEditor.models : []);
    const models = providerModels.join(", ");
    const apiKey = provider.apiKey ?? (isSelected ? pane.providerEditor.apiKey : { displayValue: "" });
    return {
      id: provider.id,
      label: provider.label || provider.id,
      badge: isSelected ? "当前" : "",
      initials: getProviderInitials(provider.label || provider.id),
      connected: provider.enabled ?? (provider.status === "ready" || provider.status === "available"),
      statusLabel: formatProviderStatus(provider.enabled === false ? "disabled" : provider.status),
      baseUrl: provider.baseUrl || "未设置",
      apiKey: apiKey.displayValue || "未设置",
      models: models || "暂无模型",
    };
  });
}

function getProviderInitials(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (!words.length) {
    return "AI";
  }
  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase();
  }
  return words.slice(0, 2).map((word) => word[0]).join("").toUpperCase();
}

function formatProviderStatus(status: string): string {
  return {
    ready: "已连接",
    available: "已连接",
    disabled: "已禁用",
    no_models: "无模型",
    needs_key: "未就绪",
    unavailable: "不可用",
    not_configured: "未配置",
  }[status] ?? status;
}

function createSettingsSidebar(
  targetDocument: Document,
  pane: DesktopSettingsPaneModel,
  onSelectGroup?: (groupId: DesktopSettingsPaneGroup["id"]) => void,
  initialActiveGroupId: DesktopSettingsPaneGroup["id"] = pane.groups[0]?.id ?? "general",
): HTMLElement {
  const sidebar = targetDocument.createElement("aside");
  sidebar.className = "desktop-settings-sidebar";
  sidebar.setAttribute("aria-label", "Settings navigation");

  const search = targetDocument.createElement("input");
  search.className = "desktop-settings-search";
  search.setAttribute("type", "search");
  search.setAttribute("placeholder", "Search settings...");
  search.setAttribute("aria-label", "Search settings");
  sidebar.append(search);

  const nav = targetDocument.createElement("nav");
  nav.className = "desktop-settings-nav";
  nav.setAttribute("aria-label", "Settings sections");

  const personal = createText(targetDocument, "p", "Personal");
  personal.className = "desktop-settings-nav-heading";
  nav.append(personal);

  pane.groups.forEach((group, index) => {
    if (index === 3) {
      const system = createText(targetDocument, "p", "System");
      system.className = "desktop-settings-nav-heading";
      nav.append(system);
    }
    const item = targetDocument.createElement("a");
    item.className = "desktop-settings-nav-item";
    item.setAttribute("href", "#");
    item.setAttribute("data-desktop-settings-nav", group.id);
    item.addEventListener("click", (event) => {
      selectDesktopSettingsGroup(event, targetDocument, group.id, onSelectGroup);
    });
    if (group.id === initialActiveGroupId) {
      item.setAttribute("data-active", "true");
      item.setAttribute("aria-current", "page");
    }
    item.textContent = getSettingsNavLabel(group.id);
    nav.append(item);
  });

  sidebar.append(nav);
  return sidebar;
}

function selectDesktopSettingsGroup(
  event: Event,
  targetDocument: Document,
  groupId: DesktopSettingsPaneGroup["id"],
  onSelectGroup?: (groupId: DesktopSettingsPaneGroup["id"]) => void,
): void {
  event.preventDefault?.();
  setDesktopSettingsActiveNav(targetDocument, groupId);
  onSelectGroup?.(groupId);
}

function setDesktopSettingsActiveNav(targetDocument: Document, groupId: string): void {
  for (const item of targetDocument.querySelectorAll<HTMLElement>("[data-desktop-settings-nav]")) {
    const active = item.getAttribute("data-desktop-settings-nav") === groupId;
    if (active) {
      item.setAttribute("data-active", "true");
      item.setAttribute("aria-current", "page");
    } else {
      item.removeAttribute("data-active");
      item.removeAttribute("aria-current");
    }
  }
}

function getDesktopSettingsActiveGroup(
  pane: DesktopSettingsPaneModel,
  activeGroupId?: string | null,
): DesktopSettingsPaneGroup | null {
  return pane.groups.find((group) => group.id === activeGroupId) ?? pane.groups[0] ?? null;
}

function getCurrentDesktopSettingsActiveGroupId(
  pane: HTMLElement,
  nextSettingsPane: DesktopSettingsPaneModel,
): DesktopSettingsPaneGroup["id"] {
  const activeGroupId = Array.from(pane.ownerDocument.querySelectorAll<HTMLElement>("[data-desktop-settings-nav]"))
    .find((item) => item.getAttribute("data-active") === "true")
    ?.getAttribute("data-desktop-settings-nav");
  return getDesktopSettingsActiveGroup(nextSettingsPane, activeGroupId)?.id ?? nextSettingsPane.groups[0]?.id ?? "general";
}

function getSettingsNavLabel(groupId: DesktopSettingsPaneModel["groups"][number]["id"]): string {
  return {
    general: "General",
    "provider-models": "Provider & Models",
    knowledge: "Knowledge",
    "tools-approvals": "Tools & Approvals",
    "files-workspace": "Files & Workspace",
    "memory-experience": "Memory & Experience",
    skills: "Skills",
    channels: "Channels",
    automations: "Automations",
    "gateway-runtime": "Gateway & Runtime",
    "logs-diagnostics": "Logs & Diagnostics",
  }[groupId];
}

function getSettingsGroupDescription(groupId: DesktopSettingsPaneModel["groups"][number]["id"]): string {
  return {
    general: "Default model, profile, and timezone used by the desktop workbench.",
    "provider-models": "Provider profile, endpoint, and model catalog for chat and agent runs.",
    knowledge: "Retrieval behavior for workspace knowledge and RAG context.",
    "tools-approvals": "Browser, command execution, approval policy, and MCP server access.",
    "files-workspace": "Session files, Knowledge documents, and editable workspace file boundaries.",
    "memory-experience": "Memory and experience controls for contextual continuity.",
    skills: "Skill availability and loading policy.",
    channels: "Streaming and retry behavior for desktop channels.",
    automations: "Automation and scheduling capabilities planned after core stability.",
    "gateway-runtime": "Local gateway connection, heartbeat, and runtime controls.",
    "logs-diagnostics": "Runtime logs, diagnostics export, and local state recovery.",
  }[groupId];
}

function getSettingsFieldDescription(
  groupId: DesktopSettingsPaneModel["groups"][number]["id"],
  fieldId: string,
  value: string,
): string {
  const descriptions: Record<string, string> = {
    "general.model": "Model used for default chat and agent responses.",
    "general.provider": "Provider routing for the selected model.",
    "general.activeProfile": "Named provider profile with credentials and endpoint settings.",
    "general.timezone": "Timezone used for timestamps, reminders, and scheduled work.",
    "provider-models.selectedProvider": "Provider catalog entry edited by this profile.",
    "provider-models.profileId": "Stable profile name saved in desktop configuration.",
    "provider-models.apiBase": "OpenAI-compatible endpoint for this provider.",
    "provider-models.models": "One model id per line; refresh can discover supported models.",
    "knowledge.enabled": "Enable retrieval from indexed workspace knowledge.",
    "knowledge.retrievalMode": "Retrieval strategy used when knowledge context is requested.",
    "knowledge.maxChunks": "Maximum number of chunks injected into context.",
    "knowledge.rerankApiBase": "Endpoint used when reranking is enabled.",
    "tools-approvals.webEnable": "Allow browser and web search tools.",
    "tools-approvals.execEnable": "Allow local command execution from agent workflows.",
    "tools-approvals.mcpServers": "JSON object of MCP server definitions.",
    "gateway-runtime.host": "Host interface where the desktop gateway listens.",
    "gateway-runtime.port": "Port used by the local gateway endpoint.",
    "gateway-runtime.heartbeat": "Keep the desktop gateway connection fresh.",
    "channels.sendProgress": "Stream progress events into the desktop session.",
    "channels.sendToolHints": "Show tool status hints during agent work.",
    "channels.sendMaxRetries": "Retry count for channel delivery failures.",
  };
  return descriptions[`${groupId}.${fieldId}`] ?? `Current value: ${value || "Not configured"}.`;
}

function createDesktopSettingsFieldRow(
  targetDocument: Document,
  pane: DesktopSettingsPaneModel,
  group: DesktopSettingsPaneGroup,
  field: DesktopSettingsPaneField,
  settingsActions: DesktopSettingsActionOptions,
): HTMLElement {
  const row = targetDocument.createElement("div");
  row.className = "desktop-settings-field";
  row.setAttribute("data-desktop-settings-field", field.id);
  row.setAttribute("data-state", field.state);
  const copy = targetDocument.createElement("div");
  copy.className = "desktop-settings-field-copy";
  const label = targetDocument.createElement("label");
  label.textContent = `${field.label}: `;
  label.setAttribute("for", `desktop-settings-${field.id}`);
  const help = createText(targetDocument, "span", getSettingsFieldDescription(group.id, field.id, field.value));
  help.className = "desktop-settings-field-description";
  copy.append(label, help, createDesktopSettingsFieldMeta(targetDocument, field));
  if (field.notice) {
    const notice = createText(targetDocument, "span", field.notice);
    notice.className = "desktop-settings-field-notice";
    notice.setAttribute("data-desktop-settings-field-notice", field.id);
    copy.append(notice);
  }
  row.append(copy, createDesktopSettingsControl(targetDocument, pane, field, settingsActions));
  return row;
}

function createDesktopSettingsFieldMeta(targetDocument: Document, field: DesktopSettingsPaneField): HTMLElement {
  const meta = targetDocument.createElement("span");
  meta.className = "desktop-settings-field-meta";
  const requirement = createText(targetDocument, "span", desktopSettingsRequirementLabel(field.requirement));
  requirement.className = "desktop-settings-field-chip";
  requirement.setAttribute("data-kind", field.requirement);
  const mode = createText(targetDocument, "span", desktopSettingsConfigurationModeLabel(field.configurationMode));
  mode.className = "desktop-settings-field-chip";
  mode.setAttribute("data-kind", field.configurationMode);
  meta.append(requirement, mode);
  return meta;
}

function createDesktopSettingsControl(
  targetDocument: Document,
  pane: DesktopSettingsPaneModel,
  field: DesktopSettingsPaneModel["groups"][number]["fields"][number],
  settingsActions: DesktopSettingsActionOptions,
): HTMLElement {
  if (field.control === "readonly") {
    const output = targetDocument.createElement("output");
    output.className = "desktop-settings-readonly-value";
    output.setAttribute("id", `desktop-settings-${field.id}`);
    output.textContent = field.value || "Not configured";
    return output;
  }
  const tagName = field.control === "textarea" ? "textarea" : field.control === "select" ? "select" : "input";
  const control = targetDocument.createElement(tagName);
  control.setAttribute("id", `desktop-settings-${field.id}`);
  control.setAttribute("data-desktop-settings-control", field.id);
  control.setAttribute("data-state", field.state);
  if (field.state === "invalid") {
    control.setAttribute("aria-invalid", "true");
  }
  if (field.placeholder) {
    control.setAttribute("placeholder", field.placeholder);
  }
  if (field.min !== undefined) {
    control.setAttribute("min", String(field.min));
  }
  if (field.max !== undefined) {
    control.setAttribute("max", String(field.max));
  }
  if (field.step !== undefined) {
    control.setAttribute("step", String(field.step));
  }

  if (field.control === "checkbox") {
    const checked = Boolean(field.checked);
    const button = targetDocument.createElement("button");
    button.className = "desktop-settings-switch";
    button.setAttribute("id", `desktop-settings-${field.id}`);
    button.setAttribute("type", "button");
    button.setAttribute("role", "switch");
    button.setAttribute("aria-checked", checked ? "true" : "false");
    button.setAttribute("aria-label", `${field.label}: ${checked ? "On" : "Off"}`);
    button.setAttribute("data-desktop-settings-control", field.id);
    button.setAttribute("data-state", checked ? "on" : "off");
    button.setAttribute("data-commit-mode", field.commitMode ?? "manual");
    if (field.disabled) {
      button.setAttribute("disabled", "true");
    }
    const track = targetDocument.createElement("span");
    track.className = "desktop-settings-switch-track";
    track.setAttribute("aria-hidden", "true");
    const thumb = targetDocument.createElement("span");
    thumb.className = "desktop-settings-switch-thumb";
    track.append(thumb);
    const text = createText(targetDocument, "span", checked ? "On" : "Off");
    text.className = "desktop-settings-switch-text";
    button.append(track, text);
    button.addEventListener("click", () => {
      const nextChecked = !checked;
      if (!confirmDesktopSettingsSwitchChange(field, nextChecked)) {
        return;
      }
      settingsActions.onSettingsAction?.({
        action: "edit",
        pane,
        fieldId: field.id,
        value: nextChecked,
        commitMode: field.commitMode,
      });
    });
    return button;
  }

  if (field.control === "number") {
    (control as HTMLInputElement).type = "number";
  } else if (field.control === "password") {
    (control as HTMLInputElement).type = "password";
  } else if (field.control === "text") {
    (control as HTMLInputElement).type = "text";
  }

  if (field.control === "select") {
    for (const option of field.options ?? []) {
      const element = targetDocument.createElement("option");
      element.setAttribute("value", option.value);
      element.textContent = option.label;
      if (option.value === field.inputValue) {
        element.setAttribute("selected", "true");
      }
      control.append(element);
    }
    (control as HTMLSelectElement).value = field.inputValue;
  } else {
    (control as HTMLInputElement | HTMLTextAreaElement).value = field.inputValue;
  }

  const eventName = field.control === "select" ? "change" : "input";
  control.addEventListener(eventName, (event) => {
    settingsActions.onSettingsAction?.({
      action: "edit",
      pane,
      fieldId: field.id,
      value: String((event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null)?.value ?? ""),
    });
  });
  return control;
}

function confirmDesktopSettingsSwitchChange(field: DesktopSettingsPaneField, nextChecked: boolean): boolean {
  const confirmation = field.confirmation;
  if (!confirmation) {
    return true;
  }
  const matchesDirection = confirmation.when === "change"
    || (confirmation.when === "enable" && nextChecked)
    || (confirmation.when === "disable" && !nextChecked);
  if (!matchesDirection) {
    return true;
  }
  const confirm = globalThis.confirm;
  return typeof confirm === "function" ? confirm(confirmation.message) : true;
}

function desktopSettingsRequirementLabel(requirement: DesktopSettingsPaneField["requirement"]): string {
  return {
    required: "Required",
    optional: "Optional",
    readonly: "Read only",
  }[requirement];
}

function desktopSettingsConfigurationModeLabel(mode: DesktopSettingsPaneField["configurationMode"]): string {
  return {
    fixed: "Fixed options",
    freeform: "Free text",
    json: "JSON object",
    list: "List",
    numeric: "Number",
    readonly: "Status",
    secret: "Secret",
    toggle: "Toggle",
    url: "URL",
  }[mode];
}

function toggleDesktopPanel(targetDocument: Document, panel: DesktopPanelControlId): void {
  const shell = targetDocument.getElementById(SHELL_ID);
  const panelElement = targetDocument.querySelector<HTMLElement>(`[data-workbench-region="${panel}"]`);
  const stateAttribute = `data-${panel}-visible`;
  const currentValue = shell?.getAttribute(stateAttribute) ?? panelElement?.getAttribute("data-visible") ?? "true";
  logDesktopNativeDebug("shell.panel.toggle", {
    currentVisible: currentValue !== "false",
    nextVisible: currentValue === "false",
    panel,
  });
  setDesktopPanelVisible(targetDocument, panel, currentValue === "false");
}

function installDesktopPanelFrameEventBridge(targetDocument: Document): void {
  if (desktopPanelFrameEventDocuments.has(targetDocument)) {
    return;
  }
  desktopPanelFrameEventDocuments.add(targetDocument);
  targetDocument.addEventListener("tinybot:desktop-panel-toggle", (event) => {
    const panel = (event as CustomEvent<{ panel?: unknown }>).detail?.panel;
    if (panel !== "sidebar" && panel !== "inspector") {
      return;
    }
    toggleDesktopPanel(targetDocument, panel);
  });
}

function setDesktopPanelVisible(targetDocument: Document, panel: DesktopPanelControlId, nextVisible: boolean): void {
  const shell = targetDocument.getElementById(SHELL_ID);
  const panelElement = targetDocument.querySelector<HTMLElement>(`[data-workbench-region="${panel}"]`);
  if (panel === "inspector" && nextVisible && panelElement) {
    const inspectorContent = panelElement.querySelector<HTMLElement>(".desktop-inspector-content");
    if (inspectorContent && !hasInspectorContent(inspectorContent)) {
      nextVisible = false;
    }
  }
  const stateAttribute = `data-${panel}-visible`;
  shell?.setAttribute(stateAttribute, String(nextVisible));
  panelElement?.setAttribute("data-visible", String(nextVisible));
  for (const control of targetDocument.querySelectorAll<HTMLElement>(`[data-desktop-panel-control="${panel}"]`)) {
    control.setAttribute("aria-pressed", String(nextVisible));
    const label = control.getAttribute(nextVisible ? "data-desktop-panel-label-pressed" : "data-desktop-panel-label-unpressed");
    if (label) {
      control.setAttribute("aria-label", label);
      control.setAttribute("title", label);
    }
  }

  const status = targetDocument.querySelector<HTMLElement>("[data-desktop-route-status]");
  if (status) {
    status.textContent = `${formatPanelName(panel)} panel ${nextVisible ? "shown" : "hidden"}`;
  }
  logDesktopNativeDebug("shell.panel.visible", {
    nextVisible,
    panel,
  });
}

function formatPanelName(panel: DesktopPanelControlId): string {
  if (panel === "inspector") {
    return "Activity inspector";
  }
  if (panel === "bottom") {
    return "Task and runtime";
  }
  return panel[0].toUpperCase() + panel.slice(1);
}

function createCommandPalette(targetDocument: Document): HTMLElement {
  const palette = targetDocument.createElement("section");
  if (canMountVueIsland(palette)) {
    mountCommandPaletteIsland(palette);
    return palette;
  }

  palette.id = "desktop-command-palette";
  palette.className = "desktop-command-palette";
  palette.setAttribute("role", "dialog");
  palette.setAttribute("aria-modal", "false");
  palette.setAttribute("aria-label", "Command palette");
  palette.hidden = true;

  const header = targetDocument.createElement("div");
  header.className = "desktop-command-palette-header";
  header.append(createText(targetDocument, "h2", "Command Palette"));

  const close = targetDocument.createElement("button");
  close.id = "desktop-command-palette-close";
  close.type = "button";
  close.className = "desktop-command-palette-close";
  close.setAttribute("aria-label", "Close command palette");
  close.textContent = "Close";
  header.append(close);

  const input = targetDocument.createElement("input");
  input.id = "desktop-command-palette-input";
  input.className = "desktop-command-palette-input";
  input.setAttribute("type", "search");
  input.setAttribute("aria-label", "Search commands and workbench data");
  input.setAttribute("placeholder", "Search commands, sessions, files, knowledge, tools, skills, Cowork");

  const results = targetDocument.createElement("div");
  results.id = "desktop-command-palette-results";
  results.className = "desktop-command-palette-results";
  results.setAttribute("aria-live", "polite");

  const status = targetDocument.createElement("p");
  status.id = "desktop-command-palette-status";
  status.className = "desktop-command-palette-status";
  status.textContent = "Type to search.";

  palette.append(header, input, results, status);
  return palette;
}

function createInspector(
  targetDocument: Document,
  runChainItems: DesktopRunChainItem[] = [],
  taskCenterItems: DesktopTaskCenterItem[] = [],
  selectedRunChainItemKey: string | null = null,
  workLens: DesktopWorkLensProjection | null = null,
  workLensActions: DesktopWorkLensActionOptions = {},
): HTMLElement {
  const inspector = targetDocument.createElement("aside");
  inspector.className = "desktop-inspector-content";
  const hasRunChainOverview = runChainItems.length > 0 || taskCenterItems.length > 0;
  if (hasRunChainOverview) {
    inspector.append(createRunChainOverviewPanel(targetDocument, runChainItems, taskCenterItems));
  }
  if (workLens) {
    inspector.append(createWorkLensPane(targetDocument, workLens, workLensActions));
  } else if (runChainItems.length) {
    inspector.append(createRunChainInspectorPane(targetDocument, runChainItems, selectedRunChainItemKey));
  }
  if (hasInspectorContent(inspector)) {
    mountInspectorRegionVueIsland(inspector, targetDocument, runChainItems, taskCenterItems, selectedRunChainItemKey, workLens, workLensActions);
  }
  return inspector;
}

function hasInspectorContent(inspector: HTMLElement): boolean {
  return inspector.children.length > 0;
}

function mountInspectorRegionVueIsland(
  inspector: HTMLElement,
  targetDocument: Document,
  runChainItems: DesktopRunChainItem[],
  taskCenterItems: DesktopTaskCenterItem[],
  selectedRunChainItemKey: string | null,
  workLens: DesktopWorkLensProjection | null,
  workLensActions: DesktopWorkLensActionOptions,
): void {
  if (!canMountVueIsland(inspector)) {
    return;
  }
  mountInspectorRegionIsland(inspector, {
    runChainItems,
    taskItems: taskCenterItems,
    selectedRunChainItemKey,
    workLens,
    onRunChainAction: (action) => {
      if (action.type === "close") {
        setDesktopPanelVisible(targetDocument, "inspector", false);
      } else if (action.type === "pin") {
        setRouteStatus(targetDocument, action.value ? "Activity inspector pinned" : "Activity inspector unpinned");
      } else if (action.type === "tab" || action.type === "summary") {
        setRouteStatus(targetDocument, `Activity ${action.label}`);
      } else if (action.type === "open-task-center") {
        toggleDesktopPanel(targetDocument, "bottom");
      } else if (action.type === "new-item") {
        setRouteStatus(targetDocument, "Open Cowork to create an activity item.");
      } else if (action.type === "feed") {
        setRouteStatus(targetDocument, `Selected ${action.title}`);
      }
    },
    onRunChainItemSelected: (item) => {
      setRouteStatus(targetDocument, `Inspecting ${item.title}`);
    },
    onWorkLensAction: ({ action }) => {
      if (workLens) {
        workLensActions.onWorkLensAction?.({ action, workLens });
      }
    },
    copyText: workLensActions.copyText,
  });
}

type RunChainOverviewTab = "context" | "files" | "tasks" | "approvals" | "activity";

function createRunChainOverviewPanel(
  targetDocument: Document,
  runChainItems: DesktopRunChainItem[] = [],
  taskCenterItems: DesktopTaskCenterItem[] = [],
  initialTab: RunChainOverviewTab = "context",
): HTMLElement {
  const section = targetDocument.createElement("section");
  section.className = "desktop-run-chain-overview";
  section.setAttribute("aria-label", "Activity inspector");

  const header = targetDocument.createElement("header");
  header.className = "desktop-run-chain-header";
  header.append(createText(targetDocument, "h2", "Activity"));
  const controls = targetDocument.createElement("div");
  controls.className = "desktop-run-chain-header-controls";
  for (const [label, value, action] of [
    ["Pin panel", "Pin", "pin"],
    ["Close panel", "Close", "close"],
  ]) {
    const button = targetDocument.createElement("button");
    button.type = "button";
    button.className = "desktop-run-chain-icon-button";
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
    button.setAttribute("data-desktop-run-chain-control", action);
    button.setAttribute("data-button-variant", "ghost");
    if (action === "pin") {
      button.setAttribute("aria-pressed", "false");
    }
    button.textContent = value;
    button.addEventListener("click", () => {
      if (action === "close") {
        setDesktopPanelVisible(targetDocument, "inspector", false);
        return;
      }
      const nextPressed = button.getAttribute("aria-pressed") !== "true";
      button.setAttribute("aria-pressed", String(nextPressed));
      button.textContent = nextPressed ? "Pinned" : "Pin";
      setRouteStatus(targetDocument, nextPressed ? "Activity inspector pinned" : "Activity inspector unpinned");
    });
    controls.append(button);
  }
  header.append(controls);

  const panel = targetDocument.createElement("div");
  panel.className = "desktop-run-chain-panel desktop-run-chain-cards";
  panel.setAttribute("data-desktop-run-chain-panel", "context");

  const tabs = targetDocument.createElement("div");
  tabs.className = "desktop-run-chain-tabs";
  tabs.setAttribute("role", "tablist");
  const renderPanel = (tabId: RunChainOverviewTab): void => {
    panel.setAttribute("data-desktop-run-chain-panel", tabId);
    panel.replaceChildren(...createRunChainOverviewPanelContent(targetDocument, tabId, runChainItems, taskCenterItems));
  };
  const selectTab = (tabId: RunChainOverviewTab): void => {
    for (const sibling of Array.from(tabs.children)) {
      sibling.setAttribute("aria-selected", String(sibling.getAttribute("data-desktop-run-chain-tab") === tabId));
    }
    renderPanel(tabId);
  };

  for (const [index, tabInfo] of ([
    { id: "context", label: "Context" },
    { id: "files", label: "Files" },
    { id: "tasks", label: "Tasks" },
    { id: "approvals", label: "Approvals" },
    { id: "activity", label: "Activity" },
  ] as Array<{ id: RunChainOverviewTab; label: string }>).entries()) {
    const tab = targetDocument.createElement("button");
    tab.type = "button";
    tab.className = "desktop-run-chain-tab";
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(index === 0));
    tab.setAttribute("data-desktop-run-chain-tab", tabInfo.id);
    tab.textContent = tabInfo.label;
    tab.addEventListener("click", () => {
      selectTab(tabInfo.id);
      setRouteStatus(targetDocument, `Activity ${tabInfo.label}`);
    });
    tabs.append(tab);
  }

  const summary = createRunChainSummaryStrip(targetDocument, runChainItems, taskCenterItems, selectTab);
  selectTab(initialTab);

  const actions = targetDocument.createElement("div");
  actions.className = "desktop-run-chain-actions";
  actions.append(
    createRunChainActionButton(targetDocument, "Open Task Center", () => toggleDesktopPanel(targetDocument, "bottom"), "desktop-run-chain-panel-action", "primary"),
  );

  section.append(header, summary, tabs, panel, actions);
  mountRunChainOverviewVueIsland(section, targetDocument, runChainItems, taskCenterItems, initialTab);
  return section;
}

function refreshRunChainOverviewFromTaskCenter(
  targetDocument: Document,
  liveState: DesktopWorkbenchLiveState,
): void {
  const current = targetDocument.querySelector<HTMLElement>(".desktop-run-chain-overview");
  const shouldRenderOverview = liveState.runChainItems.length > 0 || liveState.taskCenterItems.length > 0;
  if (!shouldRenderOverview) {
    current?.remove();
    const inspectorContent = targetDocument.querySelector<HTMLElement>(".desktop-inspector-content");
    if (inspectorContent && !hasInspectorContent(inspectorContent)) {
      setDesktopPanelVisible(targetDocument, "inspector", false);
    }
    return;
  }
  if (!current) {
    const inspectorContent = targetDocument.querySelector<HTMLElement>(".desktop-inspector-content");
    if (!inspectorContent) {
      return;
    }
    inspectorContent.append(createRunChainOverviewPanel(targetDocument, liveState.runChainItems, liveState.taskCenterItems));
    return;
  }
  const selectedTab = currentRunChainOverviewTab(current);
  const next = createRunChainOverviewPanel(targetDocument, liveState.runChainItems, liveState.taskCenterItems, selectedTab);
  if (typeof current.replaceWith === "function") {
    current.replaceWith(next);
    return;
  }
  current.replaceChildren(...Array.from(next.children));
}

function currentRunChainOverviewTab(overview: HTMLElement): RunChainOverviewTab {
  const panelTab = overview.querySelector<HTMLElement>(".desktop-run-chain-panel")?.getAttribute("data-desktop-run-chain-panel");
  if (isRunChainOverviewTab(panelTab)) {
    return panelTab;
  }
  const selectedTab = overview.querySelector<HTMLElement>('[data-desktop-run-chain-tab][aria-selected="true"]')?.getAttribute("data-desktop-run-chain-tab");
  if (isRunChainOverviewTab(selectedTab)) {
    return selectedTab;
  }
  return "context";
}

function isRunChainOverviewTab(value: string | null | undefined): value is RunChainOverviewTab {
  return value === "context" || value === "files" || value === "tasks" || value === "approvals" || value === "activity";
}

function createRunChainSummaryStrip(
  targetDocument: Document,
  runChainItems: DesktopRunChainItem[],
  taskCenterItems: DesktopTaskCenterItem[],
  selectTab: (tabId: RunChainOverviewTab) => void,
): HTMLElement {
  const summary = targetDocument.createElement("div");
  summary.className = "desktop-run-chain-summary-strip";
  const status = runChainOverviewStatus(runChainItems);
  const approvalCount = pendingApprovalItems(taskCenterItems).length;
  for (const item of [
    { label: "Gateway", text: "Gateway", accessibleText: "Gateway: Connected", tab: "context" as const, tone: "connected" },
    { label: "Run", text: status, accessibleText: `Run: ${status}`, tab: "activity" as const, tone: "muted" },
    { label: "Items", text: `${runChainItems.length} ${runChainItems.length === 1 ? "item" : "items"}`, accessibleText: `Items: ${runChainItems.length}`, tab: "activity" as const, tone: "muted" },
    { label: "Approvals", text: `${approvalCount} ${approvalCount === 1 ? "approval" : "approvals"}`, accessibleText: `Approvals: ${approvalCount}`, tab: "approvals" as const, tone: approvalCount ? "attention" : "muted" },
  ]) {
    const button = targetDocument.createElement("button");
    button.type = "button";
    button.className = "desktop-run-chain-summary-item desktop-run-chain-status-pill";
    button.setAttribute("data-desktop-run-chain-summary", item.label.toLowerCase());
    button.setAttribute("data-status-tone", item.tone);
    button.setAttribute("aria-label", item.accessibleText);
    button.setAttribute("title", item.accessibleText);
    if (item.tone === "connected") {
      const dot = targetDocument.createElement("span");
      dot.className = "desktop-run-chain-status-dot";
      dot.setAttribute("aria-hidden", "true");
      button.append(dot);
    }
    button.append(createText(targetDocument, "span", item.text));
    button.addEventListener("click", () => {
      selectTab(item.tab);
      setRouteStatus(targetDocument, `Activity ${item.label}`);
    });
    summary.append(button);
  }
  return summary;
}

function createRunChainOverviewPanelContent(
  targetDocument: Document,
  tabId: RunChainOverviewTab,
  runChainItems: DesktopRunChainItem[],
  taskCenterItems: DesktopTaskCenterItem[],
): HTMLElement[] {
  if (tabId === "files") {
    return [
      createRunChainPanelSection(targetDocument, "Files", [
        ["Project", "tinybot"],
        ["Path", "D:\\code\\tinybot\\tinybot"],
      ], createWorkbenchLink(targetDocument, "Open Files", "/files", "desktop-run-chain-panel-action")),
    ];
  }

  if (tabId === "tasks") {
    return [
      createRunChainPanelSection(targetDocument, "Tasks", [
        ["Task center", "Available"],
        ["Run", runChainOverviewStatus(runChainItems)],
        ["Chain items", String(runChainItems.length)],
      ], createRunChainActionButton(targetDocument, "New Activity Item", () => {
        setRouteStatus(targetDocument, "Open Cowork to create an activity item.");
      }, "desktop-run-chain-panel-action desktop-run-chain-new-item", "secondary"), runChainItems.length ? undefined : "No chain items yet."),
    ];
  }

  if (tabId === "approvals") {
    const approvals = pendingApprovalItems(taskCenterItems);
    return [
      createRunChainPanelSection(targetDocument, "Approvals", [
        ["Pending", String(approvals.length)],
        ["Policy", "Ask before sensitive actions"],
        ["Queue", approvals.length ? `${approvals.length} pending ${approvals.length === 1 ? "approval" : "approvals"}` : "No pending approvals"],
      ], createRunChainActionButton(targetDocument, "Open Task Center", () => toggleDesktopPanel(targetDocument, "bottom"), "desktop-run-chain-panel-action", "secondary"), approvals.length ? undefined : "No pending approvals"),
      ...createRunChainApprovalQueue(targetDocument, approvals),
    ];
  }

  if (tabId === "activity") {
    const feed = createRunChainActivityFeed(targetDocument, runChainItems);
    return [
      createRunChainPanelSection(targetDocument, "Activity Feed", [
        ["Status", runChainOverviewStatus(runChainItems)],
        ["Events", String(runChainItems.length)],
      ], undefined, runChainItems.length ? undefined : "Gateway events, tool calls, and runtime logs appear here."),
      ...(feed ? [feed] : []),
    ];
  }

  return [
    createRunChainPanelSection(targetDocument, "Gateway", [
      ["Status", "Connected"],
      ["Endpoint", "http://127.0.0.1:18790"],
      ["Mode", "External"],
      ["Version", "v0.1.0"],
    ], createWorkbenchLink(targetDocument, "Open Gateway Status", "/api/status", "desktop-run-chain-panel-action")),
    createRunChainPanelSection(targetDocument, "Session Context", [
      ["Run", runChainOverviewStatus(runChainItems)],
      ["Items", String(runChainItems.length)],
    ]),
  ];
}

function createRunChainPanelSection(
  targetDocument: Document,
  title: string,
  rows: [string, string][],
  action?: HTMLElement,
  emptyState?: string,
): HTMLElement {
  const section = targetDocument.createElement("section");
  section.className = "desktop-run-chain-panel-section";
  section.append(createText(targetDocument, "h3", title));
  for (const [label, value] of rows) {
    const row = targetDocument.createElement("p");
    row.className = "desktop-run-chain-card-row";
    row.textContent = `${label}: ${value}`;
    section.append(row);
  }
  if (emptyState) {
    const empty = targetDocument.createElement("p");
    empty.className = "desktop-run-chain-empty-state";
    empty.textContent = emptyState;
    section.append(empty);
  }
  if (action) {
    section.append(action);
  }
  return section;
}

function createRunChainApprovalQueue(
  targetDocument: Document,
  approvals: DesktopTaskCenterItem[],
): HTMLElement[] {
  if (!approvals.length) {
    return [];
  }
  const section = targetDocument.createElement("section");
  section.className = "desktop-run-chain-panel-section desktop-run-chain-approval-list";
  section.append(createText(targetDocument, "h3", "Approval Queue"));
  for (const item of approvals.slice(0, 4)) {
    const row = targetDocument.createElement("button");
    row.type = "button";
    row.className = "desktop-run-chain-approval-item";
    row.setAttribute("data-desktop-run-chain-approval-item", item.id);
    row.setAttribute("data-status-tone", item.tone);
    const title = targetDocument.createElement("span");
    title.className = "desktop-run-chain-approval-title";
    title.textContent = item.title;
    row.append(title);
    if (item.detail) {
      const detail = targetDocument.createElement("span");
      detail.className = "desktop-run-chain-approval-detail";
      detail.textContent = item.detail;
      row.append(detail);
    }
    row.addEventListener("click", () => {
      toggleDesktopPanel(targetDocument, "bottom");
    });
    section.append(row);
  }
  return [section];
}

function createRunChainActivityFeed(
  targetDocument: Document,
  runChainItems: DesktopRunChainItem[],
): HTMLElement | null {
  if (!runChainItems.length) {
    return null;
  }
  const section = targetDocument.createElement("section");
  section.className = "desktop-run-chain-panel-section desktop-run-chain-activity-feed";
  section.append(createText(targetDocument, "h3", "Activity"));
  for (const item of runChainItems.slice(0, 4)) {
    const row = targetDocument.createElement("button");
    row.type = "button";
    row.className = "desktop-run-chain-feed-item";
    row.setAttribute("data-desktop-run-chain-feed-item", item.key);
    row.textContent = `${item.title}: ${item.preview}`;
    row.addEventListener("click", () => {
      setRouteStatus(targetDocument, `Selected ${item.title}`);
    });
    section.append(row);
  }
  return section;
}

function createRunChainActionButton(
  targetDocument: Document,
  label: string,
  onClick: () => void,
  className = "desktop-run-chain-panel-action",
  variant: "primary" | "secondary" | "ghost" = "secondary",
): HTMLElement {
  const button = targetDocument.createElement("button");
  button.type = "button";
  button.className = className;
  button.setAttribute("data-desktop-run-chain-action", label);
  button.setAttribute("data-button-variant", variant);
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function runChainOverviewStatus(runChainItems: DesktopRunChainItem[]): string {
  if (runChainItems.some((item) => item.status === "failed")) {
    return "Needs attention";
  }
  if (runChainItems.some((item) => item.status === "running")) {
    return "Running";
  }
  return runChainItems.length ? "Completed" : "Idle";
}

function pendingApprovalItems(items: DesktopTaskCenterItem[]): DesktopTaskCenterItem[] {
  return items.filter((item) => item.source === "approval" && item.state !== "completed" && item.state !== "canceled");
}

function mountRunChainOverviewVueIsland(
  section: HTMLElement,
  targetDocument: Document,
  runChainItems: DesktopRunChainItem[],
  taskCenterItems: DesktopTaskCenterItem[],
  initialTab: RunChainOverviewTab,
): void {
  if (!canMountVueIsland(section)) {
    return;
  }
  mountRunChainOverviewIsland(section, {
    items: runChainItems,
    taskItems: taskCenterItems,
    initialTab,
    onAction: (action) => {
      if (action.type === "close") {
        setDesktopPanelVisible(targetDocument, "inspector", false);
      } else if (action.type === "pin") {
        setRouteStatus(targetDocument, action.value ? "Activity inspector pinned" : "Activity inspector unpinned");
      } else if (action.type === "tab" || action.type === "summary") {
        setRouteStatus(targetDocument, `Activity ${action.label}`);
      } else if (action.type === "open-task-center") {
        toggleDesktopPanel(targetDocument, "bottom");
      } else if (action.type === "new-item") {
        setRouteStatus(targetDocument, "Open Cowork to create an activity item.");
      } else if (action.type === "feed") {
        setRouteStatus(targetDocument, `Selected ${action.title}`);
      }
    },
  });
}

function createWorkLensPane(
  targetDocument: Document,
  workLens: DesktopWorkLensProjection,
  workLensActions: DesktopWorkLensActionOptions,
  placement: "inspector" | "inline" = "inspector",
): HTMLElement {
  const section = targetDocument.createElement("section");
  section.className = "desktop-workbench-section desktop-work-lens";
  section.setAttribute("aria-label", "Work Lens");
  section.setAttribute("data-desktop-work-lens-mode", workLens.mode);
  section.setAttribute("data-desktop-work-lens-kind", workLens.kind);
  section.setAttribute("data-desktop-work-lens-id", workLens.id);
  section.setAttribute("data-desktop-work-lens-placement", placement);
  if (workLens.fallbackReason) {
    section.setAttribute("data-desktop-work-lens-fallback-reason", workLens.fallbackReason);
  }
  section.append(createText(targetDocument, "h2", "Work Lens"));
  section.append(createText(targetDocument, "p", workLens.title));

  if (workLens.fallbackReason) {
    const fallback = createText(targetDocument, "p", workLens.fallbackReason);
    fallback.setAttribute("data-desktop-work-lens-fallback", workLens.fallbackReason);
    fallback.setAttribute("aria-label", `Work Lens fallback: ${workLens.fallbackReason}`);
    section.append(fallback);
  }

  for (const lensSection of workLens.sections) {
    const group = targetDocument.createElement("section");
    group.className = "desktop-work-lens-section";
    group.setAttribute("data-desktop-work-lens-section", lensSection.id);
    group.setAttribute("aria-label", `Work Lens section: ${lensSection.id}`);
    group.append(createText(targetDocument, "h2", lensSection.title));
    for (const row of lensSection.rows) {
      group.append(createText(targetDocument, "p", `${row.label}: ${row.value}`));
    }
    section.append(group);
  }

  if (workLens.relatedResources.length) {
    section.append(createWorkLensResourceList(targetDocument, "Related resources", workLens.relatedResources));
  }
  if (workLens.outputs.length) {
    section.append(createWorkLensResourceList(targetDocument, "Outputs", workLens.outputs));
  }

  if (workLens.nextActions.length) {
    const actions = targetDocument.createElement("div");
    actions.className = "desktop-work-lens-actions";
    actions.setAttribute("aria-label", `${workLens.title} next actions`);
    for (const action of workLens.nextActions) {
      const element = action.route?.href
        ? createWorkbenchLink(targetDocument, action.label, action.route.href, "desktop-work-lens-action")
        : targetDocument.createElement("button");
      element.setAttribute("data-desktop-work-lens-action", action.id);
      element.setAttribute("aria-label", `Work Lens action: ${action.id} ${workLens.title}`);
      if (!action.route?.href) {
        element.className = "desktop-work-lens-action";
        element.setAttribute("type", "button");
        element.textContent = action.label;
        element.addEventListener("click", (event) => {
          event.preventDefault?.();
          workLensActions.onWorkLensAction?.({ action: action.id, workLens });
          if (action.id === "copyDiagnostics" && action.diagnosticText) {
            void copyTaskDiagnostics(action.diagnosticText, workLensActions.copyText);
          }
        });
      }
      actions.append(element);
    }
    section.append(actions);
  }

  mountWorkLensVueIsland(section, workLens, workLensActions, placement);
  return section;
}

function mountWorkLensVueIsland(
  section: HTMLElement,
  workLens: DesktopWorkLensProjection,
  workLensActions: DesktopWorkLensActionOptions,
  placement: "inspector" | "inline",
): void {
  if (!canMountVueIsland(section)) {
    return;
  }
  mountWorkLensIsland(section, {
    workLens,
    placement,
    onAction: ({ action }) => {
      workLensActions.onWorkLensAction?.({ action, workLens });
    },
    copyText: workLensActions.copyText,
  });
}

function createWorkLensResourceList(
  targetDocument: Document,
  title: string,
  resources: DesktopWorkLensRelatedResource[],
): HTMLElement {
  const list = targetDocument.createElement("section");
  list.className = "desktop-work-lens-resources";
  list.append(createText(targetDocument, "h2", title));
  for (const resource of resources) {
    const element = resource.route.href
      ? createWorkbenchLink(targetDocument, `${resource.title}: ${resource.detail}`.replace(/: $/, ""), resource.route.href, "desktop-work-lens-resource")
      : targetDocument.createElement("button");
    element.setAttribute("data-desktop-work-lens-resource", resource.id);
    element.setAttribute("data-desktop-work-lens-resource-kind", resource.kind);
    element.setAttribute("aria-label", `Work Lens resource: ${resource.kind} ${resource.title}`);
    if (!resource.route.href) {
      element.className = "desktop-work-lens-resource";
      element.setAttribute("type", "button");
      element.textContent = `${resource.title}: ${resource.detail}`.replace(/: $/, "");
    }
    list.append(element);
  }
  return list;
}

function createRunChainInspectorPane(
  targetDocument: Document,
  runChainItems: DesktopRunChainItem[],
  selectedRunChainItemKey: string | null,
): HTMLElement {
  const section = targetDocument.createElement("section");
  section.className = "desktop-workbench-section desktop-run-chain-inspector";
  section.setAttribute("aria-label", "Run-chain inspector");
  section.append(createText(targetDocument, "h2", "Run-chain inspector"));
  section.append(createText(targetDocument, "p", buildDesktopRunChainSummary(runChainItems)));

  const list = targetDocument.createElement("div");
  list.className = "desktop-run-chain-list";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Run-chain items");

  const detail = targetDocument.createElement("section");
  detail.className = "desktop-run-chain-detail";

  const selectedItem = runChainItems.find((item) => item.key === selectedRunChainItemKey && item.inspectable)
    ?? runChainItems.find((item) => item.inspectable)
    ?? runChainItems[0];

  const renderSelectedDetail = (item: DesktopRunChainItem): void => {
    for (const row of Array.from(list.children)) {
      row.setAttribute("aria-selected", row.getAttribute("data-desktop-run-chain-item") === item.key ? "true" : "false");
    }
    detail.replaceChildren(renderInspectorView(targetDocument, createDesktopRunChainInspectorView(item)));
    setRouteStatus(targetDocument, `Inspecting ${item.title}`);
  };

  for (const item of runChainItems) {
    const row = targetDocument.createElement("button");
    row.type = "button";
    row.className = "desktop-run-chain-item";
    row.setAttribute("role", "option");
    row.setAttribute("data-desktop-run-chain-item", item.key);
    row.setAttribute("data-desktop-run-chain-kind", item.kind);
    row.setAttribute("aria-selected", item.key === selectedItem.key ? "true" : "false");
    row.textContent = `${item.title}: ${item.preview}`;
    row.addEventListener("click", () => {
      renderSelectedDetail(item);
    });
    list.append(row);
  }

  detail.append(renderInspectorView(targetDocument, createDesktopRunChainInspectorView(selectedItem)));
  section.append(list, detail);
  mountRunChainInspectorVueIsland(section, targetDocument, runChainItems, selectedItem.key);
  return section;
}

function mountRunChainInspectorVueIsland(
  section: HTMLElement,
  targetDocument: Document,
  items: DesktopRunChainItem[],
  selectedItemKey: string,
): void {
  if (!canMountVueIsland(section)) {
    return;
  }
  mountRunChainInspectorIsland(section, {
    eventTarget: targetDocument,
    items,
    selectedItemKey,
    onSelect: (item) => setRouteStatus(targetDocument, `Inspecting ${item.title}`),
  });
}

function createBottomRegion(
  targetDocument: Document,
  runtimeStatus: GatewayRuntimeStatus | null,
  gatewayHttp: string,
  taskCenterItems: DesktopTaskCenterItem[],
  taskActions: DesktopTaskCenterActionOptions,
  gatewayActions: DesktopGatewayRuntimeActionOptions,
): HTMLElement {
  const bottom = targetDocument.createElement("section");
  bottom.className = "desktop-bottom-content";
  bottom.append(
    createTaskCenterSurface(targetDocument, taskCenterItems, taskActions),
    createGatewayRuntimeSurface(targetDocument, runtimeStatus, gatewayHttp, gatewayActions),
  );
  mountBottomRegionVueIsland(bottom, targetDocument, runtimeStatus, gatewayHttp, taskCenterItems, taskActions, gatewayActions);
  return bottom;
}

function mountBottomRegionVueIsland(
  bottom: HTMLElement,
  targetDocument: Document,
  runtimeStatus: GatewayRuntimeStatus | null,
  gatewayHttp: string,
  taskCenterItems: DesktopTaskCenterItem[],
  taskActions: DesktopTaskCenterActionOptions,
  gatewayActions: DesktopGatewayRuntimeActionOptions,
): void {
  if (!canMountVueIsland(bottom)) {
    return;
  }
  mountBottomRegionIsland(bottom, {
    gatewayHttp,
    gatewayStatus: runtimeStatus,
    taskItems: taskCenterItems,
    onGatewayAction: ({ action }) => {
      handleGatewayRuntimeActionId(targetDocument, runtimeStatus, gatewayHttp, gatewayActions, action);
    },
    onTaskAction: ({ action, item }) => {
      handleTaskActionId(targetDocument, item, action, taskCenterItems, taskActions);
    },
  });
}

function createGatewayRuntimeSurface(
  targetDocument: Document,
  runtimeStatus: GatewayRuntimeStatus | null,
  gatewayHttp: string,
  gatewayActions: DesktopGatewayRuntimeActionOptions,
): HTMLElement {
  const section = targetDocument.createElement("section");
  section.className = "desktop-workbench-section desktop-gateway-runtime";
  section.setAttribute("aria-label", "Gateway runtime controls");
  section.append(createText(targetDocument, "h2", "Runtime"));
  for (const row of buildDesktopGatewayRuntimeRows(runtimeStatus, gatewayHttp)) {
    const element = targetDocument.createElement("p");
    element.className = "desktop-gateway-runtime-row";
    element.setAttribute("data-desktop-gateway-runtime-row", row.label);
    element.textContent = `${row.label}: ${row.value}`;
    section.append(element);
  }
  const actions = targetDocument.createElement("div");
  actions.className = "desktop-gateway-actions";
  actions.setAttribute("aria-label", "Gateway runtime actions");
  for (const action of buildDesktopGatewayRuntimeActions(runtimeStatus)) {
    const button = targetDocument.createElement("button");
    button.type = "button";
    button.className = "desktop-gateway-action";
    button.setAttribute("data-desktop-gateway-action", action.id);
    button.textContent = action.label;
    button.addEventListener("click", (event) => {
      handleGatewayRuntimeAction(targetDocument, runtimeStatus, gatewayHttp, gatewayActions, action.id, event);
    });
    actions.append(button);
  }
  section.append(actions);
  mountGatewayRuntimeVueIsland(section, targetDocument, runtimeStatus, gatewayHttp, gatewayActions);
  return section;
}

function mountGatewayRuntimeVueIsland(
  section: HTMLElement,
  targetDocument: Document,
  runtimeStatus: GatewayRuntimeStatus | null,
  gatewayHttp: string,
  gatewayActions: DesktopGatewayRuntimeActionOptions,
): void {
  if (!canMountVueIsland(section)) {
    return;
  }
  mountGatewayRuntimeIsland(section, {
    gatewayHttp,
    status: runtimeStatus,
    onAction: ({ action }) => {
      handleGatewayRuntimeActionId(targetDocument, runtimeStatus, gatewayHttp, gatewayActions, action);
    },
  });
}

function handleGatewayRuntimeAction(
  targetDocument: Document,
  runtimeStatus: GatewayRuntimeStatus | null,
  gatewayHttp: string,
  gatewayActions: DesktopGatewayRuntimeActionOptions,
  action: DesktopGatewayRuntimeActionId,
  event: Event,
): void {
  event.preventDefault?.();
  handleGatewayRuntimeActionId(targetDocument, runtimeStatus, gatewayHttp, gatewayActions, action);
}

function handleGatewayRuntimeActionId(
  targetDocument: Document,
  runtimeStatus: GatewayRuntimeStatus | null,
  gatewayHttp: string,
  gatewayActions: DesktopGatewayRuntimeActionOptions,
  action: DesktopGatewayRuntimeActionId,
): void {
  const diagnostics = buildDesktopGatewayRuntimeDiagnostics(runtimeStatus, gatewayHttp);
  if (action === "copyDiagnostics") {
    void copyGatewayRuntimeDiagnostics(diagnostics, gatewayActions.copyText);
    setRouteStatus(targetDocument, "Copied gateway diagnostics");
    return;
  }
  if (action === "openLogs") {
    renderGatewayRuntimeLogs(targetDocument, runtimeStatus, gatewayHttp);
    setRouteStatus(targetDocument, "Opened gateway logs");
    return;
  }
  gatewayActions.onGatewayRuntimeAction?.({ action, status: runtimeStatus, diagnostics });
}

function canMountVueIsland(element: HTMLElement): boolean {
  return typeof HTMLElement !== "undefined" && element instanceof HTMLElement;
}

function inspectRunChainItemFromConversation(targetDocument: Document, itemKey: string): void {
  const shell = targetDocument.getElementById(SHELL_ID);
  if (shell?.getAttribute("data-inspector-visible") === "false") {
    toggleDesktopPanel(targetDocument, "inspector");
  }
  const row = targetDocument.querySelector<HTMLElement>(`[data-desktop-run-chain-item="${itemKey}"]`);
  row?.click();
}

function dispatchDesktopCustomEvent(targetDocument: Document, type: string, detail: Record<string, unknown>): void {
  const CustomEventConstructor = targetDocument.defaultView?.CustomEvent
    ?? (typeof CustomEvent !== "undefined" ? CustomEvent : null);
  if (CustomEventConstructor) {
    targetDocument.dispatchEvent(new CustomEventConstructor(type, { detail }));
    return;
  }
  targetDocument.dispatchEvent({ type, detail } as unknown as Event);
}

async function copyDesktopText(text: string, targetDocument: Document): Promise<void> {
  const clipboard = targetDocument.defaultView?.navigator?.clipboard
    ?? (typeof navigator !== "undefined" ? navigator.clipboard : undefined);
  if (!clipboard?.writeText) {
    throw new Error("Clipboard is unavailable.");
  }
  return clipboard.writeText(text);
}

async function copyGatewayRuntimeDiagnostics(text: string, copyText?: (text: string) => void | Promise<void>): Promise<void> {
  if (copyText) {
    await copyText(text);
    return;
  }
  await navigator.clipboard?.writeText(text);
}

function renderGatewayRuntimeLogs(
  targetDocument: Document,
  runtimeStatus: GatewayRuntimeStatus | null,
  gatewayHttp: string,
): void {
  const inspector = targetDocument.querySelector<HTMLElement>('[data-workbench-region="inspector"]');
  if (!inspector) {
    return;
  }
  inspector.replaceChildren(renderInspectorView(targetDocument, {
    title: "Gateway Logs",
    subtitle: runtimeStatus?.gateway_http || gatewayHttp,
    emptyText: "",
    sections: [
      {
        type: "text",
        label: "Logs",
        text: (runtimeStatus?.logs ?? []).length ? (runtimeStatus?.logs ?? []).slice(-12).join("\n") : "No recent logs.",
      },
      ...(runtimeStatus?.last_error ? [{ type: "text" as const, label: "Last error", text: runtimeStatus.last_error }] : []),
    ],
  }));
}

function createTaskCenterSurface(
  targetDocument: Document,
  items: DesktopTaskCenterItem[],
  taskActions: DesktopTaskCenterActionOptions,
): HTMLElement {
  const section = targetDocument.createElement("section");
  section.id = "desktop-task-center";
  section.className = "desktop-task-center";
  section.setAttribute("aria-label", "Background task center");
  section.append(createText(targetDocument, "h2", "Task Center"));

  const summary = targetDocument.createElement("p");
  summary.className = "desktop-task-center-summary";
  summary.textContent = taskCenterSummary(items);
  section.append(summary);

  const list = targetDocument.createElement("div");
  list.className = "desktop-task-center-list";
  list.setAttribute("role", "list");
  list.setAttribute("aria-live", "polite");

  if (!items.length) {
    const empty = targetDocument.createElement("p");
    empty.className = "desktop-task-center-empty";
    empty.textContent = "No background tasks.";
    list.append(empty);
  }

  for (const item of items) {
    list.append(createTaskCenterItem(targetDocument, item, items, taskActions));
  }

  section.append(list);
  mountTaskCenterVueIsland(section, targetDocument, items, taskActions);
  return section;
}

function mountTaskCenterVueIsland(
  section: HTMLElement,
  targetDocument: Document,
  items: DesktopTaskCenterItem[],
  taskActions: DesktopTaskCenterActionOptions,
): void {
  if (!canMountVueIsland(section)) {
    return;
  }
  mountTaskCenterIsland(section, {
    items,
    onAction: ({ action, item }) => {
      handleTaskActionId(targetDocument, item, action, items, taskActions);
    },
  });
}

function createTaskCenterItem(
  targetDocument: Document,
  item: DesktopTaskCenterItem,
  items: DesktopTaskCenterItem[],
  taskActions: DesktopTaskCenterActionOptions,
): HTMLElement {
  const row = targetDocument.createElement("article");
  row.className = "desktop-task-center-item";
  row.setAttribute("role", "listitem");
  row.setAttribute("data-desktop-task-id", item.id);
  row.setAttribute("data-desktop-task-source", item.source);
  row.setAttribute("data-desktop-task-state", item.state);
  row.setAttribute("data-desktop-task-tone", item.tone);

  const heading = targetDocument.createElement("div");
  heading.className = "desktop-task-center-item-heading";
  heading.append(createText(targetDocument, "h2", item.title), createTaskStateBadge(targetDocument, item));

  const detail = targetDocument.createElement("p");
  detail.className = "desktop-task-center-detail";
  detail.textContent = [formatTaskSource(item.source), item.detail, item.progressLabel].filter(Boolean).join(" - ");

  const diagnostics = targetDocument.createElement("p");
  diagnostics.className = "desktop-task-center-diagnostics";
  diagnostics.textContent = item.diagnostics;

  const actions = targetDocument.createElement("div");
  actions.className = "desktop-task-center-actions";
  actions.setAttribute("aria-label", `${item.title} actions`);
  for (const action of item.actions) {
    actions.append(createTaskAction(targetDocument, item, action, items, taskActions));
  }

  row.append(heading, detail);
  if (item.diagnostics) {
    row.append(diagnostics);
  }
  row.append(actions);
  return row;
}

function createTaskStateBadge(targetDocument: Document, item: DesktopTaskCenterItem): HTMLElement {
  const badge = targetDocument.createElement("span");
  badge.className = "desktop-task-state-badge";
  badge.setAttribute("data-desktop-task-state-badge", item.state);
  badge.textContent = item.state;
  mountTaskStateBadgeVueIsland(badge, item.state);
  return badge;
}

function mountTaskStateBadgeVueIsland(badge: HTMLElement, state: string): void {
  if (!canMountVueIsland(badge)) {
    return;
  }
  mountTaskStateBadgeIsland(badge, { state });
}

function createTaskAction(
  targetDocument: Document,
  item: DesktopTaskCenterItem,
  action: DesktopTaskCenterAction,
  items: DesktopTaskCenterItem[],
  taskActions: DesktopTaskCenterActionOptions,
): HTMLElement {
  const href = item.destination.href ?? `/${item.destination.module}`;
  const element =
    action.id === "open"
      ? createWorkbenchLink(targetDocument, action.label, href, "desktop-task-action")
      : targetDocument.createElement("button");
  element.setAttribute("data-desktop-task-action", action.id);
  element.setAttribute("data-desktop-task-id", item.id);
  element.setAttribute("data-desktop-task-source", item.source);
  if (action.id !== "open") {
    element.setAttribute("type", "button");
    element.className = "desktop-task-action";
    element.textContent = action.label;
    element.addEventListener("click", (event) => {
      handleTaskAction(targetDocument, item, action.id, items, taskActions, event);
    });
  }
  mountTaskActionVueIsland(element, {
    action: action.id,
    href,
    itemId: item.id,
    itemSource: item.source,
    label: action.label,
  });
  return element;
}

function mountTaskActionVueIsland(
  element: HTMLElement,
  options: {
    action: DesktopTaskActionId;
    href: string;
    itemId: string;
    itemSource: DesktopTaskSource;
    label: string;
  },
): void {
  if (!canMountVueIsland(element)) {
    return;
  }
  mountTaskActionIsland(element, options);
}

function handleTaskAction(
  targetDocument: Document,
  item: DesktopTaskCenterItem,
  action: DesktopTaskActionId,
  items: DesktopTaskCenterItem[],
  taskActions: DesktopTaskCenterActionOptions,
  event: Event,
): void {
  event.preventDefault?.();
  handleTaskActionId(targetDocument, item, action, items, taskActions);
}

function handleTaskActionId(
  targetDocument: Document,
  item: DesktopTaskCenterItem,
  action: DesktopTaskActionId,
  items: DesktopTaskCenterItem[],
  taskActions: DesktopTaskCenterActionOptions,
): void {
  if (!item.actions.some((candidate) => candidate.id === action)) {
    return;
  }
  taskActions.onTaskAction?.({ action, item });
  if (action === "inspect") {
    const renderedWorkLens = renderTaskWorkLens(targetDocument, item);
    setRouteStatus(targetDocument, renderedWorkLens ? `Inspecting ${item.title} in Work Lens` : `Inspecting ${item.title}`);
  } else if (action === "copyDiagnostics" && item.diagnostics) {
    void copyTaskDiagnostics(item.diagnostics, taskActions.copyText);
    setRouteStatus(targetDocument, `Copied diagnostics for ${item.title}`);
  } else if (action === "dismiss") {
    updateDesktopTaskCenterItems(targetDocument, items.filter((candidate) => candidate.id !== item.id), taskActions);
    setRouteStatus(targetDocument, `Dismissed ${item.title}`);
  } else if (action === "retry") {
    setRouteStatus(targetDocument, `Retry requested for ${item.title}`);
  } else if (action === "cancel") {
    setRouteStatus(targetDocument, `Cancel requested for ${item.title}`);
  } else if (action === "approveOnce") {
    setRouteStatus(targetDocument, `Approval granted once for ${item.title}`);
  } else if (action === "approveSession") {
    setRouteStatus(targetDocument, `Approval granted for this session for ${item.title}`);
  } else if (action === "deny") {
    setRouteStatus(targetDocument, `Approval denied for ${item.title}`);
  }
}

function renderTaskInspector(targetDocument: Document, item: DesktopTaskCenterItem): void {
  const inspector = targetDocument.querySelector<HTMLElement>('[data-workbench-region="inspector"]');
  if (!inspector) {
    return;
  }
  inspector.replaceChildren(renderInspectorView(targetDocument, {
    title: item.title,
    subtitle: `${formatTaskSource(item.source)} / ${item.state}`,
    emptyText: "",
    sections: [
      { type: "text", label: "Status", text: item.status },
      { type: "text", label: "Detail", text: item.detail || "No detail." },
      { type: "text", label: "Destination", text: [item.destination.module, item.destination.entityId, item.destination.href].filter(Boolean).join(" / ") },
      ...(item.diagnostics ? [{ type: "text" as const, label: "Diagnostics", text: item.diagnostics }] : []),
    ],
  }));
}

function renderTaskWorkLens(targetDocument: Document, item: DesktopTaskCenterItem): boolean {
  ensureDesktopPanelVisible(targetDocument, "inspector");
  return renderWorkLensProjection(targetDocument, buildDesktopWorkLensProjection({ task: item }), item);
}

function ensureDesktopPanelVisible(targetDocument: Document, panel: DesktopPanelControlId): void {
  const shell = targetDocument.getElementById(SHELL_ID);
  const panelElement = targetDocument.querySelector<HTMLElement>(`[data-workbench-region="${panel}"]`);
  const stateAttribute = `data-${panel}-visible`;
  const currentValue = shell?.getAttribute(stateAttribute) ?? panelElement?.getAttribute("data-visible") ?? "true";
  if (currentValue !== "false") {
    return;
  }
  setDesktopPanelVisible(targetDocument, panel, true);
}

function refreshVisibleWorkLensFromTaskCenter(targetDocument: Document, items: DesktopTaskCenterItem[]): void {
  const current = targetDocument.querySelector<HTMLElement>(".desktop-work-lens");
  const currentId = current?.getAttribute("data-desktop-work-lens-id") ?? "";
  if (!current || !currentId) {
    return;
  }
  const nextItem = items.find((item) => item.id === currentId);
  if (nextItem) {
    renderTaskWorkLens(targetDocument, nextItem);
    return;
  }
  renderWorkLensProjection(targetDocument, buildDesktopWorkLensProjection({ fallbackReason: "missing-context" }));
}

function renderWorkLensProjection(
  targetDocument: Document,
  projection: DesktopWorkLensProjection,
  fallbackItem?: DesktopTaskCenterItem,
): boolean {
  const inspector = targetDocument.querySelector<HTMLElement>('[data-workbench-region="inspector"]');
  const inlineHost = targetDocument.getElementById(WORK_LENS_INLINE_ID);
  if (!inspector && !inlineHost) {
    return false;
  }
  const inspectorVisible = inspector?.getAttribute("data-visible") !== "false";
  if (projection.mode !== "ready") {
    if (projection.fallbackReason === "missing-context") {
      renderProjectionInVisibleWorkLensTarget(targetDocument, projection, inspector, inlineHost);
      return false;
    }
    if (inspector && inspectorVisible && fallbackItem) {
      renderTaskInspector(targetDocument, fallbackItem);
    }
    return false;
  }
  return renderProjectionInVisibleWorkLensTarget(targetDocument, projection, inspector, inlineHost);
}

function renderProjectionInVisibleWorkLensTarget(
  targetDocument: Document,
  projection: DesktopWorkLensProjection,
  inspector: HTMLElement | null,
  inlineHost: HTMLElement | null,
): boolean {
  const inspectorVisible = inspector?.getAttribute("data-visible") !== "false";
  if (inspector && inspectorVisible) {
    inlineHost?.replaceChildren();
    inspector.replaceChildren(createWorkLensPane(targetDocument, projection, {}, "inspector"));
    return true;
  }
  if (inlineHost) {
    inlineHost.replaceChildren(createWorkLensPane(targetDocument, projection, {}, "inline"));
    return true;
  }
  return true;
}

async function copyTaskDiagnostics(text: string, copyText?: (text: string) => void | Promise<void>): Promise<void> {
  if (copyText) {
    await copyText(text);
    return;
  }
  await navigator.clipboard?.writeText(text);
}

function setRouteStatus(targetDocument: Document, message: string): void {
  const status = targetDocument.querySelector<HTMLElement>("[data-desktop-route-status]");
  if (status) {
    status.textContent = message;
  }
}

function taskCenterSummary(items: DesktopTaskCenterItem[]): string {
  if (!items.length) {
    return "0 tasks";
  }
  const active = items.filter((item) => item.state === "active").length;
  const blocked = items.filter((item) => item.state === "blocked").length;
  const failed = items.filter((item) => item.state === "failed").length;
  return `${items.length} tasks - ${active} active - ${blocked} blocked - ${failed} failed`;
}

function formatTaskSource(source: DesktopTaskCenterItem["source"]): string {
  if (source === "cowork") {
    return "Cowork";
  }
  return source[0].toUpperCase() + source.slice(1);
}

function createPanel(
  targetDocument: Document,
  region: WorkbenchPanelId,
  state: WorkbenchPanelState,
  content: HTMLElement,
): HTMLElement {
  const panel = targetDocument.createElement(region === "bottom" ? "section" : "aside");
  panel.className = `desktop-workbench-${region}`;
  panel.setAttribute("data-workbench-region", region);
  panel.setAttribute("data-visible", String(state.visible));
  panel.style.setProperty("--region-size", `${state.size}px`);
  panel.append(content);
  mountWorkbenchPanelVueIsland(panel, region, state, content);
  if (region === "sidebar") {
    panel.append(createSidebarResizer(targetDocument, state.size));
  }
  return panel;
}

function createSidebarResizer(targetDocument: Document, initialSize: number): HTMLElement {
  const handle = targetDocument.createElement("div");
  handle.className = "desktop-workbench-sidebar-resizer";
  handle.setAttribute("data-desktop-sidebar-resizer", "");
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-label", "Resize sidebar");
  handle.setAttribute("aria-orientation", "vertical");
  handle.setAttribute("aria-valuemin", String(DESKTOP_SIDEBAR_MIN_SIZE));
  handle.setAttribute("aria-valuemax", String(DESKTOP_SIDEBAR_MAX_SIZE));
  handle.setAttribute("aria-valuenow", String(clampDesktopSidebarSize(initialSize)));
  handle.setAttribute("tabindex", "0");

  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    handle.setAttribute("data-dragging", "true");
    handle.setPointerCapture?.(event.pointerId);
    const startX = event.clientX;
    const startSize = currentDesktopSidebarSize(targetDocument);
    const onPointerMove = (moveEvent: PointerEvent) => {
      moveEvent.preventDefault();
      const requestedSize = startSize + moveEvent.clientX - startX;
      if (requestedSize <= DESKTOP_SIDEBAR_MIN_SIZE - DESKTOP_SIDEBAR_COLLAPSE_OVERSHOOT) {
        applyDesktopSidebarSize(targetDocument, DESKTOP_SIDEBAR_MIN_SIZE);
        setDesktopPanelVisible(targetDocument, "sidebar", false);
        return;
      }
      setDesktopPanelVisible(targetDocument, "sidebar", true);
      applyDesktopSidebarSize(targetDocument, requestedSize);
    };
    const stopDrag = (upEvent: PointerEvent) => {
      handle.removeAttribute("data-dragging");
      handle.releasePointerCapture?.(upEvent.pointerId);
      targetDocument.removeEventListener("pointermove", onPointerMove);
      targetDocument.removeEventListener("pointerup", stopDrag);
      targetDocument.removeEventListener("pointercancel", stopDrag);
    };
    targetDocument.addEventListener("pointermove", onPointerMove);
    targetDocument.addEventListener("pointerup", stopDrag);
    targetDocument.addEventListener("pointercancel", stopDrag);
  });

  handle.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }
    event.preventDefault();
    const direction = event.key === "ArrowLeft" ? -1 : 1;
    setDesktopPanelVisible(targetDocument, "sidebar", true);
    applyDesktopSidebarSize(targetDocument, currentDesktopSidebarSize(targetDocument) + direction * 12);
  });

  return handle;
}

function currentDesktopSidebarSize(targetDocument: Document): number {
  const shell = targetDocument.getElementById(SHELL_ID);
  const panel = targetDocument.querySelector<HTMLElement>('[data-workbench-region="sidebar"]');
  const rawSize = shell?.style.getPropertyValue("--desktop-sidebar-size") || panel?.style.getPropertyValue("--region-size") || "";
  const parsed = Number.parseFloat(rawSize);
  return clampDesktopSidebarSize(Number.isFinite(parsed) ? parsed : 260);
}

function applyDesktopSidebarSize(targetDocument: Document, requestedSize: number): void {
  const nextSize = clampDesktopSidebarSize(requestedSize);
  const shell = targetDocument.getElementById(SHELL_ID);
  const panel = targetDocument.querySelector<HTMLElement>('[data-workbench-region="sidebar"]');
  const handle = targetDocument.querySelector<HTMLElement>("[data-desktop-sidebar-resizer]");
  shell?.style.setProperty("--desktop-sidebar-size", `${nextSize}px`);
  panel?.style.setProperty("--region-size", `${nextSize}px`);
  handle?.setAttribute("aria-valuenow", String(nextSize));
}

function clampDesktopSidebarSize(size: number): number {
  return Math.min(DESKTOP_SIDEBAR_MAX_SIZE, Math.max(DESKTOP_SIDEBAR_MIN_SIZE, Math.round(size)));
}

function mountWorkbenchPanelVueIsland(
  panel: HTMLElement,
  region: WorkbenchPanelId,
  state: WorkbenchPanelState,
  content: HTMLElement,
): void {
  if (!canMountVueIsland(panel)) {
    return;
  }
  mountWorkbenchPanelIsland(panel, {
    content,
    region,
    size: state.size,
    visible: state.visible,
  });
}

function createFileActions(targetDocument: Document, chat: DesktopNativeChatModel | null = null): HTMLElement {
  const section = targetDocument.createElement("section");
  section.className = "desktop-file-actions";
  section.setAttribute("data-desktop-module-surface", "chat attachments");
  section.append(createText(targetDocument, "h2", "Session attachments"));

  const sessionKey = targetDocument.createElement("input");
  sessionKey.setAttribute("id", "desktop-session-upload-key");
  sessionKey.setAttribute("class", "desktop-session-upload-key");
  sessionKey.setAttribute("aria-label", "Session key for temporary file upload");
  sessionKey.setAttribute("placeholder", "Session key");
  if (chat?.activeSessionKey) {
    sessionKey.value = chat.activeSessionKey;
    sessionKey.setAttribute("readonly", "");
    sessionKey.setAttribute("data-active-session-key", chat.activeSessionKey);
  }

  const session = createFileImportCard(targetDocument, {
    id: "desktop-session-file-upload",
    label: "Attach to session",
    uploadKind: "session-temporary-file",
    dropTarget: "session-temporary-file",
    formatsId: "desktop-file-session-formats",
    formats: ["md", "txt", "pdf", "docx", "csv", "json", "png", "jpg"],
  });

  const sessionCard = targetDocument.createElement("div");
  sessionCard.className = "desktop-file-session-card";
  const sessionLabel = targetDocument.createElement("label");
  sessionLabel.setAttribute("for", "desktop-session-upload-key");
  sessionLabel.textContent = "Session key";
  const sessionMeta = targetDocument.createElement("div");
  sessionMeta.className = "desktop-file-session-meta";
  const sessionCount = targetDocument.createElement("span");
  sessionCount.setAttribute("id", "desktop-session-file-count");
  sessionCount.className = "desktop-file-count-pill";
  sessionCount.textContent = "0";
  const sessionRefresh = targetDocument.createElement("button");
  sessionRefresh.setAttribute("id", "desktop-session-files-refresh");
  sessionRefresh.setAttribute("type", "button");
  sessionRefresh.setAttribute("class", "desktop-file-refresh");
  sessionRefresh.setAttribute("data-desktop-session-files-refresh", "true");
  sessionRefresh.textContent = "Refresh";
  sessionMeta.append(createText(targetDocument, "span", "Temporary files"), sessionCount, sessionRefresh);
  sessionCard.append(sessionLabel, sessionKey, sessionMeta);
  mountSessionUploadCardVueIsland(sessionCard, chat?.activeSessionKey ?? null);

  const status = targetDocument.createElement("p");
  status.setAttribute("id", "desktop-file-upload-status");
  status.setAttribute("class", "desktop-file-upload-status");
  status.textContent = "No file operation running.";
  mountFileUploadStatusVueIsland(status, "No file operation running.");

  const sessionFiles = targetDocument.createElement("div");
  sessionFiles.setAttribute("id", "desktop-session-file-list");
  sessionFiles.setAttribute("class", "desktop-session-file-list");
  sessionFiles.setAttribute("aria-label", "Session temporary files");
  sessionFiles.textContent = chat?.activeSessionKey ? "Temporary files not loaded yet." : "Select a chat session to view temporary files.";
  mountSessionFileListVueIsland(sessionFiles, chat?.activeSessionKey ?? "");

  const grid = targetDocument.createElement("div");
  grid.className = "desktop-file-import-grid";
  grid.append(session, sessionCard);

  const operationStrip = targetDocument.createElement("div");
  operationStrip.className = "desktop-file-operation-strip";
  operationStrip.append(
    createFileOperationStatus(targetDocument, "Session upload", "Waiting"),
    status,
  );

  section.append(grid, operationStrip, sessionFiles);
  mountFileActionsSurfaceVueIsland(section, chat?.activeSessionKey ?? null);
  return section;
}

function mountFileActionsSurfaceVueIsland(section: HTMLElement, activeSessionKey: string | null): void {
  if (!canMountVueIsland(section)) {
    return;
  }
  mountFileActionsSurfaceIsland(section, { activeSessionKey });
}

function mountSessionUploadCardVueIsland(card: HTMLElement, activeSessionKey: string | null): void {
  if (!canMountVueIsland(card)) {
    return;
  }
  mountSessionUploadCardIsland(card, { activeSessionKey });
}

function createFileImportCard(
  targetDocument: Document,
  options: {
    id: string;
    label: string;
    uploadKind?: string;
    dropTarget: string;
    formatsId: string;
    formats: string[];
    href?: string;
  },
): HTMLElement {
  const control = options.href
    ? createWorkbenchLink(targetDocument, options.label, options.href, "desktop-file-action desktop-file-import-button")
    : targetDocument.createElement("button");
  control.setAttribute("id", options.id);
  control.setAttribute("class", "desktop-file-action desktop-file-import-button");
  control.setAttribute("data-desktop-drop-target", options.dropTarget);
  if (!options.href) {
    control.setAttribute("type", "button");
  }
  if (options.uploadKind) {
    control.setAttribute("data-desktop-file-upload", options.uploadKind);
  }
  control.append(
    createText(targetDocument, "span", options.label),
    createText(targetDocument, "small", "Drop files here or click to select"),
  );

  const card = targetDocument.createElement("div");
  card.className = "desktop-file-import-card";
  card.append(control, createFormatChipList(targetDocument, options.formatsId, options.formats));
  mountFileImportCardVueIsland(card, options);
  return card;
}

function mountFileImportCardVueIsland(
  card: HTMLElement,
  options: {
    id: string;
    label: string;
    uploadKind?: string;
    dropTarget: string;
    formatsId: string;
    formats: string[];
    href?: string;
  },
): void {
  if (!canMountVueIsland(card)) {
    return;
  }
  mountFileImportCardIsland(card, options);
}

function createFormatChipList(targetDocument: Document, id: string, formats: string[]): HTMLElement {
  const row = targetDocument.createElement("p");
  row.className = "desktop-file-format-row";
  row.setAttribute("id", id);
  row.append(createText(targetDocument, "span", "Formats:"));
  for (const format of formats) {
    const chip = targetDocument.createElement("span");
    chip.className = "desktop-file-format-chip";
    chip.textContent = format;
    row.append(chip);
  }
  mountFormatChipListVueIsland(row, id, formats);
  return row;
}

function mountFormatChipListVueIsland(row: HTMLElement, id: string, formats: string[]): void {
  if (!canMountVueIsland(row)) {
    return;
  }
  mountFormatChipListIsland(row, { id, formats });
}

function createFileOperationStatus(targetDocument: Document, label: string, status: string): HTMLElement {
  const item = targetDocument.createElement("div");
  item.className = "desktop-file-operation-status";
  item.append(createText(targetDocument, "span", label), createText(targetDocument, "strong", status));
  mountFileOperationStatusVueIsland(item, label, status);
  return item;
}

function mountFileOperationStatusVueIsland(item: HTMLElement, label: string, status: string): void {
  if (!canMountVueIsland(item)) {
    return;
  }
  mountFileOperationStatusIsland(item, { label, status });
}

function mountFileUploadStatusVueIsland(status: HTMLElement, message: string): void {
  if (!canMountVueIsland(status)) {
    return;
  }
  mountFileUploadStatusIsland(status, { message });
}

function mountSessionFileListVueIsland(sessionFiles: HTMLElement, sessionKey: string): void {
  if (!canMountVueIsland(sessionFiles)) {
    return;
  }
  mountOrUpdateSessionFileListIsland(sessionFiles, { sessionKey, rows: [] });
}

function syncSessionFileUploadKey(targetDocument: Document, activeSessionKey: string): void {
  const sessionKey = targetDocument.getElementById("desktop-session-upload-key") as HTMLInputElement | null;
  if (!sessionKey) {
    return;
  }
  sessionKey.value = activeSessionKey;
  sessionKey.setAttribute("readonly", "");
  sessionKey.setAttribute("data-active-session-key", activeSessionKey);
  targetDocument.dispatchEvent(new CustomEvent("tinybot:desktop-session-key-changed", { detail: { sessionKey: activeSessionKey } }));
}

function createDesktopHelpSurface(targetDocument: Document): HTMLElement {
  const section = targetDocument.createElement("section");
  section.className = "desktop-help-pane";
  section.setAttribute("data-desktop-module-surface", "docs");
  section.setAttribute("aria-label", "Desktop help");
  section.append(createText(targetDocument, "h2", "Help"));

  const docs = createWorkbenchLink(targetDocument, "Open docs", "/docs", "desktop-help-action");
  docs.setAttribute("data-desktop-help-action", "docs");

  const shortcuts = targetDocument.createElement("button");
  shortcuts.setAttribute("type", "button");
  shortcuts.className = "desktop-help-action";
  shortcuts.setAttribute("data-desktop-help-action", "shortcut-help");
  shortcuts.textContent = "Shortcut help";
  shortcuts.addEventListener("click", () => {
    renderDesktopShortcutHelp(targetDocument);
  });

  const pageHelp = targetDocument.createElement("button");
  pageHelp.setAttribute("type", "button");
  pageHelp.className = "desktop-help-action";
  pageHelp.setAttribute("data-desktop-help-action", "page-help");
  pageHelp.textContent = "Page help";
  pageHelp.addEventListener("click", () => {
    renderDesktopPageHelp(targetDocument, "Page help");
  });

  const tour = targetDocument.createElement("button");
  tour.setAttribute("type", "button");
  tour.className = "desktop-help-action";
  tour.setAttribute("data-desktop-help-action", "help-tour");
  tour.textContent = "Help tour";
  tour.addEventListener("click", () => {
    renderDesktopPageHelp(targetDocument, "Desktop help tour");
  });

  section.append(docs, shortcuts, pageHelp, tour);
  mountHelpSurfaceVueIsland(section, targetDocument);
  return section;
}

function mountHelpSurfaceVueIsland(section: HTMLElement, targetDocument: Document): void {
  if (!canMountVueIsland(section)) {
    return;
  }
  mountHelpSurfaceIsland(section, {
    onAction: (action) => {
      if (action === "shortcut-help") {
        renderDesktopShortcutHelp(targetDocument);
      } else if (action === "page-help") {
        renderDesktopPageHelp(targetDocument, "Page help");
      } else if (action === "help-tour") {
        renderDesktopPageHelp(targetDocument, "Desktop help tour");
      }
    },
  });
}

function installDesktopHelpEventRouting(targetDocument: Document): void {
  targetDocument.addEventListener("tinybot:open-shortcut-help", () => {
    renderDesktopShortcutHelp(targetDocument);
  });
  targetDocument.addEventListener("tinybot:open-page-help", () => {
    renderDesktopPageHelp(targetDocument, "Page help");
  });
  targetDocument.addEventListener("tinybot:open-backend-logs", () => {
    const snapshot = desktopRuntimeStatusSnapshots.get(targetDocument);
    renderDesktopBackendLogs(targetDocument, snapshot?.runtimeStatus ?? null, snapshot?.gatewayHttp ?? "");
  });
  targetDocument.addEventListener("tinybot:open-help-tour", () => {
    renderDesktopPageHelp(targetDocument, "Desktop help tour");
  });
}

function renderDesktopShortcutHelp(targetDocument: Document): void {
  const existing = targetDocument.getElementById("desktop-shortcut-help-dialog") as HTMLElement | null;
  if (existing) {
    existing.hidden = false;
    existing.querySelector<HTMLElement>(".desktop-shortcut-help-search")?.focus();
    setRouteStatus(targetDocument, "Opened shortcut help");
    return;
  }

  const dialog = targetDocument.createElement("section");
  if (canMountVueIsland(dialog)) {
    targetDocument.body.append(dialog);
    mountShortcutHelpDialogIsland(dialog, {
      groups: groupShortcutHelpItems().map(([title, items]) => ({ title, items })),
    });
    setRouteStatus(targetDocument, "Opened shortcut help");
    return;
  }

  dialog.id = "desktop-shortcut-help-dialog";
  dialog.setAttribute("id", "desktop-shortcut-help-dialog");
  dialog.className = "desktop-shortcut-help-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", "Keyboard shortcuts");

  const panel = targetDocument.createElement("div");
  panel.className = "desktop-shortcut-help-panel";

  const header = targetDocument.createElement("header");
  header.className = "desktop-shortcut-help-header";
  header.append(createText(targetDocument, "h2", "Keyboard shortcuts"));

  const close = targetDocument.createElement("button");
  close.type = "button";
  close.className = "desktop-shortcut-help-close";
  close.setAttribute("aria-label", "Close keyboard shortcuts");
  close.textContent = "x";
  close.addEventListener("click", () => {
    dialog.hidden = true;
  });
  header.append(close);

  const search = targetDocument.createElement("input");
  search.type = "search";
  search.className = "desktop-shortcut-help-search";
  search.setAttribute("aria-label", "Search shortcuts");
  search.setAttribute("placeholder", "Search shortcuts");

  const list = targetDocument.createElement("div");
  list.className = "desktop-shortcut-help-list";
  list.setAttribute("role", "list");
  renderShortcutHelpRows(targetDocument, list, "");

  search.addEventListener("input", () => {
    renderShortcutHelpRows(targetDocument, list, search.value);
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      dialog.hidden = true;
    }
  });

  panel.append(header, search, list);
  dialog.append(panel);
  targetDocument.body.append(dialog);
  search.focus();
  setRouteStatus(targetDocument, "Opened shortcut help");
}

function renderDesktopBackendLogs(
  targetDocument: Document,
  runtimeStatus: GatewayRuntimeStatus | null,
  gatewayHttp: string,
): void {
  const existing = targetDocument.getElementById("desktop-backend-logs-dialog") as HTMLElement | null;
  const logText = formatDesktopBackendLogs(runtimeStatus, gatewayHttp);
  if (existing) {
    existing.hidden = false;
    existing.replaceChildren(createDesktopBackendLogsPanel(targetDocument, existing, logText));
    existing.querySelector<HTMLElement>(".desktop-backend-logs-close")?.focus();
    setRouteStatus(targetDocument, "Opened backend logs");
    return;
  }

  const dialog = targetDocument.createElement("section");
  dialog.id = "desktop-backend-logs-dialog";
  dialog.setAttribute("id", "desktop-backend-logs-dialog");
  dialog.className = "desktop-shortcut-help-dialog desktop-backend-logs-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", "Backend logs");
  dialog.append(createDesktopBackendLogsPanel(targetDocument, dialog, logText));
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      dialog.hidden = true;
    }
  });
  targetDocument.body.append(dialog);
  dialog.querySelector<HTMLElement>(".desktop-backend-logs-close")?.focus();
  setRouteStatus(targetDocument, "Opened backend logs");
}

function createDesktopBackendLogsPanel(targetDocument: Document, dialog: HTMLElement, logText: string): HTMLElement {
  const panel = targetDocument.createElement("div");
  panel.className = "desktop-shortcut-help-panel desktop-backend-logs-panel";

  const header = targetDocument.createElement("header");
  header.className = "desktop-shortcut-help-header desktop-backend-logs-header";
  header.append(createText(targetDocument, "h2", "Backend Logs"));

  const actions = targetDocument.createElement("div");
  actions.className = "desktop-backend-logs-actions";

  const copy = targetDocument.createElement("button");
  copy.type = "button";
  copy.className = "desktop-backend-logs-copy";
  copy.textContent = "Copy";
  copy.addEventListener("click", () => {
    void copyDesktopText(logText, targetDocument)
      .then(() => setRouteStatus(targetDocument, "Copied backend logs"))
      .catch(() => setRouteStatus(targetDocument, "Backend log copy failed"));
  });

  const close = targetDocument.createElement("button");
  close.type = "button";
  close.className = "desktop-shortcut-help-close desktop-backend-logs-close";
  close.setAttribute("aria-label", "Close backend logs");
  close.textContent = "x";
  close.addEventListener("click", () => {
    dialog.hidden = true;
  });
  actions.append(copy, close);
  header.append(actions);

  const body = targetDocument.createElement("pre");
  body.className = "desktop-backend-logs-content";
  body.textContent = logText;

  panel.append(header, body);
  return panel;
}

function formatDesktopBackendLogs(runtimeStatus: GatewayRuntimeStatus | null, gatewayHttp: string): string {
  const runtimeLogs = runtimeStatus?.logs ?? [];
  const persistentLogTail = runtimeStatus?.log_tail ?? [];
  const workerDiagnostics = runtimeStatus?.worker_runtime?.diagnostics ?? [];
  return [
    `Gateway: ${runtimeStatus?.gateway_http || gatewayHttp || "unknown"}`,
    "Source: bounded in-memory runtime buffers + persistent log file tail",
    `Log file: ${runtimeStatus?.log_path || "not configured"}`,
    "",
    `Persistent log tail (${persistentLogTail.length})`,
    persistentLogTail.length ? persistentLogTail.join("\n") : "No persistent backend log lines.",
    "",
    `Gateway runtime logs (${runtimeLogs.length})`,
    runtimeLogs.length ? runtimeLogs.join("\n") : "No recent gateway logs.",
    "",
    `Worker diagnostics (${workerDiagnostics.length})`,
    workerDiagnostics.length
      ? workerDiagnostics.map((line) => `${line.stream}: ${line.line}`).join("\n")
      : "No recent worker diagnostics.",
  ].join("\n");
}

function renderShortcutHelpRows(targetDocument: Document, list: HTMLElement, query: string): void {
  const normalizedQuery = query.trim().toLowerCase();
  list.replaceChildren();
  for (const [group, items] of groupShortcutHelpItems()) {
    const visibleItems = items.filter((item) => {
      if (!normalizedQuery) {
        return true;
      }
      return `${item.command} ${item.key} ${item.description}`.toLowerCase().includes(normalizedQuery);
    });
    if (!visibleItems.length) {
      continue;
    }

    const section = targetDocument.createElement("section");
    section.className = "desktop-shortcut-help-group";
    section.append(createText(targetDocument, "h3", group));
    for (const item of visibleItems) {
      const row = targetDocument.createElement("div");
      row.className = "desktop-shortcut-help-row";
      row.setAttribute("role", "listitem");

      const label = targetDocument.createElement("span");
      label.className = "desktop-shortcut-help-command";
      label.textContent = item.command;

      const key = targetDocument.createElement("kbd");
      key.className = "desktop-shortcut-help-key";
      key.textContent = item.key;

      row.append(label, key);
      section.append(row);
    }
    list.append(section);
  }
}

function groupShortcutHelpItems(): Array<[string, typeof DESKTOP_SHORTCUT_HELP_ITEMS]> {
  return [
    ["Chat", DESKTOP_SHORTCUT_HELP_ITEMS.filter((item) => ["New chat", "Stop generation", "Search sessions"].includes(item.command))],
    [
      "Navigation",
      DESKTOP_SHORTCUT_HELP_ITEMS.filter((item) => ["Settings", "Documentation", "Command palette", "Gateway status"].includes(item.command)),
    ],
    [
      "Workbench",
      DESKTOP_SHORTCUT_HELP_ITEMS.filter((item) => ["Toggle sidebar", "Shortcut help", "Page help"].includes(item.command)),
    ],
  ];
}

function renderDesktopPageHelp(targetDocument: Document, title: string): void {
  const inspector = targetDocument.querySelector<HTMLElement>('[data-workbench-region="inspector"]');
  if (!inspector) {
    return;
  }
  const targets = buildDesktopPageHelpText(resolveDesktopVisibleHelpTargets(targetDocument));
  inspector.replaceChildren(renderInspectorView(targetDocument, {
    title,
    subtitle: "Desktop workbench regions",
    emptyText: "",
    sections: targets.length
      ? targets.map((row) => ({ type: "text" as const, label: "Target", text: row }))
      : [{ type: "text" as const, label: "Target", text: "No visible desktop help targets." }],
  }));
  setRouteStatus(targetDocument, `Opened ${title.toLowerCase()}`);
}

function renderInspectorView(targetDocument: Document, view: DesktopInspectorView): HTMLElement {
  const section = targetDocument.createElement("section");
  section.className = "desktop-workbench-section desktop-inspector-view";
  section.setAttribute("data-desktop-inspector-view", "");
  section.append(createText(targetDocument, "h2", view.title));

  if (view.subtitle) {
    section.append(createText(targetDocument, "p", view.subtitle));
  }

  if (!view.sections.length) {
    section.append(createText(targetDocument, "p", view.emptyText));
    mountInspectorViewVueIsland(section, {
      emptyText: view.emptyText,
      rows: [],
      subtitle: view.subtitle,
      title: view.title,
    });
    return section;
  }

  const rows = inspectorViewRows(view);
  for (const text of rows) {
    const row = targetDocument.createElement("p");
    row.textContent = text;
    section.append(row);
  }
  mountInspectorViewVueIsland(section, {
    emptyText: view.emptyText,
    rows,
    subtitle: view.subtitle,
    title: view.title,
  });
  return section;
}

function inspectorViewRows(view: DesktopInspectorView): string[] {
  return view.sections.map((item) => {
    if (item.type === "browserActivity") {
      return `${item.activity.actionLabel}: ${[item.activity.title, item.activity.url].filter(Boolean).join(" | ")}`;
    }
    return `${item.label}: ${item.text}`;
  });
}

function mountInspectorViewVueIsland(
  section: HTMLElement,
  options: {
    emptyText: string;
    rows: string[];
    subtitle?: string;
    title: string;
  },
): void {
  if (!canMountVueIsland(section)) {
    return;
  }
  mountInspectorViewIsland(section, options);
}

function createWorkbenchLink(targetDocument: Document, label: string, href: string, className: string): HTMLElement {
  const link = targetDocument.createElement("a");
  link.className = className;
  link.setAttribute("href", href);
  link.textContent = label;
  return link;
}

function createText(targetDocument: Document, tagName: keyof HTMLElementTagNameMap, text: string, className = ""): HTMLElement {
  const element = targetDocument.createElement(tagName);
  if (className) {
    element.className = className;
  }
  element.textContent = text;
  return element;
}

function setDesktopEntityHook(element: HTMLElement, module: string, entityId: string): void {
  element.setAttribute("data-desktop-entity-module", module);
  element.setAttribute("data-desktop-entity-id", entityId);
  element.setAttribute("tabindex", "0");
}

function ensureDesktopWorkbenchShellStyle(targetDocument: Document): void {
  if (targetDocument.getElementById(STYLE_ID)) {
    return;
  }

  const style = targetDocument.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    body.desktop-native-workbench {
      --desktop-chat-column-width: clamp(720px, calc(100vw - 240px), 1760px);
      --desktop-chat-gutter: clamp(16px, 2vw, 36px);
      --desktop-chat-composer-gutter: clamp(32px, 4vw, 72px);
      --desktop-chat-composer-bottom-offset: 8px;
      margin: 0;
      min-height: 100vh;
      overflow: hidden;
      background: var(--bg);
      color: var(--text);
      font-family: var(--font-sans);
    }

    body.desktop-native-workbench .desktop-workbench-shell,
    body.desktop-native-workbench .desktop-workbench-shell * {
      box-sizing: border-box;
    }

    body.desktop-native-workbench .desktop-workbench-shell {
      height: 100vh;
      padding-top: var(--desktop-window-frame-height, 0px);
      display: grid;
      grid-template-columns: 56px minmax(220px, var(--desktop-sidebar-size, 260px)) minmax(420px, 1fr) minmax(280px, var(--desktop-inspector-size, 360px));
      grid-template-rows: minmax(0, 1fr) auto;
      border-top: 1px solid var(--border);
      background: var(--bg);
    }

    body.desktop-native-workbench .desktop-workbench-shell[data-inspector-visible="false"] {
      grid-template-columns: 56px minmax(220px, var(--desktop-sidebar-size, 260px)) minmax(0, 1fr) 0;
    }

    body.desktop-native-workbench .desktop-workbench-shell[data-sidebar-visible="false"] {
      grid-template-columns: 56px 0 minmax(420px, 1fr) minmax(280px, var(--desktop-inspector-size, 360px));
    }

    body.desktop-native-workbench .desktop-workbench-shell[data-sidebar-visible="false"][data-inspector-visible="false"] {
      grid-template-columns: 56px 0 minmax(0, 1fr) 0;
    }

    body.desktop-native-workbench .desktop-activity-rail {
      grid-column: 1;
      grid-row: 1 / span 2;
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 10px 7px;
      border-right: 1px solid var(--border);
      background: var(--bg);
    }

    body.desktop-native-workbench .desktop-activity-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 36px;
      border: 1px solid transparent;
      border-radius: var(--radius-md);
      background: transparent;
      color: var(--text-muted);
      font: 600 12px/1.2 var(--font-sans);
      text-decoration: none;
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-activity-button:hover,
    body.desktop-native-workbench .desktop-activity-button:focus-visible {
      border-color: var(--border);
      background: var(--surface-soft);
      color: var(--text);
    }

    body.desktop-native-workbench .desktop-workbench-sidebar,
    body.desktop-native-workbench .desktop-workbench-inspector,
    body.desktop-native-workbench .desktop-workbench-bottom,
    body.desktop-native-workbench .desktop-workbench-main {
      min-width: 0;
      min-height: 0;
      overflow: hidden;
      border-right: 1px solid var(--border);
      background: var(--panel);
    }

    body.desktop-native-workbench .desktop-workbench-sidebar {
      position: relative;
      grid-column: 2;
      width: var(--region-size);
    }

    body.desktop-native-workbench .desktop-workbench-sidebar-resizer {
      position: absolute;
      top: 0;
      right: -5px;
      z-index: 8;
      width: 10px;
      height: 100%;
      border: 0;
      background: transparent;
      cursor: col-resize;
      touch-action: none;
    }

    body.desktop-native-workbench .desktop-workbench-sidebar-resizer::after {
      position: absolute;
      top: 24px;
      right: 4px;
      bottom: 24px;
      width: 2px;
      border-radius: var(--radius-full, 9999px);
      background: transparent;
      content: "";
      transition: background-color 160ms ease, box-shadow 160ms ease;
    }

    body.desktop-native-workbench .desktop-workbench-sidebar-resizer:hover::after,
    body.desktop-native-workbench .desktop-workbench-sidebar-resizer:focus-visible::after,
    body.desktop-native-workbench .desktop-workbench-sidebar-resizer[data-dragging="true"]::after {
      background: var(--accent, #cc785c);
      box-shadow: 0 0 0 2px var(--accent-soft, rgba(204, 120, 92, 0.12));
    }

    body.desktop-native-workbench .desktop-workbench-inspector {
      grid-column: 4;
      width: var(--region-size);
      border-right: 0;
      border-left: 1px solid var(--border);
      background: #fbfaf7;
    }

    body.desktop-native-workbench .desktop-workbench-inspector[data-visible="false"],
    body.desktop-native-workbench .desktop-workbench-sidebar[data-visible="false"],
    body.desktop-native-workbench .desktop-workbench-bottom[data-visible="false"] {
      display: none;
    }

    body.desktop-native-workbench .desktop-workbench-main {
      grid-column: 3;
      display: grid;
      grid-template-rows: minmax(0, 1fr) auto auto;
      padding: 18px 24px 12px;
      overflow: auto;
      background: var(--bg);
    }

    body.desktop-native-workbench .desktop-empty-session {
      align-self: start;
      display: grid;
      gap: 12px;
      width: min(var(--desktop-chat-column-width), 100%);
      max-width: var(--desktop-chat-column-width);
      min-width: 0;
      margin: 0 auto;
      border: 0;
      border-radius: 0;
      padding: 14px 0 18px;
      background: transparent;
    }

    body.desktop-native-workbench .desktop-empty-session > * {
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-work-lens-inline {
      grid-column: 1;
      grid-row: 3;
      justify-self: center;
      display: grid;
      gap: 8px;
      min-width: 0;
      width: min(var(--desktop-chat-column-width), 100%);
    }

    body.desktop-native-workbench .desktop-work-lens[data-desktop-work-lens-placement="inline"] {
      width: 100%;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: 6px;
      background: var(--panel, #faf9f5);
    }

    body.desktop-native-workbench .desktop-module-work {
      display: grid;
      gap: 6px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-module-work-row {
      min-width: 0;
      min-height: 34px;
      max-width: 100%;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: 6px;
      padding: 6px 8px;
      background: var(--panel, #faf9f5);
      color: var(--text, #141413);
      font: 600 12px/1.3 var(--font-sans, system-ui, sans-serif);
      text-align: left;
      overflow-wrap: anywhere;
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-module-work-row .n-button__content {
      display: block;
      min-width: 0;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    body.desktop-native-workbench .desktop-empty-session h1 {
      margin: 0;
      color: var(--text, #141413);
      font-family: var(--font-display, Georgia, serif);
      font-size: 24px;
      font-weight: 500;
      line-height: 1.2;
      letter-spacing: -0.01em;
    }

    body.desktop-native-workbench .desktop-empty-session p,
    body.desktop-native-workbench .desktop-workbench-section p {
      margin: 0;
      color: var(--text-muted, #6c6a64);
      font-size: 12px;
      line-height: 1.45;
      overflow-wrap: anywhere;
    }

    body.desktop-native-workbench .desktop-workbench-link {
      min-width: 0;
      overflow: hidden;
      color: var(--text, #141413);
      font-size: 12px;
      line-height: 1.3;
      text-decoration: none;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    body.desktop-native-workbench .desktop-workbench-link:focus-visible,
    body.desktop-native-workbench .desktop-activity-button:focus-visible {
      outline: 2px solid var(--primary);
      outline-offset: 2px;
      box-shadow: 0 0 0 4px var(--focus-ring);
    }

    body.desktop-native-workbench .desktop-panel-controls {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-panel-control {
      min-height: 32px;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: 0 10px;
      background: var(--panel);
      color: var(--text);
      font: 600 12px/1.2 var(--font-sans);
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-panel-control[aria-pressed="true"] {
      border-color: var(--primary);
      background: var(--surface-card);
    }

    body.desktop-native-workbench .desktop-inspector-restore {
      display: none;
      justify-self: start;
      min-height: 32px;
      border: 1px solid var(--primary);
      border-radius: 6px;
      padding: 0 10px;
      background: #fff7f3;
      color: var(--primary);
      font: 700 12px/1.2 var(--font-sans);
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-workbench-shell[data-inspector-visible="false"] .desktop-inspector-restore {
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }

    body.desktop-native-workbench .desktop-command-palette {
      display: grid;
      gap: 8px;
      width: min(680px, 100%);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: 10px;
      background: var(--panel);
      box-shadow: var(--shadow-lg);
    }

    body.desktop-native-workbench .desktop-command-palette[hidden] {
      display: none;
    }

    body.desktop-native-workbench .desktop-command-palette-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-command-palette-header h2 {
      margin: 0;
      font-size: 13px;
      line-height: 1.2;
    }

    body.desktop-native-workbench .desktop-command-palette-close,
    body.desktop-native-workbench .desktop-command-palette-result {
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: var(--panel);
      color: var(--text);
      font: 12px/1.2 var(--font-sans);
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-command-palette-close {
      min-height: 28px;
      padding: 0 10px;
    }

    body.desktop-native-workbench .desktop-command-palette-input {
      width: 100%;
      min-width: 0;
      min-height: 34px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 0 10px;
      background: var(--bg);
      color: var(--text);
      font: 13px/1.2 var(--font-sans);
    }

    body.desktop-native-workbench .desktop-command-palette-results {
      display: grid;
      gap: 6px;
      max-height: min(320px, 42vh);
      min-width: 0;
      overflow: auto;
    }

    body.desktop-native-workbench .desktop-command-palette-result {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 3px;
      min-width: 0;
      min-height: 40px;
      padding: 6px 8px;
      text-align: left;
    }

    body.desktop-native-workbench .desktop-command-palette-result strong,
    body.desktop-native-workbench .desktop-command-palette-result span,
    body.desktop-native-workbench .desktop-command-palette-status,
    body.desktop-native-workbench .desktop-command-palette-empty {
      min-width: 0;
      margin: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    body.desktop-native-workbench .desktop-command-palette-result span,
    body.desktop-native-workbench .desktop-command-palette-status,
    body.desktop-native-workbench .desktop-command-palette-empty {
      color: var(--text-muted, #6c6a64);
      font-size: 11px;
      line-height: 1.35;
    }

    body.desktop-native-workbench .desktop-command-palette-close:focus-visible,
    body.desktop-native-workbench .desktop-command-palette-input:focus-visible,
    body.desktop-native-workbench .desktop-command-palette-result:focus-visible {
      outline: 2px solid var(--primary, #cc785c);
      outline-offset: 2px;
    }

    body.desktop-native-workbench .desktop-panel-control:focus-visible,
    body.desktop-native-workbench .desktop-file-action:focus-visible,
    body.desktop-native-workbench .desktop-help-action:focus-visible,
    body.desktop-native-workbench .desktop-sidebar-delete-session:focus-visible,
    body.desktop-native-workbench .desktop-cowork-session-row:focus-visible,
    body.desktop-native-workbench .desktop-cowork-action:focus-visible,
    body.desktop-native-workbench .desktop-cowork-observability-tab:focus-visible,
    body.desktop-native-workbench .desktop-cowork-graph-node:focus-visible,
    body.desktop-native-workbench .desktop-module-work-row:focus-visible,
    body.desktop-native-workbench .desktop-task-action:focus-visible,
    body.desktop-native-workbench .desktop-file-refresh:focus-visible,
    body.desktop-native-workbench .desktop-session-upload-key:focus-visible,
    body.desktop-native-workbench .desktop-workspace-search:focus-visible,
    body.desktop-native-workbench .desktop-workspace-file-row:focus-visible,
    body.desktop-native-workbench .desktop-workspace-editor:focus-visible,
    body.desktop-native-workbench .desktop-inspector-restore:focus-visible,
    body.desktop-native-workbench .desktop-chat-header-stop:focus-visible,
    body.desktop-native-workbench .desktop-chat-header-panel-button:focus-visible,
    body.desktop-native-workbench .desktop-tool-approval-action:focus-visible,
    body.desktop-native-workbench .desktop-run-chain-icon-button:focus-visible,
    body.desktop-native-workbench .desktop-run-chain-summary-item:focus-visible,
    body.desktop-native-workbench .desktop-run-chain-tab:focus-visible,
    body.desktop-native-workbench .desktop-run-chain-panel-action:focus-visible,
    body.desktop-native-workbench .desktop-run-chain-approval-item:focus-visible,
    body.desktop-native-workbench .desktop-run-chain-feed-item:focus-visible {
      outline: 2px solid var(--primary, #cc785c);
      outline-offset: 2px;
    }

    body.desktop-native-workbench .desktop-file-action {
      padding: 0 12px;
    }

    body.desktop-native-workbench .desktop-file-actions {
      display: grid;
      gap: 10px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-file-actions h2 {
      margin: 0;
      color: var(--text-strong, #141413);
      font: 700 20px/1.2 var(--font-sans, system-ui, sans-serif);
    }

    body.desktop-native-workbench .desktop-file-import-grid {
      display: grid;
      grid-template-columns: minmax(160px, 1fr) minmax(160px, 1fr) minmax(170px, 0.82fr) minmax(180px, 1.18fr);
      min-width: 0;
      overflow: hidden;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: 8px;
      background: var(--panel, #faf9f5);
    }

    body.desktop-native-workbench .desktop-file-import-card,
    body.desktop-native-workbench .desktop-file-session-card {
      display: grid;
      align-content: start;
      gap: 10px;
      min-width: 0;
      min-height: 128px;
      border-right: 1px solid var(--border, #e6dfd8);
      padding: 14px;
    }

    body.desktop-native-workbench .desktop-file-import-card:last-child {
      border-right: 0;
    }

    body.desktop-native-workbench .desktop-file-import-button {
      display: grid;
      grid-template-columns: 28px minmax(0, 1fr);
      grid-template-areas: "icon label" "icon hint";
      justify-content: start;
      min-height: 42px;
      border: 0;
      padding: 0;
      background: transparent;
      color: var(--text, #141413);
      text-align: left;
      text-decoration: none;
    }

    body.desktop-native-workbench .desktop-file-import-button::before {
      content: "↑";
      grid-area: icon;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      border-radius: 6px;
      background: var(--accent-soft, #fff0ea);
      color: var(--primary, #d85f45);
      font: 700 16px/1 var(--font-sans, system-ui, sans-serif);
    }

    body.desktop-native-workbench .desktop-file-import-button span {
      grid-area: label;
      min-width: 0;
      font: 700 12px/1.25 var(--font-sans, system-ui, sans-serif);
    }

    body.desktop-native-workbench .desktop-file-import-button small {
      grid-area: hint;
      min-width: 0;
      color: var(--text-muted, #6f685f);
      font: 12px/1.35 var(--font-sans, system-ui, sans-serif);
    }

    body.desktop-native-workbench .desktop-file-format-row,
    body.desktop-native-workbench .desktop-file-session-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      align-items: center;
      min-width: 0;
      margin: 0;
      color: var(--text-muted, #6f685f);
      font: 11px/1.3 var(--font-sans, system-ui, sans-serif);
    }

    body.desktop-native-workbench .desktop-file-format-chip,
    body.desktop-native-workbench .desktop-file-count-pill,
    body.desktop-native-workbench .desktop-file-operation-status strong {
      display: inline-flex;
      align-items: center;
      min-height: 20px;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: 999px;
      padding: 0 7px;
      background: var(--bg, #fffdfa);
      color: var(--text, #141413);
      font: 600 11px/1.2 var(--font-sans, system-ui, sans-serif);
    }

    body.desktop-native-workbench .desktop-file-session-card label {
      color: var(--text-strong, #141413);
      font: 700 12px/1.2 var(--font-sans, system-ui, sans-serif);
    }

    body.desktop-native-workbench .desktop-file-refresh {
      min-height: 24px;
      border: 0;
      border-radius: 6px;
      padding: 0 6px;
      background: transparent;
      color: var(--primary, #d85f45);
      font: 700 11px/1.2 var(--font-sans, system-ui, sans-serif);
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-file-operation-strip {
      display: grid;
      grid-template-columns: repeat(3, minmax(120px, 1fr)) minmax(180px, 1.2fr);
      gap: 12px;
      align-items: center;
      min-width: 0;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: 8px;
      padding: 10px 12px;
      background: var(--panel, #faf9f5);
    }

    body.desktop-native-workbench .desktop-file-operation-status {
      display: flex;
      gap: 8px;
      align-items: center;
      min-width: 0;
      font: 700 12px/1.2 var(--font-sans, system-ui, sans-serif);
    }

    body.desktop-native-workbench .desktop-file-operation-status strong {
      border-color: #bfe4c4;
      background: #effaf0;
      color: #2f7d3e;
    }

    body.desktop-native-workbench .desktop-file-action {
      min-height: 34px;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: 6px;
      background: var(--panel, #faf9f5);
      color: var(--text, #141413);
      font: 600 12px/1.2 var(--font-sans, system-ui, sans-serif);
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-help-pane {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-help-pane h2 {
      flex: 1 0 100%;
    }

    body.desktop-native-workbench .desktop-help-action {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 32px;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: 6px;
      padding: 0 10px;
      background: var(--panel, #faf9f5);
      color: var(--text, #141413);
      font: 600 12px/1.2 var(--font-sans, system-ui, sans-serif);
      text-decoration: none;
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-shortcut-help-dialog {
      position: fixed;
      inset: 0;
      z-index: 1500;
      display: grid;
      place-items: center;
      padding: 18px;
      background: rgba(20, 18, 16, 0.18);
    }

    body.desktop-native-workbench .desktop-shortcut-help-dialog[hidden] {
      display: none;
    }

    body.desktop-native-workbench .desktop-shortcut-help-panel {
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr);
      gap: 18px;
      width: min(860px, calc(100vw - 32px));
      max-height: min(820px, calc(100vh - 32px));
      border: 1px solid rgba(230, 223, 216, 0.74);
      border-radius: 18px;
      padding: 28px 30px 26px;
      background: rgba(255, 255, 255, 0.94);
      box-shadow: 0 24px 70px rgba(34, 28, 22, 0.18);
      backdrop-filter: blur(14px);
    }

    body.desktop-native-workbench .desktop-shortcut-help-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-shortcut-help-header h2 {
      margin: 0;
      color: var(--text, #141413);
      font: 750 24px/1.15 var(--font-sans, system-ui, sans-serif);
      letter-spacing: 0;
    }

    body.desktop-native-workbench .desktop-shortcut-help-close {
      width: 30px;
      height: 30px;
      border: 0;
      border-radius: 999px;
      background: transparent;
      color: var(--text-muted, #6f685f);
      font: 500 20px/1 var(--font-sans, system-ui, sans-serif);
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-shortcut-help-close:hover,
    body.desktop-native-workbench .desktop-shortcut-help-close:focus-visible {
      background: #f2ede7;
      outline: 0;
    }

    body.desktop-native-workbench .desktop-backend-logs-panel {
      grid-template-rows: auto minmax(0, 1fr);
      width: min(960px, calc(100vw - 32px));
    }

    body.desktop-native-workbench .desktop-backend-logs-actions {
      display: flex;
      gap: 8px;
      align-items: center;
    }

    body.desktop-native-workbench .desktop-backend-logs-copy {
      min-height: 30px;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: 8px;
      padding: 0 10px;
      background: var(--bg, #fffdfa);
      color: var(--text, #141413);
      font: 700 12px/1.2 var(--font-sans, system-ui, sans-serif);
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-backend-logs-copy:hover,
    body.desktop-native-workbench .desktop-backend-logs-copy:focus-visible {
      border-color: var(--primary, #cc785c);
      outline: 0;
    }

    body.desktop-native-workbench .desktop-backend-logs-content {
      min-height: 280px;
      max-height: min(620px, calc(100vh - 180px));
      margin: 0;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: 10px;
      padding: 14px;
      background: #181614;
      color: #f8f2ea;
      font: 12px/1.5 ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace;
    }

    body.desktop-native-workbench .desktop-shortcut-help-search {
      width: 100%;
      min-height: 52px;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: 10px;
      padding: 0 16px;
      background: rgba(255, 255, 255, 0.9);
      color: var(--text, #141413);
      font: 500 15px/1.2 var(--font-sans, system-ui, sans-serif);
      outline: 0;
    }

    body.desktop-native-workbench .desktop-shortcut-help-search:focus {
      border-color: var(--primary, #cc785c);
      box-shadow: 0 0 0 3px rgba(204, 120, 92, 0.16);
    }

    body.desktop-native-workbench .desktop-shortcut-help-list {
      min-height: 0;
      overflow: auto;
      padding-right: 6px;
    }

    body.desktop-native-workbench .desktop-shortcut-help-group {
      display: grid;
      gap: 10px;
      margin: 0 0 24px;
    }

    body.desktop-native-workbench .desktop-shortcut-help-group h3 {
      margin: 0 0 8px;
      color: var(--text, #141413);
      font: 750 16px/1.2 var(--font-sans, system-ui, sans-serif);
      letter-spacing: 0;
    }

    body.desktop-native-workbench .desktop-shortcut-help-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 18px;
      align-items: center;
      min-height: 28px;
      color: #4f4b46;
      font: 500 15px/1.25 var(--font-sans, system-ui, sans-serif);
    }

    body.desktop-native-workbench .desktop-shortcut-help-key {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 22px;
      border-radius: 999px;
      padding: 0 9px;
      background: #ecebea;
      color: #595653;
      font: 500 13px/1 var(--font-mono, ui-monospace, monospace);
      white-space: nowrap;
    }

    body.desktop-native-workbench .desktop-file-action.is-desktop-drop-hover,
    body.desktop-native-workbench .desktop-file-action[data-desktop-drop-target]:focus-visible {
      outline: 2px solid var(--primary, #cc785c);
      outline-offset: 2px;
      background: var(--panel-strong, #efe9de);
    }

    body.desktop-native-workbench .desktop-session-upload-key {
      min-width: 0;
      width: 100%;
      min-height: 34px;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: 6px;
      padding: 0 10px;
      background: var(--bg, #fffdfa);
      color: var(--text, #141413);
      font: 12px/1.2 var(--font-sans, system-ui, sans-serif);
    }

    body.desktop-native-workbench .desktop-knowledge-pane {
      align-content: start;
      gap: 16px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-knowledge-workbench {
      display: grid;
      gap: 14px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-knowledge-header {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 18px;
      min-width: 0;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: var(--radius-lg, 12px);
      padding: 14px 16px;
      background: var(--panel, #faf9f5);
    }

    body.desktop-native-workbench .desktop-knowledge-title-block {
      display: grid;
      gap: 6px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-knowledge-kicker,
    body.desktop-native-workbench .desktop-knowledge-status,
    body.desktop-native-workbench .desktop-knowledge-region-header p,
    body.desktop-native-workbench .desktop-knowledge-upload-panel p,
    body.desktop-native-workbench .desktop-knowledge-metric-detail {
      color: var(--text-muted, #6c6a64);
      font: 600 13px/1.4 var(--font-sans, system-ui, sans-serif);
      letter-spacing: 0;
    }

    body.desktop-native-workbench .desktop-knowledge-title-block h2,
    body.desktop-native-workbench .desktop-knowledge-region-header h3,
    body.desktop-native-workbench .desktop-knowledge-upload-panel h4 {
      margin: 0;
      color: var(--text, #141413);
      letter-spacing: 0;
    }

    body.desktop-native-workbench .desktop-knowledge-title-block h2 {
      font: 750 20px/1.15 var(--font-sans, system-ui, sans-serif);
    }

    body.desktop-native-workbench .desktop-knowledge-title-block p {
      margin: 0;
      max-width: 720px;
      color: var(--text-body, #3d3d3a);
      font: 600 13px/1.35 var(--font-sans, system-ui, sans-serif);
    }

    body.desktop-native-workbench .desktop-knowledge-action-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: flex-end;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-knowledge-toolbar {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 8px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-knowledge-action-button {
      min-height: 44px;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: var(--radius-md, 8px);
      padding: 0 16px;
      background: var(--panel, #faf9f5);
      color: var(--text, #141413);
      font: 750 14px/1.2 var(--font-sans, system-ui, sans-serif);
      cursor: pointer;
      transition: background-color 180ms ease, border-color 180ms ease, color 180ms ease, box-shadow 180ms ease;
    }

    body.desktop-native-workbench .desktop-knowledge-action-button-primary {
      border-color: var(--accent, #cc785c);
      background: var(--accent, #cc785c);
      color: var(--on-primary, #ffffff);
      box-shadow: 0 10px 24px var(--accent-glow, rgba(204, 120, 92, 0.15));
    }

    body.desktop-native-workbench .desktop-knowledge-action-button-secondary:hover,
    body.desktop-native-workbench .desktop-knowledge-action-button-secondary:focus-visible {
      border-color: var(--accent, #cc785c);
      background: var(--accent-soft, rgba(204, 120, 92, 0.12));
      color: var(--accent-hover, #a9583e);
      outline: 0;
    }

    body.desktop-native-workbench .desktop-knowledge-action-button-primary:hover,
    body.desktop-native-workbench .desktop-knowledge-action-button-primary:focus-visible {
      border-color: var(--accent-hover, #a9583e);
      background: var(--accent-hover, #a9583e);
      outline: 0;
    }

    body.desktop-native-workbench .desktop-knowledge-action-button:focus-visible {
      box-shadow: 0 0 0 3px var(--accent-glow-strong, rgba(204, 120, 92, 0.24));
    }

    body.desktop-native-workbench .desktop-knowledge-action-button:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }

    body.desktop-native-workbench .desktop-knowledge-management-grid {
      display: grid;
      grid-template-columns: minmax(420px, 1fr) clamp(500px, 42vw, 720px);
      gap: 14px;
      align-items: start;
      min-width: 0;
      width: 100%;
    }

    body.desktop-native-workbench .desktop-knowledge-source-column,
    body.desktop-native-workbench .desktop-knowledge-inspector-column {
      display: grid;
      align-content: start;
      gap: 14px;
      min-width: 0;
      min-height: 0;
    }

    body.desktop-native-workbench .desktop-knowledge-source-column > .desktop-knowledge-region,
    body.desktop-native-workbench .desktop-knowledge-inspector-column > .desktop-knowledge-region {
      grid-area: auto;
    }

    body.desktop-native-workbench .desktop-knowledge-inspector-column {
      position: sticky;
      top: 14px;
    }

    body.desktop-native-workbench .desktop-knowledge-region {
      min-width: 0;
      min-height: 0;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: var(--radius-lg, 12px);
      padding: 16px;
      background: var(--panel, #faf9f5);
      color: var(--text, #141413);
    }

    body.desktop-native-workbench .desktop-knowledge-overview {
      grid-area: overview;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }

    body.desktop-native-workbench .desktop-knowledge-upload-region {
      grid-area: upload;
      display: grid;
      gap: 14px;
    }

    body.desktop-native-workbench .desktop-knowledge-queue-region {
      grid-area: queue;
      display: grid;
      gap: 12px;
    }

    body.desktop-native-workbench .desktop-knowledge-documents-region {
      grid-area: documents;
      display: grid;
      gap: 14px;
    }

    body.desktop-native-workbench .desktop-knowledge-graph-region {
      grid-area: graph;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      gap: 14px;
      max-height: calc(100vh - 96px);
    }

    body.desktop-native-workbench .desktop-knowledge-pipeline {
      grid-area: pipeline;
      display: grid;
      gap: 14px;
    }

    body.desktop-native-workbench .desktop-knowledge-region-header {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      align-items: start;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-knowledge-region-header h3 {
      font: 750 18px/1.2 var(--font-sans, system-ui, sans-serif);
    }

    body.desktop-native-workbench .desktop-knowledge-region-header p,
    body.desktop-native-workbench .desktop-knowledge-upload-panel p {
      margin: 5px 0 0;
    }

    body.desktop-native-workbench .desktop-knowledge-metric {
      display: grid;
      gap: 5px;
      min-width: 0;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: var(--radius-md, 8px);
      padding: 12px;
      background: var(--surface-card, #efe9de);
    }

    body.desktop-native-workbench .desktop-knowledge-metric strong {
      color: var(--text, #141413);
      font: 760 28px/1 var(--font-sans, system-ui, sans-serif);
      letter-spacing: 0;
    }

    body.desktop-native-workbench .desktop-knowledge-metric-label {
      color: var(--text-body, #3d3d3a);
      font: 750 12px/1.2 var(--font-sans, system-ui, sans-serif);
      letter-spacing: 0;
      text-transform: uppercase;
    }

    body.desktop-native-workbench .desktop-knowledge-drop-zone,
    body.desktop-native-workbench .desktop-knowledge-upload-panel {
      display: grid;
      gap: 8px;
      place-items: center;
      min-height: 92px;
      border: 1px dashed rgba(204, 120, 92, 0.45);
      border-radius: var(--radius-md, 8px);
      padding: 16px;
      background: var(--accent-soft, rgba(204, 120, 92, 0.12));
      color: var(--text-body, #3d3d3a);
      text-align: center;
    }

    body.desktop-native-workbench .desktop-knowledge-drop-zone strong {
      color: var(--text, #141413);
      font: 750 14px/1.2 var(--font-sans, system-ui, sans-serif);
    }

    body.desktop-native-workbench .desktop-knowledge-drop-zone span,
    body.desktop-native-workbench .desktop-knowledge-drop-zone small,
    body.desktop-native-workbench .desktop-knowledge-empty-note {
      color: var(--text-muted, #6c6a64);
      font: 600 12px/1.4 var(--font-sans, system-ui, sans-serif);
    }

    body.desktop-native-workbench .desktop-knowledge-upload-panel h4 {
      font: 750 16px/1.2 var(--font-sans, system-ui, sans-serif);
    }

    body.desktop-native-workbench .desktop-knowledge-queue-list,
    body.desktop-native-workbench .desktop-knowledge-queue-row {
      display: grid;
      gap: 8px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-knowledge-queue-row {
      grid-template-columns: minmax(0, 1fr) minmax(90px, 160px) auto auto auto;
      align-items: center;
      border-top: 1px solid var(--border-subtle, #ebe6df);
      padding-top: 10px;
    }

    body.desktop-native-workbench .desktop-knowledge-queue-file {
      display: grid;
      gap: 3px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-knowledge-queue-file strong,
    body.desktop-native-workbench .desktop-knowledge-queue-file span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    body.desktop-native-workbench .desktop-knowledge-queue-file span,
    body.desktop-native-workbench .desktop-knowledge-queue-percent {
      color: var(--text-muted, #6c6a64);
      font-size: 12px;
    }

    body.desktop-native-workbench .desktop-knowledge-queue-progress {
      height: 4px;
      overflow: hidden;
      border-radius: var(--radius-full, 9999px);
      background: var(--surface-soft, #f5f0e8);
    }

    body.desktop-native-workbench .desktop-knowledge-queue-progress span {
      display: block;
      height: 100%;
      border-radius: inherit;
      background: var(--accent, #cc785c);
    }

    body.desktop-native-workbench .desktop-knowledge-queue-row button,
    body.desktop-native-workbench .desktop-knowledge-documents-toolbar button,
    body.desktop-native-workbench .desktop-knowledge-document-row button,
    body.desktop-native-workbench .desktop-knowledge-query-controls button {
      min-height: 32px;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: var(--radius-md, 8px);
      padding: 0 10px;
      background: var(--panel, #faf9f5);
      color: var(--text, #141413);
      font: 700 12px/1.2 var(--font-sans, system-ui, sans-serif);
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-knowledge-documents {
      display: grid;
      gap: 10px;
      min-width: 0;
      overflow: hidden;
    }

    body.desktop-native-workbench .desktop-knowledge-documents-toolbar {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      gap: 8px;
      align-items: center;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-knowledge-documents-toolbar input {
      min-width: 0;
      min-height: 34px;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: var(--radius-md, 8px);
      padding: 0 10px;
      background: var(--bg, #faf9f5);
      color: var(--text, #141413);
      font: 600 12px/1.2 var(--font-sans, system-ui, sans-serif);
    }

    body.desktop-native-workbench .desktop-knowledge-documents-list {
      display: grid;
      gap: 8px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-knowledge-document-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px 10px;
      align-items: center;
      min-width: 0;
      border-top: 1px solid var(--border-subtle, #ebe6df);
      padding-top: 10px;
    }

    body.desktop-native-workbench .desktop-knowledge-document-summary {
      display: grid;
      gap: 2px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-knowledge-document-summary strong,
    body.desktop-native-workbench .desktop-knowledge-document-meta {
      display: block;
      min-width: 0;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    body.desktop-native-workbench .desktop-knowledge-document-attributes {
      display: flex;
      flex-wrap: wrap;
      grid-column: 1 / -1;
      gap: 6px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-knowledge-document-attribute,
    body.desktop-native-workbench .desktop-knowledge-document-status {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      max-width: 100%;
      border: 1px solid var(--border-subtle, #ebe6df);
      border-radius: var(--radius-full, 9999px);
      padding: 0 8px;
      color: var(--text-muted, #6c6a64);
      font: 650 11px/1.2 var(--font-sans, system-ui, sans-serif);
    }

    body.desktop-native-workbench .desktop-knowledge-document-row button {
      max-width: 100%;
    }

    body.desktop-native-workbench .desktop-knowledge-query-panel {
      display: grid;
      gap: 10px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-knowledge-query-controls {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(84px, auto) 64px auto;
      gap: 8px;
      align-items: center;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-knowledge-query-controls input,
    body.desktop-native-workbench .desktop-knowledge-query-controls select {
      min-width: 0;
      min-height: 34px;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: var(--radius-md, 8px);
      padding: 0 10px;
      background: var(--bg, #faf9f5);
      color: var(--text, #141413);
      font: 600 12px/1.2 var(--font-sans, system-ui, sans-serif);
    }

    body.desktop-native-workbench .desktop-knowledge-query-summary {
      display: flex;
      flex-wrap: wrap;
      gap: 6px 12px;
      margin: 0;
      color: var(--text-muted, #6c6a64);
      font: 650 12px/1.4 var(--font-sans, system-ui, sans-serif);
    }

    body.desktop-native-workbench .desktop-knowledge-graph {
      position: relative;
      display: grid;
      gap: 10px;
      min-height: 0;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-knowledge-graph-workspace {
      position: relative;
      display: grid;
      grid-template-rows: minmax(280px, 0.92fr) minmax(180px, 1fr);
      gap: 10px;
      min-width: 0;
      min-height: min(720px, calc(100vh - 176px));
      max-height: calc(100vh - 176px);
    }

    body.desktop-native-workbench .desktop-knowledge-graph-canvas {
      position: relative;
      display: grid;
      grid-template-rows: minmax(0, 1fr) auto;
      min-width: 0;
      min-height: 280px;
      overflow: hidden;
      border: 1px solid var(--border-subtle, #ebe6df);
      border-radius: var(--radius-lg, 12px);
      background:
        radial-gradient(circle at 1px 1px, rgba(20, 20, 19, 0.08) 1px, transparent 0) 0 0 / 18px 18px,
        var(--bg, #faf9f5);
    }

    body.desktop-native-workbench .desktop-knowledge-graph-3d-host {
      width: 100%;
      min-width: 0;
      min-height: 0;
      cursor: grab;
    }

    body.desktop-native-workbench .desktop-knowledge-graph-3d-host:active {
      cursor: grabbing;
    }

    body.desktop-native-workbench .desktop-knowledge-graph-3d-host canvas {
      display: block;
      outline: none;
    }

    body.desktop-native-workbench .desktop-knowledge-graph-fallback svg {
      display: block;
      width: 100%;
      min-width: 0;
      min-height: 280px;
    }

    body.desktop-native-workbench .desktop-knowledge-graph-edge line {
      stroke: rgba(217, 120, 87, 0.56);
      stroke-width: 2;
    }

    body.desktop-native-workbench .desktop-knowledge-graph-edge text,
    body.desktop-native-workbench .desktop-knowledge-graph-node text {
      fill: var(--text-muted, #6c6a64);
      font: 650 12px/1 var(--font-sans, system-ui, sans-serif);
      text-anchor: middle;
      paint-order: stroke;
      stroke: rgba(255, 253, 249, 0.86);
      stroke-width: 4px;
    }

    body.desktop-native-workbench .desktop-knowledge-graph-node {
      cursor: pointer;
      outline: none;
    }

    body.desktop-native-workbench .desktop-knowledge-graph-node circle {
      fill: #f2eadf;
      stroke: var(--primary, #cc785c);
      stroke-width: 2.5;
      filter: drop-shadow(0 8px 14px rgba(75, 54, 38, 0.12));
    }

    body.desktop-native-workbench .desktop-knowledge-graph-node[data-selected="true"] circle,
    body.desktop-native-workbench .desktop-knowledge-graph-node:focus-visible circle {
      fill: #fff7ef;
      stroke-width: 4;
    }

    body.desktop-native-workbench .desktop-knowledge-graph-3d-hint {
      position: absolute;
      left: 10px;
      right: 10px;
      bottom: 10px;
      z-index: 1;
      width: fit-content;
      max-width: calc(100% - 20px);
      border: 1px solid rgba(226, 217, 210, 0.9);
      border-radius: 999px;
      padding: 5px 9px;
      background: rgba(255, 253, 249, 0.88);
      color: var(--text-muted, #6c6a64);
      font: 650 11px/1.2 var(--font-sans, system-ui, sans-serif);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      pointer-events: none;
    }

    body.desktop-native-workbench .desktop-knowledge-graph-references {
      min-width: 0;
      min-height: 0;
      overflow: auto;
      border: 1px solid var(--border-subtle, #ebe6df);
      border-radius: var(--radius-lg, 12px);
      background: var(--bg, #faf9f5);
    }

    body.desktop-native-workbench .desktop-knowledge-graph-references h2 {
      position: sticky;
      top: 0;
      z-index: 1;
      margin: 0;
      border-bottom: 1px solid var(--border-subtle, #ebe6df);
      padding: 8px 10px;
      background: var(--bg, #faf9f5);
      color: var(--text, #141413);
      font: 750 12px/1.2 var(--font-sans, system-ui, sans-serif);
      text-transform: uppercase;
    }

    body.desktop-native-workbench .desktop-knowledge-graph-references .n-list {
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-knowledge-graph-references .n-list-item {
      min-width: 0;
      padding: 8px 10px;
    }

    body.desktop-native-workbench .desktop-knowledge-graph-references .n-space {
      min-width: 0;
      max-width: 100%;
    }

    body.desktop-native-workbench .desktop-knowledge-graph-references .n-space > span:last-child {
      min-width: 0;
      overflow-wrap: anywhere;
    }

    body.desktop-native-workbench .desktop-knowledge-graph-selection-empty {
      margin: 0;
      padding: 10px;
      color: var(--text-muted, #6c6a64);
      font: 600 12px/1.45 var(--font-sans, system-ui, sans-serif);
    }

    body.desktop-native-workbench .desktop-knowledge-pipeline-workspace,
    body.desktop-native-workbench .desktop-knowledge-pipeline-steps {
      display: grid;
      gap: 12px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-knowledge-pipeline-steps {
      grid-template-columns: repeat(6, minmax(64px, 1fr));
    }

    body.desktop-native-workbench .desktop-knowledge-pipeline-step {
      display: grid;
      gap: 4px;
      justify-items: center;
      color: var(--text-muted, #6c6a64);
      text-align: center;
      font-size: 12px;
    }

    body.desktop-native-workbench .desktop-knowledge-pipeline-dot {
      width: 34px;
      height: 34px;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: var(--radius-full, 9999px);
      background: var(--surface-soft, #f5f0e8);
    }

    body.desktop-native-workbench .desktop-knowledge-pipeline-step-done .desktop-knowledge-pipeline-dot,
    body.desktop-native-workbench .desktop-knowledge-pipeline-step-active .desktop-knowledge-pipeline-dot {
      border-color: var(--accent, #cc785c);
      background: var(--accent-soft, rgba(204, 120, 92, 0.12));
    }

    body.desktop-native-workbench .desktop-knowledge-readiness,
    body.desktop-native-workbench .desktop-knowledge-documents,
    body.desktop-native-workbench .desktop-knowledge-document-detail,
    body.desktop-native-workbench .desktop-knowledge-query {
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-knowledge-upload-control {
      position: absolute;
      width: 1px;
      height: 1px;
      margin: -1px;
      border: 0;
      padding: 0;
      overflow: hidden;
      clip: rect(0 0 0 0);
      clip-path: inset(50%);
      white-space: nowrap;
    }

    @media (max-width: 1180px) {
      body.desktop-native-workbench .desktop-knowledge-header {
        grid-template-columns: minmax(0, 1fr);
      }

      body.desktop-native-workbench .desktop-knowledge-action-row {
        justify-content: start;
      }

      body.desktop-native-workbench .desktop-knowledge-management-grid {
        grid-template-columns: minmax(0, 1fr);
      }

      body.desktop-native-workbench .desktop-knowledge-inspector-column {
        position: static;
      }

      body.desktop-native-workbench .desktop-knowledge-graph-region {
        max-height: none;
      }

      body.desktop-native-workbench .desktop-knowledge-graph-workspace {
        max-height: none;
      }

      body.desktop-native-workbench .desktop-knowledge-overview {
        grid-template-columns: repeat(2, minmax(120px, 1fr));
      }

      body.desktop-native-workbench .desktop-knowledge-upload-panel,
      body.desktop-native-workbench .desktop-knowledge-region-header {
        grid-template-columns: minmax(0, 1fr);
      }
    }

    @media (max-width: 640px) {
      body.desktop-native-workbench .desktop-knowledge-overview {
        grid-template-columns: minmax(0, 1fr);
      }

      body.desktop-native-workbench .desktop-knowledge-pipeline-steps {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }

    body.desktop-native-workbench .desktop-workspace-files {
      display: grid;
      grid-template-columns: minmax(180px, 0.62fr) minmax(240px, 0.9fr) minmax(300px, 1.5fr) minmax(160px, 0.7fr);
      grid-template-areas:
        "header header header header"
        "source browser detail actions"
        "source browser editor actions";
      gap: 12px;
      align-items: stretch;
      min-width: 0;
      width: 100%;
    }

    body.desktop-native-workbench .desktop-workspace-files-grid {
      width: 100%;
      min-width: 0;
      align-items: stretch;
    }

    body.desktop-native-workbench .desktop-workspace-header,
    body.desktop-native-workbench .desktop-file-source-tree,
    body.desktop-native-workbench .desktop-workspace-browser,
    body.desktop-native-workbench .desktop-workspace-detail-panel,
    body.desktop-native-workbench .desktop-workspace-editor-panel,
    body.desktop-native-workbench .desktop-workspace-action-rail {
      min-width: 0;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: 8px;
      background: var(--panel, #faf9f5);
      color: var(--text, #141413);
    }

    body.desktop-native-workbench .desktop-workspace-header {
      grid-area: header;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      min-height: 56px;
      padding: 10px 12px;
    }

    body.desktop-native-workbench .desktop-workspace-title-group {
      display: grid;
      gap: 2px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-workspace-title-group h2,
    body.desktop-native-workbench .desktop-workspace-title-group p,
    body.desktop-native-workbench .desktop-file-source-tree h3,
    body.desktop-native-workbench .desktop-workspace-browser h3,
    body.desktop-native-workbench .desktop-workspace-detail-panel h3,
    body.desktop-native-workbench .desktop-workspace-editor-panel h3,
    body.desktop-native-workbench .desktop-workspace-action-rail h3,
    body.desktop-native-workbench .desktop-workspace-active-path,
    body.desktop-native-workbench .desktop-workspace-updated-at,
    body.desktop-native-workbench .desktop-workspace-detail,
    body.desktop-native-workbench .desktop-workspace-save-state,
    body.desktop-native-workbench .desktop-workspace-error,
    body.desktop-native-workbench .desktop-workspace-status {
      margin: 0;
    }

    body.desktop-native-workbench .desktop-workspace-title-group h2 {
      font: 700 15px/1.25 var(--font-sans, system-ui, sans-serif);
    }

    body.desktop-native-workbench .desktop-workspace-title-group p,
    body.desktop-native-workbench .desktop-workspace-updated-at,
    body.desktop-native-workbench .desktop-workspace-size,
    body.desktop-native-workbench .desktop-workspace-detail,
    body.desktop-native-workbench .desktop-workspace-save-state,
    body.desktop-native-workbench .desktop-workspace-status {
      color: var(--text-muted, #6f685f);
      font: 12px/1.45 var(--font-sans, system-ui, sans-serif);
    }

    body.desktop-native-workbench .desktop-workspace-browser {
      grid-area: browser;
    }

    body.desktop-native-workbench .desktop-file-source-tree {
      grid-area: source;
    }

    body.desktop-native-workbench .desktop-workspace-detail-panel {
      grid-area: detail;
    }

    body.desktop-native-workbench .desktop-workspace-editor-panel {
      grid-area: editor;
    }

    body.desktop-native-workbench .desktop-workspace-action-rail {
      grid-area: actions;
    }

    body.desktop-native-workbench .desktop-file-source-tree,
    body.desktop-native-workbench .desktop-workspace-browser,
    body.desktop-native-workbench .desktop-workspace-detail-panel,
    body.desktop-native-workbench .desktop-workspace-editor-panel,
    body.desktop-native-workbench .desktop-workspace-action-rail {
      display: grid;
      align-content: start;
      gap: 10px;
      padding: 10px;
    }

    body.desktop-native-workbench .desktop-file-source-tree h3 {
      color: var(--text-strong, #141413);
      font: 700 12px/1.2 var(--font-sans, system-ui, sans-serif);
      text-transform: uppercase;
      letter-spacing: 0;
    }

    body.desktop-native-workbench .desktop-file-scope-chips {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-file-scope-chip,
    body.desktop-native-workbench .desktop-file-source-row {
      min-width: 0;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: 7px;
      background: var(--panel-strong, #fffdfa);
      color: var(--text, #141413);
      font-family: var(--font-sans, system-ui, sans-serif);
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-file-scope-chip {
      min-height: 30px;
      padding: 0 8px;
      font-size: 12px;
      font-weight: 650;
    }

    body.desktop-native-workbench .desktop-file-source-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 2px 8px;
      align-items: center;
      min-height: 58px;
      padding: 8px 9px;
      text-align: left;
    }

    body.desktop-native-workbench .desktop-file-source-title {
      min-width: 0;
      color: var(--text-strong, #141413);
      font-size: 13px;
      font-weight: 700;
      line-height: 1.2;
    }

    body.desktop-native-workbench .desktop-file-source-detail {
      grid-column: 1 / -1;
      min-width: 0;
      color: var(--text-muted, #6f685f);
      font-size: 11px;
      line-height: 1.3;
    }

    body.desktop-native-workbench .desktop-file-source-count {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 20px;
      height: 20px;
      border-radius: 999px;
      background: var(--bg, #f4efe8);
      color: var(--text-muted, #6f685f);
      font-size: 11px;
      font-weight: 700;
    }

    body.desktop-native-workbench .desktop-file-scope-chip:focus-visible,
    body.desktop-native-workbench .desktop-file-source-row:focus-visible {
      outline: 2px solid var(--primary, #cc785c);
      outline-offset: 2px;
    }

    body.desktop-native-workbench .desktop-workspace-search {
      width: 100%;
      min-width: 0;
      min-height: 34px;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: 6px;
      padding: 0 10px;
      background: var(--bg, #fffdfa);
      color: var(--text, #141413);
      font: 12px/1.2 var(--font-sans, system-ui, sans-serif);
    }

    body.desktop-native-workbench .desktop-workspace-browser h3,
    body.desktop-native-workbench .desktop-workspace-detail-panel h3,
    body.desktop-native-workbench .desktop-workspace-editor-panel h3,
    body.desktop-native-workbench .desktop-workspace-action-rail h3 {
      color: var(--text-strong, #141413);
      font: 700 12px/1.2 var(--font-sans, system-ui, sans-serif);
      text-transform: uppercase;
      letter-spacing: 0;
    }

    body.desktop-native-workbench .desktop-workspace-active-path {
      color: var(--text-strong, #141413);
      font: 600 13px/1.35 var(--font-sans, system-ui, sans-serif);
      overflow-wrap: anywhere;
    }

    body.desktop-native-workbench .desktop-workspace-recent-files {
      display: grid;
      gap: 6px;
      max-height: 270px;
      overflow: auto;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-workspace-file-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 10px;
      min-width: 0;
      min-height: 46px;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: 6px;
      padding: 7px 10px;
      overflow: hidden;
      background: var(--panel, #faf9f5);
      color: var(--text, #141413);
      font: 12px/1.2 var(--font-sans, system-ui, sans-serif);
      text-align: left;
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-workspace-file-row > span {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    body.desktop-native-workbench .desktop-workspace-file-path {
      color: var(--text-strong, #141413);
      font-weight: 650;
    }

    body.desktop-native-workbench .desktop-workspace-file-meta {
      max-width: 18ch;
      color: var(--text-muted, #6f685f);
      font-size: 11px;
      text-align: right;
    }

    body.desktop-native-workbench .desktop-file-import-button {
      min-height: 42px;
      border: 0;
      padding: 0;
      background: transparent;
      text-decoration: none;
    }

    body.desktop-native-workbench .desktop-file-upload-status {
      min-width: 0;
      margin: 0;
      overflow: hidden;
      color: var(--text-muted, #6f685f);
      font: 12px/1.35 var(--font-sans, system-ui, sans-serif);
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    body.desktop-native-workbench .desktop-workspace-file-row[aria-selected="true"] {
      border-color: var(--primary, #cc785c);
      background: var(--accent-soft, #fff0ea);
      color: var(--text-strong, #141413);
    }

    body.desktop-native-workbench .desktop-workspace-actions {
      display: grid;
      gap: 8px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-workspace-editor {
      min-width: 0;
      width: 100%;
      min-height: 220px;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: 6px;
      padding: 8px;
      resize: vertical;
      font: 12px/1.45 ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
    }

    body.desktop-native-workbench .desktop-workspace-save-state,
    body.desktop-native-workbench .desktop-workspace-error {
      overflow-wrap: anywhere;
    }

    body.desktop-native-workbench .desktop-workspace-error {
      color: var(--danger, #c64545);
    }

    body.desktop-native-workbench .desktop-native-composer {
      display: block;
      width: min(var(--desktop-chat-column-width), calc(100% - var(--desktop-chat-composer-gutter)));
      min-width: 0;
      margin: 0 auto var(--desktop-chat-composer-bottom-offset);
      border: 1px solid var(--border);
      border-radius: 24px;
      padding: 14px 8px 8px 14px;
      background: var(--panel);
      box-shadow: var(--shadow-sm);
    }

    body.desktop-native-workbench .desktop-native-composer-layout {
      display: grid;
      grid-template-columns: 40px minmax(0, 1fr) 44px;
      grid-template-rows: auto auto;
      grid-template-areas: "input input input" "attach runtime send";
      gap: 10px 18px;
      align-items: end;
      width: 100%;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-native-composer-action,
    body.desktop-native-workbench .desktop-native-composer-send {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 40px;
      min-width: 40px;
      min-height: 40px;
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 0;
      background: var(--bg);
      color: var(--text);
      font: 600 12px/1.2 var(--font-sans);
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-native-composer-send {
      width: 38px;
      min-width: 38px;
      height: 38px;
      min-height: 38px;
      border-color: var(--primary);
      background: var(--primary);
      color: var(--on-primary);
    }

    body.desktop-native-workbench .desktop-native-composer-send:disabled {
      border-color: #8f9094;
      background: #8f9094;
      color: #ffffff;
      cursor: not-allowed;
    }

    body.desktop-native-workbench .desktop-native-composer-input {
      grid-area: input;
      min-width: 0;
      width: 100%;
      min-height: 24px;
      max-height: calc(24px * 3);
      border: 0;
      border-radius: 0;
      padding: 0;
      resize: none;
      overflow-y: auto;
      scrollbar-gutter: stable;
      background: transparent;
      color: var(--text);
      font: 16px/1.5 var(--font-sans);
    }

    body.desktop-native-workbench .desktop-native-composer-action:focus-visible,
    body.desktop-native-workbench .desktop-native-composer-send:focus-visible {
      outline: 2px solid var(--primary);
      outline-offset: 2px;
      box-shadow: 0 0 0 4px var(--focus-ring);
    }

    body.desktop-native-workbench .desktop-native-composer-input:focus-visible {
      outline: 0;
      box-shadow: none;
    }

    body.desktop-native-workbench .desktop-native-composer-runtime {
      grid-area: runtime;
      display: flex;
      flex-wrap: nowrap;
      gap: 10px;
      align-items: center;
      justify-content: flex-end;
      min-width: 0;
      overflow: visible;
    }

    body.desktop-native-workbench .desktop-native-token-orb {
      position: relative;
      display: inline-flex;
      flex: 0 0 auto;
      align-items: center;
      justify-content: center;
      width: 38px;
      height: 38px;
      overflow: hidden;
      border: 1px solid var(--border-subtle);
      border-radius: 999px;
      background:
        linear-gradient(
          to top,
          rgba(105, 152, 220, 0.86) 0 var(--token-usage-fill, 0%),
          rgba(255, 255, 255, 0.92) var(--token-usage-fill, 0%) 100%
        );
      color: #29313d;
      font: 700 10px/1 var(--font-sans);
      box-shadow: inset 0 0 0 3px rgba(255, 255, 255, 0.58);
    }

    body.desktop-native-workbench .desktop-workbench-shell {
      grid-template-columns: 92px minmax(220px, var(--desktop-sidebar-size, 260px)) minmax(0, 1fr) minmax(280px, 340px);
      grid-template-rows: minmax(0, 1fr) auto;
      border-top: 0;
      background: #f7f7f5;
    }

    body.desktop-native-workbench .desktop-workbench-shell[data-inspector-visible="false"] {
      grid-template-columns: 92px minmax(220px, var(--desktop-sidebar-size, 260px)) minmax(0, 1fr) 0;
    }

    body.desktop-native-workbench .desktop-workbench-shell[data-sidebar-visible="false"] {
      grid-template-columns: 92px 0 minmax(0, 1fr) minmax(280px, 340px);
    }

    body.desktop-native-workbench .desktop-workbench-shell[data-sidebar-visible="false"][data-inspector-visible="false"] {
      grid-template-columns: 92px 0 minmax(0, 1fr) 0;
    }

    body.desktop-native-workbench .desktop-activity-rail {
      justify-content: space-between;
      gap: 12px;
      padding: 14px 10px 16px;
      background: #fbfaf7;
    }

    body.desktop-native-workbench .desktop-activity-rail > .n-config-provider {
      display: flex;
      flex: 1 1 auto;
      min-height: 0;
    }

    body.desktop-native-workbench .desktop-activity-rail-stack {
      display: flex;
      flex: 1 1 auto;
      flex-direction: column;
      gap: 12px;
      width: 100%;
      height: 100%;
      min-height: 0;
    }

    body.desktop-native-workbench .desktop-activity-primary,
    body.desktop-native-workbench .desktop-activity-secondary {
      display: grid;
      gap: 14px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-activity-secondary {
      margin-top: auto;
    }

    body.desktop-native-workbench .desktop-activity-button,
    body.desktop-native-workbench .desktop-activity-secondary-button {
      width: 72px;
      min-height: 42px;
      border-radius: 8px;
      color: #5f5b56;
      font-size: 11px;
      font-weight: 700;
      line-height: 1.15;
      text-align: center;
      white-space: normal;
      box-shadow: none;
    }

    body.desktop-native-workbench .desktop-activity-button[data-active="true"],
    body.desktop-native-workbench .desktop-activity-secondary-button[data-active="true"] {
      border-color: #eaded8;
      background: #fff7ef;
      color: var(--primary);
      box-shadow: none;
    }

    body.desktop-native-workbench .desktop-activity-secondary-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid transparent;
      background: transparent;
      text-decoration: none;
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-activity-secondary-button:hover,
    body.desktop-native-workbench .desktop-activity-secondary-button:focus-visible {
      border-color: #eaded8;
      background: #fff7ef;
      color: #262522;
    }

    body.desktop-native-workbench .desktop-workbench-link[data-active="true"] {
      border-radius: 6px;
      padding: 4px 8px;
      background: #ffffff;
      color: var(--primary);
      box-shadow: inset 3px 0 0 var(--primary);
    }

    body.desktop-native-workbench .desktop-workbench-sidebar,
    body.desktop-native-workbench .desktop-workbench-main,
    body.desktop-native-workbench .desktop-workbench-inspector {
      border-color: #e9e4df;
      background: #f7f7f5;
    }

    body.desktop-native-workbench .desktop-workbench-panel,
    body.desktop-native-workbench .desktop-workbench-panel > .n-card__content,
    body.desktop-native-workbench .desktop-workbench-panel-content {
      height: 100%;
      min-height: 0;
      background: transparent;
    }

    body.desktop-native-workbench .desktop-workbench-panel > .n-card__content {
      padding: 0;
    }

    body.desktop-native-workbench .desktop-workbench-inspector {
      margin: 16px 16px 16px 0;
      border: 1px solid #e9e4df;
      border-radius: 14px;
      background: #ffffff;
      box-shadow: 0 12px 34px rgba(20, 20, 19, 0.08);
    }

    body.desktop-native-workbench .desktop-sidebar-content {
      display: flex;
      flex-direction: column;
      gap: 10px;
      height: 100%;
      min-height: 0;
      padding: 18px 14px;
      overflow-y: auto;
      overflow-x: hidden;
      background: inherit;
    }

    body.desktop-native-workbench .desktop-sidebar-content > .desktop-workbench-section {
      display: grid;
      gap: 6px;
      min-width: 0;
      border: 0;
      padding: 4px 0 0;
      background: transparent;
    }

    body.desktop-native-workbench .desktop-sidebar-content > .desktop-workbench-section:last-child {
      margin-top: auto;
      padding-top: 12px;
      border-top: 1px solid #ebe3dc;
    }

    body.desktop-native-workbench .desktop-sidebar-actions {
      display: grid;
      gap: 12px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-sidebar-primary-action {
      display: grid;
      grid-template-columns: auto 1fr auto;
      align-items: center;
      gap: 8px;
      min-height: 42px;
      border: 1px solid #d9684c;
      border-radius: 7px;
      padding: 0 14px;
      background: linear-gradient(180deg, #e76d50, #cf5e43);
      color: #ffffff;
      font: 600 14px/1.2 var(--font-sans);
      text-decoration: none;
      box-shadow: 0 10px 24px rgba(207, 94, 67, 0.18);
    }

    body.desktop-native-workbench .desktop-sidebar-shortcut {
      color: rgba(255, 255, 255, 0.8);
      font-size: 12px;
      font-weight: 500;
    }

    body.desktop-native-workbench .desktop-sidebar-search {
      width: 100%;
      min-height: 42px;
      border: 1px solid #e5ddd7;
      border-radius: 7px;
      padding: 0 42px 0 14px;
      background: #ffffff;
      color: var(--text);
      font: 13px/1.2 var(--font-sans);
    }

    body.desktop-native-workbench .desktop-sidebar-list-section {
      display: grid;
      gap: 8px;
      min-width: 0;
      min-height: 0;
      overflow: hidden;
    }

    body.desktop-native-workbench .desktop-sidebar-list-section-recent {
      margin-top: 6px;
    }

    body.desktop-native-workbench .desktop-sidebar-section-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
      padding: 0 8px;
    }

    body.desktop-native-workbench .desktop-sidebar-section-heading h2 {
      margin: 0;
      color: #696662;
      font-size: 11px;
      font-weight: 700;
      line-height: 1.2;
      text-transform: uppercase;
    }

    body.desktop-native-workbench .desktop-sidebar-section-action {
      border: 0;
      background: transparent;
      color: #696662;
      font: 600 16px/1 var(--font-sans);
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-workspace-list,
    body.desktop-native-workbench .desktop-recent-chat-list {
      display: grid;
      align-content: start;
      grid-auto-rows: min-content;
      gap: 6px;
      min-width: 0;
      overflow: auto;
    }

    body.desktop-native-workbench .desktop-recent-chat-list {
      max-height: min(42vh, 360px);
    }

    body.desktop-native-workbench .desktop-sidebar-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 8px;
      min-height: 36px;
      border: 1px solid transparent;
      border-radius: 7px;
      padding: 0 10px;
      color: #262522;
      font: 500 13px/1.2 var(--font-sans);
      text-decoration: none;
    }

    body.desktop-native-workbench .desktop-workbench-link {
      display: flex;
      align-items: center;
      justify-content: flex-start;
      width: 100%;
      min-height: 30px;
      border: 1px solid transparent;
      border-radius: 7px;
      padding: 0 9px;
      background: transparent;
      color: #4d4944;
      font: 500 12px/1.2 var(--font-sans);
      text-align: left;
      text-decoration: none;
      cursor: pointer;
      appearance: none;
    }

    body.desktop-native-workbench .desktop-workbench-link:hover,
    body.desktop-native-workbench .desktop-workbench-link:focus-visible {
      border-color: #eee4dd;
      background: #fff7ef;
      color: #262522;
    }

    body.desktop-native-workbench .desktop-sidebar-chat-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      align-items: center;
      gap: 6px;
      min-width: 0;
      min-height: 36px;
      border: 1px solid transparent;
      border-radius: 7px;
      padding: 0 5px 0 0;
      position: relative;
      transition: background-color 120ms ease, border-color 120ms ease;
    }

    body.desktop-native-workbench .desktop-sidebar-chat-row .desktop-sidebar-row {
      min-width: 0;
      min-height: 34px;
      border: 0;
      padding: 0 82px 0 10px;
      background: transparent;
    }

    body.desktop-native-workbench .desktop-sidebar-chat-row .desktop-sidebar-row-main {
      grid-template-columns: minmax(0, 1fr);
    }

    body.desktop-native-workbench .desktop-sidebar-row-title {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-sidebar-pin-icon {
      flex: 0 0 auto;
      font-size: 11px;
      line-height: 1;
    }

    body.desktop-native-workbench .desktop-sidebar-delete-session {
      position: absolute;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      right: 10px;
      top: 50%;
      transform: translateY(-50%);
      width: 24px;
      min-height: 24px;
      border: 1px solid transparent;
      border-radius: 999px;
      padding: 0;
      background: transparent;
      color: #8b5b4e;
      font: 600 11px/1 var(--font-sans);
      cursor: pointer;
      opacity: 0;
      pointer-events: none;
      transition: opacity 120ms ease, background-color 120ms ease, border-color 120ms ease, color 120ms ease;
    }

    body.desktop-native-workbench .desktop-sidebar-delete-session[data-confirming="true"] {
      width: 64px;
      border-color: #f2c9c2;
      background: #fff0ee;
      color: #9f2f25;
      justify-content: center;
      opacity: 1;
      pointer-events: auto;
    }

    body.desktop-native-workbench .desktop-sidebar-chat-row:hover {
      border-color: #eee4dd;
      background: #fffdfb;
    }

    body.desktop-native-workbench .desktop-sidebar-chat-row:hover .desktop-sidebar-row-meta,
    body.desktop-native-workbench .desktop-sidebar-chat-row:focus-within .desktop-sidebar-row-meta,
    body.desktop-native-workbench .desktop-sidebar-chat-row:has(.desktop-sidebar-delete-session[data-confirming="true"]) .desktop-sidebar-row-meta,
    body.desktop-native-workbench .desktop-sidebar-chat-row:has(.desktop-sidebar-delete-session[data-deleting="true"]) .desktop-sidebar-row-meta {
      opacity: 0;
    }

    body.desktop-native-workbench .desktop-sidebar-chat-row:hover .desktop-sidebar-delete-session,
    body.desktop-native-workbench .desktop-sidebar-chat-row:focus-within .desktop-sidebar-delete-session,
    body.desktop-native-workbench .desktop-sidebar-delete-session[data-deleting="true"] {
      background: #f2efec;
      opacity: 1;
      pointer-events: auto;
    }

    body.desktop-native-workbench .desktop-sidebar-delete-session:hover,
    body.desktop-native-workbench .desktop-sidebar-delete-session:focus-visible {
      border-color: #eaded8;
      background: #f8eee9;
      color: #8d4a3a;
    }

    body.desktop-native-workbench .desktop-sidebar-chat-row[data-active="true"],
    body.desktop-native-workbench .desktop-sidebar-row[data-active="true"] {
      border-color: #f0d8cf;
      background: #fff7ef;
      color: #b4533c;
    }

    body.desktop-native-workbench .desktop-sidebar-chat-row[data-active="true"] .desktop-sidebar-row {
      color: #b4533c;
    }

    body.desktop-native-workbench .desktop-sidebar-chat-row[data-pinned="true"] {
      border-color: #e9cabe;
      background: #fbf2ee;
    }

    body.desktop-native-workbench .desktop-sidebar-row-label,
    body.desktop-native-workbench .desktop-sidebar-row-meta {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    body.desktop-native-workbench .desktop-sidebar-row-meta {
      position: absolute;
      right: 10px;
      top: 50%;
      transform: translateY(-50%);
      width: 64px;
      color: #77736f;
      font-size: 12px;
      font-weight: 400;
      pointer-events: none;
      text-align: right;
      transition: opacity 120ms ease;
    }

    body.desktop-native-workbench .desktop-workbench-main {
      grid-template-rows: minmax(0, 1fr) auto 0;
      height: 100%;
      min-height: 0;
      padding: 0;
      overflow: hidden;
      background: #f7f7f5;
    }

    body.desktop-native-workbench .desktop-chat-workbench {
      --desktop-composer-reserve: 36px;
      align-self: stretch;
      display: grid;
      grid-template-columns: minmax(0, 1fr) 0;
      grid-template-rows: auto minmax(0, 1fr) auto auto;
      column-gap: 0;
      row-gap: 0;
      justify-items: stretch;
      width: 100%;
      max-width: none;
      height: 100%;
      min-height: 0;
      margin: 0;
      padding: 0 var(--desktop-chat-gutter);
      overflow: hidden;
      background: #f7f7f5;
      transition:
        column-gap 520ms cubic-bezier(0.16, 1, 0.3, 1),
        grid-template-columns 520ms cubic-bezier(0.16, 1, 0.3, 1);
    }

    body.desktop-native-workbench .desktop-chat-workbench:has(.desktop-conversation-body-layout[data-detail-panel-mode="push"][data-detail-panel-state="opening"]),
    body.desktop-native-workbench .desktop-chat-workbench:has(.desktop-conversation-body-layout[data-detail-panel-mode="push"][data-detail-panel-state="open"]) {
      column-gap: 18px;
      grid-template-columns: minmax(0, 1fr) minmax(300px, var(--desktop-tool-detail-width, 50%));
    }

    body.desktop-native-workbench .desktop-chat-workbench > span,
    body.desktop-native-workbench .desktop-chat-workbench > .desktop-panel-controls {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
      clip-path: inset(50%);
      white-space: nowrap;
    }

    body.desktop-native-workbench .desktop-chat-workbench-chrome {
      grid-column: 1;
      grid-row: 2;
      justify-self: center;
      display: grid;
      gap: 12px;
      width: min(var(--desktop-chat-column-width), 100%);
      margin: 14px auto 0;
      padding: 24px 0;
      background: transparent;
    }

    body.desktop-native-workbench .desktop-chat-workbench-chrome h2 {
      margin: 0;
      color: #1f1d1a;
      font: 700 18px/1.25 var(--font-sans);
      letter-spacing: 0;
    }

    body.desktop-native-workbench .desktop-chat-workbench-chrome p {
      max-width: 520px;
      color: #69635d;
      font: 500 13px/1.55 var(--font-sans);
    }

    body.desktop-native-workbench .desktop-chat-header {
      grid-column: 1;
      grid-row: 1;
      justify-self: center;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      width: min(var(--desktop-chat-column-width), 100%);
      min-width: 0;
      min-height: 54px;
      margin: 0 auto;
      border-bottom: 0;
      padding: 0;
      background: transparent;
    }

    body.desktop-native-workbench .desktop-chat-title-row {
      position: relative;
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-chat-title-group {
      display: grid;
      gap: 2px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-chat-context {
      overflow: hidden;
      color: #8a8179;
      font: 650 11px/1.1 var(--font-sans);
      letter-spacing: 0;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    body.desktop-native-workbench .desktop-chat-header h1 {
      margin: 0;
      color: #1c1b19;
      font-family: var(--font-sans);
      font-size: 18px;
      font-weight: 650;
      line-height: 1.2;
      letter-spacing: 0;
    }

    body.desktop-native-workbench .desktop-chat-header-status {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 5px;
      min-width: 0;
      margin-top: 2px;
    }

    body.desktop-native-workbench .desktop-chat-header-stop {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 20px;
      max-width: 100%;
      border: 1px solid #eaded8;
      border-radius: 999px;
      padding: 0 7px;
      background: #fffaf5;
      color: #6f685f;
      font: 650 10px/1.2 var(--font-sans);
      letter-spacing: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    body.desktop-native-workbench .desktop-chat-header-stop {
      border-color: #e6b8a8;
      background: #fff0ea;
      color: #b4533c;
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-chat-title-editor {
      width: min(360px, 42vw);
      min-width: 120px;
      border: 1px solid #dfd6cf;
      border-radius: 6px;
      padding: 3px 7px;
      background: #fffdfb;
      color: #1c1b19;
      font: 650 18px/1.2 var(--font-sans);
      letter-spacing: 0;
      outline: none;
    }

    body.desktop-native-workbench .desktop-chat-title-editor:focus {
      border-color: #d5674c;
      box-shadow: 0 0 0 2px rgba(213, 103, 76, 0.16);
    }

    body.desktop-native-workbench .desktop-chat-header-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex: 0 0 auto;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-chat-header-panel-button,
    body.desktop-native-workbench .desktop-chat-menu {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 30px;
      min-width: 30px;
      min-height: 30px;
      border: 0;
      border-radius: 6px;
      background: #ffffff;
      color: #262522;
      font: 700 16px/1 var(--font-sans);
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-chat-header-panel-button {
      width: 34px;
      min-width: 34px;
      padding: 0;
      border: 1px solid #e4ddd6;
      color: #59544f;
    }

    body.desktop-native-workbench .desktop-chat-header-panel-icon {
      position: relative;
      display: block;
      width: 18px;
      height: 18px;
      color: #6f6963;
    }

    body.desktop-native-workbench .desktop-chat-header-panel-icon-frame {
      position: absolute;
      inset: 2px;
      border: 1.5px solid currentColor;
      border-radius: 4px;
    }

    body.desktop-native-workbench .desktop-chat-header-panel-icon-rail {
      position: absolute;
      top: 5px;
      bottom: 5px;
      width: 3px;
      border-radius: 2px;
      background: currentColor;
    }

    body.desktop-native-workbench .desktop-chat-header-panel-icon[data-panel-icon="collapse-left"] .desktop-chat-header-panel-icon-rail {
      left: 5px;
    }

    body.desktop-native-workbench .desktop-chat-header-panel-icon[data-panel-icon="collapse-right"] .desktop-chat-header-panel-icon-rail {
      right: 5px;
    }

    body.desktop-native-workbench .desktop-chat-menu {
      width: 30px;
      padding: 0;
      font-size: 16px;
    }

    body.desktop-native-workbench .desktop-chat-menu:hover,
    body.desktop-native-workbench .desktop-chat-menu:focus-visible,
    body.desktop-native-workbench .desktop-chat-header-panel-button:hover,
    body.desktop-native-workbench .desktop-chat-header-panel-button:focus-visible {
      background: #f7f2ed;
    }

    body.desktop-native-workbench .desktop-chat-menu-popover {
      position: absolute;
      top: calc(100% + 8px);
      left: 0;
      right: auto;
      z-index: 8;
      display: grid;
      gap: 4px;
      min-width: 176px;
      border: 1px solid #e5ddd7;
      border-radius: 8px;
      padding: 6px;
      background: #ffffff;
      box-shadow: 0 12px 26px rgba(42, 34, 27, 0.14);
    }

    body.desktop-native-workbench .desktop-chat-menu-popover[hidden] {
      display: none;
    }

    body.desktop-native-workbench .desktop-chat-menu-action {
      min-height: 30px;
      border: 0;
      border-radius: 6px;
      padding: 0 10px;
      background: transparent;
      color: #262522;
      font: 600 13px/1.2 var(--font-sans);
      text-align: left;
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-chat-menu-action:hover,
    body.desktop-native-workbench .desktop-chat-menu-action:focus-visible {
      background: #f7f2ed;
    }

    body.desktop-native-workbench .desktop-chat-menu-empty {
      padding: 7px 10px;
      color: #77736f;
      font: 500 12px/1.2 var(--font-sans);
    }

    body.desktop-native-workbench .desktop-conversation-thread {
      grid-column: 1 / -1;
      grid-row: 2;
      display: grid;
      grid-template-rows: minmax(0, 1fr);
      width: 100%;
      height: 100%;
      min-width: 0;
      min-height: 0;
      overflow: hidden;
    }

    body.desktop-native-workbench .desktop-conversation-thread > .n-config-provider {
      display: grid;
      grid-template-rows: minmax(0, 1fr);
      width: 100%;
      height: 100%;
      min-width: 0;
      min-height: 0;
      overflow: hidden;
    }

    body.desktop-native-workbench .desktop-conversation-message {
      display: grid;
      justify-self: stretch;
      width: 100%;
      max-width: 100%;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-conversation-content-card,
    body.desktop-native-workbench .desktop-conversation-content {
      display: grid;
      gap: 5px;
      width: 100%;
      min-width: 0;
      border: 0;
      border-radius: 0;
      padding: 2px 0 5px;
      background: transparent;
      color: #1f1d1a;
      font: 14px/1.58 var(--font-sans);
    }

    body.desktop-native-workbench .desktop-conversation-message[data-message-tone="assistant"] .desktop-conversation-content {
      padding: 2px 0 5px;
      line-height: 1.62;
    }

    body.desktop-native-workbench .desktop-conversation-content-card .n-card__content {
      padding: 0;
    }

    body.desktop-native-workbench .desktop-conversation-content-card .n-card-content {
      padding: 0;
    }

    body.desktop-native-workbench .desktop-conversation-content-card {
      border: 0;
      padding: 0;
      background: transparent;
      box-shadow: none;
    }

    body.desktop-native-workbench .desktop-conversation-header {
      display: flex;
      align-items: baseline;
      justify-content: flex-start;
      gap: 8px;
      min-width: 0;
      min-height: 20px;
    }

    body.desktop-native-workbench .desktop-conversation-meta {
      display: flex;
      align-items: baseline;
      gap: 6px;
      min-width: 0;
      color: #6d6964;
      font-size: 12px;
      line-height: 1.2;
    }

    body.desktop-native-workbench .desktop-conversation-meta strong {
      color: #1f1d1a;
      font-size: 14px;
      font-weight: 700;
    }

    body.desktop-native-workbench .desktop-message-copy-button {
      position: relative;
      display: inline-grid;
      place-items: center;
      width: 24px;
      height: 24px;
      border: 0;
      border-radius: 6px;
      padding: 0;
      background: transparent;
      color: #77716a;
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-message-copy-button:hover,
    body.desktop-native-workbench .desktop-message-copy-button:focus-visible {
      background: #f7f2ed;
      color: #3f3a35;
      outline: none;
    }

    body.desktop-native-workbench .desktop-message-actions {
      display: flex;
      justify-content: flex-start;
      min-height: 24px;
      margin-top: 2px;
    }

    body.desktop-native-workbench .desktop-message-copy-icon,
    body.desktop-native-workbench .desktop-message-copy-icon::before,
    body.desktop-native-workbench .desktop-message-copy-icon::after {
      box-sizing: border-box;
      display: block;
      width: 12px;
      height: 12px;
      border: 1.5px solid currentColor;
      border-radius: 3px;
    }

    body.desktop-native-workbench .desktop-message-copy-icon {
      position: relative;
      transform: translate(2px, -2px);
    }

    body.desktop-native-workbench .desktop-message-copy-icon::before {
      content: "";
      position: absolute;
      right: 4px;
      top: 4px;
      background: transparent;
    }

    body.desktop-native-workbench .desktop-conversation-content p {
      margin: 0;
      overflow-wrap: anywhere;
    }

    body.desktop-native-workbench .desktop-message-reasoning {
      display: grid;
      justify-items: start;
      justify-self: stretch;
      width: 100%;
      max-width: 100%;
      margin-top: 0;
      overflow: visible;
      border: 0;
      background: transparent;
      color: #77716a;
      font-size: 11px;
      opacity: 0.86;
    }

    body.desktop-native-workbench .desktop-message-reasoning[open] {
      justify-items: stretch;
    }

    body.desktop-native-workbench .desktop-message-reasoning summary {
      justify-self: start;
      list-style: none;
    }

    body.desktop-native-workbench .desktop-message-reasoning summary::-webkit-details-marker {
      display: none;
    }

    body.desktop-native-workbench .desktop-message-reasoning-summary {
      display: flex;
      align-items: center;
      gap: 5px;
      width: fit-content;
      margin-left: 0;
      min-height: 22px;
      border-radius: 999px;
      padding: 0 7px;
      background: transparent;
      color: #77716a;
      font: 650 11px/1.2 var(--font-sans);
      cursor: pointer;
      user-select: none;
    }

    body.desktop-native-workbench .desktop-message-reasoning-summary:hover,
    body.desktop-native-workbench .desktop-message-reasoning-summary:focus-visible {
      background: #f7f2ed;
      color: #3f3a35;
    }

    body.desktop-native-workbench .desktop-message-reasoning-summary::before {
      content: "";
      display: none;
    }

    body.desktop-native-workbench .desktop-message-reasoning-summary::after {
      content: "⌄";
      color: #8c847c;
      font: 700 11px/1 var(--font-sans);
      transition: transform 150ms ease;
    }

    body.desktop-native-workbench .desktop-message-reasoning[open] .desktop-message-reasoning-summary::after {
      transform: rotate(90deg);
    }

    body.desktop-native-workbench .desktop-message-reasoning-toggle {
      display: flex;
      align-items: center;
      gap: 5px;
      width: fit-content;
      margin-left: 0;
      min-height: 22px;
      border: 0;
      border-radius: 999px;
      padding: 0 7px;
      background: transparent;
      color: #77716a;
      font: 650 11px/1.2 var(--font-sans);
      cursor: pointer;
      user-select: none;
    }

    body.desktop-native-workbench .desktop-message-reasoning-toggle:hover,
    body.desktop-native-workbench .desktop-message-reasoning-toggle:focus-visible {
      background: #f7f2ed;
      color: #3f3a35;
      outline: none;
    }

    body.desktop-native-workbench .desktop-message-reasoning-toggle::before {
      content: ">";
      display: inline-block;
      color: #8c847c;
      font: 700 11px/1 var(--font-sans);
      transition: transform 150ms ease;
    }

    body.desktop-native-workbench .desktop-message-reasoning-toggle[aria-expanded="true"]::before {
      transform: rotate(90deg);
    }

    body.desktop-native-workbench .desktop-message-reasoning[data-expanded="true"] {
      justify-items: stretch;
    }

    body.desktop-native-workbench .desktop-message-reasoning-summary::before {
      content: ">";
      display: inline-block;
      color: #8c847c;
      font: 700 11px/1 var(--font-sans);
      transition: transform 150ms ease;
    }

    body.desktop-native-workbench .desktop-message-reasoning-summary::after {
      content: none;
      display: none;
    }

    body.desktop-native-workbench .desktop-message-reasoning[open] .desktop-message-reasoning-summary::before {
      transform: rotate(90deg);
    }

    body.desktop-native-workbench .desktop-message-reasoning-title {
      color: #3f3a35;
      font-weight: 700;
    }

    body.desktop-native-workbench .desktop-message-reasoning-meta {
      margin-left: auto;
      color: #7a746d;
      font-size: 12px;
    }

    body.desktop-native-workbench .desktop-message-reasoning-body {
      box-sizing: border-box;
      width: 100%;
      max-height: 240px;
      margin-top: 8px;
      overflow: auto;
      border: 1px solid #eee6de;
      border-radius: 8px;
      padding: 8px 10px;
      background: #fffaf6;
      color: #625d57;
      white-space: pre-wrap;
    }

    body.desktop-native-workbench .desktop-tool-activities {
      display: grid;
      gap: 6px;
      margin: 2px 0;
      font-size: 12px;
    }

    body.desktop-native-workbench .desktop-tool-activity {
      overflow: hidden;
      border: 1px solid #e2d9d2;
      border-radius: 8px;
      background: #fbfaf7;
      color: #625d57;
    }

    body.desktop-native-workbench .desktop-conversation-body-layout {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 0;
      grid-template-rows: minmax(0, 1fr) auto;
      width: 100%;
      height: 100%;
      min-width: 0;
      min-height: 0;
      overflow: hidden;
    }

    body.desktop-native-workbench .desktop-conversation-layout {
      grid-column: 1;
      grid-row: 1;
      justify-self: center;
      align-self: stretch;
      display: grid;
      align-content: stretch;
      grid-template-rows: minmax(0, 1fr);
      min-width: 0;
      min-height: 0;
      width: min(var(--desktop-chat-column-width), 100%);
      height: 100%;
      padding: 0;
      overflow: hidden;
    }

    body.desktop-native-workbench .desktop-conversation-timeline {
      display: grid;
      align-content: start;
      gap: 6px;
      box-sizing: border-box;
      min-width: 0;
      min-height: 0;
      width: 100%;
      height: 100%;
      padding: 18px 0 12px;
      overflow-y: auto;
      overflow-x: hidden;
      overscroll-behavior: contain;
      scrollbar-gutter: stable;
    }

    body.desktop-native-workbench .desktop-detail-panel-slot {
      grid-column: 2;
      grid-row: 1 / 3;
      position: relative;
      align-self: stretch;
      box-sizing: border-box;
      z-index: 3;
      min-width: 0;
      min-height: 0;
      height: 100%;
      padding-bottom: var(--desktop-chat-composer-bottom-offset);
      opacity: 0;
      overflow: visible;
      pointer-events: none;
      transform: translateX(56px);
      transform-origin: right center;
      transition:
        opacity 420ms cubic-bezier(0.33, 0, 0.2, 1),
        transform 540ms cubic-bezier(0.16, 1, 0.3, 1);
      will-change: opacity, transform;
    }

    body.desktop-native-workbench .desktop-detail-panel-slot[data-detail-panel-state="open"] {
      opacity: 1;
      pointer-events: auto;
      transform: translateX(0);
    }

    body.desktop-native-workbench .desktop-detail-panel-slot[data-detail-panel-state="closing"] {
      opacity: 0;
      pointer-events: none;
      transform: translateX(56px);
      transition:
        opacity 420ms cubic-bezier(0.7, 0, 0.84, 0),
        transform 500ms cubic-bezier(0.7, 0, 0.84, 0);
    }

    body.desktop-native-workbench .desktop-conversation-message {
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-conversation-message[data-message-tone="user"] {
      display: flex;
      justify-content: flex-end;
    }

    body.desktop-native-workbench .desktop-conversation-message[data-message-tone="user"] .desktop-user-message-bubble {
      box-sizing: border-box;
      width: fit-content;
      max-width: min(100%, var(--desktop-chat-column-width));
      border: 0;
      border-radius: 16px;
      padding: 10px 13px;
      background: var(--desktop-user-message-bg, #fff1bd);
      color: var(--text-strong, #262522);
    }

    body.desktop-native-workbench .desktop-conversation-message[data-message-tone="assistant"] {
      display: block;
    }

    body.desktop-native-workbench .desktop-assistant-step-group {
      min-width: 0;
      color: #77716a;
    }

    body.desktop-native-workbench .desktop-assistant-step-group summary::-webkit-details-marker {
      display: none;
    }

    body.desktop-native-workbench .desktop-assistant-step-summary {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-height: 28px;
      border-radius: 7px;
      padding: 2px 0;
      color: #77716a;
      cursor: pointer;
      font: 500 14px/1.45 var(--font-sans);
      list-style: none;
    }

    body.desktop-native-workbench .desktop-assistant-step-summary::after {
      content: "";
      width: 7px;
      height: 7px;
      border-right: 1.5px solid currentColor;
      border-bottom: 1.5px solid currentColor;
      transform: rotate(-45deg);
      transition: transform 160ms ease;
    }

    body.desktop-native-workbench .desktop-assistant-step-group[open] .desktop-assistant-step-summary::after {
      transform: rotate(45deg);
    }

    body.desktop-native-workbench .desktop-assistant-step-summary-count,
    body.desktop-native-workbench .desktop-assistant-step-summary-time {
      color: #918b84;
    }

    body.desktop-native-workbench .desktop-assistant-step-list {
      display: grid;
      gap: 6px;
      margin: 5px 0 2px;
      padding-left: 16px;
      border-left: 1px solid #e3ded7;
    }

    body.desktop-native-workbench .desktop-chat-cowork-surface {
      display: grid;
      gap: 12px;
      width: min(100%, 820px);
      border: 1px solid var(--border, #e6dfd8);
      border-radius: 8px;
      padding: 14px;
      background: var(--panel, #fffdf9);
      color: var(--text, #2f2a25);
      box-shadow: 0 12px 30px rgba(31, 27, 22, 0.06);
    }

    body.desktop-native-workbench .desktop-chat-cowork-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
    }

    body.desktop-native-workbench .desktop-chat-cowork-title,
    body.desktop-native-workbench .desktop-chat-cowork-agent-main,
    body.desktop-native-workbench .desktop-chat-cowork-agent-aside {
      display: grid;
      gap: 3px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-chat-cowork-eyebrow {
      color: #8a847e;
      font: 700 11px/1.2 var(--font-sans);
      text-transform: uppercase;
    }

    body.desktop-native-workbench .desktop-chat-cowork-title strong {
      color: var(--text-strong, #211d19);
      font: 750 15px/1.3 var(--font-sans);
    }

    body.desktop-native-workbench .desktop-chat-cowork-title small {
      color: var(--text-muted, #77716a);
      font-size: 12px;
    }

    body.desktop-native-workbench .desktop-chat-cowork-metrics {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 6px;
    }

    body.desktop-native-workbench .desktop-chat-cowork-metric,
    body.desktop-native-workbench .desktop-chat-cowork-progress,
    body.desktop-native-workbench .desktop-chat-cowork-attention,
    body.desktop-native-workbench .desktop-chat-cowork-agent-status {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: 999px;
      padding: 3px 8px;
      background: var(--panel-strong, #faf9f5);
      color: #625d57;
      font: 650 11px/1.2 var(--font-sans);
      white-space: nowrap;
    }

    body.desktop-native-workbench .desktop-chat-cowork-metric strong {
      color: var(--text-strong, #211d19);
    }

    body.desktop-native-workbench .desktop-chat-cowork-summary {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    body.desktop-native-workbench .desktop-chat-cowork-agent-list {
      display: grid;
      gap: 7px;
    }

    body.desktop-native-workbench .desktop-chat-cowork-agent-row {
      display: grid;
      grid-template-columns: 30px minmax(0, 1fr) auto;
      align-items: center;
      gap: 10px;
      width: 100%;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: 8px;
      padding: 8px;
      background: var(--surface, #fffaf4);
      color: inherit;
      cursor: pointer;
      text-align: left;
    }

    body.desktop-native-workbench .desktop-chat-cowork-agent-row:hover,
    body.desktop-native-workbench .desktop-chat-cowork-agent-row:focus-visible {
      border-color: var(--accent, #8f6d49);
      background: var(--accent-soft, #f5eadf);
      outline: none;
    }

    body.desktop-native-workbench .desktop-chat-cowork-agent-avatar {
      display: grid;
      place-items: center;
      width: 30px;
      height: 30px;
      border-radius: 999px;
      background: var(--panel-strong, #f7f2ed);
      color: var(--text-strong, #211d19);
      font-weight: 800;
    }

    body.desktop-native-workbench .desktop-chat-cowork-agent-main strong {
      color: var(--text-strong, #211d19);
      font-size: 13px;
    }

    body.desktop-native-workbench .desktop-chat-cowork-agent-main span,
    body.desktop-native-workbench .desktop-chat-cowork-agent-aside small {
      overflow: hidden;
      color: var(--text-muted, #77716a);
      font-size: 12px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    body.desktop-native-workbench .desktop-chat-cowork-agent-attention {
      color: #a9583e;
      font-weight: 700;
    }

    body.desktop-native-workbench .desktop-chat-cowork-final {
      display: grid;
      gap: 3px;
      border-top: 1px solid var(--border, #e6dfd8);
      padding-top: 10px;
      color: #625d57;
      font-size: 12px;
    }

    body.desktop-native-workbench .desktop-chat-cowork-final strong {
      color: var(--text-strong, #211d19);
      font-size: 12px;
    }

    body.desktop-native-workbench .desktop-tool-activity {
      border: 0;
      border-radius: 0;
      background: transparent;
    }

    body.desktop-native-workbench .desktop-tool-activity-row {
      display: inline-grid;
      grid-template-columns: 10px auto auto minmax(0, auto) auto auto;
      align-items: center;
      gap: 6px;
      max-width: 100%;
      min-height: 28px;
      border: 1px solid transparent;
      border-radius: 7px;
      padding: 3px 8px;
      background: transparent;
      color: #625d57;
      font: 650 12px/1.35 var(--font-sans);
      cursor: pointer;
      text-align: left;
    }

    body.desktop-native-workbench .desktop-tool-activity-row:hover,
    body.desktop-native-workbench .desktop-tool-activity-row:focus-visible,
    body.desktop-native-workbench .desktop-tool-activity-row[aria-selected="true"] {
      border-color: var(--border, #e6dfd8);
      background: var(--panel-strong, #faf9f5);
      outline: none;
    }

    body.desktop-native-workbench .desktop-tool-activity-status-dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: #9c9891;
    }

    body.desktop-native-workbench .desktop-tool-activity-status-dot[data-tool-status-tone="running"] {
      background: #2f77b4;
    }

    body.desktop-native-workbench .desktop-tool-activity-status-dot[data-tool-status-tone="success"] {
      background: #3b8a4d;
    }

    body.desktop-native-workbench .desktop-tool-activity-status-dot[data-tool-status-tone="error"] {
      background: #b94735;
    }

    body.desktop-native-workbench .desktop-tool-activity-status-dot[data-tool-status-tone="denied"] {
      background: #c88022;
    }

    body.desktop-native-workbench .desktop-tool-activity-kind,
    body.desktop-native-workbench .desktop-tool-activity-separator,
    body.desktop-native-workbench .desktop-tool-activity-status-label {
      color: #7a746d;
      white-space: nowrap;
    }

    body.desktop-native-workbench .desktop-tool-activity-title {
      color: #3f3a35;
      font-family: var(--font-mono);
      font-size: 12px;
      font-weight: 700;
    }

    body.desktop-native-workbench .desktop-tool-detail-panel {
      position: relative;
      display: grid;
      grid-template-rows: auto auto auto minmax(0, 1fr);
      width: 100%;
      min-width: 300px;
      height: 100%;
      min-height: 0;
      max-height: none;
      overflow: hidden;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: 10px;
      background: var(--panel, #fffdf9);
      box-shadow: 0 18px 44px rgba(31, 29, 26, 0.12);
      opacity: 1;
      transform: translateX(0);
      transition:
        opacity 420ms cubic-bezier(0.33, 0, 0.2, 1),
        transform 540ms cubic-bezier(0.16, 1, 0.3, 1),
        box-shadow 540ms cubic-bezier(0.16, 1, 0.3, 1);
      will-change: opacity, transform;
    }

    body.desktop-native-workbench .desktop-tool-detail-panel[data-tool-detail-motion="closing"] {
      opacity: 0;
      transform: translateX(56px);
      transition:
        opacity 420ms cubic-bezier(0.7, 0, 0.84, 0),
        transform 500ms cubic-bezier(0.7, 0, 0.84, 0),
        box-shadow 500ms cubic-bezier(0.7, 0, 0.84, 0);
    }

    body.desktop-native-workbench .desktop-tool-detail-resizer {
      position: absolute;
      inset: 0 auto 0 -6px;
      width: 10px;
      cursor: col-resize;
    }

    body.desktop-native-workbench .desktop-tool-detail-header,
    body.desktop-native-workbench .desktop-tool-detail-status,
    body.desktop-native-workbench .desktop-tool-detail-approval-actions {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--border, #e6dfd8);
    }

    body.desktop-native-workbench .desktop-tool-detail-header {
      justify-content: space-between;
    }

    body.desktop-native-workbench .desktop-tool-detail-eyebrow {
      color: #7a746d;
      font: 700 10px/1.2 var(--font-sans);
      text-transform: uppercase;
    }

    body.desktop-native-workbench .desktop-tool-detail-title {
      margin: 0;
      color: #262522;
      font: 700 15px/1.25 var(--font-mono);
    }

    body.desktop-native-workbench .desktop-tool-detail-close {
      display: grid;
      place-items: center;
      width: 28px;
      height: 28px;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: 6px;
      background: transparent;
      color: #625d57;
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-tool-detail-body {
      display: grid;
      gap: 12px;
      min-height: 0;
      overflow: auto;
      padding: 14px;
    }

    body.desktop-native-workbench .desktop-tool-detail-meta {
      display: grid;
      grid-template-columns: max-content minmax(0, 1fr);
      gap: 5px 10px;
      margin: 0;
      font-size: 12px;
    }

    body.desktop-native-workbench .desktop-tool-detail-meta dt {
      color: #7a746d;
      font-weight: 700;
    }

    body.desktop-native-workbench .desktop-tool-detail-meta dd {
      margin: 0;
      min-width: 0;
      overflow-wrap: anywhere;
      color: #3f3a35;
      font-family: var(--font-mono);
    }

    body.desktop-native-workbench .desktop-tool-detail-section {
      display: grid;
      gap: 6px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-tool-detail-section h4 {
      margin: 0;
      color: #625d57;
      font: 800 11px/1.2 var(--font-sans);
      text-transform: uppercase;
    }

    body.desktop-native-workbench .desktop-tool-detail-pre {
      max-height: 280px;
      margin: 0;
      overflow: auto;
      border-radius: 8px;
      padding: 10px;
      background: var(--surface-dark-soft, #1f1e1b);
      color: var(--on-dark, #faf9f5);
      font: 12px/1.5 var(--font-mono);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    body.desktop-native-workbench .desktop-reference-source-section {
      display: grid;
      gap: 6px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-reference-source-section h4 {
      margin: 0;
      color: #625d57;
      font: 800 11px/1.2 var(--font-sans);
      text-transform: uppercase;
    }

    body.desktop-native-workbench .desktop-reference-source-preview {
      display: grid;
      max-height: 320px;
      overflow: auto;
      border-radius: 8px;
      padding: 8px 0;
      background: var(--surface-dark-soft, #1f1e1b);
      color: var(--on-dark, #faf9f5);
      font: 12px/1.5 var(--font-mono);
    }

    body.desktop-native-workbench .desktop-reference-source-line {
      display: grid;
      grid-template-columns: 44px minmax(0, 1fr);
      gap: 10px;
      min-width: 0;
      padding: 1px 12px;
    }

    body.desktop-native-workbench .desktop-reference-source-line.highlighted {
      background: rgba(224, 97, 67, 0.24);
      color: #fff7ed;
    }

    body.desktop-native-workbench .desktop-reference-source-line-number {
      color: rgba(250, 249, 245, 0.52);
      text-align: right;
      user-select: none;
    }

    body.desktop-native-workbench .desktop-reference-source-line code {
      min-width: 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    body.desktop-native-workbench .desktop-tool-detail-panel[data-tool-detail-mode="overlay"] {
      position: fixed;
      z-index: 40;
      top: 72px;
      right: 18px;
      bottom: 92px;
      width: min(520px, calc(100vw - 36px));
      max-height: none;
    }

    body.desktop-native-workbench .desktop-tool-detail-panel[data-tool-detail-mode="overlay"] .desktop-tool-detail-resizer {
      display: none;
    }

    body.desktop-native-workbench .desktop-tool-activity summary {
      list-style: none;
    }

    body.desktop-native-workbench .desktop-tool-activity summary::-webkit-details-marker {
      display: none;
    }

    body.desktop-native-workbench .desktop-tool-activity-summary {
      display: grid;
      grid-template-columns: 18px minmax(0, 1fr) auto;
      align-items: center;
      gap: 8px;
      min-height: 34px;
      padding: 6px 9px;
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-tool-activity-icon {
      display: grid;
      place-items: center;
      width: 16px;
      height: 16px;
      border-radius: 4px;
      background: rgba(109, 105, 100, 0.1);
      color: #7a746d;
      font: 700 11px/1 var(--font-mono);
      transition: transform 150ms ease;
    }

    body.desktop-native-workbench .desktop-tool-activity[open] .desktop-tool-activity-icon {
      transform: rotate(90deg);
    }

    body.desktop-native-workbench .desktop-tool-activity-main {
      display: grid;
      min-width: 0;
      gap: 1px;
    }

    body.desktop-native-workbench .desktop-tool-activity-title {
      overflow: hidden;
      color: #3f3a35;
      font: 650 12px/1.35 var(--font-mono);
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    body.desktop-native-workbench .desktop-tool-activity-preview {
      overflow: hidden;
      color: #7a746d;
      font-size: 11px;
      line-height: 1.35;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    body.desktop-native-workbench .desktop-tool-activity-badges {
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }

    body.desktop-native-workbench .desktop-tool-activity-badge {
      border: 1px solid #e2d9d2;
      border-radius: 999px;
      padding: 1px 6px;
      background: #ffffff;
      color: #6d6964;
      font-size: 10px;
      font-weight: 700;
      white-space: nowrap;
    }

    body.desktop-native-workbench .desktop-tool-activity-approval-badge {
      border-color: rgba(93, 184, 114, 0.4);
      background: rgba(93, 184, 114, 0.12);
      color: #3b8a4d;
    }

    body.desktop-native-workbench .desktop-tool-activity-status-completed {
      border-color: rgba(93, 184, 114, 0.4);
      background: rgba(93, 184, 114, 0.12);
      color: #3b8a4d;
    }

    body.desktop-native-workbench .desktop-tool-activity-status-running {
      border-color: rgba(56, 128, 194, 0.38);
      background: rgba(56, 128, 194, 0.12);
      color: #2f6798;
    }

    body.desktop-native-workbench .desktop-tool-activity-status-pending,
    body.desktop-native-workbench .desktop-tool-activity-status-blocked {
      border-color: rgba(191, 124, 47, 0.42);
      background: rgba(191, 124, 47, 0.13);
      color: #925d1f;
    }

    body.desktop-native-workbench .desktop-tool-activity-status-failed,
    body.desktop-native-workbench .desktop-tool-activity-status-cancelled {
      border-color: rgba(194, 76, 56, 0.4);
      background: rgba(194, 76, 56, 0.12);
      color: #9a3b2f;
    }

    body.desktop-native-workbench .desktop-tool-activity-pending-approval-badge {
      border-color: rgba(191, 124, 47, 0.42);
      background: rgba(191, 124, 47, 0.13);
      color: #925d1f;
    }

    body.desktop-native-workbench .desktop-tool-approval-card {
      display: grid;
      gap: 8px;
      border-top: 1px solid rgba(191, 124, 47, 0.22);
      padding: 10px 11px 11px 35px;
      background: #fff7eb;
    }

    body.desktop-native-workbench .desktop-tool-approval-card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-tool-approval-title {
      min-width: 0;
      overflow: hidden;
      color: #4a3424;
      font: 700 12px/1.3 var(--font-sans);
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    body.desktop-native-workbench .desktop-tool-approval-tool {
      flex: 0 1 auto;
      min-width: 0;
      overflow: hidden;
      color: #7c5f42;
      font: 650 11px/1.3 var(--font-mono);
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    body.desktop-native-workbench .desktop-tool-approval-command {
      overflow: hidden;
      margin: 0;
      border: 1px solid rgba(191, 124, 47, 0.24);
      border-radius: 6px;
      padding: 7px 8px;
      background: rgba(255, 255, 255, 0.62);
      color: #554235;
      font: 11px/1.45 var(--font-mono);
      text-overflow: ellipsis;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    body.desktop-native-workbench .desktop-tool-approval-actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 7px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-tool-approval-action {
      min-height: 30px;
      border: 1px solid rgba(191, 124, 47, 0.32);
      border-radius: 6px;
      padding: 0 10px;
      background: #fffaf4;
      color: #5d3f23;
      font: 700 11px/1.2 var(--font-sans);
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-tool-approval-action-approveOnce,
    body.desktop-native-workbench .desktop-tool-approval-action-approveSession {
      border-color: rgba(79, 143, 91, 0.36);
      background: #f2fbf4;
      color: #315f3a;
    }

    body.desktop-native-workbench .desktop-tool-approval-action-deny {
      border-color: rgba(194, 76, 56, 0.36);
      background: #fff4f1;
      color: #8d3529;
    }

    body.desktop-native-workbench .desktop-tool-approval-action:hover,
    body.desktop-native-workbench .desktop-tool-approval-action:focus-visible {
      border-color: rgba(191, 124, 47, 0.5);
      background: #fff2dd;
      color: #3f2b18;
    }

    body.desktop-native-workbench .desktop-tool-approval-action-approveOnce:hover,
    body.desktop-native-workbench .desktop-tool-approval-action-approveOnce:focus-visible,
    body.desktop-native-workbench .desktop-tool-approval-action-approveSession:hover,
    body.desktop-native-workbench .desktop-tool-approval-action-approveSession:focus-visible {
      border-color: rgba(79, 143, 91, 0.56);
      background: #e7f7eb;
      color: #214929;
    }

    body.desktop-native-workbench .desktop-tool-approval-action-deny:hover,
    body.desktop-native-workbench .desktop-tool-approval-action-deny:focus-visible {
      border-color: rgba(194, 76, 56, 0.56);
      background: #ffe7e0;
      color: #67281f;
    }

    body.desktop-native-workbench .desktop-tool-activity-body {
      display: grid;
      gap: 0;
      border-top: 1px solid #e8dfd7;
      padding: 7px 11px 11px 35px;
      background: #fffdf9;
    }

    body.desktop-native-workbench .desktop-tool-activity-section {
      display: grid;
      gap: 5px;
      padding: 5px 0 7px;
    }

    body.desktop-native-workbench .desktop-tool-activity-content-details {
      display: grid;
      gap: 6px;
    }

    body.desktop-native-workbench .desktop-tool-activity-content-summary {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      color: #7a746d;
      cursor: pointer;
      list-style: none;
    }

    body.desktop-native-workbench .desktop-tool-activity-content-summary::-webkit-details-marker {
      display: none;
    }

    body.desktop-native-workbench .desktop-tool-activity-content-preview {
      min-width: 0;
      overflow: hidden;
      color: #8a847e;
      font: 11px/1.4 var(--font-mono);
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    body.desktop-native-workbench .desktop-tool-activity-label {
      color: #7a746d;
      font-size: 10px;
      font-weight: 800;
      text-transform: uppercase;
    }

    body.desktop-native-workbench .desktop-tool-activity-pre,
    body.desktop-native-workbench .desktop-tool-activity-empty {
      margin: 0;
      min-height: auto;
      overflow-x: auto;
      padding: 0;
      background: transparent;
      color: #625d57;
      font: 11px/1.5 var(--font-mono);
      white-space: pre-wrap;
    }

    body.desktop-native-workbench .desktop-conversation-bullet {
      padding-left: 18px;
    }

    body.desktop-native-workbench .desktop-conversation-bullet::before {
      content: "•";
      margin-left: -16px;
      padding-right: 8px;
    }

    body.desktop-native-workbench .desktop-conversation-body {
      min-width: 0;
      overflow-wrap: anywhere;
    }

    body.desktop-native-workbench .desktop-conversation-body > *:first-child {
      margin-top: 0;
    }

    body.desktop-native-workbench .desktop-conversation-body > *:last-child {
      margin-bottom: 0;
    }

    body.desktop-native-workbench .desktop-conversation-body p {
      margin: 0 0 10px;
    }

    body.desktop-native-workbench .desktop-conversation-body ul,
    body.desktop-native-workbench .desktop-conversation-body ol {
      margin: 10px 0;
      padding-left: 24px;
    }

    body.desktop-native-workbench .desktop-conversation-body li {
      margin: 0 0 6px;
    }

    body.desktop-native-workbench .desktop-conversation-body pre {
      position: relative;
      margin: 12px 0;
      min-height: auto;
      max-width: 100%;
      overflow-x: auto;
      border: 1px solid #e2d9d2;
      border-radius: 8px;
      padding: 12px 14px;
      background: #fbfaf7;
      color: #1f1d1a;
      font: 12px/1.55 var(--font-mono);
    }

    body.desktop-native-workbench .desktop-code-copy-button {
      position: absolute;
      top: 6px;
      right: 6px;
      border: 1px solid #e6ded6;
      border-radius: 999px;
      padding: 3px 8px;
      background: rgba(255, 253, 249, 0.92);
      color: #6d6964;
      font: 650 11px/1.2 var(--font-sans);
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-code-copy-button:hover,
    body.desktop-native-workbench .desktop-code-copy-button:focus-visible {
      background: #f7f2ed;
      color: #3f3a35;
      outline: none;
    }

    body.desktop-native-workbench .desktop-conversation-body code {
      border: 1px solid #e8dfd7;
      border-radius: 5px;
      padding: 2px 5px;
      background: #fbfaf7;
      font: 12px/1.4 var(--font-mono);
    }

    body.desktop-native-workbench .desktop-conversation-body pre code {
      border: 0;
      padding: 0;
      background: transparent;
      font: inherit;
    }

    body.desktop-native-workbench .desktop-conversation-body blockquote {
      margin: 12px 0;
      border-left: 3px solid #d66348;
      padding: 8px 12px;
      background: #fbfaf7;
      color: #5f5a54;
    }

    body.desktop-native-workbench .desktop-conversation-body a {
      color: #a9583e;
      text-decoration: none;
      border-bottom: 1px solid rgba(169, 88, 62, 0.35);
    }

    body.desktop-native-workbench .desktop-conversation-body a:hover {
      border-bottom-color: #a9583e;
    }

    body.desktop-native-workbench .desktop-message-references {
      display: grid;
      gap: 6px;
      margin-top: 2px;
    }

    body.desktop-native-workbench .desktop-message-reference-group {
      border: 0;
      border-radius: 8px;
      background: transparent;
      color: #6d6964;
      font-size: 12px;
    }

    body.desktop-native-workbench .desktop-message-references-summary {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      width: fit-content;
      border-radius: 999px;
      padding: 3px 8px;
      color: #77716a;
      cursor: pointer;
      list-style: none;
    }

    body.desktop-native-workbench .desktop-message-references-summary::-webkit-details-marker {
      display: none;
    }

    body.desktop-native-workbench .desktop-message-references-summary:hover,
    body.desktop-native-workbench .desktop-message-references-summary:focus-visible {
      background: #f7f2ed;
      color: #3f3a35;
      outline: none;
    }

    body.desktop-native-workbench .desktop-message-references-title {
      font-weight: 700;
    }

    body.desktop-native-workbench .desktop-message-references-count {
      color: #8a847e;
      font-size: 11px;
    }

    body.desktop-native-workbench .desktop-message-reference-list {
      display: grid;
      gap: 5px;
      padding: 5px 0 0 8px;
    }

    body.desktop-native-workbench .desktop-message-reference-item {
      display: grid;
      gap: 2px;
      width: 100%;
      border-left: 2px solid #eee2d7;
      border-top: 0;
      border-right: 0;
      border-bottom: 0;
      padding-left: 8px;
      background: transparent;
      color: #625d57;
      cursor: pointer;
      text-align: left;
    }

    body.desktop-native-workbench .desktop-message-reference-item:hover,
    body.desktop-native-workbench .desktop-message-reference-item:focus-visible {
      border-left-color: var(--accent, #8f6d49);
      color: #3f3a35;
      outline: none;
    }

    body.desktop-native-workbench .desktop-message-reference-title {
      color: #3f3a35;
      font-size: 12px;
      font-weight: 700;
    }

    body.desktop-native-workbench .desktop-message-reference-kind {
      color: #8a847e;
      font-size: 11px;
      font-weight: 700;
    }

    body.desktop-native-workbench .desktop-message-reference-detail {
      color: #7a746d;
      font-size: 11px;
    }

    body.desktop-native-workbench .desktop-conversation-body table {
      width: 100%;
      margin: 12px 0;
      border-collapse: collapse;
    }

    body.desktop-native-workbench .desktop-conversation-body th,
    body.desktop-native-workbench .desktop-conversation-body td {
      border: 1px solid #e2d9d2;
      padding: 8px 10px;
      text-align: left;
    }

    body.desktop-native-workbench .desktop-conversation-attachment {
      width: min(440px, 100%);
      border: 1px solid #e2d9d2;
      border-radius: 8px;
      padding: 14px 16px;
      background: #fbfaf7;
      color: #4f4b46;
      font: 13px/1.4 var(--font-sans);
      overflow-wrap: anywhere;
    }

    body.desktop-native-workbench .desktop-native-composer {
      position: relative;
      grid-column: 1;
      grid-row: 4;
      justify-self: center;
      width: min(var(--desktop-chat-column-width), calc(100% - var(--desktop-chat-composer-gutter)));
      min-height: 0;
      margin: 0 auto var(--desktop-chat-composer-bottom-offset);
      border-color: #ddd5cd;
      border-radius: 24px;
      padding: 14px 8px 8px 14px;
      background: #ffffff;
      box-shadow: 0 10px 28px rgba(20, 20, 19, 0.08);
    }

    body.desktop-native-workbench .desktop-native-composer-layout {
      grid-template-columns: 40px minmax(0, 1fr) 44px;
      grid-template-rows: auto auto;
      grid-template-areas: "input input input" "attach runtime send";
      gap: 10px 14px;
      align-items: end;
    }

    body.desktop-native-workbench .desktop-native-composer-action {
      align-self: end;
      width: 34px;
      min-width: 34px;
      min-height: 34px;
      border-color: transparent;
      border-radius: 999px;
      background: transparent;
      color: #7d7b76;
      font-size: 24px;
    }

    body.desktop-native-workbench #desktop-native-composer-attach {
      grid-area: attach;
    }

    body.desktop-native-workbench .desktop-native-composer-input {
      grid-area: input;
      min-height: 24px;
      max-height: calc(24px * 3);
      padding: 0;
      overflow-y: auto;
      scrollbar-gutter: stable;
      color: #262522;
      font-size: 16px;
    }

    body.desktop-native-workbench .desktop-native-composer-runtime {
      grid-area: runtime;
      align-items: center;
      justify-content: flex-end;
      min-height: 38px;
      max-height: none;
      overflow: visible;
      gap: 10px;
      flex-wrap: nowrap;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-native-composer-model {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      max-width: min(220px, 100%);
      min-height: 34px;
      border: 0;
      border-radius: 999px;
      padding: 0 14px;
      background: transparent;
      color: #262522;
      font: 600 12px/1.2 var(--font-sans);
      box-shadow: none;
      cursor: pointer;
      white-space: nowrap;
    }

    body.desktop-native-workbench .desktop-native-composer-model-label {
      min-width: 0;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    body.desktop-native-workbench .desktop-native-composer-model-menu {
      position: absolute;
      right: 0;
      bottom: calc(100% + 10px);
      z-index: 40;
      display: flex;
      min-width: 220px;
      max-width: min(320px, 70vw);
      padding: 8px;
      flex-direction: column;
      gap: 2px;
      border: 1px solid #ded8d0;
      border-radius: 16px;
      background: #ffffff;
      color: #262522;
      box-shadow: 0 18px 38px rgba(53, 45, 34, 0.16);
      text-align: left;
    }

    body.desktop-native-workbench .desktop-native-composer-model-menu-title {
      padding: 4px 10px 6px;
      color: #77736f;
      font: 500 12px/1.2 var(--font-sans);
    }

    body.desktop-native-workbench .desktop-native-composer-model-option {
      display: flex;
      min-height: 34px;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      border-radius: 10px;
      padding: 0 10px;
      color: #262522;
      font: 500 14px/1.2 var(--font-sans);
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-native-composer-model-option:hover,
    body.desktop-native-workbench .desktop-native-composer-model-option:focus-visible {
      background: #f5f1ec;
      outline: 0;
    }

    body.desktop-native-workbench .desktop-native-composer-model-check {
      width: 18px;
      height: 18px;
      flex: 0 0 auto;
      color: #5f5a55;
    }

    body.desktop-native-workbench .desktop-native-composer-model:hover,
    body.desktop-native-workbench .desktop-native-composer-model:focus-visible {
      outline: 0;
      background: #fff7ef;
      box-shadow: none;
    }

    body.desktop-native-workbench .desktop-native-composer-rag-toggle:hover,
    body.desktop-native-workbench .desktop-native-composer-rag-toggle[aria-pressed="true"] {
      background: #fff7ef;
      box-shadow: none;
    }

    body.desktop-native-workbench .desktop-native-composer-rag-toggle[aria-pressed="false"]:not(:hover):not(:focus-visible) {
      background: transparent;
      box-shadow: none;
    }

    body.desktop-native-workbench .desktop-native-token-orb {
      width: 36px;
      height: 36px;
      border-color: #d8d2ca;
    }

    body.desktop-native-workbench .desktop-native-composer-send {
      grid-area: send;
      align-self: end;
      width: 36px;
      min-width: 36px;
      height: 36px;
      min-height: 36px;
      border-color: var(--primary);
      border-radius: 999px;
      background: var(--primary);
      color: #ffffff;
      font-size: 0;
    }

    body.desktop-native-workbench .desktop-native-composer-send svg {
      display: block;
      width: 20px;
      height: 20px;
    }

    body.desktop-native-workbench .desktop-native-composer-send:disabled {
      border-color: #8f9094;
      background: #8f9094;
    }

    body.desktop-native-workbench .desktop-utility-surfaces {
      display: grid;
      gap: 12px;
      max-height: 0;
      min-width: 0;
      overflow: hidden;
    }

    body.desktop-native-workbench .desktop-utility-surfaces [data-desktop-module-surface] {
      display: none;
    }

    html[data-desktop-active-workbench-module="files"] body.desktop-native-workbench .desktop-chat-workbench,
    html[data-desktop-active-workbench-module="knowledge"] body.desktop-native-workbench .desktop-chat-workbench,
    html[data-desktop-active-workbench-module="cowork"] body.desktop-native-workbench .desktop-chat-workbench,
    html[data-desktop-active-workbench-module="settings"] body.desktop-native-workbench .desktop-chat-workbench,
    html[data-desktop-active-workbench-module="docs"] body.desktop-native-workbench .desktop-chat-workbench {
      display: none;
    }

    html[data-desktop-active-workbench-module="files"] body.desktop-native-workbench .desktop-native-composer,
    html[data-desktop-active-workbench-module="knowledge"] body.desktop-native-workbench .desktop-native-composer,
    html[data-desktop-active-workbench-module="cowork"] body.desktop-native-workbench .desktop-native-composer,
    html[data-desktop-active-workbench-module="settings"] body.desktop-native-workbench .desktop-native-composer,
    html[data-desktop-active-workbench-module="docs"] body.desktop-native-workbench .desktop-native-composer {
      display: none;
    }

    html[data-desktop-active-workbench-module="settings"] body.desktop-native-workbench .desktop-workbench-shell {
      grid-template-columns: 92px minmax(220px, var(--desktop-sidebar-size, 260px)) minmax(0, 1fr) 0;
    }

    html[data-desktop-active-workbench-module="settings"] body.desktop-native-workbench .desktop-workbench-shell[data-sidebar-visible="false"] {
      grid-template-columns: 92px 0 minmax(0, 1fr) 0;
    }

    html[data-desktop-active-workbench-module="settings"] body.desktop-native-workbench .desktop-workbench-inspector {
      display: none;
    }

    html[data-desktop-active-workbench-module="files"] body.desktop-native-workbench .desktop-utility-surfaces,
    html[data-desktop-active-workbench-module="knowledge"] body.desktop-native-workbench .desktop-utility-surfaces,
    html[data-desktop-active-workbench-module="cowork"] body.desktop-native-workbench .desktop-utility-surfaces,
    html[data-desktop-active-workbench-module="settings"] body.desktop-native-workbench .desktop-utility-surfaces,
    html[data-desktop-active-workbench-module="docs"] body.desktop-native-workbench .desktop-utility-surfaces {
      max-height: none;
      height: 100%;
      min-height: 0;
      padding: 18px 28px;
      overflow: auto;
    }

    html[data-desktop-active-workbench-module="files"] body.desktop-native-workbench [data-desktop-module-surface~="workspace"],
    html[data-desktop-active-workbench-module="knowledge"] body.desktop-native-workbench [data-desktop-module-surface~="knowledge"],
    html[data-desktop-active-workbench-module="cowork"] body.desktop-native-workbench [data-desktop-module-surface~="cowork"],
    html[data-desktop-active-workbench-module="settings"] body.desktop-native-workbench [data-desktop-module-surface~="settings"],
    html[data-desktop-active-workbench-module="docs"] body.desktop-native-workbench [data-desktop-module-surface~="docs"] {
      display: grid;
    }

    body.desktop-native-workbench .desktop-settings-pane {
      grid-template-columns: minmax(0, 1fr);
      justify-content: stretch;
      align-items: start;
      gap: 0;
      min-width: 0;
      width: 100%;
      max-width: 1220px;
      margin: 0 auto;
    }

    body.desktop-native-workbench .desktop-settings-pane > .n-config-provider {
      display: contents;
    }

    body.desktop-native-workbench .desktop-settings-sidebar {
      position: sticky;
      top: 0;
      display: grid;
      align-content: start;
      gap: 14px;
      min-width: 0;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: var(--radius-lg, 12px);
      padding: 14px;
      background: var(--surface-soft, #f5f0e8);
    }

    body.desktop-native-workbench .desktop-workbench-sidebar .desktop-settings-sidebar {
      position: static;
      min-height: 100%;
      height: auto;
      max-height: none;
      border: 0;
      border-radius: 0;
      padding: 14px 16px;
      background: transparent;
      overflow: visible;
      overscroll-behavior: auto;
      scrollbar-gutter: auto;
    }

    body.desktop-native-workbench .desktop-settings-search {
      width: 100%;
      min-width: 0;
      min-height: 34px;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: var(--radius-md, 8px);
      background: var(--panel, #faf9f5);
      color: var(--text, #141413);
      padding: 0 10px;
      font: 500 13px/1.35 var(--font-sans);
    }

    body.desktop-native-workbench .desktop-settings-search-results,
    body.desktop-native-workbench .desktop-settings-preview-list {
      display: grid;
      gap: 6px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-settings-search-result,
    body.desktop-native-workbench .desktop-settings-preview-item,
    body.desktop-native-workbench .desktop-settings-dirty-summary {
      display: grid;
      gap: 2px;
      min-width: 0;
      border: 1px solid var(--border-subtle, #ebe6df);
      border-radius: var(--radius-md, 8px);
      padding: 8px 10px;
      background: var(--panel, #faf9f5);
      color: var(--text, #141413);
      font: 500 12px/1.3 var(--font-sans);
      text-align: left;
    }

    body.desktop-native-workbench .desktop-settings-search-result {
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-settings-search-result small,
    body.desktop-native-workbench .desktop-settings-preview-item small {
      color: var(--text-muted, #6c6a64);
      font: 500 11px/1.25 var(--font-sans);
    }

    body.desktop-native-workbench .desktop-settings-search-empty {
      border: 1px solid var(--border-subtle, #ebe6df);
      border-radius: var(--radius-md, 8px);
      padding: 9px 10px;
      background: var(--panel, #faf9f5);
      color: var(--text-muted, #6c6a64);
      font: 500 12px/1.35 var(--font-sans);
    }

    body.desktop-native-workbench .desktop-settings-dirty-summary {
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      border-color: var(--accent, #cc785c);
      background: var(--accent-soft, rgba(204, 120, 92, 0.12));
    }

    body.desktop-native-workbench .desktop-settings-dirty-summary button {
      min-height: 28px;
      border: 1px solid var(--accent, #cc785c);
      border-radius: var(--radius-sm, 6px);
      padding: 0 9px;
      background: var(--panel, #faf9f5);
      color: var(--accent, #cc785c);
      font: 600 12px/1.2 var(--font-sans);
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-settings-local-nav {
      display: none;
      align-items: center;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      min-width: 0;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: var(--radius-md, 8px);
      padding: 8px;
      background: var(--panel, #faf9f5);
      box-shadow: var(--shadow-xs, 0 1px 2px rgba(15, 23, 42, 0.04));
    }

    body.desktop-native-workbench .desktop-workbench-shell[data-sidebar-visible="false"] .desktop-settings-local-nav {
      display: grid;
    }

    body.desktop-native-workbench .desktop-settings-local-nav-menu {
      position: relative;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-settings-local-nav-current,
    body.desktop-native-workbench .desktop-settings-local-nav-restore {
      min-height: 34px;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: var(--radius-sm, 6px);
      padding: 0 10px;
      background: var(--bg, #fffdfa);
      color: var(--text, #141413);
      font: 700 12px/1.2 var(--font-sans);
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-settings-local-nav-current {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-settings-local-nav-list {
      position: absolute;
      top: calc(100% + 6px);
      left: 0;
      z-index: 10;
      display: grid;
      gap: 3px;
      width: min(320px, calc(100vw - 48px));
      max-height: min(420px, 60vh);
      overflow-y: auto;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: var(--radius-md, 8px);
      padding: 6px;
      background: var(--panel, #faf9f5);
      box-shadow: var(--shadow-md, 0 12px 24px rgba(15, 23, 42, 0.1));
    }

    body.desktop-native-workbench .desktop-settings-nav {
      display: grid;
      gap: 3px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-settings-nav-heading {
      margin: 14px 0 4px;
      color: var(--text-muted, #6c6a64);
      font: 500 11px/1.2 var(--font-sans);
      letter-spacing: 0;
      text-transform: uppercase;
    }

    body.desktop-native-workbench .desktop-settings-nav-item {
      display: flex;
      align-items: center;
      min-height: 34px;
      min-width: 0;
      border-radius: var(--radius-md, 8px);
      padding: 0 10px;
      color: var(--text, #141413);
      font: 500 13px/1.25 var(--font-sans);
      text-decoration: none;
      transition: background 140ms ease, color 140ms ease;
    }

    body.desktop-native-workbench .desktop-settings-nav-item:hover,
    body.desktop-native-workbench .desktop-settings-nav-item:focus-visible,
    body.desktop-native-workbench .desktop-settings-nav-item[data-active="true"] {
      background: var(--surface-card, #efe9de);
      color: var(--text-strong, #252523);
    }

    body.desktop-native-workbench .desktop-settings-content {
      display: grid;
      gap: 22px;
      width: 100%;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-settings-header {
      display: flex;
      align-items: start;
      justify-content: space-between;
      gap: 16px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-settings-save-region {
      display: flex;
      align-items: center;
      justify-content: end;
      gap: 10px;
      min-width: min(340px, 100%);
    }

    body.desktop-native-workbench .desktop-settings-save-status {
      min-width: 0;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: var(--radius-md, 8px);
      padding: 8px 10px;
      background: var(--panel, #faf9f5);
      color: var(--text-muted, #6c6a64);
      font: 500 12px/1.3 var(--font-sans);
    }

    body.desktop-native-workbench .desktop-settings-save-status p {
      margin: 0;
    }

    body.desktop-native-workbench .desktop-settings-breadcrumb h2 {
      margin: 0;
      color: var(--text, #141413);
      font: 400 28px/1.2 var(--font-display);
      letter-spacing: 0;
    }

    body.desktop-native-workbench .desktop-settings-breadcrumb {
      color: var(--text-muted, #6c6a64);
    }

    body.desktop-native-workbench .desktop-settings-error-banner {
      display: grid;
      gap: 8px;
      border: 1px solid var(--danger, #c64545);
      border-radius: var(--radius-lg, 12px);
      padding: 14px 16px;
      background: var(--danger-soft, rgba(198, 69, 69, 0.12));
      color: var(--text, #141413);
    }

    body.desktop-native-workbench .desktop-settings-error-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    body.desktop-native-workbench .desktop-settings-error-actions button,
    body.desktop-native-workbench .desktop-settings-save-details button {
      min-height: 28px;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: var(--radius-sm, 6px);
      padding: 0 10px;
      background: var(--panel, #faf9f5);
      color: var(--text, #141413);
      font: 600 12px/1.2 var(--font-sans);
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-settings-save-details {
      display: grid;
      gap: 5px;
      margin: 8px 0 0;
      padding: 0;
      list-style: none;
    }

    body.desktop-native-workbench .desktop-settings-save-details li {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
    }

    body.desktop-native-workbench .desktop-settings-capability-map,
    body.desktop-native-workbench .desktop-settings-default-llm-card,
    body.desktop-native-workbench .desktop-settings-provider-section {
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-settings-capability-map {
      display: grid;
      grid-template-columns: repeat(3, minmax(180px, 1fr));
      gap: 10px;
      align-items: stretch;
    }

    body.desktop-native-workbench .desktop-settings-capability-card {
      display: grid;
      align-content: start;
      gap: 5px;
      min-width: 0;
      min-height: 92px;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: var(--radius-lg, 12px);
      padding: 10px 12px;
      background: var(--panel, #faf9f5);
      color: var(--text, #141413);
      text-decoration: none;
    }

    body.desktop-native-workbench .desktop-settings-capability-card:hover,
    body.desktop-native-workbench .desktop-settings-capability-card:focus-visible {
      border-color: var(--accent, #cc785c);
      background: var(--accent-soft, rgba(204, 120, 92, 0.12));
      outline: 2px solid transparent;
    }

    body.desktop-native-workbench .desktop-settings-capability-label {
      color: var(--text-muted, #6c6a64);
      font: 500 11px/1.2 var(--font-sans);
      text-transform: uppercase;
      letter-spacing: 0;
    }

    body.desktop-native-workbench .desktop-settings-capability-status {
      min-width: 0;
      color: var(--text-strong, #252523);
      font: 500 14px/1.25 var(--font-sans);
      overflow-wrap: anywhere;
    }

    body.desktop-native-workbench .desktop-settings-capability-detail {
      min-width: 0;
      color: var(--text-muted, #6c6a64);
      font: 500 12px/1.35 var(--font-sans);
      overflow-wrap: anywhere;
    }

    body.desktop-native-workbench .desktop-settings-task-page {
      display: grid;
      gap: 18px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-settings-task-card {
      display: grid;
      gap: 16px;
      min-width: 0;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: var(--radius-lg, 12px);
      padding: 24px;
      background: var(--panel, #faf9f5);
      color: var(--text, #141413);
      overflow: hidden;
      scroll-margin-top: 16px;
    }

    body.desktop-native-workbench .desktop-settings-section-heading {
      display: flex;
      align-items: start;
      justify-content: space-between;
      gap: 14px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-settings-section-heading h2 {
      margin: 0;
      color: var(--text, #141413);
      font: 400 24px/1.2 var(--font-display);
      letter-spacing: 0;
    }

    body.desktop-native-workbench .desktop-settings-section-heading p,
    body.desktop-native-workbench .desktop-settings-supporting-copy {
      margin: 4px 0 0;
      color: var(--text-muted, #6c6a64);
      font: 500 13px/1.5 var(--font-sans);
    }

    body.desktop-native-workbench .desktop-settings-section-badge,
    body.desktop-native-workbench .desktop-settings-provider-summary,
    body.desktop-native-workbench .desktop-settings-eyebrow {
      display: inline-flex;
      align-items: center;
      width: max-content;
      max-width: 100%;
      border-radius: var(--radius-full, 9999px);
      padding: 4px 10px;
      background: var(--accent-soft, rgba(204, 120, 92, 0.12));
      color: var(--accent, #cc785c);
      font: 600 12px/1.2 var(--font-sans);
      overflow-wrap: anywhere;
    }

    body.desktop-native-workbench .desktop-settings-default-ai-layout,
    body.desktop-native-workbench .desktop-settings-field-pair,
    body.desktop-native-workbench .desktop-settings-response-grid,
    body.desktop-native-workbench .desktop-settings-knowledge-core-layout {
      display: grid;
      gap: 14px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-settings-default-ai-layout {
      grid-template-columns: minmax(0, 1fr) minmax(220px, 0.45fr);
      align-items: stretch;
    }

    body.desktop-native-workbench .desktop-settings-field-pair {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    body.desktop-native-workbench .desktop-settings-response-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    body.desktop-native-workbench .desktop-settings-knowledge-core-layout {
      grid-template-columns: minmax(0, 1fr) minmax(240px, 0.55fr);
    }

    body.desktop-native-workbench .desktop-settings-default-llm-card {
      display: grid;
      gap: 12px;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: var(--radius-lg, 12px);
      padding: 24px 28px;
      background: var(--panel, #faf9f5);
    }

    body.desktop-native-workbench .desktop-settings-card-heading h2,
    body.desktop-native-workbench .desktop-settings-provider-header h2 {
      margin: 0;
      color: var(--text, #141413);
      font: 400 24px/1.2 var(--font-display);
      letter-spacing: 0;
    }

    body.desktop-native-workbench .desktop-settings-default-llm-form {
      display: grid;
      grid-template-columns: minmax(180px, 1fr) minmax(220px, 1fr) minmax(120px, 0.35fr);
      align-items: end;
      gap: 18px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-settings-inline-field {
      display: grid;
      gap: 8px;
      min-width: 0;
      color: var(--text, #141413);
      font: 500 13px/1.3 var(--font-sans);
    }

    body.desktop-native-workbench .desktop-settings-inline-field select,
    body.desktop-native-workbench .desktop-settings-inline-field input,
    body.desktop-native-workbench .desktop-settings-provider-search {
      width: 100%;
      min-width: 0;
      min-height: 34px;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: var(--radius-md, 8px);
      padding: 0 10px;
      background: var(--panel, #faf9f5);
      color: var(--text, #141413);
      font: 500 13px/1.35 var(--font-sans);
    }

    body.desktop-native-workbench .desktop-settings-save-status-button {
      min-height: 34px;
      border: 1px solid var(--accent, #cc785c);
      border-radius: var(--radius-md, 8px);
      padding: 0 14px;
      background: var(--accent, #cc785c);
      color: var(--on-primary, #ffffff);
      font: 600 13px/1.2 var(--font-sans);
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-settings-save-status-button:disabled {
      cursor: not-allowed;
      opacity: 0.62;
      background: var(--surface-card, #efe9de);
      border-color: var(--border, #e6dfd8);
      color: var(--text-muted, #6c6a64);
    }

    body.desktop-native-workbench .desktop-settings-default-llm-copy {
      margin: 0;
      color: var(--text-muted, #6c6a64);
      font: 500 13px/1.55 var(--font-sans);
    }

    body.desktop-native-workbench .desktop-settings-provider-section {
      display: grid;
      gap: 18px;
    }

    body.desktop-native-workbench .desktop-settings-provider-detail-panel {
      position: sticky;
      top: 88px;
      align-self: start;
      max-height: min(720px, calc(100dvh - var(--desktop-window-frame-height, 0px) - 112px));
      overflow-x: hidden;
      overflow-y: auto;
      overscroll-behavior: contain;
      scrollbar-gutter: stable;
    }

    body.desktop-native-workbench .desktop-settings-provider-detail-section {
      display: grid;
      gap: 10px;
    }

    body.desktop-native-workbench .desktop-settings-provider-model-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-settings-provider-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-settings-provider-tools {
      display: grid;
      grid-template-columns: minmax(180px, 1fr) auto auto;
      gap: 10px;
      min-width: min(420px, 100%);
    }

    body.desktop-native-workbench .desktop-settings-provider-icon-button,
    body.desktop-native-workbench .desktop-settings-provider-add,
    body.desktop-native-workbench .desktop-settings-provider-card-actions button {
      min-height: 34px;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: var(--radius-md, 8px);
      padding: 0 12px;
      background: var(--panel, #faf9f5);
      color: var(--text, #141413);
      font: 600 13px/1.2 var(--font-sans);
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-settings-provider-icon-button {
      width: 42px;
      overflow: hidden;
      color: transparent;
      position: relative;
    }

    body.desktop-native-workbench .desktop-settings-provider-icon-button::before {
      content: "↻";
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      color: #25211d;
      font-size: 16px;
    }

    body.desktop-native-workbench .desktop-settings-provider-add {
      border-color: var(--accent, #cc785c);
      background: var(--accent, #cc785c);
      color: var(--on-primary, #ffffff);
    }

    body.desktop-native-workbench .desktop-settings-provider-icon-button {
      min-width: 82px;
      width: auto;
      color: #25211d;
    }

    body.desktop-native-workbench .desktop-settings-provider-icon-button::before {
      content: none;
    }

    body.desktop-native-workbench .desktop-settings-provider-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(250px, 1fr));
      gap: 16px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-settings-provider-card {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr) auto auto;
      align-content: start;
      gap: 14px;
      min-width: 0;
      min-height: 246px;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: var(--radius-lg, 12px);
      padding: 14px;
      background: var(--panel, #faf9f5);
      box-shadow: none;
    }

    body.desktop-native-workbench .desktop-settings-provider-card[data-selected="true"] {
      border-color: var(--accent, #cc785c);
      background: var(--accent-soft, rgba(204, 120, 92, 0.12));
    }

    body.desktop-native-workbench .desktop-settings-provider-card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-settings-provider-identity {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-settings-provider-mark {
      display: grid;
      place-items: center;
      flex: 0 0 auto;
      width: 42px;
      height: 42px;
      border-radius: var(--radius-md, 8px);
      background: var(--surface-dark, #181715);
      color: var(--on-dark, #faf9f5);
      font: 600 14px/1 var(--font-sans);
      letter-spacing: 0;
    }

    body.desktop-native-workbench .desktop-settings-provider-title {
      display: grid;
      gap: 5px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-settings-provider-title h3 {
      margin: 0;
      color: var(--text, #141413);
      font: 500 15px/1.2 var(--font-sans);
      letter-spacing: 0;
      overflow-wrap: anywhere;
    }

    body.desktop-native-workbench .desktop-settings-provider-status-row {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-settings-provider-badge {
      border-radius: var(--radius-full, 9999px);
      padding: 3px 8px;
      background: var(--accent-soft, rgba(204, 120, 92, 0.12));
      color: var(--accent, #cc785c);
      font: 600 11px/1.2 var(--font-sans);
    }

    body.desktop-native-workbench .desktop-settings-provider-status {
      color: var(--text-muted, #6c6a64);
      font: 500 11px/1.2 var(--font-sans);
      white-space: nowrap;
    }

    body.desktop-native-workbench .desktop-settings-provider-switch {
      position: relative;
      flex: 0 0 auto;
      width: 34px;
      height: 20px;
      border: 0;
      border-radius: 999px;
      appearance: none;
      background: var(--surface-cream-strong, #e8e0d2);
      box-shadow: inset 0 0 0 1px rgba(20, 20, 19, 0.05);
      cursor: pointer;
      padding: 0;
    }

    body.desktop-native-workbench .desktop-settings-provider-switch:focus-visible {
      outline: 2px solid var(--accent-glow-strong, rgba(204, 120, 92, 0.24));
      outline-offset: 2px;
    }

    body.desktop-native-workbench .desktop-settings-provider-switch::after {
      content: "";
      position: absolute;
      top: 3px;
      left: 3px;
      width: 14px;
      height: 14px;
      border-radius: 999px;
      background: var(--panel, #faf9f5);
      box-shadow: 0 1px 3px rgba(20, 20, 19, 0.18);
      transition: transform 160ms ease;
    }

    body.desktop-native-workbench .desktop-settings-provider-switch[data-state="on"] {
      background: var(--accent, #cc785c);
    }

    body.desktop-native-workbench .desktop-settings-provider-switch[data-state="on"]::after {
      transform: translateX(14px);
    }

    body.desktop-native-workbench .desktop-settings-provider-details {
      display: grid;
      gap: 10px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-settings-provider-detail {
      display: grid;
      grid-template-columns: 64px minmax(0, 1fr);
      align-items: center;
      gap: 10px;
      min-width: 0;
      margin: 0;
      color: var(--text-muted, #6c6a64);
      font: 500 11px/1.2 var(--font-sans);
    }

    body.desktop-native-workbench .desktop-settings-provider-detail input {
      width: 100%;
      min-width: 0;
      min-height: 30px;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: var(--radius-sm, 6px);
      padding: 0 9px;
      background: var(--panel, #faf9f5);
      color: var(--text, #141413);
      font: 500 12px/1.25 var(--font-sans);
      overflow: hidden;
      text-overflow: ellipsis;
      cursor: default;
    }

    body.desktop-native-workbench .desktop-settings-provider-detail-text {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
      white-space: nowrap;
    }

    body.desktop-native-workbench .desktop-settings-provider-advanced {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      width: 100%;
      min-height: 28px;
      border: 0;
      padding: 0;
      background: transparent;
      color: var(--text-muted, #6c6a64);
      font: 500 12px/1.2 var(--font-sans);
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-settings-provider-card-actions {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-settings-header p,
    body.desktop-native-workbench .desktop-settings-summary p,
    body.desktop-native-workbench .desktop-settings-field-description,
    body.desktop-native-workbench .desktop-settings-group-description {
      margin: 4px 0 0;
      color: var(--text-muted, #6c6a64);
      font: 500 12px/1.45 var(--font-sans);
    }

    body.desktop-native-workbench .desktop-settings-actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: end;
      gap: 8px;
    }

    body.desktop-native-workbench .desktop-settings-actions button,
    body.desktop-native-workbench .desktop-settings-field input,
    body.desktop-native-workbench .desktop-settings-field select,
    body.desktop-native-workbench .desktop-settings-field textarea {
      border: 1px solid var(--border, #e6dfd8);
      border-radius: var(--radius-md, 8px);
      background: var(--panel, #faf9f5);
      color: var(--text, #141413);
      font: 500 13px/1.35 var(--font-sans);
    }

    body.desktop-native-workbench .desktop-settings-actions button {
      min-height: 34px;
      padding: 0 12px;
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-settings-actions button:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }

    body.desktop-native-workbench .desktop-settings-status-card {
      min-width: 0;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: var(--radius-lg, 12px);
      background: var(--surface-soft, #f5f0e8);
      overflow: hidden;
      scroll-margin-top: 12px;
    }

    body.desktop-native-workbench .desktop-settings-status-card strong {
      display: block;
      color: var(--text, #141413);
      font: 500 14px/1.3 var(--font-sans);
      overflow-wrap: anywhere;
    }

    body.desktop-native-workbench .desktop-settings-status-card span {
      display: block;
      color: var(--text-muted, #6c6a64);
      font: 500 12px/1.45 var(--font-sans);
      overflow-wrap: anywhere;
    }

    body.desktop-native-workbench .desktop-settings-summary {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-settings-status-item {
      min-width: 0;
      margin: 0;
      border-bottom: 1px solid var(--border-subtle, #ebe6df);
      padding: 12px 14px;
      color: var(--text-muted, #6c6a64);
      font: 500 12px/1.45 var(--font-sans);
    }

    body.desktop-native-workbench .desktop-settings-status-item:nth-last-child(-n + 2) {
      border-bottom: 0;
    }

    body.desktop-native-workbench .desktop-settings-status-item strong {
      color: var(--text, #141413);
      font-weight: 500;
    }

    body.desktop-native-workbench .desktop-settings-grid {
      display: grid;
      gap: 28px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-settings-group {
      display: grid;
      align-content: start;
      gap: 0;
      min-width: 0;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: var(--radius-lg, 12px);
      background: var(--panel, #faf9f5);
      overflow: hidden;
    }

    body.desktop-native-workbench .desktop-settings-group h2 {
      margin: 0;
      padding: 16px 18px 0;
      color: var(--text, #141413);
      font: 400 20px/1.2 var(--font-display);
      letter-spacing: 0;
    }

    body.desktop-native-workbench .desktop-settings-group-description {
      padding: 0 18px 14px;
    }

    body.desktop-native-workbench .desktop-settings-files-actions,
    body.desktop-native-workbench .desktop-settings-channels-summary,
    body.desktop-native-workbench .desktop-settings-runtime-summary,
    body.desktop-native-workbench .desktop-settings-diagnostics-actions,
    body.desktop-native-workbench .desktop-settings-mcp-server-list,
    body.desktop-native-workbench .desktop-settings-secret-controls {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      margin: 0 18px 14px;
      border: 1px solid var(--border-subtle, #ebe6df);
      border-radius: var(--radius-md, 8px);
      padding: 10px;
      background: var(--surface-soft, #f5f0e8);
    }

    body.desktop-native-workbench .desktop-settings-runtime-summary,
    body.desktop-native-workbench .desktop-settings-diagnostics-actions,
    body.desktop-native-workbench .desktop-settings-mcp-server-list {
      display: grid;
      align-items: stretch;
    }

    body.desktop-native-workbench .desktop-settings-files-actions p,
    body.desktop-native-workbench .desktop-settings-channels-summary p,
    body.desktop-native-workbench .desktop-settings-runtime-summary p,
    body.desktop-native-workbench .desktop-settings-diagnostics-actions p {
      flex: 1 1 100%;
      min-width: 0;
      margin: 0;
      color: var(--text-muted, #6c6a64);
      font: 500 12px/1.45 var(--font-sans);
      overflow-wrap: anywhere;
    }

    body.desktop-native-workbench .desktop-settings-files-actions button,
    body.desktop-native-workbench .desktop-settings-channels-summary button,
    body.desktop-native-workbench .desktop-settings-runtime-summary button,
    body.desktop-native-workbench .desktop-settings-diagnostics-actions button,
    body.desktop-native-workbench .desktop-settings-secret-controls button {
      min-height: 30px;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: var(--radius-sm, 6px);
      padding: 0 10px;
      background: var(--panel, #faf9f5);
      color: var(--text, #141413);
      font: 600 12px/1.2 var(--font-sans);
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-settings-runtime-intents,
    body.desktop-native-workbench .desktop-settings-diagnostics-action-list,
    body.desktop-native-workbench .desktop-settings-knowledge-toolbar,
    body.desktop-native-workbench .desktop-settings-quality-presets {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-settings-knowledge-toolbar {
      align-items: center;
      justify-content: space-between;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: var(--radius-lg, 12px);
      padding: 12px 14px;
      background: var(--surface-soft, #f5f0e8);
    }

    body.desktop-native-workbench .desktop-settings-knowledge-enabled {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: var(--text, #141413);
      font: 500 13px/1.3 var(--font-sans);
    }

    body.desktop-native-workbench .desktop-settings-knowledge-toolbar button,
    body.desktop-native-workbench .desktop-settings-quality-presets button {
      min-height: 34px;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: var(--radius-md, 8px);
      padding: 0 12px;
      background: var(--panel, #faf9f5);
      color: var(--text, #141413);
      font: 600 13px/1.2 var(--font-sans);
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-settings-knowledge-stages {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr);
      gap: 10px;
      min-width: 0;
      margin: 0;
      padding: 0;
      list-style: none;
    }

    body.desktop-native-workbench .desktop-settings-knowledge-stages li {
      display: grid;
      gap: 4px;
      min-width: 0;
      border: 1px solid var(--border-subtle, #ebe6df);
      border-radius: var(--radius-md, 8px);
      padding: 10px;
      background: var(--surface-soft, #f5f0e8);
      color: var(--text, #141413);
      font: 500 13px/1.3 var(--font-sans);
      text-transform: capitalize;
    }

    body.desktop-native-workbench .desktop-settings-knowledge-stage-marker {
      display: inline-grid;
      place-items: center;
      width: 22px;
      height: 22px;
      border-radius: var(--radius-full, 9999px);
      background: var(--surface-dark, #181715);
      color: var(--on-dark, #faf9f5);
      font: 600 11px/1 var(--font-sans);
    }

    body.desktop-native-workbench .desktop-settings-knowledge-page[data-knowledge-disabled="true"] .desktop-settings-knowledge-stages li {
      color: var(--text-muted, #6c6a64);
    }

    body.desktop-native-workbench .desktop-settings-runtime-intents button[data-active="true"] {
      border-color: var(--accent, #cc785c);
      background: var(--accent-soft, rgba(204, 120, 92, 0.12));
      color: var(--accent, #cc785c);
    }

    body.desktop-native-workbench .desktop-settings-field {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(220px, 320px);
      align-items: center;
      gap: 22px;
      margin: 0;
      border-top: 1px solid var(--border-subtle, #ebe6df);
      padding: 14px 18px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-settings-task-card .desktop-settings-field {
      grid-template-columns: minmax(0, 1fr);
      border: 0;
      border-radius: 0;
      padding: 0;
      background: transparent;
    }

    body.desktop-native-workbench .desktop-settings-task-card .desktop-settings-readonly-value {
      justify-self: start;
      text-align: left;
    }

    body.desktop-native-workbench .desktop-settings-field[data-highlighted="true"] {
      border-color: var(--accent, #cc785c);
      box-shadow: 0 0 0 3px var(--accent-glow, rgba(204, 120, 92, 0.15));
    }

    body.desktop-native-workbench .desktop-settings-field-copy {
      display: grid;
      gap: 5px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-settings-field label {
      color: var(--text, #141413);
      font: 500 13px/1.35 var(--font-sans);
    }

    body.desktop-native-workbench .desktop-settings-field-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-settings-field-chip {
      width: max-content;
      max-width: 100%;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: 999px;
      padding: 2px 7px;
      background: var(--panel, #faf9f5);
      color: var(--text-muted, #6c6a64);
      font: 500 11px/1.2 var(--font-sans);
      overflow-wrap: anywhere;
    }

    body.desktop-native-workbench .desktop-settings-field-chip[data-kind="required"] {
      border-color: var(--accent, #cc785c);
      color: var(--accent, #cc785c);
    }

    body.desktop-native-workbench .desktop-settings-field-chip[data-kind="readonly"],
    body.desktop-native-workbench .desktop-settings-field-chip[data-kind="readonly"] + .desktop-settings-field-chip {
      color: var(--text-muted, #6c6a64);
    }

    body.desktop-native-workbench .desktop-settings-advanced-fields {
      display: grid;
      min-width: 0;
      border-top: 1px solid var(--border-subtle, #ebe6df);
    }

    body.desktop-native-workbench .desktop-settings-advanced-fields summary {
      min-height: 38px;
      padding: 10px 18px;
      color: var(--text, #141413);
      font: 600 12px/1.3 var(--font-sans);
      cursor: pointer;
      list-style-position: inside;
    }

    body.desktop-native-workbench .desktop-settings-advanced-fields p {
      margin: 0;
      padding: 0 18px 14px;
      color: var(--text-muted, #6c6a64);
      font: 500 12px/1.45 var(--font-sans);
    }

    body.desktop-native-workbench .desktop-settings-field input,
    body.desktop-native-workbench .desktop-settings-field select,
    body.desktop-native-workbench .desktop-settings-field textarea {
      width: 100%;
      min-width: 0;
      min-height: 40px;
      padding: 10px 12px;
    }

    body.desktop-native-workbench .desktop-settings-readonly-value {
      min-width: 0;
      color: var(--text-muted, #6c6a64);
      font: 500 13px/1.35 var(--font-sans);
      overflow-wrap: anywhere;
      justify-self: end;
      text-align: right;
    }

    body.desktop-native-workbench .desktop-settings-field input[type="checkbox"] {
      width: 18px;
      min-height: 18px;
      padding: 0;
      justify-self: end;
    }

    body.desktop-native-workbench .desktop-settings-field-notice {
      display: block;
      margin-top: 6px;
      color: var(--text-muted, #6c6a64);
      font: 600 11px/1.35 var(--font-sans);
    }

    body.desktop-native-workbench .desktop-settings-switch {
      display: inline-grid;
      grid-template-columns: 46px minmax(24px, auto);
      align-items: center;
      justify-self: end;
      gap: 8px;
      width: max-content;
      min-width: 82px;
      min-height: 32px;
      border: 0;
      padding: 0;
      background: transparent;
      color: var(--text-muted, #6c6a64);
      font: 700 11px/1.2 var(--font-sans);
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-settings-switch:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }

    body.desktop-native-workbench .desktop-settings-switch-track {
      position: relative;
      display: block;
      width: 46px;
      height: 26px;
      border-radius: 9999px;
      background: var(--surface-cream-strong, #e8e0d2);
      box-shadow: inset 0 0 0 1px rgba(20, 20, 19, 0.08);
      transition: background 160ms ease, box-shadow 160ms ease;
    }

    body.desktop-native-workbench .desktop-settings-switch-thumb {
      position: absolute;
      top: 3px;
      left: 3px;
      width: 20px;
      height: 20px;
      border-radius: 9999px;
      background: var(--panel, #faf9f5);
      box-shadow: 0 1px 4px rgba(20, 20, 19, 0.18);
      transition: transform 160ms ease;
    }

    body.desktop-native-workbench .desktop-settings-switch[data-state="on"] {
      color: var(--text, #141413);
    }

    body.desktop-native-workbench .desktop-settings-switch[data-state="on"] .desktop-settings-switch-track {
      background: var(--accent, #cc785c);
      box-shadow: inset 0 0 0 1px rgba(153, 74, 49, 0.48);
    }

    body.desktop-native-workbench .desktop-settings-switch[data-state="on"] .desktop-settings-switch-thumb {
      transform: translateX(20px);
    }

    body.desktop-native-workbench .desktop-settings-field textarea {
      min-height: 76px;
      resize: vertical;
    }

    body.desktop-native-workbench .desktop-settings-field input[aria-invalid="true"],
    body.desktop-native-workbench .desktop-settings-field select[aria-invalid="true"],
    body.desktop-native-workbench .desktop-settings-field textarea[aria-invalid="true"] {
      border-color: var(--danger, #c64545);
      box-shadow: 0 0 0 2px var(--danger-soft, rgba(198, 69, 69, 0.12));
    }

    body.desktop-native-workbench .desktop-settings-field-error,
    body.desktop-native-workbench .desktop-settings-provider-setup-error {
      margin: 4px 0 0;
      color: var(--danger, #c64545);
      font: 500 12px/1.35 var(--font-sans);
    }

    body.desktop-native-workbench .desktop-settings-provider-setup {
      display: grid;
      gap: 10px;
      min-width: 0;
      border: 1px solid var(--accent, #cc785c);
      border-radius: var(--radius-lg, 12px);
      padding: 14px;
      background: var(--accent-soft, rgba(204, 120, 92, 0.12));
    }

    body.desktop-native-workbench .desktop-settings-provider-setup-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    body.desktop-native-workbench .desktop-settings-provider-setup input {
      min-height: 34px;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: var(--radius-md, 8px);
      padding: 0 10px;
      background: var(--panel, #faf9f5);
      color: var(--text, #141413);
      font: 500 13px/1.35 var(--font-sans);
    }

    body.desktop-native-workbench .desktop-settings-provider-setup button {
      min-height: 32px;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: var(--radius-md, 8px);
      padding: 0 12px;
      background: var(--panel, #faf9f5);
      color: var(--text, #141413);
      font: 600 12px/1.2 var(--font-sans);
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-settings-provider-setup button[data-desktop-settings-provider-setup-action="create"] {
      border-color: var(--accent, #cc785c);
      background: var(--accent, #cc785c);
      color: var(--on-primary, #ffffff);
    }

    body.desktop-native-workbench .desktop-settings-actions button:focus-visible,
    body.desktop-native-workbench .desktop-settings-files-actions button:focus-visible,
    body.desktop-native-workbench .desktop-settings-channels-summary button:focus-visible,
    body.desktop-native-workbench .desktop-settings-runtime-summary button:focus-visible,
    body.desktop-native-workbench .desktop-settings-diagnostics-actions button:focus-visible,
    body.desktop-native-workbench .desktop-settings-secret-controls button:focus-visible,
    body.desktop-native-workbench .desktop-settings-save-status-button:focus-visible,
    body.desktop-native-workbench .desktop-settings-search:focus-visible,
    body.desktop-native-workbench .desktop-settings-provider-search:focus-visible,
    body.desktop-native-workbench .desktop-settings-provider-icon-button:focus-visible,
    body.desktop-native-workbench .desktop-settings-provider-add:focus-visible,
    body.desktop-native-workbench .desktop-settings-provider-advanced:focus-visible,
    body.desktop-native-workbench .desktop-settings-provider-card-actions button:focus-visible,
    body.desktop-native-workbench .desktop-settings-capability-card:focus-visible,
    body.desktop-native-workbench .desktop-settings-switch:focus-visible,
    body.desktop-native-workbench .desktop-settings-nav-item:focus-visible,
    body.desktop-native-workbench .desktop-settings-inline-field select:focus-visible,
    body.desktop-native-workbench .desktop-settings-inline-field input:focus-visible,
    body.desktop-native-workbench .desktop-settings-field input:focus-visible,
    body.desktop-native-workbench .desktop-settings-field select:focus-visible,
    body.desktop-native-workbench .desktop-settings-field textarea:focus-visible {
      outline: 2px solid var(--accent-glow-strong, rgba(204, 120, 92, 0.24));
      outline-offset: 2px;
    }

    @media (max-width: 980px) {
      body.desktop-native-workbench .desktop-settings-pane {
        grid-template-columns: minmax(0, 1fr);
        gap: 22px;
      }

      body.desktop-native-workbench .desktop-settings-sidebar {
        position: static;
      }

      body.desktop-native-workbench .desktop-settings-field {
        grid-template-columns: minmax(0, 1fr);
      }

      body.desktop-native-workbench .desktop-settings-default-llm-card {
        padding: 24px;
      }

      body.desktop-native-workbench .desktop-settings-capability-map {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      body.desktop-native-workbench .desktop-settings-default-llm-form,
      body.desktop-native-workbench .desktop-settings-provider-grid,
      body.desktop-native-workbench .desktop-settings-provider-tools {
        grid-template-columns: minmax(0, 1fr);
      }

      body.desktop-native-workbench .desktop-settings-provider-header {
        align-items: stretch;
        flex-direction: column;
      }

      body.desktop-native-workbench .desktop-settings-header,
      body.desktop-native-workbench .desktop-settings-save-region {
        align-items: stretch;
        flex-direction: column;
      }

      body.desktop-native-workbench .desktop-settings-field input[type="checkbox"] {
        justify-self: start;
      }

      body.desktop-native-workbench .desktop-settings-default-ai-layout,
      body.desktop-native-workbench .desktop-settings-field-pair,
      body.desktop-native-workbench .desktop-settings-response-grid,
      body.desktop-native-workbench .desktop-settings-knowledge-core-layout,
      body.desktop-native-workbench .desktop-settings-knowledge-stages {
        grid-template-columns: minmax(0, 1fr);
      }
    }

    @media (max-width: 720px) {
      body.desktop-native-workbench .desktop-settings-capability-map {
        grid-template-columns: minmax(0, 1fr);
      }
    }

    body.desktop-native-workbench .desktop-status-strip {
      border-top: 1px solid #e9e4df;
      padding: 12px 28px;
      background: #fbfaf7;
      color: #55504b;
      font-size: 12px;
    }

    body.desktop-native-workbench .desktop-inspector-content {
      display: grid;
      grid-template-rows: minmax(0, 1fr);
      grid-auto-rows: min-content;
      gap: 0;
      height: 100%;
      min-height: 0;
      padding: 0;
      overflow-y: hidden;
      overflow-x: hidden;
      background: #fbfaf7;
    }

    body.desktop-native-workbench .desktop-run-chain-overview {
      display: grid;
      grid-template-rows: auto auto auto minmax(0, 1fr) auto;
      gap: 8px;
      height: 100%;
      min-width: 0;
      min-height: 0;
      padding: 14px 16px 12px;
      overflow: hidden;
      background: transparent;
    }

    body.desktop-native-workbench .desktop-run-chain-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      min-width: 0;
      padding-bottom: 2px;
    }

    body.desktop-native-workbench .desktop-run-chain-header h2,
    body.desktop-native-workbench .desktop-run-chain-panel-section h3 {
      margin: 0;
      color: #1f1d1a;
      font-family: var(--font-sans);
      font-size: 16px;
      font-weight: 650;
      line-height: 1.2;
      letter-spacing: 0;
      text-transform: none;
    }

    body.desktop-native-workbench .desktop-run-chain-header-controls {
      display: flex;
      gap: 6px;
    }

    body.desktop-native-workbench .desktop-run-chain-icon-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 28px;
      border: 1px solid transparent;
      border-radius: 6px;
      padding: 0 8px;
      background: transparent;
      color: #55504b;
      font: 600 11px/1 var(--font-sans);
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-run-chain-icon-button[data-button-variant="ghost"] {
      border-color: transparent;
      background: transparent;
      color: #77716a;
    }

    body.desktop-native-workbench .desktop-run-chain-icon-button[data-button-variant="ghost"]:hover,
    body.desktop-native-workbench .desktop-run-chain-icon-button[data-button-variant="ghost"]:focus-visible {
      background: #f2eee8;
      color: #262522;
    }

    body.desktop-native-workbench .desktop-run-chain-icon-button[aria-pressed="true"] {
      border-color: rgba(217, 104, 76, 0.35);
      background: rgba(217, 104, 76, 0.1);
      color: var(--primary);
    }

    body.desktop-native-workbench .desktop-run-chain-summary-strip {
      display: flex;
      flex-wrap: nowrap;
      flex-flow: row nowrap !important;
      gap: 4px;
      min-width: 0;
      max-width: 100%;
      overflow-x: auto;
      overflow-y: hidden;
      scrollbar-width: none;
    }

    body.desktop-native-workbench .desktop-run-chain-summary-strip::-webkit-scrollbar {
      display: none;
    }

    body.desktop-native-workbench .desktop-run-chain-summary-strip .n-space-item {
      margin-bottom: 0 !important;
    }

    body.desktop-native-workbench .desktop-run-chain-summary-strip > * {
      flex: 0 0 auto;
    }

    body.desktop-native-workbench .desktop-run-chain-summary-item {
      display: inline-flex;
      align-items: center;
      justify-content: flex-start;
      gap: 5px;
      flex: 0 0 auto;
      min-width: max-content;
      min-height: 24px;
      border: 0;
      border-radius: 999px;
      padding: 0 7px;
      overflow: hidden;
      background: #f4eee8;
      color: #625d57;
      font: 650 10px/1.2 var(--font-sans);
      text-align: left;
      text-overflow: ellipsis;
      white-space: nowrap;
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-run-chain-summary-item span:last-child {
      overflow: hidden;
      text-overflow: ellipsis;
    }

    body.desktop-native-workbench .desktop-run-chain-status-pill[data-status-tone="connected"] {
      background: #eff8f2;
      color: #28694b;
    }

    body.desktop-native-workbench .desktop-run-chain-status-pill[data-status-tone="muted"] {
      background: #f5f1ec;
      color: #77716a;
    }

    body.desktop-native-workbench .desktop-run-chain-status-pill[data-status-tone="attention"] {
      background: #fff4e0;
      color: #8a5520;
    }

    body.desktop-native-workbench .desktop-run-chain-status-dot {
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: #2f9b62;
      box-shadow: 0 0 0 2px rgba(47, 155, 98, 0.13);
    }

    body.desktop-native-workbench .desktop-run-chain-tabs {
      display: flex;
      flex-wrap: nowrap;
      flex-flow: row nowrap !important;
      gap: 3px;
      min-width: 0;
      max-width: 100%;
      overflow-x: auto;
      overflow-y: hidden;
      scrollbar-width: none;
      border: 1px solid #ebe3dc;
      border-radius: 7px;
      padding: 3px;
      background: #f8f4ef;
    }

    body.desktop-native-workbench .desktop-run-chain-tabs::-webkit-scrollbar {
      display: none;
    }

    body.desktop-native-workbench .desktop-run-chain-tabs .n-space-item {
      margin-bottom: 0 !important;
    }

    body.desktop-native-workbench .desktop-run-chain-tabs > * {
      flex: 0 0 auto;
    }

    body.desktop-native-workbench .desktop-run-chain-tab {
      flex: 0 0 auto;
      min-width: max-content;
      min-height: 30px;
      border: 0;
      border-radius: 6px;
      padding: 0 7px;
      background: transparent;
      color: #625d57;
      font: 650 11px/1.2 var(--font-sans);
      white-space: nowrap;
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-run-chain-tab[aria-selected="true"] {
      background: #ffffff;
      color: #1f1d1a;
      box-shadow: 0 1px 1px rgba(20, 20, 19, 0.04);
    }

    body.desktop-native-workbench .desktop-run-chain-panel {
      display: grid;
      align-content: start;
      gap: 8px;
      min-width: 0;
      overflow: auto;
    }

    body.desktop-native-workbench .desktop-run-chain-panel-section {
      display: grid;
      gap: 7px;
      min-width: 0;
      border: 1px solid #ebe3dc;
      border-radius: 6px;
      padding: 10px 11px;
      background: #fffdf9;
      box-shadow: none;
    }

    body.desktop-native-workbench .desktop-run-chain-card-row {
      margin: 0;
      color: #77716a;
      font: 500 11px/1.45 var(--font-sans);
      overflow-wrap: anywhere;
    }

    body.desktop-native-workbench .desktop-run-chain-empty-state {
      margin: 2px 0 0;
      border-radius: 7px;
      padding: 8px 9px;
      background: #f7f2ed;
      color: #77716a;
      font: 500 12px/1.35 var(--font-sans);
    }

    body.desktop-native-workbench .desktop-run-chain-actions {
      display: flex;
      justify-content: stretch;
      gap: 8px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-run-chain-actions .desktop-run-chain-panel-action {
      flex: 1 1 auto;
    }

    body.desktop-native-workbench .desktop-run-chain-panel-action,
    body.desktop-native-workbench .desktop-run-chain-approval-item,
    body.desktop-native-workbench .desktop-run-chain-feed-item,
    body.desktop-native-workbench .desktop-run-chain-new-item {
      min-height: 32px;
      border: 1px solid #e2d9d2;
      border-radius: 6px;
      padding: 0 10px;
      background: #ffffff;
      color: #262522;
      font: 700 12px/1.2 var(--font-sans);
      text-align: center;
      text-decoration: none;
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-run-chain-panel-action[data-button-variant="primary"] {
      border-color: var(--primary);
      background: var(--primary);
      color: #ffffff;
    }

    body.desktop-native-workbench .desktop-run-chain-panel-action[data-button-variant="secondary"],
    body.desktop-native-workbench .desktop-run-chain-new-item[data-button-variant="secondary"] {
      border-color: #e2d9d2;
      background: #ffffff;
      color: #3f3a35;
    }

    body.desktop-native-workbench .desktop-run-chain-panel-action[data-button-variant="ghost"] {
      border-color: transparent;
      background: transparent;
      color: #77716a;
    }

    body.desktop-native-workbench .desktop-run-chain-feed-item {
      overflow: hidden;
      text-align: left;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    body.desktop-native-workbench .desktop-run-chain-approval-list {
      gap: 8px;
    }

    body.desktop-native-workbench .desktop-run-chain-approval-item {
      display: grid;
      gap: 3px;
      justify-items: start;
      width: 100%;
      min-height: 46px;
      padding: 8px 10px;
      text-align: left;
      white-space: normal;
    }

    body.desktop-native-workbench .desktop-run-chain-approval-title,
    body.desktop-native-workbench .desktop-run-chain-approval-detail {
      min-width: 0;
      max-width: 100%;
      overflow-wrap: anywhere;
    }

    body.desktop-native-workbench .desktop-run-chain-approval-title {
      color: #262522;
      font: 700 12px/1.25 var(--font-sans);
    }

    body.desktop-native-workbench .desktop-run-chain-approval-detail {
      color: #77716a;
      font: 500 11px/1.35 var(--font-sans);
    }

    body.desktop-native-workbench .desktop-bottom-content {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(220px, 320px);
      gap: 0;
      height: 100%;
      min-width: 0;
      min-height: 0;
    }

    body.desktop-native-workbench .desktop-task-center {
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr);
      gap: 8px;
      min-width: 0;
      min-height: 0;
      padding: 12px;
      border-right: 1px solid var(--border, #e6dfd8);
    }

    body.desktop-native-workbench .desktop-task-center h2,
    body.desktop-native-workbench .desktop-task-center-summary,
    body.desktop-native-workbench .desktop-task-center-empty {
      margin: 0;
    }

    body.desktop-native-workbench .desktop-task-center h2 {
      font-size: 12px;
      line-height: 1.2;
      text-transform: uppercase;
      letter-spacing: 0;
    }

    body.desktop-native-workbench .desktop-task-center-summary,
    body.desktop-native-workbench .desktop-task-center-empty,
    body.desktop-native-workbench .desktop-task-center-detail,
    body.desktop-native-workbench .desktop-task-center-diagnostics {
      color: var(--text-muted, #6c6a64);
      font-size: 11px;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }

    body.desktop-native-workbench .desktop-task-center-list {
      display: grid;
      gap: 6px;
      max-height: 148px;
      min-width: 0;
      overflow: auto;
    }

    body.desktop-native-workbench .desktop-task-center-item {
      display: grid;
      gap: 6px;
      min-width: 0;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: 6px;
      padding: 8px;
      background: var(--panel-strong, #efe9de);
    }

    body.desktop-native-workbench .desktop-task-center-item[data-desktop-task-state="failed"] {
      border-color: var(--danger, #c64545);
    }

    body.desktop-native-workbench .desktop-task-center-item[data-desktop-task-state="blocked"] {
      border-color: var(--warning, #d4a017);
    }

    body.desktop-native-workbench .desktop-task-center-item[data-desktop-task-state="completed"] {
      opacity: 0.82;
    }

    body.desktop-native-workbench .desktop-task-center-diagnostics:not(:empty) {
      border-radius: 6px;
      padding: 6px 8px;
      background: var(--surface-dark-soft, #1f1e1b);
      color: var(--on-dark-soft, #a09d96);
      font-family: var(--font-mono, ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace);
    }

    body.desktop-native-workbench .desktop-task-center-item-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-task-center-item-heading h2 {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    body.desktop-native-workbench .desktop-task-state-badge {
      flex: 0 0 auto;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: 6px;
      padding: 2px 6px;
      color: var(--text-muted, #6c6a64);
      font-size: 10px;
      line-height: 1.2;
      text-transform: uppercase;
    }

    body.desktop-native-workbench .desktop-task-center-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-task-action {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 28px;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: 6px;
      padding: 0 8px;
      background: var(--panel, #faf9f5);
      color: var(--text, #141413);
      font: 600 11px/1.2 var(--font-sans, system-ui, sans-serif);
      text-decoration: none;
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-gateway-runtime {
      min-width: 0;
      overflow: auto;
      background: var(--panel);
      color: var(--text);
    }

    body.desktop-native-workbench .desktop-gateway-runtime h2 {
      color: var(--text);
    }

    body.desktop-native-workbench .desktop-gateway-runtime-row {
      color: var(--text-muted);
      white-space: pre-wrap;
    }

    body.desktop-native-workbench .desktop-gateway-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-gateway-action {
      min-height: 28px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 0 8px;
      background: var(--bg);
      color: var(--text);
      font: 600 11px/1.2 var(--font-sans);
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-gateway-action:focus-visible {
      outline: 2px solid var(--primary, #cc785c);
      outline-offset: 2px;
    }

    body.desktop-native-workbench .desktop-workbench-section {
      display: grid;
      gap: 8px;
      padding: 12px;
      border-bottom: 1px solid var(--border, #e6dfd8);
    }

    body.desktop-native-workbench .desktop-workbench-section h2 {
      margin: 0;
      font-size: 12px;
      line-height: 1.2;
      text-transform: uppercase;
      letter-spacing: 0;
    }

    body.desktop-native-workbench .desktop-cowork-cockpit {
      grid-template-columns: minmax(160px, 220px) minmax(220px, 1fr) minmax(180px, 260px);
      align-items: start;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-cowork-unavailable {
      grid-column: 1 / -1;
      display: grid;
      gap: 8px;
      max-width: 520px;
      min-height: 220px;
      align-content: center;
      justify-self: center;
      text-align: center;
      color: var(--text, #1f1d1b);
    }

    body.desktop-native-workbench .desktop-cowork-unavailable h2 {
      font-size: 20px;
      text-transform: none;
    }

    body.desktop-native-workbench .desktop-cowork-unavailable p {
      margin: 0;
      color: var(--muted, #7d746c);
    }

    body.desktop-native-workbench .desktop-cowork-unavailable-kicker {
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      color: var(--primary, #cc785c);
    }

    body.desktop-native-workbench .desktop-cowork-cockpit > h2 {
      grid-column: 1 / -1;
    }

    body.desktop-native-workbench .desktop-cowork-sessions,
    body.desktop-native-workbench .desktop-cowork-header,
    body.desktop-native-workbench .desktop-cowork-actions,
    body.desktop-native-workbench .desktop-cowork-graph,
    body.desktop-native-workbench .desktop-cowork-observability,
    body.desktop-native-workbench .desktop-cowork-inspector,
    body.desktop-native-workbench .desktop-cowork-task-feed {
      display: grid;
      gap: 6px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-cowork-sessions,
    body.desktop-native-workbench .desktop-cowork-actions {
      grid-column: 1;
    }

    body.desktop-native-workbench .desktop-cowork-header,
    body.desktop-native-workbench .desktop-cowork-graph,
    body.desktop-native-workbench .desktop-cowork-observability {
      grid-column: 2;
    }

    body.desktop-native-workbench .desktop-cowork-inspector,
    body.desktop-native-workbench .desktop-cowork-task-feed {
      grid-column: 3;
    }

    body.desktop-native-workbench .desktop-cowork-session-row,
    body.desktop-native-workbench .desktop-cowork-action,
    body.desktop-native-workbench .desktop-cowork-observability-tab,
    body.desktop-native-workbench .desktop-cowork-graph-node {
      min-width: 0;
      min-height: 30px;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: 6px;
      padding: 0 8px;
      overflow: hidden;
      background: var(--panel, #faf9f5);
      color: var(--text, #141413);
      font: 600 11px/1.25 var(--font-sans, system-ui, sans-serif);
      text-align: left;
      text-overflow: ellipsis;
      white-space: nowrap;
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-cowork-observability-tabs {
      display: flex;
      gap: 6px;
      min-width: 0;
      overflow: auto;
      padding-bottom: 2px;
    }

    body.desktop-native-workbench .desktop-cowork-observability-tab {
      flex: 0 0 auto;
      max-width: 140px;
    }

    body.desktop-native-workbench .desktop-cowork-observability-tab[aria-selected="true"] {
      border-color: var(--primary, #cc785c);
      background: var(--panel-strong, #efe9de);
    }

    body.desktop-native-workbench .desktop-cowork-observability-filter {
      min-width: 0;
      width: 100%;
      min-height: 30px;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: 6px;
      padding: 0 8px;
      background: var(--panel, #faf9f5);
      color: var(--text, #141413);
      font: 12px/1.35 var(--font-sans, system-ui, sans-serif);
      letter-spacing: 0;
    }

    body.desktop-native-workbench .desktop-cowork-observability-panel {
      display: grid;
      gap: 5px;
      min-width: 0;
      max-height: min(320px, 40vh);
      overflow: auto;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: 6px;
      padding: 8px;
      background: var(--panel, #faf9f5);
    }

    body.desktop-native-workbench .desktop-cowork-observability-panel p {
      min-width: 0;
      margin: 0;
      overflow-wrap: anywhere;
      font: 12px/1.35 var(--font-sans, system-ui, sans-serif);
    }

    body.desktop-native-workbench .desktop-cowork-limit-status {
      color: var(--muted, #6b655c);
      font-size: 11px;
    }

    body.desktop-native-workbench .desktop-cowork-action-input {
      min-width: 0;
      width: 100%;
      min-height: 58px;
      resize: vertical;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: 6px;
      padding: 7px 8px;
      background: var(--panel, #faf9f5);
      color: var(--text, #141413);
      font: 12px/1.35 var(--font-sans, system-ui, sans-serif);
      letter-spacing: 0;
    }

    body.desktop-native-workbench .desktop-cowork-action-status,
    body.desktop-native-workbench .desktop-cowork-action-summary,
    body.desktop-native-workbench .desktop-cowork-blueprint-diagnostics {
      min-width: 0;
      margin: 0;
      overflow: hidden;
      color: var(--muted, #6b655c);
      font: 12px/1.35 var(--font-sans, system-ui, sans-serif);
      text-overflow: ellipsis;
    }

    body.desktop-native-workbench .desktop-run-chain-inspector {
      grid-template-rows: auto auto minmax(0, 1fr) auto;
      min-height: 0;
    }

    body.desktop-native-workbench .desktop-run-chain-list {
      display: grid;
      gap: 6px;
      min-height: 0;
      max-height: min(320px, 42vh);
      overflow: auto;
    }

    body.desktop-native-workbench .desktop-run-chain-item {
      min-width: 0;
      min-height: 32px;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: 6px;
      padding: 6px 8px;
      overflow: hidden;
      background: var(--panel, #faf9f5);
      color: var(--text, #141413);
      font: 12px/1.35 var(--font-sans, system-ui, sans-serif);
      text-align: left;
      text-overflow: ellipsis;
      white-space: nowrap;
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-run-chain-item[aria-selected="true"] {
      border-color: var(--primary, #cc785c);
      background: var(--panel-strong, #efe9de);
    }

    body.desktop-native-workbench .desktop-run-chain-item:focus-visible {
      outline: 2px solid var(--primary, #cc785c);
      outline-offset: 2px;
    }

    body.desktop-native-workbench .desktop-run-chain-detail {
      min-width: 0;
      overflow: auto;
      border-radius: 6px;
      padding: 8px;
      background: var(--surface-dark-soft, #1f1e1b);
      color: var(--on-dark, #faf9f5);
    }

    body.desktop-native-workbench .desktop-run-chain-detail p {
      color: var(--on-dark-soft, #a09d96);
      font-family: var(--font-mono, ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace);
    }

    body.desktop-native-workbench .desktop-status-strip {
      height: 0;
      overflow: hidden;
      padding: 0;
      color: var(--text-muted, #6c6a64);
      font-size: 11px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    body.desktop-native-workbench .desktop-workbench-bottom {
      grid-column: 2 / span 3;
      width: auto;
      height: var(--desktop-bottom-size, var(--region-size));
      border-top: 1px solid var(--border, #e6dfd8);
    }

    html[data-theme="dark"] body.desktop-native-workbench .desktop-workbench-shell,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-activity-rail,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-workbench-main,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-chat-workbench {
      color-scheme: dark;
      background: var(--bg);
      color: var(--text);
      border-color: var(--border);
    }

    html[data-theme="dark"] body.desktop-native-workbench .desktop-workbench-sidebar,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-workbench-inspector,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-workbench-bottom,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-sidebar-content,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-chat-header,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-conversation-thread,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-native-composer,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-utility-surfaces,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-inspector-content,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-pane,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-workspace-files,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-workspace-header,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-workspace-browser,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-workspace-detail-panel,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-workspace-editor-panel,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-workspace-action-rail,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-file-import-grid,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-file-import-card,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-file-session-card,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-file-operation-strip,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-status-strip {
      background: var(--panel);
      color: var(--text);
      border-color: var(--border);
    }

    html[data-theme="dark"] body.desktop-native-workbench .desktop-activity-button,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-activity-secondary-button,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-sidebar-row,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-sidebar-delete-session,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-workbench-link,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-panel-control,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-file-action,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-help-action,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-native-composer-action,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-native-composer-input,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-search,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-actions button,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-save-status-button,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-inline-field select,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-inline-field input,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-provider-search,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-provider-icon-button,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-provider-add,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-provider-card-actions button,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-files-actions button,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-channels-summary button,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-runtime-summary button,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-diagnostics-actions button,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-secret-controls button,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-provider-detail input,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-field input,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-field select,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-field textarea,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-workspace-file-row,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-workspace-search,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-workspace-editor,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-task-action,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-cowork-session-row,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-cowork-action,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-cowork-observability-tab,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-cowork-observability-filter,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-cowork-observability-panel,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-cowork-action-input,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-run-chain-item,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-run-chain-summary-item,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-run-chain-panel-action,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-run-chain-feed-item,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-run-chain-new-item,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-inspector-restore,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-gateway-action {
      background: var(--panel-strong);
      color: var(--text);
      border-color: var(--border);
    }

    html[data-theme="dark"] body.desktop-native-workbench .desktop-file-import-button {
      background: transparent;
      border-color: transparent;
    }

    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-status-card,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-group,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-sidebar,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-save-status,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-files-actions,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-channels-summary,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-runtime-summary,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-diagnostics-actions,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-mcp-server-list,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-secret-controls,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-capability-card,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-default-llm-card,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-provider-card {
      background: var(--panel-strong);
      border-color: var(--border);
    }

    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-status-item,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-field,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-files-actions,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-channels-summary,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-runtime-summary,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-diagnostics-actions,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-mcp-server-list,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-secret-controls {
      border-color: var(--border);
    }

    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-breadcrumb h2,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-card-heading h2,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-provider-header h2,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-provider-title h3,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-group h2,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-inline-field,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-field label,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-provider-detail strong,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-status-item strong {
      color: var(--text);
    }

    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-header p,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-summary p,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-field-description,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-group-description,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-default-llm-copy,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-provider-status,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-provider-detail,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-provider-advanced,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-status-item,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-save-status,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-files-actions p,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-channels-summary p,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-runtime-summary p,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-diagnostics-actions p,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-nav-heading {
      color: var(--muted);
    }

    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-nav-item {
      color: var(--text);
    }

    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-nav-item:hover,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-nav-item:focus-visible,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-nav-item[data-active="true"] {
      background: var(--panel-strong);
      color: var(--text);
    }

    html[data-theme="dark"] body.desktop-native-workbench .desktop-activity-button:hover,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-activity-button:focus-visible,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-activity-button[data-active="true"],
    html[data-theme="dark"] body.desktop-native-workbench .desktop-sidebar-chat-row[data-active="true"],
    html[data-theme="dark"] body.desktop-native-workbench .desktop-sidebar-row[data-active="true"],
    html[data-theme="dark"] body.desktop-native-workbench .desktop-sidebar-delete-session:hover,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-panel-control[aria-pressed="true"],
    html[data-theme="dark"] body.desktop-native-workbench .desktop-run-chain-tab[aria-selected="true"],
    html[data-theme="dark"] body.desktop-native-workbench .desktop-run-chain-icon-button[aria-pressed="true"],
    html[data-theme="dark"] body.desktop-native-workbench .desktop-run-chain-item[aria-selected="true"],
    html[data-theme="dark"] body.desktop-native-workbench .desktop-cowork-observability-tab[aria-selected="true"] {
      background: var(--accent-soft);
      color: var(--text-strong);
      border-color: var(--accent);
    }

    html[data-theme="dark"] body.desktop-native-workbench .desktop-sidebar-chat-row:hover {
      background: var(--panel-strong);
      border-color: var(--border);
    }

    html[data-theme="dark"] body.desktop-native-workbench .desktop-sidebar-row-meta,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-chat-context,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-empty-session p,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-workbench-section p,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-workspace-title-group p,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-workspace-status,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-workspace-updated-at,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-workspace-detail,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-command-palette-status,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-task-center-summary,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-task-center-detail,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-cowork-action-status,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-cowork-action-summary,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-run-chain-empty-state,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-run-chain-card-row,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-run-chain-approval-detail,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-gateway-runtime-row {
      color: var(--text-muted);
    }

    html[data-theme="dark"] body.desktop-native-workbench .desktop-run-chain-empty-state {
      background: var(--panel-strong);
    }

    html[data-theme="dark"] body.desktop-native-workbench .desktop-chat-workbench-chrome h2,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-chat-header h1,
    html[data-theme="dark"] body.desktop-native-workbench .n-text,
    html[data-theme="dark"] body.desktop-native-workbench .n-ellipsis,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-sidebar-row,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-sidebar-row-label,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-conversation-content,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-conversation-meta strong,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-native-composer-input,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-native-composer-model,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-message-references-title {
      color: var(--text);
    }

    html[data-theme="dark"] body.desktop-native-workbench .desktop-chat-workbench-chrome p,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-sidebar-section-heading h2,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-sidebar-section-action,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-conversation-meta,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-message-copy-button,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-native-composer-action,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-native-token-orb {
      color: var(--text-muted);
    }

    html[data-theme="dark"] body.desktop-native-workbench .n-card,
    html[data-theme="dark"] body.desktop-native-workbench .n-card > .n-card__content {
      background: transparent;
      color: var(--text);
      border-color: var(--border);
    }

    html[data-theme="dark"] body.desktop-native-workbench .n-button {
      color: var(--text);
    }

    html[data-theme="dark"] body.desktop-native-workbench .desktop-sidebar-search,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-chat-title-editor,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-chat-header-panel-button,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-chat-menu,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-chat-menu-popover,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-native-composer-model-menu,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-native-composer,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-native-token-orb {
      background: var(--panel-strong);
      color: var(--text);
      border-color: var(--border);
      box-shadow: none;
    }

    html[data-theme="dark"] body.desktop-native-workbench .desktop-chat-menu-action {
      color: var(--text);
    }

    html[data-theme="dark"] body.desktop-native-workbench .desktop-native-composer-model-menu-title {
      color: var(--text-muted);
    }

    html[data-theme="dark"] body.desktop-native-workbench .desktop-native-composer-model-option,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-native-composer-model-check {
      color: var(--text);
    }

    html[data-theme="dark"] body.desktop-native-workbench .desktop-chat-menu-empty {
      color: var(--text-muted);
    }

    html[data-theme="dark"] body.desktop-native-workbench .desktop-activity-secondary-button:hover,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-activity-secondary-button:focus-visible,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-workbench-link:hover,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-workbench-link:focus-visible,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-chat-menu:hover,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-chat-menu:focus-visible,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-chat-menu-action:hover,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-chat-menu-action:focus-visible,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-native-composer-model-option:hover,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-native-composer-model-option:focus-visible,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-chat-header-panel-button:hover,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-chat-header-panel-button:focus-visible,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-native-composer-model:hover,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-native-composer-model:focus-visible,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-native-composer-rag-toggle:hover,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-native-composer-rag-toggle[aria-pressed="true"] {
      background: var(--accent-soft);
      color: var(--text-strong);
      border-color: var(--accent);
    }

    html[data-theme="dark"] body.desktop-native-workbench .desktop-workbench-link[data-active="true"],
    html[data-theme="dark"] body.desktop-native-workbench .desktop-activity-button[data-active="true"],
    html[data-theme="dark"] body.desktop-native-workbench .desktop-activity-secondary-button[data-active="true"] {
      background: var(--accent-soft);
      color: var(--text-strong);
      border-color: var(--accent);
      box-shadow: none;
    }

    html[data-theme="dark"] body.desktop-native-workbench .desktop-native-composer-send:not(:disabled),
    html[data-theme="dark"] body.desktop-native-workbench .desktop-run-chain-panel-action[data-button-variant="primary"] {
      background: var(--accent);
      border-color: var(--accent);
      color: var(--on-primary);
    }

    html[data-theme="dark"] body.desktop-native-workbench .desktop-run-chain-status-pill[data-status-tone="connected"] {
      background: rgba(47, 155, 98, 0.16);
      color: #8ed3a8;
    }

    html[data-theme="dark"] body.desktop-native-workbench .desktop-run-chain-status-pill[data-status-tone="muted"] {
      background: var(--panel-strong);
      color: var(--text-muted);
    }

    html[data-theme="dark"] body.desktop-native-workbench .desktop-run-chain-status-pill[data-status-tone="attention"] {
      background: rgba(217, 104, 76, 0.18);
      color: #f0aa8a;
    }

    html[data-theme="dark"] body.desktop-native-workbench .desktop-run-chain-approval-title {
      color: var(--text-strong);
    }

    html[data-theme="dark"] body.desktop-native-workbench .desktop-task-center-diagnostics:not(:empty),
    html[data-theme="dark"] body.desktop-native-workbench .desktop-run-chain-detail {
      background: var(--surface-dark);
      color: var(--on-dark);
    }

    html[data-theme="dark"] body.desktop-native-workbench .desktop-task-center-diagnostics:not(:empty) p,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-run-chain-detail p {
      color: var(--on-dark-soft);
    }

    @media (prefers-reduced-motion: reduce) {
      body.desktop-native-workbench .desktop-conversation-layout,
      body.desktop-native-workbench .desktop-detail-panel-slot,
      body.desktop-native-workbench .desktop-tool-detail-panel {
        transition: none;
      }

      body.desktop-native-workbench .desktop-detail-panel-slot,
      body.desktop-native-workbench .desktop-tool-detail-panel,
      body.desktop-native-workbench .desktop-tool-detail-panel[data-tool-detail-motion="closing"] {
        transform: none;
      }
    }

    @media (max-width: 1020px) {
      body.desktop-native-workbench .desktop-workspace-files {
        grid-template-columns: minmax(180px, 240px) minmax(0, 1fr);
        grid-template-areas:
          "header header"
          "browser detail"
          "browser editor"
          "actions actions";
      }

      body.desktop-native-workbench .desktop-workspace-actions {
        grid-template-columns: repeat(4, minmax(0, 1fr));
      }

      body.desktop-native-workbench .desktop-file-import-grid,
      body.desktop-native-workbench .desktop-file-operation-strip {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }

    @media (max-width: 760px) {
      body.desktop-native-workbench .desktop-workbench-shell,
      body.desktop-native-workbench .desktop-workbench-shell[data-inspector-visible="false"] {
        grid-template-columns: 52px 0 minmax(0, 1fr) 0;
      }

      body.desktop-native-workbench .desktop-workbench-sidebar,
      body.desktop-native-workbench .desktop-workbench-inspector,
      body.desktop-native-workbench .desktop-workbench-bottom {
        display: none;
      }

      body.desktop-native-workbench .desktop-workbench-main {
        padding: 12px;
      }

      body.desktop-native-workbench .desktop-chat-header {
        min-height: 54px;
        width: min(var(--desktop-chat-column-width), 100%);
        padding: 0;
      }

      body.desktop-native-workbench .desktop-conversation-thread {
        width: 100%;
        padding: 0;
      }

      body.desktop-native-workbench .desktop-conversation-message {
        width: 100%;
      }

      body.desktop-native-workbench .desktop-native-composer {
        width: min(var(--desktop-chat-column-width), calc(100% - 28px));
      }

      body.desktop-native-workbench .desktop-native-composer-layout {
        grid-template-columns: 36px minmax(0, 1fr) 44px;
        grid-template-rows: auto auto;
        grid-template-areas: "input input input" "attach runtime send";
      }

      body.desktop-native-workbench .desktop-native-composer-runtime {
        display: flex;
      }

      body.desktop-native-workbench .desktop-native-composer-send {
      }

      body.desktop-native-workbench .desktop-empty-session {
        max-width: none;
      }

      body.desktop-native-workbench .desktop-workspace-files {
        grid-template-columns: minmax(0, 1fr);
        grid-template-areas:
          "header"
          "browser"
          "detail"
          "editor"
          "actions";
      }

      body.desktop-native-workbench .desktop-workspace-header {
        align-items: flex-start;
        flex-direction: column;
      }

      body.desktop-native-workbench .desktop-file-import-grid,
      body.desktop-native-workbench .desktop-file-operation-strip {
        grid-template-columns: minmax(0, 1fr);
      }

      body.desktop-native-workbench .desktop-file-import-card,
      body.desktop-native-workbench .desktop-file-session-card {
        border-right: 0;
        border-bottom: 1px solid var(--border, #e6dfd8);
      }
    }
  `;
  targetDocument.head.append(style);
}
