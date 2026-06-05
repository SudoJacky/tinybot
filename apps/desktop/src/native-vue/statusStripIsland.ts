import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NText } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface StatusStripIslandOptions {
  message: string;
}

export interface MountedStatusStripIsland {
  unmount: () => void;
}

export function mountStatusStripIsland(
  host: HTMLElement,
  options: StatusStripIslandOptions,
): MountedStatusStripIsland {
  host.setAttribute("data-desktop-vue-island", "status-strip");
  host.className = "desktop-status-strip";
  host.setAttribute("data-desktop-route-status", "");
  const app = createStatusStripApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createStatusStripApp(options: StatusStripIslandOptions): App {
  return createApp(defineComponent({
    name: "StatusStripIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NText, { depth: 3 }, { default: () => options.message }),
      });
    },
  }));
}
