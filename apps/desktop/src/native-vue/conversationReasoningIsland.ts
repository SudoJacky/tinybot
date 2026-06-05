import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NText } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface ConversationReasoningIslandOptions {
  content: string;
}

export interface MountedConversationReasoningIsland {
  unmount: () => void;
}

export function mountConversationReasoningIsland(
  host: HTMLElement,
  options: ConversationReasoningIslandOptions,
): MountedConversationReasoningIsland {
  host.setAttribute("data-desktop-vue-island", "conversation-reasoning");
  host.className = "desktop-message-reasoning";
  const app = createConversationReasoningApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createConversationReasoningApp(options: ConversationReasoningIslandOptions): App {
  return createApp(defineComponent({
    name: "ConversationReasoningIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => [
          h("summary", { class: "desktop-message-reasoning-summary" }, [
            h(NText, { class: "desktop-message-reasoning-title", tag: "span" }, { default: () => "Thinking" }),
            h(NText, { class: "desktop-message-reasoning-meta", depth: 3, tag: "span" }, { default: () => "Show details" }),
          ]),
          h(NText, { class: "desktop-message-reasoning-body", tag: "div" }, { default: () => options.content }),
        ],
      });
    },
  }));
}
