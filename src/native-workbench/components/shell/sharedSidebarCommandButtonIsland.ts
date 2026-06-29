import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NText } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface SharedSidebarCommandButtonIslandOptions {
  commandId: string;
  icon?: string;
  id: string;
  kind: "command";
  label: string;
  targetDocument?: Document;
}

export interface MountedSharedSidebarCommandButtonIsland {
  unmount: () => void;
}

export function mountSharedSidebarCommandButtonIsland(
  host: HTMLElement,
  options: SharedSidebarCommandButtonIslandOptions,
): MountedSharedSidebarCommandButtonIsland {
  host.setAttribute("data-desktop-vue-island", "shared-sidebar-command-button");
  host.className = "desktop-workbench-link";
  host.setAttribute("type", "button");
  host.setAttribute("data-sidebar-command", options.commandId);
  host.setAttribute("data-sidebar-item-id", options.id);
  host.setAttribute("data-sidebar-item-kind", options.kind);
  if (options.icon) {
    host.setAttribute("data-sidebar-icon", options.icon);
  } else {
    host.removeAttribute("data-sidebar-icon");
  }
  if (options.targetDocument) {
    host.addEventListener("click", () => {
      options.targetDocument?.dispatchEvent(new CustomEvent("desktop-menu-command", {
        detail: { id: options.commandId, source: "native-sidebar" },
      }));
    });
  }
  const app = createSharedSidebarCommandButtonApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createSharedSidebarCommandButtonApp(options: SharedSidebarCommandButtonIslandOptions): App {
  return createApp(defineComponent({
    name: "SharedSidebarCommandButtonIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NText, { tag: "span" }, { default: () => options.label }),
      });
    },
  }));
}
