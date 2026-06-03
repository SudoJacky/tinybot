import { isAgentUiFormSubmittable, type AgentUiForm, type AgentUiFormField } from "./agentUiEvents";
import type { GatewayRuntimeStatus } from "./desktopGatewayStartup";
import {
  buildDesktopGatewayRuntimeActions,
  buildDesktopGatewayRuntimeDiagnostics,
  buildDesktopGatewayRuntimeRows,
  type DesktopGatewayRuntimeActionId,
} from "./desktopGatewayRuntimeControls";
import {
  buildDesktopPageHelpText,
  buildDesktopShortcutHelpText,
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

interface DesktopNativeChatActionOptions {
  onComposerSubmit?: (event: DesktopNativeChatComposerSubmitEvent) => void;
  onInterrupt?: () => void;
  onNewChat?: () => void;
  onDeleteSession?: (event: DesktopNativeChatDeleteSessionEvent) => void;
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
  gatewayHttp = "",
  chatActions: DesktopNativeChatActionOptions = {},
): void {
  syncNativeChatDocumentState(targetDocument, chat);
  const header = targetDocument.querySelector<HTMLElement>(".desktop-chat-header");
  if (header) {
    const next = createChatHeader(targetDocument, chat);
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
    const http =
      gatewayHttp ||
      targetDocument
        .querySelector<HTMLElement>(".desktop-native-composer-chip")
        ?.textContent
        ?.replace(/^Gateway ready:\s*/, "") ||
      "";
    const next = createNativeComposerSurface(targetDocument, http, chat, chatActions);
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
  return sidebar;
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
  return section;
}

function createSidebarWorkspaceList(targetDocument: Document, chat: DesktopNativeChatModel | null): HTMLElement {
  const section = targetDocument.createElement("section");
  section.className = "desktop-sidebar-list-section";
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
  return section;
}

function createSidebarRecentChats(
  targetDocument: Document,
  chat: DesktopNativeChatModel | null,
  chatActions: DesktopNativeChatActionOptions = {},
): HTMLElement {
  const section = targetDocument.createElement("section");
  section.className = "desktop-sidebar-list-section";
  section.append(createSidebarSectionHeading(targetDocument, "Recent chats"));

  const list = targetDocument.createElement("div");
  list.className = "desktop-recent-chat-list";
  list.setAttribute("role", "list");
  if (chat) {
    const sessions = chat.sessions.length ? chat.sessions : [];
    for (const session of sessions) {
      const routeId = desktopChatRouteId(session);
      list.append(createRecentChatRow(targetDocument, session, session.key === chat.activeSessionKey, chatActions, routeId));
    }
    if (!sessions.length) {
      list.append(createText(targetDocument, "p", "No recent chats."));
    }
    section.append(list);
    return section;
  }

  for (const [name, meta] of [
    ["Design native workbench", "Just now"],
    ["修复会话加载问题", "2h ago"],
    ["实现文件上传功能", "Yesterday"],
    ["项目启动优化", "2d ago"],
    ["自动化脚本建议", "3d ago"],
  ] as const) {
    list.append(createSidebarRow(targetDocument, name, meta, false, "chat"));
  }

  section.append(list);
  return section;
}

function desktopChatRouteId(session: NativeChatSession): string {
  if (session.key && !session.key.startsWith("WebSocket:")) {
    return session.key;
  }
  return session.chatId || session.key;
}

function createRecentChatRow(
  targetDocument: Document,
  session: NativeChatSession,
  active: boolean,
  chatActions: DesktopNativeChatActionOptions,
  routeId = desktopChatRouteId(session),
): HTMLElement {
  const row = targetDocument.createElement("div");
  row.className = "desktop-sidebar-chat-row";
  row.setAttribute("role", "listitem");
  row.setAttribute("data-active", String(active));
  row.setAttribute("data-sidebar-row-kind", "chat");

  const link = targetDocument.createElement("a");
  link.className = "desktop-sidebar-row desktop-sidebar-row-main";
  link.setAttribute("href", `/chat/${encodeURIComponent(routeId)}`);
  link.setAttribute("data-active", String(active));
  link.setAttribute("data-sidebar-row-kind", "chat");
  link.setAttribute("data-desktop-entity-module", "chat");
  link.setAttribute("data-desktop-entity-id", routeId);

  const title = session.title || "New session";
  const label = targetDocument.createElement("span");
  label.className = "desktop-sidebar-row-label";
  label.textContent = title;
  const time = targetDocument.createElement("span");
  time.className = "desktop-sidebar-row-meta";
  time.textContent = session.updatedAt ? `Updated ${formatCompactTime(session.updatedAt)}` : session.chatId;
  link.append(label, time);

  const deleteButton = targetDocument.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "desktop-sidebar-delete-session";
  deleteButton.setAttribute("data-desktop-chat-delete", session.key);
  deleteButton.setAttribute("aria-label", `Delete chat ${title}`);
  deleteButton.textContent = "Delete";
  deleteButton.addEventListener("click", (event) => {
    event.preventDefault?.();
    event.stopPropagation?.();
    chatActions.onDeleteSession?.({
      sessionKey: session.key,
      chatId: session.chatId,
      title,
    });
  });

  row.append(link, deleteButton);
  return row;
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
  return heading;
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
  row.setAttribute(
    "href",
    kind === "folder"
      ? "/workspace"
      : entityId
        ? `/chat/${encodeURIComponent(entityId)}`
        : "/chat",
  );
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
  return row;
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
  workbench.append(
    createChatHeader(targetDocument, chat),
    createConversationThread(targetDocument, chat),
    createText(targetDocument, "span", "Ready for a new session"),
    createText(targetDocument, "span", "Start from chat, inspect workspace, or check gateway status."),
    createQuickActions(targetDocument),
    createPanelControls(targetDocument, layout),
    createWorkLensInlineHost(targetDocument, layout.inspector.visible ? null : workLens, workLensActions),
    ...(chatWorkItems.length ? [createModuleWorkSection(targetDocument, "Chat runs", chatWorkItems)] : []),
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

  const status = targetDocument.createElement("div");
  status.className = "desktop-status-strip";
  status.setAttribute("data-desktop-route-status", "");
  status.textContent = `No workspace file selected · Gateway ${gatewayHttp}`;

  main.append(workbench, createNativeComposerSurface(targetDocument, gatewayHttp, chat, chatActions), utilities, status);
  return main;
}

function createChatHeader(targetDocument: Document, chat: DesktopNativeChatModel | null): HTMLElement {
  const header = targetDocument.createElement("header");
  header.className = "desktop-chat-header";
  const title = targetDocument.createElement("h1");
  title.textContent = activeChatTitle(chat);
  const menu = targetDocument.createElement("button");
  menu.type = "button";
  menu.className = "desktop-chat-menu";
  menu.setAttribute("aria-label", "More chat actions");
  menu.textContent = "...";
  header.append(title);
  if (chat?.status) {
    const status = createText(targetDocument, "span", chat.status);
    status.className = "desktop-chat-runtime-status";
    header.append(status);
  }
  header.append(menu);
  return header;
}

function createConversationThread(targetDocument: Document, chat: DesktopNativeChatModel | null): HTMLElement {
  const thread = targetDocument.createElement("section");
  thread.className = "desktop-conversation-thread";
  thread.setAttribute("aria-label", "Conversation");
  if (chat) {
    if (!chat.activeSessionKey) {
      thread.append(createText(targetDocument, "p", "No live session selected."));
      return thread;
    }
    if (!chat.messages.length) {
      thread.append(createText(targetDocument, "p", "No messages in this session."));
      return thread;
    }
    thread.append(...chat.messages.map((message) => createConversationMessage(targetDocument, {
      author: message.role === "user" ? "You" : "Tinybot",
      time: formatCompactTime(message.timestamp),
      avatar: message.role === "user" ? "T" : "TB",
      tone: message.role === "user" ? "user" : "assistant",
      body: [message.reasoningContent, message.content].filter(Boolean),
      references: message.references,
    })));
    return thread;
  }
  thread.append(
    createConversationMessage(targetDocument, {
      author: "You",
      time: "10:28 AM",
      avatar: "T",
      tone: "user",
      body: ["这是目前的 native 界面，我希望你帮我设计一个更接近 codex 风格的界面。"],
    }),
    createConversationMessage(targetDocument, {
      author: "Tinybot",
      time: "10:28 AM",
      avatar: "TB",
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

function createConversationMessage(
  targetDocument: Document,
  options: {
    author: string;
    time: string;
    avatar: string;
    tone: "user" | "assistant";
    body: string[];
    references?: NativeChatMessage["references"];
    attachment?: string;
  },
): HTMLElement {
  const article = targetDocument.createElement("article");
  article.className = "desktop-conversation-message";
  article.setAttribute("data-message-tone", options.tone);

  const avatar = targetDocument.createElement("div");
  avatar.className = "desktop-conversation-avatar";
  avatar.textContent = options.avatar;

  const content = targetDocument.createElement("div");
  content.className = "desktop-conversation-content";
  const meta = targetDocument.createElement("div");
  meta.className = "desktop-conversation-meta";
  meta.append(createText(targetDocument, "strong", options.author), createText(targetDocument, "span", options.time));
  content.append(meta);
  for (const [index, line] of options.body.entries()) {
    const node = createText(targetDocument, "p", line);
    if (index > 0 && options.tone === "assistant") {
      node.className = "desktop-conversation-bullet";
    }
    content.append(node);
  }
  for (const reference of options.references ?? []) {
    const node = createText(targetDocument, "p", `${reference.kind}: ${reference.title}${reference.detail ? ` - ${reference.detail}` : ""}`);
    node.className = "desktop-conversation-reference";
    content.append(node);
  }
  if (options.attachment) {
    const attachment = targetDocument.createElement("div");
    attachment.className = "desktop-conversation-attachment";
    attachment.textContent = `${options.attachment}  1.2 MB`;
    content.append(attachment);
  }
  article.append(avatar, content);
  return article;
}

function createNativeComposerSurface(
  targetDocument: Document,
  gatewayHttp: string,
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
  attach.setAttribute("aria-label", "Attach file");
  attach.textContent = "+";

  const input = targetDocument.createElement("textarea");
  input.id = "desktop-native-composer-input";
  input.className = "desktop-native-composer-input";
  input.setAttribute("aria-label", "Native composer input");
  input.setAttribute("placeholder", "Ask Tinybot");

  const send = targetDocument.createElement("button");
  send.id = "desktop-native-composer-send";
  send.type = "button";
  send.className = "desktop-native-composer-send";
  send.setAttribute("data-desktop-composer-action", "send");
  send.setAttribute("aria-label", "Send message");
  if (nativeComposerState(chat) !== "idle") {
    send.setAttribute("disabled", "");
  }
  send.textContent = "↑";
  send.addEventListener("click", () => {
    chatActions.onComposerSubmit?.({
      content: input.value,
      usePersistentRag: chat?.usePersistentRag !== false,
    });
  });

  const stop = targetDocument.createElement("button");
  stop.id = "desktop-native-composer-stop";
  stop.type = "button";
  stop.className = "desktop-native-composer-action";
  stop.setAttribute("data-desktop-composer-action", "stop");
  stop.setAttribute("aria-label", "Stop generation");
  stop.textContent = "Stop";
  stop.hidden = chat?.responding !== true;
  stop.addEventListener("click", () => {
    chatActions.onInterrupt?.();
  });

  const microphone = targetDocument.createElement("button");
  microphone.id = "desktop-native-composer-microphone";
  microphone.type = "button";
  microphone.className = "desktop-native-composer-microphone";
  microphone.setAttribute("data-desktop-composer-action", "microphone");
  microphone.setAttribute("aria-label", "Voice input");
  microphone.textContent = "Mic";

  const runtime = targetDocument.createElement("div");
  runtime.id = "desktop-native-composer-runtime";
  runtime.className = "desktop-native-composer-runtime";
  runtime.setAttribute("data-desktop-composer-region", "runtime-status");
  runtime.setAttribute("aria-label", "Runtime status");
  runtime.append(
    createComposerModelControl(targetDocument, chat),
    createComposerChip(targetDocument, "Provider", chat?.runtime?.provider || "-"),
    createComposerChip(targetDocument, "Session", chat?.activeChatId || "No active session"),
    createPersistentRagToggle(targetDocument, chat, chatActions),
    createComposerChip(targetDocument, "Generation", chat?.responding ? "Running" : "Idle"),
    createComposerChip(targetDocument, "Composer", nativeComposerStateLabel(nativeComposerState(chat))),
    createComposerChip(targetDocument, "WebSocket", chat?.runtime?.webSocket || "-"),
    createComposerChip(targetDocument, "Token", chat?.runtime?.tokenReady ? "Ready" : "Pending"),
    createComposerChip(targetDocument, "Token usage", chat?.runtime?.tokenUsage || "-"),
    createComposerChip(targetDocument, "Gateway", chat?.runtime?.gatewayHttp || gatewayHttp),
  );

  composer.append(attach, input, runtime, microphone, stop, send);
  return composer;
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

function nativeComposerStateLabel(state: NonNullable<DesktopNativeChatModel["composerState"]>): string {
  switch (state) {
    case "queued":
      return "Queued";
    case "sending":
      return "Sending";
    case "idle":
      return "Ready";
  }
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
  return button;
}

function createComposerChip(targetDocument: Document, label: string, value: string): HTMLElement {
  const chip = targetDocument.createElement("span");
  chip.className = "desktop-native-composer-chip";
  chip.textContent = `${label}: ${value}`;
  return chip;
}

function createPersistentRagToggle(
  targetDocument: Document,
  chat: DesktopNativeChatModel | null,
  chatActions: DesktopNativeChatActionOptions,
): HTMLElement {
  const enabled = chat?.usePersistentRag !== false;
  const button = targetDocument.createElement("button");
  button.type = "button";
  button.className = "desktop-native-composer-chip desktop-native-composer-rag-toggle";
  button.setAttribute("data-desktop-composer-action", "rag-toggle");
  button.setAttribute("aria-label", "Toggle persistent RAG");
  button.setAttribute("aria-pressed", String(enabled));
  button.textContent = `RAG: ${enabled ? "On" : "Off"}`;
  button.addEventListener("click", () => {
    chatActions.onPersistentRagChange?.(!enabled);
  });
  return button;
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
    row.addEventListener("click", () => {
      const renderedWorkLens = renderTaskWorkLens(targetDocument, item);
      setRouteStatus(targetDocument, renderedWorkLens ? `Inspecting ${item.title} in Work Lens` : `Inspecting ${item.title}`);
    });
    section.append(row);
  }

  return section;
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
    return section;
  }

  for (const form of forms) {
    section.append(createAgentUiFormCard(targetDocument, form, agentUiActions));
  }
  return section;
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
    formElement.append(actions);
  }

  card.append(formElement);
  return card;
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
  return wrapper;
}

function createAgentUiFieldControl(targetDocument: Document, form: AgentUiForm, field: AgentUiFormField): HTMLElement {
  const value = form.values?.[field.name] ?? form.initial_values?.[field.name] ?? field.default ?? "";
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
  section.append(skills);

  if (pane.selectedSkill) {
    const detail = targetDocument.createElement("section");
    detail.className = "desktop-skill-detail";
    detail.append(
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
      createDesktopSkillEditor(targetDocument, pane, toolsSkillsActions),
    );
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
    detail.append(actionRow);
    section.append(detail);
  }
  return section;
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
  section.append(readiness);

  const documents = targetDocument.createElement("section");
  documents.className = "desktop-knowledge-documents";
  documents.append(createText(targetDocument, "h2", "Documents"));
  for (const document of pane.documentRows) {
    const row = createText(targetDocument, "p", `${document.title}: ${document.meta}`);
    setDesktopEntityHook(row, "knowledge", document.id || document.path);
    documents.append(row);
  }
  section.append(documents);

  if (pane.selectedDocument) {
    const detail = targetDocument.createElement("section");
    detail.className = "desktop-knowledge-document-detail";
    detail.append(
      createText(targetDocument, "h2", `Document detail: ${pane.selectedDocument.title}`),
      createText(targetDocument, "p", pane.selectedDocument.detail),
      createText(targetDocument, "p", `Tags: ${pane.selectedDocument.tags.join(", ") || "none"}`),
    );
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
  section.append(graph);

  return section;
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
  section.append(sessions);
  section.append(createCoworkActionControls(targetDocument, pane, coworkActions));

  if (!pane.cockpitView) {
    section.append(createText(targetDocument, "p", "Select a Cowork session to open the cockpit."));
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
  section.append(header);

  const inspector = createCoworkInspectorPane(targetDocument, view, pane, coworkActions);
  section.append(createCoworkGraphPane(targetDocument, view, inspector, pane, coworkActions));
  section.append(createCoworkObservabilityPane(targetDocument, view));
  section.append(inspector);
  section.append(createCoworkTaskFeed(targetDocument, view));

  return section;
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
  return actions;
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
  return graph;
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
  return section;
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
  return inspector;
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
  return feed;
}

function createCoworkDataRow(targetDocument: Document, className: string, text: string): HTMLElement {
  const row = createText(targetDocument, "p", text);
  row.className = className;
  return row;
}

function createCoworkLimitStatus(targetDocument: Document, visible: number, total: number, singular: string, plural: string): HTMLElement {
  const noun = total === 1 ? singular : plural;
  const status = createText(targetDocument, "p", `Showing ${visible} of ${total} ${noun}`);
  status.className = "desktop-cowork-limit-status";
  return status;
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
  const status = createText(targetDocument, "p", `Showing ${visible} of ${matched} matching ${noun} (${total} total)`);
  status.className = "desktop-cowork-limit-status";
  return status;
}

function appendKnowledgeReferenceRows(
  targetDocument: Document,
  section: HTMLElement,
  label: string,
  rows: Array<{ title: string; meta: string; text: string }>,
): void {
  for (const row of rows.slice(0, 4)) {
    section.append(createText(targetDocument, "p", `${label}: ${row.title}${row.text ? ` - ${row.text}` : ""}`));
  }
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
  return editor;
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
  section.setAttribute("aria-label", "Settings and providers");
  const header = targetDocument.createElement("header");
  header.className = "desktop-settings-header";
  const title = targetDocument.createElement("div");
  title.append(
    createText(targetDocument, "h2", "Settings"),
    createText(targetDocument, "p", pane.dirty ? "Unsaved desktop configuration changes" : "Desktop configuration is up to date"),
  );

  const actions = targetDocument.createElement("div");
  actions.className = "desktop-settings-actions";
  const save = targetDocument.createElement("button");
  save.setAttribute("type", "button");
  save.setAttribute("data-desktop-settings-action", "save");
  if (!pane.save.canSave) {
    save.setAttribute("disabled", "true");
  }
  save.textContent = pane.save.status === "saving" ? "Saving" : "Save settings";
  save.addEventListener("click", () => {
    settingsActions.onSettingsAction?.({ action: "save", pane });
  });
  const discover = targetDocument.createElement("button");
  discover.setAttribute("type", "button");
  discover.setAttribute("data-desktop-settings-action", "discoverModels");
  if (!pane.providerEditor.canDiscoverModels) {
    discover.setAttribute("disabled", "true");
  }
  discover.textContent = "Refresh models";
  discover.addEventListener("click", () => {
    settingsActions.onSettingsAction?.({ action: "discoverModels", pane });
  });
  actions.append(save, discover);
  header.append(title, actions);
  section.append(header);

  const summary = targetDocument.createElement("div");
  summary.className = "desktop-settings-summary";
  summary.append(
    createText(targetDocument, "p", `Save: ${pane.save.message}`),
    createText(targetDocument, "p", pane.validationErrors.length ? `Validation: ${pane.validationErrors.map((error) => error.field).join(", ")}` : "Validation: ready"),
    createText(targetDocument, "p", `Provider profile: ${pane.providerEditor.profileId || "default"}`),
    createText(targetDocument, "p", `API key: ${pane.providerEditor.apiKey.displayValue || "Not configured"}`),
    createText(targetDocument, "p", `Catalog: ${pane.providerCatalog.map((provider) => `${provider.label} (${provider.status})`).join(", ") || "No providers loaded"}`),
    createText(targetDocument, "p", `Models: ${pane.providerEditor.models.join(", ") || "No models loaded"}`),
  );
  section.append(summary);

  const grid = targetDocument.createElement("div");
  grid.className = "desktop-settings-grid";

  for (const group of pane.groups) {
    const groupSection = targetDocument.createElement("section");
    groupSection.className = "desktop-settings-group";
    groupSection.setAttribute("data-desktop-settings-group", group.id);
    groupSection.append(createText(targetDocument, "h2", group.label));
    for (const field of group.fields) {
      const row = targetDocument.createElement("p");
      row.className = "desktop-settings-field";
      row.setAttribute("data-desktop-settings-field", field.id);
      row.setAttribute("data-state", field.state);
      const label = targetDocument.createElement("label");
      label.textContent = `${field.label}: `;
      label.setAttribute("for", `desktop-settings-${field.id}`);
      const control = createDesktopSettingsControl(targetDocument, pane, field, settingsActions);
      row.append(label, control);
      groupSection.append(row);
    }
    grid.append(groupSection);
  }

  section.append(grid);
  return section;
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

  const panelControls: {
    panel: DesktopPanelControlId;
    label: string;
    ariaLabel: string;
    visible: boolean;
    shortcut?: string;
  }[] = [
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

  return controls;
}

function toggleDesktopPanel(targetDocument: Document, panel: DesktopPanelControlId): void {
  const shell = targetDocument.getElementById(SHELL_ID);
  const panelElement = targetDocument.querySelector<HTMLElement>(`[data-workbench-region="${panel}"]`);
  const stateAttribute = `data-${panel}-visible`;
  const currentValue = shell?.getAttribute(stateAttribute) ?? panelElement?.getAttribute("data-visible") ?? "true";
  const nextVisible = currentValue === "false";
  shell?.setAttribute(stateAttribute, String(nextVisible));
  panelElement?.setAttribute("data-visible", String(nextVisible));
  targetDocument
    .querySelector<HTMLElement>(`[data-desktop-panel-control="${panel}"]`)
    ?.setAttribute("aria-pressed", String(nextVisible));

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
  inspector.append(createRunChainOverviewPanel(targetDocument));
  if (workLens) {
    inspector.append(createWorkLensPane(targetDocument, workLens, workLensActions));
  } else if (runChainItems.length) {
    inspector.append(createRunChainInspectorPane(targetDocument, runChainItems, selectedRunChainItemKey));
  }
  return inspector;
}

function createRunChainOverviewPanel(targetDocument: Document): HTMLElement {
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
    button.textContent = value;
    button.addEventListener("click", () => {
      if (action === "close") {
        toggleDesktopPanel(targetDocument, "inspector");
        return;
      }
      setRouteStatus(targetDocument, "Run Chain pinned");
    });
    controls.append(button);
  }
  header.append(controls);

  const tabs = targetDocument.createElement("div");
  tabs.className = "desktop-run-chain-tabs";
  tabs.setAttribute("role", "tablist");
  for (const [index, label] of ["Context", "Files", "Tasks"].entries()) {
    const tab = targetDocument.createElement("button");
    tab.type = "button";
    tab.className = "desktop-run-chain-tab";
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(index === 0));
    tab.setAttribute("data-desktop-run-chain-tab", label.toLowerCase());
    tab.textContent = label;
    tab.addEventListener("click", () => {
      for (const sibling of Array.from(tabs.children)) {
        sibling.setAttribute("aria-selected", "false");
      }
      tab.setAttribute("aria-selected", "true");
      setRouteStatus(targetDocument, `Run Chain ${label}`);
    });
    tabs.append(tab);
  }

  const cards = targetDocument.createElement("div");
  cards.className = "desktop-run-chain-cards";
  cards.append(
    createRunChainCard(targetDocument, "Gateway", "Connected", [
      ["Endpoint", "http://127.0.0.1:18790"],
      ["Mode", "External"],
      ["Version", "v0.1.0"],
    ], "Open Gateway Status", "/api/status"),
    createRunChainCard(targetDocument, "Workspace", "", [
      ["tinybot", "D:\\code\\tinybot\\tinybot"],
    ], "Open Workspace", "/workspace"),
    createRunChainCard(targetDocument, "Current Run", "Idle", [
      ["No run in progress", "Select an item below to run."],
    ]),
  );

  const add = targetDocument.createElement("button");
  add.className = "desktop-run-chain-new-item";
  add.textContent = "+  New Run Chain Item";
  add.setAttribute("type", "button");
  add.addEventListener("click", () => {
    setRouteStatus(targetDocument, "Open Cowork to create a run chain item.");
  });

  section.append(header, tabs, cards, add);
  return section;
}

function createRunChainCard(
  targetDocument: Document,
  title: string,
  badge: string,
  rows: [string, string][],
  action?: string,
  actionHref?: string,
): HTMLElement {
  const card = targetDocument.createElement("article");
  card.className = "desktop-run-chain-card";
  const header = targetDocument.createElement("div");
  header.className = "desktop-run-chain-card-header";
  header.append(createText(targetDocument, "h3", title));
  if (badge) {
    const status = targetDocument.createElement("span");
    status.className = "desktop-run-chain-card-badge";
    status.textContent = badge;
    header.append(status);
  }
  card.append(header);
  for (const [label, value] of rows) {
    const row = targetDocument.createElement("p");
    row.className = "desktop-run-chain-card-row";
    row.textContent = `${label}: ${value}`;
    card.append(row);
  }
  if (action) {
    const element = actionHref
      ? createWorkbenchLink(targetDocument, action, actionHref, "desktop-run-chain-card-action")
      : targetDocument.createElement("button");
    if (!actionHref) {
      element.setAttribute("type", "button");
      element.textContent = action;
      element.className = "desktop-run-chain-card-action";
    }
    element.setAttribute("data-desktop-run-chain-action", action);
    card.append(element);
  }
  return card;
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

  return section;
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
  return section;
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
  return bottom;
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
  return section;
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
  return section;
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
  return badge;
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
  return element;
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
  return panel;
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
  return actions;
}

function createFileActions(targetDocument: Document, chat: DesktopNativeChatModel | null = null): HTMLElement {
  const section = targetDocument.createElement("section");
  section.className = "desktop-file-actions";
  section.setAttribute("data-desktop-module-surface", "workspace knowledge");
  section.append(createText(targetDocument, "h2", "File imports"));

  const knowledge = targetDocument.createElement("button");
  knowledge.setAttribute("id", "desktop-knowledge-upload");
  knowledge.setAttribute("type", "button");
  knowledge.setAttribute("class", "desktop-file-action");
  knowledge.setAttribute("data-desktop-file-upload", "knowledge-document");
  knowledge.setAttribute("data-desktop-drop-target", "knowledge-document");
  knowledge.textContent = "Import knowledge";

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

  const session = targetDocument.createElement("button");
  session.setAttribute("id", "desktop-session-file-upload");
  session.setAttribute("type", "button");
  session.setAttribute("class", "desktop-file-action");
  session.setAttribute("data-desktop-file-upload", "session-temporary-file");
  session.setAttribute("data-desktop-drop-target", "session-temporary-file");
  session.textContent = "Attach to session";

  const workspace = createWorkbenchLink(targetDocument, "Workspace import", "/workspace", "desktop-file-action");
  workspace.setAttribute("id", "desktop-workspace-file-drop");
  workspace.setAttribute("data-desktop-drop-target", "workspace-file");

  const status = targetDocument.createElement("p");
  status.setAttribute("id", "desktop-file-upload-status");
  status.setAttribute("class", "desktop-file-upload-status");
  status.textContent = "No file operation running.";

  const sessionFiles = targetDocument.createElement("div");
  sessionFiles.setAttribute("id", "desktop-session-file-list");
  sessionFiles.setAttribute("class", "desktop-session-file-list");
  sessionFiles.setAttribute("aria-label", "Session temporary files");
  sessionFiles.textContent = chat?.activeSessionKey ? "Temporary files not loaded yet." : "Select a chat session to view temporary files.";

  section.append(knowledge, sessionKey, session, workspace, status, sessionFiles);
  return section;
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
  section.setAttribute("data-desktop-module-surface", "docs settings");
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
  return section;
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
  const inspector = targetDocument.querySelector<HTMLElement>('[data-workbench-region="inspector"]');
  if (!inspector) {
    return;
  }
  inspector.replaceChildren(renderInspectorView(targetDocument, {
    title: "Shortcut Help",
    subtitle: "Current desktop command bindings",
    emptyText: "",
    sections: buildDesktopShortcutHelpText().map((row) => ({ type: "text" as const, label: "Shortcut", text: row })),
  }));
  setRouteStatus(targetDocument, "Opened shortcut help");
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
  section.append(createText(targetDocument, "h2", "Workspace files"));

  const status = targetDocument.createElement("p");
  status.setAttribute("id", "desktop-workspace-status");
  status.setAttribute("class", "desktop-workspace-status");
  status.textContent = "0 files";

  const recent = targetDocument.createElement("div");
  recent.setAttribute("id", "desktop-workspace-recent-files");
  recent.setAttribute("class", "desktop-workspace-recent-files");
  recent.setAttribute("aria-label", "Recent workspace files");

  const activePath = targetDocument.createElement("p");
  activePath.setAttribute("id", "desktop-workspace-active-path");
  activePath.setAttribute("class", "desktop-workspace-active-path");
  activePath.textContent = "No workspace file selected.";

  const updatedAt = targetDocument.createElement("p");
  updatedAt.setAttribute("id", "desktop-workspace-updated-at");
  updatedAt.setAttribute("class", "desktop-workspace-updated-at");
  updatedAt.textContent = "No timestamp";

  const detail = targetDocument.createElement("p");
  detail.setAttribute("id", "desktop-workspace-detail");
  detail.setAttribute("class", "desktop-workspace-detail");
  detail.textContent = "No workspace file selected.";

  const editor = targetDocument.createElement("textarea");
  editor.setAttribute("id", "desktop-workspace-editor");
  editor.setAttribute("class", "desktop-workspace-editor");
  editor.setAttribute("aria-label", "Workspace file editor");

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

  const exportButton = targetDocument.createElement("button");
  exportButton.setAttribute("id", "desktop-workspace-export");
  exportButton.setAttribute("type", "button");
  exportButton.setAttribute("class", "desktop-file-action");
  exportButton.setAttribute("disabled", "");
  exportButton.textContent = "Export";

  const actions = targetDocument.createElement("div");
  actions.setAttribute("class", "desktop-workspace-actions");
  actions.append(save, reveal, exportButton);

  section.append(status, activePath, updatedAt, recent, detail, editor, actions, saveState, error);
  return section;
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
    section.append(createText(targetDocument, "p", "Select a run-chain item, file, tool, skill, or Cowork entity."));
    return section;
  }

  for (const item of view.sections) {
    const row = targetDocument.createElement("p");
    if (item.type === "browserActivity") {
      row.textContent = `${item.activity.actionLabel}: ${[item.activity.title, item.activity.url].filter(Boolean).join(" | ")}`;
    } else {
      row.textContent = `${item.label}: ${item.text}`;
    }
    section.append(row);
  }
  return section;
}

function createSharedSidebarLinkSection(targetDocument: Document, group: DesktopSidebarGroup | undefined): HTMLElement {
  const section = targetDocument.createElement("section");
  section.className = "desktop-workbench-section";
  section.append(createText(targetDocument, "h2", group?.label ?? "Resources"));
  for (const item of group?.items ?? []) {
    if (item.kind === "link" && item.href) {
      section.append(createSharedWorkbenchLink(targetDocument, item));
    }
  }
  return section;
}

function createSharedSidebarCommandSection(targetDocument: Document, group: DesktopSidebarGroup | undefined): HTMLElement {
  const section = targetDocument.createElement("section");
  section.className = "desktop-workbench-section";
  section.append(createText(targetDocument, "h2", group?.label ?? "System"));
  for (const item of group?.items ?? []) {
    if (item.kind === "command" && item.commandId) {
      section.append(createSharedSidebarCommandButton(targetDocument, item));
    }
  }
  return section;
}

function createSharedWorkbenchLink(targetDocument: Document, item: DesktopSidebarItem): HTMLElement {
  const link = createWorkbenchLink(targetDocument, item.label, item.href ?? "#", "desktop-workbench-link");
  applySharedSidebarItemAttributes(link, item);
  return link;
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
  return button;
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
      height: calc(100vh - var(--desktop-window-frame-height, 0px));
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
    body.desktop-native-workbench .desktop-session-upload-key:focus-visible,
    body.desktop-native-workbench .desktop-workspace-file-row:focus-visible,
    body.desktop-native-workbench .desktop-workspace-editor:focus-visible {
      outline: 2px solid var(--primary, #cc785c);
      outline-offset: 2px;
    }

    body.desktop-native-workbench .desktop-quick-action,
    body.desktop-native-workbench .desktop-file-action {
      padding: 0 12px;
    }

    body.desktop-native-workbench .desktop-file-actions {
      display: grid;
      grid-template-columns: repeat(2, minmax(130px, max-content));
      gap: 8px;
      align-items: center;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-file-actions h2,
    body.desktop-native-workbench .desktop-file-upload-status {
      grid-column: 1 / -1;
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

    body.desktop-native-workbench .desktop-file-action.is-desktop-drop-hover,
    body.desktop-native-workbench .desktop-file-action[data-desktop-drop-target]:focus-visible {
      outline: 2px solid var(--primary, #cc785c);
      outline-offset: 2px;
      background: var(--panel-strong, #efe9de);
    }

    body.desktop-native-workbench .desktop-session-upload-key {
      min-width: 0;
      width: min(220px, 100%);
      min-height: 34px;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: 6px;
      padding: 0 10px;
      font: 12px/1.2 var(--font-sans, system-ui, sans-serif);
    }

    body.desktop-native-workbench .desktop-workspace-files {
      display: grid;
      grid-template-columns: minmax(160px, 220px) minmax(0, 1fr) max-content;
      gap: 8px;
      align-items: start;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-workspace-files h2,
    body.desktop-native-workbench .desktop-workspace-active-path,
    body.desktop-native-workbench .desktop-workspace-save-state,
    body.desktop-native-workbench .desktop-workspace-error {
      grid-column: 1 / -1;
    }

    body.desktop-native-workbench .desktop-workspace-recent-files {
      display: grid;
      gap: 6px;
      max-height: 138px;
      overflow: auto;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-workspace-file-row {
      min-width: 0;
      min-height: 28px;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: 6px;
      padding: 0 8px;
      overflow: hidden;
      background: var(--panel, #faf9f5);
      color: var(--text, #141413);
      font: 12px/1.2 var(--font-sans, system-ui, sans-serif);
      text-align: left;
      text-overflow: ellipsis;
      white-space: nowrap;
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-workspace-actions {
      display: grid;
      gap: 8px;
      min-width: 92px;
    }

    body.desktop-native-workbench .desktop-workspace-editor {
      min-width: 0;
      width: 100%;
      min-height: 138px;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: 6px;
      padding: 8px;
      resize: vertical;
      font: 12px/1.45 ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
    }

    body.desktop-native-workbench .desktop-workspace-error {
      color: var(--danger, #c64545);
    }

    body.desktop-native-workbench .desktop-native-composer {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      grid-template-rows: auto auto;
      gap: 8px;
      width: min(820px, 100%);
      min-width: 0;
      margin: 0 auto 10px;
      border: 1px solid var(--border);
      border-radius: var(--radius-xl);
      padding: 10px;
      background: var(--panel);
      box-shadow: var(--shadow-sm);
    }

    body.desktop-native-workbench .desktop-native-composer-action,
    body.desktop-native-workbench .desktop-native-composer-send {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 36px;
      min-height: 36px;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: 0 12px;
      background: var(--bg);
      color: var(--text);
      font: 600 12px/1.2 var(--font-sans);
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-native-composer-send {
      border-color: var(--primary);
      background: var(--primary);
      color: var(--on-primary);
    }

    body.desktop-native-workbench .desktop-native-composer-input {
      min-width: 0;
      width: 100%;
      min-height: 36px;
      max-height: 108px;
      border: 0;
      border-radius: var(--radius-md);
      padding: 8px 10px;
      resize: vertical;
      background: transparent;
      color: var(--text);
      font: 13px/1.45 var(--font-sans);
    }

    body.desktop-native-workbench .desktop-native-composer-input:focus-visible,
    body.desktop-native-workbench .desktop-native-composer-action:focus-visible,
    body.desktop-native-workbench .desktop-native-composer-send:focus-visible {
      outline: 2px solid var(--primary);
      outline-offset: 2px;
      box-shadow: 0 0 0 4px var(--focus-ring);
    }

    body.desktop-native-workbench .desktop-native-composer-runtime {
      grid-column: 1 / -1;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-native-composer-chip {
      min-width: 0;
      max-width: 100%;
      overflow: hidden;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-full);
      padding: 3px 8px;
      background: var(--surface-soft);
      color: var(--text-muted);
      font: 500 11px/1.25 var(--font-sans);
      text-overflow: ellipsis;
      white-space: nowrap;
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
      background: #fbfaf7;
    }

    body.desktop-native-workbench .desktop-sidebar-content {
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr);
      gap: 14px;
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
      gap: 2px;
      min-width: 0;
      overflow: auto;
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
      gap: 4px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-sidebar-chat-row .desktop-sidebar-row {
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-sidebar-delete-session {
      width: 52px;
      min-height: 30px;
      border: 1px solid transparent;
      border-radius: 6px;
      background: transparent;
      color: #8d4a3a;
      font: 600 11px/1 var(--font-sans);
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-sidebar-delete-session:hover,
    body.desktop-native-workbench .desktop-sidebar-delete-session:focus-visible {
      border-color: #f0d8cf;
      background: #fff4ef;
      color: #b4533c;
    }

    body.desktop-native-workbench .desktop-sidebar-row[data-active="true"] {
      border-color: #f0d8cf;
      background: #f8e7e1;
      color: #b4533c;
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
      grid-template-rows: minmax(0, 1fr) auto auto;
      height: 100%;
      min-height: 0;
      padding: 0;
      overflow: hidden;
      background: #ffffff;
    }

    body.desktop-native-workbench .desktop-chat-workbench {
      align-self: stretch;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      gap: 0;
      width: 100%;
      max-width: none;
      height: 100%;
      min-height: 0;
      margin: 0;
      padding: 0;
      overflow: hidden;
      background: #ffffff;
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
      gap: 16px;
      min-width: 0;
      min-height: 72px;
      border-bottom: 1px solid #e9e4df;
      padding: 0 28px;
      background: #ffffff;
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

    body.desktop-native-workbench .desktop-chat-menu {
      width: 40px;
      height: 40px;
      border: 1px solid #e6dfd8;
      border-radius: 8px;
      background: #ffffff;
      color: #262522;
      font: 700 16px/1 var(--font-sans);
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-conversation-thread {
      display: grid;
      align-content: start;
      gap: 22px;
      min-height: 0;
      padding: 32px min(8vw, 72px) 22px;
      overflow-y: auto;
      overflow-x: hidden;
    }

    body.desktop-native-workbench .desktop-conversation-message {
      display: grid;
      grid-template-columns: 42px minmax(0, 1fr);
      gap: 14px;
      max-width: 760px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-conversation-avatar {
      display: grid;
      place-items: center;
      width: 42px;
      height: 42px;
      border: 1px solid #e7ddd6;
      border-radius: 999px;
      background: #ffffff;
      color: #d66348;
      font: 700 12px/1 var(--font-sans);
    }

    body.desktop-native-workbench .desktop-conversation-message[data-message-tone="user"] .desktop-conversation-avatar {
      border-color: #d66348;
      background: #d66348;
      color: #ffffff;
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

    body.desktop-native-workbench .desktop-conversation-bullet {
      padding-left: 18px;
    }

    body.desktop-native-workbench .desktop-conversation-bullet::before {
      content: "•";
      margin-left: -16px;
      padding-right: 8px;
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
      grid-template-columns: 48px minmax(0, 1fr) 48px 56px;
      grid-template-rows: minmax(72px, auto) auto;
      grid-template-areas: "attach input input input" "stop spacer microphone send";
      gap: 10px 12px;
      width: min(820px, calc(100% - 56px));
      margin: 0 auto 46px;
      border-color: #ddd5cd;
      border-radius: 16px;
      padding: 12px;
      background: #ffffff;
      box-shadow: 0 10px 28px rgba(20, 20, 19, 0.08);
    }

    body.desktop-native-workbench .desktop-native-composer-action {
      align-self: start;
      width: 48px;
      min-width: 48px;
      min-height: 48px;
      border-radius: 8px;
      background: #fbfaf7;
      font-size: 18px;
    }

    body.desktop-native-workbench #desktop-native-composer-attach {
      grid-area: attach;
    }

    body.desktop-native-workbench #desktop-native-composer-stop {
      grid-area: stop;
      font-size: 12px;
    }

    body.desktop-native-workbench .desktop-native-composer-input {
      grid-area: input;
      min-height: 54px;
      padding: 10px 4px;
      font-size: 15px;
    }

    body.desktop-native-workbench .desktop-native-composer-runtime {
      position: absolute;
      top: calc(100% + 8px);
      left: 0;
      right: 0;
      align-items: center;
      max-height: 30px;
      overflow-x: auto;
      overflow-y: hidden;
      flex-wrap: nowrap;
    }

    body.desktop-native-workbench .desktop-native-composer-model {
      min-height: 34px;
      border: 1px solid #e2d9d2;
      border-radius: 7px;
      padding: 0 14px;
      background: #ffffff;
      color: #262522;
      font: 600 12px/1.2 var(--font-sans);
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-native-composer-microphone {
      grid-area: microphone;
      width: 38px;
      min-height: 38px;
      border: 0;
      background: transparent;
      color: #3d3934;
      font: 600 12px/1 var(--font-sans);
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-native-composer-send {
      grid-area: send;
      width: 46px;
      min-width: 46px;
      min-height: 46px;
      border-radius: 999px;
      font-size: 20px;
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
      align-content: start;
      gap: 18px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-settings-header {
      display: flex;
      align-items: start;
      justify-content: space-between;
      gap: 16px;
      min-width: 0;
      border-bottom: 1px solid #e9e4df;
      padding-bottom: 14px;
    }

    body.desktop-native-workbench .desktop-settings-header h2 {
      margin: 0;
      color: #1f1d1a;
      font: 700 20px/1.2 var(--font-sans);
      letter-spacing: 0;
    }

    body.desktop-native-workbench .desktop-settings-header p,
    body.desktop-native-workbench .desktop-settings-summary p {
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

    body.desktop-native-workbench .desktop-settings-summary {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px 14px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-settings-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(280px, 1fr));
      gap: 16px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-settings-group {
      display: grid;
      align-content: start;
      gap: 12px;
      min-width: 0;
      border: 1px solid #ebe4dd;
      border-radius: 8px;
      padding: 14px;
      background: #fffdfa;
    }

    body.desktop-native-workbench .desktop-settings-group h2 {
      margin: 0;
      color: #2d2924;
      font: 650 14px/1.2 var(--font-sans);
      letter-spacing: 0;
    }

    body.desktop-native-workbench .desktop-settings-field {
      display: grid;
      grid-template-columns: minmax(100px, 0.38fr) minmax(0, 1fr);
      align-items: center;
      gap: 10px;
      margin: 0;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-settings-field label {
      color: #625b54;
      font: 600 12px/1.35 var(--font-sans);
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
      justify-self: start;
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
    body.desktop-native-workbench .desktop-settings-field input:focus-visible,
    body.desktop-native-workbench .desktop-settings-field select:focus-visible,
    body.desktop-native-workbench .desktop-settings-field textarea:focus-visible {
      outline: 2px solid rgba(31, 111, 235, 0.45);
      outline-offset: 2px;
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
      grid-template-rows: auto auto minmax(0, 1fr) auto;
      gap: 16px;
      min-width: 0;
      min-height: 0;
    }

    body.desktop-native-workbench .desktop-run-chain-header,
    body.desktop-native-workbench .desktop-run-chain-card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-run-chain-header h2,
    body.desktop-native-workbench .desktop-run-chain-card h3 {
      margin: 0;
      color: #1f1d1a;
      font-family: var(--font-sans);
      font-size: 18px;
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
      min-height: 28px;
      border: 0;
      background: transparent;
      color: #55504b;
      font: 600 11px/1 var(--font-sans);
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-run-chain-tabs {
      display: flex;
      gap: 26px;
      min-width: 0;
      border-bottom: 1px solid #e1d9d3;
    }

    body.desktop-native-workbench .desktop-run-chain-tab {
      min-height: 38px;
      border: 0;
      border-bottom: 2px solid transparent;
      padding: 0 0 10px;
      background: transparent;
      color: #262522;
      font: 500 14px/1.2 var(--font-sans);
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-run-chain-tab[aria-selected="true"] {
      border-bottom-color: var(--primary);
      color: #1f1d1a;
    }

    body.desktop-native-workbench .desktop-run-chain-cards {
      display: grid;
      align-content: start;
      gap: 16px;
      min-width: 0;
      overflow: auto;
    }

    body.desktop-native-workbench .desktop-run-chain-card {
      display: grid;
      gap: 14px;
      min-width: 0;
      border: 1px solid #e4dcd5;
      border-radius: 8px;
      padding: 18px;
      background: #ffffff;
      box-shadow: 0 1px 1px rgba(20, 20, 19, 0.03);
    }

    body.desktop-native-workbench .desktop-run-chain-card h3 {
      font-size: 15px;
    }

    body.desktop-native-workbench .desktop-run-chain-card-badge {
      border: 1px solid #cfe8d1;
      border-radius: 999px;
      padding: 4px 10px;
      background: #f3fbf3;
      color: #307a3e;
      font: 600 11px/1 var(--font-sans);
    }

    body.desktop-native-workbench .desktop-run-chain-card-row {
      margin: 0;
      color: #4e4943;
      font: 13px/1.45 var(--font-sans);
      overflow-wrap: anywhere;
    }

    body.desktop-native-workbench .desktop-run-chain-card-action,
    body.desktop-native-workbench .desktop-run-chain-new-item {
      min-height: 38px;
      border: 1px solid #e2d9d2;
      border-radius: 7px;
      background: #ffffff;
      color: #262522;
      font: 600 13px/1.2 var(--font-sans);
      cursor: pointer;
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
      overflow: hidden;
      padding: 8px 0 0;
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
        min-height: 84px;
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
        grid-template-columns: 48px minmax(0, 1fr) 56px;
        grid-template-rows: auto auto;
        grid-template-areas: "attach input input" "stop microphone send";
      }

      body.desktop-native-workbench .desktop-native-composer-runtime {
        display: flex;
      }

      body.desktop-native-workbench .desktop-native-composer-microphone {
        justify-self: end;
      }

      body.desktop-native-workbench .desktop-native-composer-send {
      }

      body.desktop-native-workbench .desktop-empty-session {
        max-width: none;
      }
    }
  `;
  targetDocument.head.append(style);
}
