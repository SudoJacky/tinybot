import type { GatewayRuntimeStatus } from "./desktopGatewayStartup";
import {
  buildDesktopGatewayRuntimeActions,
  buildDesktopGatewayRuntimeDiagnostics,
  buildDesktopGatewayRuntimeRows,
  type DesktopGatewayRuntimeActionId,
} from "./desktopGatewayRuntimeControls";
import { createDesktopRunChainInspectorView, type DesktopInspectorView } from "./desktopRunChainInspector";
import type { DesktopTaskActionId, DesktopTaskCenterAction, DesktopTaskCenterItem } from "./desktopTaskCenter";
import type { WorkbenchLayoutState, WorkbenchPanelId, WorkbenchPanelState } from "./desktopWorkbenchLayout";
import { loadWorkbenchLayout } from "./desktopWorkbenchLayout";

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

interface InstallDesktopWorkbenchShellOptions {
  targetDocument?: Document;
  layout?: WorkbenchLayoutState;
  runtimeStatus?: GatewayRuntimeStatus | null;
  taskCenterItems?: DesktopTaskCenterItem[];
  gatewayHttp: string;
  taskActions?: DesktopTaskCenterActionOptions;
  gatewayActions?: DesktopGatewayRuntimeActionOptions;
}

const SHELL_ID = "desktop-workbench-shell";
const STYLE_ID = "desktop-workbench-shell-style";
type DesktopPanelControlId = "sidebar" | "inspector" | "bottom";

export function installDesktopWorkbenchShell({
  targetDocument = document,
  layout = loadWorkbenchLayout(),
  runtimeStatus = null,
  taskCenterItems = [],
  gatewayHttp,
  taskActions = {},
  gatewayActions = {},
}: InstallDesktopWorkbenchShellOptions): void {
  ensureDesktopWorkbenchShellStyle(targetDocument);
  targetDocument.body.classList.add("desktop-native-workbench");
  targetDocument.body.replaceChildren(createWorkbenchShell(targetDocument, layout, runtimeStatus, gatewayHttp, taskCenterItems, taskActions, gatewayActions));
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

function createWorkbenchShell(
  targetDocument: Document,
  layout: WorkbenchLayoutState,
  runtimeStatus: GatewayRuntimeStatus | null,
  gatewayHttp: string,
  taskCenterItems: DesktopTaskCenterItem[],
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
    createPanel(targetDocument, "sidebar", layout.sidebar, createSidebar(targetDocument)),
    createMainRegion(targetDocument, gatewayHttp, layout),
    createPanel(targetDocument, "inspector", layout.inspector, createInspector(targetDocument)),
    createPanel(targetDocument, "bottom", layout.bottom, createBottomRegion(targetDocument, runtimeStatus, gatewayHttp, taskCenterItems, taskActions, gatewayActions)),
  );

  return shell;
}

function createActivityRail(targetDocument: Document): HTMLElement {
  const rail = targetDocument.createElement("nav");
  rail.className = "desktop-activity-rail";
  rail.setAttribute("data-workbench-region", "activity");
  rail.setAttribute("aria-label", "Desktop workbench modules");
  for (const [index, [label, href]] of [
    ["Chat", "/chat"],
    ["Files", "/workspace"],
    ["Knowledge", "/knowledge"],
    ["Cowork", "/cowork"],
  ].entries()) {
    const item = targetDocument.createElement("a");
    item.className = "desktop-activity-button";
    item.setAttribute("href", href);
    item.textContent = label.slice(0, 1);
    item.setAttribute("aria-label", label);
    item.setAttribute("data-focus-order", `activity-${index + 1}`);
    rail.append(item);
  }
  return rail;
}

function createSidebar(targetDocument: Document): HTMLElement {
  const sidebar = targetDocument.createElement("div");
  sidebar.className = "desktop-sidebar-content";
  sidebar.append(
    createSection(targetDocument, "Sessions", ["No active session", "Recent sessions will appear here"]),
    createLinkSection(targetDocument, "Resources", [
      ["Workspace", "/workspace"],
      ["Knowledge", "/knowledge"],
      ["Tools and skills", "/tools"],
      ["Docs", "/docs"],
      ["Tinybot repo", "https://github.com/SudoJacky/tinybot"],
    ]),
  );
  return sidebar;
}

function createMainRegion(targetDocument: Document, gatewayHttp: string, layout: WorkbenchLayoutState): HTMLElement {
  const main = targetDocument.createElement("section");
  main.className = "desktop-workbench-main";
  main.setAttribute("data-workbench-region", "main");
  main.setAttribute("aria-label", "Primary desktop work area");

  const empty = targetDocument.createElement("div");
  empty.className = "desktop-empty-session";
  empty.append(
    createText(targetDocument, "h1", "Ready for a new session"),
    createText(targetDocument, "p", "Start from chat, inspect workspace, or check gateway status."),
    createQuickActions(targetDocument),
    createPanelControls(targetDocument, layout),
    createCommandPalette(targetDocument),
    createFileActions(targetDocument),
    createWorkspaceFilesSurface(targetDocument),
  );

  const status = targetDocument.createElement("div");
  status.className = "desktop-status-strip";
  status.setAttribute("data-desktop-route-status", "");
  status.textContent = `Gateway ${gatewayHttp}`;

  main.append(empty, status);
  return main;
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
      label: "Inspector",
      ariaLabel: "Toggle inspector panel",
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

function createInspector(targetDocument: Document): HTMLElement {
  const inspector = targetDocument.createElement("aside");
  inspector.className = "desktop-inspector-content";
  inspector.append(renderInspectorView(targetDocument, createDesktopRunChainInspectorView(null)));
  return inspector;
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
    renderTaskInspector(targetDocument, item);
    setRouteStatus(targetDocument, `Inspecting ${item.title}`);
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

function createFileActions(targetDocument: Document): HTMLElement {
  const section = targetDocument.createElement("section");
  section.className = "desktop-file-actions";
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

  section.append(knowledge, sessionKey, session, workspace, status);
  return section;
}

function createWorkspaceFilesSurface(targetDocument: Document): HTMLElement {
  const section = targetDocument.createElement("section");
  section.className = "desktop-workspace-files";
  section.append(createText(targetDocument, "h2", "Workspace files"));

  const recent = targetDocument.createElement("div");
  recent.setAttribute("id", "desktop-workspace-recent-files");
  recent.setAttribute("class", "desktop-workspace-recent-files");
  recent.setAttribute("aria-label", "Recent workspace files");

  const activePath = targetDocument.createElement("p");
  activePath.setAttribute("id", "desktop-workspace-active-path");
  activePath.setAttribute("class", "desktop-workspace-active-path");
  activePath.textContent = "No workspace file selected.";

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

  section.append(activePath, recent, editor, actions, saveState, error);
  return section;
}

function createSection(targetDocument: Document, title: string, rows: string[]): HTMLElement {
  const section = targetDocument.createElement("section");
  section.className = "desktop-workbench-section";
  section.append(createText(targetDocument, "h2", title));
  for (const row of rows) {
    section.append(createText(targetDocument, "p", row));
  }
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
    row.textContent = item.type === "browserActivity" ? item.activity.title || item.activity.url : item.text;
    section.append(row);
  }
  return section;
}

function createLinkSection(targetDocument: Document, title: string, rows: [string, string][]): HTMLElement {
  const section = targetDocument.createElement("section");
  section.className = "desktop-workbench-section";
  section.append(createText(targetDocument, "h2", title));
  for (const [label, href] of rows) {
    section.append(createWorkbenchLink(targetDocument, label, href, "desktop-workbench-link"));
  }
  return section;
}

function createWorkbenchLink(targetDocument: Document, label: string, href: string, className: string): HTMLElement {
  const link = targetDocument.createElement("a");
  link.className = className;
  link.setAttribute("href", href);
  link.textContent = label;
  return link;
}

function createText(targetDocument: Document, tagName: "h1" | "h2" | "p", text: string): HTMLElement {
  const element = targetDocument.createElement(tagName);
  element.textContent = text;
  return element;
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
      background: var(--bg, #f7f7f4);
      color: var(--text, #24211d);
    }

    body.desktop-native-workbench .desktop-workbench-shell,
    body.desktop-native-workbench .desktop-workbench-shell * {
      box-sizing: border-box;
    }

    body.desktop-native-workbench .desktop-workbench-shell {
      height: calc(100vh - var(--desktop-window-frame-height, 0px));
      padding-top: var(--desktop-window-frame-height, 0px);
      display: grid;
      grid-template-columns: 52px minmax(220px, var(--desktop-sidebar-size, 260px)) minmax(420px, 1fr) minmax(280px, var(--desktop-inspector-size, 360px));
      grid-template-rows: minmax(0, 1fr) auto;
      border-top: 1px solid var(--border, #dedbd3);
      background: var(--bg, #f7f7f4);
    }

    body.desktop-native-workbench .desktop-workbench-shell[data-inspector-visible="false"] {
      grid-template-columns: 52px minmax(220px, var(--desktop-sidebar-size, 260px)) minmax(0, 1fr) 0;
    }

    body.desktop-native-workbench .desktop-workbench-shell[data-sidebar-visible="false"] {
      grid-template-columns: 52px 0 minmax(420px, 1fr) minmax(280px, var(--desktop-inspector-size, 360px));
    }

    body.desktop-native-workbench .desktop-workbench-shell[data-sidebar-visible="false"][data-inspector-visible="false"] {
      grid-template-columns: 52px 0 minmax(0, 1fr) 0;
    }

    body.desktop-native-workbench .desktop-activity-rail {
      grid-column: 1;
      grid-row: 1 / span 2;
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 10px 6px;
      border-right: 1px solid var(--border, #dedbd3);
      background: var(--panel-strong, #ffffff);
    }

    body.desktop-native-workbench .desktop-activity-button,
    body.desktop-native-workbench .desktop-quick-action {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 36px;
      border: 1px solid var(--border, #dedbd3);
      border-radius: 6px;
      background: var(--panel, #ffffff);
      color: var(--text, #24211d);
      font: 600 12px/1.2 var(--font-sans, system-ui, sans-serif);
      text-decoration: none;
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-workbench-sidebar,
    body.desktop-native-workbench .desktop-workbench-inspector,
    body.desktop-native-workbench .desktop-workbench-bottom,
    body.desktop-native-workbench .desktop-workbench-main {
      min-width: 0;
      min-height: 0;
      overflow: hidden;
      border-right: 1px solid var(--border, #dedbd3);
      background: var(--panel, #ffffff);
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
      grid-template-rows: minmax(0, 1fr) auto;
      padding: 14px;
      overflow: auto;
      background: var(--bg-subtle, #f2f0ea);
    }

    body.desktop-native-workbench .desktop-empty-session {
      align-self: start;
      display: grid;
      gap: 12px;
      max-width: 720px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-empty-session > * {
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-empty-session h1 {
      margin: 0;
      font-size: 20px;
      line-height: 1.2;
    }

    body.desktop-native-workbench .desktop-empty-session p,
    body.desktop-native-workbench .desktop-workbench-section p {
      margin: 0;
      color: var(--text-muted, #6f685d);
      font-size: 12px;
      line-height: 1.45;
      overflow-wrap: anywhere;
    }

    body.desktop-native-workbench .desktop-workbench-link {
      min-width: 0;
      overflow: hidden;
      color: var(--text, #24211d);
      font-size: 12px;
      line-height: 1.3;
      text-decoration: none;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    body.desktop-native-workbench .desktop-workbench-link:focus-visible,
    body.desktop-native-workbench .desktop-activity-button:focus-visible,
    body.desktop-native-workbench .desktop-quick-action:focus-visible {
      outline: 2px solid var(--accent, #5c6bc0);
      outline-offset: 2px;
    }

    body.desktop-native-workbench .desktop-quick-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    body.desktop-native-workbench .desktop-panel-controls {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      min-width: 0;
    }

    body.desktop-native-workbench .desktop-panel-control {
      min-height: 32px;
      border: 1px solid var(--border, #dedbd3);
      border-radius: 6px;
      padding: 0 10px;
      background: var(--panel, #ffffff);
      color: var(--text, #24211d);
      font: 600 12px/1.2 var(--font-sans, system-ui, sans-serif);
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-panel-control[aria-pressed="true"] {
      border-color: var(--accent, #5c6bc0);
      background: var(--panel-strong, #ffffff);
    }

    body.desktop-native-workbench .desktop-command-palette {
      display: grid;
      gap: 8px;
      width: min(680px, 100%);
      border: 1px solid var(--border, #dedbd3);
      border-radius: 6px;
      padding: 10px;
      background: var(--panel, #ffffff);
      box-shadow: 0 12px 30px rgba(20, 18, 15, 0.16);
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
      border: 1px solid var(--border, #dedbd3);
      border-radius: 6px;
      background: var(--panel, #ffffff);
      color: var(--text, #24211d);
      font: 12px/1.2 var(--font-sans, system-ui, sans-serif);
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
      border: 1px solid var(--border, #dedbd3);
      border-radius: 6px;
      padding: 0 10px;
      color: var(--text, #24211d);
      font: 13px/1.2 var(--font-sans, system-ui, sans-serif);
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
      color: var(--text-muted, #6f685d);
      font-size: 11px;
      line-height: 1.35;
    }

    body.desktop-native-workbench .desktop-command-palette-close:focus-visible,
    body.desktop-native-workbench .desktop-command-palette-input:focus-visible,
    body.desktop-native-workbench .desktop-command-palette-result:focus-visible {
      outline: 2px solid var(--accent, #5c6bc0);
      outline-offset: 2px;
    }

    body.desktop-native-workbench .desktop-panel-control:focus-visible,
    body.desktop-native-workbench .desktop-file-action:focus-visible,
    body.desktop-native-workbench .desktop-task-action:focus-visible,
    body.desktop-native-workbench .desktop-session-upload-key:focus-visible,
    body.desktop-native-workbench .desktop-workspace-file-row:focus-visible,
    body.desktop-native-workbench .desktop-workspace-editor:focus-visible {
      outline: 2px solid var(--accent, #5c6bc0);
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
      border: 1px solid var(--border, #dedbd3);
      border-radius: 6px;
      background: var(--panel, #ffffff);
      color: var(--text, #24211d);
      font: 600 12px/1.2 var(--font-sans, system-ui, sans-serif);
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-file-action.is-desktop-drop-hover,
    body.desktop-native-workbench .desktop-file-action[data-desktop-drop-target]:focus-visible {
      outline: 2px solid var(--accent, #5c6bc0);
      outline-offset: 2px;
      background: var(--panel-strong, #ffffff);
    }

    body.desktop-native-workbench .desktop-session-upload-key {
      min-width: 0;
      width: min(220px, 100%);
      min-height: 34px;
      border: 1px solid var(--border, #dedbd3);
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
      border: 1px solid var(--border, #dedbd3);
      border-radius: 6px;
      padding: 0 8px;
      overflow: hidden;
      background: var(--panel, #ffffff);
      color: var(--text, #24211d);
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
      border: 1px solid var(--border, #dedbd3);
      border-radius: 6px;
      padding: 8px;
      resize: vertical;
      font: 12px/1.45 ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
    }

    body.desktop-native-workbench .desktop-workspace-error {
      color: var(--danger, #a33a2f);
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
      border-right: 1px solid var(--border, #dedbd3);
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
      color: var(--text-muted, #6f685d);
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
      border: 1px solid var(--border, #dedbd3);
      border-radius: 6px;
      padding: 8px;
      background: var(--panel-strong, #ffffff);
    }

    body.desktop-native-workbench .desktop-task-center-item[data-desktop-task-state="failed"] {
      border-color: var(--danger, #a33a2f);
    }

    body.desktop-native-workbench .desktop-task-center-item[data-desktop-task-state="blocked"] {
      border-color: var(--warning, #a76a00);
    }

    body.desktop-native-workbench .desktop-task-center-item[data-desktop-task-state="completed"] {
      opacity: 0.82;
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
      border: 1px solid var(--border, #dedbd3);
      border-radius: 6px;
      padding: 2px 6px;
      color: var(--text-muted, #6f685d);
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
      border: 1px solid var(--border, #dedbd3);
      border-radius: 6px;
      padding: 0 8px;
      background: var(--panel, #ffffff);
      color: var(--text, #24211d);
      font: 600 11px/1.2 var(--font-sans, system-ui, sans-serif);
      text-decoration: none;
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-gateway-runtime {
      min-width: 0;
      overflow: auto;
    }

    body.desktop-native-workbench .desktop-gateway-runtime-row {
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
      border: 1px solid var(--border, #dedbd3);
      border-radius: 6px;
      padding: 0 8px;
      background: var(--panel, #ffffff);
      color: var(--text, #24211d);
      font: 600 11px/1.2 var(--font-sans, system-ui, sans-serif);
      cursor: pointer;
    }

    body.desktop-native-workbench .desktop-gateway-action:focus-visible {
      outline: 2px solid var(--accent, #5c6bc0);
      outline-offset: 2px;
    }

    body.desktop-native-workbench .desktop-workbench-section {
      display: grid;
      gap: 8px;
      padding: 12px;
      border-bottom: 1px solid var(--border, #dedbd3);
    }

    body.desktop-native-workbench .desktop-workbench-section h2 {
      margin: 0;
      font-size: 12px;
      line-height: 1.2;
      text-transform: uppercase;
      letter-spacing: 0;
    }

    body.desktop-native-workbench .desktop-status-strip {
      overflow: hidden;
      padding: 8px 0 0;
      color: var(--text-muted, #6f685d);
      font-size: 11px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    body.desktop-native-workbench .desktop-workbench-bottom {
      grid-column: 2 / span 3;
      width: auto;
      height: var(--desktop-bottom-size, var(--region-size));
      border-top: 1px solid var(--border, #dedbd3);
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

      body.desktop-native-workbench .desktop-empty-session {
        max-width: none;
      }
    }
  `;
  targetDocument.head.append(style);
}
