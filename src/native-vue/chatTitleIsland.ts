import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NEllipsis } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface ChatTitleIslandOptions {
  title: string;
}

export interface MountedChatTitleIsland {
  unmount: () => void;
}

export function mountChatTitleIsland(
  host: HTMLElement,
  options: ChatTitleIslandOptions,
): MountedChatTitleIsland {
  host.setAttribute("data-desktop-vue-island", "chat-title");
  host.className = "desktop-chat-title";
  const app = createChatTitleApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createChatTitleApp(options: ChatTitleIslandOptions): App {
  return createApp(defineComponent({
    name: "ChatTitleIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NEllipsis, { lineClamp: 1 }, { default: () => options.title }),
      });
    },
  }));
}
