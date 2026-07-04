import {
  DESKTOP_CHROME_COMMANDS,
  DESKTOP_HELP_COMMANDS,
  DESKTOP_RESOURCE_COMMANDS,
  DESKTOP_SYSTEM_COMMANDS,
  type DesktopMenuCommand,
} from "../command/desktopCommandNavigation";
import type { GatewayRuntimeStatus } from "../gateway/desktopGatewayStartup";
import { mountDesktopHelpMenuIsland } from "../components/shell/desktopHelpMenuIsland";

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

  frame.append(appMenu);
  if (shouldRenderFramePanelControls(targetDocument)) {
    frame.append(createFramePanelControls(targetDocument));
  }
  frame.append(controls);
  frame.addEventListener("pointerdown", () => {
    void currentWindow.startDragging().catch(logWindowFrameError);
  });
  frame.addEventListener("dblclick", () => {
    void currentWindow.toggleMaximize().catch(logWindowFrameError);
  });

  targetDocument.body.prepend(frame);
}

function shouldRenderFramePanelControls(targetDocument: Document): boolean {
  return targetDocument.documentElement.dataset.desktopWorkbenchMode === "native-workbench"
    || Boolean(targetDocument.getElementById("desktop-workbench-shell"));
}

function createFramePanelControls(targetDocument: Document): HTMLElement {
  const controls = targetDocument.createElement("div");
  controls.className = "desktop-frame-panel-controls";
  controls.setAttribute("aria-label", "Global workbench panel controls");
  controls.append(
    createFramePanelControl(targetDocument, "sidebar", framePanelVisible(targetDocument, "sidebar", true), "Collapse session list", "Expand session list"),
    createFramePanelControl(targetDocument, "inspector", framePanelVisible(targetDocument, "inspector", false), "Close Activity inspector", "Open Activity inspector"),
  );
  return controls;
}

function framePanelVisible(targetDocument: Document, panel: "sidebar" | "inspector", fallback: boolean): boolean {
  const shell = targetDocument.getElementById("desktop-workbench-shell");
  const value = shell?.getAttribute(`data-${panel}-visible`);
  return value === null || value === undefined ? fallback : value !== "false";
}

function createFramePanelControl(
  targetDocument: Document,
  panel: "sidebar" | "inspector",
  visible: boolean,
  pressedLabel: string,
  unpressedLabel: string,
): HTMLElement {
  const button = targetDocument.createElement("button");
  button.type = "button";
  button.className = "desktop-frame-panel-control";
  button.setAttribute("data-desktop-panel-control", panel);
  button.setAttribute("data-desktop-panel-label-pressed", pressedLabel);
  button.setAttribute("data-desktop-panel-label-unpressed", unpressedLabel);
  button.setAttribute("aria-label", visible ? pressedLabel : unpressedLabel);
  button.setAttribute("title", visible ? pressedLabel : unpressedLabel);
  button.setAttribute("aria-pressed", String(visible));
  button.append(createFramePanelIcon(targetDocument, panel));
  button.addEventListener("pointerdown", (event) => event.stopPropagation());
  button.addEventListener("dblclick", (event) => event.stopPropagation());
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    dispatchFramePanelToggle(targetDocument, panel);
  });
  return button;
}

function createFramePanelIcon(targetDocument: Document, panel: "sidebar" | "inspector"): HTMLElement {
  const icon = targetDocument.createElement("span");
  icon.className = "desktop-frame-panel-icon";
  icon.setAttribute("data-panel-icon", panel === "sidebar" ? "collapse-left" : "collapse-right");
  icon.setAttribute("aria-hidden", "true");
  icon.append(
    createFramePanelIconPart(targetDocument, "frame"),
    createFramePanelIconPart(targetDocument, "rail"),
  );
  return icon;
}

function createFramePanelIconPart(targetDocument: Document, part: "frame" | "rail"): HTMLElement {
  const node = targetDocument.createElement("span");
  node.className = `desktop-frame-panel-icon-${part}`;
  return node;
}

function dispatchFramePanelToggle(targetDocument: Document, panel: "sidebar" | "inspector"): void {
  const CustomEventConstructor = targetDocument.defaultView?.CustomEvent
    ?? (typeof CustomEvent !== "undefined" ? CustomEvent : null);
  if (CustomEventConstructor) {
    targetDocument.dispatchEvent(new CustomEventConstructor("tinybot:desktop-panel-toggle", { detail: { panel } }));
    return;
  }
  targetDocument.dispatchEvent({ type: "tinybot:desktop-panel-toggle", detail: { panel } } as unknown as Event);
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
  trigger.setAttribute("aria-label", label);
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");
  trigger.title = label;
  trigger.append(
    createApplicationMenuIcon(targetDocument, label),
    createApplicationMenuLabel(targetDocument, label),
  );

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

function createApplicationMenuIcon(targetDocument: Document, label: string): HTMLElement {
  const icon = targetDocument.createElement("span");
  icon.className = "desktop-application-menu-icon";
  icon.setAttribute("data-desktop-menu-icon", applicationMenuIcon(label));
  icon.setAttribute("aria-hidden", "true");
  return icon;
}

function createApplicationMenuLabel(targetDocument: Document, label: string): HTMLElement {
  const node = targetDocument.createElement("span");
  node.className = "desktop-application-menu-label";
  node.textContent = label;
  return node;
}

function applicationMenuIcon(label: string): string {
  switch (label.toLowerCase()) {
    case "app":
      return "app";
    case "resources":
      return "resources";
    case "system":
      return "system";
    case "help":
      return "help";
    default:
      return "menu";
  }
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
      gap: 4px;
      margin-left: 78px;
      min-width: 0;
      overflow: visible;
    }

    body.desktop-custom-frame .desktop-help-menu {
      position: relative;
      display: flex;
      align-items: center;
      flex: 0 0 auto;
    }

    body.desktop-custom-frame .desktop-application-menu-item {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
      box-sizing: border-box;
      max-width: 160px;
      min-width: 32px;
      height: 30px;
      padding: 0 8px;
      border: 1px solid transparent;
      border-radius: 999px;
      overflow: hidden;
      background: transparent;
      color: var(--text, #141413);
      font: 500 13px/1 var(--font-sans, system-ui, sans-serif);
      text-overflow: ellipsis;
      white-space: nowrap;
      cursor: default;
      transition:
        background-color 180ms ease,
        border-color 180ms ease,
        color 180ms ease;
    }

    body.desktop-custom-frame .desktop-application-menu-item .n-button__content {
      display: inline-flex;
      align-items: center;
      min-width: 0;
      overflow: visible;
      line-height: 1;
    }

    body.desktop-custom-frame .desktop-application-menu-icon {
      position: relative;
      display: inline-block;
      flex: 0 0 16px;
      width: 16px;
      height: 16px;
      color: var(--text-muted, #6c6a64);
      transition: color 180ms ease;
    }

    body.desktop-custom-frame .desktop-application-menu-icon::before,
    body.desktop-custom-frame .desktop-application-menu-icon::after {
      content: "";
      position: absolute;
      box-sizing: border-box;
    }

    body.desktop-custom-frame .desktop-application-menu-icon[data-desktop-menu-icon="app"]::before {
      top: 2px;
      left: 2px;
      width: 4px;
      height: 4px;
      border-radius: 1.5px;
      background: currentColor;
      box-shadow:
        8px 0 0 currentColor,
        0 8px 0 currentColor,
        8px 8px 0 currentColor;
    }

    body.desktop-custom-frame .desktop-application-menu-icon[data-desktop-menu-icon="resources"]::before {
      left: 2px;
      top: 5px;
      width: 12px;
      height: 9px;
      border: 1.5px solid currentColor;
      border-radius: 3px;
    }

    body.desktop-custom-frame .desktop-application-menu-icon[data-desktop-menu-icon="resources"]::after {
      left: 4px;
      top: 2px;
      width: 6px;
      height: 4px;
      border: 1.5px solid currentColor;
      border-bottom: 0;
      border-radius: 3px 3px 0 0;
    }

    body.desktop-custom-frame .desktop-application-menu-icon[data-desktop-menu-icon="system"]::before {
      inset: 3px;
      border: 1.6px solid currentColor;
      border-radius: 999px;
    }

    body.desktop-custom-frame .desktop-application-menu-icon[data-desktop-menu-icon="system"]::after {
      inset: 6px;
      border-radius: 999px;
      background: currentColor;
      box-shadow:
        0 -6px 0 -1px currentColor,
        0 6px 0 -1px currentColor,
        -6px 0 0 -1px currentColor,
        6px 0 0 -1px currentColor;
    }

    body.desktop-custom-frame .desktop-application-menu-icon[data-desktop-menu-icon="help"]::before {
      inset: 1px;
      border: 1.5px solid currentColor;
      border-radius: 999px;
    }

    body.desktop-custom-frame .desktop-application-menu-icon[data-desktop-menu-icon="help"]::after {
      content: "?";
      inset: 0;
      color: currentColor;
      font: 700 11px/16px var(--font-sans, system-ui, sans-serif);
      text-align: center;
    }

    body.desktop-custom-frame .desktop-application-menu-label {
      display: inline-block;
      max-width: 0;
      margin-left: 0;
      overflow: hidden;
      opacity: 0;
      text-overflow: clip;
      white-space: nowrap;
      transition:
        max-width 220ms ease,
        margin-left 220ms ease,
        opacity 160ms ease;
    }

    body.desktop-custom-frame .desktop-application-menu-item:hover,
    body.desktop-custom-frame .desktop-application-menu-item:focus-visible {
      background: #f2ede7;
      outline: 0;
    }

    body.desktop-custom-frame .desktop-application-menu-item:hover .desktop-application-menu-label,
    body.desktop-custom-frame .desktop-application-menu-item:focus-visible .desktop-application-menu-label,
    body.desktop-custom-frame .desktop-application-menu-item[aria-expanded="true"] .desktop-application-menu-label {
      max-width: 96px;
      margin-left: 8px;
      opacity: 1;
    }

    body.desktop-custom-frame .desktop-application-menu-item[aria-expanded="true"] {
      border-color: color-mix(in srgb, var(--border, #e6dfd8) 82%, var(--primary, #cc785c));
      background: var(--panel-strong, #efe9de);
      color: var(--text, #141413);
    }

    body.desktop-custom-frame .desktop-application-menu-item:hover .desktop-application-menu-icon,
    body.desktop-custom-frame .desktop-application-menu-item:focus-visible .desktop-application-menu-icon,
    body.desktop-custom-frame .desktop-application-menu-item[aria-expanded="true"] .desktop-application-menu-icon {
      color: var(--primary, #cc785c);
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

    body.desktop-custom-frame .desktop-frame-panel-controls {
      position: absolute;
      top: 50%;
      right: 12px;
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 6px;
      min-width: 0;
      transform: translateY(-50%);
    }

    body.desktop-custom-frame .desktop-frame-panel-control {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 30px;
      min-width: 30px;
      height: 28px;
      min-height: 28px;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: 6px;
      padding: 0;
      background: #ffffff;
      color: #59544f;
      cursor: default;
    }

    body.desktop-custom-frame .desktop-frame-panel-control:hover,
    body.desktop-custom-frame .desktop-frame-panel-control:focus-visible {
      background: #f2ede7;
      outline: 0;
    }

    body.desktop-custom-frame .desktop-frame-panel-icon {
      position: relative;
      display: block;
      width: 17px;
      height: 17px;
      color: currentColor;
    }

    body.desktop-custom-frame .desktop-frame-panel-icon-frame {
      position: absolute;
      inset: 2px;
      border: 1.5px solid currentColor;
      border-radius: 4px;
    }

    body.desktop-custom-frame .desktop-frame-panel-icon-rail {
      position: absolute;
      top: 5px;
      bottom: 5px;
      width: 3px;
      border-radius: 2px;
      background: currentColor;
    }

    body.desktop-custom-frame .desktop-frame-panel-icon[data-panel-icon="collapse-left"] .desktop-frame-panel-icon-rail {
      left: 5px;
    }

    body.desktop-custom-frame .desktop-frame-panel-icon[data-panel-icon="collapse-right"] .desktop-frame-panel-icon-rail {
      right: 5px;
    }

    body.desktop-custom-frame .desktop-window-controls {
      position: absolute;
      top: 50%;
      left: 18px;
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

    html[data-theme="dark"] body.desktop-custom-frame .desktop-application-menu-item[aria-expanded="true"] {
      border-color: rgba(204, 120, 92, 0.28);
      background: var(--panel-strong, #252320);
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
        left: 12px;
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
