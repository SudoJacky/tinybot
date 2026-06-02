const STYLE_ID = "desktop-composer-surface-style";

const WORKSPACE_RUNTIME_PATTERNS = [
  /provider/i,
  /model/i,
  /websocket/i,
  /token/i,
  /rag/i,
  /用量/,
] as const;

const TASK_STATUS_PATTERNS: Array<[RegExp, string]> = [
  [/background|task/i, "background-tasks"],
  [/approval/i, "approvals"],
  [/cowork/i, "cowork"],
  [/upload/i, "uploads"],
];

export function installRootWebUiComposerRuntime(targetDocument: Document): void {
  const composer = targetDocument.getElementById("composer-form");
  if (!composer || composer.getAttribute("data-desktop-composer") === "true") {
    return;
  }

  composer.setAttribute("data-desktop-composer", "true");
  composer.classList.add("desktop-composer-surface");
  composer.classList.add("desktop-composer-runtime");

  const composerRow = targetDocument.body.querySelector<HTMLElement>(".composer-row");
  composerRow?.setAttribute("data-workbench-region", "message-entry");
  composerRow?.setAttribute("data-desktop-composer-region", "controls");
  targetDocument.getElementById("temporary-file-button")?.setAttribute("data-desktop-drop-target", "session-temporary-file");
  targetDocument.getElementById("send-button")?.setAttribute("data-desktop-composer-action", "send");
  targetDocument.getElementById("stop-generation-button")?.setAttribute("data-desktop-composer-action", "stop");

  const statusPanel = targetDocument.body.querySelector<HTMLElement>(".composer-status-panel");
  statusPanel?.setAttribute("data-desktop-composer-region", "runtime-status");

  const feedback = targetDocument.createElement("p");
  feedback.id = "desktop-composer-feedback";
  feedback.setAttribute("id", "desktop-composer-feedback");
  feedback.className = "desktop-composer-feedback";
  feedback.setAttribute("aria-live", "polite");
  feedback.hidden = true;
  composerRow?.after(feedback);

  for (const item of targetDocument.body.querySelectorAll<HTMLElement>(".composer-status-panel .status-item")) {
    installStatusItem(targetDocument, item, feedback);
  }

  composer.addEventListener("submit", () => {
    const input = targetDocument.getElementById("composer-input") as HTMLTextAreaElement | null;
    if (!input?.value.trim()) {
      setComposerFeedback(feedback, "Enter a message or attach a file before sending.");
    } else {
      feedback.hidden = true;
      feedback.textContent = "";
    }
  });

  for (const eventName of ["dragenter", "dragover"]) {
    composer.addEventListener(eventName, (event) => {
      event.preventDefault();
      composer.classList.add("is-desktop-drop-hover");
      setComposerFeedback(feedback, "Drop a file to attach it to this session.");
    });
  }
  for (const eventName of ["dragleave", "drop"]) {
    composer.addEventListener(eventName, () => {
      composer.classList.remove("is-desktop-drop-hover");
    });
  }
}

export function ensureDesktopComposerSurfaceStyle(targetDocument: Document): void {
  if (targetDocument.getElementById(STYLE_ID)) {
    return;
  }

  const style = targetDocument.createElement("style");
  style.id = STYLE_ID;
  style.setAttribute("id", STYLE_ID);
  style.textContent = `
    body.desktop-root-webui-workbench .composer {
      border-top: 1px solid var(--border, #e6dfd8);
      background: color-mix(in srgb, var(--panel, #faf9f5) 92%, transparent);
    }

    body.desktop-root-webui-workbench .composer.desktop-composer-surface {
      display: grid;
      gap: 8px;
      padding: 14px 22px 12px;
    }

    body.desktop-root-webui-workbench [data-desktop-composer-region="controls"] {
      display: grid;
      grid-template-columns: 42px minmax(0, 1fr) 54px auto;
      gap: 10px;
      align-items: stretch;
      width: min(960px, 100%);
      min-width: 0;
      margin: 0 auto;
    }

    body.desktop-root-webui-workbench .composer-file,
    body.desktop-root-webui-workbench .composer-send,
    body.desktop-root-webui-workbench [data-desktop-composer-action="stop"] {
      width: auto;
      min-width: 0;
      min-height: 42px;
      border-radius: 6px;
    }

    body.desktop-root-webui-workbench [data-desktop-composer-action="stop"][hidden],
    body.desktop-root-webui-workbench [data-desktop-composer-action="stop"][aria-hidden="true"] {
      display: none;
    }

    body.desktop-root-webui-workbench .composer-input {
      min-height: 42px;
      max-height: 156px;
      border-radius: 6px;
    }

    body.desktop-root-webui-workbench .composer-meta {
      align-items: center;
      min-width: 0;
    }

    body.desktop-root-webui-workbench .composer-meta-left {
      display: flex;
      flex: 1 1 auto;
      flex-wrap: wrap;
      gap: 6px 14px;
      align-items: center;
      min-width: 0;
    }

    body.desktop-root-webui-workbench [data-desktop-composer-region="runtime-status"] {
      width: min(960px, 100%);
      min-width: 0;
      margin: 0 auto;
      border: 0;
      padding: 0;
      background: transparent;
      box-shadow: none;
    }

    body.desktop-root-webui-workbench .composer-status-panel .panel-header {
      display: none;
    }

    body.desktop-root-webui-workbench .system-status {
      display: flex !important;
      flex-wrap: wrap;
      grid-template-columns: none !important;
      gap: 6px 10px;
      align-items: center;
      min-width: 0;
    }

    body.desktop-root-webui-workbench .composer-status-panel .system-status {
      display: grid !important;
      grid-auto-flow: column;
      grid-auto-columns: max-content;
      grid-template-columns: none !important;
      justify-content: start;
      overflow: visible;
    }

    body.desktop-root-webui-workbench [data-desktop-runtime-scope="workspace"] {
      display: inline-flex;
      flex: 0 1 auto;
      align-items: center;
      gap: 5px;
      min-width: 0;
      min-height: 22px;
      width: auto !important;
      border: 0;
      border-radius: 4px;
      padding: 0;
      background: transparent;
      color: var(--text-muted, #6c6a64);
      font-size: 11px;
      line-height: 1.2;
      cursor: default;
    }

    body.desktop-root-webui-workbench .composer-status-panel .usage-item {
      grid-column: auto !important;
    }

    body.desktop-root-webui-workbench .composer-status-panel .status-label,
    body.desktop-root-webui-workbench .composer-status-panel .status-value,
    body.desktop-root-webui-workbench .composer-status-panel .usage-display {
      width: auto;
      min-width: 0;
      white-space: nowrap;
    }

    body.desktop-root-webui-workbench [data-desktop-runtime-scope="workspace"]:focus-visible {
      outline: 2px solid var(--primary, #cc785c);
      outline-offset: 2px;
    }

    body.desktop-root-webui-workbench .desktop-composer-feedback {
      width: min(960px, 100%);
      min-width: 0;
      margin: 0 auto;
      color: var(--danger, #c64545);
      font-size: 11px;
      line-height: 1.35;
    }

    body.desktop-root-webui-workbench .desktop-composer-feedback[hidden] {
      display: none;
    }

    body.desktop-root-webui-workbench .composer.is-desktop-drop-hover [data-desktop-composer-region="controls"] {
      outline: 2px solid var(--primary, #cc785c);
      outline-offset: 3px;
      border-radius: 8px;
    }

    body.desktop-root-webui-workbench .desktop-task-status-surface {
      display: grid;
      gap: 4px;
      min-width: 0;
      margin-top: 8px;
    }

    body.desktop-root-webui-workbench .desktop-task-status-surface .status-item {
      min-width: 0;
      border-left: 1px solid var(--border, #e6dfd8);
      padding-left: 8px;
      color: var(--text-muted, #6c6a64);
      font-size: 11px;
      line-height: 1.3;
    }

    @media (max-width: 980px) and (min-width: 721px) {
      body.desktop-root-webui-workbench .composer.desktop-composer-surface {
        padding: 12px 16px 10px;
      }

      body.desktop-root-webui-workbench [data-desktop-composer-region="controls"] {
        grid-template-columns: 38px minmax(0, 1fr) 48px;
        gap: 8px;
      }

      body.desktop-root-webui-workbench [data-desktop-composer-action="stop"] {
        grid-column: 2 / 3;
        min-height: 32px;
      }

      body.desktop-root-webui-workbench [data-desktop-composer-region="runtime-status"],
      body.desktop-root-webui-workbench .desktop-composer-feedback {
        width: min(960px, 100%);
      }
    }

    @media (max-width: 720px) {
      body.desktop-root-webui-workbench .composer.desktop-composer-surface {
        padding: 10px 12px 10px;
      }

      body.desktop-root-webui-workbench [data-desktop-composer-region="controls"] {
        grid-template-columns: 36px minmax(0, 1fr);
        gap: 7px;
      }

      body.desktop-root-webui-workbench [data-desktop-composer-action="send"] {
        grid-column: 2 / 3;
        min-height: 34px;
      }

      body.desktop-root-webui-workbench [data-desktop-composer-action="stop"] {
        grid-column: 2 / 3;
        min-height: 32px;
      }

      body.desktop-root-webui-workbench [data-desktop-composer-region="runtime-status"] {
        width: min(960px, 100%);
        overflow-x: auto;
      }

      body.desktop-root-webui-workbench .desktop-composer-feedback {
        width: min(960px, 100%);
      }
    }
  `;
  targetDocument.head.append(style);
}

function installStatusItem(targetDocument: Document, item: HTMLElement, feedback: HTMLElement): void {
  const name = runtimeChipName(item);
  const taskStatus = taskStatusName(name);
  if (taskStatus) {
    item.setAttribute("data-desktop-task-status", taskStatus);
    moveTaskStatusItem(targetDocument, item);
    return;
  }

  if (!isWorkspaceRuntimeStatus(name)) {
    return;
  }

  item.setAttribute("role", "button");
  item.setAttribute("tabindex", "0");
  item.setAttribute("data-desktop-runtime-chip", name);
  item.setAttribute("data-desktop-runtime-scope", "workspace");
  item.addEventListener("click", () => {
    setComposerFeedback(feedback, `${name} status selected.`);
  });
  item.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    setComposerFeedback(feedback, `${name} status selected.`);
  });
}

function moveTaskStatusItem(targetDocument: Document, item: HTMLElement): void {
  const surface = ensureDesktopTaskStatusSurface(targetDocument);
  item.parentElement?.removeChild(item);
  surface.append(item);
}

function ensureDesktopTaskStatusSurface(targetDocument: Document): HTMLElement {
  const existing = targetDocument.body.querySelector<HTMLElement>(".desktop-task-status-surface");
  if (existing) {
    return existing;
  }

  const surface = targetDocument.createElement("section");
  surface.className = "desktop-task-status-surface";
  surface.setAttribute("data-desktop-task-status-surface", "sidebar");
  surface.setAttribute("aria-label", "Desktop task status");
  const sidebar = targetDocument.body.querySelector<HTMLElement>(".sidebar");
  (sidebar ?? targetDocument.body).append(surface);
  return surface;
}

function runtimeChipName(item: HTMLElement): string {
  return item.querySelector(".status-label")?.textContent?.trim() || "Runtime";
}

function taskStatusName(name: string): string | null {
  const match = TASK_STATUS_PATTERNS.find(([pattern]) => pattern.test(name));
  return match?.[1] ?? null;
}

function isWorkspaceRuntimeStatus(name: string): boolean {
  return WORKSPACE_RUNTIME_PATTERNS.some((pattern) => pattern.test(name));
}

function setComposerFeedback(feedback: HTMLElement, message: string): void {
  feedback.hidden = false;
  feedback.textContent = message;
}
