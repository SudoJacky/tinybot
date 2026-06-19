// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import type { DesktopKnowledgeEvidenceRow, DesktopKnowledgePaneGraph } from "../desktopKnowledgeTraceability";
import { mountKnowledgeGraphIsland } from "./knowledgeGraphIsland";

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
  test("renders graph references and limits evidence rows with existing copy", () => {
    const host = document.createElement("section");

    const mounted = mountKnowledgeGraphIsland(host, { graph });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("knowledge-graph");
    expect(host.className).toContain("desktop-knowledge-graph");
    expect(host.querySelector('[data-desktop-knowledge-graph-pane="canvas"]')).not.toBeNull();
    expect(host.querySelector('[data-desktop-knowledge-graph-pane="references"]')).not.toBeNull();
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

  test("draws graph edges between their source and target nodes", () => {
    const host = document.createElement("section");
    const mounted = mountKnowledgeGraphIsland(host, {
      graph: {
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
          evidenceRows: [],
        },
      },
    });

    const edge = host.querySelector('[data-desktop-knowledge-graph-edge="edge-source-target"]');
    expect(edge?.getAttribute("x1")).toBe("320");
    expect(edge?.getAttribute("y1")).toBe("65");
    expect(edge?.getAttribute("x2")).toBe("320");
    expect(edge?.getAttribute("y2")).toBe("295");

    mounted.unmount();
  });
});
