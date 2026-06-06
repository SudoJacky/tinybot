import hljs from "highlight.js";
import { marked } from "marked";
import { createApp, defineComponent, h, onMounted, ref, type App } from "vue";
import { NConfigProvider, NText } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface ConversationBodyIslandOptions {
  body: string[];
  tone: "assistant" | "user";
}

export interface MountedConversationBodyIsland {
  unmount: () => void;
}

export function mountConversationBodyIsland(
  host: HTMLElement,
  options: ConversationBodyIslandOptions,
): MountedConversationBodyIsland {
  host.setAttribute("data-desktop-vue-island", "conversation-body");
  host.className = "desktop-conversation-body";
  const app = createConversationBodyApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createConversationBodyApp(options: ConversationBodyIslandOptions): App {
  return createApp(defineComponent({
    name: "ConversationBodyIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => renderConversationBodyChildren(options),
      });
    },
  }));
}

export function renderConversationBodyNode(options: ConversationBodyIslandOptions) {
  return h("div", { class: "desktop-conversation-body" }, renderConversationBodyChildren(options));
}

export function renderConversationBodyChildren(options: ConversationBodyIslandOptions) {
  if (options.tone === "assistant") {
    return h(ConversationMarkdownBody, { content: conversationBodyContent(options.body) });
  }
  return options.body.filter((line) => line.trim()).map((line) => h(NText, { tag: "p" }, { default: () => line }));
}

const ConversationMarkdownBody = defineComponent({
  name: "ConversationMarkdownBody",
  props: {
    content: {
      required: true,
      type: String,
    },
  },
  setup(props) {
    const markdownHost = ref<HTMLElement | null>(null);
    onMounted(() => {
      if (markdownHost.value) {
        renderConversationMarkdown(markdownHost.value, props.content);
      }
    });
    return () => h("div", { ref: markdownHost });
  },
});

function conversationBodyContent(body: string[]): string {
  return body.filter((line) => line.trim()).join("\n\n");
}

function renderConversationMarkdown(target: HTMLElement, content: string): void {
  target.textContent = "";
  if (!content.trim()) {
    return;
  }
  try {
    const html = marked.parse(content, { breaks: true, gfm: true, async: false });
    target.innerHTML = addMarkdownLinkAttributes(typeof html === "string" ? html : content);
    target.querySelectorAll("pre code").forEach((block) => {
      hljs.highlightElement(block as HTMLElement);
    });
    addCodeCopyButtons(target);
  } catch {
    target.textContent = content;
  }
}

function addMarkdownLinkAttributes(html: string): string {
  return html.replace(/<a\s+(?![^>]*\btarget=)([^>]*href=)/gi, '<a target="_blank" rel="noreferrer" $1');
}

function addCodeCopyButtons(target: HTMLElement): void {
  target.querySelectorAll("pre").forEach((pre) => {
    if (pre.querySelector(".desktop-code-copy-button")) {
      return;
    }
    const button = target.ownerDocument.createElement("button");
    button.type = "button";
    button.className = "desktop-code-copy-button";
    button.setAttribute("aria-label", "Copy code");
    button.textContent = "Copy";
    button.addEventListener("click", () => {
      const code = pre.querySelector("code");
      const copyAttempt = writeClipboard((code?.textContent ?? pre.textContent ?? "").trimEnd(), target.ownerDocument);
      button.textContent = "Copied";
      void copyAttempt
        .catch(() => {
          button.textContent = "Failed";
        });
    });
    pre.append(button);
  });
}

async function writeClipboard(text: string, ownerDocument: Document): Promise<void> {
  const clipboard = ownerDocument.defaultView?.navigator?.clipboard
    ?? (typeof navigator !== "undefined" ? navigator.clipboard : undefined);
  if (!clipboard?.writeText) {
    throw new Error("Clipboard is unavailable.");
  }
  return clipboard.writeText(text);
}
