import { DESKTOP_MENU_COMMANDS } from "./desktopCommandNavigation";
import type { GatewayRuntimeStatus } from "./desktopGatewayStartup";

export interface DesktopWindowHandle {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  startDragging(): Promise<void>;
}

interface InstallDesktopWindowFrameOptions {
  targetDocument?: Document;
  currentWindow: DesktopWindowHandle;
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
}: InstallDesktopWindowFrameOptions): void {
  ensureDesktopWindowFrameStyle(targetDocument);
  targetDocument.body.classList.add("desktop-custom-frame");

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

  const title = targetDocument.createElement("div");
  title.className = "desktop-window-title";
  title.setAttribute("data-tauri-drag-region", "");
  title.textContent = "Tinybot";

  const appMenu = createApplicationMenu(targetDocument);

  const runtimeStatus = targetDocument.createElement("div");
  runtimeStatus.id = RUNTIME_STATUS_ID;
  runtimeStatus.setAttribute("id", RUNTIME_STATUS_ID);
  runtimeStatus.className = "desktop-runtime-status";
  runtimeStatus.setAttribute("data-tauri-drag-region", "");
  runtimeStatus.setAttribute("aria-live", "polite");
  runtimeStatus.setAttribute("data-runtime-tone", "pending");
  runtimeStatus.textContent = "Gateway: Starting";
  runtimeStatus.setAttribute("title", "Waiting for Tinybot gateway readiness");

  const controls = targetDocument.createElement("div");
  controls.className = "desktop-window-controls";

  controls.append(
    createWindowButton(targetDocument, "minimize", "Minimize", "−", () => currentWindow.minimize()),
    createWindowButton(targetDocument, "maximize", "Maximize", "□", () => currentWindow.toggleMaximize()),
    createWindowButton(targetDocument, "close", "Close", "×", () => currentWindow.close()),
  );

  frame.append(title, appMenu, runtimeStatus, controls);
  frame.addEventListener("pointerdown", () => {
    void currentWindow.startDragging().catch(logWindowFrameError);
  });
  frame.addEventListener("dblclick", () => {
    void currentWindow.toggleMaximize().catch(logWindowFrameError);
  });

  targetDocument.body.prepend(frame);
}

function createApplicationMenu(targetDocument: Document): HTMLElement {
  const menu = targetDocument.createElement("nav");
  menu.className = "desktop-application-menu";
  menu.setAttribute("aria-label", "Desktop application menu");

  for (const command of DESKTOP_MENU_COMMANDS) {
    const button = targetDocument.createElement("button");
    button.type = "button";
    button.className = "desktop-application-menu-item";
    button.setAttribute("data-desktop-menu-command", command.id);
    button.textContent = command.label;
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
      --desktop-window-frame-height: 34px;
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
      padding: 0 6px 0 14px;
      border-bottom: 1px solid var(--border, #dedbd3);
      background: color-mix(in srgb, var(--panel-strong, #ffffff) 92%, var(--bg-subtle, #f6f4ef));
      color: var(--text, #24211d);
      user-select: none;
      -webkit-user-select: none;
    }

    body.desktop-custom-frame .desktop-window-title {
      min-width: 0;
      overflow: hidden;
      color: var(--text-muted, #6f685d);
      font-size: 12px;
      font-weight: 600;
      line-height: 1;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    body.desktop-custom-frame .desktop-application-menu {
      display: flex;
      align-items: center;
      gap: 2px;
      min-width: 0;
      margin-left: 12px;
      overflow: hidden;
    }

    body.desktop-custom-frame .desktop-application-menu-item {
      flex: 0 1 auto;
      max-width: 130px;
      min-width: 0;
      height: 26px;
      padding: 0 8px;
      border: 0;
      border-radius: 4px;
      overflow: hidden;
      background: transparent;
      color: var(--text, #24211d);
      font: 600 11px/1 var(--font-sans, system-ui, sans-serif);
      text-overflow: ellipsis;
      white-space: nowrap;
      cursor: default;
    }

    body.desktop-custom-frame .desktop-application-menu-item:hover,
    body.desktop-custom-frame .desktop-application-menu-item:focus-visible {
      background: color-mix(in srgb, var(--text, #24211d) 10%, transparent);
      outline: none;
    }

    body.desktop-custom-frame .desktop-runtime-status {
      min-width: 0;
      max-width: min(38vw, 340px);
      overflow: hidden;
      margin-left: 14px;
      padding: 4px 9px;
      border: 1px solid color-mix(in srgb, var(--border, #dedbd3) 88%, transparent);
      border-radius: 999px;
      color: var(--text-muted, #6f685d);
      font-size: 11px;
      font-weight: 600;
      line-height: 1;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    body.desktop-custom-frame .desktop-runtime-status[data-runtime-tone="ok"] {
      border-color: color-mix(in srgb, #1f8f4d 40%, var(--border, #dedbd3));
      color: #1f6f3f;
    }

    body.desktop-custom-frame .desktop-runtime-status[data-runtime-tone="pending"] {
      border-color: color-mix(in srgb, #9a6a00 38%, var(--border, #dedbd3));
      color: #7a5600;
    }

    body.desktop-custom-frame .desktop-runtime-status[data-runtime-tone="warn"] {
      border-color: color-mix(in srgb, #b42318 40%, var(--border, #dedbd3));
      color: #9b1c14;
    }

    body.desktop-custom-frame .desktop-window-controls {
      display: flex;
      align-items: center;
      align-self: stretch;
      gap: 2px;
    }

    body.desktop-custom-frame .desktop-window-button {
      width: 38px;
      height: 28px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 0;
      border-radius: 4px;
      background: transparent;
      color: var(--text, #24211d);
      font: 16px/1 var(--font-sans, system-ui, sans-serif);
      cursor: default;
    }

    body.desktop-custom-frame .desktop-window-button:hover {
      background: color-mix(in srgb, var(--text, #24211d) 10%, transparent);
    }

    body.desktop-custom-frame .desktop-window-button-close:hover {
      background: #c42b1c;
      color: #ffffff;
    }

    body.desktop-custom-frame > .desktop-startup-shell {
      min-height: calc(100vh - var(--desktop-window-frame-height));
      padding-top: calc(var(--desktop-window-frame-height) + 24px);
    }

    body.desktop-custom-frame > .shell {
      height: calc(100vh - var(--desktop-window-frame-height) - 32px);
      margin: calc(var(--desktop-window-frame-height) + 16px) 16px 16px;
    }

    @media (max-width: 1100px) {
      body.desktop-custom-frame > .shell {
        min-height: calc(100vh - var(--desktop-window-frame-height) - 32px);
      }
    }
  `;
  targetDocument.head.append(style);
}

function logWindowFrameError(error: unknown): void {
  console.warn("Tinybot desktop window frame action failed", error);
}
