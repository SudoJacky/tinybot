import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref, type App } from "vue";
import { NConfigProvider, NGi, NGrid } from "naive-ui";
import { createDesktopWorkspaceFileState } from "../desktopWorkspaceFiles";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";
import { mountWorkspaceActionsIsland } from "./workspaceActionsIsland";
import { mountWorkspaceBrowserIsland } from "./workspaceBrowserIsland";
import { mountWorkspaceDetailIsland } from "./workspaceDetailIsland";
import { mountWorkspaceEditorIsland } from "./workspaceEditorIsland";
import { mountWorkspaceHeaderIsland } from "./workspaceHeaderIsland";

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
      const mountedChildren: Array<{ unmount: () => void }> = [];
      const header = ref<HTMLElement | null>(null);
      const browser = ref<HTMLElement | null>(null);
      const detail = ref<HTMLElement | null>(null);
      const editor = ref<HTMLElement | null>(null);
      const actions = ref<HTMLElement | null>(null);

      onMounted(() => {
        const state = createDesktopWorkspaceFileState();
        mountChild(mountedChildren, header.value, (host) => mountWorkspaceHeaderIsland(host, { state }));
        mountChild(mountedChildren, browser.value, (host) => mountWorkspaceBrowserIsland(host));
        mountChild(mountedChildren, detail.value, (host) => mountWorkspaceDetailIsland(host, { state }));
        mountChild(mountedChildren, editor.value, (host) => mountWorkspaceEditorIsland(host, { state }));
        mountChild(mountedChildren, actions.value, (host) => mountWorkspaceActionsIsland(host, { state }));
      });

      onBeforeUnmount(() => {
        while (mountedChildren.length) {
          mountedChildren.pop()?.unmount();
        }
      });

      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NGrid, {
          class: "desktop-workspace-files-grid",
          xGap: 12,
          yGap: 12,
          cols: 3,
          style: {
            gridColumn: "1 / -1",
            gridRow: "1 / -1",
            gridTemplateAreas: "\"header header header\" \"browser detail actions\" \"browser editor actions\"",
            gridTemplateColumns: "minmax(220px, 0.78fr) minmax(0, 1.55fr) minmax(150px, 0.48fr)",
          },
        }, {
          default: () => [
            h(NGi, { style: { gridArea: "header" } }, { default: () => h("div", { ref: header }) }),
            h(NGi, { style: { gridArea: "browser" } }, { default: () => h("aside", { ref: browser }) }),
            h(NGi, { style: { gridArea: "detail" } }, { default: () => h("section", { ref: detail }) }),
            h(NGi, { style: { gridArea: "editor" } }, { default: () => h("section", { ref: editor }) }),
            h(NGi, { style: { gridArea: "actions" } }, { default: () => h("aside", { ref: actions }) }),
          ],
        }),
      });
    },
  }));
}

function mountChild<T extends { unmount: () => void }>(
  mountedChildren: Array<{ unmount: () => void }>,
  host: HTMLElement | null,
  mount: (host: HTMLElement) => T,
): void {
  if (!host) {
    return;
  }
  mountedChildren.push(mount(host));
}
