import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NText } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface SidebarRowIslandOptions {
  active: boolean;
  entityId?: string;
  entityModule?: string;
  href: string;
  kind: "folder" | "chat";
  meta: string;
  title: string;
}

export interface MountedSidebarRowIsland {
  unmount: () => void;
}

export function mountSidebarRowIsland(
  host: HTMLAnchorElement,
  options: SidebarRowIslandOptions,
): MountedSidebarRowIsland {
  host.setAttribute("data-desktop-vue-island", "sidebar-row");
  host.className = "desktop-sidebar-row";
  host.setAttribute("href", options.href);
  host.setAttribute("role", "listitem");
  host.setAttribute("data-active", String(options.active));
  host.setAttribute("data-sidebar-row-kind", options.kind);
  setOptionalAttribute(host, "data-desktop-entity-module", options.entityModule);
  setOptionalAttribute(host, "data-desktop-entity-id", options.entityId);
  const app = createSidebarRowApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function setOptionalAttribute(host: HTMLElement, name: string, value: string | undefined): void {
  if (value) {
    host.setAttribute(name, value);
    return;
  }
  host.removeAttribute(name);
}

function createSidebarRowApp(options: SidebarRowIslandOptions): App {
  return createApp(defineComponent({
    name: "SidebarRowIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => [
          h(NText, { class: "desktop-sidebar-row-label", tag: "span" }, { default: () => options.title }),
          h(NText, { class: "desktop-sidebar-row-meta", depth: 3, tag: "span" }, { default: () => options.meta }),
        ],
      });
    },
  }));
}
