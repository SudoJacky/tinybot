import { NCard, NConfigProvider } from "naive-ui";
import { createApp, defineComponent, h, onMounted, ref, type App } from "vue";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export type WorkbenchPanelIslandRegion = "bottom" | "inspector" | "sidebar";

export interface WorkbenchPanelIslandOptions {
  content: HTMLElement;
  region: WorkbenchPanelIslandRegion;
  size: number;
  visible: boolean;
}

export interface MountedWorkbenchPanelIsland {
  unmount: () => void;
}

export function mountWorkbenchPanelIsland(
  host: HTMLElement,
  options: WorkbenchPanelIslandOptions,
): MountedWorkbenchPanelIsland {
  host.className = `desktop-workbench-${options.region}`;
  host.setAttribute("data-desktop-vue-island", "workbench-panel");
  host.setAttribute("data-workbench-region", options.region);
  host.setAttribute("data-visible", String(options.visible));
  host.style.setProperty("--region-size", `${options.size}px`);

  const app = createWorkbenchPanelApp(host, options.content);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createWorkbenchPanelApp(_host: HTMLElement, content: HTMLElement): App {
  return createApp(defineComponent({
    name: "WorkbenchPanelIsland",
    setup() {
      const contentHost = ref<HTMLElement | null>(null);
      onMounted(() => {
        contentHost.value?.replaceChildren(content);
      });
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NCard, {
          class: "desktop-workbench-panel",
          size: "small",
          bordered: false,
        }, {
          default: () => h("div", { ref: contentHost, class: "desktop-workbench-panel-content" }),
        }),
      });
    },
  }));
}
