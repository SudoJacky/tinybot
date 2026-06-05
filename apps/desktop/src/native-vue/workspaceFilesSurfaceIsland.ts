import { createApp, defineComponent, h, type App } from "vue";
import { NButton, NCard, NConfigProvider, NSpace, NTag } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface MountedWorkspaceFilesSurfaceIsland {
  unmount: () => void;
}

export function mountWorkspaceFilesSurfaceIsland(host: HTMLElement): MountedWorkspaceFilesSurfaceIsland {
  host.className = "desktop-workspace-files";
  host.setAttribute("data-desktop-vue-island", "workspace-files-surface");
  host.setAttribute("data-desktop-module-surface", "workspace");
  host.setAttribute("data-desktop-workspace-layout", "browser-detail-actions");

  const app = createWorkspaceFilesSurfaceApp();
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createWorkspaceFilesSurfaceApp(): App {
  return createApp(defineComponent({
    name: "WorkspaceFilesSurfaceIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => [
          renderHeader(),
          renderBrowser(),
          renderDetailPanel(),
          renderEditorPanel(),
          renderActionRail(),
        ],
      });
    },
  }));
}

function renderHeader() {
  return h("div", { class: "desktop-workspace-header" }, [
    h("div", { class: "desktop-workspace-title-group" }, [
      h("h2", "Workspace files"),
      h("p", "Browse, inspect, edit, and export workspace files."),
    ]),
    h(NSpace, { size: 8, align: "center" }, {
      default: () => [
        h("p", { id: "desktop-workspace-status", class: "desktop-workspace-status" }, "0 files"),
        h(NTag, { size: "small", round: true }, { default: () => "empty" }),
      ],
    }),
  ]);
}

function renderBrowser() {
  return h("aside", { class: "desktop-workspace-browser" }, [
    h(NCard, { size: "small", bordered: false }, {
      default: () => [
        h("h3", "Files"),
        h("input", {
          id: "desktop-workspace-search",
          class: "desktop-workspace-search",
          type: "search",
          placeholder: "Search workspace files...",
          "aria-label": "Search workspace files",
        }),
        h("div", {
          id: "desktop-workspace-recent-files",
          class: "desktop-workspace-recent-files",
          "aria-label": "Recent workspace files",
        }),
      ],
    }),
  ]);
}

function renderDetailPanel() {
  return h("section", { class: "desktop-workspace-detail-panel" }, [
    h(NCard, { size: "small", bordered: false }, {
      default: () => [
        h("h3", "Selection"),
        h("p", { id: "desktop-workspace-active-path", class: "desktop-workspace-active-path" }, "No workspace file selected."),
        h("p", { id: "desktop-workspace-updated-at", class: "desktop-workspace-updated-at" }, "No timestamp"),
        h("p", { id: "desktop-workspace-size", class: "desktop-workspace-size" }, "No size"),
        h("p", { id: "desktop-workspace-detail", class: "desktop-workspace-detail" }, "No workspace file selected."),
      ],
    }),
  ]);
}

function renderEditorPanel() {
  return h("section", { class: "desktop-workspace-editor-panel" }, [
    h(NCard, { size: "small", bordered: false }, {
      default: () => [
        h("h3", "Editor"),
        h("textarea", {
          id: "desktop-workspace-editor",
          class: "desktop-workspace-editor",
          "aria-label": "Workspace file editor",
        }),
      ],
    }),
  ]);
}

function renderActionRail() {
  return h("aside", { class: "desktop-workspace-action-rail", "aria-label": "Workspace file actions" }, [
    h(NCard, { size: "small", bordered: false }, {
      default: () => [
        h("h3", "Actions"),
        h(NSpace, { class: "desktop-workspace-actions", size: 8, wrap: true }, {
          default: () => [
            renderActionButton("desktop-workspace-save", "desktop-file-action", "Save"),
            renderActionButton("desktop-workspace-reveal", "desktop-file-action", "Reveal"),
            renderActionButton("desktop-workspace-export", "desktop-file-action", "Export"),
            renderActionButton("desktop-workspace-reload", "desktop-file-action desktop-workspace-reload", "Reload"),
          ],
        }),
        h("p", { id: "desktop-workspace-save-state", class: "desktop-workspace-save-state" }, "Select a workspace file"),
        h("p", { id: "desktop-workspace-error", class: "desktop-workspace-error" }, ""),
      ],
    }),
  ]);
}

function renderActionButton(id: string, className: string, label: string) {
  return h(NButton, {
    id,
    class: className,
    disabled: true,
    size: "small",
    type: "default",
  }, { default: () => label });
}
