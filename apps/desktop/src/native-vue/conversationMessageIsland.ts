import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";
import { renderConversationAttachmentNode } from "./conversationAttachmentIsland";
import { renderConversationBodyNode } from "./conversationBodyIsland";
import { renderConversationMetaNode } from "./conversationMetaIsland";
import { renderConversationReasoningNode } from "./conversationReasoningIsland";
import { renderConversationReferenceNode, type ConversationReferenceIslandOptions } from "./conversationReferenceIsland";
import { renderToolActivitiesNode } from "./toolActivitiesIsland";
import type { ToolActivityIslandOptions } from "./toolActivityIsland";

export interface ConversationMessageIslandOptions {
  attachment?: string;
  author: string;
  body: string[];
  references: ConversationReferenceIslandOptions[];
  reasoningContent?: string;
  time: string;
  tone: "assistant" | "user";
  toolActivities?: ToolActivityIslandOptions[];
}

export interface MountedConversationMessageIsland {
  unmount: () => void;
}

export function mountConversationMessageIsland(
  host: HTMLElement,
  options: ConversationMessageIslandOptions,
): MountedConversationMessageIsland {
  host.setAttribute("data-desktop-vue-island", "conversation-message");
  host.className = "desktop-conversation-message";
  host.setAttribute("data-message-tone", options.tone);
  const app = createConversationMessageApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createConversationMessageApp(options: ConversationMessageIslandOptions): App {
  return createApp(defineComponent({
    name: "ConversationMessageIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => renderConversationMessageChildren(options),
      });
    },
  }));
}

export function renderConversationMessageNode(options: ConversationMessageIslandOptions) {
  return h("article", {
    class: "desktop-conversation-message",
    "data-message-tone": options.tone,
  }, renderConversationMessageChildren(options));
}

export function renderConversationMessageChildren(options: ConversationMessageIslandOptions) {
  return h("div", { class: "desktop-conversation-content" }, [
    renderConversationMetaNode({ author: options.author, time: options.time }),
    options.reasoningContent?.trim() ? renderConversationReasoningNode({ content: options.reasoningContent }) : null,
    options.toolActivities?.length ? renderToolActivitiesNode({ activities: options.toolActivities }) : null,
    renderConversationBodyNode({ body: options.body, tone: options.tone }),
    ...options.references.map((reference) => renderConversationReferenceNode(reference)),
    options.attachment ? renderConversationAttachmentNode({ name: options.attachment, sizeLabel: "1.2 MB" }) : null,
  ]);
}
