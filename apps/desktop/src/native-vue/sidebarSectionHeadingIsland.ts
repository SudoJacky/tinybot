import { createApp, defineComponent, h, type App } from "vue";
import { NButton, NConfigProvider } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface SidebarSectionHeadingIslandOptions {
  title: string;
  action?: string;
}

export interface MountedSidebarSectionHeadingIsland {
  unmount: () => void;
}

export function mountSidebarSectionHeadingIsland(
  host: HTMLElement,
  options: SidebarSectionHeadingIslandOptions,
): MountedSidebarSectionHeadingIsland {
  host.setAttribute("data-desktop-vue-island", "sidebar-section-heading");
  host.className = "desktop-sidebar-section-heading";
  const app = createSidebarSectionHeadingApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createSidebarSectionHeadingApp(options: SidebarSectionHeadingIslandOptions): App {
  return createApp(defineComponent({
    name: "SidebarSectionHeadingIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => [
          h("h2", options.title),
          options.action
            ? h(NButton, {
              class: "desktop-sidebar-section-action",
              focusable: false,
              quaternary: true,
              size: "tiny",
              "aria-label": `${options.title} action`,
            }, { default: () => options.action })
            : null,
        ],
      });
    },
  }));
}
