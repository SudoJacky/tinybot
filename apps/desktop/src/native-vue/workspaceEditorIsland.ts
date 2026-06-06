import { createApp, defineComponent, h, ref, type App } from "vue";
import { NCard, NConfigProvider } from "naive-ui";
import type { DesktopWorkspaceFileState } from "../desktopWorkspaceFiles";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface WorkspaceEditorIslandOptions {
  state: DesktopWorkspaceFileState;
  onDraftInput?: (draft: string) => void;
}

export interface MountedWorkspaceEditorIsland {
  update: (state: DesktopWorkspaceFileState) => void;
  unmount: () => void;
}

export function mountWorkspaceEditorIsland(
  host: HTMLElement,
  options: WorkspaceEditorIslandOptions,
): MountedWorkspaceEditorIsland {
  host.setAttribute("data-desktop-vue-island", "workspace-editor");
  host.className = "desktop-workspace-editor-panel";

  const state = ref(options.state);
  const app = createWorkspaceEditorApp(state, options.onDraftInput);
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

function createWorkspaceEditorApp(
  state: { value: DesktopWorkspaceFileState },
  onDraftInput: WorkspaceEditorIslandOptions["onDraftInput"],
): App {
  return createApp(defineComponent({
    name: "WorkspaceEditorIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NCard, { size: "small", bordered: false }, {
          default: () => [
            h("h3", "Editor"),
            h("textarea", {
              id: "desktop-workspace-editor",
              class: "desktop-workspace-editor",
              "aria-label": "Workspace file editor",
              value: state.value.draft,
              onInput: (event: Event) => onDraftInput?.(String((event.target as HTMLTextAreaElement | null)?.value ?? "")),
            }),
          ],
        }),
      });
    },
  }));
}
