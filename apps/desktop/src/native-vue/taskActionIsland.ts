import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NText } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface TaskActionIslandOptions {
  action: string;
  href?: string;
  itemId: string;
  itemSource: string;
  label: string;
  onAction?: (action: string) => void;
}

export interface MountedTaskActionIsland {
  unmount: () => void;
}

export function mountTaskActionIsland(
  host: HTMLElement,
  options: TaskActionIslandOptions,
): MountedTaskActionIsland {
  host.setAttribute("data-desktop-vue-island", "task-action");
  host.className = "desktop-task-action";
  host.setAttribute("data-desktop-task-action", options.action);
  host.setAttribute("data-desktop-task-id", options.itemId);
  host.setAttribute("data-desktop-task-source", options.itemSource);
  if (options.action === "open" && options.href) {
    host.setAttribute("href", options.href);
  } else {
    host.setAttribute("type", "button");
    if (options.onAction) {
      host.addEventListener("click", (event) => {
        event.preventDefault();
        options.onAction?.(options.action);
      });
    }
  }
  const app = createTaskActionApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createTaskActionApp(options: TaskActionIslandOptions): App {
  return createApp(defineComponent({
    name: "TaskActionIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NText, { strong: true }, { default: () => options.label }),
      });
    },
  }));
}
