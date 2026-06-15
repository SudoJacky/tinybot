// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import type { DesktopKnowledgeReadinessView } from "../desktopKnowledgeTraceability";
import { mountKnowledgeReadinessIsland } from "./knowledgeReadinessIsland";

const readiness: DesktopKnowledgeReadinessView = {
  score: 80,
  titleKey: "knowledge.readiness.partial",
  descKey: "knowledge.readiness.partial.desc",
  descReplacements: { ready: 4, total: 5 },
  partialAvailability: true,
  failedStageCount: 0,
  staleStageCount: 1,
  rows: [
    {
      id: "retrieval",
      titleKey: "knowledge.readiness.retrieval",
      textKey: "knowledge.readiness.retrieval.text",
      statusKey: "knowledge.readiness.ready",
      tone: "ready",
      replacements: { chunks: 10 },
    },
    {
      id: "graph",
      titleKey: "knowledge.readiness.graph",
      textKey: "knowledge.readiness.graph.text",
      statusKey: "knowledge.readiness.warn",
      tone: "warn",
      replacements: { nodes: 2 },
    },
  ],
};

describe("knowledge readiness Vue island", () => {
  test("renders readiness hints and rows with existing desktop copy", () => {
    const host = document.createElement("section");

    const mounted = mountKnowledgeReadinessIsland(host, {
      readiness,
      configHints: ["Knowledge enabled", "Retrieval hybrid"],
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("knowledge-readiness");
    expect(host.className).toContain("desktop-knowledge-readiness");
    expect(host.textContent).toContain("Upload");
    expect(host.textContent).toContain("Parse");
    expect(host.textContent).toContain("Chunk");
    expect(host.textContent).toContain("Embed");
    expect(host.textContent).toContain("Graph Build");
    expect(host.textContent).toContain("Complete");
    expect(host.textContent).toContain("Knowledge enabled");
    expect(host.textContent).toContain("Retrieval hybrid");
    expect(host.textContent).toContain("retrieval: ready");
    expect(host.textContent).toContain("graph: warn");
    expect(host.textContent).toContain("EmbedReady");
    expect(host.textContent).not.toContain("EmbedIn progress");
    expect(host.textContent).toContain("4 / 6 steps");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
