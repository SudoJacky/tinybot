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
const STYLE_ID = "desktop-window-frame-style";

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

  const controls = targetDocument.createElement("div");
  controls.className = "desktop-window-controls";

  controls.append(
    createWindowButton(targetDocument, "minimize", "Minimize", "−", () => currentWindow.minimize()),
    createWindowButton(targetDocument, "maximize", "Maximize", "□", () => currentWindow.toggleMaximize()),
    createWindowButton(targetDocument, "close", "Close", "×", () => currentWindow.close()),
  );

  frame.append(title, controls);
  frame.addEventListener("pointerdown", () => {
    void currentWindow.startDragging().catch(logWindowFrameError);
  });
  frame.addEventListener("dblclick", () => {
    void currentWindow.toggleMaximize().catch(logWindowFrameError);
  });

  targetDocument.body.prepend(frame);
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
