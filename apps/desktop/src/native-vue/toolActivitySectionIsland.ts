import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NText } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface ToolActivitySectionIslandOptions {
  kind: "call" | "response";
  label: string;
  text: string;
}

export interface MountedToolActivitySectionIsland {
  unmount: () => void;
}

export function mountToolActivitySectionIsland(
  host: HTMLElement,
  options: ToolActivitySectionIslandOptions,
): MountedToolActivitySectionIsland {
  host.setAttribute("data-desktop-vue-island", "tool-activity-section");
  host.className = `desktop-tool-activity-section desktop-tool-activity-section-${options.kind}`;
  const app = createToolActivitySectionApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createToolActivitySectionApp(options: ToolActivitySectionIslandOptions): App {
  return createApp(defineComponent({
    name: "ToolActivitySectionIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => [
          h(NText, { class: "desktop-tool-activity-label", tag: "div" }, { default: () => options.label }),
          h("pre", { class: "desktop-tool-activity-pre" }, options.text),
        ],
      });
    },
  }));
}
