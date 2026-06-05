import { createApp, defineComponent, h, type App } from "vue";
import { NButton, NCard, NConfigProvider, NEmpty, NList, NListItem, NProgress, NSpace, NTag } from "naive-ui";
import type { DesktopTaskCenterItem } from "../desktopTaskCenter";
import type {
  DesktopKnowledgeDocumentRow,
  DesktopKnowledgeEvidenceRow,
  DesktopKnowledgePaneDocument,
  DesktopKnowledgePaneGraph,
  DesktopKnowledgePaneModel,
  DesktopKnowledgePaneReferenceRow,
  DesktopKnowledgeQueryResultRow,
  DesktopKnowledgeReadinessRow,
} from "../desktopKnowledgeTraceability";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";
import { renderModuleWorkSectionSurface } from "./moduleWorkSectionIsland";

export type KnowledgePaneActionId = "runQuery" | "refreshGraph" | "rebuildIndex" | "deleteDocument" | "uploadDocument";

export interface KnowledgePaneActionEvent {
  action: KnowledgePaneActionId;
  pane: DesktopKnowledgePaneModel;
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

interface KnowledgeActionItem {
  action: KnowledgePaneActionId;
  label: string;
  enabled: boolean;
}

const KNOWLEDGE_REFERENCE_LIMIT = 4;

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
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => [
          h("h2", "Knowledge"),
          h("p", options.pane.status),
          renderActions(options),
          ...(options.workItems?.length
            ? [renderModuleWorkSectionSurface({
              title: "Knowledge jobs",
              items: options.workItems,
              onInspect: options.onInspectWorkItem,
            })]
            : []),
          renderReadiness(options.pane),
          renderDocuments(options.pane.documentRows),
          options.pane.selectedDocument ? renderDocumentDetail(options.pane.selectedDocument) : null,
          renderQuery(options.pane),
          renderGraph(options.pane.graph),
        ],
      });
    },
  }));
}

function renderActions(options: KnowledgePaneIslandOptions) {
  const actions = knowledgeActions(options.pane);
  return h("div", { class: "desktop-knowledge-actions" }, [
    h(NSpace, { size: 8, wrap: true }, {
      default: () => actions.map((item) => h(NButton, {
        "data-desktop-knowledge-action": item.action,
        disabled: !item.enabled,
        secondary: true,
        size: "small",
        type: actionButtonType(item.action),
        onClick: () => {
          if (item.enabled) {
            options.onKnowledgeAction?.({ action: item.action, pane: options.pane });
          }
        },
      }, { default: () => item.label })),
    }),
  ]);
}

function renderReadiness(pane: DesktopKnowledgePaneModel) {
  return h("section", { class: "desktop-knowledge-readiness" }, [
    h(NCard, { size: "small", bordered: false }, {
      default: () => [
        h("h2", "Readiness"),
        h(NProgress, {
          percentage: pane.readiness.score,
          processing: pane.readiness.partialAvailability,
          status: readinessProgressStatus(pane),
          type: "line",
        }),
        h("p", `Score: ${pane.readiness.score}%`),
        h(NSpace, { vertical: true, size: 4 }, {
          default: () => [
            ...pane.configHints.map((hint) => h("p", hint)),
            ...pane.readiness.rows.map((row) => h("p", [
              `${row.id}: ${row.tone}`,
              " ",
              h(NTag, { size: "small", round: true, type: readinessRowType(row.tone) }, { default: () => row.tone }),
            ])),
          ],
        }),
      ],
    }),
  ]);
}

function renderDocuments(documents: DesktopKnowledgeDocumentRow[]) {
  return h("section", { class: "desktop-knowledge-documents" }, [
    h("h2", "Documents"),
    documents.length
      ? h(NList, { bordered: false, hoverable: true }, {
        default: () => documents.map((document) => h(NListItem, {
          "data-desktop-entity-module": "knowledge",
          "data-desktop-entity-id": document.id || document.path,
        }, {
          default: () => h(NSpace, { vertical: true, size: 4 }, {
            default: () => [
              h("span", `${document.title}: ${document.meta}`),
              h(NSpace, { size: 4, wrap: true }, {
                default: () => documentTags(document).map((tag) => h(NTag, {
                  size: "small",
                  round: true,
                  type: document.status === "indexed" ? "success" : "default",
                }, { default: () => tag })),
              }),
            ],
          }),
        })),
      })
      : h(NEmpty, { class: "desktop-knowledge-documents-empty", description: "No knowledge documents loaded.", size: "small" }),
  ]);
}

function renderDocumentDetail(document: DesktopKnowledgePaneDocument) {
  return h("section", { class: "desktop-knowledge-document-detail" }, [
    h(NCard, { size: "small", bordered: false }, {
      default: () => [
        h("h2", `Document detail: ${document.title}`),
        h("p", document.detail),
        h("p", `Tags: ${document.tags.join(", ") || "none"}`),
        h(NSpace, { size: 4, wrap: true }, {
          default: () => documentTags(document).map((tag) => h(NTag, {
            size: "small",
            round: true,
            type: document.status === "indexed" ? "success" : "default",
          }, { default: () => tag })),
        }),
      ],
    }),
  ]);
}

function renderQuery(pane: DesktopKnowledgePaneModel) {
  return h("section", { class: "desktop-knowledge-query" }, [
    h(NCard, { size: "small", bordered: false }, {
      default: () => [
        h("h2", `Query: ${pane.query.draft.query || "empty"}`),
        h("p", `Mode: ${pane.query.draft.mode} / top ${pane.query.draft.topK}`),
        h("p", `Results: ${pane.query.results.summary.count}`),
        pane.query.results.rows.length
          ? renderQueryRows(pane.query.results.rows)
          : h(NEmpty, { class: "desktop-knowledge-query-empty", description: "No knowledge query results.", size: "small" }),
      ],
    }),
  ]);
}

function renderQueryRows(rows: DesktopKnowledgeQueryResultRow[]) {
  return h(NList, { bordered: false, hoverable: true }, {
    default: () => rows.slice(0, KNOWLEDGE_REFERENCE_LIMIT).map((row) => h(NListItem, {
      "data-desktop-knowledge-query-result": row.id,
    }, {
      default: () => h(NSpace, { vertical: true, size: 4 }, {
        default: () => [
          h("span", `${row.docName}: ${row.content}`),
          h(NSpace, { size: 4, wrap: true }, {
            default: () => [
              h(NTag, { size: "small", round: true, type: queryRelevanceType(row.relevance) }, { default: () => row.relevance }),
              row.scoreLabel ? h(NTag, { size: "small", round: true }, { default: () => row.scoreLabel }) : null,
            ],
          }),
        ],
      }),
    })),
  });
}

function renderGraph(graph: DesktopKnowledgePaneGraph) {
  return h("section", { class: "desktop-knowledge-graph" }, [
    h(NCard, { size: "small", bordered: false }, {
      default: () => [
        h("h2", `Graph: ${graph.summary}`),
        renderReferenceGroup("Community", graph.communities),
        renderReferenceGroup("Report", graph.reports),
        renderReferenceGroup("Claim", graph.claims),
        renderReferenceGroup("Relation", graph.relations),
        renderReferenceGroup("Conflict", graph.conflicts),
        renderEvidenceRows(graph.evidence),
      ],
    }),
  ]);
}

function renderReferenceGroup(label: string, rows: DesktopKnowledgePaneReferenceRow[]) {
  if (!rows.length) {
    return null;
  }
  return h(NList, { bordered: false, hoverable: true }, {
    default: () => rows.slice(0, KNOWLEDGE_REFERENCE_LIMIT).map((row) => h(NListItem, {
      "data-desktop-knowledge-graph-reference": `${label}:${row.id}`,
    }, {
      default: () => h(NSpace, { align: "center", size: 6, wrap: true }, {
        default: () => [
          h(NTag, { size: "small", round: true }, { default: () => label }),
          h("span", `${label}: ${row.title}${row.text ? ` - ${row.text}` : ""}`),
        ],
      }),
    })),
  });
}

function renderEvidenceRows(rows: DesktopKnowledgeEvidenceRow[]) {
  if (!rows.length) {
    return null;
  }
  return h(NList, { bordered: false, hoverable: true }, {
    default: () => rows.slice(0, KNOWLEDGE_REFERENCE_LIMIT).map((row) => h(NListItem, {
      "data-desktop-knowledge-graph-evidence": row.id,
    }, {
      default: () => h(NSpace, { align: "center", size: 6, wrap: true }, {
        default: () => [
          h(NTag, { size: "small", round: true, type: "success" }, { default: () => "Evidence" }),
          h("span", `Evidence: ${row.title} / ${row.docName}`),
        ],
      }),
    })),
  });
}

function knowledgeActions(pane: DesktopKnowledgePaneModel): KnowledgeActionItem[] {
  return [
    { action: "uploadDocument", label: "Upload document", enabled: pane.actions.upload },
    { action: "runQuery", label: "Run query", enabled: pane.actions.query },
    { action: "refreshGraph", label: "Refresh graph", enabled: pane.actions.refreshGraph },
    { action: "rebuildIndex", label: "Rebuild index", enabled: pane.actions.rebuild },
    { action: "deleteDocument", label: "Delete document", enabled: pane.actions.deleteDocument },
  ];
}

function documentTags(document: Pick<DesktopKnowledgeDocumentRow | DesktopKnowledgePaneDocument, "category" | "status" | "tags">): string[] {
  return document.tags.length ? document.tags : [document.category || document.status].filter(Boolean);
}

function readinessProgressStatus(pane: DesktopKnowledgePaneModel): "success" | "warning" | "error" {
  if (pane.readiness.failedStageCount > 0) {
    return "error";
  }
  if (pane.readiness.partialAvailability || pane.readiness.staleStageCount > 0) {
    return "warning";
  }
  return "success";
}

function readinessRowType(tone: DesktopKnowledgeReadinessRow["tone"]): "default" | "error" | "success" | "warning" {
  if (tone === "ready") {
    return "success";
  }
  if (tone === "warn") {
    return "warning";
  }
  if (tone === "error") {
    return "error";
  }
  return "default";
}

function queryRelevanceType(relevance: DesktopKnowledgeQueryResultRow["relevance"]): "default" | "success" | "warning" {
  if (relevance === "high") {
    return "success";
  }
  if (relevance === "low") {
    return "warning";
  }
  return "default";
}

function actionButtonType(action: KnowledgePaneActionId): "default" | "error" | "primary" | "warning" {
  if (action === "deleteDocument") {
    return "error";
  }
  if (action === "rebuildIndex") {
    return "warning";
  }
  if (action === "uploadDocument" || action === "runQuery") {
    return "primary";
  }
  return "default";
}
