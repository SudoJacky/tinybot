import { describe, expect, test } from "vitest";
import { buildDesktopKnowledgePaneModel, buildDesktopKnowledgeTaskOperations } from "./desktopKnowledgeTraceability";
import { buildDesktopKnowledgeWorkbenchProjection } from "./desktopKnowledgeWorkbenchProjection";
import { buildDesktopTaskCenterItems } from "./desktopTaskCenter";

function buildKnowledgeModel() {
  return buildDesktopKnowledgePaneModel({
    statsPayload: {
      total_documents: 2,
      total_chunks: 12,
      indexed_dense: 12,
      indexed_sparse: 12,
      claim_count: 4,
      relation_count: 3,
      graph_ready: true,
    },
    documentsPayload: {
      documents: [
        {
          id: "doc-1",
          title: "Native app overview",
          path: "NATIVE_APP_OVERVIEW.md",
          category: "native",
          tags: ["desktop"],
          chunk_count: 8,
          updated_at: "2026-06-02T08:00:00Z",
          status: "indexed",
        },
      ],
    },
    queryDraft: { query: "graph evidence", mode: "hybrid", topK: 5 },
    queryResultPayload: {
      data: [
        {
          doc_id: "doc-1",
          doc_name: "Native app overview",
          section_path: "Knowledge / Graph",
          content: "Graph evidence can be used in Chat.",
          score: 0.73,
          source_snippets: [{ id: "ev-1", doc_name: "Native app overview", evidence_text: "Graph evidence" }],
        },
      ],
    },
    graphPayload: {
      nodes: [
        { id: "doc-1", label: "Native app overview", type: "document", community_id: "c1" },
        { id: "claim-1", label: "Graph evidence can be used in Chat", type: "claim", evidence_ids: ["ev-1"] },
      ],
      edges: [
        { id: "edge-1", source: "doc-1", target: "claim-1", predicate: "supports", evidence: [{ id: "ev-1", doc_name: "Native app overview" }] },
      ],
      communities: [{ id: "c1", title: "Native app" }],
      conflicts: [{ id: "conflict-1", node_ids: ["claim-1"], status: "open" }],
    },
  });
}

describe("desktop knowledge workbench projection", () => {
  test("projects command bar readiness, upload, query, refresh, rebuild, stats, and mode switch", () => {
    const projection = buildDesktopKnowledgeWorkbenchProjection({
      pane: buildKnowledgeModel(),
      mode: "graph-2d",
    });

    expect(projection.commandBar).toEqual({
      readiness: "57%",
      stats: "1 doc / readiness 57% / graph 2 nodes / 1 edge",
      mode: "graph-2d",
      actions: ["upload", "query", "refresh-graph", "rebuild", "show-stats", "mode-switch"],
    });
  });

  test("projects filters, layers, documents, default 2D graph, table mode, and lazy 3D availability", () => {
    const projection = buildDesktopKnowledgeWorkbenchProjection({
      pane: buildKnowledgeModel(),
      mode: "graph-2d",
      selectedLayerIds: new Set(["documents", "claims"]),
    });

    expect(projection.leftPanel.layers).toEqual([
      { id: "documents", label: "Documents", active: true },
      { id: "claims", label: "Claims", active: true },
      { id: "relations", label: "Relations", active: false },
      { id: "communities", label: "Communities", active: false },
      { id: "conflicts", label: "Conflicts", active: false },
      { id: "evidence", label: "Evidence", active: false },
    ]);
    expect(projection.leftPanel.documents[0]).toEqual({
      id: "doc-1",
      title: "Native app overview",
      status: "indexed",
      meta: "native / indexed / 8 chunks / 2026-06-02T08:00:00Z",
      selected: true,
    });
    expect(projection.mainView).toEqual({
      mode: "graph-2d",
      graph: { nodeCount: 2, edgeCount: 1, renderer: "sigma", lazy3dAvailable: true },
      table: { rows: 1 },
    });
  });

  test("projects query result drawer with scores, evidence paths, and Use in Chat action", () => {
    const projection = buildDesktopKnowledgeWorkbenchProjection({
      pane: buildKnowledgeModel(),
      mode: "table",
    });

    expect(projection.queryDrawer).toEqual({
      open: true,
      summary: { count: 1, docs: ["Native app overview"], lowConfidence: false },
      results: [
        expect.objectContaining({
          id: "doc-1:0",
          title: "Native app overview",
          scoreLabel: "0.730",
          evidencePaths: ["Native app overview"],
          actions: ["use-in-chat", "open-graph-detail"],
        }),
      ],
    });
  });

  test("projects graph detail drawer for node, evidence, conflict, and community context", () => {
    const projection = buildDesktopKnowledgeWorkbenchProjection({
      pane: buildKnowledgeModel(),
      mode: "graph-2d",
      selectedGraphId: "claim-1",
    });

    expect(projection.detailDrawer).toEqual({
      open: true,
      id: "claim-1",
      title: "Graph evidence can be used in Chat",
      kind: "claim",
      evidence: ["ev-1"],
      conflicts: ["conflict-1"],
      communities: ["Native app"],
      actions: ["use-in-chat", "inspect-evidence", "open-source"],
    });
  });

  test("projects index job panel with progress, failures, retry/cancel, and document links", () => {
    const jobs = buildDesktopTaskCenterItems({ knowledgeJobs: buildDesktopKnowledgeTaskOperations([
      {
        job: {
          id: "kjob-1",
          doc_id: "doc-1",
          name: "NATIVE_APP_OVERVIEW.md",
          status: "failed",
          stage: "dense_indexing",
          message: "Embedding failed",
          error: "timeout",
          processed: 2,
          total: 5,
        },
      },
    ]) });
    const projection = buildDesktopKnowledgeWorkbenchProjection({
      pane: buildKnowledgeModel(),
      mode: "graph-2d",
      jobs,
    });

    expect(projection.indexJobs).toEqual([
      {
        id: "knowledge:kjob-1",
        title: "Index NATIVE_APP_OVERVIEW.md",
        state: "failed",
        progress: { completed: 2, total: 5 },
        failure: "timeout",
        documentLinks: ["doc-1"],
        actions: ["retry", "cancel", "open-document"],
      },
    ]);
  });
});
