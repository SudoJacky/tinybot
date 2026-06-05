// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { buildDesktopKnowledgePaneModel } from "../desktopKnowledgeTraceability";
import type { DesktopTaskCenterItem } from "../desktopTaskCenter";
import { mountKnowledgePaneIsland } from "./knowledgePaneIsland";

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
    const actions: string[] = [];
    const inspected: string[] = [];

    const mounted = mountKnowledgePaneIsland(host, {
      pane,
      workItems: [workItem],
      onInspectWorkItem: (item) => inspected.push(item.id),
      onKnowledgeAction: (event) => actions.push(event.action),
    });

    expect(host.className).toBe("desktop-workbench-section desktop-knowledge-pane");
    expect(host.getAttribute("data-desktop-vue-island")).toBe("knowledge-pane");
    expect(host.getAttribute("data-desktop-module-surface")).toBe("knowledge");
    expect(host.getAttribute("aria-label")).toBe("Knowledge workbench");
    expect(host.textContent).toContain("Knowledge");
    expect(host.textContent).toContain("2 docs / readiness 100% / graph 2 nodes / 1 edge");

    expect(host.querySelector('[data-desktop-knowledge-action="runQuery"]')?.textContent).toContain("Run query");
    expect(host.querySelector(".desktop-knowledge-readiness")?.textContent).toContain("Readiness");
    expect(host.querySelector('[data-desktop-entity-module="knowledge"]')?.getAttribute("data-desktop-entity-id")).toBe("doc-1");
    expect(host.querySelector(".desktop-knowledge-document-detail")?.textContent).toContain("Document detail: Desktop UX");
    expect(host.querySelector('[data-desktop-knowledge-query-result]')?.textContent).toContain("Desktop panes expose graph evidence.");
    expect(host.querySelector('[data-desktop-knowledge-graph-reference="Community:community-1"]')?.textContent).toContain("Desktop cluster");
    expect(host.querySelector('[data-desktop-module-work="knowledge:rebuild"]')?.textContent).toContain("Rebuild knowledge index");

    host.querySelector<HTMLButtonElement>('[data-desktop-knowledge-action="runQuery"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-module-work="knowledge:rebuild"]')?.click();

    expect(actions).toEqual(["runQuery"]);
    expect(inspected).toEqual(["knowledge:rebuild"]);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
