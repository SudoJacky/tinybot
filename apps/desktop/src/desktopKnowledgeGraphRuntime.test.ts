import { describe, expect, test, vi } from "vitest";
import {
  DEFAULT_KNOWLEDGE_GRAPH_STACK,
  buildKnowledgeGraphHighlightState,
  buildKnowledgeGraphViewportEvent,
  createLazyKnowledgeGraph3dLoader,
  normalizeKnowledgeGraphData,
} from "./desktopKnowledgeGraphRuntime";

describe("desktop knowledge graph runtime", () => {
  test("declares sigma and graphology as the default 2D graph stack", () => {
    expect(DEFAULT_KNOWLEDGE_GRAPH_STACK).toEqual({
      renderer: "sigma",
      model: "graphology",
      defaultMode: "2d",
      optional3d: ["three", "3d-force-graph"],
    });
  });

  test("normalizes graph payloads for scalable viewport rendering", () => {
    const graph = normalizeKnowledgeGraphData({
      nodes: [
        { id: "doc-1", label: "Desktop Overview", type: "document", community_id: "c1", conflict: false },
        { id: "claim-1", label: "Graph-first Knowledge", type: "claim", confidence: 0.82, evidence_ids: ["ev-1"] },
      ],
      edges: [
        { id: "edge-1", source: "doc-1", target: "claim-1", predicate: "supports", evidence: [{ id: "ev-1", doc_name: "Overview" }] },
      ],
      communities: [{ id: "c1", title: "Desktop" }],
      conflicts: [{ id: "conflict-1", node_ids: ["claim-1"], status: "open" }],
      index: { version: "v1", ready: true, updated_at: "2026-06-06T15:00:00Z" },
    });

    expect(graph.nodes).toEqual([
      {
        id: "doc-1",
        label: "Desktop Overview",
        type: "document",
        attributes: { communityId: "c1", confidence: null, conflict: false, evidenceIds: [] },
      },
      {
        id: "claim-1",
        label: "Graph-first Knowledge",
        type: "claim",
        attributes: { communityId: null, confidence: 0.82, conflict: true, evidenceIds: ["ev-1"] },
      },
    ]);
    expect(graph.edges[0]).toMatchObject({
      id: "edge-1",
      source: "doc-1",
      target: "claim-1",
      type: "supports",
      evidenceIds: ["ev-1"],
    });
    expect(graph.metadata).toEqual({
      nodeCount: 2,
      edgeCount: 1,
      communityCount: 1,
      conflictCount: 1,
      indexReady: true,
      indexVersion: "v1",
      updatedAt: "2026-06-06T15:00:00Z",
    });
  });

  test("builds viewport events and query highlight state without mutating filters", () => {
    const event = buildKnowledgeGraphViewportEvent({
      type: "select",
      nodeId: "claim-1",
      filters: { nodeTypes: ["claim"], layers: ["evidence"] },
      viewport: { x: 10, y: 20, ratio: 1.4 },
    });

    expect(event).toEqual({
      type: "select",
      selectedNodeId: "claim-1",
      selectedEdgeId: null,
      hoveredNodeId: null,
      filters: { nodeTypes: ["claim"], layers: ["evidence"] },
      viewport: { x: 10, y: 20, ratio: 1.4 },
    });

    expect(buildKnowledgeGraphHighlightState({
      queryResultIds: ["claim-1"],
      selectedNodeId: "doc-1",
      selectedEdgeId: "edge-1",
      evidenceIds: ["ev-1"],
    })).toEqual({
      highlightedNodeIds: ["claim-1", "doc-1"],
      highlightedEdgeIds: ["edge-1"],
      highlightedEvidenceIds: ["ev-1"],
    });
  });

  test("lazy-loads optional 3D graph dependencies only when requested", async () => {
    const importModule = vi.fn(async (name: string) => ({ name }));
    const loader = createLazyKnowledgeGraph3dLoader(importModule);

    expect(importModule).not.toHaveBeenCalled();
    await expect(loader.load()).resolves.toEqual({
      three: { name: "three" },
      forceGraph3d: { name: "3d-force-graph" },
    });
    expect(importModule).toHaveBeenCalledWith("three");
    expect(importModule).toHaveBeenCalledWith("3d-force-graph");
  });
});
