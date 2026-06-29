import { createApp, defineComponent, h, ref, type App } from "vue";
import { NConfigProvider, NSpace } from "naive-ui";
import type { DesktopWorkspaceFileState } from "../desktopWorkspaceFiles";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export type WorkspaceActionId = "save" | "reveal" | "export" | "reload";

export interface WorkspaceActionsIslandOptions {
  state: DesktopWorkspaceFileState;
  canReveal?: boolean;
  canExport?: boolean;
  onAction?: (action: WorkspaceActionId) => void;
}

interface WorkspaceActionsState {
  fileState: DesktopWorkspaceFileState;
  canReveal: boolean;
  canExport: boolean;
}

export interface MountedWorkspaceActionsIsland {
  update: (state: DesktopWorkspaceFileState, canReveal?: boolean, canExport?: boolean) => void;
  unmount: () => void;
}

export function mountWorkspaceActionsIsland(
  host: HTMLElement,
  options: WorkspaceActionsIslandOptions,
): MountedWorkspaceActionsIsland {
  host.setAttribute("data-desktop-vue-island", "workspace-actions");
  host.className = "desktop-workspace-action-rail";
  host.setAttribute("aria-label", "Workspace file actions");

  const state = ref<WorkspaceActionsState>({
    fileState: options.state,
    canReveal: Boolean(options.canReveal),
    canExport: Boolean(options.canExport),
  });
  const app = createWorkspaceActionsApp(state, options.onAction);
  app.mount(host);
  return {
    update: (nextState, canReveal = false, canExport = false) => {
      state.value = {
        fileState: nextState,
        canReveal,
        canExport,
      };
    },
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createWorkspaceActionsApp(
  state: { value: WorkspaceActionsState },
  onAction: WorkspaceActionsIslandOptions["onAction"],
): App {
  return createApp(defineComponent({
    name: "WorkspaceActionsIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => [
          h("h3", "Actions"),
          h(NSpace, { class: "desktop-workspace-actions", size: 8, wrap: true }, {
            default: () => [
              renderButton("desktop-workspace-save", "desktop-file-action", "Save", isSaveDisabled(state.value), onAction),
              renderButton("desktop-workspace-reveal", "desktop-file-action", "Reveal", isRevealDisabled(state.value), onAction),
              renderButton("desktop-workspace-export", "desktop-file-action", "Export", isExportDisabled(state.value), onAction),
              renderButton("desktop-workspace-reload", "desktop-file-action desktop-workspace-reload", "Reload", isReloadDisabled(state.value), onAction),
            ],
          }),
          h("p", { id: "desktop-workspace-save-state", class: "desktop-workspace-save-state" }, workspaceSaveStateText(state.value.fileState)),
          h("p", { id: "desktop-workspace-error", class: "desktop-workspace-error" }, state.value.fileState.error ?? ""),
        ],
      });
    },
  }));
}

function renderButton(
  id: string,
  className: string,
  label: string,
  disabled: boolean,
  onAction: WorkspaceActionsIslandOptions["onAction"],
) {
  const action = label.toLowerCase() as WorkspaceActionId;
  return h("button", {
    id,
    type: "button",
    class: className,
    disabled,
    onClick: () => {
      if (!disabled) {
        onAction?.(action);
      }
    },
  }, label);
}

function isSaveDisabled(state: WorkspaceActionsState): boolean {
  return !state.fileState.activePath || !state.fileState.dirty || state.fileState.saveState === "saving";
}

function isRevealDisabled(state: WorkspaceActionsState): boolean {
  return !state.fileState.activePath || !state.canReveal || state.fileState.saveState === "saving";
}

function isReloadDisabled(state: WorkspaceActionsState): boolean {
  return !state.fileState.activePath || state.fileState.saveState !== "conflict-error";
}

function isExportDisabled(state: WorkspaceActionsState): boolean {
  return !state.fileState.activePath || !state.canExport || state.fileState.saveState === "saving";
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
