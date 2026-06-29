import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NText } from "naive-ui";
import { desktopNaiveThemeOverrides } from "../shell/desktopNaiveTheme";

export interface CoworkLimitStatusIslandOptions {
  text: string;
}

export interface MountedCoworkLimitStatusIsland {
  unmount: () => void;
}

export function mountCoworkLimitStatusIsland(
  host: HTMLElement,
  options: CoworkLimitStatusIslandOptions,
): MountedCoworkLimitStatusIsland {
  host.setAttribute("data-desktop-vue-island", "cowork-limit-status");
  host.className = "desktop-cowork-limit-status";
  const app = createCoworkLimitStatusApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createCoworkLimitStatusApp(options: CoworkLimitStatusIslandOptions): App {
  return createApp(defineComponent({
    name: "CoworkLimitStatusIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NText, { depth: 3, tag: "span" }, { default: () => options.text }),
      });
    },
  }));
}
