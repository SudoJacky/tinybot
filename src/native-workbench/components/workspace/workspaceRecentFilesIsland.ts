import { createApp, defineComponent, h, ref, type App } from "vue";
import { NButton, NConfigProvider, NEmpty, NSpace } from "naive-ui";
import type { DesktopWorkspaceFileState } from "../../workspace/desktopWorkspaceFiles";
import { desktopNaiveThemeOverrides } from "../shell/desktopNaiveTheme";

export interface WorkspaceRecentFilesIslandOptions {
  state: DesktopWorkspaceFileState;
  onSelect?: (path: string) => void;
}

export interface MountedWorkspaceRecentFilesIsland {
  update: (state: DesktopWorkspaceFileState) => void;
  unmount: () => void;
}

export function mountWorkspaceRecentFilesIsland(
  host: HTMLElement,
  options: WorkspaceRecentFilesIslandOptions,
): MountedWorkspaceRecentFilesIsland {
  host.setAttribute("data-desktop-vue-island", "workspace-recent-files");
  host.id = "desktop-workspace-recent-files";
  host.className = "desktop-workspace-recent-files";
  host.setAttribute("aria-label", "Recent workspace files");

  const state = ref(options.state);
  const app = createWorkspaceRecentFilesApp(state, options.onSelect);
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

function createWorkspaceRecentFilesApp(
  state: { value: DesktopWorkspaceFileState },
  onSelect: WorkspaceRecentFilesIslandOptions["onSelect"],
): App {
  return createApp(defineComponent({
    name: "WorkspaceRecentFilesIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => {
          const rows = visibleWorkspaceRows(state.value);
          if (!rows.length) {
            return h(NEmpty, {
              class: "desktop-workspace-empty",
              description: "No workspace files.",
              size: "small",
            });
          }
          return h(NSpace, {
            vertical: true,
            size: 6,
            role: "list",
          }, {
            default: () => rows.map(({ path, meta }) => h(NButton, {
              class: "desktop-workspace-file-row",
              "data-desktop-workspace-file": path,
              "data-desktop-entity-module": "workspace",
              "data-desktop-entity-id": path,
              "aria-selected": state.value.activePath === path ? "true" : "false",
              block: true,
              secondary: state.value.activePath !== path,
              type: state.value.activePath === path ? "primary" : "default",
              onClick: () => onSelect?.(path),
            }, {
              default: () => [
                h("span", { class: "desktop-workspace-file-path" }, path),
                h("span", { class: "desktop-workspace-file-meta" }, meta),
              ],
            })),
          });
        },
      });
    },
  }));
}

function visibleWorkspaceRows(state: DesktopWorkspaceFileState): Array<{ path: string; meta: string }> {
  const query = state.searchQuery.trim().toLowerCase();
  const paths = query
    ? state.files.map((file) => file.path).filter((path) => path.toLowerCase().includes(query))
    : state.recentPaths.length
      ? state.recentPaths
      : state.files.map((file) => file.path).slice(0, 6);
  return paths.map((path) => ({
    path,
    meta: state.files.find((file) => file.path === path)?.meta ?? "Recent",
  }));
}
