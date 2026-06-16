import { describe, expect, test } from "vitest";

import {
  buildKnowledgeGraphExtractionPrompt,
  buildKnowledgeGraphExtractionPlan,
  estimateKnowledgeGraphExtractionTokens,
  findExistingKnowledgeGraphExtractionSkips,
  parseKnowledgeGraphExtractionJson,
  resolveKnowledgeGraphExtractionDocIds,
  runKnowledgeGraphExtractionPlans,
} from "./knowledgeGraphExtraction.ts";

describe("knowledge graph extraction backend", () => {
  test("estimates prompt and completion tokens for a document extraction plan", () => {
    const estimate = estimateKnowledgeGraphExtractionTokens("TinyBot stores local knowledge.", 640);

    expect(estimate).toEqual({
      prompt_tokens: 248,
      completion_tokens: 256,
      total_tokens: 504,
      max_tokens: 640,
      within_budget: true,
    });
  });

  test("builds the strict JSON extraction prompt used by the backend", () => {
    const prompt = buildKnowledgeGraphExtractionPrompt("Knowledge.md", "TinyBot stores knowledge.", 640);

    expect(prompt).toContain("Return strict JSON only");
    expect(prompt).toContain("Token budget for the answer: 640.");
    expect(prompt).toContain("Document: Knowledge.md");
    expect(prompt).toContain("TinyBot stores knowledge.");
  });

  test("parses fenced LLM graph extraction output into normalized entities and relations", () => {
    const result = parseKnowledgeGraphExtractionJson([
      "```json",
      JSON.stringify({
        entities: [{ name: "TinyBot", entity_type: "project", confidence: 2, evidence: [{ quote: "TinyBot stores knowledge.", lineStart: 3 }] }],
        relations: [{ source: "TinyBot", target: "Knowledge", type: "stores", confidence: -1, evidence: [{ text: "TinyBot stores knowledge." }] }],
      }),
      "```",
    ].join("\n"));

    expect(result).toEqual({
      entities: [{
        name: "TinyBot",
        type: "project",
        confidence: 1,
        evidence: [{ text: "TinyBot stores knowledge.", line_start: 3, line_end: 3 }],
      }],
      relations: [{
        source: "TinyBot",
        target: "Knowledge",
        predicate: "stores",
        confidence: 0,
        evidence: [{ text: "TinyBot stores knowledge.", line_start: 1, line_end: 1 }],
      }],
    });
  });

  test("resolves explicit and scope-all extraction document ids", async () => {
    const listRequests: Record<string, unknown>[] = [];
    const provider = {
      listDocuments: (request: Record<string, unknown>) => {
        listRequests.push(request);
        return { documents: [{ id: "doc-1" }, { id: "doc-2" }] };
      },
      getDocument: () => null,
    };

    await expect(resolveKnowledgeGraphExtractionDocIds({ doc_id: "doc-1", doc_ids: ["doc-1", "doc-2"] }, provider, "trace")).resolves.toEqual(["doc-1", "doc-2"]);
    await expect(resolveKnowledgeGraphExtractionDocIds({ scope: "all", document_limit: 250 }, provider, "trace")).resolves.toEqual(["doc-1", "doc-2"]);
    expect(listRequests).toEqual([{ limit: 250 }]);
  });

  test("builds extraction plans with configured chunk limits", async () => {
    const provider = {
      listDocuments: () => ({ documents: [] }),
      getDocument: () => ({
        document: { id: "doc-1", name: "Knowledge.md", chunk_count: 3 },
        content: ["# Knowledge", "first chunk", "second chunk"].join("\n\n"),
      }),
    };

    const plan = await buildKnowledgeGraphExtractionPlan(provider, "doc-1", 640, 2, "trace");

    expect(plan).toMatchObject({
      docId: "doc-1",
      docName: "Knowledge.md",
      content: "# Knowledge\n\nfirst chunk",
      extractionScope: { max_chunks: 2, chunk_count: 2, original_chunk_count: 3 },
      tokenEstimate: { max_tokens: 640 },
    });
  });

  test("skips existing entity graphs only when they are not stale", async () => {
    const provider = {
      listDocuments: () => ({ documents: [] }),
      getDocument: () => null,
      graph: (request: Record<string, unknown>) => request.doc_id === "fresh"
        ? { nodes: [{ id: "entity:fresh" }], edges: [], readiness: { entity_graph_stale: false }, stats: { stale_count: 0 } }
        : { nodes: [{ id: "entity:stale", attributes: { stale: true } }], edges: [], readiness: { entity_graph_stale: true }, stats: { stale_count: 1 } },
    };
    const plans = [
      { docId: "fresh", docName: "Fresh.md", content: "fresh", tokenEstimate: {}, extractionScope: {} },
      { docId: "stale", docName: "Stale.md", content: "stale", tokenEstimate: {}, extractionScope: {} },
    ];

    await expect(findExistingKnowledgeGraphExtractionSkips(plans, provider, "trace")).resolves.toEqual([
      { doc_id: "fresh", doc_name: "Fresh.md", reason: "entity_graph_exists" },
    ]);
  });

  test("runs extraction plans with bounded concurrency while preserving result order", async () => {
    let active = 0;
    let maxActive = 0;
    const plans = [
      { docId: "doc-1", docName: "One.md", content: "one", tokenEstimate: {}, extractionScope: {} },
      { docId: "doc-2", docName: "Two.md", content: "two", tokenEstimate: {}, extractionScope: {} },
      { docId: "doc-3", docName: "Three.md", content: "three", tokenEstimate: {}, extractionScope: {} },
    ];

    const results = await runKnowledgeGraphExtractionPlans(plans, 2, async (plan) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, plan.docId === "doc-1" ? 10 : 1));
      active -= 1;
      return plan.docId;
    });

    expect(maxActive).toBe(2);
    expect(results).toEqual(["doc-1", "doc-2", "doc-3"]);
  });
});
