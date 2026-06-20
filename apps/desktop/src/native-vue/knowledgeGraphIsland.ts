import { computed, createApp, defineComponent, h, onBeforeUnmount, onMounted, ref, shallowRef, type App, type PropType, type Ref } from "vue";
import { NConfigProvider, NList, NListItem, NSpace, NTag } from "naive-ui";
import type {
  DesktopKnowledgeEvidenceRow,
  DesktopKnowledgePaneGraph,
  DesktopKnowledgePaneReferenceRow,
} from "../desktopKnowledgeTraceability";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

const KNOWLEDGE_GRAPH_REFERENCE_LIMIT = 4;
const KNOWLEDGE_GRAPH_EVIDENCE_LIMIT = 4;

export interface KnowledgeGraph3dNode {
  id: string;
  name: string;
  type: string;
  val: number;
  raw: unknown;
}

export interface KnowledgeGraph3dLink {
  id: string;
  source: string | KnowledgeGraph3dNode;
  target: string | KnowledgeGraph3dNode;
  label: string;
  title: string;
  evidenceCount: number;
}

export interface KnowledgeGraph3dData {
  nodes: KnowledgeGraph3dNode[];
  links: KnowledgeGraph3dLink[];
}

export interface KnowledgeGraphSelection {
  node: { id: string; label: string } | null;
  relations: DesktopKnowledgePaneReferenceRow[];
  evidence: DesktopKnowledgeEvidenceRow[];
  isFiltered: boolean;
}

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
      const selectedNodeId = ref<string | null>(null);
      const selection = computed(() => buildKnowledgeGraphSelection(options.graph, selectedNodeId.value));
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h("div", { class: "desktop-knowledge-graph-workspace" }, [
          renderGraphCanvas(options.graph, selectedNodeId),
          h("div", {
            class: "desktop-knowledge-graph-references",
            "data-desktop-knowledge-graph-pane": "references",
            "data-desktop-knowledge-graph-filtered": String(selection.value.isFiltered),
          }, [
            renderSelectionReferences(options.graph, selection.value),
          ]),
        ]),
      });
    },
  }));
}

function renderGraphCanvas(graph: DesktopKnowledgePaneGraph, selectedNodeId: Ref<string | null>) {
  if (!graph.view.nodes.length) {
    return h("div", {
      class: "desktop-knowledge-graph-canvas desktop-knowledge-graph-empty",
      "data-desktop-knowledge-graph-pane": "canvas",
    }, [
      h("strong", "No graph built yet"),
      h("p", "Upload documents, then build the graph to inspect entities and relationships."),
    ]);
  }
  return h(KnowledgeGraph3dScene, {
    graph,
    selectedNodeId: selectedNodeId.value ?? "",
    onSelectNode: (nodeId: string) => {
      selectedNodeId.value = nodeId;
    },
  });
}

const KnowledgeGraph3dScene = defineComponent({
  name: "KnowledgeGraph3dScene",
  props: {
    graph: {
      type: Object as PropType<DesktopKnowledgePaneGraph>,
      required: true,
    },
    selectedNodeId: {
      type: String,
      default: "",
    },
  },
  emits: ["selectNode"],
  setup(props, { emit }) {
    const host = ref<HTMLElement | null>(null);
    const selected = ref<string>("Drag to orbit, scroll to zoom, click a node to focus.");
    const graphInstance = shallowRef<KnowledgeGraph3dInstance | null>(null);
    let resizeObserver: ResizeObserver | null = null;

    onMounted(() => {
      void mountKnowledgeGraph3dScene(host.value, props.graph, selected, (nodeId) => {
        selected.value = props.graph.view.nodes.find((node) => node.id === nodeId)?.label ?? selected.value;
        emit("selectNode", nodeId);
      }, (instance) => {
        graphInstance.value = instance;
      }, (observer) => {
        resizeObserver = observer;
      });
    });

    onBeforeUnmount(() => {
      resizeObserver?.disconnect();
      graphInstance.value?._destructor?.();
      graphInstance.value = null;
    });

    return () => h("div", {
      class: "desktop-knowledge-graph-canvas",
      "data-desktop-knowledge-graph-pane": "canvas",
      "data-desktop-knowledge-graph-mode": "3d",
      "data-desktop-knowledge-selected-node": props.selectedNodeId ?? "",
      role: "application",
      "aria-label": `${props.graph.summary}. Drag to orbit, scroll to zoom, click nodes to focus.`,
    }, [
      h("div", {
        ref: host,
        class: "desktop-knowledge-graph-3d-host",
        "data-desktop-knowledge-graph-3d-host": "",
      }),
      h("div", { class: "desktop-knowledge-graph-3d-hint" }, selected.value),
    ]);
  },
});

async function mountKnowledgeGraph3dScene(
  host: HTMLElement | null,
  graph: DesktopKnowledgePaneGraph,
  selected: { value: string },
  selectNode: (nodeId: string) => void,
  setInstance: (instance: KnowledgeGraph3dInstance) => void,
  setResizeObserver: (observer: ResizeObserver) => void,
): Promise<void> {
  if (!host || !canRenderKnowledgeGraph3d()) {
    return;
  }
  const { default: ForceGraph3D } = await import("3d-force-graph");
  const ForceGraph3DConstructor = ForceGraph3D as unknown as new (element: HTMLElement, configOptions?: object) => KnowledgeGraph3dInstance;
  const instance = new ForceGraph3DConstructor(host, { controlType: "orbit" });
  setInstance(instance);

  const graphData = buildKnowledgeGraph3dData(graph);
  const resize = () => {
    const rect = host.getBoundingClientRect();
    instance.width(Math.max(320, Math.floor(rect.width || 640)));
    instance.height(Math.max(260, Math.floor(rect.height || 360)));
  };

  instance
    .backgroundColor("#fffdf9")
    .showNavInfo(false)
    .graphData(graphData)
    .nodeLabel((node: KnowledgeGraph3dNode) => node.name)
    .nodeVal((node: KnowledgeGraph3dNode) => node.val)
    .nodeColor((node: KnowledgeGraph3dNode) => node.type === "document" ? "#d97857" : "#8f6d49")
    .linkLabel((link: KnowledgeGraph3dLink) => link.title)
    .linkColor(() => "rgba(217, 120, 87, 0.48)")
    .linkWidth((link: KnowledgeGraph3dLink) => Math.max(1.5, Math.min(4, link.evidenceCount + 1)))
    .linkDirectionalParticles(1)
    .linkDirectionalParticleSpeed(0.004)
    .cooldownTicks(80)
    .d3VelocityDecay(0.34)
    .onNodeClick((node: KnowledgeGraph3dNode) => {
      selected.value = node.name;
      selectNode(node.id);
      const positionedNode = node as KnowledgeGraph3dNode & { x?: number; y?: number; z?: number };
      const distance = 140;
      const distRatio = 1 + distance / Math.hypot(positionedNode.x ?? 1, positionedNode.y ?? 1, positionedNode.z ?? 1);
      instance.cameraPosition(
        {
          x: (positionedNode.x ?? 1) * distRatio,
          y: (positionedNode.y ?? 1) * distRatio,
          z: (positionedNode.z ?? 1) * distRatio,
        },
        positionedNode,
        700,
      );
    })
    .onLinkClick((link: KnowledgeGraph3dLink) => {
      selected.value = link.title || link.label;
      const sourceId = typeof link.source === "string" ? link.source : link.source.id;
      if (sourceId) {
        selectNode(sourceId);
      }
    });

  resize();
  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    setResizeObserver(observer);
  }
}

function canRenderKnowledgeGraph3d(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return false;
  }
  const canvas = document.createElement("canvas");
  return typeof canvas.getContext === "function" && Boolean(canvas.getContext("webgl") || canvas.getContext("experimental-webgl"));
}

export function buildKnowledgeGraph3dData(graph: DesktopKnowledgePaneGraph): KnowledgeGraph3dData {
  const nodes = graph.view.nodes.slice(0, 64).map((node, index) => ({
    id: node.id,
    name: node.label,
    type: node.type,
    val: index === 0 ? 8 : 4,
    raw: node.raw,
  }));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const links = graph.view.edges
    .filter((edge) => nodeIds.has(edge.sourceId) && nodeIds.has(edge.targetId))
    .slice(0, 96)
    .map((edge) => ({
      id: edge.id,
      source: edge.sourceId,
      target: edge.targetId,
      label: edge.predicate || "related",
      title: edge.title,
      evidenceCount: edge.evidenceCount,
    }));
  return { nodes, links };
}

export function buildKnowledgeGraphSelection(graph: DesktopKnowledgePaneGraph, selectedNodeId: string | null): KnowledgeGraphSelection {
  if (!selectedNodeId) {
    return {
      node: null,
      relations: graph.relations,
      evidence: graph.evidence,
      isFiltered: false,
    };
  }
  const selectedNode = graph.view.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const relatedEdges = graph.view.edges.filter((edge) => edge.sourceId === selectedNodeId || edge.targetId === selectedNodeId);
  const relatedEdgeIds = new Set(relatedEdges.map((edge) => edge.id));
  const relatedRelationTitles = new Set(relatedEdges.map((edge) => edge.title));
  const relations = graph.relations.filter((row) => relatedEdgeIds.has(row.id) || relatedRelationTitles.has(row.title));
  const evidence = graph.evidence.filter(
    (row) => row.sourceNodeId === selectedNodeId || row.targetNodeId === selectedNodeId || relatedEdgeIds.has(row.edgeId),
  );
  return {
    node: selectedNode ? { id: selectedNode.id, label: selectedNode.label } : null,
    relations,
    evidence,
    isFiltered: true,
  };
}

type KnowledgeGraph3dInstance = {
  backgroundColor: (value: string) => KnowledgeGraph3dInstance;
  showNavInfo: (value: boolean) => KnowledgeGraph3dInstance;
  graphData: (value: KnowledgeGraph3dData) => KnowledgeGraph3dInstance;
  nodeLabel: (value: (node: KnowledgeGraph3dNode) => string) => KnowledgeGraph3dInstance;
  nodeVal: (value: (node: KnowledgeGraph3dNode) => number) => KnowledgeGraph3dInstance;
  nodeColor: (value: (node: KnowledgeGraph3dNode) => string) => KnowledgeGraph3dInstance;
  linkLabel: (value: (link: KnowledgeGraph3dLink) => string) => KnowledgeGraph3dInstance;
  linkColor: (value: (link: KnowledgeGraph3dLink) => string) => KnowledgeGraph3dInstance;
  linkWidth: (value: (link: KnowledgeGraph3dLink) => number) => KnowledgeGraph3dInstance;
  linkDirectionalParticles: (value: number) => KnowledgeGraph3dInstance;
  linkDirectionalParticleSpeed: (value: number) => KnowledgeGraph3dInstance;
  cooldownTicks: (value: number) => KnowledgeGraph3dInstance;
  d3VelocityDecay: (value: number) => KnowledgeGraph3dInstance;
  onNodeClick: (value: (node: KnowledgeGraph3dNode) => void) => KnowledgeGraph3dInstance;
  onLinkClick: (value: (link: KnowledgeGraph3dLink) => void) => KnowledgeGraph3dInstance;
  width: (value: number) => KnowledgeGraph3dInstance;
  height: (value: number) => KnowledgeGraph3dInstance;
  cameraPosition: (position: { x: number; y: number; z: number }, lookAt: object, duration: number) => KnowledgeGraph3dInstance;
  _destructor?: () => void;
};

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

function renderSelectionReferences(graph: DesktopKnowledgePaneGraph, selection: KnowledgeGraphSelection) {
  if (!selection.isFiltered) {
    return [
      h("h2", `Graph: ${graph.summary}`),
      renderReferenceGroup("Community", graph.communities),
      renderReferenceGroup("Report", graph.reports),
      renderReferenceGroup("Claim", graph.claims),
      renderReferenceGroup("Relation", graph.relations),
      renderReferenceGroup("Conflict", graph.conflicts),
      renderEvidence(graph.evidence),
    ];
  }
  const hasSelectionRows = selection.relations.length > 0 || selection.evidence.length > 0;
  return [
    h("h2", `Selected: ${selection.node?.label ?? "Unknown node"}`),
    hasSelectionRows
      ? [
          renderReferenceGroup("Relation", selection.relations),
          renderEvidence(selection.evidence),
        ]
      : h("p", { class: "desktop-knowledge-graph-selection-empty" }, "No relations or evidence for this node yet."),
  ];
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
