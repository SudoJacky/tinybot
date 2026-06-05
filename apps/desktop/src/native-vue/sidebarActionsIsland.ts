import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NSpace } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface MountedSidebarActionsIsland {
  unmount: () => void;
}

export function mountSidebarActionsIsland(host: HTMLElement): MountedSidebarActionsIsland {
  host.setAttribute("data-desktop-vue-island", "sidebar-actions");
  host.className = "desktop-sidebar-actions";
  const app = createSidebarActionsApp();
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createSidebarActionsApp(): App {
  return createApp(defineComponent({
    name: "SidebarActionsIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NSpace, {
          vertical: true,
          size: 8,
        }, {
          default: () => [
            h("a", {
              class: "desktop-sidebar-primary-action",
              href: "/chat/new",
              "aria-label": "New chat",
            }, [
              "+  New chat",
              h("span", { class: "desktop-sidebar-shortcut" }, "Ctrl N"),
            ]),
            h("input", {
              class: "desktop-sidebar-search",
              type: "search",
              "aria-label": "Search",
              placeholder: "Search",
            }),
          ],
        }),
      });
    },
  }));
}
