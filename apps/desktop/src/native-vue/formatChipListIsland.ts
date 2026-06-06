import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NText } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface FormatChipListIslandOptions {
  formats: string[];
  id: string;
}

export interface MountedFormatChipListIsland {
  unmount: () => void;
}

export function mountFormatChipListIsland(
  host: HTMLElement,
  options: FormatChipListIslandOptions,
): MountedFormatChipListIsland {
  host.setAttribute("data-desktop-vue-island", "format-chip-list");
  host.id = options.id;
  host.className = "desktop-file-format-row";
  const app = createFormatChipListApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createFormatChipListApp(options: FormatChipListIslandOptions): App {
  return createApp(defineComponent({
    name: "FormatChipListIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => [
          h(NText, { tag: "span" }, { default: () => "Formats:" }),
          ...options.formats.map((format) => h("span", { class: "desktop-file-format-chip" }, format)),
        ],
      });
    },
  }));
}
