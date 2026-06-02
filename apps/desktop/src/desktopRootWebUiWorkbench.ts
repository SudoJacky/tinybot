import {
  loadWorkbenchLayout,
  persistWorkbenchLayout,
  toggleWorkbenchPanel,
} from "./desktopWorkbenchLayout";
import { renderDesktopAppSidebar } from "./desktopAppSidebar";
import {
  applyRootWebUiShellLayout,
  ensureDesktopRootWebUiShellLayoutStyle,
} from "./desktopShellLayout";
import {
  buildRootWebUiSidebarModel,
  buildRootWebUiWorkspaceContext,
  type DesktopSidebarItem,
} from "./desktopSharedModels";

interface InstallDesktopRootWebUiWorkbenchOptions {
  targetDocument?: Document;
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  viewportWidth?: number;
}

export function installDesktopRootWebUiWorkbenchAdapter({
  targetDocument = document,
  storage = targetDocument.defaultView?.localStorage ?? null,
  viewportWidth = targetDocument.defaultView?.innerWidth ?? Number.POSITIVE_INFINITY,
}: InstallDesktopRootWebUiWorkbenchOptions = {}): void {
  ensureDesktopRootWebUiShellLayoutStyle(targetDocument);
  installRootWebUiCommandPaletteSurface(targetDocument);
  const layout = loadWorkbenchLayout({ storage, viewportWidth });
  applyRootWebUiShellLayout(targetDocument, layout);
  installRootWebUiDesktopAppSidebar(targetDocument);
  installRootWebUiComposerRuntime(targetDocument);
  installRootWebUiPanelPersistence(targetDocument, storage, viewportWidth);
  installEmptyStateObserver(targetDocument);
}

export {
  applyRootWebUiShellLayout as applyRootWebUiWorkbenchLayout,
  ensureDesktopRootWebUiShellLayoutStyle as ensureDesktopRootWebUiWorkbenchStyle,
} from "./desktopShellLayout";

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

export function installRootWebUiDesktopAppSidebar(targetDocument: Document): void {
  const sidebar = targetDocument.body.querySelector<HTMLElement>(".sidebar");
  if (!sidebar) {
    return;
  }

  const workspace = buildRootWebUiWorkspaceContext({
    workspaceLabel: "tinybot",
    activeSession: rootWebUiActiveSession(targetDocument),
  });
  renderDesktopAppSidebar(
    sidebar,
    buildRootWebUiSidebarModel({
      workspace,
      sessions: rootWebUiSessionItems(targetDocument),
    }),
    targetDocument,
  );
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
    applyRootWebUiShellLayout(targetDocument, nextLayout);
  };
  targetDocument.defaultView?.setTimeout(run, 0) ?? setTimeout(run, 0);
}

function isSidebarVisible(targetDocument: Document): boolean {
  return !targetDocument.body.querySelector(".sidebar")?.classList.contains("collapsed");
}

function isInspectorVisible(targetDocument: Document): boolean {
  const shell = targetDocument.body.querySelector(".shell");
  const inspector = targetDocument.getElementById("inspector-panel");
  return shell?.classList.contains("inspection-mode") === true && inspector?.getAttribute("aria-hidden") !== "true";
}

function rootWebUiActiveSession(targetDocument: Document): { id: string; title: string; meta?: string } | undefined {
  const active = targetDocument.body.querySelector<HTMLElement>(
    ".session-item.active, .session-item[aria-current='page'], .session-row.active, .session-row[aria-current='page']",
  );
  if (!active) {
    return undefined;
  }
  const item = sessionItemFromElement(active);
  return {
    id: item.id,
    title: item.label,
    meta: item.meta,
  };
}

function rootWebUiSessionItems(targetDocument: Document): DesktopSidebarItem[] {
  return [
    ...targetDocument.body.querySelectorAll<HTMLElement>(
      ".session-item, .session-row, [data-session-id], [data-chat-id]",
    ),
  ].map(sessionItemFromElement);
}

function sessionItemFromElement(element: HTMLElement): DesktopSidebarItem {
  const sessionId =
    element.getAttribute("data-session-id") ??
    element.getAttribute("data-chat-id") ??
    element.querySelector<HTMLElement>("[data-session-id]")?.getAttribute("data-session-id") ??
    element.querySelector<HTMLElement>("[data-chat-id]")?.getAttribute("data-chat-id") ??
    element.textContent?.trim().toLowerCase().replace(/\s+/g, "-") ??
    "session";
  const title =
    element.querySelector<HTMLElement>(".session-title, .session-name, [data-session-title]")?.textContent?.trim() ??
    element.getAttribute("data-session-title") ??
    element.textContent?.trim() ??
    "Untitled session";
  const meta =
    element.querySelector<HTMLElement>(".session-meta, .session-time, [data-session-meta]")?.textContent?.trim() ??
    element.getAttribute("data-session-meta") ??
    undefined;

  return {
    id: `session:${sessionId}`,
    kind: "session",
    label: title,
    meta,
    active: element.classList.contains("active") || element.getAttribute("aria-current") === "page",
  };
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
