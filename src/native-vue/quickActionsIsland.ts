import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface MountedQuickActionsIsland {
  unmount: () => void;
}

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
  return h("div", { class: "desktop-quick-actions" });
}

export function renderQuickActionsContent() {
  return null;
}
