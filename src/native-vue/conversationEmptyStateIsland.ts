import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NEmpty } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface ConversationEmptyStateIslandOptions {
  message: string;
}

export interface MountedConversationEmptyStateIsland {
  unmount: () => void;
}

export function mountConversationEmptyStateIsland(
  host: HTMLElement,
  options: ConversationEmptyStateIslandOptions,
): MountedConversationEmptyStateIsland {
  host.setAttribute("data-desktop-vue-island", "conversation-empty-state");
  host.className = "desktop-conversation-thread";
  host.setAttribute("aria-label", "Conversation");
  const app = createConversationEmptyStateApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createConversationEmptyStateApp(options: ConversationEmptyStateIslandOptions): App {
  return createApp(defineComponent({
    name: "ConversationEmptyStateIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NEmpty, {
          class: "desktop-conversation-empty-state",
          description: options.message,
        }),
      });
    },
  }));
}
