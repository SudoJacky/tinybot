import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NTag, NText } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface ConversationAttachmentIslandOptions {
  name: string;
  sizeLabel: string;
}

export interface MountedConversationAttachmentIsland {
  unmount: () => void;
}

export function mountConversationAttachmentIsland(
  host: HTMLElement,
  options: ConversationAttachmentIslandOptions,
): MountedConversationAttachmentIsland {
  host.setAttribute("data-desktop-vue-island", "conversation-attachment");
  host.className = "desktop-conversation-attachment";
  const app = createConversationAttachmentApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createConversationAttachmentApp(options: ConversationAttachmentIslandOptions): App {
  return createApp(defineComponent({
    name: "ConversationAttachmentIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => renderConversationAttachmentChildren(options),
      });
    },
  }));
}

export function renderConversationAttachmentNode(options: ConversationAttachmentIslandOptions) {
  return h("div", {
    class: "desktop-conversation-attachment",
    "data-desktop-vue-island": "conversation-attachment",
  }, renderConversationAttachmentChildren(options));
}

export function renderConversationAttachmentChildren(options: ConversationAttachmentIslandOptions) {
  return [
    h(NText, { tag: "span" }, { default: () => options.name }),
    options.sizeLabel ? "  " : "",
    options.sizeLabel
      ? h(NTag, { bordered: false, round: true, size: "small" }, { default: () => options.sizeLabel })
      : null,
  ];
}
