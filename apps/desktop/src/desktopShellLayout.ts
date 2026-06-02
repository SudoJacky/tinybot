import {
  DESKTOP_WORKBENCH_LAYOUT_STORAGE_KEY,
  type WorkbenchLayoutState,
} from "./desktopWorkbenchLayout";

const STYLE_ID = "desktop-root-webui-workbench-style";

export function applyRootWebUiShellLayout(targetDocument: Document, layout: WorkbenchLayoutState): void {
  const shell = targetDocument.body.querySelector<HTMLElement>(".shell");
  if (!shell) {
    return;
  }
  const inspectorVisible = layout.inspector.visible && isRootWebUiInspectorVisible(targetDocument);

  targetDocument.body.classList.add("desktop-root-webui-workbench");
  shell.setAttribute("data-desktop-workbench", "root-webui");
  shell.setAttribute("data-desktop-layout-storage-key", DESKTOP_WORKBENCH_LAYOUT_STORAGE_KEY);
  shell.setAttribute("data-sidebar-visible", String(layout.sidebar.visible));
  shell.setAttribute("data-inspector-visible", String(inspectorVisible));
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
  const workspaceHeader =
    targetDocument.body.querySelector<HTMLElement>(".chat-header") ??
    targetDocument.body.querySelector<HTMLElement>(".session-header") ??
    targetDocument.body.querySelector<HTMLElement>("[data-desktop-workspace-header]");

  markShellRegion(sidebar, "sidebar", "sidebar");
  markShellRegion(chatPanel, "main", "workspace");
  markShellRegion(workspaceHeader, "workspace-header", "workspace-header");
  markShellRegion(messageList, "conversation", "message-list");
  markShellRegion(inspector, "inspector", "inspector");
  markShellRegion(composer, "composer", "composer");
  markShellRegion(statusPanel, "runtime-status", "runtime-status");
  workspaceHeader?.classList.add("desktop-workspace-header");

  if (!layout.sidebar.visible) {
    shell.classList.add("sidebar-collapsed");
    sidebar?.classList.add("collapsed");
  }

  if (!inspectorVisible) {
    shell.classList.remove("inspection-mode");
    inspector?.setAttribute("aria-hidden", "true");
  }
}

export function ensureDesktopRootWebUiShellLayoutStyle(targetDocument: Document): void {
  if (targetDocument.getElementById(STYLE_ID)) {
    return;
  }

  const style = targetDocument.createElement("style");
  style.id = STYLE_ID;
  style.setAttribute("id", STYLE_ID);
  style.textContent = `
    body.desktop-root-webui-workbench > .shell {
      --desktop-sidebar-rail-size: 68px;
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

    body.desktop-root-webui-workbench .sidebar .brand,
    body.desktop-root-webui-workbench .sidebar .sidebar-brand,
    body.desktop-root-webui-workbench .sidebar [data-desktop-content-branding] {
      display: none;
    }

    body.desktop-root-webui-workbench .desktop-app-sidebar {
      display: flex;
      min-width: 0;
      min-height: 0;
      overflow: hidden;
      border-right: 1px solid var(--border, #e6dfd8);
      border-radius: 0;
      background: var(--panel-strong, #efe9de);
      box-shadow: none;
    }

    body.desktop-root-webui-workbench .desktop-app-sidebar-content {
      display: grid;
      grid-template-rows: auto minmax(0, 1fr) auto;
      gap: 12px;
      width: 100%;
      min-width: 0;
      min-height: 0;
      padding: 12px 10px;
      overflow: hidden;
    }

    body.desktop-root-webui-workbench .desktop-app-sidebar-group {
      display: grid;
      gap: 6px;
      min-width: 0;
      min-height: 0;
    }

    body.desktop-root-webui-workbench .desktop-app-sidebar-group[data-sidebar-group="workspace"] {
      overflow: hidden;
    }

    body.desktop-root-webui-workbench .desktop-app-sidebar-group-label {
      margin: 0;
      overflow: hidden;
      color: var(--text-muted, #6c6a64);
      font-size: 11px;
      line-height: 1.25;
      text-overflow: ellipsis;
      text-transform: uppercase;
      white-space: nowrap;
    }

    body.desktop-root-webui-workbench .desktop-app-sidebar-list {
      display: grid;
      gap: 4px;
      min-width: 0;
      overflow: auto;
    }

    body.desktop-root-webui-workbench .desktop-app-sidebar-item {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 8px;
      min-width: 0;
      min-height: 32px;
      border: 1px solid transparent;
      border-radius: 6px;
      padding: 6px 8px;
      background: transparent;
      color: var(--text, #141413);
      font: 500 12px/1.2 var(--font-sans, system-ui, sans-serif);
      text-align: left;
      text-decoration: none;
    }

    body.desktop-root-webui-workbench .desktop-app-sidebar-item[data-sidebar-icon]::before {
      content: attr(data-sidebar-icon);
      display: none;
      min-width: 0;
      overflow: hidden;
      color: var(--text-muted, #6c6a64);
      font-size: 11px;
      font-weight: 700;
      line-height: 1;
      text-align: center;
      text-transform: uppercase;
    }

    body.desktop-root-webui-workbench .desktop-app-sidebar-item[data-active="true"],
    body.desktop-root-webui-workbench .desktop-app-sidebar-item:hover,
    body.desktop-root-webui-workbench .desktop-app-sidebar-item:focus-visible {
      border-color: var(--border, #e6dfd8);
      background: var(--panel, #faf9f5);
      outline: none;
    }

    body.desktop-root-webui-workbench .desktop-app-sidebar-item-label,
    body.desktop-root-webui-workbench .desktop-app-sidebar-item-meta {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    body.desktop-root-webui-workbench .desktop-app-sidebar-item-meta {
      color: var(--text-muted, #6c6a64);
      font-size: 11px;
      font-weight: 500;
    }

    body.desktop-root-webui-workbench > .shell .sidebar {
      order: 0 !important;
      grid-column: 1 !important;
      grid-row: 1;
    }

    body.desktop-root-webui-workbench > .shell .chat-panel,
    body.desktop-root-webui-workbench [data-desktop-shell-region="workspace"] {
      order: 0 !important;
      grid-column: 2 !important;
      grid-row: 1;
      min-width: 0;
    }

    body.desktop-root-webui-workbench > .shell .inspector-panel {
      order: 0 !important;
      grid-column: 3 !important;
      grid-row: 1;
    }

    body.desktop-root-webui-workbench .message-list {
      min-width: 0;
      scrollbar-gutter: stable;
    }

    body.desktop-root-webui-workbench .chat-header,
    body.desktop-root-webui-workbench .session-header,
    body.desktop-root-webui-workbench [data-desktop-workspace-header] {
      display: grid;
      gap: 4px;
      min-width: 0;
      border-bottom: 1px solid var(--border, #e6dfd8);
      padding: 14px 24px 12px;
      background: var(--panel, #faf9f5);
    }

    body.desktop-root-webui-workbench .desktop-workspace-header {
      display: grid;
      gap: 4px;
      min-width: 0;
      border-bottom: 1px solid var(--border, #e6dfd8);
      padding: 14px 24px 12px;
      background: var(--panel, #faf9f5);
    }

    body.desktop-root-webui-workbench .chat-header h1,
    body.desktop-root-webui-workbench .session-header h1,
    body.desktop-root-webui-workbench .desktop-workspace-header h1 {
      margin: 0;
      color: var(--text, #141413);
      font-size: 22px;
      font-weight: 500;
      line-height: 1.2;
      letter-spacing: 0;
    }

    body.desktop-root-webui-workbench .chat-header p,
    body.desktop-root-webui-workbench .session-header p,
    body.desktop-root-webui-workbench .desktop-workspace-header p {
      margin: 0;
      overflow: hidden;
      color: var(--text-muted, #6c6a64);
      font-size: 11px;
      line-height: 1.35;
      text-overflow: ellipsis;
      text-transform: uppercase;
      white-space: nowrap;
    }

    body.desktop-root-webui-workbench .desktop-empty-state-compact {
      display: grid;
      gap: 12px;
      width: min(720px, calc(100% - 48px));
      min-width: 0;
      margin: 36px auto;
      border: 0;
      border-radius: 0;
      padding: 0;
      background: transparent;
      box-shadow: none;
    }

    body.desktop-root-webui-workbench .desktop-empty-hints {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px 18px;
      min-width: 0;
      margin: 0;
    }

    body.desktop-root-webui-workbench .desktop-empty-hint {
      display: grid;
      gap: 3px;
      min-width: 0;
      border-left: 1px solid var(--border, #e6dfd8);
      padding: 0 0 0 10px;
      background: transparent;
      text-align: left;
    }

    body.desktop-root-webui-workbench .desktop-empty-hint strong,
    body.desktop-root-webui-workbench .desktop-empty-hint span {
      min-width: 0;
      overflow-wrap: anywhere;
    }

    body.desktop-root-webui-workbench .desktop-empty-hint strong {
      color: var(--text, #141413);
      font-size: 12px;
      line-height: 1.25;
    }

    body.desktop-root-webui-workbench .desktop-empty-hint span {
      color: var(--text-muted, #6c6a64);
      font-size: 11px;
      line-height: 1.35;
    }

    body.desktop-root-webui-workbench .desktop-empty-command-hints {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: center;
      min-width: 0;
      margin: 0;
    }

    body.desktop-root-webui-workbench .desktop-empty-command-hints button,
    body.desktop-root-webui-workbench .desktop-empty-command-hints .empty-chat-action {
      min-width: 0;
      min-height: 30px;
      border: 1px solid color-mix(in srgb, var(--border, #e6dfd8) 70%, transparent);
      border-radius: 6px;
      padding: 6px 10px;
      background: transparent;
      color: var(--text, #141413);
      font: 500 12px/1.2 var(--font-sans, system-ui, sans-serif);
      box-shadow: none;
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

    @media (min-width: 1181px) {
      body.desktop-root-webui-workbench > .shell,
      body.desktop-root-webui-workbench > .shell.inspection-mode {
        grid-template-columns: var(--desktop-sidebar-size, 248px) minmax(0, 1fr) minmax(0, var(--desktop-inspector-size, 360px));
        grid-template-rows: minmax(0, 1fr);
      }

      body.desktop-root-webui-workbench > .shell[data-inspector-visible="false"]:not(.inspection-mode) {
        grid-template-columns: var(--desktop-sidebar-size, 248px) minmax(0, 1fr) 0;
      }
    }

    @media (max-width: 1180px) and (min-width: 981px) {
      body.desktop-root-webui-workbench > .shell,
      body.desktop-root-webui-workbench > .shell.inspection-mode {
        grid-template-columns: minmax(220px, var(--desktop-sidebar-size, 248px)) minmax(0, 1fr) 0;
        grid-template-rows: minmax(0, 1fr);
        height: calc(100vh - var(--desktop-window-frame-height, 34px));
        min-height: 0;
      }

      body.desktop-root-webui-workbench > .shell .sidebar {
        order: 0 !important;
        grid-column: 1 !important;
        grid-row: 1;
        max-height: none;
      }

      body.desktop-root-webui-workbench > .shell .chat-panel,
      body.desktop-root-webui-workbench [data-desktop-shell-region="workspace"] {
        order: 0 !important;
        grid-column: 2 !important;
        grid-row: 1;
        min-width: 0;
        min-height: 0;
        height: auto;
      }

      body.desktop-root-webui-workbench .inspector-panel {
        display: none;
      }
    }

    @media (max-width: 980px) and (min-width: 721px) {
      body.desktop-root-webui-workbench > .shell,
      body.desktop-root-webui-workbench > .shell.inspection-mode {
        grid-template-columns: var(--desktop-sidebar-rail-size, 68px) minmax(0, 1fr) 0;
        grid-template-rows: minmax(0, 1fr);
        height: calc(100vh - var(--desktop-window-frame-height, 34px));
        min-height: 0;
      }

      body.desktop-root-webui-workbench > .shell .sidebar {
        order: 0 !important;
        grid-column: 1 !important;
        grid-row: 1;
        max-height: none;
      }

      body.desktop-root-webui-workbench > .shell .chat-panel {
        order: 0 !important;
        grid-column: 2 !important;
        grid-row: 1;
        min-height: 0;
        height: auto;
      }

      body.desktop-root-webui-workbench .desktop-app-sidebar-content {
        grid-template-rows: auto minmax(0, 1fr) auto;
        gap: 10px;
        padding: 10px 8px;
      }

      body.desktop-root-webui-workbench .desktop-app-sidebar-group-label,
      body.desktop-root-webui-workbench .desktop-app-sidebar-item-meta {
        display: none;
      }

      body.desktop-root-webui-workbench .desktop-app-sidebar-item {
        grid-template-columns: minmax(0, 1fr);
        justify-items: center;
        position: relative;
        min-height: 36px;
        padding: 7px 6px;
      }

      body.desktop-root-webui-workbench .desktop-app-sidebar-item[data-sidebar-icon]::before {
        display: block;
      }

      body.desktop-root-webui-workbench .desktop-app-sidebar-item-label {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip: rect(0 0 0 0);
        clip-path: inset(50%);
        white-space: nowrap;
      }

      body.desktop-root-webui-workbench .inspector-panel {
        display: none;
      }

      body.desktop-root-webui-workbench .desktop-empty-hints {
        grid-template-columns: minmax(0, 1fr);
      }
    }

    @media (max-width: 720px) {
      body.desktop-root-webui-workbench > .shell,
      body.desktop-root-webui-workbench > .shell.inspection-mode {
        grid-template-columns: 56px minmax(0, 1fr) 0;
        grid-template-rows: minmax(0, 1fr);
        height: calc(100vh - var(--desktop-window-frame-height, 34px));
        min-width: 0;
        min-height: 0;
      }

      body.desktop-root-webui-workbench > .shell .sidebar {
        order: 0 !important;
        grid-column: 1 !important;
        grid-row: 1;
        max-height: none;
      }

      body.desktop-root-webui-workbench > .shell .chat-panel,
      body.desktop-root-webui-workbench [data-desktop-shell-region="workspace"] {
        order: 0 !important;
        grid-column: 2 !important;
        grid-row: 1;
        min-width: 0;
        min-height: 0;
        height: auto;
      }

      body.desktop-root-webui-workbench .desktop-app-sidebar-content {
        gap: 8px;
        padding: 8px 6px;
      }

      body.desktop-root-webui-workbench .desktop-app-sidebar-group-label,
      body.desktop-root-webui-workbench .desktop-app-sidebar-item-meta {
        display: none;
      }

      body.desktop-root-webui-workbench .desktop-app-sidebar-item {
        grid-template-columns: minmax(0, 1fr);
        justify-items: center;
        position: relative;
        min-height: 34px;
        padding: 6px 4px;
      }

      body.desktop-root-webui-workbench .desktop-app-sidebar-item[data-sidebar-icon]::before {
        display: block;
      }

      body.desktop-root-webui-workbench .desktop-app-sidebar-item-label {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip: rect(0 0 0 0);
        clip-path: inset(50%);
        white-space: nowrap;
      }

      body.desktop-root-webui-workbench .inspector-panel {
        display: none;
      }

      body.desktop-root-webui-workbench .chat-header,
      body.desktop-root-webui-workbench .session-header,
      body.desktop-root-webui-workbench .desktop-workspace-header {
        padding: 12px 14px 10px;
      }

      body.desktop-root-webui-workbench .desktop-empty-state-compact {
        width: min(100%, calc(100% - 24px));
        margin: 24px auto;
      }

      body.desktop-root-webui-workbench .desktop-empty-hints {
        grid-template-columns: minmax(0, 1fr);
      }
    }
  `;
  targetDocument.head.append(style);
}

function markShellRegion(
  element: HTMLElement | null,
  workbenchRegion: string,
  desktopShellRegion: string,
): void {
  element?.setAttribute("data-workbench-region", workbenchRegion);
  element?.setAttribute("data-desktop-shell-region", desktopShellRegion);
}

function isRootWebUiInspectorVisible(targetDocument: Document): boolean {
  const shell = targetDocument.body.querySelector(".shell");
  const inspector = targetDocument.getElementById("inspector-panel");
  return shell?.classList.contains("inspection-mode") === true && inspector?.getAttribute("aria-hidden") !== "true";
}
