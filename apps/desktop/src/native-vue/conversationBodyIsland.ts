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
      const markdownHost = ref<HTMLElement | null>(null);
      onMounted(() => {
        if (options.tone === "assistant" && markdownHost.value) {
          renderConversationMarkdown(markdownHost.value, conversationBodyContent(options.body));
        }
      });
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => options.tone === "assistant"
          ? h("div", { ref: markdownHost })
          : options.body.filter((line) => line.trim()).map((line) => h(NText, { tag: "p" }, { default: () => line })),
      });
    },
  }));
}

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
  } catch {
    target.textContent = content;
  }
}

function addMarkdownLinkAttributes(html: string): string {
  return html.replace(/<a\s+(?![^>]*\btarget=)([^>]*href=)/gi, '<a target="_blank" rel="noreferrer" $1');
}
