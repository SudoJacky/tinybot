import {
  resolveDesktopShortcutCommand,
  type DesktopMenuCommandId,
} from "./desktopCommandNavigation";

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

  void listenToMenuCommand((id) => {
    routeDesktopWebUiCommand(id, targetDocument, targetWindow);
  });
}

function routeDesktopWebUiCommand(id: string, targetDocument: Document, targetWindow: Window): void {
  if (id === "open-docs") {
    targetWindow.location.assign(new URL("/docs", targetWindow.location.origin).href);
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
    return "Session search is not available in the WebUI shell.";
  }
  if (id === "open-command-palette") {
    return "Command palette is not available in the WebUI shell.";
  }
  if (id === "refresh-gateway-status") {
    return "Gateway status refresh is handled by WebUI status polling.";
  }
  return `Unknown desktop command: ${id}`;
}

function setCommandFeedback(targetDocument: Document, message: string): void {
  const routeStatus = targetDocument.querySelector<HTMLElement>("[data-desktop-route-status]");
  if (routeStatus) {
    routeStatus.textContent = message;
  }
  targetDocument.documentElement.dataset.desktopCommandFeedback = message;
}
