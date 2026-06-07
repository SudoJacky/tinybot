import { resolveDesktopNavigationTarget, type DesktopNavigationTarget } from "./desktopNavigation";

export type DesktopMenuCommandId =
  | "new-chat"
  | "stop-generation"
  | "search-sessions"
  | "open-chat"
  | "open-workspace"
  | "open-knowledge"
  | "open-files"
  | "open-cowork"
  | "open-tinybot-repo"
  | "open-settings"
  | "open-docs"
  | "open-shortcut-help"
  | "open-page-help"
  | "toggle-theme"
  | "toggle-sidebar"
  | "open-command-palette"
  | "refresh-gateway-status";

export type DesktopCommandAction =
  | "stop-generation"
  | "open-session-search"
  | "set-theme"
  | "set-sidebar-visible"
  | "open-command-palette"
  | "open-shortcut-help"
  | "open-page-help";

export interface DesktopMenuCommand {
  id: DesktopMenuCommandId;
  label: string;
  chromeLabel?: string;
  chromeGroup: "primary" | "secondary";
  shortcut: string;
}

export interface DesktopMenuCommandContext {
  activeGeneration: boolean;
  sidebarVisible: boolean;
  theme: "light" | "dark";
}

export type DesktopMenuCommandResult =
  | { kind: "navigate"; href: string }
  | { kind: "action"; action: DesktopCommandAction; value?: unknown }
  | { kind: "unavailable"; feedback: string };

export interface InstallDesktopMenuCommandRoutingOptions {
  gatewayOrigin: string;
  listenToMenuCommand: (handler: (id: string) => void) => void | Promise<unknown>;
  openExternal?: (href: string) => Promise<void> | void;
  targetDocument?: Document;
  targetWindow?: Window;
}

export const DESKTOP_MENU_COMMANDS: DesktopMenuCommand[] = [
  { id: "new-chat", label: "New Chat", chromeLabel: "New", chromeGroup: "primary", shortcut: "Ctrl+N" },
  { id: "stop-generation", label: "Stop Generation", chromeLabel: "Stop", chromeGroup: "primary", shortcut: "Ctrl+." },
  { id: "search-sessions", label: "Search Sessions", chromeLabel: "Search", chromeGroup: "primary", shortcut: "Ctrl+F" },
  { id: "open-chat", label: "Chat", chromeGroup: "secondary", shortcut: "" },
  { id: "open-files", label: "Files", chromeGroup: "secondary", shortcut: "" },
  { id: "open-knowledge", label: "Knowledge", chromeGroup: "secondary", shortcut: "" },
  { id: "open-cowork", label: "Cowork", chromeGroup: "secondary", shortcut: "" },
  { id: "open-tinybot-repo", label: "Tinybot repo", chromeGroup: "secondary", shortcut: "" },
  { id: "open-settings", label: "Settings", chromeGroup: "secondary", shortcut: "Ctrl+," },
  { id: "open-docs", label: "Documentation", chromeGroup: "secondary", shortcut: "F1" },
  { id: "open-shortcut-help", label: "Shortcut Help", chromeGroup: "secondary", shortcut: "Ctrl+/" },
  { id: "open-page-help", label: "Page Help", chromeGroup: "secondary", shortcut: "Ctrl+Shift+/" },
  { id: "toggle-theme", label: "Toggle Theme", chromeGroup: "secondary", shortcut: "Ctrl+Shift+T" },
  { id: "toggle-sidebar", label: "Toggle Sidebar", chromeGroup: "secondary", shortcut: "Ctrl+B" },
  { id: "open-command-palette", label: "Command Palette", chromeLabel: "Command", chromeGroup: "primary", shortcut: "Ctrl+Shift+P" },
  { id: "refresh-gateway-status", label: "Gateway Status", chromeGroup: "secondary", shortcut: "Ctrl+Shift+G" },
];

const DESKTOP_CHROME_COMMAND_IDS: DesktopMenuCommandId[] = [
  "new-chat",
  "search-sessions",
  "open-command-palette",
  "stop-generation",
  "toggle-theme",
  "toggle-sidebar",
];

const DESKTOP_RESOURCE_COMMAND_IDS: DesktopMenuCommandId[] = [
  "open-chat",
  "open-files",
  "open-knowledge",
  "open-cowork",
];

const DESKTOP_SYSTEM_COMMAND_IDS: DesktopMenuCommandId[] = [
  "open-settings",
  "refresh-gateway-status",
];

export const DESKTOP_CHROME_COMMANDS: DesktopMenuCommand[] = DESKTOP_CHROME_COMMAND_IDS
  .map((id) => DESKTOP_MENU_COMMANDS.find((command) => command.id === id))
  .filter((command): command is DesktopMenuCommand => Boolean(command));

export const DESKTOP_RESOURCE_COMMANDS: DesktopMenuCommand[] = DESKTOP_RESOURCE_COMMAND_IDS
  .map((id) => DESKTOP_MENU_COMMANDS.find((command) => command.id === id))
  .filter((command): command is DesktopMenuCommand => Boolean(command));

export const DESKTOP_SYSTEM_COMMANDS: DesktopMenuCommand[] = DESKTOP_SYSTEM_COMMAND_IDS
  .map((id) => DESKTOP_MENU_COMMANDS.find((command) => command.id === id))
  .filter((command): command is DesktopMenuCommand => Boolean(command));

const DESKTOP_HELP_COMMAND_IDS: DesktopMenuCommandId[] = [
  "open-docs",
  "open-shortcut-help",
  "open-page-help",
  "open-tinybot-repo",
];

export const DESKTOP_HELP_COMMANDS: DesktopMenuCommand[] = DESKTOP_HELP_COMMAND_IDS
  .map((id) => DESKTOP_MENU_COMMANDS.find((command) => command.id === id))
  .filter((command): command is DesktopMenuCommand => Boolean(command));

interface DesktopShortcutLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

export function routeDesktopMenuCommand(id: string, context: DesktopMenuCommandContext): DesktopMenuCommandResult {
  switch (id) {
    case "new-chat":
      return { kind: "navigate", href: "/chat/new" };
    case "stop-generation":
      return context.activeGeneration
        ? { kind: "action", action: "stop-generation" }
        : { kind: "unavailable", feedback: "Stop generation is unavailable without an active response." };
    case "search-sessions":
      return { kind: "action", action: "open-session-search" };
    case "open-chat":
      return { kind: "navigate", href: "/chat" };
    case "open-workspace":
      return { kind: "navigate", href: "/files" };
    case "open-knowledge":
      return { kind: "navigate", href: "/knowledge" };
    case "open-files":
      return { kind: "navigate", href: "/files" };
    case "open-cowork":
      return { kind: "navigate", href: "/cowork" };
    case "open-tinybot-repo":
      return { kind: "navigate", href: "https://github.com/SudoJacky/tinybot" };
    case "open-settings":
      return { kind: "navigate", href: "/settings" };
    case "open-docs":
      return { kind: "navigate", href: "/docs" };
    case "open-shortcut-help":
      return { kind: "action", action: "open-shortcut-help" };
    case "open-page-help":
      return { kind: "action", action: "open-page-help" };
    case "toggle-theme":
      return { kind: "action", action: "set-theme", value: context.theme === "dark" ? "light" : "dark" };
    case "toggle-sidebar":
      return { kind: "action", action: "set-sidebar-visible", value: !context.sidebarVisible };
    case "open-command-palette":
      return { kind: "action", action: "open-command-palette" };
    case "refresh-gateway-status":
      return { kind: "navigate", href: "/api/status" };
    default:
      return { kind: "unavailable", feedback: `Unknown desktop command: ${id}` };
  }
}

export function installDesktopMenuCommandRouting({
  gatewayOrigin,
  listenToMenuCommand,
  targetDocument = document,
  targetWindow = window,
}: InstallDesktopMenuCommandRoutingOptions): void {
  targetDocument.addEventListener("keydown", (event) => {
    const id = resolveDesktopShortcutCommand(event);
    if (!id) {
      return;
    }
    event.preventDefault();
    const result = routeDesktopMenuCommand(id, readCommandContext(targetDocument));
    applyDesktopMenuCommandResult(result, { gatewayOrigin, targetDocument, targetWindow });
  });
  targetDocument.addEventListener("desktop-menu-command", (event) => {
    const id = (event as CustomEvent<{ id?: unknown }>).detail?.id;
    if (typeof id === "string") {
      const result = routeDesktopMenuCommand(id, readCommandContext(targetDocument));
      applyDesktopMenuCommandResult(result, { gatewayOrigin, targetDocument, targetWindow });
    }
  });
  void listenToMenuCommand((id) => {
    const result = routeDesktopMenuCommand(id, readCommandContext(targetDocument));
    applyDesktopMenuCommandResult(result, { gatewayOrigin, targetDocument, targetWindow });
  });
}

export function resolveDesktopShortcutCommand(event: DesktopShortcutLike): DesktopMenuCommandId | null {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const commandModifier = event.ctrlKey === true || event.metaKey === true;
  const shift = event.shiftKey === true;
  const alt = event.altKey === true;
  if (alt) {
    return null;
  }
  if (key === "F1" && !commandModifier && !shift) {
    return "open-docs";
  }
  if (!commandModifier) {
    return null;
  }
  if (!shift && (key === "/" || key === "?")) {
    return "open-shortcut-help";
  }
  if (shift && (key === "/" || key === "?")) {
    return "open-page-help";
  }
  if (!shift && key === "n") {
    return "new-chat";
  }
  if (!shift && key === ".") {
    return "stop-generation";
  }
  if (!shift && key === "f") {
    return "search-sessions";
  }
  if (!shift && key === ",") {
    return "open-settings";
  }
  if (shift && key === "t") {
    return "toggle-theme";
  }
  if (!shift && key === "b") {
    return "toggle-sidebar";
  }
  if (shift && key === "p") {
    return "open-command-palette";
  }
  if (shift && key === "g") {
    return "refresh-gateway-status";
  }
  return null;
}

function readCommandContext(targetDocument: Document): DesktopMenuCommandContext {
  const shell = targetDocument.querySelector<HTMLElement>("#desktop-workbench-shell");
  const requestedTheme = targetDocument.documentElement.dataset.theme;
  return {
    activeGeneration: targetDocument.documentElement.dataset.desktopActiveGeneration === "true",
    sidebarVisible: shell?.dataset.sidebarVisible !== "false",
    theme: requestedTheme === "dark" ? "dark" : "light",
  };
}

function applyDesktopMenuCommandResult(
  result: DesktopMenuCommandResult,
  options: Pick<InstallDesktopMenuCommandRoutingOptions, "gatewayOrigin" | "targetDocument" | "targetWindow"> & {
    openExternal?: (href: string) => Promise<void> | void;
    targetDocument: Document;
    targetWindow: Window;
  },
): void {
  if (result.kind === "unavailable") {
    setCommandFeedback(options.targetDocument, result.feedback);
    return;
  }

  if (result.kind === "navigate") {
    routeMenuNavigation(result.href, options);
    return;
  }

  applyCommandAction(result, options.targetDocument);
}

function routeMenuNavigation(
  href: string,
  { gatewayOrigin, openExternal, targetDocument, targetWindow }: Pick<InstallDesktopMenuCommandRoutingOptions, "gatewayOrigin" | "openExternal"> & {
    targetDocument: Document;
    targetWindow: Window;
  },
): void {
  const target = resolveDesktopNavigationTarget(href, {
    desktopOrigin: targetWindow.location.origin,
    gatewayOrigin,
  });
  targetDocument.documentElement.dataset.desktopNavigationKind = target.kind;
  targetDocument.documentElement.dataset.desktopNavigationHref = target.href;
  updateRouteStatus(targetDocument, target);

  if (target.kind === "internal-docs") {
    targetWindow.location.assign(target.href);
    return;
  }
  if (target.kind === "workbench-route") {
    targetWindow.history.pushState({ tinybotDesktopRoute: target.href }, "", target.href);
    targetWindow.dispatchEvent(new CustomEvent("tinybot:desktop-route", { detail: target }));
    return;
  }
  if (target.kind === "gateway-action") {
    targetWindow.dispatchEvent(new CustomEvent("tinybot:desktop-gateway-action", { detail: target }));
    return;
  }
  if (target.kind === "external-url") {
    if (openExternal) {
      void openExternal(target.href);
      return;
    }
    targetWindow.open(target.href, "_blank", "noopener");
  }
}

function applyCommandAction(result: Extract<DesktopMenuCommandResult, { kind: "action" }>, targetDocument: Document): void {
  if (result.action === "stop-generation") {
    targetDocument.dispatchEvent(new CustomEvent("tinybot:desktop-stop-generation"));
    setCommandFeedback(targetDocument, "Stop generation requested");
    return;
  }
  if (result.action === "set-theme") {
    targetDocument.documentElement.dataset.theme = result.value === "dark" ? "dark" : "light";
    setCommandFeedback(targetDocument, `Theme ${targetDocument.documentElement.dataset.theme}`);
    return;
  }
  if (result.action === "set-sidebar-visible") {
    const shell = targetDocument.querySelector<HTMLElement>("#desktop-workbench-shell");
    shell?.setAttribute("data-sidebar-visible", String(result.value));
    targetDocument.querySelector<HTMLElement>('[data-workbench-region="sidebar"]')?.setAttribute("data-visible", String(result.value));
    targetDocument.querySelector<HTMLElement>('[data-desktop-panel-control="sidebar"]')?.setAttribute("aria-pressed", String(result.value));
    setCommandFeedback(targetDocument, result.value ? "Sidebar shown" : "Sidebar hidden");
    return;
  }
  if (result.action === "open-command-palette") {
    targetDocument.dispatchEvent(new CustomEvent("tinybot:open-command-palette"));
    setCommandFeedback(targetDocument, "Command palette opened");
    return;
  }
  if (result.action === "open-shortcut-help") {
    targetDocument.dispatchEvent(new CustomEvent("tinybot:open-shortcut-help"));
    setCommandFeedback(targetDocument, "Shortcut help opened");
    return;
  }
  if (result.action === "open-page-help") {
    targetDocument.dispatchEvent(new CustomEvent("tinybot:open-page-help"));
    setCommandFeedback(targetDocument, "Page help opened");
    return;
  }
  setCommandFeedback(targetDocument, commandActionFeedback(result.action));
}

function commandActionFeedback(action: DesktopCommandAction): string {
  if (action === "stop-generation") {
    return "Stop generation requested";
  }
  if (action === "open-session-search") {
    return "Session search requested";
  }
  if (action === "open-command-palette") {
    return "Command palette requested";
  }
  if (action === "open-shortcut-help") {
    return "Shortcut help requested";
  }
  if (action === "open-page-help") {
    return "Page help requested";
  }
  return "Command routed";
}

function updateRouteStatus(targetDocument: Document, target: DesktopNavigationTarget): void {
  if (target.kind === "gateway-action") {
    setCommandFeedback(targetDocument, `Gateway action ${new URL(target.href).pathname}`);
    return;
  }
  setCommandFeedback(targetDocument, `Route ${new URL(target.href).pathname}`);
}

function setCommandFeedback(targetDocument: Document, message: string): void {
  const routeStatus = targetDocument.querySelector<HTMLElement>("[data-desktop-route-status]");
  if (routeStatus) {
    routeStatus.textContent = message;
  }
  targetDocument.documentElement.dataset.desktopCommandFeedback = message;
}
