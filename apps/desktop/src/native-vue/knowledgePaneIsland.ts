import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref, type App, type Ref } from "vue";
import { NConfigProvider } from "naive-ui";
import type { DesktopTaskCenterItem } from "../desktopTaskCenter";
import type {
  DesktopKnowledgeDocumentRow,
  DesktopKnowledgePaneModel,
} from "../desktopKnowledgeTraceability";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";
import { mountFileUploadStatusIsland } from "./fileUploadStatusIsland";
import { mountKnowledgeDocumentDetailIsland } from "./knowledgeDocumentDetailIsland";
import { mountKnowledgeDocumentsIsland } from "./knowledgeDocumentsIsland";
import { mountKnowledgeGraphIsland } from "./knowledgeGraphIsland";
import { mountKnowledgeReadinessIsland } from "./knowledgeReadinessIsland";
import { mountModuleWorkSectionIsland } from "./moduleWorkSectionIsland";

export type KnowledgePaneActionId = "refreshAll" | "settings" | "runQuery" | "refreshGraph" | "rebuildIndex" | "deleteDocument" | "uploadDocument";

export interface KnowledgePaneActionEvent {
  action: KnowledgePaneActionId;
  pane: DesktopKnowledgePaneModel;
  documentId?: string;
}

export interface KnowledgePaneIslandOptions {
  pane: DesktopKnowledgePaneModel;
  workItems?: DesktopTaskCenterItem[];
  onInspectWorkItem?: (item: DesktopTaskCenterItem) => void;
  onKnowledgeAction?: (event: KnowledgePaneActionEvent) => void;
}

export interface MountedKnowledgePaneIsland {
  unmount: () => void;
}

export function mountKnowledgePaneIsland(
  host: HTMLElement,
  options: KnowledgePaneIslandOptions,
): MountedKnowledgePaneIsland {
  host.setAttribute("data-desktop-vue-island", "knowledge-pane");
  host.className = "desktop-workbench-section desktop-knowledge-pane";
  host.setAttribute("data-desktop-module-surface", "knowledge");
  host.setAttribute("aria-label", "Knowledge workbench");

  const app = createKnowledgePaneApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createKnowledgePaneApp(options: KnowledgePaneIslandOptions): App {
  return createApp(defineComponent({
    name: "KnowledgePaneIsland",
    setup() {
      const mountedChildren: Array<{ unmount: () => void }> = [];
      const work = ref<HTMLElement | null>(null);
      const readiness = ref<HTMLElement | null>(null);
      const uploadStatus = ref<HTMLElement | null>(null);
      const documents = ref<HTMLElement | null>(null);
      const documentDetail = ref<HTMLElement | null>(null);
      const graph = ref<HTMLElement | null>(null);

      onMounted(() => {
        if (options.workItems?.length) {
          mountChild(mountedChildren, work.value, (host) => mountModuleWorkSectionIsland(host, {
            title: "Knowledge jobs",
            items: options.workItems ?? [],
            onInspect: options.onInspectWorkItem,
          }));
        }
        mountChild(mountedChildren, readiness.value, (host) => mountKnowledgeReadinessIsland(host, {
          readiness: options.pane.readiness,
          configHints: options.pane.configHints,
        }));
        mountChild(mountedChildren, uploadStatus.value, (host) => mountFileUploadStatusIsland(host, {
          message: "No file operation running.",
        }));
        mountChild(mountedChildren, documents.value, (host) => mountKnowledgeDocumentsIsland(host, {
          documents: options.pane.documentRows,
          onDeleteDocument: (document) => options.onKnowledgeAction?.({
            action: "deleteDocument",
            pane: options.pane,
            documentId: document.id || document.path,
          }),
        }));
        if (options.pane.selectedDocument) {
          mountChild(mountedChildren, documentDetail.value, (host) => mountKnowledgeDocumentDetailIsland(host, {
            document: options.pane.selectedDocument!,
          }));
        }
        mountChild(mountedChildren, graph.value, (host) => mountKnowledgeGraphIsland(host, {
          graph: options.pane.graph,
        }));
      });

      onBeforeUnmount(() => {
        while (mountedChildren.length) {
          mountedChildren.pop()?.unmount();
        }
      });

      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h("div", { class: "desktop-knowledge-workbench" }, [
          renderKnowledgeHeader(options),
          h("div", {
            class: "desktop-knowledge-management-grid",
            "data-desktop-knowledge-layout": "source-left-graph-right",
          }, [
            h("section", {
              class: "desktop-knowledge-region desktop-knowledge-overview",
              "data-desktop-knowledge-region": "overview",
              "aria-label": "Knowledge base overview",
            }, renderKnowledgeOverview(options.pane)),
            renderKnowledgeUploadRegion(options, uploadStatus),
            renderKnowledgeQueueRegion(options),
            renderKnowledgeDocumentsRegion(options, documents, documentDetail),
            renderKnowledgeGraphRegion(options, graph),
            renderKnowledgePipelineRegion(options, readiness, work),
          ]),
        ]),
      });
    },
  }));
}

function renderKnowledgeHeader(options: KnowledgePaneIslandOptions) {
  return h("div", { class: "desktop-knowledge-header" }, [
    h("div", { class: "desktop-knowledge-title-block" }, [
      h("p", { class: "desktop-knowledge-kicker" }, "Knowledge Base"),
      h("h2", "Knowledge Base"),
      h("p", "Manage your knowledge base, monitor ingestion, and explore the knowledge graph."),
      h("p", { class: "desktop-knowledge-status" }, options.pane.status),
    ]),
    h("div", { class: "desktop-knowledge-toolbar" }, [
      renderKnowledgeActionButton(options, "refreshAll", "Refresh All", "secondary"),
      renderKnowledgeActionButton(options, "settings", "Settings", "secondary"),
      renderKnowledgeActionButton(options, "uploadDocument", "Upload Documents", "primary"),
    ]),
  ]);
}

function renderKnowledgeUploadRegion(options: KnowledgePaneIslandOptions, uploadStatus: Ref<HTMLElement | null>) {
  return h("section", {
    class: "desktop-knowledge-region desktop-knowledge-upload-region",
    "data-desktop-knowledge-region": "upload",
    "aria-label": "Upload knowledge documents",
  }, [
    h("div", { class: "desktop-knowledge-region-header" }, [
      h("div", [
        h("h3", "Upload Documents"),
        h("p", "Add files to your knowledge base. We'll parse, chunk, and index them."),
      ]),
      renderKnowledgeActionButton(options, "uploadDocument", "Upload Documents", "primary"),
    ]),
    h("div", {
      class: "desktop-knowledge-drop-zone",
      "data-desktop-drop-target": "knowledge-document",
    }, [
      h("strong", "Drag & drop files here or click to browse"),
      h("span", "PDF, DOCX, MD, TXT, CSV, JSON"),
      h("small", "Max 200MB per file"),
    ]),
    h("p", { ref: uploadStatus }),
    renderKnowledgeUploadControl(),
  ]);
}

function renderKnowledgeQueueRegion(options: KnowledgePaneIslandOptions) {
  const queueRows = options.pane.documentRows.slice(0, 2);
  return h("section", {
    class: "desktop-knowledge-region desktop-knowledge-queue-region",
    "data-desktop-knowledge-region": "queue",
    "aria-label": "Knowledge ingestion queue",
  }, [
    h("div", { class: "desktop-knowledge-region-header" }, [
      h("div", [
        h("h3", `Ingestion Queue${queueRows.length ? ` (${queueRows.length})` : ""}`),
        h("p", "Track files as they move through parsing and indexing."),
      ]),
    ]),
    queueRows.length
      ? h("div", { class: "desktop-knowledge-queue-list" }, queueRows.map((document, index) => renderKnowledgeQueueRow(document, index)))
      : h("p", { class: "desktop-knowledge-empty-note" }, "No ingestion jobs running."),
  ]);
}

function renderKnowledgeDocumentsRegion(
  options: KnowledgePaneIslandOptions,
  documents: Ref<HTMLElement | null>,
  documentDetail: Ref<HTMLElement | null>,
) {
  return h("section", {
    class: "desktop-knowledge-region desktop-knowledge-documents-region",
    "data-desktop-knowledge-region": "documents",
    "aria-label": "Knowledge documents",
  }, [
    h("div", { class: "desktop-knowledge-region-header" }, [
      h("div", [
        h("h3", `Documents (${options.pane.documentRows.length})`),
        h("p", "Search, filter, inspect, re-index, and delete knowledge sources."),
      ]),
    ]),
    h("section", { ref: documents }),
    options.pane.selectedDocument ? h("section", { ref: documentDetail }) : null,
  ]);
}

function renderKnowledgeGraphRegion(options: KnowledgePaneIslandOptions, graph: Ref<HTMLElement | null>) {
  return h("section", {
    class: "desktop-knowledge-region desktop-knowledge-graph-region",
    "data-desktop-knowledge-region": "graph",
    "aria-label": "Knowledge graph",
  }, [
    h("div", { class: "desktop-knowledge-region-header" }, [
      h("div", [
        h("h3", "Knowledge Graph"),
        h("p", "Explore entities and their relationships."),
      ]),
      h("div", { class: "desktop-knowledge-action-row" }, [
        renderKnowledgeActionButton(options, "rebuildIndex", "Build Graph", "secondary"),
        renderKnowledgeActionButton(options, "refreshGraph", "Refresh Graph", "secondary"),
        h("button", { class: "desktop-knowledge-action-button desktop-knowledge-action-button-secondary", type: "button" }, "Fit View"),
        h("button", { class: "desktop-knowledge-action-button desktop-knowledge-action-button-secondary", type: "button" }, "Layout"),
      ]),
    ]),
    h("section", { ref: graph }),
  ]);
}

function renderKnowledgePipelineRegion(
  options: KnowledgePaneIslandOptions,
  readiness: Ref<HTMLElement | null>,
  work: Ref<HTMLElement | null>,
) {
  return h("section", {
    class: "desktop-knowledge-region desktop-knowledge-pipeline",
    "data-desktop-knowledge-region": "pipeline",
    "aria-label": "Knowledge indexing pipeline",
  }, [
    h("div", { class: "desktop-knowledge-region-header" }, [
      h("div", [
        h("h3", "Indexing Pipeline"),
        h("p", "Track ingestion and indexing progress."),
      ]),
    ]),
    h("section", { ref: readiness }),
    options.workItems?.length ? h("section", { ref: work }) : null,
  ]);
}

function renderKnowledgeQueueRow(document: DesktopKnowledgeDocumentRow, index: number) {
  const progress = document.progressPercent;
  const stage = document.phaseLabel;
  return h("article", { class: "desktop-knowledge-queue-row" }, [
    h("div", { class: "desktop-knowledge-queue-file" }, [
      h("strong", document.title),
      h("span", `${document.typeLabel || "DOC"} / ${document.sizeLabel || "-"} / ${stage}`),
      h("small", document.progressDetail),
    ]),
    h("div", { class: "desktop-knowledge-queue-progress", "aria-label": `${stage} ${progress}%` }, [
      h("span", { style: { width: `${progress}%` } }),
    ]),
    h("span", { class: "desktop-knowledge-queue-percent" }, progress ? `${progress}%` : "-"),
    h("button", { "data-desktop-knowledge-queue-action": "pause", type: "button", disabled: index > 0 }, "Pause"),
    h("button", { "data-desktop-knowledge-queue-action": "cancel", type: "button" }, "Cancel"),
  ]);
}

function renderKnowledgeUploadControl() {
  return h("button", {
    id: "desktop-knowledge-upload",
    class: "desktop-knowledge-upload-control",
    "aria-hidden": "true",
    "data-desktop-file-upload": "knowledge-document",
    tabindex: "-1",
    type: "button",
  }, "Upload knowledge document");
}

function renderKnowledgeOverview(pane: DesktopKnowledgePaneModel) {
  const documentCount = pane.documentRows.length;
  const chunkCount = pane.documentRows.reduce((total, row) => total + row.chunkCount, 0);
  const nodeCount = pane.graph.view.nodes.length;
  const edgeCount = pane.graph.view.edges.length;
  return [
    renderKnowledgeMetric("Documents", String(documentCount), "Uploaded sources"),
    renderKnowledgeMetric("Readiness", `${pane.readiness.score}%`, `${chunkCount} indexed chunks`),
    renderKnowledgeMetric("Graph Nodes", String(nodeCount), `${pane.graph.evidence.length} evidence`),
    renderKnowledgeMetric("Relations", String(edgeCount), "Graph edges"),
    renderKnowledgeMetric("Last Indexed", pane.lastIndexedLabel, "Knowledge freshness"),
  ];
}

function renderKnowledgeMetric(label: string, value: string, detail: string) {
  return h("article", { class: "desktop-knowledge-metric" }, [
    h("span", { class: "desktop-knowledge-metric-label" }, label),
    h("strong", value),
    h("span", { class: "desktop-knowledge-metric-detail" }, detail),
  ]);
}

function renderKnowledgeActionButton(
  options: KnowledgePaneIslandOptions,
  action: KnowledgePaneActionId,
  label: string,
  variant: "primary" | "secondary",
) {
  const enabled = knowledgeActionEnabled(options.pane, action);
  return h("button", {
    class: `desktop-knowledge-action-button desktop-knowledge-action-button-${variant}`,
    "data-desktop-knowledge-action": action,
    disabled: !enabled,
    type: "button",
    onClick: () => options.onKnowledgeAction?.({ action, pane: options.pane }),
  }, label);
}

function knowledgeActionEnabled(pane: DesktopKnowledgePaneModel, action: KnowledgePaneActionId): boolean {
  if (action === "uploadDocument") {
    return pane.actions.upload;
  }
  if (action === "refreshGraph") {
    return pane.actions.refreshGraph;
  }
  if (action === "runQuery") {
    return pane.actions.query;
  }
  if (action === "rebuildIndex") {
    return pane.actions.rebuild;
  }
  if (action === "deleteDocument") {
    return pane.actions.deleteDocument;
  }
  return true;
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
