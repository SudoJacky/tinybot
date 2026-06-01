import {
  DESKTOP_WORKBENCH_LAYOUT_STORAGE_KEY,
  loadWorkbenchLayout,
  persistWorkbenchLayout,
  toggleWorkbenchPanel,
  type WorkbenchLayoutState,
} from "./desktopWorkbenchLayout";

interface InstallDesktopRootWebUiWorkbenchOptions {
  targetDocument?: Document;
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  viewportWidth?: number;
}

const STYLE_ID = "desktop-root-webui-workbench-style";

export function installDesktopRootWebUiWorkbenchAdapter({
  targetDocument = document,
  storage = targetDocument.defaultView?.localStorage ?? null,
  viewportWidth = targetDocument.defaultView?.innerWidth ?? Number.POSITIVE_INFINITY,
}: InstallDesktopRootWebUiWorkbenchOptions = {}): void {
  ensureDesktopRootWebUiWorkbenchStyle(targetDocument);
  installRootWebUiCommandPaletteSurface(targetDocument);
  const layout = loadWorkbenchLayout({ storage, viewportWidth });
  applyRootWebUiWorkbenchLayout(targetDocument, layout);
  installRootWebUiComposerRuntime(targetDocument);
  installRootWebUiPanelPersistence(targetDocument, storage, viewportWidth);
  installEmptyStateObserver(targetDocument);
}

export function installRootWebUiComposerRuntime(targetDocument: Document): void {
  const composer = targetDocument.getElementById("composer-form");
  if (!composer || composer.getAttribute("data-desktop-composer") === "true") {
    return;
  }

  composer.setAttribute("data-desktop-composer", "true");
  composer.classList.add("desktop-composer-runtime");
  targetDocument.body.querySelector<HTMLElement>(".composer-row")?.setAttribute("data-workbench-region", "message-entry");
  targetDocument.getElementById("temporary-file-button")?.setAttribute("data-desktop-drop-target", "session-temporary-file");
  targetDocument.getElementById("send-button")?.setAttribute("data-desktop-composer-action", "send");

  const feedback = targetDocument.createElement("p");
  feedback.id = "desktop-composer-feedback";
  feedback.setAttribute("id", "desktop-composer-feedback");
  feedback.className = "desktop-composer-feedback";
  feedback.setAttribute("aria-live", "polite");
  feedback.hidden = true;
  targetDocument.body.querySelector<HTMLElement>(".composer-row")?.after(feedback);

  for (const item of targetDocument.body.querySelectorAll<HTMLElement>(".composer-status-panel .status-item")) {
    item.setAttribute("role", "button");
    item.setAttribute("tabindex", "0");
    item.setAttribute("data-desktop-runtime-chip", runtimeChipName(item));
    item.addEventListener("click", () => {
      setComposerFeedback(feedback, `${runtimeChipName(item)} status selected.`);
    });
    item.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      setComposerFeedback(feedback, `${runtimeChipName(item)} status selected.`);
    });
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

export function installRootWebUiCommandPaletteSurface(targetDocument: Document): void {
  if (targetDocument.getElementById("desktop-command-palette")) {
    return;
  }

  const palette = targetDocument.createElement("div");
  palette.id = "desktop-command-palette";
  palette.setAttribute("id", "desktop-command-palette");
  palette.className = "desktop-command-palette";
  palette.setAttribute("role", "dialog");
  palette.setAttribute("aria-modal", "true");
  palette.setAttribute("aria-label", "Command palette");
  palette.hidden = true;

  const header = targetDocument.createElement("div");
  header.className = "desktop-command-palette-header";

  const input = targetDocument.createElement("input");
  input.id = "desktop-command-palette-input";
  input.setAttribute("id", "desktop-command-palette-input");
  input.className = "desktop-command-palette-input";
  input.type = "search";
  input.setAttribute("aria-label", "Search commands and workbench data");
  input.setAttribute("placeholder", "Search commands, sessions, files, tools...");

  const close = targetDocument.createElement("button");
  close.id = "desktop-command-palette-close";
  close.setAttribute("id", "desktop-command-palette-close");
  close.className = "desktop-command-palette-close";
  close.type = "button";
  close.textContent = "Close";

  header.append(input, close);

  const status = targetDocument.createElement("p");
  status.id = "desktop-command-palette-status";
  status.setAttribute("id", "desktop-command-palette-status");
  status.className = "desktop-command-palette-status";
  status.textContent = "Type to search.";

  const results = targetDocument.createElement("div");
  results.id = "desktop-command-palette-results";
  results.setAttribute("id", "desktop-command-palette-results");
  results.className = "desktop-command-palette-results";
  results.setAttribute("aria-live", "polite");

  palette.append(header, status, results);
  targetDocument.body.append(palette);
}

export function applyRootWebUiWorkbenchLayout(targetDocument: Document, layout: WorkbenchLayoutState): void {
  const shell = targetDocument.body.querySelector<HTMLElement>(".shell");
  if (!shell) {
    return;
  }

  targetDocument.body.classList.add("desktop-root-webui-workbench");
  shell.setAttribute("data-desktop-workbench", "root-webui");
  shell.setAttribute("data-desktop-layout-storage-key", DESKTOP_WORKBENCH_LAYOUT_STORAGE_KEY);
  shell.setAttribute("data-sidebar-visible", String(layout.sidebar.visible));
  shell.setAttribute("data-inspector-visible", String(layout.inspector.visible));
  shell.setAttribute("data-bottom-visible", String(layout.bottom.visible));
  shell.style.setProperty("--desktop-sidebar-size", `${layout.sidebar.size}px`);
  shell.style.setProperty("--desktop-inspector-size", `${layout.inspector.size}px`);
  shell.style.setProperty("--desktop-bottom-size", `${layout.bottom.size}px`);

  const sidebar = targetDocument.body.querySelector<HTMLElement>(".sidebar");
  const chatPanel = targetDocument.body.querySelector<HTMLElement>(".chat-panel");
  const messageList = targetDocument.getElementById("message-list");
  const inspector = targetDocument.getElementById("inspector-panel");
  const composer = targetDocument.getElementById("composer-form");
  const statusPanel = targetDocument.body.querySelector<HTMLElement>(".composer-status-panel");

  sidebar?.setAttribute("data-workbench-region", "sidebar");
  chatPanel?.setAttribute("data-workbench-region", "main");
  messageList?.setAttribute("data-workbench-region", "conversation");
  inspector?.setAttribute("data-workbench-region", "inspector");
  composer?.setAttribute("data-workbench-region", "composer");
  statusPanel?.setAttribute("data-workbench-region", "runtime-status");

  if (!layout.sidebar.visible) {
    shell.classList.add("sidebar-collapsed");
    sidebar?.classList.add("collapsed");
  }

  if (!layout.inspector.visible) {
    shell.classList.remove("inspection-mode");
    inspector?.setAttribute("aria-hidden", "true");
  }
}

export function upgradeDesktopRootWebUiEmptyState(emptyChat: HTMLElement, targetDocument: Document): boolean {
  if (emptyChat.getAttribute("data-desktop-empty-state") === "true") {
    return false;
  }

  emptyChat.setAttribute("data-desktop-empty-state", "true");
  const modules = targetDocument.createElement("div");
  modules.className = "desktop-empty-modules";
  modules.setAttribute("aria-label", "Desktop workbench starting points");

  for (const [title, detail] of [
    ["Recent sessions", "Use Search to resume a conversation."],
    ["Files and resources", "Attach a session file or open Workspace."],
    ["Background tasks", "Check streaming, cowork, uploads, and approvals."],
    ["Gateway health", "Use the gateway chip for diagnostics."],
  ]) {
    const item = targetDocument.createElement("article");
    item.className = "desktop-empty-module";

    const heading = targetDocument.createElement("strong");
    heading.textContent = title;
    const copy = targetDocument.createElement("span");
    copy.textContent = detail;

    item.append(heading, copy);
    modules.append(item);
  }

  const actions = emptyChat.querySelector<HTMLElement>(".empty-chat-actions");
  emptyChat.insertBefore(modules, actions ?? null);
  return true;
}

export function ensureDesktopRootWebUiWorkbenchStyle(targetDocument: Document): void {
  if (targetDocument.getElementById(STYLE_ID)) {
    return;
  }

  const style = targetDocument.createElement("style");
  style.id = STYLE_ID;
  style.setAttribute("id", STYLE_ID);
  style.textContent = `
    body.desktop-root-webui-workbench > .shell {
      grid-template-columns: var(--desktop-sidebar-size, 248px) minmax(0, 1fr) minmax(0, var(--desktop-inspector-size, 360px));
      background: var(--panel, #faf9f5);
      box-shadow: none;
    }

    body.desktop-root-webui-workbench > .shell[data-inspector-visible="false"]:not(.inspection-mode) {
      grid-template-columns: var(--desktop-sidebar-size, 248px) minmax(0, 1fr) 0;
    }

    body.desktop-root-webui-workbench > .shell[data-sidebar-visible="false"],
    body.desktop-root-webui-workbench > .shell.sidebar-collapsed {
      grid-template-columns: 68px minmax(0, 1fr) 0;
    }

    body.desktop-root-webui-workbench .sidebar,
    body.desktop-root-webui-workbench .chat-panel,
    body.desktop-root-webui-workbench .inspector-panel {
      border-radius: 0;
      box-shadow: none;
    }

    body.desktop-root-webui-workbench .message-list {
      min-width: 0;
      scrollbar-gutter: stable;
    }

    body.desktop-root-webui-workbench .composer {
      border-top: 1px solid var(--border, #e6dfd8);
      background: color-mix(in srgb, var(--panel, #faf9f5) 92%, transparent);
    }

    body.desktop-root-webui-workbench .composer.desktop-composer-runtime {
      display: grid;
      gap: 8px;
      padding: 14px 22px 12px;
    }

    body.desktop-root-webui-workbench .composer-row {
      display: grid;
      grid-template-columns: 42px minmax(0, 1fr) 54px;
      gap: 10px;
      align-items: stretch;
      min-width: 0;
    }

    body.desktop-root-webui-workbench .composer-file,
    body.desktop-root-webui-workbench .composer-send {
      width: auto;
      min-width: 0;
      min-height: 42px;
      border-radius: 6px;
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

    body.desktop-root-webui-workbench .composer-status-panel {
      flex: 0 1 auto;
      min-width: 0;
      margin: 0;
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

    body.desktop-root-webui-workbench .composer-status-panel .status-item {
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

    body.desktop-root-webui-workbench .composer-status-panel .status-item:focus-visible {
      outline: 2px solid var(--primary, #cc785c);
      outline-offset: 2px;
    }

    body.desktop-root-webui-workbench .desktop-composer-feedback {
      margin: 0;
      color: var(--danger, #c64545);
      font-size: 11px;
      line-height: 1.35;
    }

    body.desktop-root-webui-workbench .desktop-composer-feedback[hidden] {
      display: none;
    }

    body.desktop-root-webui-workbench .composer.is-desktop-drop-hover .composer-row {
      outline: 2px solid var(--primary, #cc785c);
      outline-offset: 3px;
      border-radius: 8px;
    }

    body.desktop-root-webui-workbench .desktop-empty-modules {
      display: grid;
      grid-template-columns: repeat(2, minmax(180px, 1fr));
      gap: 8px;
      width: min(760px, 100%);
      margin: 12px auto 2px;
      min-width: 0;
    }

    body.desktop-root-webui-workbench .desktop-empty-module {
      display: grid;
      gap: 5px;
      min-width: 0;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: 6px;
      padding: 10px 12px;
      background: color-mix(in srgb, var(--panel-strong, #efe9de) 72%, transparent);
      text-align: left;
    }

    body.desktop-root-webui-workbench .desktop-empty-module strong,
    body.desktop-root-webui-workbench .desktop-empty-module span {
      min-width: 0;
      overflow-wrap: anywhere;
    }

    body.desktop-root-webui-workbench .desktop-empty-module strong {
      color: var(--text, #141413);
      font-size: 12px;
      line-height: 1.25;
    }

    body.desktop-root-webui-workbench .desktop-empty-module span {
      color: var(--text-muted, #6c6a64);
      font-size: 11px;
      line-height: 1.35;
    }

    body.desktop-root-webui-workbench .desktop-command-palette {
      position: fixed;
      top: calc(var(--desktop-window-frame-height, 34px) + 18px);
      left: 50%;
      z-index: 1500;
      display: grid;
      gap: 10px;
      width: min(680px, calc(100vw - 48px));
      max-height: min(620px, calc(100vh - var(--desktop-window-frame-height, 34px) - 44px));
      min-width: 0;
      overflow: hidden;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: 8px;
      padding: 12px;
      background: var(--panel, #faf9f5);
      box-shadow: 0 18px 48px rgba(20, 20, 19, 0.18);
      transform: translateX(-50%);
    }

    body.desktop-root-webui-workbench .desktop-command-palette[hidden] {
      display: none;
    }

    body.desktop-root-webui-workbench .desktop-command-palette-header {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      min-width: 0;
    }

    body.desktop-root-webui-workbench .desktop-command-palette-input {
      min-width: 0;
      min-height: 36px;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: 6px;
      padding: 0 10px;
      background: var(--panel, #faf9f5);
      color: var(--text, #141413);
      font: 13px/1.2 var(--font-sans, system-ui, sans-serif);
    }

    body.desktop-root-webui-workbench .desktop-command-palette-close {
      min-height: 36px;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: 6px;
      padding: 0 10px;
      background: var(--panel-strong, #efe9de);
      color: var(--text, #141413);
      font: 600 12px/1.2 var(--font-sans, system-ui, sans-serif);
    }

    body.desktop-root-webui-workbench .desktop-command-palette-status {
      margin: 0;
      overflow: hidden;
      color: var(--text-muted, #6c6a64);
      font-size: 11px;
      line-height: 1.35;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    body.desktop-root-webui-workbench .desktop-command-palette-results {
      display: grid;
      gap: 6px;
      max-height: min(430px, 58vh);
      min-width: 0;
      overflow: auto;
    }

    body.desktop-root-webui-workbench .desktop-command-palette-result {
      display: grid;
      gap: 3px;
      min-width: 0;
      min-height: 42px;
      border: 1px solid var(--border, #e6dfd8);
      border-radius: 6px;
      padding: 7px 9px;
      background: var(--panel, #faf9f5);
      color: var(--text, #141413);
      text-align: left;
    }

    body.desktop-root-webui-workbench .desktop-command-palette-result[aria-selected="true"],
    body.desktop-root-webui-workbench .desktop-command-palette-result:focus-visible,
    body.desktop-root-webui-workbench .desktop-command-palette-input:focus-visible,
    body.desktop-root-webui-workbench .desktop-command-palette-close:focus-visible {
      outline: 2px solid var(--primary, #cc785c);
      outline-offset: 2px;
    }

    body.desktop-root-webui-workbench .desktop-command-palette-result strong,
    body.desktop-root-webui-workbench .desktop-command-palette-result span,
    body.desktop-root-webui-workbench .desktop-command-palette-empty {
      min-width: 0;
      margin: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    body.desktop-root-webui-workbench .desktop-command-palette-result span,
    body.desktop-root-webui-workbench .desktop-command-palette-empty {
      color: var(--text-muted, #6c6a64);
      font-size: 11px;
      line-height: 1.35;
    }

    @media (max-width: 980px) {
      body.desktop-root-webui-workbench > .shell,
      body.desktop-root-webui-workbench > .shell.inspection-mode {
        grid-template-columns: 68px minmax(0, 1fr) 0;
      }

      body.desktop-root-webui-workbench .inspector-panel {
        display: none;
      }

      body.desktop-root-webui-workbench .desktop-empty-modules {
        grid-template-columns: minmax(0, 1fr);
      }
    }
  `;
  targetDocument.head.append(style);
}

function installRootWebUiPanelPersistence(
  targetDocument: Document,
  storage: Pick<Storage, "getItem" | "setItem"> | null,
  viewportWidth: number,
): void {
  if (!storage) {
    return;
  }

  const sidebarButton = targetDocument.getElementById("sidebar-collapse-button");
  sidebarButton?.addEventListener("click", () => {
    queuePanelSync(targetDocument, storage, viewportWidth, "sidebar");
  });

  const inspectorClose = targetDocument.getElementById("inspector-close");
  inspectorClose?.addEventListener("click", () => {
    queuePanelSync(targetDocument, storage, viewportWidth, "inspector");
  });
}

function queuePanelSync(
  targetDocument: Document,
  storage: Pick<Storage, "getItem" | "setItem">,
  viewportWidth: number,
  panel: "sidebar" | "inspector",
): void {
  const run = () => {
    const layout = loadWorkbenchLayout({ storage, viewportWidth });
    const visible = panel === "sidebar" ? isSidebarVisible(targetDocument) : isInspectorVisible(targetDocument);
    const nextLayout = toggleWorkbenchPanel(layout, panel, visible);
    persistWorkbenchLayout(nextLayout, storage);
    applyRootWebUiWorkbenchLayout(targetDocument, nextLayout);
  };
  targetDocument.defaultView?.setTimeout(run, 0) ?? setTimeout(run, 0);
}

function isSidebarVisible(targetDocument: Document): boolean {
  return !targetDocument.body.querySelector(".sidebar")?.classList.contains("collapsed");
}

function isInspectorVisible(targetDocument: Document): boolean {
  const shell = targetDocument.body.querySelector(".shell");
  const inspector = targetDocument.getElementById("inspector-panel");
  return shell?.classList.contains("inspection-mode") === true || inspector?.getAttribute("aria-hidden") !== "true";
}

function installEmptyStateObserver(targetDocument: Document): void {
  const upgrade = () => {
    for (const emptyChat of targetDocument.body.querySelectorAll<HTMLElement>(".empty-chat")) {
      upgradeDesktopRootWebUiEmptyState(emptyChat, targetDocument);
    }
  };
  upgrade();

  const observerConstructor = targetDocument.defaultView?.MutationObserver ?? globalThis.MutationObserver;
  const messageList = targetDocument.getElementById("message-list");
  if (!observerConstructor || !messageList) {
    return;
  }

  const observer = new observerConstructor(upgrade);
  observer.observe(messageList, { childList: true });
}

function runtimeChipName(item: HTMLElement): string {
  return item.querySelector(".status-label")?.textContent?.trim() || "Runtime";
}

function setComposerFeedback(feedback: HTMLElement, message: string): void {
  feedback.hidden = false;
  feedback.textContent = message;
}
