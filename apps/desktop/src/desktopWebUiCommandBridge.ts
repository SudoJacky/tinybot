import {
  resolveDesktopShortcutCommand,
  type DesktopMenuCommandId,
} from "./desktopCommandNavigation";
import { openDesktopCommandPalette } from "./desktopCommandPalette";

export interface DesktopWebUiCommandBridgeOptions {
  listenToMenuCommand: (handler: (id: string) => void) => void | Promise<unknown>;
  targetDocument?: Document;
  targetWindow?: Window;
}

const WEBUI_COMMAND_BUTTONS: Partial<Record<DesktopMenuCommandId, string>> = {
  "new-chat": "#new-chat-button",
  "open-settings": "#settings-button",
  "toggle-theme": "#theme-toggle",
  "toggle-sidebar": "#sidebar-collapse-button",
  "open-shortcut-help": "#help-tour-button",
  "open-page-help": "#help-tour-button",
};

export function installDesktopWebUiCommandBridge({
  listenToMenuCommand,
  targetDocument = document,
  targetWindow = window,
}: DesktopWebUiCommandBridgeOptions): void {
  targetDocument.addEventListener("keydown", (event) => {
    const id = resolveDesktopShortcutCommand(event);
    if (!id) {
      return;
    }
    event.preventDefault();
    routeDesktopWebUiCommand(id, targetDocument, targetWindow);
  });

  targetDocument.addEventListener("desktop-menu-command", (event) => {
    const id = (event as CustomEvent<{ id?: unknown }>).detail?.id;
    if (typeof id === "string") {
      routeDesktopWebUiCommand(id, targetDocument, targetWindow);
    }
  });
  targetDocument.addEventListener("contextmenu", (event) => {
    recordDesktopWebUiContextTarget(event, targetDocument);
  });

  void listenToMenuCommand((id) => {
    routeDesktopWebUiCommand(id, targetDocument, targetWindow);
  });
}

function routeDesktopWebUiCommand(id: string, targetDocument: Document, targetWindow: Window): void {
  if (id === "open-docs") {
    targetWindow.location.assign(new URL("/docs", targetWindow.location.origin).href);
    return;
  }
  if (id === "open-command-palette") {
    openDesktopCommandPalette(targetDocument);
    setCommandFeedback(targetDocument, "Command palette opened");
    return;
  }
  if (id === "search-sessions") {
    openDesktopCommandPalette(targetDocument, "session");
    setCommandFeedback(targetDocument, "Session search opened");
    return;
  }

  const selector = WEBUI_COMMAND_BUTTONS[id as DesktopMenuCommandId];
  const target = selector ? targetDocument.querySelector<HTMLElement>(selector) : null;
  if (target && typeof target.click === "function") {
    target.click();
    setCommandFeedback(targetDocument, commandFeedback(id));
    return;
  }

  setCommandFeedback(targetDocument, commandUnavailableFeedback(id));
}

function commandFeedback(id: string): string {
  switch (id) {
    case "new-chat":
      return "New chat requested";
    case "open-settings":
      return "Settings opened";
    case "toggle-theme":
      return "Theme toggled";
    case "toggle-sidebar":
      return "Sidebar toggled";
    case "open-shortcut-help":
    case "open-page-help":
      return "Help opened";
    default:
      return "Desktop command routed";
  }
}

function commandUnavailableFeedback(id: string): string {
  if (id === "stop-generation") {
    return "Stop generation is unavailable in the WebUI shell.";
  }
  if (id === "search-sessions") {
    return "Session search opened";
  }
  if (id === "open-command-palette") {
    return "Command palette opened";
  }
  if (id === "refresh-gateway-status") {
    return "Gateway status refresh is handled by WebUI status polling.";
  }
  return `Unknown desktop command: ${id}`;
}

function recordDesktopWebUiContextTarget(event: Event, targetDocument: Document): void {
  const target = event.target as HTMLElement | null;
  const closest = typeof target?.closest === "function"
    ? target.closest<HTMLElement>("[data-session-key], .session-item, .workspace-panel, .knowledge-panel, .tools-panel, .cowork-panel, .message, .composer, .inspector-panel")
    : null;
  if (!closest) {
    return;
  }

  targetDocument.documentElement.dataset.desktopContextMenuTarget = contextTargetName(closest);
  targetDocument.documentElement.dataset.desktopContextMenuAt = new Date(0).toISOString();
}

function contextTargetName(target: HTMLElement): string {
  if (target.dataset.sessionKey) {
    return `session:${target.dataset.sessionKey}`;
  }
  if (target.classList.contains("session-item")) {
    return "session";
  }
  if (target.classList.contains("workspace-panel")) {
    return "workspace";
  }
  if (target.classList.contains("knowledge-panel")) {
    return "knowledge";
  }
  if (target.classList.contains("tools-panel")) {
    return "tools";
  }
  if (target.classList.contains("cowork-panel")) {
    return "cowork";
  }
  if (target.classList.contains("message")) {
    return "message";
  }
  if (target.classList.contains("composer")) {
    return "composer";
  }
  if (target.classList.contains("inspector-panel")) {
    return "inspector";
  }
  return "root";
}

function setCommandFeedback(targetDocument: Document, message: string): void {
  const routeStatus = targetDocument.querySelector<HTMLElement>("[data-desktop-route-status]");
  if (routeStatus) {
    routeStatus.textContent = message;
  }
  targetDocument.documentElement.dataset.desktopCommandFeedback = message;
}
