import { createApp, defineComponent, h, type App } from "vue";
import { NButton, NConfigProvider, NSpace } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

interface QuickActionLink {
  label: string;
  href: string;
}

export interface MountedQuickActionsIsland {
  unmount: () => void;
}

const QUICK_ACTION_LINKS: QuickActionLink[] = [
  { label: "Ask about this project", href: "/chat/new" },
  { label: "Open workspace", href: "/workspace" },
  { label: "Check gateway", href: "/api/status" },
];

export function mountQuickActionsIsland(host: HTMLElement): MountedQuickActionsIsland {
  host.setAttribute("data-desktop-vue-island", "quick-actions");
  host.className = "desktop-quick-actions";
  const app = createQuickActionsApp();
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createQuickActionsApp(): App {
  return createApp(defineComponent({
    name: "QuickActionsIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => renderQuickActionsContent(),
      });
    },
  }));
}

export function renderQuickActionsSurface() {
  return h("div", { class: "desktop-quick-actions" }, renderQuickActionsContent());
}

export function renderQuickActionsContent() {
  return h(NSpace, {
    class: "desktop-quick-actions-list",
    size: 8,
  }, {
    default: () => QUICK_ACTION_LINKS.map((link) => h(NButton, {
      class: "desktop-quick-action",
      href: link.href,
      tag: "a",
      secondary: true,
      type: "default",
    }, { default: () => link.label })),
  });
}
