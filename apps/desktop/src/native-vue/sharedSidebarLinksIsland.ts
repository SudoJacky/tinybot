import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NSpace } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface SharedSidebarLinkItem {
  href: string;
  icon?: string;
  id: string;
  kind: "link";
  label: string;
}

export interface SharedSidebarLinksIslandOptions {
  items: SharedSidebarLinkItem[];
  label?: string;
}

export interface MountedSharedSidebarLinksIsland {
  unmount: () => void;
}

export function mountSharedSidebarLinksIsland(
  host: HTMLElement,
  options: SharedSidebarLinksIslandOptions,
): MountedSharedSidebarLinksIsland {
  host.setAttribute("data-desktop-vue-island", "shared-sidebar-links");
  host.className = "desktop-workbench-section";
  const app = createSharedSidebarLinksApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createSharedSidebarLinksApp(options: SharedSidebarLinksIslandOptions): App {
  return createApp(defineComponent({
    name: "SharedSidebarLinksIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => [
          h("h2", options.label ?? "Resources"),
          h(NSpace, { vertical: true, size: 6 }, {
            default: () => options.items.map((item) => h("a", {
              class: "desktop-workbench-link",
              "data-sidebar-href": item.href,
              "data-sidebar-icon": item.icon,
              "data-sidebar-item-id": item.id,
              "data-sidebar-item-kind": item.kind,
              href: item.href,
            }, item.label)),
          }),
        ],
      });
    },
  }));
}
