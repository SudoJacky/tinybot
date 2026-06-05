import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NSpace } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

interface QuickActionLink {
  label: string;
  href: string;
}

export interface MountedQuickActionsIsland {
  unmount: () => void;
}

const QUICK_ACTION_LINKS: QuickActionLink[] = [
  { label: "New chat", href: "/chat/new" },
  { label: "Open workspace", href: "/workspace" },
  { label: "Gateway status", href: "/api/status" },
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
    default: () => QUICK_ACTION_LINKS.map((link) => h("a", {
      class: "desktop-quick-action",
      href: link.href,
    }, link.label)),
  });
}
