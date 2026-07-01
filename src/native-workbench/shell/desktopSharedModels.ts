import { DESKTOP_MENU_COMMANDS, type DesktopMenuCommandId } from "../command/desktopCommandNavigation";

export type DesktopShellMode = "root-webui" | "native-workbench";

export type DesktopSidebarGroupId = "actions" | "workspace" | "footer";

export type DesktopSidebarItemKind = "command" | "link" | "session" | "status";

export type NativeWorkbenchAreaId = "chat" | "settings";

export type NativeWorkbenchFileScopeId = "session" | "knowledge" | "workspace";

export type NativeWorkbenchInspectorTabId = "context" | "files" | "tasks" | "approvals" | "activity";

export type NativeWorkbenchSettingsSectionId =
  | "general"
  | "provider-models"
  | "gateway-runtime"
  | "logs-diagnostics";

export interface NativeWorkbenchArea {
  id: NativeWorkbenchAreaId;
  label: string;
  href: string;
  owner: string;
}

export interface NativeWorkbenchFileScopeLabel {
  id: NativeWorkbenchFileScopeId;
  label: string;
  description: string;
}

export interface NativeWorkbenchInspectorTab {
  id: NativeWorkbenchInspectorTabId;
  label: string;
  active: boolean;
  badge: number | null;
}

export interface NativeWorkbenchInspectorTabOptions {
  activePage?: NativeWorkbenchAreaId;
  activityCount?: number;
  approvalCount?: number;
  fileCount?: number;
  taskCount?: number;
}

export interface NativeWorkbenchSettingsSection {
  id: NativeWorkbenchSettingsSectionId;
  label: string;
  href: string;
}

export interface NativeWorkbenchRoadmapPhase {
  id: "phase-1" | "phase-2" | "phase-3" | "phase-4";
  title: string;
  exitCriteria: string;
}

export interface DesktopSidebarItem {
  id: string;
  kind: DesktopSidebarItemKind;
  label: string;
  commandId?: DesktopMenuCommandId;
  href?: string;
  icon?: string;
  shortcut?: string;
  meta?: string;
  active?: boolean;
  disabled?: boolean;
}

export interface DesktopSidebarGroup {
  id: DesktopSidebarGroupId;
  label?: string;
  items: DesktopSidebarItem[];
}

export interface DesktopSidebarModel {
  mode: DesktopShellMode;
  workspace: DesktopWorkspaceContext;
  groups: DesktopSidebarGroup[];
}

export interface DesktopCommandEntry {
  id: string;
  title: string;
  group: string;
  keywords: string[];
  commandId?: DesktopMenuCommandId;
  href?: string;
}

export type DesktopRuntimeChipTone = "ok" | "pending" | "warn" | "muted";

export interface DesktopRuntimeChip {
  id: string;
  label: string;
  value: string;
  tone: DesktopRuntimeChipTone;
}

export interface DesktopWorkspaceContext {
  id: string;
  label: string;
  mode: DesktopShellMode;
  activeSession?: {
    id: string;
    title: string;
    meta?: string;
  };
}

export interface RootWebUiSidebarModelOptions {
  workspace?: DesktopWorkspaceContext;
  sessions?: DesktopSidebarItem[];
}

export interface RootWebUiWorkspaceContextOptions {
  workspaceId?: string;
  workspaceLabel?: string;
  activeSession?: DesktopWorkspaceContext["activeSession"];
}

export interface RootWebUiRuntimeChipOptions {
  provider?: string | null;
  model?: string | null;
  websocketConnected?: boolean | null;
  tokenUsage?: string | null;
}

export interface NativeWorkbenchSidebarModelOptions {
  workspace?: DesktopWorkspaceContext;
}

const NATIVE_WORKBENCH_AREAS: NativeWorkbenchArea[] = [
  {
    id: "chat",
    label: "Chat",
    href: "/chat",
    owner: "Daily AI execution and conversation work items",
  },
  {
    id: "settings",
    label: "Settings",
    href: "/settings",
    owner: "Providers, models, runtime, and diagnostics",
  },
];

const WORKBENCH_FILE_SCOPE_LABELS: Record<NativeWorkbenchFileScopeId, NativeWorkbenchFileScopeLabel> = {
  session: {
    id: "session",
    label: "Session file",
    description: "Temporary file attached to the active conversation.",
  },
  knowledge: {
    id: "knowledge",
    label: "Knowledge document",
    description: "Persisted document indexed for retrieval, graph, and evidence workflows.",
  },
  workspace: {
    id: "workspace",
    label: "Workspace file",
    description: "Local project file that can be previewed, edited, revealed, or referenced.",
  },
};

const WORKBENCH_INSPECTOR_TABS: Array<{ id: NativeWorkbenchInspectorTabId; label: string }> = [
  { id: "context", label: "Context" },
  { id: "files", label: "Files" },
  { id: "tasks", label: "Tasks" },
  { id: "approvals", label: "Approvals" },
  { id: "activity", label: "Activity" },
];

const WORKBENCH_SETTINGS_SECTIONS: NativeWorkbenchSettingsSection[] = [
  { id: "general", label: "General", href: "/settings/general" },
  { id: "provider-models", label: "Provider & Models", href: "/settings/provider-models" },
  { id: "gateway-runtime", label: "Gateway & Runtime", href: "/settings/gateway-runtime" },
  { id: "logs-diagnostics", label: "Logs & Diagnostics", href: "/settings/logs-diagnostics" },
];

const NATIVE_WORKBENCH_ROADMAP: NativeWorkbenchRoadmapPhase[] = [
  {
    id: "phase-1",
    title: "Chat foundation",
    exitCriteria: "Chat, Settings, runtime status, and provider basics are usable together.",
  },
  {
    id: "phase-2",
    title: "Agent execution clarity",
    exitCriteria: "Run timeline, approvals, forms, references, and token usage are inspectable from chat.",
  },
  {
    id: "phase-3",
    title: "Selective expansion",
    exitCriteria: "Files, Knowledge, Skills, and Cowork only return after the Rust backend exposes stable frontend contracts.",
  },
  {
    id: "phase-4",
    title: "Advanced workbench capabilities",
    exitCriteria: "Multi-window, tray, channels, memory, automations, and collaboration are planned after core stability.",
  },
];

const ROOT_WEBUI_ACTION_COMMANDS: DesktopMenuCommandId[] = [
  "new-chat",
  "search-sessions",
  "open-command-palette",
];

const NATIVE_WORKBENCH_ACTION_COMMANDS: DesktopMenuCommandId[] = [
  "new-chat",
  "stop-generation",
  "search-sessions",
  "open-command-palette",
];

const ROOT_WEBUI_FOOTER_COMMANDS: DesktopMenuCommandId[] = [
  "open-settings",
  "refresh-gateway-status",
  "open-docs",
];

const MENU_COMMANDS_BY_ID = new Map(DESKTOP_MENU_COMMANDS.map((command) => [command.id, command]));

export function buildRootWebUiWorkspaceContext({
  workspaceId = "root-webui",
  workspaceLabel = "tinybot",
  activeSession,
}: RootWebUiWorkspaceContextOptions = {}): DesktopWorkspaceContext {
  return {
    id: workspaceId,
    label: workspaceLabel,
    mode: "root-webui",
    activeSession,
  };
}

export function buildRootWebUiSidebarModel({
  workspace = buildRootWebUiWorkspaceContext(),
  sessions = [],
}: RootWebUiSidebarModelOptions = {}): DesktopSidebarModel {
  return {
    mode: "root-webui",
    workspace,
    groups: [
      {
        id: "actions",
        items: [
          ...sidebarItemsFromCommands(ROOT_WEBUI_ACTION_COMMANDS),
        ],
      },
      {
        id: "workspace",
        label: workspace.label,
        items: sessions,
      },
      {
        id: "footer",
        items: sidebarItemsFromCommands(ROOT_WEBUI_FOOTER_COMMANDS),
      },
    ],
  };
}

export function buildNativeWorkbenchSidebarModel({
  workspace = buildNativeWorkbenchWorkspaceContext(),
}: NativeWorkbenchSidebarModelOptions = {}): DesktopSidebarModel {
  return {
    mode: "native-workbench",
    workspace,
    groups: [
      {
        id: "actions",
        items: sidebarItemsFromCommands(NATIVE_WORKBENCH_ACTION_COMMANDS),
      },
      {
        id: "workspace",
        label: "Resources",
        items: buildWorkbenchWorkbenchAreas().map((area) => ({
          id: `link:${area.id}`,
          kind: "link",
          label: area.label,
          href: area.href,
          commandId: area.id === "settings" ? "open-settings" : undefined,
          icon: area.id === "chat" ? "new-chat" : area.id,
        })),
      },
      {
        id: "footer",
        items: sidebarItemsFromCommands(ROOT_WEBUI_FOOTER_COMMANDS.filter((commandId) => commandId !== "open-settings")),
      },
    ],
  };
}

function buildNativeWorkbenchWorkspaceContext(): DesktopWorkspaceContext {
  return {
    id: "native-workbench",
    label: "tinybot",
    mode: "native-workbench",
  };
}

export function buildRootWebUiRuntimeChips({
  provider,
  model,
  websocketConnected,
  tokenUsage,
}: RootWebUiRuntimeChipOptions = {}): DesktopRuntimeChip[] {
  return [
    {
      id: "provider",
      label: "Provider",
      value: normalizeRuntimeValue(provider),
      tone: provider ? "ok" : "muted",
    },
    {
      id: "model",
      label: "Model",
      value: normalizeRuntimeValue(model),
      tone: model ? "ok" : "muted",
    },
    {
      id: "websocket",
      label: "WebSocket",
      value: websocketConnected === true ? "Connected" : websocketConnected === false ? "Disconnected" : "-",
      tone: websocketConnected === true ? "ok" : websocketConnected === false ? "warn" : "muted",
    },
    {
      id: "token-usage",
      label: "Token usage",
      value: normalizeRuntimeValue(tokenUsage),
      tone: tokenUsage ? "ok" : "muted",
    },
  ];
}

export function buildDesktopCommandEntriesFromSidebar(model: DesktopSidebarModel): DesktopCommandEntry[] {
  return model.groups.flatMap((group) =>
    group.items.map((item) => ({
      id: `sidebar:${item.id}`,
      title: item.label,
      group: group.label ?? sidebarGroupLabel(group.id),
      keywords: commandKeywords(item, group, model.workspace),
      commandId: item.commandId,
      href: item.href,
    })),
  );
}

export function buildWorkbenchWorkbenchAreas(): NativeWorkbenchArea[] {
  return NATIVE_WORKBENCH_AREAS.map((area) => ({ ...area }));
}

export function buildWorkbenchFileScopeLabel(scope: NativeWorkbenchFileScopeId): NativeWorkbenchFileScopeLabel {
  return { ...WORKBENCH_FILE_SCOPE_LABELS[scope] };
}

export function buildWorkbenchInspectorTabs({
  activePage = "chat",
  activityCount = 0,
  approvalCount = 0,
  fileCount = 0,
  taskCount = 0,
}: NativeWorkbenchInspectorTabOptions = {}): NativeWorkbenchInspectorTab[] {
  const activeTab = activePage === "chat" ? "context" : "activity";
  const badgeByTab: Partial<Record<NativeWorkbenchInspectorTabId, number>> = {
    activity: activityCount,
    approvals: approvalCount,
    files: fileCount,
    tasks: taskCount,
  };
  return WORKBENCH_INSPECTOR_TABS.map((tab) => ({
    ...tab,
    active: tab.id === activeTab,
    badge: badgeByTab[tab.id] ? badgeByTab[tab.id] ?? null : null,
  }));
}

export function buildWorkbenchSettingsSections(): NativeWorkbenchSettingsSection[] {
  return WORKBENCH_SETTINGS_SECTIONS.map((section) => ({ ...section }));
}

export function buildNativeWorkbenchRoadmap(): NativeWorkbenchRoadmapPhase[] {
  return NATIVE_WORKBENCH_ROADMAP.map((phase) => ({ ...phase }));
}

function sidebarItemsFromCommands(commandIds: DesktopMenuCommandId[]): DesktopSidebarItem[] {
  return commandIds.map((commandId) => {
    const command = MENU_COMMANDS_BY_ID.get(commandId);
    return {
      id: `command:${commandId}`,
      kind: "command",
      label: command?.label ?? commandId,
      commandId,
      icon: commandIcon(commandId),
      shortcut: command?.shortcut,
    };
  });
}

function normalizeRuntimeValue(value: string | null | undefined): string {
  const normalized = value?.trim();
  return normalized || "-";
}

function commandIcon(commandId: DesktopMenuCommandId): string {
  switch (commandId) {
    case "new-chat":
      return "new-chat";
    case "stop-generation":
      return "stop";
    case "search-sessions":
      return "search";
    case "open-command-palette":
      return "command";
    case "open-settings":
      return "settings";
    case "refresh-gateway-status":
      return "gateway";
    case "open-docs":
      return "docs";
    default:
      return "command";
  }
}

function sidebarGroupLabel(groupId: DesktopSidebarGroupId): string {
  switch (groupId) {
    case "actions":
      return "Actions";
    case "workspace":
      return "Workspace";
    case "footer":
      return "System";
  }
}

function commandKeywords(
  item: DesktopSidebarItem,
  group: DesktopSidebarGroup,
  workspace: DesktopWorkspaceContext,
): string[] {
  return [
    item.label,
    item.id,
    item.commandId ?? "",
    item.href ?? "",
    group.id,
    group.label ?? "",
    workspace.label,
  ].filter(Boolean).map((value) => value.toLowerCase());
}
