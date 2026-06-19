// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { buildDesktopKnowledgePaneModel } from "../desktopKnowledgeTraceability";
import type { DesktopTaskCenterItem } from "../desktopTaskCenter";
import { mountKnowledgePaneIsland } from "./knowledgePaneIsland";

const pane = buildDesktopKnowledgePaneModel({
  statsPayload: {
    total_documents: 2,
    total_chunks: 18,
    last_indexed_at: "2026-06-14T09:41:00Z",
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
      { id: "doc-1", title: "Desktop UX", path: "docs/desktop.md", tags: ["desktop"], category: "MD", size_bytes: 86000, chunk_count: 10, status: "indexed", updated_at: "2h ago" },
      { id: "doc-2", title: "Migration progress", path: "knowledge/files/doc.md", category: "MD", chunk_count: 13, status: "unknown", updated_at: "5h ago" },
    ],
  },
  selectedDocumentId: "doc-1",
  queryDraft: { query: "desktop graph", mode: "local", topK: 4 },
  queryResultPayload: {
    data: [{
      doc_id: "doc-1",
      doc_name: "Desktop UX",
      content: "Desktop panes expose graph evidence.",
      semantic_fusion_score: 0.67,
    }],
  },
  graphPayload: {
    nodes: [
      { id: "desktop", label: "Desktop", type: "entity" },
      { id: "evidence", label: "Evidence", type: "entity" },
    ],
    edges: [{
      id: "edge-1",
      source: "desktop",
      target: "evidence",
      predicate: "exposes",
      evidence: [{ id: "ev-1", doc_name: "Desktop UX", evidence_text: "Desktop panes expose graph evidence." }],
    }],
    communities: [{ id: "community-1", title: "Desktop cluster", summary: "Desktop evidence cluster" }],
    reports: [{ id: "report-1", title: "Desktop report", summary: "Report summary" }],
    claims: [{ id: "claim-1", text: "Desktop panes expose graph evidence.", source: { doc_name: "Desktop UX" } }],
  },
});

const workItem: DesktopTaskCenterItem = {
  id: "knowledge:rebuild",
  source: "knowledge",
  title: "Rebuild knowledge index",
  state: "active",
  status: "running",
  tone: "normal",
  detail: "Evidence expansion",
  progress: null,
  progressLabel: "3/3",
  destination: { module: "knowledge", entityId: "index", href: "/knowledge" },
  diagnostics: "",
  relatedResources: [],
  outputs: [],
  actions: [],
  updatedAt: "",
};

describe("knowledge pane Vue island", () => {
  test("renders the knowledge surface and forwards actions", () => {
    const host = document.createElement("section");
    const actions: Array<{ action: string; query?: string }> = [];
    const inspected: string[] = [];

    const mounted = mountKnowledgePaneIsland(host, {
      pane,
      workItems: [workItem],
      onInspectWorkItem: (item) => inspected.push(item.id),
      onKnowledgeAction: (event) => actions.push({ action: event.action, query: event.queryDraft?.query }),
    });

    expect(host.className).toBe("desktop-workbench-section desktop-knowledge-pane");
    expect(host.getAttribute("data-desktop-vue-island")).toBe("knowledge-pane");
    expect(host.getAttribute("data-desktop-module-surface")).toBe("knowledge");
    expect(host.getAttribute("aria-label")).toBe("Knowledge workbench");
    expect(host.querySelector(".desktop-knowledge-toolbar")?.textContent).toContain("Refresh All");
    expect(host.querySelector(".desktop-knowledge-toolbar")?.textContent).not.toContain("Settings");
    expect(host.querySelector(".desktop-knowledge-toolbar")?.textContent).not.toContain("Upload Documents");
    expect(host.querySelector(".desktop-knowledge-management-grid")?.getAttribute("data-desktop-knowledge-layout")).toBe(
      "source-left-graph-right",
    );
    const sourceColumn = host.querySelector('[data-desktop-knowledge-column="source"]');
    const inspectorColumn = host.querySelector('[data-desktop-knowledge-column="inspector"]');
    expect(Array.from(sourceColumn?.children ?? [], (node) => node.getAttribute("data-desktop-knowledge-region"))).toEqual([
      "overview",
      "upload",
      "queue",
      "documents",
      "query",
      "pipeline",
    ]);
    expect(Array.from(inspectorColumn?.children ?? [], (node) => node.getAttribute("data-desktop-knowledge-region"))).toEqual([
      "graph",
    ]);
    expect(Array.from(host.querySelectorAll("[data-desktop-knowledge-region]"), (node) => node.getAttribute("data-desktop-knowledge-region"))).toEqual([
      "overview",
      "upload",
      "queue",
      "documents",
      "query",
      "pipeline",
      "graph",
    ]);
    expect(host.querySelector(".desktop-knowledge-title-block h2")?.textContent).toBe("Knowledge Base");
    expect(host.textContent).toContain("Manage your knowledge base, monitor ingestion, and explore the knowledge graph.");
    expect(host.textContent).toContain("2 docs / readiness 100% / graph 2 nodes / 1 edge");

    expect(host.querySelector('[data-desktop-knowledge-region="overview"]')?.textContent).toContain("Documents");
    expect(host.querySelector('[data-desktop-knowledge-region="overview"]')?.textContent).toContain("2");
    expect(host.querySelector('[data-desktop-knowledge-region="overview"]')?.textContent).toContain("Graph Nodes");
    expect(host.querySelector('[data-desktop-knowledge-region="overview"]')?.textContent).toContain("Relations");
    expect(host.querySelector('[data-desktop-knowledge-region="overview"]')?.textContent).toContain("Last Indexed");
    expect(host.querySelector('[data-desktop-knowledge-region="overview"]')?.textContent).toContain("2026-06-14 09:41");
    expect(host.querySelector('[data-desktop-knowledge-region="upload"] .desktop-knowledge-drop-zone')?.textContent).toContain("Drag & drop files here or click to browse");
    expect(host.querySelector('[data-desktop-knowledge-region="upload"] .desktop-knowledge-drop-zone')?.textContent).toContain("PDF, DOCX, MD, TXT, CSV, JSON");
    expect(host.querySelector('[data-desktop-knowledge-region="upload"] .desktop-knowledge-drop-zone')?.textContent).toContain("Max 200MB per file");
    expect(host.querySelector('[data-desktop-knowledge-region="upload"] .desktop-knowledge-drop-zone')?.getAttribute("data-desktop-drop-target")).toBe(
      "knowledge-document",
    );
    expect(host.querySelector('[data-desktop-knowledge-region="upload"] #desktop-file-upload-status')?.textContent).toContain(
      "No file operation running.",
    );
    expect(host.querySelector('[data-desktop-knowledge-region="upload"] [data-desktop-knowledge-action="uploadDocument"]')?.textContent).toContain("Upload Documents");
    expect(host.querySelector('[data-desktop-knowledge-region="upload"] #desktop-knowledge-upload')?.getAttribute("data-desktop-file-upload")).toBe(
      "knowledge-document",
    );
    expect(host.querySelector('[data-desktop-knowledge-region="queue"]')?.textContent).toContain("Knowledge Jobs");
    expect(host.querySelector('[data-desktop-knowledge-region="queue"]')?.textContent).toContain("Rebuild knowledge index");
    expect(host.querySelector('[data-desktop-knowledge-region="queue"]')?.textContent).not.toContain("Desktop UX");
    expect(host.querySelector('[data-desktop-knowledge-queue-action="pause"]')).toBeNull();
    expect(host.querySelector('[data-desktop-knowledge-queue-action="cancel"]')).toBeNull();
    expect(host.querySelector('[data-desktop-knowledge-region="documents"]')?.textContent).toContain("Documents (2)");
    expect(host.querySelector('[data-desktop-knowledge-region="documents"]')?.textContent).toContain("Search, inspect, and delete knowledge sources.");
    expect(host.querySelector('[data-desktop-knowledge-document-search]')?.getAttribute("placeholder")).toBe("Search documents...");
    expect(host.querySelector('[data-desktop-knowledge-document-filter]')).toBeNull();
    expect(host.querySelector('[aria-label="Document actions"]')).toBeNull();
    expect(host.querySelector('[data-desktop-knowledge-document-action="reindexDocument"]')).toBeNull();
    expect(host.querySelector('[data-desktop-knowledge-documents-table]')?.textContent).toContain("Name");
    expect(host.querySelector('[data-desktop-knowledge-documents-table]')?.textContent).toContain("Type");
    expect(host.querySelector('[data-desktop-knowledge-documents-table]')?.textContent).toContain("Size");
    expect(host.querySelector('[data-desktop-knowledge-documents-table]')?.textContent).toContain("Status");
    expect(host.querySelector('[data-desktop-knowledge-documents-table]')?.textContent).toContain("Actions");
    expect(host.querySelector('[data-desktop-knowledge-document-action="deleteDocument"]')?.textContent).toContain("Delete");
    expect(host.querySelector('[data-desktop-knowledge-region="documents"] .desktop-knowledge-documents')?.getAttribute("data-desktop-vue-island")).toBe(
      "knowledge-documents",
    );
    expect(host.querySelector('[data-desktop-entity-module="knowledge"]')?.getAttribute("data-desktop-entity-id")).toBe("doc-1");
    expect(host.querySelector('[data-desktop-knowledge-region="documents"] .desktop-knowledge-document-detail')?.getAttribute("data-desktop-vue-island")).toBe(
      "knowledge-document-detail",
    );
    expect(host.querySelector('[data-desktop-knowledge-region="documents"] .desktop-knowledge-document-detail')?.textContent).toContain("Document detail: Desktop UX");
    expect(host.querySelector('[data-desktop-knowledge-region="query"] .desktop-knowledge-query')?.getAttribute("data-desktop-vue-island")).toBe(
      "knowledge-query",
    );
    expect(host.querySelector('[data-desktop-knowledge-region="query"]')?.textContent).toContain("Knowledge Query");
    expect(host.querySelector('[data-desktop-knowledge-query-input]')?.getAttribute("value")).toBe("desktop graph");
    expect(host.querySelector('[data-desktop-knowledge-action="runQuery"]')?.textContent).toContain("Run Query");
    expect(host.querySelector('[data-desktop-knowledge-query-result="doc-1:0"]')?.textContent).toContain("Desktop panes expose graph evidence.");
    expect(host.querySelector('[data-desktop-knowledge-region="graph"] .desktop-knowledge-graph')?.getAttribute("data-desktop-vue-island")).toBe(
      "knowledge-graph",
    );
    expect(host.querySelector('[data-desktop-knowledge-region="graph"]')?.textContent).toContain("Extract Graph");
    expect(host.querySelector('[data-desktop-knowledge-region="graph"]')?.textContent).toContain("Rebuild Index");
    expect(host.querySelector('[data-desktop-knowledge-region="graph"]')?.textContent).not.toContain("Refresh Graph");
    expect(host.querySelector('[data-desktop-knowledge-region="graph"]')?.textContent).not.toContain("Fit View");
    expect(host.querySelector('[data-desktop-knowledge-region="graph"]')?.textContent).not.toContain("Layout");
    expect(host.querySelector(".desktop-knowledge-graph-tools")).toBeNull();
    expect(host.querySelector(".desktop-knowledge-graph-legend")?.textContent).toContain("Entity");
    expect(host.querySelector(".desktop-knowledge-graph-minimap")).not.toBeNull();
    expect(host.querySelector('[data-desktop-knowledge-graph-reference="Community:community-1"]')?.textContent).toContain("Desktop cluster");
    expect(host.querySelector('[data-desktop-knowledge-region="pipeline"] .desktop-knowledge-readiness')?.getAttribute("data-desktop-vue-island")).toBe(
      "knowledge-readiness",
    );
    expect(host.querySelector('[data-desktop-knowledge-region="pipeline"] .desktop-knowledge-readiness')?.textContent).toContain("Upload");
    expect(host.querySelector('[data-desktop-knowledge-region="pipeline"] .desktop-knowledge-readiness')?.textContent).toContain("Parse");
    expect(host.querySelector('[data-desktop-knowledge-region="pipeline"] .desktop-knowledge-readiness')?.textContent).toContain("Chunk");
    expect(host.querySelector('[data-desktop-knowledge-region="pipeline"] .desktop-knowledge-readiness')?.textContent).toContain("Embed");
    expect(host.querySelector('[data-desktop-knowledge-region="pipeline"] .desktop-knowledge-readiness')?.textContent).toContain("Graph Build");
    expect(host.querySelector('[data-desktop-knowledge-region="pipeline"] .desktop-knowledge-readiness')?.textContent).toContain("Complete");
    expect(host.querySelector('[data-desktop-knowledge-region="pipeline"] .desktop-knowledge-readiness')?.textContent).toContain("6 steps");
    expect(host.querySelector('[data-desktop-knowledge-region="pipeline"] .desktop-module-work')).toBeNull();

    host.querySelector<HTMLButtonElement>('[data-desktop-knowledge-action="refreshAll"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-knowledge-action="uploadDocument"]')?.click();
    host.querySelector<HTMLInputElement>('[data-desktop-knowledge-query-input]')!.value = "updated graph query";
    host.querySelector<HTMLInputElement>('[data-desktop-knowledge-query-input]')?.dispatchEvent(new Event("input"));
    host.querySelector<HTMLButtonElement>('[data-desktop-knowledge-action="runQuery"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-knowledge-action="extractGraph"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-knowledge-action="rebuildIndex"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-knowledge-document-action="deleteDocument"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-module-work="knowledge:rebuild"]')?.click();

    expect(actions).toEqual([
      { action: "refreshAll", query: undefined },
      { action: "uploadDocument", query: undefined },
      { action: "runQuery", query: "updated graph query" },
      { action: "extractGraph", query: undefined },
      { action: "rebuildIndex", query: undefined },
      { action: "deleteDocument", query: undefined },
    ]);
    expect(inspected).toEqual(["knowledge:rebuild"]);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
