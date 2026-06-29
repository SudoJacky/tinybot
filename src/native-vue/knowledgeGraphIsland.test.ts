// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from "vitest";
import type { DesktopKnowledgeEvidenceRow, DesktopKnowledgePaneGraph } from "../desktopKnowledgeTraceability";
import { buildKnowledgeGraph3dData, buildKnowledgeGraphSelection, mountKnowledgeGraphIsland } from "./knowledgeGraphIsland";

vi.mock("3d-force-graph", () => {
  class ForceGraph3DMock {
    backgroundColor() { return this; }
    showNavInfo() { return this; }
    graphData() { return this; }
    nodeLabel() { return this; }
    nodeVal() { return this; }
    nodeColor() { return this; }
    linkLabel() { return this; }
    linkColor() { return this; }
    linkWidth() { return this; }
    linkDirectionalParticles() { return this; }
    linkDirectionalParticleSpeed() { return this; }
    cooldownTicks() { return this; }
    d3VelocityDecay() { return this; }
    onNodeClick() { return this; }
    onLinkClick() { return this; }
    width() { return this; }
    height() { return this; }
    cameraPosition() { return this; }
    _destructor() {}
  }
  return { default: ForceGraph3DMock };
});

function evidence(index: number): DesktopKnowledgeEvidenceRow {
  return {
    id: `evidence-${index}`,
    edgeId: "edge-1",
    sourceNodeId: "desktop",
    targetNodeId: "evidence",
    title: `Evidence ${index}`,
    docName: `Doc ${index}`,
    location: "",
    meta: "",
    evidenceText: `Evidence text ${index}`,
    confidenceLabel: "",
    claimId: "",
  };
}

const graph: DesktopKnowledgePaneGraph = {
  view: {
    nodes: [],
    edges: [],
    evidenceRows: [],
  },
  summary: "2 nodes / 1 edge / 5 evidence",
  communities: [{ id: "community-1", title: "Desktop cluster", meta: "community", text: "Cluster summary" }],
  reports: [{ id: "report-1", title: "Desktop report", meta: "report", text: "Report summary" }],
  claims: [{ id: "claim-1", title: "Desktop panes expose graph evidence.", meta: "claim", text: "" }],
  relations: [{ id: "relation-1", title: "Desktop exposes Evidence", meta: "relation", text: "exposes" }],
  conflicts: [{ id: "conflict-1", title: "record left conflicts with record right", meta: "conflict", text: "" }],
  evidence: [1, 2, 3, 4, 5].map(evidence),
};

describe("knowledge graph Vue island", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("renders graph references and limits evidence rows with existing copy", () => {
    const host = document.createElement("section");

    const mounted = mountKnowledgeGraphIsland(host, { graph });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("knowledge-graph");
    expect(host.className).toContain("desktop-knowledge-graph");
    expect(host.querySelector('[data-desktop-knowledge-graph-pane="canvas"]')).not.toBeNull();
    expect(host.querySelector('[data-desktop-knowledge-graph-pane="references"]')).not.toBeNull();
    expect(host.querySelector(".desktop-knowledge-graph-legend")).toBeNull();
    expect(host.querySelector(".desktop-knowledge-graph-minimap")).toBeNull();
    expect(host.textContent).not.toContain("Entity");
    expect(host.textContent).not.toContain("Edge");
    expect(host.querySelector("h2")?.textContent).toBe("Graph: 2 nodes / 1 edge / 5 evidence");
    expect(host.textContent).toContain("Community: Desktop cluster - Cluster summary");
    expect(host.textContent).toContain("Report: Desktop report - Report summary");
    expect(host.textContent).toContain("Claim: Desktop panes expose graph evidence.");
    expect(host.textContent).toContain("Relation: Desktop exposes Evidence - exposes");
    expect(host.textContent).toContain("Conflict: record left conflicts with record right");
    expect(host.textContent).toContain("Evidence: Evidence 1 / Doc 1");
    expect(host.textContent).toContain("Evidence: Evidence 4 / Doc 4");
    expect(host.textContent).not.toContain("Evidence: Evidence 5 / Doc 5");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("renders an interactive 3D graph host instead of the legacy SVG graph", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
    const host = document.createElement("section");
    const mounted = mountKnowledgeGraphIsland(host, {
      graph: graphWithEdges(),
    });

    const canvas = host.querySelector('[data-desktop-knowledge-graph-pane="canvas"]');
    expect(canvas?.getAttribute("data-desktop-knowledge-graph-mode")).toBe("3d");
    expect(canvas?.getAttribute("role")).toBe("application");
    expect(canvas?.textContent).toContain("Drag to orbit");
    expect(canvas?.querySelector(".desktop-knowledge-graph-3d-host")).not.toBeNull();
    expect(canvas?.querySelector("svg")).toBeNull();

    mounted.unmount();
  });

  test("renders a visible 2D fallback graph when WebGL is unavailable", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const host = document.createElement("section");
    const mounted = mountKnowledgeGraphIsland(host, {
      graph: graphWithEdges(),
    });

    const canvas = host.querySelector('[data-desktop-knowledge-graph-pane="canvas"]');
    expect(canvas?.getAttribute("data-desktop-knowledge-graph-mode")).toBe("2d-fallback");
    expect(canvas?.getAttribute("role")).toBe("img");
    expect(canvas?.textContent).toContain("WebGL unavailable");
    expect(canvas?.querySelector("svg")).not.toBeNull();
    expect(canvas?.querySelector('[data-desktop-knowledge-graph-node="source"]')).not.toBeNull();
    expect(canvas?.querySelector('[data-desktop-knowledge-graph-edge="edge-source-target"]')).not.toBeNull();
    expect(canvas?.querySelector(".desktop-knowledge-graph-3d-host")).toBeNull();

    mounted.unmount();
  });

  test("maps knowledge graph nodes and edges into 3D force graph data", () => {
    const data = buildKnowledgeGraph3dData(graphWithEdges());

    expect(data.nodes.map((node) => node.id)).toEqual(["center", "source", "target"]);
    expect(data.nodes[0]).toMatchObject({
      id: "center",
      name: "Center",
      type: "entity",
      val: 8,
    });
    expect(data.links).toEqual([
      {
        id: "edge-source-target",
        source: "source",
        target: "target",
        label: "relates",
        title: "Source relates to Target",
        evidenceCount: 1,
      },
    ]);
  });

  test("filters references and evidence to the selected graph node", () => {
    const selection = buildKnowledgeGraphSelection(graphWithEdges(), "source");

    expect(selection.node?.label).toBe("Source");
    expect(selection.relations.map((row) => row.id)).toEqual(["edge-source-target"]);
    expect(selection.evidence.map((row) => row.id)).toEqual(["evidence-source-target"]);
    expect(selection.isFiltered).toBe(true);
  });

  test("shows an empty selection message when a selected node has no references", () => {
    const selection = buildKnowledgeGraphSelection(graphWithEdges(), "center");

    expect(selection.node?.label).toBe("Center");
    expect(selection.relations).toEqual([]);
    expect(selection.evidence).toEqual([]);
    expect(selection.isFiltered).toBe(true);
  });
});

function graphWithEdges(): DesktopKnowledgePaneGraph {
  return {
    ...graph,
    view: {
      nodes: [
        { id: "center", label: "Center", type: "entity", raw: {} },
        { id: "source", label: "Source", type: "entity", raw: {} },
        { id: "target", label: "Target", type: "entity", raw: {} },
      ],
      edges: [{
        id: "edge-source-target",
        title: "Source relates to Target",
        sourceId: "source",
        targetId: "target",
        sourceLabel: "Source",
        targetLabel: "Target",
        predicate: "relates",
        confidenceLabel: "",
        evidenceCount: 1,
        raw: {},
      }],
      evidenceRows: [evidenceRowForEdge("evidence-source-target", "edge-source-target", "source", "target")],
    },
    relations: [{ id: "edge-source-target", title: "Source relates to Target", meta: "relation", text: "relates" }],
    evidence: [evidenceRowForEdge("evidence-source-target", "edge-source-target", "source", "target")],
  };
}

function evidenceRowForEdge(id: string, edgeId: string, sourceNodeId: string, targetNodeId: string): DesktopKnowledgeEvidenceRow {
  return {
    id,
    edgeId,
    sourceNodeId,
    targetNodeId,
    title: "Source relates to Target",
    docName: "Graph.md",
    location: "",
    meta: "",
    evidenceText: "Source relates to Target.",
    confidenceLabel: "",
    claimId: "",
  };
}
