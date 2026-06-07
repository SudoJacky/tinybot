import { createApp, defineComponent, h, ref, type App } from "vue";
import { NConfigProvider } from "naive-ui";
import type { DesktopWorkspaceFileState } from "../desktopWorkspaceFiles";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface WorkspaceDetailIslandOptions {
  state: DesktopWorkspaceFileState;
}

export interface MountedWorkspaceDetailIsland {
  update: (state: DesktopWorkspaceFileState) => void;
  unmount: () => void;
}

export function mountWorkspaceDetailIsland(
  host: HTMLElement,
  options: WorkspaceDetailIslandOptions,
): MountedWorkspaceDetailIsland {
  host.setAttribute("data-desktop-vue-island", "workspace-detail");
  host.className = "desktop-workspace-detail-panel";

  const state = ref(options.state);
  const app = createWorkspaceDetailApp(state);
  app.mount(host);
  return {
    update: (nextState) => {
      state.value = nextState;
    },
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createWorkspaceDetailApp(state: { value: DesktopWorkspaceFileState }): App {
  return createApp(defineComponent({
    name: "WorkspaceDetailIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => [
          h("h3", "Selection"),
          h("p", { id: "desktop-workspace-active-path", class: "desktop-workspace-active-path" }, activePathText(state.value)),
          h("p", { id: "desktop-workspace-updated-at", class: "desktop-workspace-updated-at" }, updatedAtText(state.value)),
          h("p", { id: "desktop-workspace-size", class: "desktop-workspace-size" }, sizeText(state.value)),
          h("p", { id: "desktop-workspace-detail", class: "desktop-workspace-detail" }, detailText(state.value)),
        ],
      });
    },
  }));
}

function activePathText(state: DesktopWorkspaceFileState): string {
  return state.activePath ? `Active path: ${state.activePath}` : "No workspace file selected.";
}

function updatedAtText(state: DesktopWorkspaceFileState): string {
  return state.activeUpdatedAt ? `Updated: ${state.activeUpdatedAt}` : "No timestamp";
}

function sizeText(state: DesktopWorkspaceFileState): string {
  return typeof state.activeSizeBytes === "number" ? `Size: ${formatFileSize(state.activeSizeBytes)}` : "No size";
}

function detailText(state: DesktopWorkspaceFileState): string {
  return state.activePath
    ? `Workspace detail: ${state.activePath} / ${workspaceSaveStateText(state)}`
    : "No workspace file selected.";
}

function workspaceSaveStateText(state: DesktopWorkspaceFileState): string {
  if (state.saveState === "dirty") {
    return "Unsaved changes";
  }
  if (state.saveState === "saving") {
    return "Saving workspace file";
  }
  if (state.saveState === "saved") {
    if (state.exportedPath) {
      return `Exported to ${state.exportedPath}`;
    }
    return "Saved";
  }
  if (state.saveState === "protected-path-error") {
    return "Protected path blocked";
  }
  if (state.saveState === "conflict-error") {
    return "Save conflict";
  }
  if (state.saveState === "error") {
    return "Workspace file error";
  }
  return state.activePath ? "No unsaved changes" : "Select a workspace file";
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kib = bytes / 1024;
  if (kib < 1024) {
    return `${kib.toFixed(kib >= 10 ? 0 : 1)} KB`;
  }
  const mib = kib / 1024;
  return `${mib.toFixed(mib >= 10 ? 0 : 1)} MB`;
}
