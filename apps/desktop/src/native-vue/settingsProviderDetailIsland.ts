import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NText } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface SettingsProviderDetailIslandOptions {
  label: string;
  value: string;
}

export interface MountedSettingsProviderDetailIsland {
  unmount: () => void;
}

export function mountSettingsProviderDetailIsland(
  host: HTMLElement,
  options: SettingsProviderDetailIslandOptions,
): MountedSettingsProviderDetailIsland {
  host.setAttribute("data-desktop-vue-island", "settings-provider-detail");
  host.className = "desktop-settings-provider-detail";
  const app = createSettingsProviderDetailApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createSettingsProviderDetailApp(options: SettingsProviderDetailIslandOptions): App {
  return createApp(defineComponent({
    name: "SettingsProviderDetailIsland",
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
