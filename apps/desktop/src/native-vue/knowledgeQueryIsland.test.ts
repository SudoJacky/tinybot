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
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("knowledge-query");
    expect(host.className).toContain("desktop-knowledge-query");
    expect(host.querySelector("h2")?.textContent).toBe("Query: desktop");
    expect(host.textContent).toContain("Mode: hybrid / top 5");
    expect(host.textContent).toContain("Results: 5");
    expect(host.textContent).toContain("Doc 1: Knowledge result 1");
    expect(host.textContent).toContain("Doc 4: Knowledge result 4");
    expect(host.textContent).not.toContain("Doc 5: Knowledge result 5");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
