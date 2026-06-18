import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NList, NListItem, NSpace, NTag } from "naive-ui";
import type {
  DesktopKnowledgeEvidenceRow,
  DesktopKnowledgeGraphEdge,
  DesktopKnowledgeGraphNode,
  DesktopKnowledgePaneGraph,
  DesktopKnowledgePaneReferenceRow,
} from "../desktopKnowledgeTraceability";
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
        default: () => h("div", { class: "desktop-knowledge-graph-workspace" }, [
          renderGraphCanvas(options.graph),
          h("div", { class: "desktop-knowledge-graph-legend" }, [
            h("span", [h("i", { class: "desktop-knowledge-legend-node" }), "Entity"]),
            h("span", [h("i", { class: "desktop-knowledge-legend-edge" }), "Edge"]),
          ]),
          h("div", { class: "desktop-knowledge-graph-minimap", "aria-label": "Graph minimap" }, [
            h("span"),
          ]),
          h("div", { class: "desktop-knowledge-graph-references" }, [
            h("h2", `Graph: ${options.graph.summary}`),
            renderReferenceGroup("Community", options.graph.communities),
            renderReferenceGroup("Report", options.graph.reports),
            renderReferenceGroup("Claim", options.graph.claims),
            renderReferenceGroup("Relation", options.graph.relations),
            renderReferenceGroup("Conflict", options.graph.conflicts),
            renderEvidence(options.graph.evidence),
          ]),
        ]),
      });
    },
  }));
}

function renderGraphCanvas(graph: DesktopKnowledgePaneGraph) {
  if (!graph.view.nodes.length) {
    return h("div", { class: "desktop-knowledge-graph-canvas desktop-knowledge-graph-empty" }, [
      h("strong", "No graph built yet"),
      h("p", "Upload documents, then build the graph to inspect entities and relationships."),
    ]);
  }
  const visibleNodes = graph.view.nodes.slice(0, 12);
  const nodePoints = new Map(visibleNodes.map((node, index) => [node.id, graphPoint(index, visibleNodes.length)]));
  const visibleEdges = graph.view.edges
    .slice(0, 10)
    .map((edge) => ({ edge, source: nodePoints.get(edge.sourceId), target: nodePoints.get(edge.targetId) }))
    .filter((entry): entry is { edge: DesktopKnowledgeGraphEdge; source: GraphPoint; target: GraphPoint } => Boolean(entry.source && entry.target));
  return h("div", { class: "desktop-knowledge-graph-canvas" }, [
    h("svg", { viewBox: "0 0 640 360", role: "img", "aria-label": graph.summary }, [
      ...visibleEdges.map(({ edge, source, target }) => renderGraphEdge(edge, source, target)),
      ...visibleNodes.map((node, index) => renderGraphNode(node, index, visibleNodes.length)),
    ]),
  ]);
}

function renderGraphNode(node: DesktopKnowledgeGraphNode, index: number, total: number) {
  const point = graphPoint(index, total);
  const radius = index === 0 ? 34 : 18;
  return h("g", { class: "desktop-knowledge-graph-node", "data-desktop-knowledge-graph-node": node.id }, [
    h("circle", { cx: point.x, cy: point.y, r: radius }),
    h("text", { x: point.x, y: point.y + radius + 16, "text-anchor": "middle" }, node.label),
  ]);
}

function renderGraphEdge(edge: DesktopKnowledgeGraphEdge, start: GraphPoint, end: GraphPoint) {
  return h("line", {
    class: "desktop-knowledge-graph-edge",
    "data-desktop-knowledge-graph-edge": edge.id,
    x1: start.x,
    y1: start.y,
    x2: end.x,
    y2: end.y,
  });
}

interface GraphPoint {
  x: number;
  y: number;
}

function graphPoint(index: number, total: number): GraphPoint {
  if (index === 0) {
    return { x: 320, y: 180 };
  }
  const angle = ((index - 1) / Math.max(total - 1, 1)) * Math.PI * 2 - Math.PI / 2;
  return {
    x: 320 + Math.cos(angle) * 185,
    y: 180 + Math.sin(angle) * 115,
  };
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
