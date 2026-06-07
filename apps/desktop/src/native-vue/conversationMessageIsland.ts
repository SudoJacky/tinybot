import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref, type App } from "vue";
import { NCard, NConfigProvider } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";
import { mountConversationAttachmentIsland, renderConversationAttachmentNode } from "./conversationAttachmentIsland";
import { mountConversationBodyIsland, renderConversationBodyNode } from "./conversationBodyIsland";
import { mountConversationMetaIsland, renderConversationMetaNode } from "./conversationMetaIsland";
import type { ConversationReferenceIslandOptions } from "./conversationReferenceIsland";
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
  host.replaceChildren();
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
      const toolActivitiesHost = ref<HTMLElement | null>(null);
      const mountedChildren: Array<{ unmount: () => void }> = [];
      const copyLabel = ref("Copy");
      const reasoningExpanded = ref(false);
      const hasReasoning = Boolean(options.reasoningContent?.trim());
      const copyMessage = (event: MouseEvent): void => {
        const button = event.currentTarget instanceof HTMLButtonElement ? event.currentTarget : null;
        const copyAttempt = writeClipboard(conversationCopyText(options), document);
        copyLabel.value = "Copied";
        if (button) {
          button.setAttribute("aria-label", "Copied");
          button.setAttribute("title", "Copied");
        }
        void copyAttempt
          .catch(() => {
            copyLabel.value = "Failed";
            if (button) {
              button.setAttribute("aria-label", "Failed");
              button.setAttribute("title", "Failed");
            }
          });
      };

      onMounted(() => {
        mountChild(mountedChildren, metaHost.value, (host) => mountConversationMetaIsland(host, {
          author: options.author,
          time: options.time,
        }));
        if (options.toolActivities?.length) {
          mountChild(mountedChildren, toolActivitiesHost.value, (host) => mountToolActivitiesIsland(host, {
            activities: options.toolActivities!,
          }));
        }
        mountChild(mountedChildren, bodyHost.value, (host) => mountConversationBodyIsland(host, {
          body: options.body,
          tone: options.tone,
        }));
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
            h("div", { class: "desktop-conversation-header" }, [
              h("div", { ref: metaHost, class: "desktop-conversation-meta" }),
              hasReasoning
                ? renderReasoningToggle(reasoningExpanded.value, () => {
                  reasoningExpanded.value = !reasoningExpanded.value;
                })
                : null,
            ]),
            hasReasoning && reasoningExpanded.value
              ? renderReasoningPanel(options.reasoningContent!)
              : null,
            options.toolActivities?.length
              ? h("div", {
                ref: toolActivitiesHost,
                "aria-label": "Tool Timeline",
                class: "desktop-tool-activities",
                "data-desktop-chat-region": "tool-timeline",
              })
              : null,
            h("div", { ref: bodyHost, class: "desktop-conversation-body" }),
            ...renderReferenceGroups(options.references),
            options.attachment
              ? h("div", { ref: attachmentHost, class: "desktop-conversation-attachment" })
              : null,
            options.tone === "assistant"
              ? h("div", { class: "desktop-message-actions" }, [
                renderCopyButton(copyLabel.value === "Copy" ? "Copy message" : copyLabel.value, copyMessage),
              ])
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
    "data-desktop-vue-island": "conversation-message",
    "data-message-tone": options.tone,
  }, renderConversationMessageChildren(options));
}

export function renderConversationMessageChildren(options: ConversationMessageIslandOptions) {
  return h("div", { class: "desktop-conversation-content" }, [
    h("div", { class: "desktop-conversation-header" }, [
      renderConversationMetaNode({ author: options.author, time: options.time }),
      options.reasoningContent?.trim() ? renderReasoningToggle(false, () => {}) : null,
    ]),
    options.toolActivities?.length ? renderToolActivitiesNode({ activities: options.toolActivities }) : null,
    renderConversationBodyNode({ body: options.body, tone: options.tone }),
    ...renderReferenceGroups(options.references),
    options.attachment ? renderConversationAttachmentNode({ name: options.attachment, sizeLabel: "1.2 MB" }) : null,
    options.tone === "assistant"
      ? h("div", { class: "desktop-message-actions" }, [
        renderCopyButton("Copy message", () => {
          void writeClipboard(conversationCopyText(options), document);
        }),
      ])
      : null,
  ]);
}

function renderReasoningToggle(expanded: boolean, onClick: (event: MouseEvent) => void) {
  return h("button", {
    "aria-expanded": String(expanded),
    "aria-label": expanded ? "Hide details" : "Show details",
    class: "desktop-message-reasoning-toggle",
    onClick,
    title: expanded ? "Hide details" : "Show details",
    type: "button",
  }, "Details");
}

function renderReasoningPanel(content: string) {
  return h("div", {
    class: "desktop-message-reasoning",
    "data-expanded": "true",
  }, [
    h("div", { class: "desktop-message-reasoning-body" }, content),
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

function renderReferenceGroups(references: ConversationReferenceIslandOptions[]) {
  if (!references.length) {
    return [];
  }
  return [h("div", { class: "desktop-message-references" }, groupReferences(references).map((group) => h("details", {
    class: `desktop-message-reference-group desktop-message-reference-group-${group.id}`,
  }, [
    h("summary", { class: "desktop-message-references-summary" }, [
      h("span", { class: "desktop-message-references-title" }, group.label),
      h("span", { class: "desktop-message-references-count" }, `${group.references.length} ${group.references.length === 1 ? "source" : "sources"}`),
    ]),
      h("div", { class: "desktop-message-reference-list" }, group.references.map((reference) => h("article", {
      class: "desktop-message-reference-item desktop-conversation-reference",
      "data-desktop-vue-island": "conversation-reference",
      "data-desktop-reference-kind": reference.kind,
    }, [
      h("span", { class: "desktop-message-reference-kind" }, `${reference.kind}: `),
      h("strong", { class: "desktop-message-reference-title" }, reference.title),
      reference.detail ? h("span", { class: "desktop-message-reference-detail" }, reference.detail) : null,
    ]))),
  ])))];
}

function renderCopyButton(label: string, onClick: (event: MouseEvent) => void) {
  return h("button", {
    "aria-label": label,
    class: "desktop-message-copy-button",
    onClick,
    title: label,
    type: "button",
  }, [
    h("span", { "aria-hidden": "true", class: "desktop-message-copy-icon" }),
  ]);
}

function groupReferences(references: ConversationReferenceIslandOptions[]): Array<{
  id: string;
  label: string;
  references: ConversationReferenceIslandOptions[];
}> {
  const groups: Array<{ id: string; label: string; references: ConversationReferenceIslandOptions[] }> = [];
  for (const reference of references) {
    const id = normalizeReferenceKind(reference.kind);
    const existing = groups.find((group) => group.id === id);
    if (existing) {
      existing.references.push(reference);
    } else {
      groups.push({ id, label: referenceGroupLabel(id), references: [reference] });
    }
  }
  return groups;
}

function normalizeReferenceKind(kind: string): string {
  const normalized = kind.toLowerCase();
  if (normalized.includes("memory")) {
    return "memory";
  }
  if (normalized.includes("recent")) {
    return "recent";
  }
  if (normalized.includes("browser")) {
    return "browser";
  }
  if (normalized.includes("file") || normalized.includes("reference")) {
    return "file";
  }
  return "reference";
}

function referenceGroupLabel(kind: string): string {
  if (kind === "memory") {
    return "Memory references";
  }
  if (kind === "recent") {
    return "Recent context";
  }
  if (kind === "browser") {
    return "Browser references";
  }
  if (kind === "file") {
    return "File references";
  }
  return "References";
}

function conversationCopyText(options: ConversationMessageIslandOptions): string {
  return options.body.filter((line) => line.trim()).join("\n\n");
}

async function writeClipboard(text: string, ownerDocument: Document): Promise<void> {
  const clipboard = ownerDocument.defaultView?.navigator?.clipboard
    ?? (typeof navigator !== "undefined" ? navigator.clipboard : undefined);
  if (!clipboard?.writeText) {
    throw new Error("Clipboard is unavailable.");
  }
  return clipboard.writeText(text);
}
