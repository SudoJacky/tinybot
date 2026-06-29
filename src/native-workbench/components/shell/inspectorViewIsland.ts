import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NText } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface InspectorViewIslandOptions {
  emptyText: string;
  rows: string[];
  subtitle?: string;
  title: string;
}

export interface MountedInspectorViewIsland {
  unmount: () => void;
}

export function mountInspectorViewIsland(
  host: HTMLElement,
  options: InspectorViewIslandOptions,
): MountedInspectorViewIsland {
  host.setAttribute("data-desktop-vue-island", "inspector-view");
  host.className = "desktop-workbench-section desktop-inspector-view";
  host.setAttribute("data-desktop-inspector-view", "");
  const app = createInspectorViewApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createInspectorViewApp(options: InspectorViewIslandOptions): App {
  return createApp(defineComponent({
    name: "InspectorViewIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => [
          h("h2", options.title),
          options.subtitle ? h(NText, { depth: 3, tag: "p" }, { default: () => options.subtitle }) : null,
          options.rows.length
            ? options.rows.map((row) => h(NText, {
              class: "desktop-inspector-view-row",
              depth: 2,
              tag: "p",
            }, { default: () => row }))
            : h(NText, {
              class: "desktop-inspector-view-empty",
              depth: 3,
              tag: "p",
            }, { default: () => options.emptyText }),
        ],
      });
    },
  }));
}
