import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NText } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface CoworkDataRowIslandOptions {
  className: string;
  text: string;
}

export interface MountedCoworkDataRowIsland {
  unmount: () => void;
}

export function mountCoworkDataRowIsland(
  host: HTMLElement,
  options: CoworkDataRowIslandOptions,
): MountedCoworkDataRowIsland {
  host.setAttribute("data-desktop-vue-island", "cowork-data-row");
  host.className = options.className;
  const app = createCoworkDataRowApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createCoworkDataRowApp(options: CoworkDataRowIslandOptions): App {
  return createApp(defineComponent({
    name: "CoworkDataRowIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NText, { tag: "span" }, { default: () => options.text }),
      });
    },
  }));
}
