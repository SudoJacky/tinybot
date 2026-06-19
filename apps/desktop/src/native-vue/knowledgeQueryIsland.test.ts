// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import type { DesktopKnowledgePaneModel, DesktopKnowledgeQueryResultRow } from "../desktopKnowledgeTraceability";
import { mountKnowledgeQueryIsland } from "./knowledgeQueryIsland";

const draft: DesktopKnowledgePaneModel["query"]["draft"] = {
  query: "desktop",
  mode: "hybrid",
  topK: 5,
};

function queryRow(index: number): DesktopKnowledgeQueryResultRow {
  return {
    id: `result-${index}`,
    docName: `Doc ${index}`,
    content: `Knowledge result ${index}`,
    relevance: index === 1 ? "high" : "medium",
    scoreLabel: `0.${index}`,
    meta: `chunk ${index}`,
    why: "matched query",
    traceabilitySections: [],
    graphHighlight: {
      query: "desktop",
      entities: [],
      relations: [],
      communities: [],
      docId: `doc-${index}`,
      docName: `Doc ${index}`,
    },
    raw: {},
  };
}

describe("knowledge query Vue island", () => {
  test("renders query summary and the existing first-four result copy", () => {
    const host = document.createElement("section");
    const actions: Array<{ query: string; mode: string; topK: number }> = [];

    const mounted = mountKnowledgeQueryIsland(host, {
      draft,
      results: {
        summary: {
          count: 5,
          docs: ["Doc 1", "Doc 2"],
          lowConfidence: false,
        },
        rows: [1, 2, 3, 4, 5].map(queryRow),
      },
      onRunQuery: (nextDraft) => actions.push(nextDraft),
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("knowledge-query");
    expect(host.className).toContain("desktop-knowledge-query");
    expect(host.querySelector("h2")).toBeNull();
    expect(host.querySelector(".desktop-knowledge-query-panel")).not.toBeNull();
    expect(host.querySelector(".desktop-knowledge-query-summary")?.textContent).toContain("Mode: hybrid");
    expect(host.querySelector(".desktop-knowledge-query-summary")?.textContent).toContain("Results: 5");
    expect(host.querySelector<HTMLInputElement>("[data-desktop-knowledge-query-input]")?.value).toBe("desktop");
    expect(host.querySelector<HTMLSelectElement>("[data-desktop-knowledge-query-mode]")?.value).toBe("hybrid");
    expect(host.querySelector<HTMLInputElement>("[data-desktop-knowledge-query-top-k]")?.value).toBe("5");
    expect(host.textContent).toContain("Doc 1: Knowledge result 1");
    expect(host.textContent).toContain("Doc 4: Knowledge result 4");
    expect(host.textContent).not.toContain("Doc 5: Knowledge result 5");

    host.querySelector<HTMLInputElement>("[data-desktop-knowledge-query-input]")!.value = "graph evidence";
    host.querySelector<HTMLInputElement>("[data-desktop-knowledge-query-input]")?.dispatchEvent(new Event("input"));
    host.querySelector<HTMLSelectElement>("[data-desktop-knowledge-query-mode]")!.value = "local";
    host.querySelector<HTMLSelectElement>("[data-desktop-knowledge-query-mode]")?.dispatchEvent(new Event("change"));
    host.querySelector<HTMLInputElement>("[data-desktop-knowledge-query-top-k]")!.value = "7";
    host.querySelector<HTMLInputElement>("[data-desktop-knowledge-query-top-k]")?.dispatchEvent(new Event("input"));
    host.querySelector<HTMLButtonElement>('[data-desktop-knowledge-action="runQuery"]')?.click();

    expect(actions).toEqual([{ query: "graph evidence", mode: "local", topK: 7 }]);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("renders retrieval plan inspection metadata", () => {
    const host = document.createElement("section");

    const mounted = mountKnowledgeQueryIsland(host, {
      draft,
      results: {
        summary: {
          count: 1,
          docs: ["Doc 1"],
          lowConfidence: false,
          retrievalPlan: {
            classification: "hybrid",
            routes: ["keyword", "tree", "graph"],
            budgetLabel: "keyword 3 / tree 3 / graph 2 / semantic 0",
            treeLabel: "tree auto, context 3",
            graphLabel: "graph hops 2, adds 2",
          },
        },
        rows: [queryRow(1)],
      },
    });

    expect(host.textContent).toContain("Plan: hybrid");
    expect(host.textContent).toContain("Routes: keyword + tree + graph");
    expect(host.textContent).toContain("keyword 3 / tree 3 / graph 2 / semantic 0");
    expect(host.textContent).toContain("tree auto, context 3");
    expect(host.textContent).toContain("graph hops 2, adds 2");

    mounted.unmount();
  });
});
