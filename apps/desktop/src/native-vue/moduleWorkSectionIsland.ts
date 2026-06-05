import { createApp, defineComponent, h, type App } from "vue";
import { NButton, NConfigProvider, NSpace } from "naive-ui";
import type { DesktopTaskCenterItem } from "../desktopTaskCenter";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface ModuleWorkSectionIslandOptions {
  title: string;
  items: DesktopTaskCenterItem[];
  onInspect?: (item: DesktopTaskCenterItem) => void;
}

export interface MountedModuleWorkSectionIsland {
  unmount: () => void;
}

export function mountModuleWorkSectionIsland(
  host: HTMLElement,
  options: ModuleWorkSectionIslandOptions,
): MountedModuleWorkSectionIsland {
  host.setAttribute("data-desktop-vue-island", "module-work");
  host.className = "desktop-module-work";
  host.setAttribute("aria-label", options.title);
  const app = createModuleWorkSectionApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createModuleWorkSectionApp(options: ModuleWorkSectionIslandOptions): App {
  return createApp(defineComponent({
    name: "ModuleWorkSectionIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => [
          h("h2", options.title),
          h(NSpace, {
            class: "desktop-module-work-list",
            vertical: true,
            size: 8,
          }, {
            default: () => options.items.map((item) => renderModuleWorkRow(item, options)),
          }),
        ],
      });
    },
  }));
}

function renderModuleWorkRow(item: DesktopTaskCenterItem, options: ModuleWorkSectionIslandOptions) {
  return h(NButton, {
    class: "desktop-module-work-row",
    type: "default",
    secondary: true,
    block: true,
    "data-desktop-module-work": item.id,
    "data-desktop-module-work-source": item.source,
    "aria-label": `Inspect ${item.title} in Work Lens`,
    onClick: () => options.onInspect?.(item),
  }, { default: () => moduleWorkRowText(item) });
}

function moduleWorkRowText(item: DesktopTaskCenterItem): string {
  return `${item.title}: ${[item.status, item.detail, item.progressLabel].filter(Boolean).join(" / ")}`;
}
