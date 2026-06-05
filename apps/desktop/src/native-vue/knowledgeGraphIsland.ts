import { createApp, defineComponent, h, type App } from "vue";
import { NCard, NConfigProvider, NList, NListItem, NSpace, NTag } from "naive-ui";
import type { DesktopKnowledgeEvidenceRow, DesktopKnowledgePaneGraph, DesktopKnowledgePaneReferenceRow } from "../desktopKnowledgeTraceability";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

const KNOWLEDGE_GRAPH_REFERENCE_LIMIT = 4;
const KNOWLEDGE_GRAPH_EVIDENCE_LIMIT = 4;

export interface KnowledgeGraphIslandOptions {
  graph: DesktopKnowledgePaneGraph;
}

export interface MountedKnowledgeGraphIsland {
  unmount: () => void;
}

export function mountKnowledgeGraphIsland(
  host: HTMLElement,
  options: KnowledgeGraphIslandOptions,
): MountedKnowledgeGraphIsland {
  host.setAttribute("data-desktop-vue-island", "knowledge-graph");
  host.className = "desktop-knowledge-graph";
  const app = createKnowledgeGraphApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createKnowledgeGraphApp(options: KnowledgeGraphIslandOptions): App {
  return createApp(defineComponent({
    name: "KnowledgeGraphIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NCard, { size: "small", bordered: false }, {
          default: () => [
            h("h2", `Graph: ${options.graph.summary}`),
            renderReferenceGroup("Community", options.graph.communities),
            renderReferenceGroup("Report", options.graph.reports),
            renderReferenceGroup("Claim", options.graph.claims),
            renderReferenceGroup("Relation", options.graph.relations),
            renderReferenceGroup("Conflict", options.graph.conflicts),
            renderEvidence(options.graph.evidence),
          ],
        }),
      });
    },
  }));
}

function renderReferenceGroup(label: string, rows: DesktopKnowledgePaneReferenceRow[]) {
  if (!rows.length) {
    return null;
  }
  return h(NList, { bordered: false, hoverable: true }, {
    default: () => rows.slice(0, KNOWLEDGE_GRAPH_REFERENCE_LIMIT).map((row) => h(NListItem, {
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

function renderEvidence(rows: DesktopKnowledgeEvidenceRow[]) {
  if (!rows.length) {
    return null;
  }
  return h(NList, { bordered: false, hoverable: true }, {
    default: () => rows.slice(0, KNOWLEDGE_GRAPH_EVIDENCE_LIMIT).map((row) => h(NListItem, {
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
