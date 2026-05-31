import { describe, expect, test } from "vitest";
import {
  buildDesktopKnowledgeDocumentRows,
  buildDesktopKnowledgeGraphView,
  buildDesktopKnowledgeQueryRequest,
  buildDesktopKnowledgeQueryResultRows,
  buildDesktopKnowledgeReadinessView,
  buildDesktopKnowledgeTaskOperations,
  buildDesktopKnowledgeTraceabilityInspection,
} from "./desktopKnowledgeTraceability";

describe("desktop knowledge and traceability helpers", () => {
  test("projects knowledge readiness using root WebUI stage semantics", () => {
    const view = buildDesktopKnowledgeReadinessView({
      total_documents: 3,
      total_chunks: 24,
      indexed_dense: 24,
      indexed_sparse: 24,
      claim_count: 7,
      relation_count: 2,
      graph_ready: false,
      stage_readiness: {
        claim_extraction: { stage: "claim_extraction", status: "complete", ready: true, processed: 7, total: 7 },
        relation_extraction: { stage: "relation_extraction", status: "stale", stale: 1, processed: 1, total: 2 },
        evidence_expansion: { stage: "evidence_expansion", status: "budget_limited", processed: 4, total: 8 },
      },
    });

    expect(view.score).toBe(57);
    expect(view.titleKey).toBe("knowledge.healthStale");
    expect(view.rows.map((row) => [row.id, row.tone])).toEqual([
      ["retrieval", "ready"],
      ["claims", "ready"],
      ["relations", "warn"],
      ["expansion", "warn"],
      ["graph", "muted"],
    ]);
  });

  test("normalizes document lists for stable desktop panes", () => {
    expect(
      buildDesktopKnowledgeDocumentRows({
        documents: [
          {
            id: "doc-1",
            title: "Architecture",
            path: "docs/architecture.md",
            category: "docs",
            tags: ["system", "desktop"],
            chunk_count: 12,
            updated_at: "2026-05-31T08:00:00Z",
            status: "indexed",
          },
        ],
      }),
    ).toEqual([
      {
        id: "doc-1",
        title: "Architecture",
        path: "docs/architecture.md",
        category: "docs",
        tags: ["system", "desktop"],
        chunkCount: 12,
        status: "indexed",
        updatedAt: "2026-05-31T08:00:00Z",
        meta: "docs / indexed / 12 chunks / 2026-05-31T08:00:00Z",
      },
    ]);
  });

  test("projects backend knowledge indexing and rebuild jobs into task center operations", () => {
    expect(
      buildDesktopKnowledgeTaskOperations([
        {
          job: {
            id: "kjob_index",
            doc_id: "doc-1",
            name: "desktop-notes.md",
            status: "running",
            stage: "dense_indexing",
            message: "Indexing retrieval vectors",
            processed: 2,
            total: 5,
            error: "",
            updated_at: "2026-05-31T10:00:00Z",
          },
        },
        {
          message: "Knowledge index rebuild started",
          type: "all",
          job: {
            id: "kjob_rebuild",
            name: "rebuild:all",
            status: "queued",
            stage: "queued",
            message: "Queued for knowledge index rebuild",
            processed: 0,
            total: 3,
          },
        },
        {
          data: {
            id: "kjob_failed",
            doc_id: "doc-2",
            name: "broken.md",
            status: "failed",
            stage: "failed",
            message: "Knowledge indexing failed",
            error: "embedding timeout",
            processed: 1,
            total: 4,
          },
        },
      ]),
    ).toEqual([
      {
        id: "knowledge:kjob_index",
        title: "Index desktop-notes.md",
        status: "running",
        detail: "Indexing retrieval vectors / dense_indexing",
        progress: { completed: 2, total: 5 },
        canonical: { module: "knowledge", entityId: "doc-1", href: "/knowledge" },
        diagnostics: "",
        retryable: false,
        updatedAt: "2026-05-31T10:00:00Z",
      },
      {
        id: "knowledge:kjob_rebuild",
        title: "Rebuild knowledge index",
        status: "queued",
        detail: "Queued for knowledge index rebuild / queued",
        progress: { completed: 0, total: 3 },
        canonical: { module: "knowledge", entityId: "kjob_rebuild", href: "/knowledge" },
        diagnostics: "",
        retryable: false,
        updatedAt: "",
      },
      {
        id: "knowledge:kjob_failed",
        title: "Index broken.md",
        status: "failed",
        detail: "Knowledge indexing failed / failed",
        progress: { completed: 1, total: 4 },
        canonical: { module: "knowledge", entityId: "doc-2", href: "/knowledge" },
        diagnostics: "embedding timeout",
        retryable: false,
        updatedAt: "",
      },
    ]);
  });

  test("builds query request and projects query rows with traceability sections", () => {
    expect(buildDesktopKnowledgeQueryRequest({ query: " desktop graph ", mode: "semantic", topK: 8 })).toEqual({
      query: "desktop graph",
      mode: "semantic",
      top_k: 8,
    });

    const view = buildDesktopKnowledgeQueryResultRows(
      {
        query: "desktop graph",
        data: [
          {
            doc_id: "doc-1",
            doc_name: "Architecture",
            section_path: "Desktop / Graph",
            content: "Desktop graph rendering uses stable projections.",
            rerank_score: 0.42,
            matched_entities: ["Desktop", "Graph"],
            matched_relations: ["Desktop->Graph"],
            matched_communities: ["community-1"],
            matched_methods: ["semantic", "graph"],
            source_snippets: [
              {
                doc_name: "Architecture",
                line_start: 10,
                line_end: 12,
                evidence_text: "Desktop graph rendering uses stable projections.",
                confidence: 0.8,
              },
            ],
            matched_claim_evidence: [
              {
                id: "claim-1",
                text: "Desktop graph rendering uses stable projections.",
                status: "supported",
                source: { doc_name: "Architecture", line_start: 10, line_end: 12 },
              },
            ],
          },
        ],
      },
      { query: "desktop graph" },
    );

    expect(view.summary).toEqual({
      count: 1,
      docs: ["Architecture"],
      lowConfidence: false,
    });
    expect(view.rows[0]).toMatchObject({
      id: "doc-1:0",
      docName: "Architecture",
      relevance: "high",
      scoreLabel: "rerank 0.4200",
      meta: "semantic+graph / Desktop / Graph",
      graphHighlight: {
        query: "desktop graph",
        entities: ["Desktop", "Graph"],
        relations: ["Desktop->Graph"],
        communities: ["community-1"],
        docId: "doc-1",
        docName: "Architecture",
      },
    });
    expect(view.rows[0].traceabilitySections.map((section) => section.kind)).toEqual(["source", "claims"]);
  });

  test("normalizes graph evidence and traceability inspections", () => {
    const graph = buildDesktopKnowledgeGraphView({
      nodes: [
        { id: "n1", label: "Desktop" },
        { id: "n2", canonical_name: "Graph" },
      ],
      edges: [
        {
          id: "e1",
          source: "n1",
          target: "n2",
          predicate: "uses",
          confidence: 0.73,
          evidence: [
            {
              id: "ev-1",
              claim_id: "claim-1",
              doc_name: "Architecture",
              line_start: 20,
              line_end: 21,
              evidence_text: "Desktop uses graph projections.",
            },
          ],
        },
      ],
    });

    expect(graph.edges[0]).toMatchObject({
      id: "e1",
      title: "Desktop -[uses]-> Graph",
      sourceLabel: "Desktop",
      targetLabel: "Graph",
      evidenceCount: 1,
    });
    expect(graph.evidenceRows[0]).toMatchObject({
      id: "ev-1",
      edgeId: "e1",
      docName: "Architecture",
      location: "L20-L21",
      evidenceText: "Desktop uses graph projections.",
    });

    const inspection = buildDesktopKnowledgeTraceabilityInspection({
      kind: "relation",
      value: graph.edges[0].raw,
      graphNodes: graph.nodes.map((node) => node.raw),
    });
    expect(inspection).toMatchObject({
      kind: "relation",
      title: "Desktop -[uses]-> Graph",
      evidence: [{ title: "Architecture", text: "Desktop uses graph projections." }],
    });
    expect(inspection.rows).toContainEqual({ label: "Endpoints", value: "Desktop -> Graph" });
  });
});
