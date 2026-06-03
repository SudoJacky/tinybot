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
  ensureDesktopComposerSurfaceStyle,
  installRootWebUiComposerRuntime,
} from "./desktopComposerSurface";
import { upgradeDesktopRootWebUiEmptyState } from "./desktopEmptyState";
import {
  buildRootWebUiSidebarModel,
  buildRootWebUiWorkspaceContext,
  type DesktopSidebarItem,
} from "./desktopSharedModels";
import { installDesktopDesignTokens } from "./desktopDesignTokens";

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
  installDesktopDesignTokens(targetDocument);
  ensureDesktopRootWebUiShellLayoutStyle(targetDocument);
  ensureDesktopComposerSurfaceStyle(targetDocument);
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
export {
  ensureDesktopComposerSurfaceStyle,
  installRootWebUiComposerRuntime,
} from "./desktopComposerSurface";
export { upgradeDesktopRootWebUiEmptyState } from "./desktopEmptyState";

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

  preserveRootWebUiCommandProxies(targetDocument);
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

const ROOT_WEBUI_COMMAND_PROXY_IDS = [
  "new-chat-button",
  "stop-generation-button",
  "settings-button",
  "theme-toggle",
  "sidebar-collapse-button",
  "help-tour-button",
];

function preserveRootWebUiCommandProxies(targetDocument: Document): void {
  const controls = ROOT_WEBUI_COMMAND_PROXY_IDS
    .map((id) => targetDocument.getElementById(id))
    .filter((control): control is HTMLElement => Boolean(control));
  if (controls.length === 0) {
    return;
  }

  const proxyHost = ensureCommandProxyHost(targetDocument);
  for (const control of controls) {
    control.setAttribute("data-desktop-command-proxy", "true");
    control.setAttribute("aria-hidden", "true");
    control.tabIndex = -1;
    proxyHost.append(control);
  }
}

function ensureCommandProxyHost(targetDocument: Document): HTMLElement {
  const existing = targetDocument.getElementById("desktop-webui-command-proxies");
  if (existing) {
    return existing;
  }

  const proxyHost = targetDocument.createElement("div");
  proxyHost.id = "desktop-webui-command-proxies";
  proxyHost.className = "desktop-webui-command-proxies";
  proxyHost.setAttribute("id", "desktop-webui-command-proxies");
  proxyHost.setAttribute("aria-hidden", "true");
  proxyHost.hidden = true;
  targetDocument.body.append(proxyHost);
  return proxyHost;
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
