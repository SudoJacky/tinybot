import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NText } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface DesktopEmptyHint {
  detail: string;
  title: string;
}

export interface DesktopEmptyHintsIslandOptions {
  hints: DesktopEmptyHint[];
}

export interface MountedDesktopEmptyHintsIsland {
  unmount: () => void;
}

export function mountDesktopEmptyHintsIsland(
  host: HTMLElement,
  options: DesktopEmptyHintsIslandOptions,
): MountedDesktopEmptyHintsIsland {
  host.setAttribute("data-desktop-vue-island", "desktop-empty-hints");
  host.className = "desktop-empty-hints";
  host.setAttribute("aria-label", "Desktop workbench starting points");
  const app = createDesktopEmptyHintsApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createDesktopEmptyHintsApp(options: DesktopEmptyHintsIslandOptions): App {
  return createApp(defineComponent({
    name: "DesktopEmptyHintsIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => options.hints.map((hint) => h("article", { class: "desktop-empty-hint" }, [
          h(NText, { strong: true, tag: "strong" }, { default: () => hint.title }),
          h(NText, { depth: 3, tag: "span" }, { default: () => hint.detail }),
        ])),
      });
    },
  }));
}
