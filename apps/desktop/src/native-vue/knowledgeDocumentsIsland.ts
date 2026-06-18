import { computed, createApp, defineComponent, h, ref, type App } from "vue";
import { NConfigProvider, NEmpty, NTag } from "naive-ui";
import type { DesktopKnowledgeDocumentRow } from "../desktopKnowledgeTraceability";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

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
            ? renderDocumentsTable(filteredDocuments.value, options)
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

function renderDocumentsTable(documents: DesktopKnowledgeDocumentRow[], options: KnowledgeDocumentsIslandOptions) {
  return h("table", { class: "desktop-knowledge-documents-table", "data-desktop-knowledge-documents-table": "" }, [
    h("thead", [
      h("tr", [
        h("th", "Name"),
        h("th", "Type"),
        h("th", "Size"),
        h("th", "Status"),
        h("th", "Added"),
        h("th", "Actions"),
      ]),
    ]),
    h("tbody", documents.map((document) => h("tr", {
      "data-desktop-entity-module": "knowledge",
      "data-desktop-entity-id": document.id || document.path,
    }, [
      h("td", [
        h("strong", document.title),
        h("span", { class: "desktop-knowledge-document-meta" }, document.meta),
      ]),
      h("td", document.typeLabel || document.category || "DOC"),
      h("td", document.sizeLabel || "-"),
      h("td", renderStatusTag(document)),
      h("td", document.addedLabel || "-"),
      h("td", [
        h("button", {
          "data-desktop-knowledge-document-action": "deleteDocument",
          type: "button",
          onClick: () => options.onDeleteDocument?.(document),
        }, "Delete"),
      ]),
    ]))),
  ]);
}

function renderStatusTag(document: DesktopKnowledgeDocumentRow) {
  const status = document.status || "unknown";
  return h(NTag, {
    size: "small",
    round: true,
    type: status === "indexed" ? "success" : status === "failed" ? "error" : "warning",
  }, { default: () => status });
}
