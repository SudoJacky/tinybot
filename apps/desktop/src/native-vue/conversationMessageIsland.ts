import { computed, createApp, defineComponent, h, ref, type App, type PropType } from "vue";
import { NCard, NConfigProvider } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";
import { renderConversationAttachmentNode } from "./conversationAttachmentIsland";
import { renderConversationBodyNode } from "./conversationBodyIsland";
import type { ConversationReferenceIslandOptions } from "./conversationReferenceIsland";
import { renderToolActivitiesNode } from "./toolActivitiesIsland";
import type { ToolActivityIslandOptions } from "./toolActivityIsland";

export interface ConversationMessageIslandOptions {
  attachment?: string;
  author: string;
  body: string[];
  copyable?: boolean;
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
      return () => h(ConversationMessageContent, { options });
    },
  }));
}

const ConversationMessageContent = defineComponent({
  name: "ConversationMessageContent",
  props: {
    options: {
      required: true,
      type: Object as PropType<ConversationMessageIslandOptions>,
    },
  },
  setup(props) {
    const copyLabel = ref("Copy");
    const manualReasoningExpanded = ref<boolean | null>(null);
    const hasReasoning = computed(() => Boolean(props.options.reasoningContent?.trim()));
    const hasBody = computed(() => props.options.body.some((line) => line.trim()));
    const canCopy = computed(() => props.options.copyable !== false && hasBody.value);
    const reasoningExpanded = computed(() => {
      if (!hasReasoning.value) {
        return false;
      }
      return manualReasoningExpanded.value ?? !hasBody.value;
    });
    const copyMessage = (event: MouseEvent): void => {
      const button = event.currentTarget instanceof HTMLButtonElement ? event.currentTarget : null;
      const copyAttempt = writeClipboard(conversationCopyText(props.options), document);
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
    const toggleReasoning = () => {
      manualReasoningExpanded.value = !reasoningExpanded.value;
    };

    return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
      default: () => props.options.tone === "user"
        ? renderUserMessage(props.options)
        : h(NCard, {
          bordered: false,
          class: "desktop-conversation-content-card",
          size: "small",
        }, {
          default: () => h("div", { class: "desktop-conversation-content" }, [
            hasReasoning.value
              ? h("div", { class: "desktop-conversation-header" }, [
                renderReasoningToggle(
                  reasoningExpanded.value,
                  hasBody.value ? "Thinking complete" : "Thinking",
                  toggleReasoning,
                ),
              ])
              : null,
            hasReasoning.value && reasoningExpanded.value
              ? renderReasoningPanel(props.options.reasoningContent!)
              : null,
            props.options.toolActivities?.length ? renderToolActivitiesNode({ activities: props.options.toolActivities }) : null,
            renderConversationBodyNode({ body: props.options.body, tone: props.options.tone }),
            ...renderReferenceGroups(props.options.references),
            props.options.attachment ? renderConversationAttachmentNode({ name: props.options.attachment, sizeLabel: "1.2 MB" }) : null,
            canCopy.value ? h("div", { class: "desktop-message-actions" }, [
              renderCopyButton(copyLabel.value === "Copy" ? "Copy message" : copyLabel.value, copyMessage),
            ]) : null,
          ]),
        }),
    });
  },
});

export function renderConversationMessageNode(options: ConversationMessageIslandOptions) {
  return h("article", {
    class: "desktop-conversation-message",
    "data-desktop-vue-island": "conversation-message",
    "data-message-tone": options.tone,
  }, renderConversationMessageChildren(options));
}

export function renderConversationMessageChildren(options: ConversationMessageIslandOptions) {
  return h(ConversationMessageContent, { options });
}

function renderUserMessage(options: ConversationMessageIslandOptions) {
  return h("div", { class: "desktop-conversation-content desktop-user-message-bubble" }, [
    renderConversationBodyNode({ body: options.body, tone: options.tone }),
    ...renderReferenceGroups(options.references),
    options.attachment ? renderConversationAttachmentNode({ name: options.attachment, sizeLabel: "1.2 MB" }) : null,
  ]);
}

function renderReasoningToggle(expanded: boolean, label: string, onClick: (event: MouseEvent) => void) {
  return h("button", {
    "aria-expanded": String(expanded),
    "aria-label": expanded ? "Hide thinking" : "Show thinking",
    class: "desktop-message-reasoning-toggle",
    onClick,
    title: expanded ? "Hide thinking" : "Show thinking",
    type: "button",
  }, label);
}

function renderReasoningPanel(content: string) {
  return h("div", {
    class: "desktop-message-reasoning",
    "data-expanded": "true",
  }, [
    h("div", { class: "desktop-message-reasoning-body" }, content),
  ]);
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
