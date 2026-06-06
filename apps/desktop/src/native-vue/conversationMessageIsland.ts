import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref, type App } from "vue";
import { NCard, NConfigProvider } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";
import { mountConversationAttachmentIsland, renderConversationAttachmentNode } from "./conversationAttachmentIsland";
import { mountConversationBodyIsland, renderConversationBodyNode } from "./conversationBodyIsland";
import { mountConversationMetaIsland, renderConversationMetaNode } from "./conversationMetaIsland";
import { mountConversationReasoningIsland, renderConversationReasoningNode } from "./conversationReasoningIsland";
import { mountConversationReferenceIsland, renderConversationReferenceNode, type ConversationReferenceIslandOptions } from "./conversationReferenceIsland";
import { mountToolActivitiesIsland, renderToolActivitiesNode } from "./toolActivitiesIsland";
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
      const attachmentHost = ref<HTMLElement | null>(null);
      const bodyHost = ref<HTMLElement | null>(null);
      const metaHost = ref<HTMLElement | null>(null);
      const reasoningHost = ref<HTMLElement | null>(null);
      const referenceHosts = ref<Array<HTMLElement | null>>([]);
      const toolActivitiesHost = ref<HTMLElement | null>(null);
      const mountedChildren: Array<{ unmount: () => void }> = [];

      onMounted(() => {
        mountChild(mountedChildren, metaHost.value, (host) => mountConversationMetaIsland(host, {
          author: options.author,
          time: options.time,
        }));
        if (options.reasoningContent?.trim()) {
          mountChild(mountedChildren, reasoningHost.value, (host) => mountConversationReasoningIsland(host, {
            content: options.reasoningContent!,
          }));
        }
        if (options.toolActivities?.length) {
          mountChild(mountedChildren, toolActivitiesHost.value, (host) => mountToolActivitiesIsland(host, {
            activities: options.toolActivities!,
          }));
        }
        mountChild(mountedChildren, bodyHost.value, (host) => mountConversationBodyIsland(host, {
          body: options.body,
          tone: options.tone,
        }));
        options.references.forEach((reference, index) => {
          mountChild(mountedChildren, referenceHosts.value[index] ?? null, (host) => mountConversationReferenceIsland(host, reference));
        });
        if (options.attachment) {
          mountChild(mountedChildren, attachmentHost.value, (host) => mountConversationAttachmentIsland(host, {
            name: options.attachment!,
            sizeLabel: "1.2 MB",
          }));
        }
      });

      onBeforeUnmount(() => {
        while (mountedChildren.length) {
          mountedChildren.pop()?.unmount();
        }
      });

      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NCard, {
          class: "desktop-conversation-content-card",
          size: "small",
          bordered: false,
        }, {
          default: () => h("div", { class: "desktop-conversation-content" }, [
            h("div", { ref: metaHost, class: "desktop-conversation-meta" }),
            options.reasoningContent?.trim()
              ? h("details", { ref: reasoningHost, class: "desktop-message-reasoning" })
              : null,
            options.toolActivities?.length
              ? h("div", { ref: toolActivitiesHost, class: "desktop-tool-activities" })
              : null,
            h("div", { ref: bodyHost, class: "desktop-conversation-body" }),
            ...options.references.map((reference, index) => h("p", {
              ref: (element) => {
                referenceHosts.value[index] = element as HTMLElement | null;
              },
              class: "desktop-conversation-reference",
            })),
            options.attachment
              ? h("div", { ref: attachmentHost, class: "desktop-conversation-attachment" })
              : null,
          ]),
        }),
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
