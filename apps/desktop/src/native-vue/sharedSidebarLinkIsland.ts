import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NText } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface SharedSidebarLinkIslandOptions {
  href: string;
  icon?: string;
  id: string;
  kind: "link";
  label: string;
}

export interface MountedSharedSidebarLinkIsland {
  unmount: () => void;
}

export function mountSharedSidebarLinkIsland(
  host: HTMLElement,
  options: SharedSidebarLinkIslandOptions,
): MountedSharedSidebarLinkIsland {
  host.setAttribute("data-desktop-vue-island", "shared-sidebar-link");
  host.className = "desktop-workbench-link";
  host.setAttribute("href", options.href);
  host.setAttribute("data-sidebar-href", options.href);
  host.setAttribute("data-sidebar-item-id", options.id);
  host.setAttribute("data-sidebar-item-kind", options.kind);
  if (options.icon) {
    host.setAttribute("data-sidebar-icon", options.icon);
  } else {
    host.removeAttribute("data-sidebar-icon");
  }
  const app = createSharedSidebarLinkApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createSharedSidebarLinkApp(options: SharedSidebarLinkIslandOptions): App {
  return createApp(defineComponent({
    name: "SharedSidebarLinkIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NText, { tag: "span" }, { default: () => options.label }),
      });
    },
  }));
}
