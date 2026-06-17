import { describe, expect, test } from "vitest";

import {
  areKnowledgeGraphPlansWithinJobBudget,
  buildKnowledgeGraphBatchEstimateBody,
  buildKnowledgeGraphExtractionPrompt,
  buildKnowledgeGraphExtractionPlan,
  buildKnowledgeGraphSingleEstimateBody,
  estimateKnowledgeGraphExtractionTokens,
  findExistingKnowledgeGraphExtractionSkips,
  parseKnowledgeGraphExtractionJson,
  resolveKnowledgeGraphExtractionDocIds,
  runKnowledgeGraphExtractionPlan,
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
    expect(prompt).toContain("Allowed relation predicates: depends_on, causes, implements, configures, mentions, conflicts_with, supports.");
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
        predicate: "mentions",
        confidence: 0,
        evidence: [{ text: "TinyBot stores knowledge.", line_start: 1, line_end: 1 }],
      }],
    });
  });

  test("drops extracted relations that cannot satisfy native graph validation", () => {
    const result = parseKnowledgeGraphExtractionJson(JSON.stringify({
      entities: [],
      relations: [
        { source: "TinyBot", target: "Knowledge", predicate: "uses", confidence: 0.8, evidence: [] },
        { source: "TinyBot", target: "Runtime", predicate: "depends on", confidence: 0.8, evidence: [{ text: "TinyBot uses Runtime." }] },
      ],
    }));

    expect(result.relations).toEqual([
      {
        source: "TinyBot",
        target: "Runtime",
        predicate: "depends_on",
        confidence: 0.8,
        evidence: [{ text: "TinyBot uses Runtime.", line_start: 1, line_end: 1 }],
      },
    ]);
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

  test("runs one extraction plan through the LLM and persists normalized graph data", async () => {
    const completions: Array<Record<string, unknown>> = [];
    const saves: Array<Record<string, unknown>> = [];
    const provider = {
      listDocuments: () => ({ documents: [] }),
      getDocument: () => null,
      saveEntityGraphExtraction: (payload: Record<string, unknown>) => {
        saves.push(payload);
        return { id: "kjob_extract_graph_doc-1", status: "completed" };
      },
    };
    const openAiProvider = {
      completeChat: (request: Record<string, unknown>) => {
        completions.push(request);
        return JSON.stringify({
          entities: [{ name: "TinyBot", type: "project", confidence: 0.9 }],
          relations: [{ source: "TinyBot", target: "Knowledge", predicate: "stores", confidence: 0.8 }],
        });
      },
    };

    const job = await runKnowledgeGraphExtractionPlan({
      plan: {
        docId: "doc-1",
        docName: "Knowledge.md",
        content: "TinyBot stores knowledge.",
        tokenEstimate: { total_tokens: 500, max_tokens: 640 },
        extractionScope: { max_chunks: 1, chunk_count: 1, original_chunk_count: 1 },
      },
      provider,
      openAiCompatProvider: openAiProvider,
      model: "graph-model",
      maxTokens: 640,
      timeoutSeconds: 12,
      traceId: "trace",
    });

    expect(job).toEqual({ id: "kjob_extract_graph_doc-1", status: "completed" });
    expect(completions).toEqual([expect.objectContaining({
      sessionKey: "knowledge:graph-extraction",
      chatId: "knowledge-graph-extraction",
      model: "graph-model",
      timeoutSeconds: 12,
    })]);
    expect(String(completions[0]?.content)).toContain("TinyBot stores knowledge.");
    expect(saves).toEqual([expect.objectContaining({
      doc_id: "doc-1",
      doc_name: "Knowledge.md",
      model: "graph-model",
      token_estimate: { total_tokens: 500, max_tokens: 640 },
      extraction_scope: { max_chunks: 1, chunk_count: 1, original_chunk_count: 1 },
      entities: [{ name: "TinyBot", type: "project", confidence: 0.9, evidence: [] }],
      relations: [],
    })]);
  });

  test("builds batch estimates from runnable documents and configured job budget", () => {
    const plans = [
      { docId: "doc-1", docName: "One.md", content: "one", tokenEstimate: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300, max_tokens: 640, within_budget: true }, extractionScope: {} },
      { docId: "doc-2", docName: "Two.md", content: "two", tokenEstimate: { prompt_tokens: 150, completion_tokens: 250, total_tokens: 400, max_tokens: 640, within_budget: true }, extractionScope: {} },
    ];

    expect(areKnowledgeGraphPlansWithinJobBudget(plans, 600)).toBe(false);
    expect(buildKnowledgeGraphBatchEstimateBody(plans, 640, 600, "selected", [
      { doc_id: "doc-2", doc_name: "Two.md", reason: "entity_graph_exists" },
    ])).toMatchObject({
      object: "knowledge_graph_extraction_estimate",
      document_count: 2,
      runnable_document_count: 1,
      skipped_count: 1,
      progress: {
        stage: "estimated",
        completed: 5,
        total: 8,
        documents: [
          {
            doc_id: "doc-1",
            status: "ready",
            stage: "budget_checked",
            completed: 5,
            total: 8,
            stages: [
              { stage: "resolved_document", status: "completed" },
              { stage: "loaded_content", status: "completed" },
              { stage: "estimated_tokens", status: "completed" },
              { stage: "checked_existing_graph", status: "completed" },
              { stage: "checked_budget", status: "completed" },
              { stage: "llm_extraction", status: "pending" },
              { stage: "parsed_graph_json", status: "pending" },
              { stage: "persisted_entity_graph", status: "pending" },
            ],
          },
          {
            doc_id: "doc-2",
            status: "skipped",
            stage: "skipped_existing_graph",
            skipped_reason: "entity_graph_exists",
          },
        ],
      },
      estimates: [
        { doc_id: "doc-1", token_estimate: { total_tokens: 300 } },
        { doc_id: "doc-2", skipped: true, skipped_reason: "entity_graph_exists" },
      ],
      token_estimate: {
        prompt_tokens: 100,
        completion_tokens: 200,
        total_tokens: 300,
        max_job_tokens: 600,
        within_budget: true,
      },
    });
  });

  test("builds skipped single-document estimates without charging tokens", () => {
    const body = buildKnowledgeGraphSingleEstimateBody({
      docId: "doc-1",
      docName: "One.md",
      content: "one",
      tokenEstimate: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300, max_tokens: 640, within_budget: true },
      extractionScope: { max_chunks: 1 },
    }, { doc_id: "doc-1", doc_name: "One.md", reason: "entity_graph_exists" });

    expect(body).toMatchObject({
      doc_id: "doc-1",
      runnable_document_count: 0,
      skipped_count: 1,
      skipped_reason: "entity_graph_exists",
      progress: {
        stage: "estimated",
        completed: 5,
        total: 8,
        documents: [
          {
            doc_id: "doc-1",
            status: "skipped",
            stage: "skipped_existing_graph",
            skipped_reason: "entity_graph_exists",
          },
        ],
      },
      token_estimate: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        max_tokens: 640,
        within_budget: true,
      },
    });
  });
});
