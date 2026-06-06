import hljs from "highlight.js";
import { marked } from "marked";
import { isAgentUiFormSubmittable, type AgentUiForm, type AgentUiFormField } from "./agentUiEvents";
import type { GatewayRuntimeStatus } from "./desktopGatewayStartup";
import {
  buildDesktopGatewayRuntimeActions,
  buildDesktopGatewayRuntimeDiagnostics,
  buildDesktopGatewayRuntimeRows,
  type DesktopGatewayRuntimeActionId,
} from "./desktopGatewayRuntimeControls";
import {
  DESKTOP_SHORTCUT_HELP_ITEMS,
  buildDesktopPageHelpText,
  resolveDesktopVisibleHelpTargets,
} from "./desktopHelp";
import {
  buildDesktopCoworkTaskOperation,
  buildDesktopCoworkCockpitView,
  type DesktopCoworkCockpitView,
  type DesktopCoworkActionInput,
  type DesktopCoworkSelectionType,
  type DesktopCoworkSessionRow,
} from "./desktopCowork";
import type { DesktopKnowledgePaneModel } from "./desktopKnowledgeTraceability";
import type { DesktopSettingsPaneModel } from "./desktopSettingsProviders";
import type { DesktopSkillEditorField, DesktopToolsSkillsPaneModel } from "./desktopToolsSkills";
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
} from "./desktopTaskCenter";
import {
  buildDesktopWorkLensProjection,
  DesktopWorkLensActionId,
  type DesktopWorkLensProjection,
  type DesktopWorkLensRelatedResource,
} from "./desktopWorkLens";
import type { WorkbenchLayoutState, WorkbenchPanelId, WorkbenchPanelState } from "./desktopWorkbenchLayout";
import { loadWorkbenchLayout } from "./desktopWorkbenchLayout";
import {
  buildNativeWorkbenchSidebarModel,
  type DesktopSidebarGroup,
  type DesktopSidebarItem,
} from "./desktopSharedModels";
import { installDesktopDesignTokens } from "./desktopDesignTokens";
import type { NativeChatMessage, NativeChatSession } from "./nativeChat";
import { mountAgentUiFormActionsIsland } from "./native-vue/agentUiFormActionsIsland";
import { mountAgentUiFormCardIsland } from "./native-vue/agentUiFormCardIsland";
import { mountAgentUiFormFieldIsland } from "./native-vue/agentUiFormFieldIsland";
import { mountAgentUiFormsSurfaceIsland } from "./native-vue/agentUiFormsSurfaceIsland";
import { mountBottomRegionIsland } from "./native-vue/bottomRegionIsland";
import { mountActivityRailIsland } from "./native-vue/activityRailIsland";
import { mountChatHeaderActionsIsland } from "./native-vue/chatHeaderActionsIsland";
import { mountChatMenuActionIsland } from "./native-vue/chatMenuActionIsland";
import { mountChatMenuButtonIsland } from "./native-vue/chatMenuButtonIsland";
import { mountChatMenuEmptyIsland } from "./native-vue/chatMenuEmptyIsland";
import { mountChatMenuPopoverIsland } from "./native-vue/chatMenuPopoverIsland";
import { mountChatTitleIsland } from "./native-vue/chatTitleIsland";
import { mountChatWorkbenchIsland } from "./native-vue/chatWorkbenchIsland";
import { mountCommandPaletteIsland } from "./native-vue/commandPaletteIsland";
import { mountComposerAttachButtonIsland } from "./native-vue/composerAttachButtonIsland";
import { mountComposerModelControlIsland } from "./native-vue/composerModelControlIsland";
import { mountComposerRuntimeIsland } from "./native-vue/composerRuntimeIsland";
import { mountComposerSendButtonIsland } from "./native-vue/composerSendButtonIsland";
import { mountComposerSurfaceIsland } from "./native-vue/composerSurfaceIsland";
import { mountConversationAttachmentIsland } from "./native-vue/conversationAttachmentIsland";
import { mountConversationBodyIsland } from "./native-vue/conversationBodyIsland";
import { mountConversationEmptyStateIsland } from "./native-vue/conversationEmptyStateIsland";
import { mountConversationMessageIsland } from "./native-vue/conversationMessageIsland";
import { mountConversationMetaIsland } from "./native-vue/conversationMetaIsland";
import { mountConversationReasoningIsland } from "./native-vue/conversationReasoningIsland";
import { mountConversationReferenceIsland } from "./native-vue/conversationReferenceIsland";
import { mountConversationThreadIsland } from "./native-vue/conversationThreadIsland";
import { mountCoworkActionsIsland } from "./native-vue/coworkActionsIsland";
import { mountCoworkDataRowIsland } from "./native-vue/coworkDataRowIsland";
import { mountCoworkGraphIsland } from "./native-vue/coworkGraphIsland";
import { mountCoworkHeaderIsland } from "./native-vue/coworkHeaderIsland";
import { mountCoworkInspectorIsland } from "./native-vue/coworkInspectorIsland";
import { mountCoworkLimitStatusIsland } from "./native-vue/coworkLimitStatusIsland";
import { mountCoworkObservabilityIsland } from "./native-vue/coworkObservabilityIsland";
import { mountCoworkPaneIsland } from "./native-vue/coworkPaneIsland";
import { mountCoworkSessionsIsland } from "./native-vue/coworkSessionsIsland";
import { mountCoworkTaskFeedIsland } from "./native-vue/coworkTaskFeedIsland";
import { mountFileActionsSurfaceIsland } from "./native-vue/fileActionsSurfaceIsland";
import { mountFileImportCardIsland } from "./native-vue/fileImportCardIsland";
import { mountFileOperationStatusIsland } from "./native-vue/fileOperationStatusIsland";
import { mountFileUploadStatusIsland } from "./native-vue/fileUploadStatusIsland";
import { mountFormatChipListIsland } from "./native-vue/formatChipListIsland";
import { mountGatewayRuntimeIsland } from "./native-vue/gatewayRuntimeIsland";
import { mountHeaderPanelControlIsland } from "./native-vue/headerPanelControlIsland";
import { mountHelpSurfaceIsland } from "./native-vue/helpSurfaceIsland";
import { mountInspectorRegionIsland } from "./native-vue/inspectorRegionIsland";
import { mountInspectorViewIsland } from "./native-vue/inspectorViewIsland";
import { mountKnowledgeActionsIsland } from "./native-vue/knowledgeActionsIsland";
import { mountKnowledgeDocumentDetailIsland } from "./native-vue/knowledgeDocumentDetailIsland";
import { mountKnowledgeDocumentsIsland } from "./native-vue/knowledgeDocumentsIsland";
import { mountKnowledgeGraphIsland } from "./native-vue/knowledgeGraphIsland";
import { mountKnowledgePaneIsland } from "./native-vue/knowledgePaneIsland";
import { mountKnowledgeQueryIsland } from "./native-vue/knowledgeQueryIsland";
import { mountKnowledgeReadinessIsland } from "./native-vue/knowledgeReadinessIsland";
import { mountKnowledgeReferenceRowIsland } from "./native-vue/knowledgeReferenceRowIsland";
import { mountMainUtilitiesRegionIsland } from "./native-vue/mainUtilitiesRegionIsland";
import { mountModuleWorkSectionIsland } from "./native-vue/moduleWorkSectionIsland";
import { mountPanelControlsIsland } from "./native-vue/panelControlsIsland";
import { mountPanelIconPartIsland } from "./native-vue/panelIconPartIsland";
import { mountPersistentRagToggleIsland } from "./native-vue/persistentRagToggleIsland";
import { mountQuickActionsIsland } from "./native-vue/quickActionsIsland";
import { mountRecentChatRowIsland } from "./native-vue/recentChatRowIsland";
import { mountRunChainInspectorIsland } from "./native-vue/runChainInspectorIsland";
import { mountRunChainOverviewIsland } from "./native-vue/runChainOverviewIsland";
import { mountSidebarActionsIsland } from "./native-vue/sidebarActionsIsland";
import { mountSidebarContentIsland } from "./native-vue/sidebarContentIsland";
import { mountSidebarRecentChatsIsland } from "./native-vue/sidebarRecentChatsIsland";
import { mountSidebarRowIsland } from "./native-vue/sidebarRowIsland";
import { mountSidebarSectionHeadingIsland } from "./native-vue/sidebarSectionHeadingIsland";
import { mountSidebarWorkspaceListIsland } from "./native-vue/sidebarWorkspaceListIsland";
import { mountSettingsDefaultLlmIsland } from "./native-vue/settingsDefaultLlmIsland";
import { mountSettingsGroupsIsland } from "./native-vue/settingsGroupsIsland";
import { mountSettingsPaneIsland } from "./native-vue/settingsPaneIsland";
import { mountSettingsProviderDetailIsland } from "./native-vue/settingsProviderDetailIsland";
import { mountSettingsProviderManagementIsland } from "./native-vue/settingsProviderManagementIsland";
import { mountSettingsSidebarIsland } from "./native-vue/settingsSidebarIsland";
import { mountSettingsStatusIsland } from "./native-vue/settingsStatusIsland";
import { mountSettingsStatusItemIsland } from "./native-vue/settingsStatusItemIsland";
import { mountOrUpdateSessionFileListIsland } from "./native-vue/sessionFileListIsland";
import { mountSessionUploadCardIsland } from "./native-vue/sessionUploadCardIsland";
import { mountSharedSidebarCommandButtonIsland } from "./native-vue/sharedSidebarCommandButtonIsland";
import { mountSharedSidebarCommandsIsland } from "./native-vue/sharedSidebarCommandsIsland";
import { mountSharedSidebarLinkIsland } from "./native-vue/sharedSidebarLinkIsland";
import { mountSharedSidebarLinksIsland } from "./native-vue/sharedSidebarLinksIsland";
import { mountShortcutHelpDialogIsland } from "./native-vue/shortcutHelpDialogIsland";
import { mountSkillEditorIsland } from "./native-vue/skillEditorIsland";
import { mountSkillDetailSummaryIsland } from "./native-vue/skillDetailSummaryIsland";
import { mountSkillsListIsland } from "./native-vue/skillsListIsland";
import { mountStatusStripIsland } from "./native-vue/statusStripIsland";
import { mountTaskActionIsland } from "./native-vue/taskActionIsland";
import { mountTaskCenterIsland } from "./native-vue/taskCenterIsland";
import { mountTaskStateBadgeIsland } from "./native-vue/taskStateBadgeIsland";
import { mountToolDetailIsland } from "./native-vue/toolDetailIsland";
import { mountToolActivitiesIsland } from "./native-vue/toolActivitiesIsland";
import { mountToolActivityIsland } from "./native-vue/toolActivityIsland";
import { mountToolActivitySectionIsland } from "./native-vue/toolActivitySectionIsland";
import { mountToolsListIsland } from "./native-vue/toolsListIsland";
import { mountToolsSkillsActionsIsland } from "./native-vue/toolsSkillsActionsIsland";
import { mountToolsSkillsPaneIsland } from "./native-vue/toolsSkillsPaneIsland";
import { mountTokenUsageOrbIsland } from "./native-vue/tokenUsageOrbIsland";
import { mountWorkLensIsland } from "./native-vue/workLensIsland";
import { mountWorkbenchPanelIsland } from "./native-vue/workbenchPanelIsland";
import { mountWorkspaceBrowserIsland } from "./native-vue/workspaceBrowserIsland";

const desktopPinnedChatSessions = new WeakMap<Document, Set<string>>();

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
  onNewChat?: () => void;
  onDeleteSession?: (event: DesktopNativeChatDeleteSessionEvent) => void;
  onPinSession?: (event: DesktopNativeChatPinSessionEvent) => void;
  onRenameSession?: (event: DesktopNativeChatRenameSessionEvent) => void;
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

export type DesktopSettingsActionId = "save" | "discoverModels" | "edit";

export type DesktopSettingsActionEvent =
  | {
      action: "save" | "discoverModels";
      pane: DesktopSettingsPaneModel;
    }
  | {
      action: "edit";
      pane: DesktopSettingsPaneModel;
      fieldId: string;
      value: string | boolean;
    };

interface DesktopSettingsActionOptions {
  onSettingsAction?: (event: DesktopSettingsActionEvent) => void;
}

export type DesktopKnowledgeActionId = "runQuery" | "refreshGraph" | "rebuildIndex" | "deleteDocument" | "uploadDocument";

export interface DesktopKnowledgeActionEvent {
  action: DesktopKnowledgeActionId;
  pane: DesktopKnowledgePaneModel;
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
  | "validateBlueprint"
  | "addTask"
  | "task"
  | "workUnit"
  | "selectBranch"
  | "selectBranchResult"
  | "mergeBranchResults"
>;

export interface DesktopCoworkActionEvent {
  action: DesktopCoworkActionId;
  pane: DesktopCoworkPaneModel;
  sessionId?: string;
  goal?: string;
  message?: string;
  blueprintText?: string;
  preview?: boolean;
  taskTitle?: string;
  assignedAgentId?: string;
  taskId?: string;
  taskAction?: Extract<DesktopCoworkActionInput, { action: "task" }>["taskAction"];
  workUnitId?: string;
  workUnitAction?: Extract<DesktopCoworkActionInput, { action: "workUnit" }>["workUnitAction"];
  branchId?: string;
  resultId?: string;
  branchIds?: string[];
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
    webSocket?: string;
    tokenReady?: boolean;
    tokenUsage?: string;
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
type DesktopPanelControlId = "sidebar" | "inspector" | "bottom";

interface DesktopPanelControlItem {
  panel: DesktopPanelControlId;
  label: string;
  ariaLabel: string;
  visible: boolean;
  shortcut?: string;
}

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
  targetDocument.body.classList.add("desktop-native-workbench");
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
  refreshVisibleWorkLensFromTaskCenter(targetDocument, items);
}

export function updateDesktopGatewayRuntimeStatus(
  targetDocument: Document = document,
  runtimeStatus: GatewayRuntimeStatus | null,
  gatewayHttp: string,
  gatewayActions: DesktopGatewayRuntimeActionOptions = {},
): void {
  const runtime = targetDocument.querySelector<HTMLElement>(".desktop-gateway-runtime");
  if (!runtime) {
    return;
  }
  const next = createGatewayRuntimeSurface(targetDocument, runtimeStatus, gatewayHttp, gatewayActions);
  runtime.replaceChildren(...Array.from(next.children));
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
  const next = createSettingsProvidersPane(targetDocument, settingsPane, settingsActions);
  pane.replaceChildren(...Array.from(next.children));
}

export function updateDesktopKnowledgePane(
  targetDocument: Document = document,
  knowledgePane: DesktopKnowledgePaneModel,
  knowledgeActions: DesktopKnowledgeActionOptions = {},
): void {
  const pane = targetDocument.querySelector<HTMLElement>(".desktop-knowledge-pane");
  if (!pane) {
    return;
  }
  const next = createKnowledgePane(targetDocument, knowledgePane, knowledgeActions);
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
  const surface = targetDocument.querySelector<HTMLElement>(".desktop-agent-ui-forms");
  if (!surface) {
    return;
  }
  const next = createAgentUiFormsSurface(targetDocument, forms, agentUiActions);
  surface.replaceChildren(...Array.from(next.children));
}

export function updateDesktopCoworkPane(
  targetDocument: Document = document,
  coworkPane: DesktopCoworkPaneModel,
  coworkActions: DesktopCoworkActionOptions = {},
): void {
  const pane = targetDocument.querySelector<HTMLElement>(".desktop-cowork-cockpit");
  if (!pane) {
    return;
  }
  const next = createCoworkCockpitPane(targetDocument, coworkPane, coworkActions);
  pane.replaceChildren(...Array.from(next.children));
}

export function updateDesktopNativeChat(
  targetDocument: Document = document,
  chat: DesktopNativeChatModel,
  _gatewayHttp = "",
  chatActions: DesktopNativeChatActionOptions = {},
): void {
  syncNativeChatDocumentState(targetDocument, chat);
  const header = targetDocument.querySelector<HTMLElement>(".desktop-chat-header");
  if (header) {
    const next = createChatHeader(targetDocument, chat, readCurrentWorkbenchLayout(targetDocument), chatActions);
    header.replaceChildren(...Array.from(next.children));
  }

  const thread = targetDocument.querySelector<HTMLElement>(".desktop-conversation-thread");
  if (thread) {
    const next = createConversationThread(targetDocument, chat);
    thread.replaceChildren(...Array.from(next.children));
  }

  const workspaceList = targetDocument.querySelector<HTMLElement>(".desktop-workspace-list");
  if (workspaceList) {
    const next = createSidebarWorkspaceList(targetDocument, chat).querySelector<HTMLElement>(".desktop-workspace-list");
    workspaceList.replaceChildren(...Array.from(next?.children ?? []));
  }

  const recentChats = targetDocument.querySelector<HTMLElement>(".desktop-recent-chat-list");
  if (recentChats) {
    const next = createSidebarRecentChats(targetDocument, chat, chatActions).querySelector<HTMLElement>(".desktop-recent-chat-list");
    recentChats.replaceChildren(...Array.from(next?.children ?? []));
  }

  const composer = targetDocument.getElementById("desktop-native-composer");
  if (composer) {
    const next = createNativeComposerSurface(targetDocument, chat, chatActions);
    composer.setAttribute("data-active-session-key", chat.activeSessionKey);
    composer.setAttribute("data-desktop-composer-responding", String(chat.responding === true));
    composer.setAttribute("data-desktop-composer-rag", String(chat.usePersistentRag !== false));
    composer.setAttribute("data-desktop-composer-state", nativeComposerState(chat));
    composer.replaceChildren(...Array.from(next.children));
  }
  syncSessionFileUploadKey(targetDocument, chat.activeSessionKey);
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
  knowledgePane: DesktopKnowledgePaneModel | null,
  knowledgeActions: DesktopKnowledgeActionOptions,
  toolsSkillsPane: DesktopToolsSkillsPaneModel | null,
  toolsSkillsActions: DesktopToolsSkillsActionOptions,
  coworkPane: DesktopCoworkPaneModel | null,
  coworkActions: DesktopCoworkActionOptions,
  runChainItems: DesktopRunChainItem[],
  selectedRunChainItemKey: string | null,
  workLens: DesktopWorkLensProjection | null,
  workLensActions: DesktopWorkLensActionOptions,
  taskActions: DesktopTaskCenterActionOptions,
  gatewayActions: DesktopGatewayRuntimeActionOptions,
): HTMLElement {
  const shell = targetDocument.createElement("main");
  shell.id = SHELL_ID;
  shell.className = "desktop-workbench-shell";
  shell.setAttribute("data-sidebar-visible", String(layout.sidebar.visible));
  shell.setAttribute("data-inspector-visible", String(layout.inspector.visible));
  shell.setAttribute("data-bottom-visible", String(layout.bottom.visible));
  shell.style.setProperty("--desktop-sidebar-size", `${layout.sidebar.size}px`);
  shell.style.setProperty("--desktop-inspector-size", `${layout.inspector.size}px`);
  shell.style.setProperty("--desktop-bottom-size", `${layout.bottom.size}px`);

  shell.append(
    createActivityRail(targetDocument),
    createPanel(targetDocument, "sidebar", layout.sidebar, createSidebar(targetDocument, chat, chatActions)),
    createMainRegion(targetDocument, gatewayHttp, layout, chat, chatActions, agentUiForms, agentUiActions, taskCenterItems, settingsPane, settingsActions, knowledgePane, knowledgeActions, toolsSkillsPane, toolsSkillsActions, coworkPane, coworkActions, workLens, workLensActions),
    createPanel(targetDocument, "inspector", layout.inspector, createInspector(targetDocument, runChainItems, selectedRunChainItemKey, workLens, workLensActions)),
    createPanel(targetDocument, "bottom", layout.bottom, createBottomRegion(targetDocument, runtimeStatus, gatewayHttp, taskCenterItems, taskActions, gatewayActions)),
  );

  return shell;
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

  const primary = targetDocument.createElement("div");
  primary.className = "desktop-activity-primary";
  for (const [index, [label, href, module]] of [
    ["Chat", "/chat", "chat"],
    ["Files", "/workspace", "workspace"],
    ["Knowledge", "/knowledge", "knowledge"],
    ["Cowork", "/cowork", "cowork"],
  ].entries()) {
    const item = targetDocument.createElement("a");
    item.className = "desktop-activity-button";
    item.setAttribute("href", href);
    item.textContent = label;
    item.setAttribute("aria-label", label);
    item.setAttribute("title", label);
    item.setAttribute("data-desktop-module-target", module);
    if (module === "chat") {
      item.setAttribute("data-active", "true");
      item.setAttribute("aria-current", "page");
    }
    item.setAttribute("data-focus-order", `activity-${index + 1}`);
    primary.append(item);
  }

  const secondary = targetDocument.createElement("div");
  secondary.className = "desktop-activity-secondary";
  for (const [label, href, module] of [
    ["Docs", "/docs", "docs"],
    ["GitHub", "https://github.com/SudoJacky/tinybot", "gateway"],
    ["Settings", "/settings", "settings"],
  ]) {
    const item = targetDocument.createElement("a");
    item.className = "desktop-activity-secondary-button";
    item.setAttribute("href", href);
    item.textContent = label;
    item.setAttribute("aria-label", label);
    item.setAttribute("title", label);
    item.setAttribute("data-desktop-module-target", module);
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
  const model = buildNativeWorkbenchSidebarModel();
  const workspaceGroup = model.groups.find((group) => group.id === "workspace");
  const footerGroup = model.groups.find((group) => group.id === "footer");
  const sidebar = targetDocument.createElement("div");
  sidebar.className = "desktop-sidebar-content";
  sidebar.append(
    createSidebarActions(targetDocument),
    createSidebarWorkspaceList(targetDocument, chat),
    createSidebarRecentChats(targetDocument, chat, chatActions),
    createSharedSidebarLinkSection(targetDocument, workspaceGroup),
    createSharedSidebarCommandSection(targetDocument, footerGroup),
  );
  if (chat) {
    mountSidebarContentVueIsland(sidebar, targetDocument, chat, chatActions, workspaceGroup, footerGroup);
  }
  return sidebar;
}

function mountSidebarContentVueIsland(
  sidebar: HTMLElement,
  targetDocument: Document,
  chat: DesktopNativeChatModel,
  chatActions: DesktopNativeChatActionOptions,
  workspaceGroup: DesktopSidebarGroup | undefined,
  footerGroup: DesktopSidebarGroup | undefined,
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
    commandItems: sidebarCommandItems(footerGroup),
    commandLabel: footerGroup?.label,
    recentChats,
    resourceItems: sidebarLinkItems(workspaceGroup),
    resourceLabel: workspaceGroup?.label,
    targetDocument,
    workspaceRows: [{
      active: true,
      entityId: "tinybot",
      meta: chat.activeSessionKey ? "Active session" : "Ready",
      title: "tinybot",
    }],
  });
}

function sidebarLinkItems(group: DesktopSidebarGroup | undefined): Array<DesktopSidebarItem & { href: string; kind: "link" }> {
  return (group?.items ?? []).flatMap((item) => item.kind === "link" && item.href
    ? [{ ...item, href: item.href, kind: "link" as const }]
    : []);
}

function sidebarCommandItems(group: DesktopSidebarGroup | undefined): Array<DesktopSidebarItem & { commandId: string; kind: "command" }> {
  return (group?.items ?? []).flatMap((item) => item.kind === "command" && item.commandId
    ? [{ ...item, commandId: item.commandId, kind: "command" as const }]
    : []);
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

function createSidebarWorkspaceList(targetDocument: Document, chat: DesktopNativeChatModel | null): HTMLElement {
  const section = targetDocument.createElement("section");
  section.className = "desktop-sidebar-list-section desktop-sidebar-list-section-workspaces";
  section.append(createSidebarSectionHeading(targetDocument, "Workspaces", "+"));

  const list = targetDocument.createElement("div");
  list.className = "desktop-workspace-list";
  list.setAttribute("role", "list");
  const rows = chat ? [["tinybot", chat.activeSessionKey ? "Active session" : "Ready", true]] as const : [
    ["tinybot", "1m ago", true],
    ["ai-rvc", "2h ago", false],
    ["ai-light", "Yesterday", false],
    ["ai-tv", "2d ago", false],
    ["ai-fridge", "3d ago", false],
    ["genie", "4d ago", false],
    ["docs", "May 26", false],
    ["archive", "May 20", false],
  ] as const;
  for (const [name, meta, active] of rows) {
    list.append(createSidebarRow(targetDocument, name, meta, active, "folder", "workspace", name));
  }

  section.append(list);
  mountSidebarWorkspaceListVueIsland(section, rows.map(([name, meta, active]) => ({
    active,
    entityId: name,
    meta,
    title: name,
  })));
  return section;
}

function mountSidebarWorkspaceListVueIsland(
  section: HTMLElement,
  rows: Array<{
    active: boolean;
    entityId: string;
    meta: string;
    title: string;
  }>,
): void {
  if (!canMountVueIsland(section)) {
    return;
  }
  mountSidebarWorkspaceListIsland(section, { rows });
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
    mountSidebarRecentChatsVueIsland(section, sessions.map((session) => recentChatRowModel(
      session,
      session.key === chat.activeSessionKey,
      pinnedSessionKeys.has(session.key),
    )), chatActions);
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

function recentChatRowModel(session: NativeChatSession, active: boolean, pinned: boolean): {
  active: boolean;
  chatId: string;
  href: string;
  pinned: boolean;
  routeId: string;
  sessionKey: string;
  title: string;
  updatedLabel: string;
} {
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
    updatedLabel: session.updatedAt ? `Updated ${formatCompactTime(session.updatedAt)}` : session.chatId,
  };
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
  const updatedLabel = session.updatedAt ? `Updated ${formatCompactTime(session.updatedAt)}` : session.chatId;

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
      deleteButton.textContent = "Confirm";
      return;
    }
    deleteButton.setAttribute("disabled", "");
    deleteButton.setAttribute("data-deleting", "true");
    deleteButton.textContent = "Deleting";
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
    onDeleteSession?: (event: { chatId: string; sessionKey: string; title: string }) => void;
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
    ? "/workspace"
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
  knowledgePane: DesktopKnowledgePaneModel | null,
  knowledgeActions: DesktopKnowledgeActionOptions,
  toolsSkillsPane: DesktopToolsSkillsPaneModel | null,
  toolsSkillsActions: DesktopToolsSkillsActionOptions,
  coworkPane: DesktopCoworkPaneModel | null,
  coworkActions: DesktopCoworkActionOptions,
  workLens: DesktopWorkLensProjection | null,
  workLensActions: DesktopWorkLensActionOptions,
): HTMLElement {
  const main = targetDocument.createElement("section");
  main.className = "desktop-workbench-main";
  main.setAttribute("data-workbench-region", "main");
  main.setAttribute("aria-label", "Primary desktop work area");
  const chatWorkItems = moduleWorkItems(taskCenterItems, "chat");

  const workbench = targetDocument.createElement("div");
  workbench.className = "desktop-empty-session desktop-chat-workbench";
  const workbenchChrome = targetDocument.createElement("div");
  workbenchChrome.className = "desktop-chat-workbench-chrome";
  workbenchChrome.append(
    createText(targetDocument, "span", "Ready for a new session"),
    createText(targetDocument, "span", "Start from chat, inspect workspace, or check gateway status."),
    createQuickActions(targetDocument),
    createPanelControls(targetDocument, layout),
    ...(chatWorkItems.length ? [createModuleWorkSection(targetDocument, "Chat runs", chatWorkItems)] : []),
  );
  mountChatWorkbenchVueIsland(workbenchChrome, targetDocument, layout, chatWorkItems);
  workbench.append(
    createChatHeader(targetDocument, chat, layout, chatActions),
    createConversationThread(targetDocument, chat),
    workbenchChrome,
    createWorkLensInlineHost(targetDocument, layout.inspector.visible ? null : workLens, workLensActions),
  );

  const utilities = targetDocument.createElement("div");
  utilities.className = "desktop-utility-surfaces";
  utilities.append(
    createCommandPalette(targetDocument),
    createFileActions(targetDocument, chat),
    createDesktopHelpSurface(targetDocument),
    createAgentUiFormsSurface(targetDocument, agentUiForms, agentUiActions),
    createWorkspaceFilesSurface(targetDocument),
    ...(settingsPane ? [createSettingsProvidersPane(targetDocument, settingsPane, settingsActions)] : []),
    ...(knowledgePane ? [createKnowledgePane(targetDocument, knowledgePane, knowledgeActions, moduleWorkItems(taskCenterItems, "knowledge"))] : []),
    ...(toolsSkillsPane ? [createToolsSkillsPane(targetDocument, toolsSkillsPane, toolsSkillsActions)] : []),
    ...(coworkPane ? [createCoworkCockpitPane(targetDocument, coworkPane, coworkActions)] : []),
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
    knowledgePane,
    knowledgeActions,
    toolsSkillsPane,
    toolsSkillsActions,
    coworkPane,
    coworkActions,
  );

  const status = targetDocument.createElement("div");
  status.className = "desktop-status-strip";
  status.setAttribute("data-desktop-route-status", "");
  status.textContent = `No workspace file selected · Gateway ${gatewayHttp}`;

  if (canMountVueIsland(status)) {
    mountStatusStripIsland(status, { message: status.textContent });
  }
  main.append(workbench, createNativeComposerSurface(targetDocument, chat, chatActions), utilities, status);
  return main;
}

function mountChatWorkbenchVueIsland(
  workbenchChrome: HTMLElement,
  targetDocument: Document,
  layout: WorkbenchLayoutState,
  chatWorkItems: DesktopTaskCenterItem[],
): void {
  if (!canMountVueIsland(workbenchChrome)) {
    return;
  }
  mountChatWorkbenchIsland(workbenchChrome, {
    moduleWorkItems: chatWorkItems,
    panelControls: buildDesktopPanelControls(layout),
    onInspectWorkItem: (item) => inspectModuleWorkItem(targetDocument, item),
    onPanelToggle: (panel) => toggleDesktopPanel(targetDocument, panel),
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
  layout: WorkbenchLayoutState,
  chatActions: DesktopNativeChatActionOptions = {},
): HTMLElement {
  const header = targetDocument.createElement("header");
  header.className = "desktop-chat-header";

  const titleRow = targetDocument.createElement("div");
  titleRow.className = "desktop-chat-title-row";

  const activeSession = activeChatSession(chat);
  const title = targetDocument.createElement("h1");
  title.className = "desktop-chat-title";
  title.textContent = activeChatTitle(chat);
  if (canMountVueIsland(title)) {
    mountChatTitleIsland(title, { title: activeChatTitle(chat) });
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

  titleRow.append(title, menu, popover);

  const actions = targetDocument.createElement("div");
  actions.className = "desktop-chat-header-actions";
  actions.append(
    createHeaderPanelControl(targetDocument, {
      panel: "sidebar",
      visible: layout.sidebar.visible,
      label: "▏",
      pressedLabel: "Collapse session list",
      unpressedLabel: "Expand session list",
    }),
    createHeaderPanelControl(targetDocument, {
      panel: "inspector",
      visible: layout.inspector.visible,
      label: "▌",
      pressedLabel: "Close Run Chain panel",
      unpressedLabel: "Open Run Chain panel",
    }),
  );

  mountChatHeaderActionsVueIsland(actions, targetDocument, [
    {
      panel: "sidebar",
      visible: layout.sidebar.visible,
      label: "Sidebar",
      pressedLabel: "Collapse session list",
      unpressedLabel: "Expand session list",
    },
    {
      panel: "inspector",
      visible: layout.inspector.visible,
      label: "Run Chain",
      pressedLabel: "Close Run Chain panel",
      unpressedLabel: "Open Run Chain panel",
    },
  ]);

  header.append(titleRow, actions);
  return header;
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

function mountChatHeaderActionsVueIsland(
  actions: HTMLElement,
  targetDocument: Document,
  items: ReadonlyArray<{
    panel: "sidebar" | "inspector";
    visible: boolean;
    label: string;
    pressedLabel: string;
    unpressedLabel: string;
  }>,
): void {
  if (!canMountVueIsland(actions)) {
    return;
  }
  mountChatHeaderActionsIsland(actions, {
    actions: [...items],
    onToggle: (panel) => toggleDesktopPanel(targetDocument, panel),
  });
}

function toggleChatMenuPopover(menu: HTMLElement, popover: HTMLElement): void {
  const expanded = menu.getAttribute("aria-expanded") === "true";
  menu.setAttribute("aria-expanded", String(!expanded));
  popover.hidden = expanded;
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

function readCurrentWorkbenchLayout(targetDocument: Document): WorkbenchLayoutState {
  const shell = targetDocument.getElementById(SHELL_ID);
  return {
    sidebar: {
      visible: shell?.getAttribute("data-sidebar-visible") !== "false",
      size: 260,
    },
    inspector: {
      visible: shell?.getAttribute("data-inspector-visible") !== "false",
      size: 360,
    },
    bottom: {
      visible: shell?.getAttribute("data-bottom-visible") === "true",
      size: 220,
    },
  };
}

function createHeaderPanelControl(
  targetDocument: Document,
  {
    panel,
    visible,
    label,
    pressedLabel,
    unpressedLabel,
  }: {
    panel: DesktopPanelControlId;
    visible: boolean;
    label: string;
    pressedLabel: string;
    unpressedLabel: string;
  },
): HTMLElement {
  const button = targetDocument.createElement("button");
  button.type = "button";
  button.className = "desktop-chat-header-panel-button";
  button.setAttribute("data-desktop-panel-control", panel);
  button.setAttribute("data-desktop-panel-label-pressed", pressedLabel);
  button.setAttribute("data-desktop-panel-label-unpressed", unpressedLabel);
  button.setAttribute("aria-label", visible ? pressedLabel : unpressedLabel);
  button.setAttribute("title", visible ? pressedLabel : unpressedLabel);
  button.setAttribute("aria-pressed", String(visible));
  const iconDirection = panel === "sidebar" ? "collapse-left" : panel === "inspector" ? "collapse-right" : "";
  if (iconDirection) {
    const icon = targetDocument.createElement("span");
    icon.className = "desktop-chat-header-panel-icon";
    icon.setAttribute("data-panel-icon", iconDirection);
    icon.setAttribute("aria-hidden", "true");
    icon.append(
      createPanelIconPart(targetDocument, "frame"),
      createPanelIconPart(targetDocument, "rail"),
    );
    button.append(icon);
  } else {
    button.textContent = label;
  }
  mountHeaderPanelControlVueIsland(button, targetDocument, {
    panel,
    visible,
    label,
    pressedLabel,
    unpressedLabel,
  });
  return button;
}

function mountHeaderPanelControlVueIsland(
  button: HTMLElement,
  targetDocument: Document,
  options: {
    panel: DesktopPanelControlId;
    visible: boolean;
    label: string;
    pressedLabel: string;
    unpressedLabel: string;
  },
): void {
  const toggle = () => toggleDesktopPanel(targetDocument, options.panel);
  const installFallback = () => {
    button.addEventListener("click", toggle);
    button.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      toggle();
    });
  };
  if (!canMountVueIsland(button)) {
    installFallback();
    return;
  }
  mountHeaderPanelControlIsland(button, {
    ...options,
    onToggle: () => toggle(),
  });
}

function createPanelIconPart(targetDocument: Document, part: "frame" | "rail"): HTMLElement {
  const node = targetDocument.createElement("span");
  node.className = `desktop-chat-header-panel-icon-${part}`;
  mountPanelIconPartVueIsland(node, part);
  return node;
}

function mountPanelIconPartVueIsland(node: HTMLElement, part: "frame" | "rail"): void {
  if (!canMountVueIsland(node)) {
    return;
  }
  mountPanelIconPartIsland(node, { part });
}

function createConversationThread(targetDocument: Document, chat: DesktopNativeChatModel | null): HTMLElement {
  const thread = targetDocument.createElement("section");
  thread.className = "desktop-conversation-thread";
  thread.setAttribute("aria-label", "Conversation");
  if (chat) {
    if (!chat.activeSessionKey) {
      renderConversationEmptyState(targetDocument, thread, "No live session selected.");
      mountConversationThreadVueIsland(thread, { emptyMessage: "No live session selected.", messages: [] });
      return thread;
    }
    if (!chat.messages.length) {
      renderConversationEmptyState(targetDocument, thread, "No messages in this session.");
      mountConversationThreadVueIsland(thread, { emptyMessage: "No messages in this session.", messages: [] });
      return thread;
    }
    const messages = chat.messages.map((message) => ({
      author: message.role === "user" ? "You" : "Tinybot",
      time: formatCompactTime(message.timestamp),
      tone: message.role === "user" ? "user" : "assistant",
      reasoningContent: message.reasoningContent,
      body: shouldRenderConversationBody(message) ? [message.content].filter(Boolean) : [],
      toolActivities: (message.toolActivities ?? []).map((activity) => ({
        argsText: activity.argsText || "",
        approvalStatus: activity.approvalStatus || "",
        id: activity.id || "",
        kind: activity.kind,
        name: activity.name || "",
        responseText: activity.responseText || "",
      })),
      references: (message.references ?? []).map((reference) => ({
        detail: reference.detail ?? "",
        kind: reference.kind,
        title: reference.title,
      })),
    }));
    thread.append(...messages.map((message) => createConversationMessage(targetDocument, message)));
    mountConversationThreadVueIsland(thread, { emptyMessage: "", messages });
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

function mountConversationThreadVueIsland(
  thread: HTMLElement,
  options: {
    emptyMessage: string;
    messages: Array<{
      attachment?: string;
      author: string;
      body: string[];
      references: Array<{ detail: string; kind: string; title: string }>;
      reasoningContent?: string;
      time: string;
      tone: "assistant" | "user";
      toolActivities: Array<{
        argsText: string;
        approvalStatus: string;
        id: string;
        kind: "call" | "result";
        name: string;
        responseText: string;
      }>;
    }>;
  },
): void {
  if (!canMountVueIsland(thread)) {
    return;
  }
  mountConversationThreadIsland(thread, options);
}

function renderConversationEmptyState(targetDocument: Document, thread: HTMLElement, message: string): void {
  thread.append(createText(targetDocument, "p", message));
  if (!canMountVueIsland(thread)) {
    return;
  }
  mountConversationEmptyStateIsland(thread, { message });
}

function shouldRenderConversationBody(message: NativeChatMessage): boolean {
  return !((message.role === "tool" || message.role === "progress") && Boolean(message.toolActivities?.length));
}

function createConversationMessage(
  targetDocument: Document,
  options: {
    author: string;
    time: string;
    tone: "user" | "assistant";
    reasoningContent?: string;
    body: string[];
    toolActivities?: NativeChatMessage["toolActivities"];
    references?: NativeChatMessage["references"];
    attachment?: string;
  },
): HTMLElement {
  const article = targetDocument.createElement("article");
  article.className = "desktop-conversation-message";
  article.setAttribute("data-message-tone", options.tone);

  const content = targetDocument.createElement("div");
  content.className = "desktop-conversation-content";
  const meta = targetDocument.createElement("div");
  meta.className = "desktop-conversation-meta";
  meta.append(createText(targetDocument, "strong", options.author), createText(targetDocument, "span", options.time));
  mountConversationMetaVueIsland(meta, { author: options.author, time: options.time });
  content.append(meta);
  if (options.reasoningContent?.trim()) {
    content.append(createConversationReasoning(targetDocument, options.reasoningContent));
  }
  if (options.toolActivities?.length) {
    content.append(createToolActivities(targetDocument, options.toolActivities));
  }
  content.append(createConversationBody(targetDocument, options.body, options.tone));
  for (const reference of options.references ?? []) {
    const node = createText(targetDocument, "p", conversationReferenceText(reference));
    node.className = "desktop-conversation-reference";
    mountConversationReferenceVueIsland(node, {
      detail: reference.detail ?? "",
      kind: reference.kind,
      title: reference.title,
    });
    content.append(node);
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
  article.append(content);
  mountConversationMessageVueIsland(article, {
    attachment: options.attachment,
    author: options.author,
    body: options.body,
    references: (options.references ?? []).map((reference) => ({
      detail: reference.detail ?? "",
      kind: reference.kind,
      title: reference.title,
    })),
    reasoningContent: options.reasoningContent,
    time: options.time,
    tone: options.tone,
    toolActivities: (options.toolActivities ?? []).map((activity) => ({
      argsText: activity.argsText || "",
      approvalStatus: activity.approvalStatus || "",
      id: activity.id || "",
      kind: activity.kind,
      name: activity.name || "",
      responseText: activity.responseText || "",
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
      argsText: string;
      approvalStatus: string;
      id: string;
      kind: "call" | "result";
      name: string;
      responseText: string;
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

function conversationReferenceText(reference: { detail?: string; kind: string; title: string }): string {
  return `${reference.kind}: ${reference.title}${reference.detail ? ` - ${reference.detail}` : ""}`;
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

function mountConversationReferenceVueIsland(
  reference: HTMLElement,
  options: { detail: string; kind: string; title: string },
): void {
  if (!canMountVueIsland(reference)) {
    return;
  }
  mountConversationReferenceIsland(reference, options);
}

function createConversationReasoning(targetDocument: Document, reasoningContent: string): HTMLElement {
  const details = targetDocument.createElement("details");
  details.className = "desktop-message-reasoning";
  const summary = targetDocument.createElement("summary");
  summary.className = "desktop-message-reasoning-summary";
  const title = createText(targetDocument, "span", "Thinking");
  title.className = "desktop-message-reasoning-title";
  const meta = createText(targetDocument, "span", "Show details");
  meta.className = "desktop-message-reasoning-meta";
  summary.append(title, meta);
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
  activities: NonNullable<NativeChatMessage["toolActivities"]>,
): HTMLElement {
  const wrapper = targetDocument.createElement("div");
  wrapper.className = "desktop-tool-activities";
  for (const activity of activities) {
    wrapper.append(createToolActivity(targetDocument, activity));
  }
  mountToolActivitiesVueIsland(wrapper, activities.map((activity) => ({
    argsText: activity.argsText || "",
    approvalStatus: activity.approvalStatus || "",
    id: activity.id || "",
    kind: activity.kind,
    name: activity.name || "",
    responseText: activity.responseText || "",
  })));
  return wrapper;
}

function mountToolActivitiesVueIsland(
  wrapper: HTMLElement,
  activities: Array<{
    argsText: string;
    approvalStatus: string;
    id: string;
    kind: "call" | "result";
    name: string;
    responseText: string;
  }>,
): void {
  if (!canMountVueIsland(wrapper)) {
    return;
  }
  mountToolActivitiesIsland(wrapper, { activities });
}

function createToolActivity(
  targetDocument: Document,
  activity: NonNullable<NativeChatMessage["toolActivities"]>[number],
): HTMLElement {
  const details = targetDocument.createElement("details");
  details.className = "desktop-tool-activity";
  details.setAttribute("data-desktop-tool-activity-kind", activity.kind);
  if (activity.id) {
    details.setAttribute("data-desktop-tool-activity-id", activity.id);
  }

  const summary = targetDocument.createElement("summary");
  summary.className = "desktop-tool-activity-summary";
  const icon = createText(targetDocument, "span", ">");
  icon.className = "desktop-tool-activity-icon";
  icon.setAttribute("aria-hidden", "true");
  const main = targetDocument.createElement("span");
  main.className = "desktop-tool-activity-main";
  const title = createText(targetDocument, "span", activity.name || "unknown");
  title.className = "desktop-tool-activity-title";
  const preview = createText(targetDocument, "span", summarizeToolText(activity.argsText || activity.responseText));
  preview.className = "desktop-tool-activity-preview";
  main.append(title, preview);
  const badges = targetDocument.createElement("span");
  badges.className = "desktop-tool-activity-badges";
  if (activity.approvalStatus === "approved") {
    const approval = createText(targetDocument, "span", "Approved");
    approval.className = "desktop-tool-activity-badge desktop-tool-activity-approval-badge";
    badges.append(approval);
  }
  const badge = createText(targetDocument, "span", activity.kind === "result" ? "Result" : "Call");
  badge.className = "desktop-tool-activity-badge";
  badges.append(badge);
  summary.append(icon, main, badges);
  details.append(summary);

  const body = targetDocument.createElement("div");
  body.className = "desktop-tool-activity-body";
  if (activity.argsText) {
    body.append(createToolActivitySection(targetDocument, "Arguments", activity.argsText, "call"));
  }
  if (activity.responseText) {
    body.append(createToolActivitySection(targetDocument, "Response", activity.responseText, "response"));
  }
  if (!activity.argsText && !activity.responseText) {
    const empty = createText(targetDocument, "div", "No arguments or response.");
    empty.className = "desktop-tool-activity-empty";
    body.append(empty);
  }
  details.append(body);
  mountToolActivityVueIsland(details, {
    argsText: activity.argsText || "",
    approvalStatus: activity.approvalStatus || "",
    id: activity.id || "",
    kind: activity.kind,
    name: activity.name || "",
    responseText: activity.responseText || "",
  });
  return details;
}

function mountToolActivityVueIsland(
  activity: HTMLElement,
  options: {
    argsText: string;
    approvalStatus: string;
    id: string;
    kind: "call" | "result";
    name: string;
    responseText: string;
  },
): void {
  if (!canMountVueIsland(activity)) {
    return;
  }
  mountToolActivityIsland(activity, options);
}

function createToolActivitySection(
  targetDocument: Document,
  label: string,
  text: string,
  kind: "call" | "response",
): HTMLElement {
  const section = targetDocument.createElement("div");
  section.className = `desktop-tool-activity-section desktop-tool-activity-section-${kind}`;
  const labelNode = createText(targetDocument, "div", label);
  labelNode.className = "desktop-tool-activity-label";
  const pre = createText(targetDocument, "pre", text);
  pre.className = "desktop-tool-activity-pre";
  section.append(labelNode, pre);
  mountToolActivitySectionVueIsland(section, { kind, label, text });
  return section;
}

function mountToolActivitySectionVueIsland(
  section: HTMLElement,
  options: { kind: "call" | "response"; label: string; text: string },
): void {
  if (!canMountVueIsland(section)) {
    return;
  }
  mountToolActivitySectionIsland(section, options);
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
  } catch {
    target.textContent = content;
  }
}

function addMarkdownLinkAttributes(html: string): string {
  return html.replace(/<a\s+(?![^>]*\btarget=)([^>]*href=)/gi, '<a target="_blank" rel="noreferrer" $1');
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
    createComposerModelControl(targetDocument, chat),
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
  mountComposerSurfaceIsland(composer, {
    activeSessionKey: chat?.activeSessionKey || null,
    composerState: nativeComposerState(chat),
    model: chat?.runtime?.model || null,
    responding: chat?.responding === true,
    tokenUsage: chat?.runtime?.tokenUsage || "-",
    usePersistentRag: chat?.usePersistentRag !== false,
    onAttach: () => chatActions.onAttachSessionFile?.(),
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
    persistentRag: chat?.usePersistentRag !== false,
    tokenUsage: chat?.runtime?.tokenUsage || "-",
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

function formatCompactTime(value: string): string {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString();
}

function createComposerModelControl(targetDocument: Document, chat: DesktopNativeChatModel | null = null): HTMLElement {
  const button = targetDocument.createElement("button");
  button.type = "button";
  button.className = "desktop-native-composer-model";
  button.setAttribute("aria-label", "Select model");
  button.textContent = chat?.runtime?.model || "Tinybot Pro";
  mountComposerModelControlVueIsland(button, chat?.runtime?.model || null);
  return button;
}

function mountComposerModelControlVueIsland(button: HTMLElement, model: string | null): void {
  if (!canMountVueIsland(button)) {
    return;
  }
  mountComposerModelControlIsland(button, { model });
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
    const actions: Array<[DesktopToolsSkillsActionId, string, boolean]> = [
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
  actions: Array<[DesktopToolsSkillsActionId, string, boolean]>,
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
  section.append(createText(targetDocument, "h2", "Knowledge"), createText(targetDocument, "p", pane.status));

  const actions: Array<[DesktopKnowledgeActionId, string, boolean]> = [
    ["uploadDocument", "Upload document", pane.actions.upload],
    ["runQuery", "Run query", pane.actions.query],
    ["refreshGraph", "Refresh graph", pane.actions.refreshGraph],
    ["rebuildIndex", "Rebuild index", pane.actions.rebuild],
    ["deleteDocument", "Delete document", pane.actions.deleteDocument],
  ];
  const actionRow = targetDocument.createElement("div");
  actionRow.className = "desktop-knowledge-actions";
  for (const [action, label, enabled] of actions) {
    const button = targetDocument.createElement("button");
    button.setAttribute("type", "button");
    button.setAttribute("data-desktop-knowledge-action", action);
    if (!enabled) {
      button.setAttribute("disabled", "true");
    }
    button.textContent = label;
    button.addEventListener("click", () => {
      knowledgeActions.onKnowledgeAction?.({ action, pane });
    });
    actionRow.append(button);
  }
  mountKnowledgeActionsVueIsland(actionRow, actions, pane, knowledgeActions);
  section.append(actionRow);
  if (workItems.length) {
    section.append(createModuleWorkSection(targetDocument, "Knowledge jobs", workItems));
  }

  const readiness = targetDocument.createElement("section");
  readiness.className = "desktop-knowledge-readiness";
  readiness.append(createText(targetDocument, "h2", "Readiness"));
  for (const hint of pane.configHints) {
    readiness.append(createText(targetDocument, "p", hint));
  }
  for (const row of pane.readiness.rows) {
    readiness.append(createText(targetDocument, "p", `${row.id}: ${row.tone}`));
  }
  mountKnowledgeReadinessVueIsland(readiness, pane);
  section.append(readiness);

  const documents = targetDocument.createElement("section");
  documents.className = "desktop-knowledge-documents";
  documents.append(createText(targetDocument, "h2", "Documents"));
  for (const document of pane.documentRows) {
    const row = createText(targetDocument, "p", `${document.title}: ${document.meta}`);
    setDesktopEntityHook(row, "knowledge", document.id || document.path);
    documents.append(row);
  }
  mountKnowledgeDocumentsVueIsland(documents, pane);
  section.append(documents);

  if (pane.selectedDocument) {
    const detail = targetDocument.createElement("section");
    detail.className = "desktop-knowledge-document-detail";
    detail.append(
      createText(targetDocument, "h2", `Document detail: ${pane.selectedDocument.title}`),
      createText(targetDocument, "p", pane.selectedDocument.detail),
      createText(targetDocument, "p", `Tags: ${pane.selectedDocument.tags.join(", ") || "none"}`),
    );
    mountKnowledgeDocumentDetailVueIsland(detail, pane.selectedDocument);
    section.append(detail);
  }

  const query = targetDocument.createElement("section");
  query.className = "desktop-knowledge-query";
  query.append(
    createText(targetDocument, "h2", `Query: ${pane.query.draft.query || "empty"}`),
    createText(targetDocument, "p", `Mode: ${pane.query.draft.mode} / top ${pane.query.draft.topK}`),
    createText(targetDocument, "p", `Results: ${pane.query.results.summary.count}`),
  );
  for (const row of pane.query.results.rows.slice(0, 4)) {
    query.append(createText(targetDocument, "p", `${row.docName}: ${row.content}`));
  }
  mountKnowledgeQueryVueIsland(query, pane);
  section.append(query);

  const graph = targetDocument.createElement("section");
  graph.className = "desktop-knowledge-graph";
  graph.append(createText(targetDocument, "h2", `Graph: ${pane.graph.summary}`));
  appendKnowledgeReferenceRows(targetDocument, graph, "Community", pane.graph.communities);
  appendKnowledgeReferenceRows(targetDocument, graph, "Report", pane.graph.reports);
  appendKnowledgeReferenceRows(targetDocument, graph, "Claim", pane.graph.claims);
  appendKnowledgeReferenceRows(targetDocument, graph, "Relation", pane.graph.relations);
  appendKnowledgeReferenceRows(targetDocument, graph, "Conflict", pane.graph.conflicts);
  for (const evidence of pane.graph.evidence.slice(0, 4)) {
    graph.append(createText(targetDocument, "p", `Evidence: ${evidence.title} / ${evidence.docName}`));
  }
  mountKnowledgeGraphVueIsland(graph, pane);
  section.append(graph);

  mountKnowledgePaneVueIsland(section, targetDocument, pane, knowledgeActions, workItems);
  return section;
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
    onInspectWorkItem: (item) => renderWorkLensFromTask(targetDocument, item),
    onKnowledgeAction: (event) => {
      knowledgeActions.onKnowledgeAction?.(event);
    },
  });
}

function mountKnowledgeActionsVueIsland(
  actionRow: HTMLElement,
  actions: Array<[DesktopKnowledgeActionId, string, boolean]>,
  pane: DesktopKnowledgePaneModel,
  knowledgeActions: DesktopKnowledgeActionOptions,
): void {
  if (!canMountVueIsland(actionRow)) {
    return;
  }
  mountKnowledgeActionsIsland(actionRow, {
    actions: actions.map(([action, label, enabled]) => ({ action, label, enabled })),
    onAction: (action) => {
      knowledgeActions.onKnowledgeAction?.({ action, pane });
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

function mountKnowledgeQueryVueIsland(
  query: HTMLElement,
  pane: DesktopKnowledgePaneModel,
): void {
  if (!canMountVueIsland(query)) {
    return;
  }
  mountKnowledgeQueryIsland(query, {
    draft: pane.query.draft,
    results: pane.query.results,
  });
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
  ];
  actions.append(goal, message, blueprint, taskTitle, assignedAgentId);
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
      ["selectBranchResult", "Set final"],
      ["mergeBranchResults", "Merge results"],
    ] as const) {
      const button = createCoworkSelectedActionButton(targetDocument, action, label);
      button.addEventListener("click", () => {
        if (action === "mergeBranchResults") {
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
          branchId: branch?.branchId || id,
          resultId: action === "selectBranchResult" ? branch?.resultId : undefined,
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
    const element = createText(targetDocument, "p", knowledgeReferenceRowText(label, row));
    mountKnowledgeReferenceRowVueIsland(element, { label, text: row.text, title: row.title });
    section.append(element);
  }
}

function knowledgeReferenceRowText(label: string, row: { title: string; text: string }): string {
  return `${label}: ${row.title}${row.text ? ` - ${row.text}` : ""}`;
}

function mountKnowledgeReferenceRowVueIsland(
  row: HTMLElement,
  options: { label: string; text: string; title: string },
): void {
  if (!canMountVueIsland(row)) {
    return;
  }
  mountKnowledgeReferenceRowIsland(row, options);
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
): HTMLElement {
  const section = targetDocument.createElement("section");
  section.className = "desktop-workbench-section desktop-settings-pane";
  section.setAttribute("data-desktop-module-surface", "settings");
  section.setAttribute("data-settings-layout", "codex-like");
  section.setAttribute("aria-label", "Settings and providers");

  section.append(createSettingsSidebar(targetDocument, pane));

  const content = targetDocument.createElement("div");
  content.className = "desktop-settings-content";

  const header = targetDocument.createElement("header");
  header.className = "desktop-settings-header";
  const breadcrumb = targetDocument.createElement("div");
  breadcrumb.className = "desktop-settings-breadcrumb";
  breadcrumb.append(createText(targetDocument, "h2", "设置 / 模型"));
  header.append(breadcrumb);
  content.append(header);

  content.append(createDefaultLlmSettingsCard(targetDocument, pane, settingsActions));
  content.append(createProviderManagementSection(targetDocument, pane, settingsActions));
  content.append(createSettingsStatusCard(targetDocument, pane));

  const grid = targetDocument.createElement("div");
  grid.className = "desktop-settings-grid";

  for (const group of pane.groups) {
    const fields = getSettingsGroupDisplayFields(group);
    if (!fields.length) {
      continue;
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
    for (const field of fields) {
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
      const control = createDesktopSettingsControl(targetDocument, pane, field, settingsActions);
      copy.append(label, help);
      row.append(copy, control);
      groupSection.append(row);
    }
    grid.append(groupSection);
  }

  content.append(grid);
  mountSettingsGroupsVueIsland(grid, pane, settingsActions);
  section.append(content);
  mountSettingsPaneVueIsland(section, targetDocument, pane, settingsActions);
  return section;
}

function mountSettingsPaneVueIsland(
  section: HTMLElement,
  targetDocument: Document,
  pane: DesktopSettingsPaneModel,
  settingsActions: DesktopSettingsActionOptions,
): void {
  if (!canMountVueIsland(section)) {
    return;
  }
  mountSettingsPaneIsland(section, {
    pane,
    onSettingsAction: settingsActions.onSettingsAction,
    promptProviderId: () => promptForSettingsProviderId(targetDocument),
    onFocusSettingsControl: (fieldId) => focusDesktopSettingsControl(targetDocument, fieldId),
  });
}

function mountSettingsGroupsVueIsland(
  grid: HTMLElement,
  pane: DesktopSettingsPaneModel,
  settingsActions: DesktopSettingsActionOptions,
): void {
  if (!canMountVueIsland(grid)) {
    return;
  }
  mountSettingsGroupsIsland(grid, {
    pane,
    onSettingsAction: settingsActions.onSettingsAction,
  });
}

function createDefaultLlmSettingsCard(
  targetDocument: Document,
  pane: DesktopSettingsPaneModel,
  settingsActions: DesktopSettingsActionOptions,
): HTMLElement {
  const card = targetDocument.createElement("section");
  card.className = "desktop-settings-default-llm-card";
  card.setAttribute("aria-label", "Default LLM settings");

  const heading = targetDocument.createElement("div");
  heading.className = "desktop-settings-card-heading";
  heading.append(createText(targetDocument, "h2", "默认 LLM"));

  const form = targetDocument.createElement("div");
  form.className = "desktop-settings-default-llm-form";
  const provider = findSettingsPaneField(pane, "provider", "selectedProvider");
  const model = findSettingsPaneField(pane, "agent", "model");
  if (provider) {
    form.append(createSettingsControlField(targetDocument, pane, provider, "提供商", settingsActions));
  }
  if (model) {
    form.append(createSettingsControlField(targetDocument, pane, model, "模型", settingsActions));
  }

  const save = targetDocument.createElement("button");
  save.className = "desktop-settings-save-status-button";
  save.setAttribute("type", "button");
  save.setAttribute("data-desktop-settings-action", "save");
  if (!pane.save.canSave) {
    save.setAttribute("disabled", "true");
  }
  save.textContent = pane.save.status === "saving" ? "保存中" : pane.save.status === "saved" ? "已保存" : pane.dirty ? "保存设置" : "已保存";
  save.addEventListener("click", () => {
    settingsActions.onSettingsAction?.({ action: "save", pane });
  });
  form.append(save);

  const copy = createText(targetDocument, "p", "这里设置全局默认的 LLM 模型。你也可以在聊天页面为具体 Agent 单独选择使用的模型。");
  copy.className = "desktop-settings-default-llm-copy";

  card.append(heading, form, copy);
  mountSettingsDefaultLlmVueIsland(card, pane, settingsActions);
  return card;
}

function mountSettingsDefaultLlmVueIsland(
  card: HTMLElement,
  pane: DesktopSettingsPaneModel,
  settingsActions: DesktopSettingsActionOptions,
): void {
  if (!canMountVueIsland(card)) {
    return;
  }
  mountSettingsDefaultLlmIsland(card, {
    pane,
    onSettingsAction: settingsActions.onSettingsAction,
  });
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
  header.append(createText(targetDocument, "h2", "提供商"));

  const tools = targetDocument.createElement("div");
  tools.className = "desktop-settings-provider-tools";
  const search = targetDocument.createElement("input");
  search.className = "desktop-settings-provider-search";
  search.setAttribute("type", "search");
  search.setAttribute("placeholder", "搜索提供商...");
  search.setAttribute("aria-label", "Search providers");

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
    settingsActions.onSettingsAction?.({ action: "discoverModels", pane });
  });

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
  add.textContent = "+ 添加提供商";
  tools.append(search, refresh, add);
  header.append(tools);

  const cards = targetDocument.createElement("div");
  cards.className = "desktop-settings-provider-grid";
  for (const provider of getProviderCards(pane)) {
    cards.append(createProviderManagementCard(targetDocument, pane, provider, settingsActions));
  }
  search.addEventListener("input", () => {
    filterSettingsProviderCards(cards, search.value);
  });

  section.append(header, cards);
  mountSettingsProviderManagementVueIsland(section, targetDocument, pane, settingsActions);
  return section;
}

function mountSettingsProviderManagementVueIsland(
  section: HTMLElement,
  targetDocument: Document,
  pane: DesktopSettingsPaneModel,
  settingsActions: DesktopSettingsActionOptions,
): void {
  if (!canMountVueIsland(section)) {
    return;
  }
  mountSettingsProviderManagementIsland(section, {
    pane,
    onSettingsAction: settingsActions.onSettingsAction,
    promptProviderId: () => promptForSettingsProviderId(targetDocument),
    onFocusSettingsControl: (fieldId) => focusDesktopSettingsControl(targetDocument, fieldId),
  });
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
  wrapper.append(field.id === "model" && pane.providerEditor.models.length > 0
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
  const values = [field.inputValue, ...pane.providerEditor.models].filter(Boolean);
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

function createProviderManagementCard(
  targetDocument: Document,
  pane: DesktopSettingsPaneModel,
  provider: DesktopProviderCardModel,
  settingsActions: DesktopSettingsActionOptions,
): HTMLElement {
  const card = targetDocument.createElement("article");
  card.className = "desktop-settings-provider-card";
  card.setAttribute("data-desktop-settings-provider-card", provider.id);

  const header = targetDocument.createElement("header");
  header.className = "desktop-settings-provider-card-header";
  const title = targetDocument.createElement("div");
  title.className = "desktop-settings-provider-title";
  title.append(createText(targetDocument, "h3", provider.label));
  if (provider.badge) {
    const badge = createText(targetDocument, "span", provider.badge);
    badge.className = "desktop-settings-provider-badge";
    title.append(badge);
  }
  const status = createText(targetDocument, "span", provider.statusLabel);
  status.className = "desktop-settings-provider-status";
  header.append(title, status);

  const details = targetDocument.createElement("div");
  details.className = "desktop-settings-provider-details";
  details.append(
    createSettingsProviderDetail(targetDocument, "Base URL", provider.baseUrl),
    createSettingsProviderDetail(targetDocument, "API Key", provider.apiKey),
    createSettingsProviderDetail(targetDocument, "Model", provider.models),
  );

  const actions = targetDocument.createElement("div");
  actions.className = "desktop-settings-provider-card-actions";
  const modelAction = createText(targetDocument, "button", "\u6a21\u578b");
  modelAction.setAttribute("type", "button");
  modelAction.setAttribute("data-desktop-settings-provider-action", "models");
  modelAction.addEventListener("click", () => {
    handleSettingsProviderCardAction(targetDocument, pane, settingsActions, provider.id, "model");
  });
  const settingsAction = createText(targetDocument, "button", "\u8bbe\u7f6e");
  settingsAction.setAttribute("type", "button");
  settingsAction.setAttribute("data-desktop-settings-provider-action", "settings");
  settingsAction.addEventListener("click", () => {
    handleSettingsProviderCardAction(targetDocument, pane, settingsActions, provider.id, "settings");
  });
  actions.replaceChildren(modelAction, settingsAction);

  card.append(header, details, actions);
  return card;
}

function createSettingsProviderDetail(targetDocument: Document, label: string, value: string): HTMLElement {
  const row = targetDocument.createElement("p");
  row.className = "desktop-settings-provider-detail";
  row.append(createText(targetDocument, "span", `${label}: `), createText(targetDocument, "strong", value));
  mountSettingsProviderDetailVueIsland(row, label, value);
  return row;
}

function mountSettingsProviderDetailVueIsland(row: HTMLElement, label: string, value: string): void {
  if (!canMountVueIsland(row)) {
    return;
  }
  mountSettingsProviderDetailIsland(row, { label, value });
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
  target: "model" | "settings",
): void {
  if (providerId !== pane.providerEditor.selectedProvider) {
    selectSettingsProvider(pane, settingsActions, providerId);
    focusDesktopSettingsControl(targetDocument, "selectedProvider");
    return;
  }
  focusDesktopSettingsControl(targetDocument, target === "model" ? "model" : "apiBase");
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

function focusDesktopSettingsControl(targetDocument: Document, fieldId: string): void {
  targetDocument.querySelector<HTMLElement>(`[data-desktop-settings-control="${fieldId}"]`)?.focus();
}

type DesktopSettingsPaneGroup = DesktopSettingsPaneModel["groups"][number];
type DesktopSettingsPaneField = DesktopSettingsPaneGroup["fields"][number];

interface DesktopProviderCardModel {
  id: string;
  label: string;
  badge: string;
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
  if (group.id === "agent") {
    return group.fields.filter((field) => !["model", "provider"].includes(field.id));
  }
  if (group.id === "provider") {
    return group.fields.filter((field) => !["selectedProvider"].includes(field.id));
  }
  return group.fields;
}

function getProviderCards(pane: DesktopSettingsPaneModel): DesktopProviderCardModel[] {
  const selectedProvider = pane.providerEditor.selectedProvider || "provider";
  const catalog = pane.providerCatalog.length
    ? pane.providerCatalog
    : [{ id: selectedProvider, label: selectedProvider, status: "not_configured" }];
  return catalog.map((provider) => {
    const isSelected = provider.id === selectedProvider;
    const models = isSelected ? pane.providerEditor.models.join(", ") : "";
    return {
      id: provider.id,
      label: provider.label || provider.id,
      badge: isSelected ? "当前" : "",
      statusLabel: formatProviderStatus(provider.status),
      baseUrl: isSelected ? pane.providerEditor.apiBase || "未设置" : "未设置",
      apiKey: isSelected ? pane.providerEditor.apiKey.displayValue || "未设置" : "未设置",
      models: models || "暂无模型",
    };
  });
}

function formatProviderStatus(status: string): string {
  return {
    ready: "已连接",
    needs_key: "未就绪",
    unavailable: "不可用",
    not_configured: "未配置",
  }[status] ?? status;
}

function createSettingsSidebar(targetDocument: Document, pane: DesktopSettingsPaneModel): HTMLElement {
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
    item.setAttribute("href", `#desktop-settings-group-${group.id}`);
    item.setAttribute("data-desktop-settings-nav", group.id);
    if (index === 0) {
      item.setAttribute("data-active", "true");
      item.setAttribute("aria-current", "page");
    }
    item.textContent = getSettingsNavLabel(group.id);
    nav.append(item);
  });

  sidebar.append(nav);
  mountSettingsSidebarVueIsland(sidebar, pane);
  return sidebar;
}

function mountSettingsSidebarVueIsland(sidebar: HTMLElement, pane: DesktopSettingsPaneModel): void {
  if (!canMountVueIsland(sidebar)) {
    return;
  }
  mountSettingsSidebarIsland(sidebar, { groups: pane.groups });
}

function createSettingsStatusCard(targetDocument: Document, pane: DesktopSettingsPaneModel): HTMLElement {
  const card = targetDocument.createElement("section");
  card.className = "desktop-settings-status-card";
  card.setAttribute("aria-label", "Settings status");

  const details = targetDocument.createElement("div");
  details.className = "desktop-settings-summary";
  details.append(
    createSettingsStatusItem(targetDocument, "Save", pane.save.message),
    createSettingsStatusItem(
      targetDocument,
      "Validation",
      pane.validationErrors.length ? pane.validationErrors.map((error) => error.field).join(", ") : "ready",
    ),
    createSettingsStatusItem(targetDocument, "Provider profile", pane.providerEditor.profileId || "default"),
    createSettingsStatusItem(targetDocument, "API key", pane.providerEditor.apiKey.displayValue || "Not configured"),
    createSettingsStatusItem(
      targetDocument,
      "Catalog",
      pane.providerCatalog.map((provider) => `${provider.label} (${provider.status})`).join(", ") || "No providers loaded",
    ),
    createSettingsStatusItem(targetDocument, "Models", pane.providerEditor.models.join(", ") || "No models loaded"),
  );
  card.append(details);
  mountSettingsStatusVueIsland(card, pane);
  return card;
}

function mountSettingsStatusVueIsland(card: HTMLElement, pane: DesktopSettingsPaneModel): void {
  if (!canMountVueIsland(card)) {
    return;
  }
  mountSettingsStatusIsland(card, { pane });
}

function createSettingsStatusItem(targetDocument: Document, label: string, value: string): HTMLElement {
  const row = targetDocument.createElement("p");
  row.className = "desktop-settings-status-item";
  row.append(createText(targetDocument, "span", `${label}: `), createText(targetDocument, "strong", value));
  mountSettingsStatusItemVueIsland(row, label, value);
  return row;
}

function mountSettingsStatusItemVueIsland(row: HTMLElement, label: string, value: string): void {
  if (!canMountVueIsland(row)) {
    return;
  }
  mountSettingsStatusItemIsland(row, { label, value });
}

function getSettingsNavLabel(groupId: DesktopSettingsPaneModel["groups"][number]["id"]): string {
  return {
    agent: "General",
    provider: "Provider",
    knowledge: "Knowledge",
    tools: "Tools",
    gateway: "Gateway",
    channels: "Channels",
  }[groupId];
}

function getSettingsGroupDescription(groupId: DesktopSettingsPaneModel["groups"][number]["id"]): string {
  return {
    agent: "Default model, profile, and timezone used by the desktop workbench.",
    provider: "Provider profile, endpoint, and model catalog for chat and agent runs.",
    knowledge: "Retrieval behavior for workspace knowledge and RAG context.",
    tools: "Browser, command execution, and MCP server access.",
    gateway: "Local gateway connection and heartbeat configuration.",
    channels: "Streaming and retry behavior for desktop channels.",
  }[groupId];
}

function getSettingsFieldDescription(
  groupId: DesktopSettingsPaneModel["groups"][number]["id"],
  fieldId: string,
  value: string,
): string {
  const descriptions: Record<string, string> = {
    "agent.model": "Model used for default chat and agent responses.",
    "agent.provider": "Provider routing for the selected model.",
    "agent.activeProfile": "Named provider profile with credentials and endpoint settings.",
    "agent.timezone": "Timezone used for timestamps, reminders, and scheduled work.",
    "provider.selectedProvider": "Provider catalog entry edited by this profile.",
    "provider.profileId": "Stable profile name saved in desktop configuration.",
    "provider.apiBase": "OpenAI-compatible endpoint for this provider.",
    "provider.models": "One model id per line; refresh can discover supported models.",
    "knowledge.enabled": "Enable retrieval from indexed workspace knowledge.",
    "knowledge.retrievalMode": "Retrieval strategy used when knowledge context is requested.",
    "knowledge.maxChunks": "Maximum number of chunks injected into context.",
    "knowledge.rerankApiBase": "Endpoint used when reranking is enabled.",
    "tools.webEnable": "Allow browser and web search tools.",
    "tools.execEnable": "Allow local command execution from agent workflows.",
    "tools.mcpServers": "JSON object of MCP server definitions.",
    "gateway.host": "Host interface where the desktop gateway listens.",
    "gateway.port": "Port used by the local gateway endpoint.",
    "gateway.heartbeat": "Keep the desktop gateway connection fresh.",
    "channels.sendProgress": "Stream progress events into the desktop session.",
    "channels.sendToolHints": "Show tool status hints during agent work.",
    "channels.sendMaxRetries": "Retry count for channel delivery failures.",
  };
  return descriptions[`${groupId}.${fieldId}`] ?? `Current value: ${value || "Not configured"}.`;
}

function createDesktopSettingsControl(
  targetDocument: Document,
  pane: DesktopSettingsPaneModel,
  field: DesktopSettingsPaneModel["groups"][number]["fields"][number],
  settingsActions: DesktopSettingsActionOptions,
): HTMLElement {
  const tagName = field.control === "textarea" ? "textarea" : field.control === "select" ? "select" : "input";
  const control = targetDocument.createElement(tagName);
  control.setAttribute("id", `desktop-settings-${field.id}`);
  control.setAttribute("data-desktop-settings-control", field.id);
  control.setAttribute("data-state", field.state);
  if (field.state === "invalid") {
    control.setAttribute("aria-invalid", "true");
  }

  if (field.control === "checkbox") {
    (control as HTMLInputElement).type = "checkbox";
    (control as HTMLInputElement).checked = Boolean(field.checked);
    control.addEventListener("change", (event) => {
      settingsActions.onSettingsAction?.({
        action: "edit",
        pane,
        fieldId: field.id,
        value: Boolean((event.target as HTMLInputElement | null)?.checked),
      });
    });
    return control;
  }

  if (field.control === "number") {
    (control as HTMLInputElement).type = "number";
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

function createPanelControls(targetDocument: Document, layout: WorkbenchLayoutState): HTMLElement {
  const controls = targetDocument.createElement("div");
  controls.className = "desktop-panel-controls";
  controls.setAttribute("aria-label", "Workbench panel controls");

  const panelControls = buildDesktopPanelControls(layout);

  for (const control of panelControls) {
    const button = targetDocument.createElement("button");
    button.className = "desktop-panel-control";
    button.setAttribute("type", "button");
    button.setAttribute("data-desktop-panel-control", control.panel);
    button.setAttribute("aria-label", control.ariaLabel);
    button.setAttribute("aria-pressed", String(control.visible));
    if (control.shortcut) {
      button.setAttribute("aria-keyshortcuts", control.shortcut);
    }
    button.textContent = control.label;
    button.addEventListener("click", () => {
      toggleDesktopPanel(targetDocument, control.panel);
    });
    button.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      toggleDesktopPanel(targetDocument, control.panel);
    });
    controls.append(button);
  }

  mountPanelControlsVueIsland(controls, targetDocument, panelControls);
  return controls;
}

function buildDesktopPanelControls(layout: WorkbenchLayoutState): DesktopPanelControlItem[] {
  return [
    {
      panel: "sidebar",
      label: "Sidebar",
      ariaLabel: "Toggle sidebar panel",
      visible: layout.sidebar.visible,
      shortcut: "Ctrl+B",
    },
    {
      panel: "inspector",
      label: "Run Chain",
      ariaLabel: "Toggle Run Chain panel",
      visible: layout.inspector.visible,
    },
    {
      panel: "bottom",
      label: "Tasks",
      ariaLabel: "Toggle task and runtime panel",
      visible: layout.bottom.visible,
    },
  ];
}

function mountPanelControlsVueIsland(
  controls: HTMLElement,
  targetDocument: Document,
  panelControls: DesktopPanelControlItem[],
): void {
  if (!canMountVueIsland(controls)) {
    return;
  }
  mountPanelControlsIsland(controls, {
    controls: panelControls,
    onToggle: (panel) => toggleDesktopPanel(targetDocument, panel),
  });
}

function toggleDesktopPanel(targetDocument: Document, panel: DesktopPanelControlId): void {
  const shell = targetDocument.getElementById(SHELL_ID);
  const panelElement = targetDocument.querySelector<HTMLElement>(`[data-workbench-region="${panel}"]`);
  const stateAttribute = `data-${panel}-visible`;
  const currentValue = shell?.getAttribute(stateAttribute) ?? panelElement?.getAttribute("data-visible") ?? "true";
  const nextVisible = currentValue === "false";
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
}

function formatPanelName(panel: DesktopPanelControlId): string {
  if (panel === "inspector") {
    return "Run Chain";
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
  selectedRunChainItemKey: string | null = null,
  workLens: DesktopWorkLensProjection | null = null,
  workLensActions: DesktopWorkLensActionOptions = {},
): HTMLElement {
  const inspector = targetDocument.createElement("aside");
  inspector.className = "desktop-inspector-content";
  inspector.append(createRunChainOverviewPanel(targetDocument, runChainItems));
  if (workLens) {
    inspector.append(createWorkLensPane(targetDocument, workLens, workLensActions));
  } else if (runChainItems.length) {
    inspector.append(createRunChainInspectorPane(targetDocument, runChainItems, selectedRunChainItemKey));
  }
  mountInspectorRegionVueIsland(inspector, targetDocument, runChainItems, selectedRunChainItemKey, workLens, workLensActions);
  return inspector;
}

function mountInspectorRegionVueIsland(
  inspector: HTMLElement,
  targetDocument: Document,
  runChainItems: DesktopRunChainItem[],
  selectedRunChainItemKey: string | null,
  workLens: DesktopWorkLensProjection | null,
  workLensActions: DesktopWorkLensActionOptions,
): void {
  if (!canMountVueIsland(inspector)) {
    return;
  }
  mountInspectorRegionIsland(inspector, {
    runChainItems,
    selectedRunChainItemKey,
    workLens,
    onRunChainAction: (action) => {
      if (action.type === "close") {
        toggleDesktopPanel(targetDocument, "inspector");
      } else if (action.type === "pin") {
        setRouteStatus(targetDocument, action.value ? "Run Chain pinned" : "Run Chain unpinned");
      } else if (action.type === "tab" || action.type === "summary") {
        setRouteStatus(targetDocument, `Run Chain ${action.label}`);
      } else if (action.type === "open-task-center") {
        toggleDesktopPanel(targetDocument, "bottom");
      } else if (action.type === "new-item") {
        setRouteStatus(targetDocument, "Open Cowork to create a run chain item.");
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

type RunChainOverviewTab = "context" | "files" | "tasks";

function createRunChainOverviewPanel(
  targetDocument: Document,
  runChainItems: DesktopRunChainItem[] = [],
): HTMLElement {
  const section = targetDocument.createElement("section");
  section.className = "desktop-run-chain-overview";
  section.setAttribute("aria-label", "Run Chain");

  const header = targetDocument.createElement("header");
  header.className = "desktop-run-chain-header";
  header.append(createText(targetDocument, "h2", "Run Chain"));
  const controls = targetDocument.createElement("div");
  controls.className = "desktop-run-chain-header-controls";
  for (const [label, value, action] of [
    ["Pin Run Chain", "Pin", "pin"],
    ["Close Run Chain", "Close", "close"],
  ]) {
    const button = targetDocument.createElement("button");
    button.type = "button";
    button.className = "desktop-run-chain-icon-button";
    button.setAttribute("aria-label", label);
    button.setAttribute("data-desktop-run-chain-control", action);
    if (action === "pin") {
      button.setAttribute("aria-pressed", "false");
    }
    button.textContent = value;
    button.addEventListener("click", () => {
      if (action === "close") {
        toggleDesktopPanel(targetDocument, "inspector");
        return;
      }
      const nextPressed = button.getAttribute("aria-pressed") !== "true";
      button.setAttribute("aria-pressed", String(nextPressed));
      button.textContent = nextPressed ? "Pinned" : "Pin";
      setRouteStatus(targetDocument, nextPressed ? "Run Chain pinned" : "Run Chain unpinned");
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
    panel.replaceChildren(...createRunChainOverviewPanelContent(targetDocument, tabId, runChainItems));
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
      setRouteStatus(targetDocument, `Run Chain ${tabInfo.label}`);
    });
    tabs.append(tab);
  }

  const summary = createRunChainSummaryStrip(targetDocument, runChainItems, selectTab);
  selectTab("context");

  const actions = targetDocument.createElement("div");
  actions.className = "desktop-run-chain-actions";
  actions.append(
    createRunChainActionButton(targetDocument, "Open Task Center", () => toggleDesktopPanel(targetDocument, "bottom")),
    createRunChainActionButton(targetDocument, "New Run Chain Item", () => {
      setRouteStatus(targetDocument, "Open Cowork to create a run chain item.");
    }, "desktop-run-chain-new-item"),
  );

  section.append(header, summary, tabs, panel, actions);
  mountRunChainOverviewVueIsland(section, targetDocument, runChainItems);
  return section;
}

function createRunChainSummaryStrip(
  targetDocument: Document,
  runChainItems: DesktopRunChainItem[],
  selectTab: (tabId: RunChainOverviewTab) => void,
): HTMLElement {
  const summary = targetDocument.createElement("div");
  summary.className = "desktop-run-chain-summary-strip";
  const status = runChainOverviewStatus(runChainItems);
  for (const item of [
    { label: "Gateway", value: "Connected", tab: "context" as const },
    { label: "Run", value: status, tab: "tasks" as const },
    { label: "Items", value: String(runChainItems.length), tab: "tasks" as const },
  ]) {
    const button = targetDocument.createElement("button");
    button.type = "button";
    button.className = "desktop-run-chain-summary-item";
    button.setAttribute("data-desktop-run-chain-summary", item.label.toLowerCase());
    button.textContent = `${item.label} ${item.value}`;
    button.addEventListener("click", () => {
      selectTab(item.tab);
      setRouteStatus(targetDocument, `Run Chain ${item.label}`);
    });
    summary.append(button);
  }
  return summary;
}

function createRunChainOverviewPanelContent(
  targetDocument: Document,
  tabId: RunChainOverviewTab,
  runChainItems: DesktopRunChainItem[],
): HTMLElement[] {
  if (tabId === "files") {
    return [
      createRunChainPanelSection(targetDocument, "Workspace", [
        ["Project", "tinybot"],
        ["Path", "D:\\code\\tinybot\\tinybot"],
      ], createWorkbenchLink(targetDocument, "Open Workspace", "/workspace", "desktop-run-chain-panel-action")),
    ];
  }

  if (tabId === "tasks") {
    const feed = createRunChainActivityFeed(targetDocument, runChainItems);
    return [
      createRunChainPanelSection(targetDocument, "Current Run", [
        ["Status", runChainOverviewStatus(runChainItems)],
        ["Chain items", String(runChainItems.length)],
      ], createRunChainActionButton(targetDocument, "New Run Chain Item", () => {
        setRouteStatus(targetDocument, "Open Cowork to create a run chain item.");
      }, "desktop-run-chain-panel-action desktop-run-chain-new-item")),
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
  if (action) {
    section.append(action);
  }
  return section;
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
): HTMLElement {
  const button = targetDocument.createElement("button");
  button.type = "button";
  button.className = className;
  button.setAttribute("data-desktop-run-chain-action", label);
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

function mountRunChainOverviewVueIsland(
  section: HTMLElement,
  targetDocument: Document,
  runChainItems: DesktopRunChainItem[],
): void {
  if (!canMountVueIsland(section)) {
    return;
  }
  mountRunChainOverviewIsland(section, {
    items: runChainItems,
    onAction: (action) => {
      if (action.type === "close") {
        toggleDesktopPanel(targetDocument, "inspector");
      } else if (action.type === "pin") {
        setRouteStatus(targetDocument, action.value ? "Run Chain pinned" : "Run Chain unpinned");
      } else if (action.type === "tab" || action.type === "summary") {
        setRouteStatus(targetDocument, `Run Chain ${action.label}`);
      } else if (action.type === "open-task-center") {
        toggleDesktopPanel(targetDocument, "bottom");
      } else if (action.type === "new-item") {
        setRouteStatus(targetDocument, "Open Cowork to create a run chain item.");
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
  return renderWorkLensProjection(targetDocument, buildDesktopWorkLensProjection({ task: item }), item);
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
  return panel;
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

function createQuickActions(targetDocument: Document): HTMLElement {
  const actions = targetDocument.createElement("div");
  actions.className = "desktop-quick-actions";
  for (const [label, href] of [
    ["New chat", "/chat/new"],
    ["Open workspace", "/workspace"],
    ["Gateway status", "/api/status"],
  ]) {
    actions.append(createWorkbenchLink(targetDocument, label, href, "desktop-quick-action"));
  }
  mountQuickActionsVueIsland(actions);
  return actions;
}

function mountQuickActionsVueIsland(actions: HTMLElement): void {
  if (!canMountVueIsland(actions)) {
    return;
  }
  mountQuickActionsIsland(actions);
}

function createFileActions(targetDocument: Document, chat: DesktopNativeChatModel | null = null): HTMLElement {
  const section = targetDocument.createElement("section");
  section.className = "desktop-file-actions";
  section.setAttribute("data-desktop-module-surface", "workspace knowledge");
  section.append(createText(targetDocument, "h2", "File imports"));

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

  const knowledge = createFileImportCard(targetDocument, {
    id: "desktop-knowledge-upload",
    label: "Import knowledge",
    uploadKind: "knowledge-document",
    dropTarget: "knowledge-document",
    formatsId: "desktop-file-knowledge-formats",
    formats: ["md", "pdf", "docx", "csv", "json"],
  });

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

  const workspace = createFileImportCard(targetDocument, {
    id: "desktop-workspace-file-drop",
    label: "Workspace import",
    href: "/workspace",
    dropTarget: "workspace-file",
    formatsId: "desktop-file-workspace-formats",
    formats: ["md", "txt", "json", "csv", "py", "js", "ts", "html", "css", "yaml", "toml"],
  });

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
  grid.append(knowledge, session, sessionCard, workspace);

  const operationStrip = targetDocument.createElement("div");
  operationStrip.className = "desktop-file-operation-strip";
  operationStrip.append(
    createFileOperationStatus(targetDocument, "Knowledge upload", "Waiting"),
    createFileOperationStatus(targetDocument, "Session upload", "Waiting"),
    createFileOperationStatus(targetDocument, "Workspace import", "Waiting"),
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

function createWorkspaceFilesSurface(targetDocument: Document): HTMLElement {
  const section = targetDocument.createElement("section");
  section.className = "desktop-workspace-files";
  section.setAttribute("data-desktop-module-surface", "workspace");
  section.setAttribute("data-desktop-workspace-layout", "browser-detail-actions");

  const header = targetDocument.createElement("div");
  header.className = "desktop-workspace-header";
  const titleGroup = targetDocument.createElement("div");
  titleGroup.className = "desktop-workspace-title-group";
  titleGroup.append(
    createText(targetDocument, "h2", "Workspace files"),
    createText(targetDocument, "p", "Browse, inspect, edit, and export workspace files."),
  );

  const status = targetDocument.createElement("p");
  status.setAttribute("id", "desktop-workspace-status");
  status.setAttribute("class", "desktop-workspace-status");
  status.textContent = "0 files";
  header.append(titleGroup, status);

  const recent = targetDocument.createElement("div");
  recent.setAttribute("id", "desktop-workspace-recent-files");
  recent.setAttribute("class", "desktop-workspace-recent-files");
  recent.setAttribute("aria-label", "Recent workspace files");

  const search = targetDocument.createElement("input");
  search.setAttribute("id", "desktop-workspace-search");
  search.setAttribute("class", "desktop-workspace-search");
  search.setAttribute("type", "search");
  search.setAttribute("placeholder", "Search workspace files...");
  search.setAttribute("aria-label", "Search workspace files");

  const activePath = targetDocument.createElement("p");
  activePath.setAttribute("id", "desktop-workspace-active-path");
  activePath.setAttribute("class", "desktop-workspace-active-path");
  activePath.textContent = "No workspace file selected.";

  const updatedAt = targetDocument.createElement("p");
  updatedAt.setAttribute("id", "desktop-workspace-updated-at");
  updatedAt.setAttribute("class", "desktop-workspace-updated-at");
  updatedAt.textContent = "No timestamp";

  const size = targetDocument.createElement("p");
  size.setAttribute("id", "desktop-workspace-size");
  size.setAttribute("class", "desktop-workspace-size");
  size.textContent = "No size";

  const detail = targetDocument.createElement("p");
  detail.setAttribute("id", "desktop-workspace-detail");
  detail.setAttribute("class", "desktop-workspace-detail");
  detail.textContent = "No workspace file selected.";

  const browser = targetDocument.createElement("aside");
  browser.className = "desktop-workspace-browser";
  browser.append(
    createText(targetDocument, "h3", "Files"),
    search,
    recent,
  );
  mountWorkspaceBrowserVueIsland(browser);

  const detailPanel = targetDocument.createElement("section");
  detailPanel.className = "desktop-workspace-detail-panel";
  detailPanel.append(
    createText(targetDocument, "h3", "Selection"),
    activePath,
    updatedAt,
    size,
    detail,
  );

  const editor = targetDocument.createElement("textarea");
  editor.setAttribute("id", "desktop-workspace-editor");
  editor.setAttribute("class", "desktop-workspace-editor");
  editor.setAttribute("aria-label", "Workspace file editor");

  const editorPanel = targetDocument.createElement("section");
  editorPanel.className = "desktop-workspace-editor-panel";
  editorPanel.append(
    createText(targetDocument, "h3", "Editor"),
    editor,
  );

  const saveState = targetDocument.createElement("p");
  saveState.setAttribute("id", "desktop-workspace-save-state");
  saveState.setAttribute("class", "desktop-workspace-save-state");
  saveState.textContent = "Select a workspace file";

  const error = targetDocument.createElement("p");
  error.setAttribute("id", "desktop-workspace-error");
  error.setAttribute("class", "desktop-workspace-error");
  error.textContent = "";

  const save = targetDocument.createElement("button");
  save.setAttribute("id", "desktop-workspace-save");
  save.setAttribute("type", "button");
  save.setAttribute("class", "desktop-file-action");
  save.setAttribute("disabled", "");
  save.textContent = "Save";

  const reveal = targetDocument.createElement("button");
  reveal.setAttribute("id", "desktop-workspace-reveal");
  reveal.setAttribute("type", "button");
  reveal.setAttribute("class", "desktop-file-action");
  reveal.setAttribute("disabled", "");
  reveal.textContent = "Reveal";

  const reload = targetDocument.createElement("button");
  reload.setAttribute("id", "desktop-workspace-reload");
  reload.setAttribute("type", "button");
  reload.setAttribute("class", "desktop-file-action desktop-workspace-reload");
  reload.setAttribute("disabled", "");
  reload.textContent = "Reload";

  const exportButton = targetDocument.createElement("button");
  exportButton.setAttribute("id", "desktop-workspace-export");
  exportButton.setAttribute("type", "button");
  exportButton.setAttribute("class", "desktop-file-action");
  exportButton.setAttribute("disabled", "");
  exportButton.textContent = "Export";

  const actions = targetDocument.createElement("div");
  actions.setAttribute("class", "desktop-workspace-actions");
  actions.append(save, reveal, exportButton, reload);

  const actionRail = targetDocument.createElement("aside");
  actionRail.className = "desktop-workspace-action-rail";
  actionRail.setAttribute("aria-label", "Workspace file actions");
  actionRail.append(
    createText(targetDocument, "h3", "Actions"),
    actions,
    saveState,
    error,
  );

  section.append(header, browser, detailPanel, editorPanel, actionRail);
  return section;
}

function mountWorkspaceBrowserVueIsland(browser: HTMLElement): void {
  if (!canMountVueIsland(browser)) {
    return;
  }
  mountWorkspaceBrowserIsland(browser);
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

function createSharedSidebarLinkSection(targetDocument: Document, group: DesktopSidebarGroup | undefined): HTMLElement {
  const section = targetDocument.createElement("section");
  section.className = "desktop-workbench-section";
  section.append(createText(targetDocument, "h2", group?.label ?? "Resources"));
  const linkItems: Array<DesktopSidebarItem & { href: string; kind: "link" }> = [];
  for (const item of group?.items ?? []) {
    if (item.kind === "link" && item.href) {
      linkItems.push({ ...item, href: item.href, kind: "link" });
      section.append(createSharedWorkbenchLink(targetDocument, item));
    }
  }
  mountSharedSidebarLinksVueIsland(section, group?.label, linkItems);
  return section;
}

function mountSharedSidebarLinksVueIsland(
  section: HTMLElement,
  label: string | undefined,
  items: Array<DesktopSidebarItem & { href: string; kind: "link" }>,
): void {
  if (!canMountVueIsland(section)) {
    return;
  }
  mountSharedSidebarLinksIsland(section, { label, items });
}

function createSharedSidebarCommandSection(targetDocument: Document, group: DesktopSidebarGroup | undefined): HTMLElement {
  const section = targetDocument.createElement("section");
  section.className = "desktop-workbench-section";
  section.append(createText(targetDocument, "h2", group?.label ?? "System"));
  const commandItems: Array<DesktopSidebarItem & { commandId: string; kind: "command" }> = [];
  for (const item of group?.items ?? []) {
    if (item.kind === "command" && item.commandId) {
      commandItems.push({ ...item, commandId: item.commandId, kind: "command" });
      section.append(createSharedSidebarCommandButton(targetDocument, item));
    }
  }
  mountSharedSidebarCommandsVueIsland(section, targetDocument, group?.label, commandItems);
  return section;
}

function mountSharedSidebarCommandsVueIsland(
  section: HTMLElement,
  targetDocument: Document,
  label: string | undefined,
  items: Array<DesktopSidebarItem & { commandId: string; kind: "command" }>,
): void {
  if (!canMountVueIsland(section)) {
    return;
  }
  mountSharedSidebarCommandsIsland(section, { label, items, targetDocument });
}

function createSharedWorkbenchLink(targetDocument: Document, item: DesktopSidebarItem): HTMLElement {
  const link = createWorkbenchLink(targetDocument, item.label, item.href ?? "#", "desktop-workbench-link");
  applySharedSidebarItemAttributes(link, item);
  mountSharedSidebarLinkVueIsland(link, item);
  return link;
}

function mountSharedSidebarLinkVueIsland(link: HTMLElement, item: DesktopSidebarItem): void {
  if (!canMountVueIsland(link) || item.kind !== "link" || !item.href) {
    return;
  }
  mountSharedSidebarLinkIsland(link, {
    href: item.href ?? "#",
    icon: item.icon,
    id: item.id,
    kind: "link",
    label: item.label,
  });
}

function createSharedSidebarCommandButton(targetDocument: Document, item: DesktopSidebarItem): HTMLElement {
  const button = targetDocument.createElement("button");
  button.className = "desktop-workbench-link";
  button.setAttribute("type", "button");
  button.textContent = item.label;
  applySharedSidebarItemAttributes(button, item);
  button.addEventListener("click", () => {
    if (!item.commandId) {
      return;
    }
    targetDocument.dispatchEvent(new CustomEvent("desktop-menu-command", {
      detail: { id: item.commandId, source: "native-sidebar" },
    }));
  });
  mountSharedSidebarCommandButtonVueIsland(button, item);
  return button;
}

function mountSharedSidebarCommandButtonVueIsland(button: HTMLElement, item: DesktopSidebarItem): void {
  if (!canMountVueIsland(button) || item.kind !== "command" || !item.commandId) {
    return;
  }
  mountSharedSidebarCommandButtonIsland(button, {
    commandId: item.commandId ?? "",
    icon: item.icon,
    id: item.id,
    kind: "command",
    label: item.label,
  });
}

function applySharedSidebarItemAttributes(element: HTMLElement, item: DesktopSidebarItem): void {
  element.setAttribute("data-sidebar-item-id", item.id);
  element.setAttribute("data-sidebar-item-kind", item.kind);
  if (item.href) {
    element.setAttribute("data-sidebar-href", item.href);
  }
  if (item.commandId) {
    element.setAttribute("data-sidebar-command", item.commandId);
  }
  if (item.icon) {
    element.setAttribute("data-sidebar-icon", item.icon);
  }
}

function createWorkbenchLink(targetDocument: Document, label: string, href: string, className: string): HTMLElement {
  const link = targetDocument.createElement("a");
  link.className = className;
  link.setAttribute("href", href);
  link.textContent = label;
  return link;
}

function createText(targetDocument: Document, tagName: keyof HTMLElementTagNameMap, text: string): HTMLElement {
  const element = targetDocument.createElement(tagName);
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

    body.desktop-native-workbench .desktop-activity-button,
    body.desktop-native-workbench .desktop-quick-action {
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
      grid-column: 2;
      width: var(--region-size);
    }

    body.desktop-native-workbench .desktop-workbench-inspector {
      grid-column: 4;
      width: var(--region-size);
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
      width: min(820px, 100%);
      max-width: 820px;
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
      display: grid;
      gap: 8px;
      min-width: 0;
      width: 100%;
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
    body.desktop-native-workbench .desktop-activity-button:focus-visible,
    body.desktop-native-workbench .desktop-quick-action:focus-visible {
      outline: 2px solid var(--primary);
      outline-offset: 2px;
      box-shadow: 0 0 0 4px var(--focus-ring);
    }

    body.desktop-native-workbench .desktop-quick-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    body.desktop-native-workbench .desktop-quick-actions .desktop-quick-action:first-child {
      border-color: var(--primary);
      background: var(--primary);
      color: #ffffff;
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
    body.desktop-native-workbench .desktop-chat-header-panel-button:focus-visible,
    body.desktop-native-workbench .desktop-run-chain-icon-button:focus-visible,
    body.desktop-native-workbench .desktop-run-chain-summary-item:focus-visible,
    body.desktop-native-workbench .desktop-run-chain-tab:focus-visible,
    body.desktop-native-workbench .desktop-run-chain-panel-action:focus-visible,
    body.desktop-native-workbench .desktop-run-chain-feed-item:focus-visible {
      outline: 2px solid var(--primary, #cc785c);
      outline-offset: 2px;
    }

    body.desktop-native-workbench .desktop-quick-action,
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

    body.desktop-native-workbench .desktop-workspace-files {
      display: grid;
      grid-template-columns: minmax(220px, 0.78fr) minmax(0, 1.55fr) minmax(150px, 0.48fr);
      grid-template-areas:
        "header header header"
        "browser detail actions"
        "browser editor actions";
      gap: 12px;
      align-items: stretch;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-workspace-header,
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

    body.desktop-native-workbench .desktop-workspace-detail-panel {
      grid-area: detail;
    }

    body.desktop-native-workbench .desktop-workspace-editor-panel {
      grid-area: editor;
    }

    body.desktop-native-workbench .desktop-workspace-action-rail {
      grid-area: actions;
    }

    body.desktop-native-workbench .desktop-workspace-browser,
    body.desktop-native-workbench .desktop-workspace-detail-panel,
    body.desktop-native-workbench .desktop-workspace-editor-panel,
    body.desktop-native-workbench .desktop-workspace-action-rail {
      display: grid;
      align-content: start;
      gap: 10px;
      padding: 10px;
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
      text-overflow: ellipsis;
      white-space: nowrap;
      cursor: pointer;
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
      width: min(1100px, 100%);
      min-width: 0;
      margin: 0 auto 10px;
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
      gap: 16px;
      align-items: center;
      justify-content: flex-end;
      min-width: 0;
      overflow: hidden;
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
      grid-template-columns: 92px minmax(220px, 280px) minmax(0, 1fr) minmax(280px, 340px);
      grid-template-rows: minmax(0, 1fr) auto;
      border-top: 0;
      background: #fbfaf7;
    }

    body.desktop-native-workbench .desktop-workbench-shell[data-inspector-visible="false"] {
      grid-template-columns: 92px minmax(220px, 280px) minmax(0, 1fr) 0;
    }

    body.desktop-native-workbench .desktop-workbench-shell[data-sidebar-visible="false"] {
      grid-template-columns: 92px 0 minmax(0, 1fr) minmax(280px, 340px);
    }

    body.desktop-native-workbench .desktop-workbench-shell[data-sidebar-visible="false"][data-inspector-visible="false"] {
      grid-template-columns: 92px 0 minmax(0, 1fr) 0;
    }

    body.desktop-native-workbench .desktop-activity-rail {
      justify-content: space-between;
      gap: 14px;
      padding: 16px 10px 18px;
      background: #fbfaf7;
    }

    body.desktop-native-workbench .desktop-activity-primary,
    body.desktop-native-workbench .desktop-activity-secondary {
      display: grid;
      gap: 14px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-activity-button,
    body.desktop-native-workbench .desktop-activity-secondary-button {
      width: 72px;
      min-height: 48px;
      border-radius: 8px;
      color: #2f302e;
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
      background: #ffffff;
      color: var(--primary);
      box-shadow: 0 8px 20px rgba(20, 20, 19, 0.08);
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

    body.desktop-native-workbench .desktop-workbench-inspector {
      margin: 16px 16px 16px 0;
      border: 1px solid #e9e4df;
      border-radius: 14px;
      background: #ffffff;
      box-shadow: 0 12px 34px rgba(20, 20, 19, 0.08);
    }

    body.desktop-native-workbench .desktop-sidebar-content {
      display: grid;
      grid-template-rows: auto auto auto;
      align-content: start;
      gap: 10px;
      height: 100%;
      min-height: 0;
      padding: 18px 14px;
      overflow: hidden;
      background: #fbfaf7;
    }

    body.desktop-native-workbench .desktop-sidebar-content > .desktop-workbench-section {
      display: none;
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

    body.desktop-native-workbench .desktop-sidebar-chat-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 6px;
      min-width: 0;
      min-height: 36px;
      border: 1px solid transparent;
      border-radius: 7px;
      padding: 0 5px 0 0;
      transition: background-color 120ms ease, border-color 120ms ease;
    }

    body.desktop-native-workbench .desktop-sidebar-chat-row .desktop-sidebar-row {
      min-width: 0;
      min-height: 34px;
      border: 0;
      padding: 0 4px 0 10px;
      background: transparent;
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
      width: 24px;
      min-height: 24px;
      border: 1px solid transparent;
      border-radius: 5px;
      background: transparent;
      color: #8b5b4e;
      font: 600 11px/1 var(--font-sans);
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-sidebar-delete-session[data-confirming="true"] {
      width: 64px;
    }

    body.desktop-native-workbench .desktop-sidebar-chat-row:hover {
      border-color: #eee4dd;
      background: #fffdfb;
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
      background: #f8e7e1;
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
      color: #77736f;
      font-size: 12px;
      font-weight: 400;
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
      align-self: stretch;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      gap: 0;
      justify-items: center;
      width: 100%;
      max-width: none;
      height: 100%;
      min-height: 0;
      margin: 0;
      padding: 0 clamp(20px, 3vw, 46px);
      overflow: hidden;
      background: #f7f7f5;
    }

    body.desktop-native-workbench .desktop-chat-workbench > span,
    body.desktop-native-workbench .desktop-chat-workbench > .desktop-quick-actions,
    body.desktop-native-workbench .desktop-chat-workbench > .desktop-panel-controls {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
      clip-path: inset(50%);
      white-space: nowrap;
    }

    body.desktop-native-workbench .desktop-chat-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      width: min(1120px, 100%);
      min-width: 0;
      min-height: 54px;
      border-bottom: 1px solid #e9e4df;
      padding: 0 18px;
      background: #ffffff;
    }

    body.desktop-native-workbench .desktop-chat-title-row {
      position: relative;
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
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
      display: grid;
      align-content: start;
      gap: 22px;
      width: min(1120px, 100%);
      min-height: 0;
      padding: 32px min(8vw, 72px) 22px;
      overflow-y: auto;
      overflow-x: hidden;
    }

    body.desktop-native-workbench .desktop-conversation-message {
      display: grid;
      max-width: 760px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-conversation-content {
      display: grid;
      gap: 10px;
      min-width: 0;
      color: #1f1d1a;
      font: 14px/1.75 var(--font-sans);
    }

    body.desktop-native-workbench .desktop-conversation-meta {
      display: flex;
      align-items: baseline;
      gap: 10px;
      min-width: 0;
      color: #6d6964;
      font-size: 12px;
      line-height: 1.2;
    }

    body.desktop-native-workbench .desktop-conversation-meta strong {
      color: #1f1d1a;
      font-size: 14px;
    }

    body.desktop-native-workbench .desktop-conversation-content p {
      margin: 0;
      overflow-wrap: anywhere;
    }

    body.desktop-native-workbench .desktop-message-reasoning {
      overflow: hidden;
      border: 1px solid #e2d9d2;
      border-radius: 8px;
      background: #fbfaf7;
      color: #625d57;
      font-size: 13px;
    }

    body.desktop-native-workbench .desktop-message-reasoning summary {
      list-style: none;
    }

    body.desktop-native-workbench .desktop-message-reasoning summary::-webkit-details-marker {
      display: none;
    }

    body.desktop-native-workbench .desktop-message-reasoning-summary {
      display: flex;
      align-items: center;
      gap: 10px;
      min-height: 36px;
      padding: 8px 11px;
      cursor: pointer;
      user-select: none;
    }

    body.desktop-native-workbench .desktop-message-reasoning-summary::before {
      content: ">";
      display: grid;
      place-items: center;
      width: 16px;
      height: 16px;
      border-radius: 4px;
      color: #a9583e;
      font: 700 11px/1 var(--font-mono);
      transition: transform 150ms ease;
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
      max-height: 320px;
      overflow: auto;
      padding: 0 14px 12px 37px;
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
      width: min(1120px, calc(100% - 40px));
      min-height: 0;
      margin: 0 auto 8px;
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
      gap: 10px 18px;
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
      overflow-x: auto;
      overflow-y: visible;
      gap: 16px;
      flex-wrap: nowrap;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-native-composer-model {
      min-height: 34px;
      border: 0;
      border-radius: 999px;
      padding: 0 14px;
      background: #fffaf6;
      color: #262522;
      font: 600 12px/1.2 var(--font-sans);
      box-shadow: none;
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-native-composer-model:focus-visible,
    body.desktop-native-workbench .desktop-native-composer-rag-toggle[aria-pressed="true"] {
      outline: 0;
      box-shadow: 0 8px 20px rgba(216, 112, 72, 0.18);
    }

    body.desktop-native-workbench .desktop-native-composer-rag-toggle[aria-pressed="false"] {
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

    html[data-desktop-active-workbench-module="workspace"] body.desktop-native-workbench .desktop-chat-workbench,
    html[data-desktop-active-workbench-module="knowledge"] body.desktop-native-workbench .desktop-chat-workbench,
    html[data-desktop-active-workbench-module="cowork"] body.desktop-native-workbench .desktop-chat-workbench,
    html[data-desktop-active-workbench-module="settings"] body.desktop-native-workbench .desktop-chat-workbench,
    html[data-desktop-active-workbench-module="docs"] body.desktop-native-workbench .desktop-chat-workbench {
      display: none;
    }

    html[data-desktop-active-workbench-module="workspace"] body.desktop-native-workbench .desktop-native-composer,
    html[data-desktop-active-workbench-module="knowledge"] body.desktop-native-workbench .desktop-native-composer,
    html[data-desktop-active-workbench-module="cowork"] body.desktop-native-workbench .desktop-native-composer,
    html[data-desktop-active-workbench-module="settings"] body.desktop-native-workbench .desktop-native-composer,
    html[data-desktop-active-workbench-module="docs"] body.desktop-native-workbench .desktop-native-composer {
      display: none;
    }

    html[data-desktop-active-workbench-module="settings"] body.desktop-native-workbench .desktop-workbench-shell {
      grid-template-columns: 56px minmax(220px, var(--desktop-sidebar-size, 260px)) minmax(0, 1fr) 0;
    }

    html[data-desktop-active-workbench-module="settings"] body.desktop-native-workbench .desktop-workbench-inspector {
      display: none;
    }

    html[data-desktop-active-workbench-module="workspace"] body.desktop-native-workbench .desktop-utility-surfaces,
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

    html[data-desktop-active-workbench-module="workspace"] body.desktop-native-workbench [data-desktop-module-surface~="workspace"],
    html[data-desktop-active-workbench-module="knowledge"] body.desktop-native-workbench [data-desktop-module-surface~="knowledge"],
    html[data-desktop-active-workbench-module="cowork"] body.desktop-native-workbench [data-desktop-module-surface~="cowork"],
    html[data-desktop-active-workbench-module="settings"] body.desktop-native-workbench [data-desktop-module-surface~="settings"],
    html[data-desktop-active-workbench-module="docs"] body.desktop-native-workbench [data-desktop-module-surface~="docs"] {
      display: grid;
    }

    body.desktop-native-workbench .desktop-settings-pane {
      grid-template-columns: minmax(180px, 220px) minmax(0, 1fr);
      justify-content: stretch;
      align-items: start;
      gap: 28px;
      min-width: 0;
      width: 100%;
      max-width: 1180px;
      margin: 0 auto;
    }

    body.desktop-native-workbench .desktop-settings-sidebar {
      position: sticky;
      top: 0;
      display: grid;
      align-content: start;
      gap: 16px;
      min-width: 0;
      padding-top: 6px;
    }

    body.desktop-native-workbench .desktop-settings-search {
      width: 100%;
      min-width: 0;
      min-height: 34px;
      border: 1px solid #e5ded7;
      border-radius: 8px;
      background: #fffdfa;
      color: #25211d;
      padding: 0 10px;
      font: 500 13px/1.35 var(--font-sans);
    }

    body.desktop-native-workbench .desktop-settings-nav {
      display: grid;
      gap: 5px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-settings-nav-heading {
      margin: 14px 0 4px;
      color: #9a9189;
      font: 650 11px/1.2 var(--font-sans);
      text-transform: uppercase;
    }

    body.desktop-native-workbench .desktop-settings-nav-item {
      display: flex;
      align-items: center;
      min-height: 34px;
      min-width: 0;
      border-radius: 7px;
      padding: 0 10px;
      color: #3a332e;
      font: 650 13px/1.25 var(--font-sans);
      text-decoration: none;
    }

    body.desktop-native-workbench .desktop-settings-nav-item:hover,
    body.desktop-native-workbench .desktop-settings-nav-item:focus-visible,
    body.desktop-native-workbench .desktop-settings-nav-item[data-active="true"] {
      background: #eee9e3;
      color: #1f1d1a;
    }

    body.desktop-native-workbench .desktop-settings-content {
      display: grid;
      gap: 26px;
      width: 100%;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-settings-header {
      display: flex;
      align-items: start;
      justify-content: space-between;
      gap: 16px;
      min-width: 0;
      padding-top: 22px;
    }

    body.desktop-native-workbench .desktop-settings-breadcrumb h2 {
      margin: 0;
      color: #1f1d1a;
      font: 700 20px/1.2 var(--font-sans);
      letter-spacing: 0;
    }

    body.desktop-native-workbench .desktop-settings-breadcrumb {
      color: #8c847c;
    }

    body.desktop-native-workbench .desktop-settings-default-llm-card,
    body.desktop-native-workbench .desktop-settings-provider-section {
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-settings-default-llm-card {
      display: grid;
      gap: 12px;
      border: 1px solid #ebe4dd;
      border-radius: 8px;
      padding: 34px 40px;
      background: #fffdfa;
    }

    body.desktop-native-workbench .desktop-settings-card-heading h2,
    body.desktop-native-workbench .desktop-settings-provider-header h2 {
      margin: 0;
      color: #1f1d1a;
      font: 750 21px/1.2 var(--font-sans);
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
      color: #3b352f;
      font: 650 13px/1.3 var(--font-sans);
    }

    body.desktop-native-workbench .desktop-settings-inline-field select,
    body.desktop-native-workbench .desktop-settings-inline-field input,
    body.desktop-native-workbench .desktop-settings-provider-search {
      width: 100%;
      min-width: 0;
      min-height: 34px;
      border: 1px solid #e0d8d0;
      border-radius: 6px;
      padding: 0 10px;
      background: #fffdfa;
      color: #25211d;
      font: 500 13px/1.35 var(--font-sans);
    }

    body.desktop-native-workbench .desktop-settings-save-status-button {
      min-height: 34px;
      border: 1px solid #d8d0c8;
      border-radius: 6px;
      padding: 0 14px;
      background: #f8f6f2;
      color: #5c554e;
      font: 700 13px/1.2 var(--font-sans);
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-settings-save-status-button:disabled {
      cursor: not-allowed;
      opacity: 0.62;
    }

    body.desktop-native-workbench .desktop-settings-default-llm-copy {
      margin: 0;
      color: #6b635c;
      font: 500 13px/1.55 var(--font-sans);
    }

    body.desktop-native-workbench .desktop-settings-provider-section {
      display: grid;
      gap: 18px;
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
      border: 1px solid #d8d0c8;
      border-radius: 6px;
      padding: 0 12px;
      background: #fffdfa;
      color: #25211d;
      font: 700 13px/1.2 var(--font-sans);
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
      border-color: #f07a2b;
      background: #ff7a1a;
      color: #ffffff;
    }

    body.desktop-native-workbench .desktop-settings-provider-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-settings-provider-card {
      display: grid;
      align-content: space-between;
      gap: 20px;
      min-width: 0;
      min-height: 250px;
      border: 1px solid #ebe4dd;
      border-radius: 8px;
      padding: 28px 26px 18px;
      background: #fffdfa;
    }

    body.desktop-native-workbench .desktop-settings-provider-card-header {
      display: flex;
      align-items: start;
      justify-content: space-between;
      gap: 12px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-settings-provider-title {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-settings-provider-title h3 {
      margin: 0;
      color: #141413;
      font: 750 20px/1.2 var(--font-sans);
      letter-spacing: 0;
    }

    body.desktop-native-workbench .desktop-settings-provider-badge {
      border-radius: 5px;
      padding: 2px 6px;
      background: #d9f7f1;
      color: #08756b;
      font: 700 11px/1.2 var(--font-sans);
    }

    body.desktop-native-workbench .desktop-settings-provider-status {
      color: #8c847c;
      font: 700 12px/1.2 var(--font-sans);
      white-space: nowrap;
    }

    body.desktop-native-workbench .desktop-settings-provider-details {
      display: grid;
      gap: 8px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-settings-provider-detail {
      margin: 0;
      color: #8a827a;
      font: 500 12px/1.45 var(--font-sans);
      overflow-wrap: anywhere;
    }

    body.desktop-native-workbench .desktop-settings-provider-detail strong {
      color: #4a433d;
      font-weight: 600;
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
      color: #67605a;
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
      border: 1px solid #d8d0c8;
      border-radius: 6px;
      background: #fffdfa;
      color: #25211d;
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
      border: 1px solid #ebe4dd;
      border-radius: 8px;
      background: #fffdfa;
      overflow: hidden;
    }

    body.desktop-native-workbench .desktop-settings-summary {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-settings-status-item {
      min-width: 0;
      margin: 0;
      border-bottom: 1px solid #eee8e1;
      padding: 12px 14px;
      color: #67605a;
      font: 600 12px/1.45 var(--font-sans);
    }

    body.desktop-native-workbench .desktop-settings-status-item:nth-last-child(-n + 2) {
      border-bottom: 0;
    }

    body.desktop-native-workbench .desktop-settings-status-item strong {
      color: #36312c;
      font-weight: 650;
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
      border: 1px solid #ebe4dd;
      border-radius: 8px;
      background: #fffdfa;
      overflow: hidden;
    }

    body.desktop-native-workbench .desktop-settings-group h2 {
      margin: 0;
      padding: 16px 18px 0;
      color: #2d2924;
      font: 650 14px/1.2 var(--font-sans);
      letter-spacing: 0;
    }

    body.desktop-native-workbench .desktop-settings-group-description {
      padding: 0 18px 14px;
    }

    body.desktop-native-workbench .desktop-settings-field {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(220px, 320px);
      align-items: center;
      gap: 22px;
      margin: 0;
      border-top: 1px solid #eee8e1;
      padding: 14px 18px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-settings-field-copy {
      display: grid;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-settings-field label {
      color: #2d2924;
      font: 650 13px/1.35 var(--font-sans);
    }

    body.desktop-native-workbench .desktop-settings-field input,
    body.desktop-native-workbench .desktop-settings-field select,
    body.desktop-native-workbench .desktop-settings-field textarea {
      width: 100%;
      min-width: 0;
      min-height: 34px;
      padding: 7px 9px;
    }

    body.desktop-native-workbench .desktop-settings-field input[type="checkbox"] {
      width: 18px;
      min-height: 18px;
      padding: 0;
      justify-self: end;
    }

    body.desktop-native-workbench .desktop-settings-field textarea {
      min-height: 76px;
      resize: vertical;
    }

    body.desktop-native-workbench .desktop-settings-field input[aria-invalid="true"],
    body.desktop-native-workbench .desktop-settings-field select[aria-invalid="true"],
    body.desktop-native-workbench .desktop-settings-field textarea[aria-invalid="true"] {
      border-color: #bd3d2a;
      box-shadow: 0 0 0 1px rgba(189, 61, 42, 0.12);
    }

    body.desktop-native-workbench .desktop-settings-actions button:focus-visible,
    body.desktop-native-workbench .desktop-settings-save-status-button:focus-visible,
    body.desktop-native-workbench .desktop-settings-search:focus-visible,
    body.desktop-native-workbench .desktop-settings-provider-search:focus-visible,
    body.desktop-native-workbench .desktop-settings-provider-icon-button:focus-visible,
    body.desktop-native-workbench .desktop-settings-provider-add:focus-visible,
    body.desktop-native-workbench .desktop-settings-provider-card-actions button:focus-visible,
    body.desktop-native-workbench .desktop-settings-nav-item:focus-visible,
    body.desktop-native-workbench .desktop-settings-inline-field select:focus-visible,
    body.desktop-native-workbench .desktop-settings-inline-field input:focus-visible,
    body.desktop-native-workbench .desktop-settings-field input:focus-visible,
    body.desktop-native-workbench .desktop-settings-field select:focus-visible,
    body.desktop-native-workbench .desktop-settings-field textarea:focus-visible {
      outline: 2px solid rgba(31, 111, 235, 0.45);
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

      body.desktop-native-workbench .desktop-settings-default-llm-form,
      body.desktop-native-workbench .desktop-settings-provider-grid,
      body.desktop-native-workbench .desktop-settings-provider-tools {
        grid-template-columns: minmax(0, 1fr);
      }

      body.desktop-native-workbench .desktop-settings-provider-header {
        align-items: stretch;
        flex-direction: column;
      }

      body.desktop-native-workbench .desktop-settings-field input[type="checkbox"] {
        justify-self: start;
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
      grid-template-rows: auto minmax(0, 1fr);
      gap: 16px;
      height: 100%;
      min-height: 0;
      padding: 18px 20px;
      overflow-y: auto;
      overflow-x: hidden;
      background: #fbfaf7;
    }

    body.desktop-native-workbench .desktop-run-chain-overview {
      display: grid;
      grid-template-rows: auto auto auto minmax(0, 1fr) auto;
      gap: 10px;
      min-width: 0;
      min-height: 0;
    }

    body.desktop-native-workbench .desktop-run-chain-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      min-width: 0;
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

    body.desktop-native-workbench .desktop-run-chain-icon-button[aria-pressed="true"] {
      border-color: rgba(217, 104, 76, 0.35);
      background: rgba(217, 104, 76, 0.1);
      color: var(--primary);
    }

    body.desktop-native-workbench .desktop-run-chain-summary-strip {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 6px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-run-chain-summary-item {
      display: grid;
      min-width: 0;
      min-height: 34px;
      border: 1px solid #e6dfd8;
      border-radius: 6px;
      padding: 5px 7px;
      overflow: hidden;
      background: #fffdf9;
      color: #3f3a35;
      font: 700 11px/1.25 var(--font-sans);
      text-align: left;
      text-overflow: ellipsis;
      white-space: nowrap;
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-run-chain-tabs {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 4px;
      min-width: 0;
      border: 1px solid #e3dbd4;
      border-radius: 7px;
      padding: 3px;
      background: #f2eee8;
    }

    body.desktop-native-workbench .desktop-run-chain-tab {
      min-width: 0;
      min-height: 30px;
      border: 0;
      border-radius: 5px;
      padding: 0 8px;
      background: transparent;
      color: #262522;
      font: 700 12px/1.2 var(--font-sans);
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-run-chain-tab[aria-selected="true"] {
      background: #ffffff;
      color: #1f1d1a;
      box-shadow: 0 1px 2px rgba(20, 20, 19, 0.06);
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
      border-top: 1px solid #e7dfd8;
      padding: 10px 0 2px;
    }

    body.desktop-native-workbench .desktop-run-chain-card-row {
      margin: 0;
      color: #4e4943;
      font: 12px/1.4 var(--font-sans);
      overflow-wrap: anywhere;
    }

    body.desktop-native-workbench .desktop-run-chain-actions {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-run-chain-panel-action,
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

    body.desktop-native-workbench .desktop-run-chain-feed-item {
      overflow: hidden;
      text-align: left;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    body.desktop-native-workbench .desktop-run-chain-new-item {
      border-color: var(--primary);
      color: var(--primary);
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
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-default-llm-card,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-provider-card {
      background: var(--panel-strong);
      border-color: var(--border);
    }

    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-status-item,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-field {
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
    html[data-theme="dark"] body.desktop-native-workbench .desktop-settings-status-item,
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
    html[data-theme="dark"] body.desktop-native-workbench .desktop-run-chain-card-row,
    html[data-theme="dark"] body.desktop-native-workbench .desktop-gateway-runtime-row {
      color: var(--text-muted);
    }

    html[data-theme="dark"] body.desktop-native-workbench .desktop-native-composer-send:not(:disabled),
    html[data-theme="dark"] body.desktop-native-workbench .desktop-quick-actions .desktop-quick-action:first-child {
      background: var(--accent);
      border-color: var(--accent);
      color: var(--on-primary);
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
        padding: 0 16px;
      }

      body.desktop-native-workbench .desktop-conversation-thread {
        padding: 28px 18px 18px;
      }

      body.desktop-native-workbench .desktop-conversation-message {
        grid-template-columns: 48px minmax(0, 1fr);
      }

      body.desktop-native-workbench .desktop-native-composer {
        width: calc(100% - 28px);
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
