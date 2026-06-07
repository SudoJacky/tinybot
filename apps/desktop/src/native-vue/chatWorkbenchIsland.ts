import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref, type App } from "vue";
import { NConfigProvider, NText } from "naive-ui";
import type { DesktopTaskCenterItem } from "../desktopTaskCenter";
import { mountModuleWorkSectionIsland } from "./moduleWorkSectionIsland";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface ChatWorkbenchIslandOptions {
  moduleWorkItems?: DesktopTaskCenterItem[];
  onInspectWorkItem?: (item: DesktopTaskCenterItem) => void;
}

export interface MountedChatWorkbenchIsland {
  unmount: () => void;
}

export function mountChatWorkbenchIsland(
  host: HTMLElement,
  options: ChatWorkbenchIslandOptions,
): MountedChatWorkbenchIsland {
  host.setAttribute("data-desktop-vue-island", "chat-workbench");
  host.className = "desktop-chat-workbench-chrome";
  const app = createChatWorkbenchApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createChatWorkbenchApp(options: ChatWorkbenchIslandOptions): App {
  return createApp(defineComponent({
    name: "ChatWorkbenchIsland",
    setup() {
      const mountedChildren: Array<{ unmount: () => void }> = [];
      const moduleWork = ref<HTMLElement | null>(null);

      onMounted(() => {
        if (options.moduleWorkItems?.length) {
          mountChild(mountedChildren, moduleWork.value, (host) => mountModuleWorkSectionIsland(host, {
            title: "Chat runs",
            items: options.moduleWorkItems ?? [],
            onInspect: options.onInspectWorkItem,
          }));
        }
      });

      onBeforeUnmount(() => {
        while (mountedChildren.length) {
          mountedChildren.pop()?.unmount();
        }
      });

      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => [
          h(NText, { tag: "h2" }, { default: () => "Start a new session" }),
          h(NText, { depth: 3, tag: "p" }, { default: () => "Ask Tinybot about the workspace, inspect files, or create a task." }),
          options.moduleWorkItems?.length ? h("section", { ref: moduleWork }) : null,
        ],
      });
    },
  }));
}

function mountChild<T extends { unmount: () => void }>(
  mountedChildren: Array<{ unmount: () => void }>,
  host: HTMLElement | null,
  mount: (host: HTMLElement) => T,
): void {
  if (!host) {
    return;
  }
  mountedChildren.push(mount(host));
}
