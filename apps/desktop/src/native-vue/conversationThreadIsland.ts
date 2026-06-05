import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NEmpty } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";
import { renderConversationMessageNode, type ConversationMessageIslandOptions } from "./conversationMessageIsland";

export interface ConversationThreadIslandOptions {
  emptyMessage: string;
  messages: ConversationMessageIslandOptions[];
}

export interface MountedConversationThreadIsland {
  unmount: () => void;
}

export function mountConversationThreadIsland(
  host: HTMLElement,
  options: ConversationThreadIslandOptions,
): MountedConversationThreadIsland {
  host.setAttribute("data-desktop-vue-island", "conversation-thread");
  host.className = "desktop-conversation-thread";
  host.setAttribute("aria-label", "Conversation");
  const app = createConversationThreadApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createConversationThreadApp(options: ConversationThreadIslandOptions): App {
  return createApp(defineComponent({
    name: "ConversationThreadIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => options.messages.length
          ? options.messages.map((message) => renderConversationMessageNode(message))
          : h(NEmpty, { description: options.emptyMessage }),
      });
    },
  }));
}
