import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export type PanelIconPart = "frame" | "rail";

export interface PanelIconPartIslandOptions {
  part: PanelIconPart;
}

export interface MountedPanelIconPartIsland {
  unmount: () => void;
}

export function mountPanelIconPartIsland(
  host: HTMLElement,
  options: PanelIconPartIslandOptions,
): MountedPanelIconPartIsland {
  host.setAttribute("data-desktop-vue-island", "panel-icon-part");
  host.className = `desktop-chat-header-panel-icon-${options.part}`;
  const app = createPanelIconPartApp();
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createPanelIconPartApp(): App {
  return createApp(defineComponent({
    name: "PanelIconPartIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides });
    },
  }));
}
