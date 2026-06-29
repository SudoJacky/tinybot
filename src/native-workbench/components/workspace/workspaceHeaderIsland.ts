import { createApp, defineComponent, h, ref, type App } from "vue";
import { NConfigProvider, NSpace, NTag } from "naive-ui";
import type { DesktopWorkspaceFileState } from "../../workspace/desktopWorkspaceFiles";
import { desktopNaiveThemeOverrides } from "../shell/desktopNaiveTheme";

export interface WorkspaceHeaderIslandOptions {
  state: DesktopWorkspaceFileState;
}

export interface MountedWorkspaceHeaderIsland {
  update: (state: DesktopWorkspaceFileState) => void;
  unmount: () => void;
}

export function mountWorkspaceHeaderIsland(
  host: HTMLElement,
  options: WorkspaceHeaderIslandOptions,
): MountedWorkspaceHeaderIsland {
  host.setAttribute("data-desktop-vue-island", "workspace-header");
  host.className = "desktop-workspace-header";

  const state = ref(options.state);
  const app = createWorkspaceHeaderApp(state);
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

function createWorkspaceHeaderApp(state: { value: DesktopWorkspaceFileState }): App {
  return createApp(defineComponent({
    name: "WorkspaceHeaderIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => [
          h("div", { class: "desktop-workspace-title-group" }, [
            h("h2", "Workspace files"),
            h("p", "Browse, inspect, edit, and export workspace files."),
          ]),
          h(NSpace, { size: 8, align: "center" }, {
            default: () => [
              h("p", { id: "desktop-workspace-status", class: "desktop-workspace-status" }, fileCountText(state.value)),
              h(NTag, { size: "small", round: true, type: state.value.files.length ? "success" : "default" }, {
                default: () => state.value.files.length ? "loaded" : "empty",
              }),
            ],
          }),
        ],
      });
    },
  }));
}

function fileCountText(state: DesktopWorkspaceFileState): string {
  const fileLabel = state.files.length === 1 ? "file" : "files";
  return `${state.files.length} ${fileLabel}`;
}
