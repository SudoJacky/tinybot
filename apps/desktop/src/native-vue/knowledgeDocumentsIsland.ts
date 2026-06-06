import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NEmpty, NList, NListItem, NSpace, NTag } from "naive-ui";
import type { DesktopKnowledgeDocumentRow } from "../desktopKnowledgeTraceability";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface KnowledgeDocumentsIslandOptions {
  documents: DesktopKnowledgeDocumentRow[];
}

export interface MountedKnowledgeDocumentsIsland {
  unmount: () => void;
}

export function mountKnowledgeDocumentsIsland(
  host: HTMLElement,
  options: KnowledgeDocumentsIslandOptions,
): MountedKnowledgeDocumentsIsland {
  host.setAttribute("data-desktop-vue-island", "knowledge-documents");
  host.className = "desktop-knowledge-documents";
  const app = createKnowledgeDocumentsApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createKnowledgeDocumentsApp(options: KnowledgeDocumentsIslandOptions): App {
  return createApp(defineComponent({
    name: "KnowledgeDocumentsIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => [
          h("h2", "Documents"),
          options.documents.length
            ? renderDocuments(options.documents)
            : h(NEmpty, {
              class: "desktop-knowledge-documents-empty",
              description: "No knowledge documents loaded.",
              size: "small",
            }),
        ],
      });
    },
  }));
}

function renderDocuments(documents: DesktopKnowledgeDocumentRow[]) {
  return h(NList, { bordered: false, hoverable: true }, {
    default: () => documents.map((document) => h(NListItem, {
      "data-desktop-entity-module": "knowledge",
      "data-desktop-entity-id": document.id || document.path,
    }, {
      default: () => h(NSpace, { vertical: true, size: 4 }, {
        default: () => [
          h("span", `${document.title}: ${document.meta}`),
          renderDocumentTags(document),
        ],
      }),
    })),
  });
}

function renderDocumentTags(document: DesktopKnowledgeDocumentRow) {
  const tags = document.tags.length ? document.tags : [document.category || document.status];
  return h(NSpace, { size: 4, wrap: true }, {
    default: () => tags.filter(Boolean).map((tag) => h(NTag, {
      size: "small",
      round: true,
      type: document.status === "indexed" ? "success" : "default",
    }, { default: () => tag })),
  });
}
