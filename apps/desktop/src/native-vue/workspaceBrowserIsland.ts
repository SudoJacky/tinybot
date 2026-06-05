import { createApp, defineComponent, h, type App } from "vue";
import { NCard, NConfigProvider } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface MountedWorkspaceBrowserIsland {
  unmount: () => void;
}

export function mountWorkspaceBrowserIsland(host: HTMLElement): MountedWorkspaceBrowserIsland {
  host.setAttribute("data-desktop-vue-island", "workspace-browser");
  host.className = "desktop-workspace-browser";

  const app = createWorkspaceBrowserApp();
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createWorkspaceBrowserApp(): App {
  return createApp(defineComponent({
    name: "WorkspaceBrowserIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NCard, { size: "small", bordered: false }, {
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
      });
    },
  }));
}
