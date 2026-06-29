import { computed, createApp, defineComponent, h, ref, type App } from "vue";
import { NConfigProvider, NEmpty, NTag } from "naive-ui";
import type { DesktopKnowledgeDocumentRow } from "../../knowledge/desktopKnowledgeTraceability";
import { desktopNaiveThemeOverrides } from "../shell/desktopNaiveTheme";

export interface KnowledgeDocumentsIslandOptions {
  documents: DesktopKnowledgeDocumentRow[];
  onDeleteDocument?: (document: DesktopKnowledgeDocumentRow) => void;
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
      const searchQuery = ref("");
      const filteredDocuments = computed(() => {
        const query = searchQuery.value.trim().toLowerCase();
        if (!query) {
          return options.documents;
        }
        return options.documents.filter((document) => documentMatchesSearch(document, query));
      });
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => [
          h("div", { class: "desktop-knowledge-documents-toolbar" }, [
            h("input", {
              "aria-label": "Search documents",
              "data-desktop-knowledge-document-search": "",
              placeholder: "Search documents...",
              type: "search",
              value: searchQuery.value,
              onInput: (event: Event) => {
                searchQuery.value = (event.target as HTMLInputElement).value;
              },
            }),
          ]),
          filteredDocuments.value.length
            ? renderDocumentsList(filteredDocuments.value, options)
            : h(NEmpty, {
              class: "desktop-knowledge-documents-empty",
              description: options.documents.length ? "No matching documents" : "No documents yet",
              size: "small",
            }),
        ],
      });
    },
  }));
}

function documentMatchesSearch(document: DesktopKnowledgeDocumentRow, query: string): boolean {
  return [
    document.title,
    document.path,
    document.category,
    document.typeLabel,
    document.status,
    document.meta,
    ...document.tags,
  ].some((value) => String(value ?? "").toLowerCase().includes(query));
}

function renderDocumentsList(documents: DesktopKnowledgeDocumentRow[], options: KnowledgeDocumentsIslandOptions) {
  return h("div", {
    class: "desktop-knowledge-documents-list",
    "data-desktop-knowledge-documents-list": "",
  }, documents.map((document) => {
    const attributes = [
      document.typeLabel || document.category || "DOC",
      document.sizeLabel,
      document.addedLabel,
    ].filter((value): value is string => Boolean(value));
    return h("article", {
      class: "desktop-knowledge-document-row",
      "data-desktop-entity-module": "knowledge",
      "data-desktop-entity-id": document.id || document.path,
    }, [
      h("div", { class: "desktop-knowledge-document-summary" }, [
        h("strong", document.title),
        h("span", { class: "desktop-knowledge-document-meta" }, document.meta),
      ]),
      h("div", { class: "desktop-knowledge-document-attributes" }, [
        ...attributes.map((attribute) => h("span", { class: "desktop-knowledge-document-attribute" }, attribute)),
        renderStatusTag(document),
      ]),
      h("button", {
        "data-desktop-knowledge-document-action": "deleteDocument",
        type: "button",
        onClick: () => options.onDeleteDocument?.(document),
      }, "Delete"),
    ]);
  }));
}

function renderStatusTag(document: DesktopKnowledgeDocumentRow) {
  const status = document.status || "unknown";
  return h(NTag, {
    size: "small",
    round: true,
    type: status === "indexed" ? "success" : status === "failed" ? "error" : "warning",
  }, { default: () => status });
}
