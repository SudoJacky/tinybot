import { describe, expect, test } from "vitest";
import {
  buildDesktopKnowledgeDocumentRows,
  buildDesktopKnowledgeGraphView,
  buildDesktopKnowledgePaneModel,
  buildDesktopKnowledgeQueryRequest,
  buildDesktopKnowledgeQueryResultRows,
  buildDesktopKnowledgeReadinessView,
  buildDesktopKnowledgeTaskOperations,
  buildDesktopKnowledgeTraceabilityInspection,
  hasRunnableKnowledgeQueryDraft,
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
    expect(view.rows[0]).toMatchObject({
      id: "retrieval",
      status: "not_started",
      processed: 0,
      total: 0,
      failed: 0,
      stale: 0,
      detail: "dense 24 / sparse 24",
    });
    expect(view.rows[2]).toMatchObject({
      id: "relations",
      status: "stale",
      processed: 1,
      total: 2,
      failed: 0,
      stale: 1,
      detail: "1 / 2 processed; 1 stale",
    });
    expect(view.rows.map((row) => [row.id, row.tone])).toEqual([
      ["retrieval", "ready"],
      ["claims", "ready"],
      ["relations", "warn"],
      ["expansion", "warn"],
      ["graph", "muted"],
    ]);
  });

  test("keeps graph build ready when graph stats are available but graph stages report not configured", () => {
    const view = buildDesktopKnowledgeReadinessView({
      total_documents: 1,
      total_chunks: 4,
      indexed_dense: 4,
      indexed_sparse: 4,
      entity_count: 3,
      relation_count: 2,
      community_count: 1,
      community_report_count: 1,
      graph_ready: true,
      stage_readiness: {
        graph_projection: { stage: "graph_projection", status: "not_configured", ready: false, processed: 0, total: 0 },
        community_report_projection: { stage: "community_report_projection", status: "not_configured", ready: false, processed: 0, total: 0 },
      },
    });

    expect(view.rows.find((row) => row.id === "graph")).toMatchObject({
      status: "ready",
      tone: "ready",
      detail: "1 communities / 1 reports",
    });
  });

  test("shows graph build as pending instead of not configured before entity graph output exists", () => {
    const view = buildDesktopKnowledgeReadinessView({
      total_documents: 1,
      total_chunks: 4,
      indexed_sparse: 4,
      retrieval_ready: true,
      graph_ready: false,
      stage_readiness: {
        graph_projection: { stage: "graph_projection", status: "not_configured", ready: false, processed: 0, total: 0 },
        community_report_projection: { stage: "community_report_projection", status: "not_configured", ready: false, processed: 0, total: 0 },
      },
    });

    expect(view.rows.find((row) => row.id === "graph")).toMatchObject({
      status: "pending",
      tone: "muted",
      detail: "0 communities / 0 reports",
    });
  });

  test("honors fresh query drafts when deciding whether a query can run", () => {
    expect(hasRunnableKnowledgeQueryDraft({ query: "", mode: "hybrid", topK: 5 })).toBe(false);
    expect(hasRunnableKnowledgeQueryDraft({ query: "   ", mode: "hybrid", topK: 5 })).toBe(false);
    expect(hasRunnableKnowledgeQueryDraft({ query: "fresh graph query", mode: "hybrid", topK: 5 })).toBe(true);
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
        typeLabel: "docs",
        sizeLabel: "-",
        addedLabel: "2026-05-31 08:00",
        tags: ["system", "desktop"],
        chunkCount: 12,
        status: "indexed",
        phaseLabel: "Indexed",
        progressPercent: 100,
        progressDetail: "12 chunks indexed",
        updatedAt: "2026-05-31T08:00:00Z",
        meta: "docs / Indexed / 12 chunks / 2026-05-31T08:00:00Z",
      },
    ]);
  });

  test("infers chunked progress when backend status is unknown but chunks exist", () => {
    expect(
      buildDesktopKnowledgeDocumentRows({
        documents: [
          {
            id: "doc-stuck",
            title: "Migration progress",
            path: "knowledge/files/doc.md",
            category: "md",
            chunk_count: 13,
            status: "unknown",
          },
        ],
      })[0],
    ).toMatchObject({
      id: "doc-stuck",
      status: "chunked",
      phaseLabel: "Chunks indexed",
      progressPercent: 50,
      progressDetail: "13 chunks available; waiting for semantic or graph stages",
      meta: "md / Chunks indexed / 13 chunks",
    });
  });

  test("preserves failed document progress instead of falling back to queued", () => {
    expect(
      buildDesktopKnowledgeDocumentRows({
        documents: [
          {
            id: "doc-failed",
            title: "Broken notes",
            path: "knowledge/files/broken.md",
            category: "md",
            chunk_count: 4,
            status: "failed",
          },
        ],
      })[0],
    ).toMatchObject({
      id: "doc-failed",
      status: "failed",
      phaseLabel: "Failed",
      progressPercent: 0,
      progressDetail: "4 chunks parsed; indexing failed",
      meta: "md / Failed / 4 chunks",
    });
  });

  test("preserves native not configured semantic stages while treating graph build as pending work", () => {
    const view = buildDesktopKnowledgeReadinessView({
      total_documents: 1,
      total_chunks: 13,
      indexed_sparse: 26,
      stage_readiness: {
        dense_indexing: { status: "not_configured", ready: false, processed: 0, total: 0, skipped: 13 },
        sparse_indexing: { status: "ready", ready: true, processed: 26, total: 26 },
        claim_extraction: { status: "not_configured", ready: false, processed: 0, total: 0, skipped: 13 },
        relation_extraction: { status: "not_configured", ready: false, processed: 0, total: 0, skipped: 13 },
        graph_projection: { status: "not_configured", ready: false, processed: 0, total: 0, skipped: 13 },
        community_report_projection: { status: "not_configured", ready: false, processed: 0, total: 0, skipped: 13 },
      },
    });

    expect(view.rows.find((row) => row.id === "retrieval")).toMatchObject({
      status: "ready",
      tone: "ready",
      detail: "26 / 26 processed",
    });
    expect(view.rows.find((row) => row.id === "claims")).toMatchObject({
      status: "not_configured",
      tone: "muted",
      detail: "not_configured",
    });
    expect(view.rows.find((row) => row.id === "graph")).toMatchObject({
      status: "pending",
      tone: "muted",
      detail: "0 communities / 0 reports",
    });
  });

  test("does not advertise deterministic GraphRAG reports when report projection is not configured", () => {
    const pane = buildDesktopKnowledgePaneModel({
      statsPayload: {
        total_documents: 1,
        total_chunks: 135,
        retrieval_ready: true,
        stage_readiness: {
          sparse_indexing: { status: "ready", ready: true, processed: 135, total: 135 },
          claim_extraction: { status: "not_configured", ready: false, processed: 0, total: 0, skipped: 135 },
          relation_extraction: { status: "not_configured", ready: false, processed: 0, total: 0, skipped: 135 },
          graph_projection: { status: "not_configured", ready: false, processed: 0, total: 0, skipped: 135 },
          community_report_projection: { status: "not_configured", ready: false, processed: 0, total: 0, skipped: 135 },
        },
      },
      config: {
        knowledge: {
          enabled: true,
          retrieval_mode: "hybrid",
          max_chunks: 5,
          graphrag_report_llm_enabled: false,
        },
      },
    });

    expect(pane.configHints).toContain("GraphRAG reports not configured");
    expect(pane.configHints).not.toContain("GraphRAG reports use deterministic summaries");
  });

  test("reads canonical GraphRAG enabled config key when building report hints", () => {
    const pane = buildDesktopKnowledgePaneModel({
      statsPayload: {
        total_documents: 1,
        total_chunks: 12,
        retrieval_ready: true,
      },
      config: {
        knowledge: {
          enabled: true,
          retrieval_mode: "hybrid",
          max_chunks: 5,
          graphragEnabled: false,
          graphrag_report_llm_enabled: false,
        },
      },
    });

    expect(pane.configHints).toContain("GraphRAG reports not configured");
    expect(pane.configHints).not.toContain("GraphRAG reports use deterministic summaries");
  });

  test("normalizes root WebUI list envelopes for native knowledge documents", () => {
    expect(
      buildDesktopKnowledgeDocumentRows({
        object: "list",
        data: [
          {
            id: "doc-upload",
            name: "Uploaded notes",
            path: "knowledge/notes.md",
            chunk_count: 3,
            updated_at: "2026-06-15T08:30:00Z",
            status: "indexed",
          },
        ],
        total: 1,
      }),
    ).toEqual([
      {
        id: "doc-upload",
        title: "Uploaded notes",
        path: "knowledge/notes.md",
        category: "",
        typeLabel: "MD",
        sizeLabel: "-",
        addedLabel: "2026-06-15 08:30",
        tags: [],
        chunkCount: 3,
        status: "indexed",
        phaseLabel: "Indexed",
        progressPercent: 100,
        progressDetail: "3 chunks indexed",
        updatedAt: "2026-06-15T08:30:00Z",
        meta: "Indexed / 3 chunks / 2026-06-15T08:30:00Z",
      },
    ]);
  });

  test("projects backend knowledge indexing and rebuild jobs into task center operations", () => {
    const operations = buildDesktopKnowledgeTaskOperations([
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
        job: {
          id: "kjob_extract",
          doc_id: "doc-1",
          name: "extract_graph:doc-1",
          status: "running",
          stage: "llm_extraction",
          message: "Extracting entity graph",
          llm_output_chars: 128,
          llm_reasoning_chars: 24,
          llm_preview: "{\"entities\":[{\"name\":\"TinyBot\"}],\"relations\":[]}",
          progress: {
            stage: "llm_extraction",
            completed: 6,
            total: 8,
            documents: [
              {
                doc_id: "doc-1",
                doc_name: "Architecture.md",
                status: "running",
                stage: "llm_extraction",
                completed: 6,
                total: 8,
                token_estimate: { total_tokens: 512, max_tokens: 1200 },
                extraction_scope: { chunk_count: 2, original_chunk_count: 4 },
                stages: [
                  { stage: "resolved_document", status: "completed" },
                  { stage: "loaded_content", status: "completed" },
                  { stage: "estimated_tokens", status: "completed" },
                  { stage: "checked_existing_graph", status: "completed" },
                  { stage: "checked_budget", status: "completed" },
                  { stage: "llm_extraction", status: "running" },
                  { stage: "parsed_graph_json", status: "pending" },
                  { stage: "persisted_entity_graph", status: "pending" },
                ],
              },
            ],
          },
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
    ]);

    expect(operations).toMatchObject([
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
        id: "knowledge:kjob_extract",
        title: "Extract knowledge graph",
        status: "running",
        detail: "Extracting entity graph / llm_extraction / 1 document: 6/8 stages",
        progress: { completed: 6, total: 8 },
        canonical: { module: "knowledge", entityId: "doc-1", href: "/knowledge" },
        diagnostics: "Architecture.md: llm_extraction, 6/8 stages, 512/1200 tokens, 2/4 chunks\nStages: resolved_document=completed, loaded_content=completed, estimated_tokens=completed, checked_existing_graph=completed, checked_budget=completed, llm_extraction=running, parsed_graph_json=pending, persisted_entity_graph=pending\nLLM output: 128 chars; reasoning: 24 chars; preview: {\"entities\":[{\"name\":\"TinyBot\"}],\"relations\":[]}",
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
    expect(operations[0].relatedResources).toEqual([
      {
        kind: "evidence",
        id: "knowledge-source:doc-1",
        title: "desktop-notes.md",
        detail: "dense_indexing",
        route: { module: "knowledge", entityId: "doc-1", href: "/knowledge" },
      },
    ]);
    expect(operations[3].outputs).toEqual([
      {
        kind: "diagnostic",
        id: "knowledge-diagnostic:kjob_failed",
        title: "Knowledge diagnostics",
        detail: "embedding timeout",
        route: { module: "knowledge", entityId: "doc-2", href: "/knowledge" },
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

  test("summarizes query retrieval plan metadata for UI inspection", () => {
    const view = buildDesktopKnowledgeQueryResultRows({
      retrieval_plan: {
        classification: "hybrid",
        selected_routes: ["keyword", "tree", "graph"],
        budgets: { keyword: 3, tree: 3, graph: 2, semantic: 0 },
        tree_options: {
          include_structure_context: true,
          context_budget: 3,
          trigger: "auto",
        },
        graph_options: {
          include_graph_context: true,
          max_hops: 2,
          max_added_chunks: 2,
        },
      },
      data: [
        {
          doc_id: "doc-1",
          doc_name: "Runtime Notes",
          content: "Runtime scheduler details.",
          matched_methods: ["keyword", "structure"],
          score: 1,
        },
      ],
    });

    expect(view.summary.retrievalPlan).toEqual({
      classification: "hybrid",
      routes: ["keyword", "tree", "graph"],
      budgetLabel: "keyword 3 / tree 3 / graph 2 / semantic 0",
      treeLabel: "tree auto, context 3",
      graphLabel: "graph hops 2, adds 2",
    });
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

  test("normalizes GraphRAG index tables into graph, reports, claims, and evidence", () => {
    const graph = buildDesktopKnowledgeGraphView({
      object: "graphrag_index",
      documents: [{ id: "doc-1", title: "Desktop UX" }],
      text_units: [{ id: "tu-1", document_id: "doc-1", text: "Desktop uses traceable evidence.", covariate_ids: ["claim-1"] }],
      entities: [
        { id: "entity-1", title: "Desktop", type: "concept" },
        { id: "entity-2", title: "Evidence", type: "concept" },
      ],
      relationships: [
        {
          id: "rel-1",
          source: "Desktop",
          target: "Evidence",
          predicate: "uses",
          confidence: 0.8,
          text_unit_ids: ["tu-1"],
        },
      ],
      covariates: [{ id: "claim-1", text: "Desktop uses traceable evidence.", source: { doc_name: "Desktop UX" } }],
      communities: [{ community: 0, title: "Desktop cluster", summary: "Traceability cluster" }],
      community_reports: [{ id: "report-1", community: 0, title: "Desktop report", summary: "Report summary" }],
    });
    const pane = buildDesktopKnowledgePaneModel({
      graphPayload: {
        object: "graphrag_index",
        documents: [{ id: "doc-1", title: "Desktop UX" }],
        text_units: [{ id: "tu-1", document_id: "doc-1", text: "Desktop uses traceable evidence.", covariate_ids: ["claim-1"] }],
        entities: [
          { id: "entity-1", title: "Desktop", type: "concept" },
          { id: "entity-2", title: "Evidence", type: "concept" },
        ],
        relationships: [
          {
            id: "rel-1",
            source: "Desktop",
            target: "Evidence",
            predicate: "uses",
            confidence: 0.8,
            text_unit_ids: ["tu-1"],
          },
        ],
        covariates: [{ id: "claim-1", text: "Desktop uses traceable evidence.", source: { doc_name: "Desktop UX" } }],
        communities: [{ community: 0, title: "Desktop cluster", summary: "Traceability cluster" }],
        community_reports: [{ id: "report-1", community: 0, title: "Desktop report", summary: "Report summary" }],
      },
    });

    expect(graph.nodes.map((node) => node.label)).toEqual(["Desktop", "Evidence"]);
    expect(graph.edges[0]).toMatchObject({
      id: "rel-1",
      title: "Desktop -[uses]-> Evidence",
      sourceId: "entity-1",
      targetId: "entity-2",
      evidenceCount: 1,
    });
    expect(graph.evidenceRows[0]).toMatchObject({
      edgeId: "rel-1",
      docName: "Desktop UX",
      evidenceText: "Desktop uses traceable evidence.",
      claimId: "claim-1",
    });
    expect(pane.graph).toMatchObject({
      summary: "2 nodes / 1 edge / 1 evidence",
      communities: [{ id: "0", title: "Desktop cluster", text: "Traceability cluster" }],
      reports: [{ id: "report-1", title: "Desktop report", text: "Report summary" }],
      claims: [{ id: "claim-1", title: "Desktop uses traceable evidence." }],
    });
  });

  test("builds a desktop knowledge pane model with documents, query, graph, and traceability summaries", () => {
    const pane = buildDesktopKnowledgePaneModel({
      statsPayload: {
        total_documents: 2,
        total_chunks: 18,
        indexed_dense: 18,
        indexed_sparse: 18,
        claim_count: 3,
        relation_count: 2,
        community_count: 1,
        community_report_count: 1,
        claims_ready: true,
        relations_ready: true,
        graph_ready: true,
        stage_readiness: {
          evidence_expansion: { stage: "evidence_expansion", status: "complete", ready: true, processed: 3, total: 3 },
        },
      },
      config: {
        knowledge: {
          enabled: true,
          retrieval_mode: "hybrid",
          max_chunks: 6,
          graphrag_report_llm_enabled: false,
        },
      },
      documentsPayload: {
        documents: [
          { id: "doc-1", title: "Desktop UX", path: "docs/desktop.md", tags: ["desktop"], chunk_count: 10, status: "indexed" },
          { id: "doc-2", title: "Gateway", path: "docs/gateway.md", chunk_count: 8, status: "indexed" },
        ],
      },
      selectedDocumentId: "doc-1",
      queryDraft: { query: "desktop graph", mode: "local", topK: 4 },
      queryResultPayload: {
        data: [
          {
            doc_id: "doc-1",
            doc_name: "Desktop UX",
            content: "Desktop panes expose graph evidence.",
            semantic_fusion_score: 0.67,
            matched_entities: ["Desktop"],
            matched_relations: ["Desktop->Evidence"],
            matched_communities: ["community-1"],
            matched_claim_evidence: [
              { id: "claim-1", text: "Desktop panes expose graph evidence.", source: { doc_name: "Desktop UX" } },
            ],
          },
        ],
      },
      graphPayload: {
        nodes: [
          { id: "desktop", label: "Desktop", type: "entity" },
          { id: "evidence", label: "Evidence", type: "entity" },
        ],
        edges: [
          {
            id: "edge-1",
            source: "desktop",
            target: "evidence",
            predicate: "exposes",
            evidence: [{ id: "ev-1", doc_name: "Desktop UX", evidence_text: "Desktop panes expose graph evidence." }],
          },
        ],
        communities: [{ id: "community-1", title: "Desktop cluster", summary: "Desktop evidence cluster" }],
        reports: [{ id: "report-1", title: "Desktop report", summary: "Report summary" }],
        claims: [{ id: "claim-1", text: "Desktop panes expose graph evidence.", source: { doc_name: "Desktop UX" } }],
        conflicts: [{ id: "conflict-1", conflict_type: "contradiction", sources: [{ doc_name: "Desktop UX" }, { doc_name: "Gateway" }] }],
      },
    });

    expect(pane.status).toBe("2 docs / readiness 100% / graph 2 nodes / 1 edge");
    expect(pane.configHints).toEqual([
      "Knowledge enabled",
      "Retrieval hybrid",
      "Max chunks 6",
      "GraphRAG reports use deterministic summaries",
    ]);
    expect(pane.selectedDocument).toMatchObject({
      id: "doc-1",
      title: "Desktop UX",
      detail: "docs/desktop.md / Indexed / 10 chunks",
    });
    expect(pane.query).toMatchObject({
      draft: { query: "desktop graph", mode: "local", topK: 4 },
      request: { query: "desktop graph", mode: "local", top_k: 4 },
      results: { summary: { count: 1, docs: ["Desktop UX"], lowConfidence: false } },
    });
    expect(pane.graph).toMatchObject({
      summary: "2 nodes / 1 edge / 1 evidence",
      communities: [{ id: "community-1", title: "Desktop cluster", meta: "community", text: "Desktop evidence cluster" }],
      reports: [{ id: "report-1", title: "Desktop report", meta: "report", text: "Report summary" }],
      claims: [{ id: "claim-1", title: "Desktop panes expose graph evidence." }],
      conflicts: [{ id: "conflict-1", title: "record left conflicts with record right" }],
    });
    expect(pane.actions).toEqual({
      upload: true,
      deleteDocument: true,
      rebuild: true,
      query: true,
      refreshGraph: true,
    });
  });
});
