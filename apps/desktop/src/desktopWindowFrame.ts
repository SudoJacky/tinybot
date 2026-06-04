import { DESKTOP_CHROME_COMMANDS } from "./desktopCommandNavigation";
import type { GatewayRuntimeStatus } from "./desktopGatewayStartup";

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
const CONTEXT_ID = "desktop-window-context";
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
    setDesktopWindowContext(targetDocument);
    return;
  }

  const frame = targetDocument.createElement("div");
  frame.id = FRAME_ID;
  frame.setAttribute("id", FRAME_ID);
  frame.className = "desktop-window-frame";
  frame.setAttribute("data-tauri-drag-region", "");
  frame.setAttribute("role", "banner");
  frame.setAttribute("aria-label", "Tinybot desktop window controls");

  const title = targetDocument.createElement("div");
  title.className = "desktop-window-title";
  title.setAttribute("data-tauri-drag-region", "");
  title.textContent = "Tinybot";

  const context = targetDocument.createElement("div");
  context.id = CONTEXT_ID;
  context.setAttribute("id", CONTEXT_ID);
  context.className = "desktop-window-context";
  context.setAttribute("data-tauri-drag-region", "");
  context.textContent = resolveDesktopWindowContextLabel(targetDocument);

  const titleGroup = targetDocument.createElement("div");
  titleGroup.className = "desktop-window-title-group";
  titleGroup.setAttribute("data-tauri-drag-region", "");
  titleGroup.append(title, context);

  const appMenu = createApplicationMenu(targetDocument);

  const runtimeStatus = targetDocument.createElement("div");
  runtimeStatus.id = RUNTIME_STATUS_ID;
  runtimeStatus.setAttribute("id", RUNTIME_STATUS_ID);
  runtimeStatus.className = "desktop-runtime-status";
  runtimeStatus.setAttribute("role", "button");
  runtimeStatus.setAttribute("tabindex", "0");
  runtimeStatus.setAttribute("data-desktop-runtime-command", "refresh-gateway-status");
  runtimeStatus.setAttribute("aria-live", "polite");
  runtimeStatus.setAttribute("data-runtime-tone", "pending");
  runtimeStatus.textContent = "Gateway: Starting";
  runtimeStatus.setAttribute("title", "Waiting for Tinybot gateway readiness");
  runtimeStatus.addEventListener("pointerdown", (event) => event.stopPropagation());
  runtimeStatus.addEventListener("dblclick", (event) => event.stopPropagation());
  runtimeStatus.addEventListener("click", (event) => {
    event.stopPropagation();
    targetDocument.dispatchEvent(new CustomEvent("desktop-menu-command", { detail: { id: "refresh-gateway-status" } }));
  });
  runtimeStatus.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    targetDocument.dispatchEvent(new CustomEvent("desktop-menu-command", { detail: { id: "refresh-gateway-status" } }));
  });

  const controls = targetDocument.createElement("div");
  controls.className = "desktop-window-controls";

  controls.append(
    createWindowButton(targetDocument, "minimize", "Minimize", "−", () => currentWindow.minimize()),
    createWindowButton(targetDocument, "maximize", "Maximize", "□", () => currentWindow.toggleMaximize()),
    createWindowButton(targetDocument, "close", "Close", "×", () => currentWindow.close()),
  );

  frame.append(titleGroup, appMenu, runtimeStatus, controls);
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

function setDesktopWindowContext(targetDocument: Document): void {
  const context = targetDocument.getElementById(CONTEXT_ID);
  if (context) {
    context.textContent = resolveDesktopWindowContextLabel(targetDocument);
  }
}

function resolveDesktopWindowContextLabel(targetDocument: Document): string {
  const mode = targetDocument.documentElement?.dataset?.desktopWorkbenchMode;
  if (mode === "native-workbench") {
    return "Native workbench";
  }
  if (mode === "root-webui") {
    return "WebUI shell";
  }
  return "Starting";
}

function createApplicationMenu(targetDocument: Document): HTMLElement {
  const menu = targetDocument.createElement("nav");
  menu.className = "desktop-application-menu";
  menu.setAttribute("aria-label", "Desktop application menu");

  for (const command of DESKTOP_CHROME_COMMANDS) {
    const button = targetDocument.createElement("button");
    button.type = "button";
    button.className = "desktop-application-menu-item";
    button.setAttribute("data-desktop-menu-command", command.id);
    button.setAttribute("aria-label", `${command.label} (${command.shortcut})`);
    button.title = `${command.label} (${command.shortcut})`;
    button.textContent = command.chromeLabel ?? command.label;
    button.addEventListener("pointerdown", (event) => event.stopPropagation());
    button.addEventListener("dblclick", (event) => event.stopPropagation());
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      targetDocument.dispatchEvent(new CustomEvent("desktop-menu-command", { detail: { id: command.id } }));
    });
    menu.append(button);
  }

  return menu;
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
  statusElement.textContent = view.label;
  statusElement.setAttribute("title", view.detail);
  statusElement.setAttribute("data-runtime-tone", view.tone);
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
  text: string,
  handler: () => Promise<void>,
): HTMLButtonElement {
  const button = targetDocument.createElement("button");
  button.className = `desktop-window-button desktop-window-button-${action}`;
  button.type = "button";
  button.setAttribute("data-window-action", action);
  button.setAttribute("aria-label", label);
  button.title = label;
  button.textContent = text;
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
      --desktop-window-frame-height: 48px;
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
      padding: 0 12px 0 16px;
      border-bottom: 1px solid var(--border, #e6dfd8);
      background: #fbfaf7;
      color: var(--text, #141413);
      user-select: none;
      -webkit-user-select: none;
    }

    body.desktop-custom-frame .desktop-window-title-group {
      display: grid;
      grid-template-columns: auto auto;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }

    body.desktop-custom-frame .desktop-window-title,
    body.desktop-custom-frame .desktop-window-context {
      min-width: 0;
      overflow: hidden;
      font-size: 12px;
      line-height: 1;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    body.desktop-custom-frame .desktop-window-title {
      color: var(--text, #141413);
      font-size: 16px;
      font-weight: 750;
    }

    body.desktop-custom-frame .desktop-window-context {
      color: var(--text-muted, #6c6a64);
      font-weight: 500;
    }

    body.desktop-custom-frame .desktop-window-context::before {
      content: "/";
      padding-right: 8px;
      color: var(--text-muted, #6c6a64);
    }

    body.desktop-custom-frame .desktop-application-menu {
      display: flex;
      align-items: center;
      gap: 2px;
      min-width: 0;
      margin-left: 18px;
      overflow: hidden;
    }

    body.desktop-custom-frame .desktop-application-menu-item {
      flex: 0 1 auto;
      max-width: 136px;
      min-width: 0;
      height: 30px;
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
      background: color-mix(in srgb, var(--primary, #cc785c) 12%, transparent);
      outline: 2px solid var(--primary, #cc785c);
      outline-offset: 1px;
    }

    body.desktop-custom-frame .desktop-runtime-status {
      min-width: 0;
      max-width: min(38vw, 340px);
      overflow: hidden;
      margin-left: auto;
      padding: 6px 12px;
      border: 1px solid color-mix(in srgb, var(--border, #e6dfd8) 88%, transparent);
      border-radius: 999px;
      color: var(--text-muted, #6c6a64);
      font-size: 12px;
      font-weight: 600;
      line-height: 1;
      text-overflow: ellipsis;
      white-space: nowrap;
      cursor: default;
    }

    body.desktop-custom-frame .desktop-runtime-status::before {
      content: "";
      display: inline-block;
      width: 9px;
      height: 9px;
      margin-right: 9px;
      border-radius: 999px;
      background: currentColor;
      vertical-align: -1px;
    }

    body.desktop-custom-frame .desktop-runtime-status:focus-visible {
      outline: 2px solid var(--primary, #cc785c);
      outline-offset: 1px;
      box-shadow: 0 0 0 4px var(--focus-ring, rgba(204, 120, 92, 0.28));
    }

    body.desktop-custom-frame .desktop-runtime-status[data-runtime-tone="ok"] {
      border-color: color-mix(in srgb, var(--success, #5db872) 44%, var(--border, #e6dfd8));
      color: #2f7b45;
    }

    body.desktop-custom-frame .desktop-runtime-status[data-runtime-tone="pending"] {
      border-color: color-mix(in srgb, var(--warning, #d4a017) 44%, var(--border, #e6dfd8));
      color: #7c5a09;
    }

    body.desktop-custom-frame .desktop-runtime-status[data-runtime-tone="warn"] {
      border-color: color-mix(in srgb, var(--danger, #c64545) 44%, var(--border, #e6dfd8));
      color: #9a3030;
    }

    body.desktop-custom-frame .desktop-window-controls {
      display: flex;
      align-items: center;
      align-self: stretch;
      gap: 4px;
      margin-left: 12px;
    }

    body.desktop-custom-frame .desktop-window-button {
      width: 30px;
      height: 30px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 0;
      border-radius: 4px;
      background: transparent;
      color: var(--text, #141413);
      font: 16px/1 var(--font-sans, system-ui, sans-serif);
      cursor: default;
    }

    body.desktop-custom-frame .desktop-window-button:hover {
      background: color-mix(in srgb, var(--primary, #cc785c) 12%, transparent);
    }

    body.desktop-custom-frame .desktop-window-button-close:hover {
      background: #c42b1c;
      color: #ffffff;
    }

    body.desktop-custom-frame > .desktop-startup-shell {
      min-height: calc(100vh - var(--desktop-window-frame-height));
      padding-top: calc(var(--desktop-window-frame-height) + 16px);
    }

    body.desktop-custom-frame > .shell {
      height: calc(100vh - var(--desktop-window-frame-height) - 18px);
      margin: calc(var(--desktop-window-frame-height) + 8px) 10px 10px;
    }

    @media (max-width: 760px) {
      body.desktop-custom-frame .desktop-window-frame {
        padding: 0 12px;
      }

      body.desktop-custom-frame .desktop-window-title,
      body.desktop-custom-frame .desktop-window-context,
      body.desktop-custom-frame .desktop-application-menu {
        display: none;
      }

      body.desktop-custom-frame .desktop-runtime-status {
        max-width: 92px;
        margin-left: auto;
        padding: 6px 9px;
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
