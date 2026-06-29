import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref, type App, type Ref } from "vue";
import { NConfigProvider, NGi, NGrid } from "naive-ui";
import { createDesktopWorkspaceFileState } from "../../workspace/desktopWorkspaceFiles";
import { desktopNaiveThemeOverrides } from "../shell/desktopNaiveTheme";
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
  host.setAttribute("data-desktop-module-surface", "files workspace");
  host.setAttribute("data-desktop-workspace-layout", "source-browser-detail-actions");

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
      const source = ref<HTMLElement | null>(null);
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
            gridTemplateAreas: "\"header header header header\" \"source browser detail actions\" \"source browser editor actions\"",
            gridTemplateColumns: "minmax(180px, 0.62fr) minmax(240px, 0.9fr) minmax(300px, 1.5fr) minmax(160px, 0.7fr)",
          },
        }, {
          default: () => [
            h(NGi, { style: { gridArea: "header" } }, { default: () => h("div", { ref: header }) }),
            h(NGi, { style: { gridArea: "source" } }, { default: () => renderFileSourceTree(source) }),
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

function renderFileSourceTree(source: Ref<HTMLElement | null>) {
  return h("aside", {
    ref: source,
    class: "desktop-file-source-tree",
    "aria-label": "File sources",
  }, [
    h("h3", "Source Tree"),
    h("div", { class: "desktop-file-scope-chips", "aria-label": "File scope filters" }, [
      ...["All", "Session", "Knowledge", "Workspace"].map((label) => h("button", {
        type: "button",
        class: "desktop-file-scope-chip",
        "data-desktop-file-scope": label.toLowerCase(),
      }, label)),
    ]),
    ...[
      ["session", "Session Files", "Current chat and recent chats"],
      ["knowledge", "Knowledge Documents", "Persistent RAG and graph sources"],
      ["workspace", "Workspace Files", "Editable project files"],
    ].map(([id, title, detail]) => h("button", {
      type: "button",
      class: "desktop-file-source-row",
      "data-desktop-file-source": id,
    }, [
      h("span", { class: "desktop-file-source-title" }, title),
      h("span", { class: "desktop-file-source-detail" }, detail),
      h("span", { class: "desktop-file-source-count", "aria-label": `${title} count` }, "0"),
    ])),
  ]);
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
