import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NTag, NText } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface ConversationReferenceIslandOptions {
  detail: string;
  kind: string;
  title: string;
}

export interface MountedConversationReferenceIsland {
  unmount: () => void;
}

export function mountConversationReferenceIsland(
  host: HTMLElement,
  options: ConversationReferenceIslandOptions,
): MountedConversationReferenceIsland {
  host.setAttribute("data-desktop-vue-island", "conversation-reference");
  host.className = "desktop-conversation-reference";
  const app = createConversationReferenceApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createConversationReferenceApp(options: ConversationReferenceIslandOptions): App {
  return createApp(defineComponent({
    name: "ConversationReferenceIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => renderConversationReferenceChildren(options),
      });
    },
  }));
}

export function renderConversationReferenceNode(options: ConversationReferenceIslandOptions) {
  return h("p", { class: "desktop-conversation-reference" }, renderConversationReferenceChildren(options));
}

export function renderConversationReferenceChildren(options: ConversationReferenceIslandOptions) {
  return [
    h(NTag, {
      bordered: false,
      round: true,
      size: "small",
    }, { default: () => `${options.kind}:` }),
    " ",
    h(NText, { tag: "span" }, { default: () => conversationReferenceText(options) }),
  ];
}

function conversationReferenceText(options: ConversationReferenceIslandOptions): string {
  return `${options.title}${options.detail ? ` - ${options.detail}` : ""}`;
}
