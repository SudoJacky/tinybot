import {
  DESKTOP_CHROME_COMMANDS,
  DESKTOP_HELP_COMMANDS,
  DESKTOP_RESOURCE_COMMANDS,
  DESKTOP_SYSTEM_COMMANDS,
  type DesktopMenuCommand,
} from "./desktopCommandNavigation";
import type { GatewayRuntimeStatus } from "./desktopGatewayStartup";
import { mountDesktopHelpMenuIsland } from "./native-vue/desktopHelpMenuIsland";

export interface DesktopWindowHandle {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  startDragging(): Promise<void>;
  setIcon?(icon: unknown): Promise<void>;
}

interface InstallDesktopWindowFrameOptions {
  targetDocument?: Document;
  currentWindow: DesktopWindowHandle;
  defaultWindowIcon?: () => Promise<unknown | null>;
}

const FRAME_ID = "desktop-window-frame";
const RUNTIME_STATUS_ID = "desktop-runtime-status";
const STYLE_ID = "desktop-window-frame-style";

export interface DesktopRuntimeStatusView {
  tone: "ok" | "pending" | "warn";
  label: string;
  detail: string;
}

export function installDesktopWindowFrame({
  targetDocument = document,
  currentWindow,
  defaultWindowIcon,
}: InstallDesktopWindowFrameOptions): void {
  ensureDesktopWindowFrameStyle(targetDocument);
  targetDocument.body.classList.add("desktop-custom-frame");
  syncDesktopWindowIcon(currentWindow, defaultWindowIcon);

  if (targetDocument.getElementById(FRAME_ID)) {
    return;
  }

  const frame = targetDocument.createElement("div");
  frame.id = FRAME_ID;
  frame.setAttribute("id", FRAME_ID);
  frame.className = "desktop-window-frame";
  frame.setAttribute("data-tauri-drag-region", "");
  frame.setAttribute("role", "banner");
  frame.setAttribute("aria-label", "Tinybot desktop window controls");

  const appMenu = createApplicationMenu(targetDocument);

  const controls = targetDocument.createElement("div");
  controls.className = "desktop-window-controls";
  controls.append(
    createWindowButton(targetDocument, "close", "Close", () => currentWindow.close()),
    createWindowButton(targetDocument, "minimize", "Minimize", () => currentWindow.minimize()),
    createWindowButton(targetDocument, "maximize", "Maximize", () => currentWindow.toggleMaximize()),
  );

  frame.append(appMenu, controls);
  frame.addEventListener("pointerdown", () => {
    void currentWindow.startDragging().catch(logWindowFrameError);
  });
  frame.addEventListener("dblclick", () => {
    void currentWindow.toggleMaximize().catch(logWindowFrameError);
  });

  targetDocument.body.prepend(frame);
}

function syncDesktopWindowIcon(
  currentWindow: DesktopWindowHandle,
  defaultWindowIcon: (() => Promise<unknown | null>) | undefined,
): void {
  if (!currentWindow.setIcon || !defaultWindowIcon) {
    return;
  }
  void defaultWindowIcon()
    .then((icon) => {
      if (!icon) {
        return;
      }
      return currentWindow.setIcon?.(icon);
    })
    .catch(logWindowFrameError);
}

function createApplicationMenu(targetDocument: Document): HTMLElement {
  const menu = targetDocument.createElement("nav");
  menu.className = "desktop-application-menu";
  menu.setAttribute("aria-label", "Desktop application menu");

  menu.append(
    createDesktopTopMenu(targetDocument, "App", "Application menu", DESKTOP_CHROME_COMMANDS),
    createDesktopTopMenu(targetDocument, "Resources", "Resources menu", DESKTOP_RESOURCE_COMMANDS),
    createDesktopTopMenu(targetDocument, "System", "System menu", DESKTOP_SYSTEM_COMMANDS),
    createDesktopTopMenu(targetDocument, "Help", "Help menu", DESKTOP_HELP_COMMANDS),
  );

  return menu;
}

function createDesktopTopMenu(
  targetDocument: Document,
  label: string,
  menuLabel: string,
  commands: DesktopMenuCommand[],
): HTMLElement {
  const menu = targetDocument.createElement("div");
  menu.className = `desktop-help-menu desktop-${label.toLowerCase()}-menu`;
  menu.setAttribute("data-desktop-menu-label", label);
  if (canMountDesktopHelpMenuIsland(menu)) {
    mountDesktopHelpMenuIsland(menu, {
      commands,
      label,
      menuLabel,
      onCommand: (id) => {
        targetDocument.dispatchEvent(new CustomEvent("desktop-menu-command", { detail: { id } }));
      },
    });
    return menu;
  }

  const trigger = targetDocument.createElement("button");
  trigger.type = "button";
  trigger.className = "desktop-application-menu-item desktop-help-menu-trigger";
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");
  trigger.textContent = label;

  const popover = targetDocument.createElement("div");
  popover.className = "desktop-help-menu-popover";
  popover.setAttribute("role", "menu");
  popover.setAttribute("aria-label", menuLabel);
  popover.hidden = true;

  const close = () => {
    popover.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
  };
  const toggle = () => {
    const expanded = trigger.getAttribute("aria-expanded") === "true";
    targetDocument.dispatchEvent(new CustomEvent("desktop-menu-close-all"));
    popover.hidden = expanded;
    trigger.setAttribute("aria-expanded", String(!expanded));
  };
  const handleOutsideClick = () => close();
  const handleCloseAll = () => close();
  targetDocument.addEventListener("click", handleOutsideClick);
  targetDocument.addEventListener("desktop-menu-close-all", handleCloseAll);

  trigger.addEventListener("pointerdown", (event) => event.stopPropagation());
  trigger.addEventListener("dblclick", (event) => event.stopPropagation());
  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    toggle();
  });
  trigger.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") {
      return;
    }
    event.preventDefault();
    close();
  });

  for (const command of commands) {
    popover.append(createMenuPopoverCommand(targetDocument, command, close));
  }

  menu.append(trigger, popover);
  return menu;
}

function createMenuPopoverCommand(
  targetDocument: Document,
  command: DesktopMenuCommand,
  close: () => void,
): HTMLElement {
  const item = targetDocument.createElement("button");
  item.type = "button";
  item.className = "desktop-help-menu-item";
  item.setAttribute("role", "menuitem");
  item.setAttribute("data-desktop-menu-command", command.id);
  item.setAttribute("aria-label", menuCommandAccessibleLabel(command));
  item.title = menuCommandAccessibleLabel(command);
  item.append(
    createHelpMenuText(targetDocument, "desktop-help-menu-label", command.label),
    ...(command.shortcut ? [createHelpMenuText(targetDocument, "desktop-help-menu-shortcut", command.shortcut)] : []),
  );
  item.addEventListener("pointerdown", (event) => event.stopPropagation());
  item.addEventListener("dblclick", (event) => event.stopPropagation());
  item.addEventListener("click", (event) => {
    event.stopPropagation();
    close();
    targetDocument.dispatchEvent(new CustomEvent("desktop-menu-command", { detail: { id: command.id } }));
  });
  return item;
}

function menuCommandAccessibleLabel(command: DesktopMenuCommand): string {
  return command.shortcut ? `${command.label} (${command.shortcut})` : command.label;
}

function canMountDesktopHelpMenuIsland(menu: HTMLElement): boolean {
  return typeof window !== "undefined" && menu instanceof window.HTMLElement;
}

function createHelpMenuText(targetDocument: Document, className: string, text: string): HTMLElement {
  const node = targetDocument.createElement("span");
  node.className = className;
  node.textContent = text;
  return node;
}

export function setDesktopWindowRuntimeStatus(
  status: GatewayRuntimeStatus | null,
  targetDocument: Document = document,
): void {
  const statusElement = targetDocument.getElementById(RUNTIME_STATUS_ID);
  if (!statusElement) {
    return;
  }

  const view = resolveDesktopRuntimeStatusView(status);
  statusElement.setAttribute("data-runtime-tone", view.tone);
  statusElement.textContent = view.label;
  statusElement.setAttribute("title", view.detail);
}

export function resolveDesktopRuntimeStatusView(status: GatewayRuntimeStatus | null): DesktopRuntimeStatusView {
  if (!status) {
    return {
      tone: "ok",
      label: "Gateway: External",
      detail: "Connected to an existing Tinybot gateway",
    };
  }

  if (status.state === "running" && status.owner === "shell" && status.http_ok) {
    return {
      tone: "ok",
      label: "Gateway: Shell",
      detail: `Running on ${status.gateway_http}`,
    };
  }

  if (status.state === "running" && status.owner === "external" && status.http_ok) {
    return {
      tone: "ok",
      label: "Gateway: External",
      detail: `Connected to ${status.gateway_http}`,
    };
  }

  if (status.state === "starting") {
    return {
      tone: "pending",
      label: "Gateway: Starting",
      detail: `Starting ${status.owner === "shell" ? "shell" : "external"} gateway at ${status.gateway_http}`,
    };
  }

  return {
    tone: "warn",
    label: "Gateway: Offline",
    detail: status.last_error || `Gateway is not ready at ${status.gateway_http}`,
  };
}

function createWindowButton(
  targetDocument: Document,
  action: string,
  label: string,
  handler: () => Promise<void>,
): HTMLButtonElement {
  const button = targetDocument.createElement("button");
  button.className = `desktop-window-button desktop-window-traffic-light desktop-window-button-${action}`;
  button.type = "button";
  button.setAttribute("data-window-action", action);
  button.setAttribute("aria-label", label);
  button.title = label;
  button.addEventListener("pointerdown", (event) => event.stopPropagation());
  button.addEventListener("dblclick", (event) => event.stopPropagation());
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    void handler().catch(logWindowFrameError);
  });
  return button;
}

function ensureDesktopWindowFrameStyle(targetDocument: Document): void {
  if (targetDocument.getElementById(STYLE_ID)) {
    return;
  }

  const style = targetDocument.createElement("style");
  style.id = STYLE_ID;
  style.setAttribute("id", STYLE_ID);
  style.textContent = `
    :root {
      --desktop-window-frame-height: 38px;
      --font-sans: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      --bg: #faf9f5;
      --bg-subtle: #f5f0e8;
      --panel: #faf9f5;
      --panel-strong: #efe9de;
      --text: #141413;
      --text-muted: #6c6a64;
      --border: #e6dfd8;
      --primary: #cc785c;
      --success: #5db872;
      --warning: #d4a017;
      --danger: #c64545;
      --focus-ring: rgba(204, 120, 92, 0.28);
    }

    body.desktop-custom-frame {
      min-height: 100vh;
    }

    body.desktop-custom-frame .desktop-window-frame {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      z-index: 1400;
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: var(--desktop-window-frame-height);
      padding: 0 10px 0 14px;
      border-bottom: 1px solid var(--border, #e6dfd8);
      background: #fbfaf7;
      color: var(--text, #141413);
      user-select: none;
      -webkit-user-select: none;
    }

    body.desktop-custom-frame .desktop-application-menu {
      display: flex;
      align-items: center;
      gap: 2px;
      min-width: 0;
      overflow: visible;
    }

    body.desktop-custom-frame .desktop-help-menu {
      position: relative;
      flex: 0 0 auto;
    }

    body.desktop-custom-frame .desktop-application-menu-item {
      flex: 0 1 auto;
      max-width: 136px;
      min-width: 0;
      height: 28px;
      padding: 0 10px;
      border: 0;
      border-radius: 4px;
      overflow: hidden;
      background: transparent;
      color: var(--text, #141413);
      font: 500 13px/1 var(--font-sans, system-ui, sans-serif);
      text-overflow: ellipsis;
      white-space: nowrap;
      cursor: default;
    }

    body.desktop-custom-frame .desktop-application-menu-item:hover,
    body.desktop-custom-frame .desktop-application-menu-item:focus-visible {
      background: #f2ede7;
      outline: 0;
    }

    body.desktop-custom-frame .desktop-help-menu-popover {
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      z-index: 1410;
      display: grid;
      gap: 2px;
      width: 236px;
      border: 1px solid color-mix(in srgb, var(--border, #e6dfd8) 72%, transparent);
      border-radius: 8px;
      padding: 8px 0;
      background: rgba(255, 255, 255, 0.96);
      box-shadow: 0 18px 44px rgba(38, 30, 23, 0.14);
      backdrop-filter: blur(12px);
    }

    body.desktop-custom-frame .desktop-help-menu-popover[hidden] {
      display: none;
    }

    body.desktop-custom-frame .desktop-help-menu-item {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 16px;
      width: 100%;
      height: auto;
      min-height: 36px;
      border: 0;
      padding: 5px 16px;
      background: transparent;
      color: var(--text, #141413);
      font: 500 13px/20px var(--font-sans, system-ui, sans-serif);
      text-align: left;
      cursor: default;
    }

    body.desktop-custom-frame .desktop-help-menu-item .n-button__content {
      display: grid;
      grid-template-columns: minmax(0, 1fr) max-content;
      align-items: center;
      gap: 16px;
      width: 100%;
      min-width: 0;
      line-height: 20px;
      overflow: visible;
    }

    body.desktop-custom-frame .desktop-help-menu-item:hover,
    body.desktop-custom-frame .desktop-help-menu-item:focus-visible {
      background: #f2ede7;
      outline: 0;
    }

    body.desktop-custom-frame .desktop-help-menu-label,
    body.desktop-custom-frame .desktop-help-menu-shortcut {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      line-height: 20px;
    }

    body.desktop-custom-frame .desktop-help-menu-label {
      justify-self: start;
    }

    body.desktop-custom-frame .desktop-help-menu-shortcut {
      justify-self: end;
      color: var(--text-muted, #6c6a64);
      font-size: 12px;
    }

    body.desktop-custom-frame .desktop-window-controls {
      position: absolute;
      top: 50%;
      right: 18px;
      display: grid;
      grid-template-columns: repeat(3, 12px);
      align-items: center;
      gap: 8px;
      width: 52px;
      height: 12px;
      margin: 0;
      padding: 0;
      transform: translateY(-50%);
    }

    body.desktop-custom-frame .desktop-window-controls::before {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
      background:
        radial-gradient(circle at 6px 6px, #ff5f57 0 5px, transparent 6px),
        radial-gradient(circle at 26px 6px, #ffbd2e 0 5px, transparent 6px),
        radial-gradient(circle at 46px 6px, #28c840 0 5px, transparent 6px);
    }

    body.desktop-custom-frame .desktop-window-button {
      width: 12px !important;
      min-width: 12px !important;
      height: 12px !important;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
      padding: 0 !important;
      border: 1px solid rgba(0, 0, 0, 0.16);
      border-radius: 999px;
      color: transparent;
      font-size: 0;
      cursor: default;
      transition:
        filter 140ms ease,
        transform 140ms ease,
        box-shadow 140ms ease;
    }

    body.desktop-custom-frame .desktop-window-button .n-button__content,
    body.desktop-custom-frame .desktop-window-button .n-button__icon {
      display: none;
    }

    body.desktop-custom-frame .desktop-window-button:hover {
      filter: brightness(0.94) saturate(1.12);
      box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.08);
    }

    body.desktop-custom-frame .desktop-window-button:active {
      transform: scale(0.92);
      filter: brightness(0.88) saturate(1.08);
    }

    body.desktop-custom-frame .desktop-window-button:focus-visible {
      outline: 2px solid var(--primary, #cc785c);
      outline-offset: 3px;
    }

    body.desktop-custom-frame .desktop-window-button-close {
      background: #ff5f57;
      border-color: #e0443e;
    }

    body.desktop-custom-frame .desktop-window-button-minimize {
      background: #ffbd2e;
      border-color: #dea123;
    }

    body.desktop-custom-frame .desktop-window-button-maximize {
      background: #28c840;
      border-color: #1aab29;
    }

    body.desktop-custom-frame > .desktop-startup-shell {
      min-height: calc(100vh - var(--desktop-window-frame-height));
      padding-top: calc(var(--desktop-window-frame-height) + 12px);
    }

    body.desktop-custom-frame > .shell {
      height: calc(100vh - var(--desktop-window-frame-height) - 18px);
      margin: calc(var(--desktop-window-frame-height) + 6px) 10px 10px;
    }

    html[data-theme="dark"] body.desktop-custom-frame {
      --bg: #181715;
      --bg-subtle: #1f1e1b;
      --panel: #1f1e1b;
      --panel-strong: #252320;
      --text: #faf9f5;
      --text-muted: #a09d96;
      --border: rgba(250, 249, 245, 0.12);
      --success: #5db872;
      --warning: #e8a55a;
      --danger: #e05b5b;
      color-scheme: dark;
    }

    html[data-theme="dark"] body.desktop-custom-frame .desktop-window-frame {
      border-bottom-color: var(--border, rgba(250, 249, 245, 0.12));
      background: var(--bg, #181715);
      color: var(--text, #faf9f5);
    }

    html[data-theme="dark"] body.desktop-custom-frame .desktop-application-menu-item,
    html[data-theme="dark"] body.desktop-custom-frame .desktop-help-menu-item {
      color: var(--text, #faf9f5);
    }

    html[data-theme="dark"] body.desktop-custom-frame .desktop-application-menu-item:hover,
    html[data-theme="dark"] body.desktop-custom-frame .desktop-application-menu-item:focus-visible,
    html[data-theme="dark"] body.desktop-custom-frame .desktop-help-menu-item:hover,
    html[data-theme="dark"] body.desktop-custom-frame .desktop-help-menu-item:focus-visible {
      background: rgba(250, 249, 245, 0.08);
    }

    html[data-theme="dark"] body.desktop-custom-frame .desktop-help-menu-popover {
      border-color: var(--border, rgba(250, 249, 245, 0.12));
      background: rgba(31, 30, 27, 0.96);
      box-shadow: 0 18px 44px rgba(0, 0, 0, 0.38);
    }

    html[data-theme="dark"] body.desktop-custom-frame .desktop-help-menu-shortcut {
      color: var(--text-muted, #a09d96);
    }

    @media (max-width: 760px) {
      body.desktop-custom-frame .desktop-window-frame {
        padding: 0 12px;
      }

      body.desktop-custom-frame .desktop-application-menu {
        display: none;
      }

      body.desktop-custom-frame .desktop-window-controls {
        right: 12px;
      }
    }

    @media (max-width: 1100px) {
      body.desktop-custom-frame > .shell {
        min-height: calc(100vh - var(--desktop-window-frame-height) - 18px);
      }
    }
  `;
  targetDocument.head.append(style);
}

function logWindowFrameError(error: unknown): void {
  console.warn("Tinybot desktop window frame action failed", error);
}
