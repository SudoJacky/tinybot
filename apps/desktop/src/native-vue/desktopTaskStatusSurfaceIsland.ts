import { createApp, defineComponent, h, type App } from "vue";
import { NCard, NConfigProvider } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface MountedDesktopTaskStatusSurfaceIsland {
  unmount: () => void;
}

export function mountDesktopTaskStatusSurfaceIsland(host: HTMLElement): MountedDesktopTaskStatusSurfaceIsland {
  applyDesktopTaskStatusSurfaceHost(host);
  const app = createDesktopTaskStatusSurfaceApp();
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function applyDesktopTaskStatusSurfaceHost(host: HTMLElement): void {
  host.className = "desktop-task-status-surface";
  host.setAttribute("data-desktop-vue-island", "desktop-task-status-surface");
  host.setAttribute("data-desktop-task-status-surface", "sidebar");
  host.setAttribute("aria-label", "Desktop task status");
}

function createDesktopTaskStatusSurfaceApp(): App {
  return createApp(defineComponent({
    name: "DesktopTaskStatusSurfaceIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NCard, {
          class: "desktop-task-status-surface-card",
          size: "small",
          bordered: false,
        }, {
          default: () => h("span", {
            class: "desktop-task-status-surface-sentinel",
            "aria-hidden": "true",
            hidden: "",
          }),
        }),
      });
    },
  }));
}
