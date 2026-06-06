import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NText } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface ConversationMetaIslandOptions {
  author: string;
  time: string;
}

export interface MountedConversationMetaIsland {
  unmount: () => void;
}

export function mountConversationMetaIsland(
  host: HTMLElement,
  options: ConversationMetaIslandOptions,
): MountedConversationMetaIsland {
  host.setAttribute("data-desktop-vue-island", "conversation-meta");
  host.className = "desktop-conversation-meta";
  const app = createConversationMetaApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createConversationMetaApp(options: ConversationMetaIslandOptions): App {
  return createApp(defineComponent({
    name: "ConversationMetaIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => renderConversationMetaChildren(options),
      });
    },
  }));
}

export function renderConversationMetaNode(options: ConversationMetaIslandOptions) {
  return h("div", { class: "desktop-conversation-meta" }, renderConversationMetaChildren(options));
}

export function renderConversationMetaChildren(options: ConversationMetaIslandOptions) {
  return [
    h(NText, { strong: true, tag: "strong" }, { default: () => options.author }),
    h("span", { class: "desktop-conversation-meta-separator", "aria-hidden": "true" }, " · "),
    h(NText, { depth: 3, tag: "span" }, { default: () => options.time }),
  ];
}
