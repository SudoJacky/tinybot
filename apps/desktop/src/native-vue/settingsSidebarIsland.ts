import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider } from "naive-ui";
import type { DesktopSettingsPaneModel } from "../desktopSettingsProviders";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

type SettingsGroup = DesktopSettingsPaneModel["groups"][number];

export interface SettingsSidebarIslandOptions {
  groups: DesktopSettingsPaneModel["groups"];
}

export interface MountedSettingsSidebarIsland {
  unmount: () => void;
}

export function mountSettingsSidebarIsland(
  host: HTMLElement,
  options: SettingsSidebarIslandOptions,
): MountedSettingsSidebarIsland {
  host.setAttribute("data-desktop-vue-island", "settings-sidebar");
  host.className = "desktop-settings-sidebar";
  host.setAttribute("aria-label", "Settings navigation");
  const app = createSettingsSidebarApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createSettingsSidebarApp(options: SettingsSidebarIslandOptions): App {
  return createApp(defineComponent({
    name: "SettingsSidebarIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => [
          h("input", {
            class: "desktop-settings-search",
            type: "search",
            placeholder: "Search settings...",
            "aria-label": "Search settings",
          }),
          h("nav", {
            class: "desktop-settings-nav",
            "aria-label": "Settings sections",
          }, renderNavigation(options.groups)),
        ],
      });
    },
  }));
}

function renderNavigation(groups: SettingsGroup[]) {
  const nodes = [
    h("p", { class: "desktop-settings-nav-heading" }, "Personal"),
  ];
  groups.forEach((group, index) => {
    if (index === 3) {
      nodes.push(h("p", { class: "desktop-settings-nav-heading" }, "System"));
    }
    nodes.push(renderNavItem(group, index));
  });
  return nodes;
}

function renderNavItem(group: SettingsGroup, index: number) {
  const attrs: Record<string, string> = {
    class: "desktop-settings-nav-item",
    href: `#desktop-settings-group-${group.id}`,
    "data-desktop-settings-nav": group.id,
  };
  if (index === 0) {
    attrs["data-active"] = "true";
    attrs["aria-current"] = "page";
  }
  return h("a", attrs, getSettingsNavLabel(group.id));
}

function getSettingsNavLabel(groupId: SettingsGroup["id"]): string {
  return {
    agent: "General",
    provider: "Provider",
    knowledge: "Knowledge",
    tools: "Tools",
    gateway: "Gateway",
    channels: "Channels",
  }[groupId];
}
