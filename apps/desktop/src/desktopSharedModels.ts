import { DESKTOP_MENU_COMMANDS, type DesktopMenuCommandId } from "./desktopCommandNavigation";

export type DesktopShellMode = "root-webui" | "native-workbench";

export type DesktopSidebarGroupId = "actions" | "workspace" | "footer";

export type DesktopSidebarItemKind = "command" | "link" | "session" | "status";

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

const ROOT_WEBUI_ACTION_COMMANDS: DesktopMenuCommandId[] = [
  "new-chat",
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
          { id: "link:tools", kind: "link", label: "Tools", href: "/tools", icon: "tools" },
          { id: "link:automations", kind: "link", label: "Automations", href: "/cowork", icon: "automation" },
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
        items: sidebarItemsFromCommands(ROOT_WEBUI_ACTION_COMMANDS),
      },
      {
        id: "workspace",
        label: "Resources",
        items: [
          { id: "link:workspace", kind: "link", label: "Workspace", href: "/workspace", icon: "files" },
          { id: "link:knowledge", kind: "link", label: "Knowledge", href: "/knowledge", icon: "knowledge" },
          { id: "link:tools", kind: "link", label: "Tools", href: "/tools", icon: "tools" },
          { id: "link:automations", kind: "link", label: "Automations", href: "/cowork", icon: "automation" },
          { id: "link:docs", kind: "link", label: "Docs", href: "/docs", icon: "docs" },
          { id: "link:repo", kind: "link", label: "Tinybot repo", href: "https://github.com/SudoJacky/tinybot", icon: "repo" },
        ],
      },
      {
        id: "footer",
        items: sidebarItemsFromCommands(ROOT_WEBUI_FOOTER_COMMANDS),
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
