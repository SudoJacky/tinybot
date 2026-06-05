import { createApp, defineComponent, h, type App } from "vue";
import { NCard, NConfigProvider, NSpace, NTag } from "naive-ui";
import type { DesktopKnowledgePaneDocument } from "../desktopKnowledgeTraceability";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface KnowledgeDocumentDetailIslandOptions {
  document: DesktopKnowledgePaneDocument;
}

export interface MountedKnowledgeDocumentDetailIsland {
  unmount: () => void;
}

export function mountKnowledgeDocumentDetailIsland(
  host: HTMLElement,
  options: KnowledgeDocumentDetailIslandOptions,
): MountedKnowledgeDocumentDetailIsland {
  host.setAttribute("data-desktop-vue-island", "knowledge-document-detail");
  host.className = "desktop-knowledge-document-detail";
  const app = createKnowledgeDocumentDetailApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createKnowledgeDocumentDetailApp(options: KnowledgeDocumentDetailIslandOptions): App {
  return createApp(defineComponent({
    name: "KnowledgeDocumentDetailIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NCard, { size: "small", bordered: false }, {
          default: () => [
            h("h2", `Document detail: ${options.document.title}`),
            h("p", options.document.detail),
            h("p", `Tags: ${tagCopy(options.document.tags)}`),
            renderTags(options.document),
          ],
        }),
      });
    },
  }));
}

function tagCopy(tags: string[]): string {
  return tags.join(", ") || "none";
}

function renderTags(document: DesktopKnowledgePaneDocument) {
  const tags = document.tags.length ? document.tags : [document.status || document.category];
  return h(NSpace, { size: 4, wrap: true }, {
    default: () => tags.filter(Boolean).map((tag) => h(NTag, {
      size: "small",
      round: true,
      type: document.status === "indexed" ? "success" : "default",
    }, { default: () => tag })),
  });
}
