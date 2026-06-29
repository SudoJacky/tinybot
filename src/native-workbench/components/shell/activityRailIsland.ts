import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NSpace } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

interface ActivityRailItem {
  href: string;
  label: string;
  module: string;
}

const PRIMARY_ACTIVITY_ITEMS: ActivityRailItem[] = [
  { href: "/chat", label: "Chat", module: "chat" },
  { href: "/files", label: "Files", module: "files" },
  { href: "/knowledge", label: "Knowledge", module: "knowledge" },
  { href: "/cowork", label: "Cowork", module: "cowork" },
  { href: "/docs", label: "Docs", module: "docs" },
  { href: "https://github.com/SudoJacky/tinybot", label: "GitHub", module: "gateway" },
];

const SECONDARY_ACTIVITY_ITEMS: ActivityRailItem[] = [
  { href: "/settings", label: "Settings", module: "settings" },
];

export interface MountedActivityRailIsland {
  unmount: () => void;
}

export function mountActivityRailIsland(host: HTMLElement): MountedActivityRailIsland {
  host.setAttribute("data-desktop-vue-island", "activity-rail");
  host.className = "desktop-activity-rail";
  host.setAttribute("data-workbench-region", "activity");
  host.setAttribute("aria-label", "Desktop workbench modules");
  const app = createActivityRailApp();
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createActivityRailApp(): App {
  return createApp(defineComponent({
    name: "ActivityRailIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h("div", { class: "desktop-activity-rail-stack" }, [
          h(NSpace, {
            class: "desktop-activity-primary",
            vertical: true,
            size: 8,
          }, {
            default: () => PRIMARY_ACTIVITY_ITEMS.map((item, index) => hActivityLink(item, {
              active: item.module === "chat",
              className: "desktop-activity-button",
              focusOrder: `activity-${index + 1}`,
            })),
          }),
          h(NSpace, {
            class: "desktop-activity-secondary",
            vertical: true,
            size: 8,
          }, {
            default: () => SECONDARY_ACTIVITY_ITEMS.map((item) => hActivityLink(item, {
              active: false,
              className: "desktop-activity-secondary-button",
            })),
          }),
        ]),
      });
    },
  }));
}

function hActivityLink(
  item: ActivityRailItem,
  options: { active: boolean; className: string; focusOrder?: string },
) {
  return h("a", {
    "aria-current": options.active ? "page" : null,
    "aria-label": item.label,
    class: options.className,
    "data-active": options.active ? "true" : null,
    "data-desktop-module-target": item.module,
    "data-focus-order": options.focusOrder,
    href: item.href,
    title: item.label,
  }, item.label);
}
