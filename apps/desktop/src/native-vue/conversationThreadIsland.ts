import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref, type App } from "vue";
import { NConfigProvider, NEmpty } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";
import { mountConversationMessageIsland, type ConversationMessageIslandOptions } from "./conversationMessageIsland";

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
      const messageHosts = ref<Array<HTMLElement | null>>([]);
      const mountedChildren: Array<{ unmount: () => void }> = [];

      onMounted(() => {
        options.messages.forEach((message, index) => {
          mountChild(mountedChildren, messageHosts.value[index] ?? null, (host) => mountConversationMessageIsland(host, message));
        });
      });

      onBeforeUnmount(() => {
        while (mountedChildren.length) {
          mountedChildren.pop()?.unmount();
        }
      });

      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => options.messages.length
          ? options.messages.map((message, index) => h("article", {
            ref: (element) => {
              messageHosts.value[index] = element as HTMLElement | null;
            },
            class: "desktop-conversation-message",
            "data-message-tone": message.tone,
          }))
          : h(NEmpty, { description: options.emptyMessage }),
      });
    },
  }));
}

function mountChild<T extends { unmount: () => void }>(
  mountedChildren: Array<{ unmount: () => void }>,
  host: HTMLElement | null,
  mount: (host: HTMLElement) => T,
): void {
  if (!host) {
    return;
  }
  mountedChildren.push(mount(host));
}
