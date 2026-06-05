import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NText } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface ChatMenuEmptyIslandOptions {
  message: string;
}

export interface MountedChatMenuEmptyIsland {
  unmount: () => void;
}

export function mountChatMenuEmptyIsland(
  host: HTMLElement,
  options: ChatMenuEmptyIslandOptions,
): MountedChatMenuEmptyIsland {
  host.setAttribute("data-desktop-vue-island", "chat-menu-empty");
  host.className = "desktop-chat-menu-empty";
  const app = createChatMenuEmptyApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createChatMenuEmptyApp(options: ChatMenuEmptyIslandOptions): App {
  return createApp(defineComponent({
    name: "ChatMenuEmptyIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NText, { depth: 3, tag: "span" }, { default: () => options.message }),
      });
    },
  }));
}
