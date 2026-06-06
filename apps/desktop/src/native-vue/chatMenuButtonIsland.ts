import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NText } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface ChatMenuButtonIslandOptions {
  expanded: boolean;
  onToggle?: () => void;
}

export interface MountedChatMenuButtonIsland {
  unmount: () => void;
}

export function mountChatMenuButtonIsland(
  host: HTMLElement,
  options: ChatMenuButtonIslandOptions,
): MountedChatMenuButtonIsland {
  host.setAttribute("data-desktop-vue-island", "chat-menu-button");
  host.setAttribute("type", "button");
  host.className = "desktop-chat-menu";
  host.setAttribute("data-desktop-chat-menu", "more");
  host.setAttribute("aria-haspopup", "menu");
  host.setAttribute("aria-expanded", String(options.expanded));
  host.setAttribute("aria-label", "More chat actions");
  host.addEventListener("click", () => {
    options.onToggle?.();
  });
  const app = createChatMenuButtonApp();
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createChatMenuButtonApp(): App {
  return createApp(defineComponent({
    name: "ChatMenuButtonIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NText, { strong: true }, { default: () => "..." }),
      });
    },
  }));
}
