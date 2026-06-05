import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";
import { renderToolActivityNode, type ToolActivityIslandOptions } from "./toolActivityIsland";

export interface ToolActivitiesIslandOptions {
  activities: ToolActivityIslandOptions[];
}

export interface MountedToolActivitiesIsland {
  unmount: () => void;
}

export function mountToolActivitiesIsland(
  host: HTMLElement,
  options: ToolActivitiesIslandOptions,
): MountedToolActivitiesIsland {
  host.setAttribute("data-desktop-vue-island", "tool-activities");
  host.className = "desktop-tool-activities";
  const app = createToolActivitiesApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createToolActivitiesApp(options: ToolActivitiesIslandOptions): App {
  return createApp(defineComponent({
    name: "ToolActivitiesIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => options.activities.map((activity) => renderToolActivityNode(activity)),
      });
    },
  }));
}
