import { describe, expect, test } from "vitest";

import { EMPTY_FINAL_RESPONSE_MESSAGE } from "../support/runtimeHelpers.ts";
import {
  handleWebuiRouteRequest,
  type WebuiAgentUiFormProvider,
  type WebuiConfigProvider,
  type WebuiDiagnosticsLogger,
  type WebuiKnowledgeProvider,
  type WebuiOpenAiCompatProvider,
  type WebuiSessionProvider,
} from "./webuiRoutes.ts";

async function waitForExpectation(assertion: () => Promise<void> | void, timeoutMs = 250): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (lastError) {
    throw lastError;
  }
}

describe("WebUI OpenAI-compatible routes", () => {
  test("streams chat completions as OpenAI-compatible SSE chunks", async () => {
    const configProvider: WebuiConfigProvider = {
      getConfig: () => ({
        agents: { defaults: { model: "test-model" } },
        api: { timeout: 3 },
      }),
      patchConfig: () => ({}),
    };
    const openAiCompatProvider: WebuiOpenAiCompatProvider = {
      completeChat: (request) => {
        request.onContentDelta?.("hel");
        request.onContentDelta?.("lo");
        return "hello";
      },
    };

    const response = await handleWebuiRouteRequest(
      {
        method: "POST",
        path: "/v1/chat/completions",
        body: {
          model: "test-model",
          session_id: "streamed",
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      configProvider,
      undefined,
      undefined,
      undefined,
      undefined,
      openAiCompatProvider,
      undefined,
      undefined,
      "trace-openai-stream",
    );

    expect(response.status).toBe(200);
    expect(response).toMatchObject({
      headers: { "Content-Type": "text/event-stream" },
    });
    expect(String(response.body)).toContain('"object":"chat.completion.chunk"');
    expect(String(response.body)).toContain('"content":"hel"');
    expect(String(response.body)).toContain('"content":"lo"');
    expect(String(response.body)).toContain("data: [DONE]");
  });

  test("retries empty chat completions once before returning the compatibility fallback", async () => {
    const completions: Array<{ content: string; sessionKey: string; traceId: string; timeoutSeconds: number }> = [];
    const configProvider: WebuiConfigProvider = {
      getConfig: () => ({
        agents: { defaults: { model: "test-model" } },
        api: { timeout: 3 },
      }),
      patchConfig: () => ({}),
    };
    const openAiCompatProvider: WebuiOpenAiCompatProvider = {
      completeChat: (request, traceId) => {
        completions.push({
          content: request.content,
          sessionKey: request.sessionKey,
          traceId,
          timeoutSeconds: request.timeoutSeconds,
        });
        return completions.length === 1 ? "   " : "\n";
      },
    };

    const response = await handleWebuiRouteRequest(
      {
        method: "POST",
        path: "/v1/chat/completions",
        body: {
          model: "test-model",
          session_id: "custom",
          messages: [{ role: "user", content: "hello" }],
        },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      configProvider,
      undefined,
      undefined,
      undefined,
      undefined,
      openAiCompatProvider,
      undefined,
      undefined,
      "trace-openai",
    );

    expect(response.status).toBe(200);
    expect(completions).toEqual([
      { content: "hello", sessionKey: "api:custom", traceId: "trace-openai", timeoutSeconds: 3 },
      { content: "hello", sessionKey: "api:custom", traceId: "trace-openai", timeoutSeconds: 3 },
    ]);
    expect(response.body).toMatchObject({
      model: "test-model",
      choices: [
        {
          message: { role: "assistant", content: EMPTY_FINAL_RESPONSE_MESSAGE },
          finish_reason: "stop",
        },
      ],
    });
  });
});

describe("WebUI knowledge graph extraction routes", () => {
  test("starts manual LLM graph extraction as a background job without waiting for chat completion", async () => {
    let resolveCompletion: ((value: string) => void) | undefined;
    const saves: Array<Record<string, unknown>> = [];
    const configProvider: WebuiConfigProvider = {
      getConfig: () => ({
        agents: { defaults: { model: "knowledge-model" } },
        knowledge: {
          enabled: true,
          graph_extraction_enabled: true,
          graph_extraction_model: "graph-model",
          graph_extraction_max_tokens: 640,
        },
      }),
      patchConfig: () => ({}),
    };
    const openAiCompatProvider: WebuiOpenAiCompatProvider = {
      completeChat: () => new Promise((resolve) => {
        resolveCompletion = resolve;
      }),
    };
    const knowledgeProvider: WebuiKnowledgeProvider = {
      listDocuments: () => ({ documents: [] }),
      addDocument: () => ({ document: {} }),
      getDocument: () => ({
        document: { id: "doc-async", name: "Async.md", chunk_count: 1 },
        content: "# Async\nTinyBot stores knowledge asynchronously.\n",
      }),
      deleteDocument: () => ({ deleted: false }),
      query: () => ({ results: [] }),
      stats: () => ({ total_documents: 1, total_chunks: 1, retrieval_ready: true }),
      saveEntityGraphExtraction: (payload) => {
        saves.push(payload);
        return {
          id: "kjob_extract_graph_doc-async",
          doc_id: "doc-async",
          name: "extract_graph:Async.md",
          status: "completed",
          stage: "entity_graph_extracted",
          processed: 1,
          total: 1,
          result: { entities: 1, relations: 0, evidence: 1 },
        };
      },
    };

    const responsePromise = handleWebuiRouteRequest(
      {
        method: "POST",
        path: "/v1/knowledge/graph/extract",
        body: { doc_id: "doc-async" },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      configProvider,
      undefined,
      undefined,
      undefined,
      undefined,
      openAiCompatProvider,
      knowledgeProvider,
      undefined,
      "trace-async-extract",
    );
    const early = await Promise.race([
      responsePromise.then((response) => ({ kind: "response" as const, response })),
      new Promise<{ kind: "pending" }>((resolve) => setTimeout(() => resolve({ kind: "pending" }), 25)),
    ]);
    if (early.kind === "pending") {
      resolveCompletion?.(JSON.stringify({ entities: [], relations: [] }));
      await responsePromise;
    }

    expect(early.kind).toBe("response");
    if (early.kind !== "response") {
      return;
    }
    expect(early.response).toMatchObject({
      status: 202,
      body: {
        message: "Knowledge graph extraction started",
        job_id: "kjob_extract_graph_doc-async",
        job: {
          id: "kjob_extract_graph_doc-async",
          status: expect.stringMatching(/queued|running/),
          stage: expect.stringMatching(/queued|planning|llm_extraction/),
          doc_id: "doc-async",
        },
      },
    });
    expect(saves).toHaveLength(0);

    const jobId = String((early.response.body as Record<string, unknown>).job_id);
    const runningJob = await handleWebuiRouteRequest(
      { method: "GET", path: `/v1/knowledge/jobs/${jobId}` },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      configProvider,
      undefined,
      undefined,
      undefined,
      undefined,
      openAiCompatProvider,
      knowledgeProvider,
      undefined,
      "trace-async-extract",
    );
    expect(runningJob.status).toBe(200);

    resolveCompletion?.(JSON.stringify({
      entities: [{ name: "TinyBot", type: "project", confidence: 0.91, evidence: [{ text: "TinyBot stores knowledge asynchronously." }] }],
      relations: [],
    }));
    await waitForExpectation(async () => {
      const completedJob = await handleWebuiRouteRequest(
        { method: "GET", path: `/v1/knowledge/jobs/${jobId}` },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        configProvider,
        undefined,
        undefined,
        undefined,
        undefined,
        openAiCompatProvider,
        knowledgeProvider,
        undefined,
        "trace-async-extract",
      );
      expect(completedJob).toMatchObject({
        status: 200,
        body: {
          status: "completed",
          stage: "completed",
          result: { entities: 1, relations: 0, evidence: 1 },
        },
      });
    });
    expect(saves).toHaveLength(1);
  });

  test("records streamed LLM extraction output details on the background job", async () => {
    const configProvider: WebuiConfigProvider = {
      getConfig: () => ({
        agents: { defaults: { model: "knowledge-model" } },
        knowledge: {
          enabled: true,
          graph_extraction_enabled: true,
          graph_extraction_model: "graph-model",
          graph_extraction_max_tokens: 640,
        },
      }),
      patchConfig: () => ({}),
    };
    const openAiCompatProvider: WebuiOpenAiCompatProvider = {
      completeChat: (request) => {
        const callbacks = request as typeof request & {
          onContentDelta?: (delta: string) => void;
          onReasoningDelta?: (delta: string) => void;
        };
        callbacks.onReasoningDelta?.("checking graph candidates");
        callbacks.onContentDelta?.("{\"entities\"");
        callbacks.onContentDelta?.(":[{\"name\":\"TinyBot\"}],\"relations\":[]}");
        return JSON.stringify({
          entities: [{ name: "TinyBot", type: "project", confidence: 0.91 }],
          relations: [],
        });
      },
    };
    const knowledgeProvider: WebuiKnowledgeProvider = {
      listDocuments: () => ({ documents: [] }),
      addDocument: () => ({ document: {} }),
      getDocument: () => ({
        document: { id: "doc-stream", name: "Stream.md", chunk_count: 1 },
        content: "# Stream\nTinyBot streams graph extraction diagnostics.\n",
      }),
      deleteDocument: () => ({ deleted: false }),
      query: () => ({ results: [] }),
      stats: () => ({ total_documents: 1, total_chunks: 1, retrieval_ready: true }),
      saveEntityGraphExtraction: () => ({
        id: "kjob_extract_graph_doc-stream",
        doc_id: "doc-stream",
        name: "extract_graph:Stream.md",
        status: "completed",
        stage: "entity_graph_extracted",
        processed: 1,
        total: 1,
        result: { entities: 1, relations: 0, evidence: 0 },
      }),
    };

    const response = await handleWebuiRouteRequest(
      {
        method: "POST",
        path: "/v1/knowledge/graph/extract",
        body: { doc_id: "doc-stream" },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      configProvider,
      undefined,
      undefined,
      undefined,
      undefined,
      openAiCompatProvider,
      knowledgeProvider,
      undefined,
      "trace-stream-extract",
    );
    const jobId = String((response.body as Record<string, unknown>).job_id);
    expect(jobId).toBe("kjob_extract_graph_doc-stream");

    await waitForExpectation(async () => {
      const completedJob = await handleWebuiRouteRequest(
        { method: "GET", path: `/v1/knowledge/jobs/${jobId}` },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        configProvider,
        undefined,
        undefined,
        undefined,
        undefined,
        openAiCompatProvider,
        knowledgeProvider,
        undefined,
        "trace-stream-extract",
      );
      expect(completedJob).toMatchObject({
        status: 200,
        body: {
          status: "completed",
          llm_output_chars: expect.any(Number),
          llm_preview: expect.stringContaining("\"entities\""),
          llm_reasoning_chars: expect.any(Number),
          stage_details: expect.arrayContaining([
            expect.objectContaining({ stage: "llm_delta", doc_id: "doc-stream" }),
          ]),
        },
      });
    });
  });

  test("estimates and persists manual LLM graph extraction", async () => {
    const completions: Array<{ content: string; sessionKey: string; model: string; timeoutSeconds: number }> = [];
    const saves: Array<Record<string, unknown>> = [];
    const configProvider: WebuiConfigProvider = {
      getConfig: () => ({
        agents: { defaults: { model: "knowledge-model" } },
        knowledge: {
          enabled: true,
          graph_extraction_model: "graph-model",
          graph_extraction_max_tokens: 640,
          semanticLlmMaxTokens: 800,
          semanticLlmModel: "semantic-model",
          semanticLlmTimeout: 12,
        },
      }),
      patchConfig: () => ({}),
    };
    const openAiCompatProvider: WebuiOpenAiCompatProvider = {
      completeChat: (request) => {
        completions.push({
          content: request.content,
          sessionKey: request.sessionKey,
          model: request.model,
          timeoutSeconds: request.timeoutSeconds,
        });
        return JSON.stringify({
          entities: [
            { name: "TinyBot", type: "project", confidence: 0.91, evidence: [{ text: "TinyBot stores knowledge.", line_start: 1, line_end: 1 }] },
          ],
          relations: [
            { source: "TinyBot", target: "knowledge graph", predicate: "stores", confidence: 0.82, evidence: [{ text: "TinyBot stores knowledge.", line_start: 1, line_end: 1 }] },
          ],
        });
      },
    };
    const knowledgeProvider: WebuiKnowledgeProvider = {
      listDocuments: () => ({ documents: [] }),
      addDocument: () => ({ document: {} }),
      getDocument: () => ({
        document: { id: "doc-1", name: "Knowledge.md", chunk_count: 1 },
        content: "# Knowledge\nTinyBot stores knowledge.\n",
      }),
      deleteDocument: () => ({ deleted: false }),
      query: () => ({ results: [] }),
      stats: () => ({ total_documents: 1, total_chunks: 1, retrieval_ready: true }),
      saveEntityGraphExtraction: (payload) => {
        saves.push(payload);
        return {
          id: "kjob_extract_graph_doc-1",
          doc_id: "doc-1",
          name: "extract_graph:Knowledge.md",
          status: "completed",
          stage: "entity_graph_extracted",
          processed: 1,
          total: 1,
          result: { entities: 1, relations: 1, evidence: 2 },
        };
      },
    };

    const estimate = await handleWebuiRouteRequest(
      {
        method: "POST",
        path: "/v1/knowledge/graph/extract",
        body: { doc_id: "doc-1", dry_run: true },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      configProvider,
      undefined,
      undefined,
      undefined,
      undefined,
      openAiCompatProvider,
      knowledgeProvider,
      undefined,
      "trace-extract",
    );

    expect(estimate).toMatchObject({
      status: 200,
      body: {
        object: "knowledge_graph_extraction_estimate",
        doc_id: "doc-1",
        extraction_scope: { max_chunks: 5, chunk_count: 1, original_chunk_count: 1 },
        runnable_document_count: 1,
        skipped_count: 0,
        progress: {
          stage: "estimated",
          completed: 5,
          total: 8,
          documents: [
            {
              doc_id: "doc-1",
              doc_name: "Knowledge.md",
              status: "ready",
              stage: "budget_checked",
              completed: 5,
              total: 8,
            },
          ],
        },
        token_estimate: { total_tokens: expect.any(Number), max_tokens: 640, within_budget: true },
      },
    });
    expect(completions).toHaveLength(0);
    expect(saves).toHaveLength(0);

    const extraction = await handleWebuiRouteRequest(
      {
        method: "POST",
        path: "/v1/knowledge/graph/extract",
        body: { doc_id: "doc-1" },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      configProvider,
      undefined,
      undefined,
      undefined,
      undefined,
      openAiCompatProvider,
      knowledgeProvider,
      undefined,
      "trace-extract",
    );

    expect(extraction).toMatchObject({
      status: 202,
      body: {
        message: "Knowledge graph extraction started",
        job_id: expect.stringMatching(/^kjob_extract_graph_/),
        job: {
          id: expect.stringMatching(/^kjob_extract_graph_/),
          doc_id: "doc-1",
          stage: expect.stringMatching(/queued|llm_extraction/),
          progress: {
            stage: expect.stringMatching(/running|llm_extraction/),
            completed: 5,
            total: 8,
            documents: [
              {
                doc_id: "doc-1",
                status: "running",
                stage: expect.stringMatching(/budget_checked|llm_extraction/),
                completed: 5,
                total: 8,
              },
            ],
          },
        },
      },
    });
    await waitForExpectation(() => {
      expect(completions).toHaveLength(1);
      expect(saves).toHaveLength(1);
    });
    expect(completions[0]).toMatchObject({
      sessionKey: "knowledge:graph-extraction",
      model: "graph-model",
      timeoutSeconds: 12,
    });
    expect(completions[0].content).toContain("Return strict JSON");
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({
      doc_id: "doc-1",
      doc_name: "Knowledge.md",
      model: "graph-model",
      entities: [{ name: "TinyBot", type: "project", confidence: 0.91 }],
      relations: [{ source: "TinyBot", target: "knowledge graph", predicate: "mentions", confidence: 0.82 }],
      token_estimate: { max_tokens: 640 },
    });
  });

  test("allows dry-run estimates but rejects extraction when graph extraction is disabled", async () => {
    const configProvider: WebuiConfigProvider = {
      getConfig: () => ({
        agents: { defaults: { model: "knowledge-model" } },
        knowledge: {
          enabled: true,
          graph_extraction_enabled: false,
          semantic_llm_max_tokens: 800,
        },
      }),
      patchConfig: () => ({}),
    };
    const knowledgeProvider: WebuiKnowledgeProvider = {
      listDocuments: () => ({ documents: [] }),
      addDocument: () => ({ document: {} }),
      getDocument: () => ({
        document: { id: "doc-1", name: "Knowledge.md", chunk_count: 1 },
        content: "# Knowledge\nTinyBot stores knowledge.\n",
      }),
      deleteDocument: () => ({ deleted: false }),
      query: () => ({ results: [] }),
      stats: () => ({ total_documents: 1, total_chunks: 1, retrieval_ready: true }),
      saveEntityGraphExtraction: () => {
        throw new Error("save should not run when graph extraction is disabled");
      },
    };

    const estimate = await handleWebuiRouteRequest(
      {
        method: "POST",
        path: "/v1/knowledge/graph/extract",
        body: { doc_id: "doc-1", dry_run: true },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      configProvider,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      knowledgeProvider,
      undefined,
      "trace-extract-disabled",
    );

    expect(estimate.status).toBe(200);

    const extraction = await handleWebuiRouteRequest(
      {
        method: "POST",
        path: "/v1/knowledge/graph/extract",
        body: { doc_id: "doc-1" },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      configProvider,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      knowledgeProvider,
      undefined,
      "trace-extract-disabled",
    );

    expect(extraction).toMatchObject({
      status: 403,
      body: {
        error: {
          message: "Knowledge graph extraction is disabled",
        },
      },
    });
  });

  test("estimates all documents and extracts selected documents with configured chunk limits", async () => {
    const completions: Array<{ content: string; model: string }> = [];
    const saves: Array<Record<string, unknown>> = [];
    const documents = [
      { id: "doc-1", name: "One.md", chunk_count: 3 },
      { id: "doc-2", name: "Two.md", chunk_count: 2 },
    ];
    const contents: Record<string, string> = {
      "doc-1": ["# One", "first chunk", "second chunk", "third chunk"].join("\n\n"),
      "doc-2": ["# Two", "alpha chunk", "beta chunk"].join("\n\n"),
    };
    const configProvider: WebuiConfigProvider = {
      getConfig: () => ({
        agents: { defaults: { model: "knowledge-model" } },
        knowledge: {
          enabled: true,
          graph_extraction_enabled: true,
          graph_extraction_max_chunks: 2,
          semantic_llm_max_tokens: 1200,
        },
      }),
      patchConfig: () => ({}),
    };
    const openAiCompatProvider: WebuiOpenAiCompatProvider = {
      completeChat: (request) => {
        completions.push({ content: request.content, model: request.model });
        return JSON.stringify({ entities: [{ name: "Entity", confidence: 0.9 }], relations: [] });
      },
    };
    const knowledgeProvider: WebuiKnowledgeProvider = {
      listDocuments: () => ({ documents }),
      addDocument: () => ({ document: {} }),
      getDocument: (docId) => ({
        document: documents.find((document) => document.id === docId) ?? { id: docId, name: docId },
        content: contents[docId] ?? "",
      }),
      deleteDocument: () => ({ deleted: false }),
      query: () => ({ results: [] }),
      stats: () => ({ total_documents: documents.length, total_chunks: 5, retrieval_ready: true }),
      saveEntityGraphExtraction: (payload) => {
        saves.push(payload);
        return {
          id: `kjob_extract_graph_${payload.doc_id}`,
          doc_id: payload.doc_id,
          name: `extract_graph:${payload.doc_name}`,
          status: "completed",
          stage: "entity_graph_extracted",
          processed: 1,
          total: 1,
          result: { entities: 1, relations: 0, evidence: 0 },
        };
      },
    };

    const estimate = await handleWebuiRouteRequest(
      {
        method: "POST",
        path: "/v1/knowledge/graph/extract",
        body: { scope: "all", dry_run: true },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      configProvider,
      undefined,
      undefined,
      undefined,
      undefined,
      openAiCompatProvider,
      knowledgeProvider,
      undefined,
      "trace-batch-extract",
    );

    expect(estimate).toMatchObject({
      status: 200,
      body: {
        object: "knowledge_graph_extraction_estimate",
        scope: "all",
        document_count: 2,
        runnable_document_count: 2,
        skipped_count: 0,
        estimates: [
          { doc_id: "doc-1", doc_name: "One.md", token_estimate: { max_tokens: 1200 } },
          { doc_id: "doc-2", doc_name: "Two.md", token_estimate: { max_tokens: 1200 } },
        ],
        token_estimate: { max_tokens: 1200, total_tokens: expect.any(Number) },
      },
    });
    expect(completions).toHaveLength(0);

    const extraction = await handleWebuiRouteRequest(
      {
        method: "POST",
        path: "/v1/knowledge/graph/extract",
        body: { doc_ids: ["doc-1", "doc-2"] },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      configProvider,
      undefined,
      undefined,
      undefined,
      undefined,
      openAiCompatProvider,
      knowledgeProvider,
      undefined,
      "trace-batch-extract",
    );

    expect(extraction).toMatchObject({
      status: 202,
      body: {
        message: "Knowledge graph extraction started",
        document_count: 2,
        runnable_document_count: 2,
        job_id: expect.stringMatching(/^kjob_extract_graph_/),
        progress: {
          stage: "running",
          completed: 5,
          total: 8,
          documents: [
            { doc_id: "doc-1", status: "running", completed: 5, total: 8 },
            { doc_id: "doc-2", status: "running", completed: 5, total: 8 },
          ],
        },
      },
    });
    await waitForExpectation(() => {
      expect(completions).toHaveLength(2);
      expect(saves).toHaveLength(2);
    });
    expect(completions[0].content).toContain("# One");
    expect(completions[0].content).toContain("first chunk");
    expect(completions[0].content).not.toContain("third chunk");
    expect(saves[0]).toMatchObject({
      doc_id: "doc-1",
      extraction_scope: { max_chunks: 2, chunk_count: 2, original_chunk_count: 4 },
    });
  });

  test("uses configurable document limits when estimating all graph documents", async () => {
    const listRequests: Record<string, unknown>[] = [];
    const documents = [{ id: "doc-1", name: "One.md", chunk_count: 1 }];
    const configProvider: WebuiConfigProvider = {
      getConfig: () => ({
        agents: { defaults: { model: "knowledge-model" } },
        knowledge: {
          enabled: true,
          graph_extraction_enabled: true,
          graph_extraction_max_tokens: 1200,
        },
      }),
      patchConfig: () => ({}),
    };
    const knowledgeProvider: WebuiKnowledgeProvider = {
      listDocuments: (request) => {
        listRequests.push(request);
        return { documents };
      },
      addDocument: () => ({ document: {} }),
      getDocument: () => ({
        document: documents[0],
        content: "# One\nKnowledge graph content.",
      }),
      deleteDocument: () => ({ deleted: false }),
      query: () => ({ results: [] }),
      stats: () => ({ total_documents: documents.length, total_chunks: 1, retrieval_ready: true }),
    };

    const estimate = await handleWebuiRouteRequest(
      {
        method: "POST",
        path: "/v1/knowledge/graph/extract",
        body: { scope: "all", document_limit: 250, dry_run: true },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      configProvider,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      knowledgeProvider,
      undefined,
      "trace-all-limit",
    );

    expect(estimate.status).toBe(200);
    expect(listRequests).toEqual([{ limit: 250 }]);
  });

  test("rejects graph extraction batches that exceed the configured job token budget", async () => {
    let completions = 0;
    const documents = [
      { id: "doc-1", name: "One.md", chunk_count: 1 },
      { id: "doc-2", name: "Two.md", chunk_count: 1 },
    ];
    const configProvider: WebuiConfigProvider = {
      getConfig: () => ({
        agents: { defaults: { model: "knowledge-model" } },
        knowledge: {
          enabled: true,
          graph_extraction_enabled: true,
          graph_extraction_max_tokens: 1200,
          graph_extraction_max_job_tokens: 900,
        },
      }),
      patchConfig: () => ({}),
    };
    const openAiCompatProvider: WebuiOpenAiCompatProvider = {
      completeChat: () => {
        completions += 1;
        return JSON.stringify({ entities: [{ name: "Entity", confidence: 0.9 }], relations: [] });
      },
    };
    const knowledgeProvider: WebuiKnowledgeProvider = {
      listDocuments: () => ({ documents }),
      addDocument: () => ({ document: {} }),
      getDocument: (docId) => ({
        document: documents.find((document) => document.id === docId) ?? { id: docId, name: docId },
        content: `# ${docId}\nKnowledge graph extraction budget content.`,
      }),
      deleteDocument: () => ({ deleted: false }),
      query: () => ({ results: [] }),
      stats: () => ({ total_documents: documents.length, total_chunks: 2, retrieval_ready: true }),
      saveEntityGraphExtraction: () => {
        throw new Error("save should not run when job token budget is exceeded");
      },
    };

    const estimate = await handleWebuiRouteRequest(
      {
        method: "POST",
        path: "/v1/knowledge/graph/extract",
        body: { doc_ids: ["doc-1", "doc-2"], dry_run: true },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      configProvider,
      undefined,
      undefined,
      undefined,
      undefined,
      openAiCompatProvider,
      knowledgeProvider,
      undefined,
      "trace-budget-estimate",
    );

    expect(estimate).toMatchObject({
      status: 200,
      body: {
        token_estimate: {
          max_job_tokens: 900,
          within_budget: false,
        },
      },
    });
    expect(completions).toBe(0);

    const extraction = await handleWebuiRouteRequest(
      {
        method: "POST",
        path: "/v1/knowledge/graph/extract",
        body: { doc_ids: ["doc-1", "doc-2"] },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      configProvider,
      undefined,
      undefined,
      undefined,
      undefined,
      openAiCompatProvider,
      knowledgeProvider,
      undefined,
      "trace-budget-extract",
    );

    expect(extraction).toMatchObject({
      status: 400,
      body: {
        error: {
          message: "Graph extraction token estimate exceeds configured job budget",
        },
      },
    });
    expect(completions).toBe(0);
  });

  test("treats zero graph extraction job token budget as unlimited", async () => {
    let completions = 0;
    const documents = [
      { id: "doc-1", name: "One.md", chunk_count: 1 },
      { id: "doc-2", name: "Two.md", chunk_count: 1 },
    ];
    const configProvider: WebuiConfigProvider = {
      getConfig: () => ({
        agents: { defaults: { model: "knowledge-model" } },
        knowledge: {
          enabled: true,
          graph_extraction_enabled: true,
          graph_extraction_max_tokens: 1200,
          graph_extraction_max_job_tokens: 0,
        },
      }),
      patchConfig: () => ({}),
    };
    const openAiCompatProvider: WebuiOpenAiCompatProvider = {
      completeChat: () => {
        completions += 1;
        return JSON.stringify({ entities: [{ name: "Entity", confidence: 0.9 }], relations: [] });
      },
    };
    const knowledgeProvider: WebuiKnowledgeProvider = {
      listDocuments: () => ({ documents }),
      addDocument: () => ({ document: {} }),
      getDocument: (docId) => ({
        document: documents.find((document) => document.id === docId) ?? { id: docId, name: docId },
        content: `# ${docId}\nKnowledge graph extraction budget content.`,
      }),
      deleteDocument: () => ({ deleted: false }),
      query: () => ({ results: [] }),
      stats: () => ({ total_documents: documents.length, total_chunks: 2, retrieval_ready: true }),
      saveEntityGraphExtraction: (payload) => ({
        id: `kjob_extract_graph_${payload.doc_id}`,
        doc_id: payload.doc_id,
        name: `extract_graph:${payload.doc_name}`,
        status: "completed",
        stage: "entity_graph_extracted",
        processed: 1,
        total: 1,
      }),
    };

    const extraction = await handleWebuiRouteRequest(
      {
        method: "POST",
        path: "/v1/knowledge/graph/extract",
        body: { doc_ids: ["doc-1", "doc-2"] },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      configProvider,
      undefined,
      undefined,
      undefined,
      undefined,
      openAiCompatProvider,
      knowledgeProvider,
      undefined,
      "trace-zero-budget-extract",
    );

    expect(extraction).toMatchObject({
      status: 202,
      body: {
        runnable_document_count: 2,
      },
    });
    await waitForExpectation(() => {
      expect(completions).toBe(2);
    });
  });

  test("honors graph extraction concurrency for batch LLM calls", async () => {
    let activeCompletions = 0;
    let maxActiveCompletions = 0;
    const documents = [
      { id: "doc-1", name: "One.md", chunk_count: 1 },
      { id: "doc-2", name: "Two.md", chunk_count: 1 },
      { id: "doc-3", name: "Three.md", chunk_count: 1 },
    ];
    const configProvider: WebuiConfigProvider = {
      getConfig: () => ({
        agents: { defaults: { model: "knowledge-model" } },
        knowledge: {
          enabled: true,
          graph_extraction_enabled: true,
          graph_extraction_concurrency: 2,
          semantic_llm_max_tokens: 1200,
        },
      }),
      patchConfig: () => ({}),
    };
    const openAiCompatProvider: WebuiOpenAiCompatProvider = {
      completeChat: async () => {
        activeCompletions += 1;
        maxActiveCompletions = Math.max(maxActiveCompletions, activeCompletions);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeCompletions -= 1;
        return JSON.stringify({ entities: [{ name: "Entity", confidence: 0.9 }], relations: [] });
      },
    };
    const knowledgeProvider: WebuiKnowledgeProvider = {
      listDocuments: () => ({ documents }),
      addDocument: () => ({ document: {} }),
      getDocument: (docId) => ({
        document: documents.find((document) => document.id === docId) ?? { id: docId, name: docId },
        content: `# ${docId}\nKnowledge graph content.`,
      }),
      deleteDocument: () => ({ deleted: false }),
      query: () => ({ results: [] }),
      stats: () => ({ total_documents: documents.length, total_chunks: 3, retrieval_ready: true }),
      saveEntityGraphExtraction: (payload) => ({
        id: `kjob_extract_graph_${payload.doc_id}`,
        doc_id: payload.doc_id,
        name: `extract_graph:${payload.doc_name}`,
        status: "completed",
        stage: "entity_graph_extracted",
        processed: 1,
        total: 1,
      }),
    };

    const extraction = await handleWebuiRouteRequest(
      {
        method: "POST",
        path: "/v1/knowledge/graph/extract",
        body: { doc_ids: ["doc-1", "doc-2", "doc-3"] },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      configProvider,
      undefined,
      undefined,
      undefined,
      undefined,
      openAiCompatProvider,
      knowledgeProvider,
      undefined,
      "trace-concurrent-extract",
    );

    expect(extraction).toMatchObject({
      status: 202,
      body: {
        document_count: 3,
        runnable_document_count: 3,
        job_id: expect.stringMatching(/^kjob_extract_graph_/),
      },
    });
    await waitForExpectation(() => {
      expect(maxActiveCompletions).toBe(2);
    });
  });

  test("skips existing entity graph extraction unless force is requested", async () => {
    let completions = 0;
    const saves: Array<Record<string, unknown>> = [];
    const configProvider: WebuiConfigProvider = {
      getConfig: () => ({
        agents: { defaults: { model: "knowledge-model" } },
        knowledge: {
          enabled: true,
          graph_extraction_enabled: true,
          semantic_llm_max_tokens: 1200,
        },
      }),
      patchConfig: () => ({}),
    };
    const openAiCompatProvider: WebuiOpenAiCompatProvider = {
      completeChat: () => {
        completions += 1;
        return JSON.stringify({ entities: [{ name: "Entity", confidence: 0.9 }], relations: [] });
      },
    };
    const knowledgeProvider: WebuiKnowledgeProvider = {
      listDocuments: () => ({ documents: [] }),
      addDocument: () => ({ document: {} }),
      getDocument: () => ({
        document: { id: "doc-1", name: "Knowledge.md", chunk_count: 1 },
        content: "# Knowledge\nAlready extracted.",
      }),
      graph: () => ({
        object: "knowledge_graph",
        graph_type: "entity",
        nodes: [{ id: "entity:doc-1:knowledge", label: "Knowledge", type: "entity" }],
        edges: [],
      }),
      deleteDocument: () => ({ deleted: false }),
      query: () => ({ results: [] }),
      stats: () => ({ total_documents: 1, total_chunks: 1, retrieval_ready: true }),
      saveEntityGraphExtraction: (payload) => {
        saves.push(payload);
        return {
          id: "kjob_extract_graph_doc-1",
          doc_id: "doc-1",
          name: "extract_graph:Knowledge.md",
          status: "completed",
          stage: "entity_graph_extracted",
          processed: 1,
          total: 1,
        };
      },
    };

    const estimate = await handleWebuiRouteRequest(
      {
        method: "POST",
        path: "/v1/knowledge/graph/extract",
        body: { doc_id: "doc-1", dry_run: true },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      configProvider,
      undefined,
      undefined,
      undefined,
      undefined,
      openAiCompatProvider,
      knowledgeProvider,
      undefined,
      "trace-skip-estimate",
    );

    expect(estimate).toMatchObject({
      status: 200,
      body: {
        object: "knowledge_graph_extraction_estimate",
        doc_id: "doc-1",
        skipped: true,
        skipped_reason: "entity_graph_exists",
        runnable_document_count: 0,
        skipped_count: 1,
        token_estimate: { total_tokens: 0, within_budget: true },
      },
    });
    expect(completions).toBe(0);
    expect(saves).toHaveLength(0);

    const skipped = await handleWebuiRouteRequest(
      {
        method: "POST",
        path: "/v1/knowledge/graph/extract",
        body: { doc_id: "doc-1" },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      configProvider,
      undefined,
      undefined,
      undefined,
      undefined,
      openAiCompatProvider,
      knowledgeProvider,
      undefined,
      "trace-skip-extract",
    );

    expect(skipped).toMatchObject({
      status: 200,
      body: {
        message: "Knowledge graph extraction skipped",
        skipped: true,
        document_count: 1,
        runnable_document_count: 0,
        skipped_count: 1,
        skipped_docs: [{ doc_id: "doc-1", reason: "entity_graph_exists" }],
      },
    });
    expect(completions).toBe(0);
    expect(saves).toHaveLength(0);

    const forced = await handleWebuiRouteRequest(
      {
        method: "POST",
        path: "/v1/knowledge/graph/extract",
        body: { doc_id: "doc-1", force: true },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      configProvider,
      undefined,
      undefined,
      undefined,
      undefined,
      openAiCompatProvider,
      knowledgeProvider,
      undefined,
      "trace-force-extract",
    );

    expect(forced).toMatchObject({
      status: 202,
      body: {
        job_id: expect.stringMatching(/^kjob_extract_graph_/),
      },
    });
    await waitForExpectation(() => {
      expect(completions).toBe(1);
      expect(saves).toHaveLength(1);
    });
  });

  test("re-extracts existing entity graphs when the native graph is stale", async () => {
    let completions = 0;
    const saves: Array<Record<string, unknown>> = [];
    const configProvider: WebuiConfigProvider = {
      getConfig: () => ({
        agents: { defaults: { model: "knowledge-model" } },
        knowledge: {
          enabled: true,
          graph_extraction_enabled: true,
          semantic_llm_max_tokens: 1200,
        },
      }),
      patchConfig: () => ({}),
    };
    const openAiCompatProvider: WebuiOpenAiCompatProvider = {
      completeChat: () => {
        completions += 1;
        return JSON.stringify({ entities: [{ name: "Fresh Entity", confidence: 0.9 }], relations: [] });
      },
    };
    const knowledgeProvider: WebuiKnowledgeProvider = {
      listDocuments: () => ({ documents: [] }),
      addDocument: () => ({ document: {} }),
      getDocument: () => ({
        document: { id: "doc-1", name: "Knowledge.md", chunk_count: 1 },
        content: "# Knowledge\nUpdated source content.",
      }),
      graph: () => ({
        object: "knowledge_graph",
        graph_type: "entity",
        nodes: [
          {
            id: "entity:doc-1:knowledge",
            label: "Knowledge",
            type: "entity",
            attributes: { stale: true },
          },
        ],
        edges: [],
        readiness: { entity_graph_stale: true },
        stats: { stale_count: 1 },
      }),
      deleteDocument: () => ({ deleted: false }),
      query: () => ({ results: [] }),
      stats: () => ({ total_documents: 1, total_chunks: 1, retrieval_ready: true }),
      saveEntityGraphExtraction: (payload) => {
        saves.push(payload);
        return {
          id: "kjob_extract_graph_doc-1",
          doc_id: "doc-1",
          name: "extract_graph:Knowledge.md",
          status: "completed",
          stage: "entity_graph_extracted",
          processed: 1,
          total: 1,
        };
      },
    };

    const extraction = await handleWebuiRouteRequest(
      {
        method: "POST",
        path: "/v1/knowledge/graph/extract",
        body: { doc_id: "doc-1" },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      configProvider,
      undefined,
      undefined,
      undefined,
      undefined,
      openAiCompatProvider,
      knowledgeProvider,
      undefined,
      "trace-stale-extract",
    );

    expect(extraction).toMatchObject({
      status: 202,
      body: {
        job_id: expect.stringMatching(/^kjob_extract_graph_/),
      },
    });
    await waitForExpectation(() => {
      expect(completions).toBe(1);
      expect(saves).toHaveLength(1);
    });
  });
});

describe("WebUI route temporary files", () => {
  test("normalizes WebSocket session keys to the provider channel casing for messages", async () => {
    const requestedSessionIds: string[] = [];
    const sessionProvider: WebuiSessionProvider = {
      channelName: "websocket",
      listSessions: () => [],
      getSessionMessages: (sessionId) => {
        requestedSessionIds.push(sessionId);
        return sessionId === "websocket:chat-1"
          ? {
              sessionId,
              messages: [{ role: "user", content: "Hello", timestamp: "2026-06-22T03:50:00.000Z" }],
            }
          : null;
      },
    };

    const response = await handleWebuiRouteRequest(
      {
        method: "GET",
        path: "/api/sessions/WebSocket%3Achat-1/messages",
      },
      undefined,
      undefined,
      sessionProvider,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "trace-uppercase-websocket",
    );

    expect(response.status).toBe(200);
    expect(requestedSessionIds).toEqual(["websocket:chat-1"]);
    expect(response.body).toEqual({
      key: "websocket:chat-1",
      messages: [{ role: "user", content: "Hello", timestamp: "2026-06-22T03:50:00.000Z" }],
    });
  });

  test("normalizes WebSocket session keys to the provider channel casing for deletes", async () => {
    const deletedSessionIds: string[] = [];
    const sessionProvider: WebuiSessionProvider = {
      channelName: "websocket",
      listSessions: () => [],
      deleteSession: (sessionId) => {
        deletedSessionIds.push(sessionId);
        return {
          sessionId,
          deleted: sessionId === "websocket:chat-1",
        };
      },
    };

    const response = await handleWebuiRouteRequest(
      {
        method: "DELETE",
        path: "/api/sessions/WebSocket%3Achat-1",
      },
      undefined,
      undefined,
      sessionProvider,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "trace-delete-uppercase-websocket",
    );

    expect(response.status).toBe(200);
    expect(deletedSessionIds).toEqual(["websocket:chat-1"]);
    expect(response.body).toEqual({
      key: "websocket:chat-1",
      deleted: true,
    });
  });

  test("restores task progress cards when session history only has the internal notification", async () => {
    const progressRequests: Array<{ planId: string; traceId: string }> = [];
    const sessionProvider: WebuiSessionProvider = {
      channelName: "websocket",
      listSessions: () => [],
      getSessionMessages: () => ({
        sessionId: "websocket:chat-1",
        messages: [
          { role: "user", content: "Start task", timestamp: "2026-06-13T08:00:00.000Z" },
          {
            role: "user",
            content: "Task plan created.\n\n**Plan ID:** plan-1",
            timestamp: "2026-06-13T08:01:00.000Z",
            _task_event: true,
          },
        ],
      }),
      getTaskProgressCard: (planId, traceId) => {
        progressRequests.push({ planId, traceId });
        return {
          role: "progress",
          content: "Task Progress: Demo plan",
          timestamp: "2026-06-13T08:02:00.000Z",
          _progress: true,
          _tool_name: "task",
          _task_event: true,
          _task_progress: { event: "restored", plan_id: planId },
          _task_plan_id: planId,
        };
      },
    };

    const response = await handleWebuiRouteRequest(
      {
        method: "GET",
        path: "/api/sessions/websocket%3Achat-1/messages",
      },
      undefined,
      undefined,
      sessionProvider,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "trace-messages",
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      key: "websocket:chat-1",
      messages: [
        { role: "user", content: "Start task", timestamp: "2026-06-13T08:00:00.000Z" },
        {
          role: "progress",
          content: "Task Progress: Demo plan",
          timestamp: "2026-06-13T08:02:00.000Z",
          _progress: true,
          _tool_name: "task",
          _task_event: true,
          _task_progress: { event: "restored", plan_id: "plan-1" },
          _task_plan_id: "plan-1",
        },
      ],
    });
    expect(progressRequests).toEqual([{ planId: "plan-1", traceId: "trace-messages" }]);
  });

  test("serializes delegated run metadata needed by native desktop session restore", async () => {
    const sessionProvider: WebuiSessionProvider = {
      channelName: "websocket",
      listSessions: () => [],
      getSessionMessages: () => ({
        sessionId: "websocket:chat-delegate",
        messages: [
          {
            role: "tool",
            content: "Waiting for approval.",
            name: "spawn",
            tool_call_id: "call-spawn",
            timestamp: "2026-06-27T04:00:00.000Z",
            metadata: {
              approvalId: "approval-1",
              awaitingUserInput: true,
              stopReason: "awaiting_approval",
              _delegate_event: true,
              _delegate_id: "delegate-1",
              _delegate_status: "awaiting_approval",
              _delegate_task: "请用中文说一句\"你好\"",
              _delegate_child_checkpoint: { messages: ["internal checkpoint must not be serialized"] },
              _delegate_child_tool_call_id: "child-call-1",
              _delegate_operation_preview: "request_approval({\"reason\":\"demo\"})",
            },
          },
        ],
      }),
    };

    const response = await handleWebuiRouteRequest(
      {
        method: "GET",
        path: "/api/sessions/websocket%3Achat-delegate/messages",
      },
      undefined,
      undefined,
      sessionProvider,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "trace-delegate-messages",
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      key: "websocket:chat-delegate",
      messages: [{
        role: "tool",
        content: "Waiting for approval.",
        timestamp: "2026-06-27T04:00:00.000Z",
        name: "spawn",
        tool_call_id: "call-spawn",
        approvalId: "approval-1",
        awaitingUserInput: true,
        stopReason: "awaiting_approval",
        _delegate_event: true,
        _delegate_id: "delegate-1",
        _delegate_status: "awaiting_approval",
        _delegate_task: "请用中文说一句\"你好\"",
        _delegate_child_tool_call_id: "child-call-1",
        _delegate_operation_preview: "request_approval({\"reason\":\"demo\"})",
      }],
    });
  });

  test("restores Agent UI form metadata and hides nested internal form messages", async () => {
    const sessionProvider: WebuiSessionProvider = {
      channelName: "websocket",
      listSessions: () => [],
      getSessionMessages: () => ({
        sessionId: "websocket:chat-forms",
        messages: [
          {
            role: "assistant",
            content: "Please fill the form.",
            timestamp: "2026-06-14T08:00:00.000Z",
            metadata: {
              _agent_ui_form_id: "travel_plan",
              _agent_ui_form_status: "pending",
              _agent_ui_form_display: {
                form_id: "travel_plan",
                status: "pending",
                values: {},
                errors: {},
              },
            },
          },
          {
            role: "tool",
            name: "request_form",
            content: "internal form request",
            timestamp: "2026-06-14T08:00:01.000Z",
            metadata: { _agent_ui_internal: true },
          },
          {
            role: "user",
            content: "Agent UI form submitted: Travel plan",
            timestamp: "2026-06-14T08:00:02.000Z",
            metadata: {
              _agent_ui_form_response: {
                action: "submitted",
                form_id: "travel_plan",
                status: "submitted",
                values: { destination: "Paris" },
                errors: {},
              },
            },
          },
        ],
      }),
    };

    const response = await handleWebuiRouteRequest(
      {
        method: "GET",
        path: "/api/sessions/websocket%3Achat-forms/messages",
      },
      undefined,
      undefined,
      sessionProvider,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "trace-form-history",
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      key: "websocket:chat-forms",
      messages: [
        {
          role: "assistant",
          content: "Please fill the form.",
          timestamp: "2026-06-14T08:00:00.000Z",
          _agent_ui_form_id: "travel_plan",
          _agent_ui_form_status: "pending",
          _agent_ui_form_display: {
            form_id: "travel_plan",
            status: "pending",
            values: {},
            errors: {},
          },
        },
        {
          role: "user",
          content: "Agent UI form submitted: Travel plan",
          timestamp: "2026-06-14T08:00:02.000Z",
          _agent_ui_form_response: {
            action: "submitted",
            form_id: "travel_plan",
            status: "submitted",
            values: { destination: "Paris" },
            errors: {},
          },
        },
      ],
    });
  });

  test("allows temporary file upload for the configured WebUI channel prefix", async () => {
    const uploads: Array<{ sessionId: string; traceId: string; name: string }> = [];
    const sessionProvider: WebuiSessionProvider = {
      channelName: "native",
      listSessions: () => [],
      uploadTemporaryFile: (sessionId, upload, traceId) => {
        uploads.push({ sessionId, traceId, name: upload.name });
        return {
          id: "session_doc_1",
          name: upload.name,
          file_type: upload.fileType,
          chunk_count: 1,
          size_bytes: upload.sizeBytes,
          temporary: true,
        };
      },
    };

    const response = await handleWebuiRouteRequest(
      {
        method: "POST",
        path: "/api/sessions/native%3Achat-1/temporary-files",
        body: { name: "notes.txt", content: "hello" },
      },
      undefined,
      undefined,
      sessionProvider,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "trace-temp-upload",
    );

    expect(response.status).toBe(200);
    expect(uploads).toEqual([{ sessionId: "native:chat-1", traceId: "trace-temp-upload", name: "notes.txt" }]);
  });

  test("passes empty text uploads to the temporary knowledge store for validation", async () => {
    const uploads: Array<{ sessionId: string; content: string }> = [];
    const sessionProvider: WebuiSessionProvider = {
      channelName: "websocket",
      listSessions: () => [],
      uploadTemporaryFile: (sessionId, upload) => {
        uploads.push({ sessionId, content: upload.content });
        throw new Error("Uploaded file contains no extractable text");
      },
    };

    const response = await handleWebuiRouteRequest(
      {
        method: "POST",
        path: "/api/sessions/websocket%3Achat-1/temporary-files",
        body: { name: "blank.txt", content: "" },
      },
      undefined,
      undefined,
      sessionProvider,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "trace-empty-upload",
    );

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "Uploaded file contains no extractable text" });
    expect(uploads).toEqual([{ sessionId: "websocket:chat-1", content: "" }]);
  });

  test("allows temporary file clearing for the configured WebUI channel prefix", async () => {
    const clears: Array<{ sessionId: string; traceId: string }> = [];
    const sessionProvider: WebuiSessionProvider = {
      channelName: "native",
      listSessions: () => [],
      clearTemporaryFiles: (sessionId, traceId) => {
        clears.push({ sessionId, traceId });
        return { sessionId, items: [], cleared: 2 };
      },
    };

    const response = await handleWebuiRouteRequest(
      {
        method: "DELETE",
        path: "/api/sessions/native%3Achat-1/temporary-files",
      },
      undefined,
      undefined,
      sessionProvider,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "trace-temp-clear",
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ items: [], cleared: 2 });
    expect(clears).toEqual([{ sessionId: "native:chat-1", traceId: "trace-temp-clear" }]);
  });
});

describe("WebUI knowledge diagnostics", () => {
  test("routes tree index rebuilds through the knowledge provider", async () => {
    const rebuilds: Array<{ type: string; traceId: string }> = [];
    const knowledgeProvider: WebuiKnowledgeProvider = {
      listDocuments: () => ({ documents: [] }),
      addDocument: () => ({ document: { id: "doc-1" } }),
      getDocument: () => null,
      deleteDocument: () => ({ deleted: false }),
      query: () => ({ results: [] }),
      stats: () => ({ total_documents: 1, total_chunks: 2, retrieval_ready: true }),
      rebuildIndex: (type, traceId) => {
        rebuilds.push({ type, traceId });
        return {
          id: `kjob_rebuild_${type}`,
          result: {
            available: true,
            documents_scanned: 1,
            sections_indexed: 2,
            tree_ready: true,
          },
        };
      },
    };

    const response = await handleWebuiRouteRequest(
      {
        method: "POST",
        path: "/v1/knowledge/rebuild-index?type=tree",
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      knowledgeProvider,
      undefined,
      "trace-tree-rebuild",
    );

    expect(response).toEqual({
      status: 200,
      body: {
        message: "Knowledge tree index rebuilt successfully",
        available: true,
        documents_scanned: 1,
        sections_indexed: 2,
        tree_ready: true,
      },
    });
    expect(rebuilds).toEqual([{ type: "tree", traceId: "trace-tree-rebuild" }]);
  });

  test("auto-extracts a graph after upload when graph auto extract is enabled", async () => {
    const saves: Array<Record<string, unknown>> = [];
    const configProvider: WebuiConfigProvider = {
      getConfig: () => ({
        agents: { defaults: { model: "knowledge-model" } },
        knowledge: {
          enabled: true,
          graph_extraction_enabled: true,
          graph_auto_extract: true,
          semantic_llm_max_tokens: 1200,
        },
      }),
      patchConfig: () => ({}),
    };
    const openAiCompatProvider: WebuiOpenAiCompatProvider = {
      completeChat: () => JSON.stringify({ entities: [{ name: "RAG", confidence: 0.9 }], relations: [] }),
    };
    const knowledgeProvider: WebuiKnowledgeProvider = {
      listDocuments: () => ({ documents: [] }),
      addDocument: (body) => ({
        document: {
          id: "doc-1",
          name: body.name,
          file_path: "knowledge/files/doc-1.md",
          file_type: body.file_type,
          chunk_count: 1,
          content: body.content,
        },
        content: body.content,
      }),
      getDocument: () => ({
        document: { id: "doc-1", name: "RAG.md", chunk_count: 1 },
        content: "# RAG\nTinyBot can extract graph data.",
      }),
      deleteDocument: () => ({ deleted: false }),
      query: () => ({ results: [] }),
      stats: () => ({ total_documents: 1, total_chunks: 1, retrieval_ready: true }),
      saveEntityGraphExtraction: (payload) => {
        saves.push(payload);
        return {
          id: "kjob_extract_graph_doc-1",
          doc_id: "doc-1",
          name: "extract_graph:RAG.md",
          status: "completed",
          stage: "entity_graph_extracted",
          processed: 1,
          total: 1,
        };
      },
    };

    const response = await handleWebuiRouteRequest(
      {
        method: "POST",
        path: "/v1/knowledge/documents/upload?async_index=true",
        body: {
          name: "RAG.md",
          content: "# RAG\nTinyBot can extract graph data.",
          file_type: "md",
        },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      configProvider,
      undefined,
      undefined,
      undefined,
      undefined,
      openAiCompatProvider,
      knowledgeProvider,
      undefined,
      "trace-auto-extract",
    );

    expect(response).toMatchObject({
      status: 202,
      body: {
        id: "doc-1",
        graph_extraction_job: {
          id: expect.stringMatching(/^kjob_extract_graph_/),
          doc_id: "doc-1",
          stage: expect.stringMatching(/queued|llm_extraction/),
        },
      },
    });
    await waitForExpectation(() => {
      expect(saves).toHaveLength(1);
    });
    expect(saves[0]).toMatchObject({ doc_id: "doc-1", doc_name: "RAG.md" });
  });

  test("emits detailed backend diagnostics for graph extraction stages", async () => {
    const diagnostics: Array<{ stream: string; line: string }> = [];
    const diagnosticsLogger: WebuiDiagnosticsLogger = (diagnostic) => diagnostics.push(diagnostic);
    const configProvider: WebuiConfigProvider = {
      getConfig: () => ({
        agents: { defaults: { model: "knowledge-model" } },
        knowledge: { graph_extraction_model: "graph-model", graph_extraction_max_tokens: 640 },
      }),
      patchConfig: () => ({}),
    };
    const openAiCompatProvider: WebuiOpenAiCompatProvider = {
      completeChat: (request) => {
        request.onReasoningDelta?.("checking graph candidates");
        request.onContentDelta?.("{\"entities\"");
        request.onContentDelta?.(":[{\"name\":\"TinyBot\",\"evidence\":[{\"text\":\"Private evidence from source doc\"}]}],\"relations\":[]}");
        return JSON.stringify({ entities: [{ name: "TinyBot", confidence: 0.9 }], relations: [] });
      },
    };
    const knowledgeProvider: WebuiKnowledgeProvider = {
      listDocuments: () => ({ documents: [] }),
      addDocument: () => ({ document: {} }),
      getDocument: () => ({
        document: { id: "doc-log", name: "RAG.md", chunk_count: 1 },
        content: "# RAG\nTinyBot extracts graph data.",
      }),
      deleteDocument: () => ({ deleted: false }),
      query: () => ({ results: [] }),
      stats: () => ({ total_documents: 1, total_chunks: 1, retrieval_ready: true }),
      saveEntityGraphExtraction: () => ({
        id: "kjob_extract_graph_doc-log",
        doc_id: "doc-log",
        name: "extract_graph:RAG.md",
        status: "completed",
        stage: "entity_graph_extracted",
        processed: 1,
        total: 1,
      }),
    };

    const response = await handleWebuiRouteRequest(
      { method: "POST", path: "/v1/knowledge/graph/extract", body: { doc_id: "doc-log" } },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      configProvider,
      undefined,
      undefined,
      undefined,
      undefined,
      openAiCompatProvider,
      knowledgeProvider,
      undefined,
      "trace-graph-log",
      diagnosticsLogger,
    );

    expect(response.status).toBe(202);
    await waitForExpectation(() => {
      expect(diagnostics.map((entry) => diagnosticStage(entry.line))).toEqual(expect.arrayContaining([
        "knowledge.graph_extract.start",
        "knowledge.graph_extract.job_queued",
        "knowledge.graph_extract.stage",
        "knowledge.graph_extract.llm_delta",
        "knowledge.graph_extract.complete",
      ]));
    });
    const logText = diagnostics.map((entry) => entry.line).join("\n");
    expect(logText).toContain('"doc_id":"doc-log"');
    expect(logText).toContain('"extract_stage":"llm_extraction"');
    expect(logText).toContain('"extract_stage":"parsed_graph_json"');
    expect(logText).toContain('"extract_stage":"persisted_entity_graph"');
    expect(logText).not.toContain("TinyBot extracts graph data");
    expect(logText).not.toContain("Private evidence from source doc");
  });

  test("marks the failed graph extraction stage in job progress", async () => {
    const configProvider: WebuiConfigProvider = {
      getConfig: () => ({
        agents: { defaults: { model: "knowledge-model" } },
        knowledge: { graph_extraction_model: "graph-model", graph_extraction_max_tokens: 640 },
      }),
      patchConfig: () => ({}),
    };
    const openAiCompatProvider: WebuiOpenAiCompatProvider = {
      completeChat: () => "Error calling model: provider returned HTML",
    };
    const knowledgeProvider: WebuiKnowledgeProvider = {
      listDocuments: () => ({ documents: [] }),
      addDocument: () => ({ document: {} }),
      getDocument: () => ({
        document: { id: "doc-fail", name: "Broken.md", chunk_count: 1 },
        content: "# Broken\nProvider returns an error page.",
      }),
      deleteDocument: () => ({ deleted: false }),
      query: () => ({ results: [] }),
      stats: () => ({ total_documents: 1, total_chunks: 1, retrieval_ready: true }),
      saveEntityGraphExtraction: () => ({ id: "unused" }),
    };

    const response = await handleWebuiRouteRequest(
      { method: "POST", path: "/v1/knowledge/graph/extract", body: { doc_id: "doc-fail" } },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      configProvider,
      undefined,
      undefined,
      undefined,
      undefined,
      openAiCompatProvider,
      knowledgeProvider,
      undefined,
      "trace-graph-fail",
    );
    const jobId = String((response.body as Record<string, unknown>).job_id);

    await waitForExpectation(async () => {
      const failedJob = await handleWebuiRouteRequest(
        { method: "GET", path: `/v1/knowledge/jobs/${jobId}` },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        configProvider,
        undefined,
        undefined,
        undefined,
        undefined,
        openAiCompatProvider,
        knowledgeProvider,
        undefined,
        "trace-graph-fail-job",
      );
      expect(failedJob).toMatchObject({
        status: 200,
        body: {
          status: "failed",
          progress: {
            documents: [
              {
                doc_id: "doc-fail",
                stage: "parsed_graph_json",
                status: "failed",
                stages: expect.arrayContaining([
                  { stage: "llm_extraction", status: "completed" },
                  { stage: "parsed_graph_json", status: "failed" },
                ]),
              },
            ],
          },
        },
      });
    });
  });

  test("emits sanitized backend diagnostics for knowledge uploads", async () => {
    const diagnostics: Array<{ stream: string; line: string }> = [];
    const diagnosticsLogger: WebuiDiagnosticsLogger = (diagnostic) => diagnostics.push(diagnostic);
    const knowledgeProvider: WebuiKnowledgeProvider = {
      listDocuments: () => ({ documents: [] }),
      addDocument: (body) => ({
        document: {
          id: "doc-1",
          name: body.name,
          file_path: "knowledge/files/doc-1.md",
          file_type: body.file_type,
          chunk_count: 2,
        },
      }),
      getDocument: () => null,
      deleteDocument: () => ({ deleted: false }),
      query: () => ({ results: [] }),
      stats: () => ({ total_documents: 1, total_chunks: 2, retrieval_ready: true }),
    };

    const response = await handleWebuiRouteRequest(
      {
        method: "POST",
        path: "/v1/knowledge/documents/upload?async_index=true",
        body: {
          name: "RAG.md",
          content: "# Secret body\nDo not put this content in diagnostics.",
          file_type: "md",
          size_bytes: 52,
        },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      knowledgeProvider,
      undefined,
      "trace-knowledge-upload",
      diagnosticsLogger,
    );

    expect(response.status).toBe(202);
    expect(diagnostics.map((entry) => entry.stream)).toEqual(["stderr", "stderr"]);
    expect(diagnostics.map((entry) => diagnosticStage(entry.line))).toEqual([
      "knowledge.upload_document.start",
      "knowledge.upload_document.complete",
    ]);
    expect(diagnostics[0].line).toContain('"name":"RAG.md"');
    expect(diagnostics[0].line).toContain('"file_type":"md"');
    expect(diagnostics[1].line).toContain('"id":"doc-1"');
    expect(diagnostics.map((entry) => entry.line).join("\n")).not.toContain("Secret body");
    expect(diagnostics.map((entry) => entry.line).join("\n")).not.toContain("Do not put this content");
  });
});

function diagnosticStage(line: string): string {
  const payload = JSON.parse(line.replace(/^\[knowledge\]\s*/, ""));
  return String(payload.stage);
}

describe("WebUI Agent UI form routes", () => {
  test("ignores invalid values on cancel like the legacy runtime form cancellation", async () => {
    const continuations: Array<{ formId: string; sessionId: string; action: string; values: Record<string, unknown> }> = [];
    const agentUiFormProvider: WebuiAgentUiFormProvider = {
      continueForm: (request) => {
        continuations.push({
          formId: request.formId,
          sessionId: request.sessionId,
          action: request.action,
          values: request.values,
        });
        return {
          cancelled: true,
          form_id: request.formId,
          continuation: { mode: "resume", delivered: true, target: "agent_loop" },
        };
      },
    };

    const response = await handleWebuiRouteRequest(
      {
        method: "POST",
        path: "/api/agent-ui/forms/travel%2Fplan/cancel",
        body: {
          correlation: { session_key: "websocket:chat-1" },
          values: "ignored",
        },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      agentUiFormProvider,
      undefined,
      undefined,
      undefined,
      undefined,
      "trace-form-cancel",
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      cancelled: true,
      form_id: "travel/plan",
      continuation: { mode: "resume", delivered: true, target: "agent_loop" },
    });
    expect(continuations).toEqual([{
      formId: "travel/plan",
      sessionId: "websocket:chat-1",
      action: "cancelled",
      values: {},
    }]);
  });
});
