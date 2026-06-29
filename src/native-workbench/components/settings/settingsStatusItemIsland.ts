import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NText } from "naive-ui";
import { desktopNaiveThemeOverrides } from "../shell/desktopNaiveTheme";

export interface SettingsStatusItemIslandOptions {
  label: string;
  value: string;
}

export interface MountedSettingsStatusItemIsland {
  unmount: () => void;
}

export function mountSettingsStatusItemIsland(
  host: HTMLElement,
  options: SettingsStatusItemIslandOptions,
): MountedSettingsStatusItemIsland {
  host.setAttribute("data-desktop-vue-island", "settings-status-item");
  host.className = "desktop-settings-status-item";
  const app = createSettingsStatusItemApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createSettingsStatusItemApp(options: SettingsStatusItemIslandOptions): App {
  return createApp(defineComponent({
    name: "SettingsStatusItemIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => [
          h(NText, { tag: "span" }, { default: () => `${options.label}: ` }),
          h(NText, { strong: true, tag: "strong" }, { default: () => options.value }),
        ],
      });
    },
  }));
}
