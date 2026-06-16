export type KnowledgeGraphExtractionResult = {
  entities: Record<string, unknown>[];
  relations: Record<string, unknown>[];
};

export type KnowledgeGraphExtractionProvider = {
  listDocuments(request: Record<string, unknown>, traceId: string): Promise<unknown> | unknown;
  getDocument(docId: string, traceId: string): Promise<unknown> | unknown;
  graph?(request: Record<string, unknown>, traceId: string): Promise<unknown> | unknown;
  saveEntityGraphExtraction?(body: Record<string, unknown>, traceId: string): Promise<unknown> | unknown;
};

export type KnowledgeGraphOpenAiCompatProvider = {
  completeChat(
    request: {
      content: string;
      sessionKey: string;
      chatId: string;
      model: string;
      timeoutSeconds: number;
    },
    traceId: string,
  ): Promise<string> | string;
};

export type KnowledgeGraphExtractionPlan = {
  docId: string;
  docName: string;
  content: string;
  tokenEstimate: Record<string, unknown>;
  extractionScope: Record<string, unknown>;
};

export type KnowledgeGraphSkippedDoc = {
  doc_id: string;
  doc_name: string;
  reason: string;
};

export async function resolveKnowledgeGraphExtractionDocIds(
  body: Record<string, unknown>,
  provider: KnowledgeGraphExtractionProvider,
  traceId: string,
): Promise<string[]> {
  const explicitIds = [
    stringValue(body.doc_id) ?? stringValue(body.docId),
    ...knowledgeGraphExtractionIdList(body.doc_ids ?? body.docIds),
  ].filter((value): value is string => Boolean(value));
  if (explicitIds.length) {
    return Array.from(new Set(explicitIds));
  }
  if (stringValue(body.scope) === "all") {
    const result = await provider.listDocuments({ limit: knowledgeGraphExtractionDocumentLimit(body) }, traceId);
    return arrayFromResult(result, "documents").map((document) => stringValue(document.id)).filter((id): id is string => Boolean(id));
  }
  return [];
}

export async function buildKnowledgeGraphExtractionPlan(
  provider: KnowledgeGraphExtractionProvider,
  docId: string,
  maxTokens: number,
  maxChunks: number,
  traceId: string,
): Promise<KnowledgeGraphExtractionPlan | null> {
  const result = await provider.getDocument(docId, traceId);
  const document = documentFromResult(result);
  if (!document) {
    return null;
  }
  const rawContent = stringValue(asObject(result)?.content) ?? stringValue(document.content) ?? "";
  const scoped = knowledgeGraphExtractionContent(rawContent, maxChunks);
  const docName = stringValue(document.name) ?? docId;
  return {
    docId,
    docName,
    content: scoped.content,
    tokenEstimate: estimateKnowledgeGraphExtractionTokens(scoped.content, maxTokens),
    extractionScope: {
      max_chunks: maxChunks,
      chunk_count: scoped.chunkCount,
      original_chunk_count: scoped.originalChunkCount,
    },
  };
}

export async function findExistingKnowledgeGraphExtractionSkips(
  plans: KnowledgeGraphExtractionPlan[],
  provider: KnowledgeGraphExtractionProvider,
  traceId: string,
): Promise<KnowledgeGraphSkippedDoc[]> {
  if (!provider.graph) {
    return [];
  }
  const skipped: KnowledgeGraphSkippedDoc[] = [];
  for (const plan of plans) {
    const graph = await provider.graph({
      doc_id: plan.docId,
      graph_type: "entity",
      limit: 1,
      edge_limit: 1,
      include_orphans: true,
    }, traceId);
    if (arrayFromResult(graph, "nodes").length || arrayFromResult(graph, "edges").length) {
      if (!knowledgeGraphExtractionStale(graph)) {
        skipped.push({ doc_id: plan.docId, doc_name: plan.docName, reason: "entity_graph_exists" });
      }
    }
  }
  return skipped;
}

export async function runKnowledgeGraphExtractionPlans<T>(
  plans: KnowledgeGraphExtractionPlan[],
  concurrency: number,
  run: (plan: KnowledgeGraphExtractionPlan) => Promise<T>,
): Promise<T[]> {
  const results = new Array<T>(plans.length);
  let cursor = 0;
  const workerCount = Math.min(Math.max(1, concurrency), plans.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < plans.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await run(plans[index]!);
    }
  }));
  return results;
}

export async function runKnowledgeGraphExtractionPlan(options: {
  plan: KnowledgeGraphExtractionPlan;
  provider: KnowledgeGraphExtractionProvider;
  openAiCompatProvider: KnowledgeGraphOpenAiCompatProvider;
  model: string;
  maxTokens: number;
  timeoutSeconds: number;
  traceId: string;
}): Promise<Record<string, unknown>> {
  const extractionText = await options.openAiCompatProvider.completeChat({
    content: buildKnowledgeGraphExtractionPrompt(options.plan.docName, options.plan.content, options.maxTokens),
    sessionKey: "knowledge:graph-extraction",
    chatId: "knowledge-graph-extraction",
    model: options.model,
    timeoutSeconds: options.timeoutSeconds,
  }, options.traceId);
  const extraction = parseKnowledgeGraphExtractionJson(extractionText);
  const savePayload = {
    doc_id: options.plan.docId,
    doc_name: options.plan.docName,
    model: options.model,
    token_estimate: options.plan.tokenEstimate,
    extraction_scope: options.plan.extractionScope,
    entities: extraction.entities,
    relations: extraction.relations,
    diagnostics: {
      raw_chars: extractionText.length,
      content_chars: options.plan.content.length,
    },
  };
  return asObject(await options.provider.saveEntityGraphExtraction?.(savePayload, options.traceId)) ?? {};
}

export function estimateKnowledgeGraphExtractionTokens(content: string, maxTokens: number): Record<string, unknown> {
  const promptTokens = Math.ceil(content.length / 4) + 240;
  const completionTokens = Math.min(maxTokens, Math.max(256, Math.ceil(content.length / 8)));
  const totalTokens = promptTokens + completionTokens;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    max_tokens: maxTokens,
    within_budget: totalTokens <= maxTokens,
  };
}

function knowledgeGraphExtractionDocumentLimit(body: Record<string, unknown>): number {
  return Math.max(
    1,
    Math.min(
      10_000,
      Math.trunc(numberValue(body.document_limit) ?? numberValue(body.documentLimit) ?? numberValue(body.limit) ?? 1000),
    ),
  );
}

function knowledgeGraphExtractionIdList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function knowledgeGraphExtractionContent(content: string, maxChunks: number): { content: string; chunkCount: number; originalChunkCount: number } {
  const chunks = content.split(/\n\s*\n/u).map((chunk) => chunk.trim()).filter(Boolean);
  if (!chunks.length) {
    return { content, chunkCount: 0, originalChunkCount: 0 };
  }
  const selected = chunks.slice(0, Math.max(1, maxChunks));
  return {
    content: selected.join("\n\n"),
    chunkCount: selected.length,
    originalChunkCount: chunks.length,
  };
}

function knowledgeGraphExtractionStale(graph: unknown): boolean {
  const graphObject = asObject(graph) ?? {};
  const readiness = asObject(graphObject.readiness) ?? {};
  const stats = asObject(graphObject.stats) ?? {};
  if (readiness.entity_graph_stale === true) {
    return true;
  }
  if ((numberValue(stats.stale_count) ?? 0) > 0) {
    return true;
  }
  return [...arrayFromResult(graph, "nodes"), ...arrayFromResult(graph, "edges")]
    .some((item) => asObject(asObject(item)?.attributes)?.stale === true);
}

function documentFromResult(result: unknown): Record<string, unknown> | null {
  const object = asObject(result);
  if (!object) {
    return null;
  }
  return asObject(object.document) ?? object;
}

function arrayFromResult(result: unknown, key: string): Record<string, unknown>[] {
  const object = asObject(result);
  const value = object ? object[key] : result;
  return Array.isArray(value)
    ? value.map((item) => asObject(item)).filter((item): item is Record<string, unknown> => item !== null)
    : [];
}

export function buildKnowledgeGraphExtractionPrompt(docName: string, content: string, maxTokens: number): string {
  return [
    "You extract a knowledge entity graph from one document.",
    "Return strict JSON only, with no markdown fences.",
    "Schema: {\"entities\":[{\"name\":\"\",\"type\":\"\",\"confidence\":0.0,\"evidence\":[{\"text\":\"\",\"line_start\":1,\"line_end\":1}]}],\"relations\":[{\"source\":\"\",\"target\":\"\",\"predicate\":\"\",\"confidence\":0.0,\"evidence\":[{\"text\":\"\",\"line_start\":1,\"line_end\":1}]}]}",
    "Only include entities and relations directly supported by source evidence.",
    `Token budget for the answer: ${maxTokens}.`,
    `Document: ${docName}`,
    "Content:",
    content,
  ].join("\n");
}

export function parseKnowledgeGraphExtractionJson(raw: string): KnowledgeGraphExtractionResult {
  const parsed = JSON.parse(stripJsonCodeFence(raw));
  const root = asObject(parsed) ?? {};
  return {
    entities: arrayFromUnknown(root.entities).map(normalizeExtractedEntity).filter((entity) => stringValue(entity.name)),
    relations: arrayFromUnknown(root.relations).map(normalizeExtractedRelation).filter((relation) =>
      stringValue(relation.source) && stringValue(relation.target) && stringValue(relation.predicate)
    ),
  };
}

function normalizeExtractedEntity(value: unknown): Record<string, unknown> {
  const entity = asObject(value) ?? {};
  return {
    name: stringValue(entity.name) ?? "",
    type: stringValue(entity.type) ?? stringValue(entity.entity_type) ?? "",
    confidence: normalizedConfidence(entity.confidence),
    evidence: arrayFromUnknown(entity.evidence).map(normalizeExtractionEvidence),
  };
}

function normalizeExtractedRelation(value: unknown): Record<string, unknown> {
  const relation = asObject(value) ?? {};
  return {
    source: stringValue(relation.source) ?? "",
    target: stringValue(relation.target) ?? "",
    predicate: stringValue(relation.predicate) ?? stringValue(relation.type) ?? "related_to",
    confidence: normalizedConfidence(relation.confidence),
    evidence: arrayFromUnknown(relation.evidence).map(normalizeExtractionEvidence),
  };
}

function normalizeExtractionEvidence(value: unknown): Record<string, unknown> {
  const evidence = asObject(value) ?? {};
  const lineStart = numberValue(evidence.line_start) ?? numberValue(evidence.lineStart) ?? 1;
  return {
    text: stringValue(evidence.text) ?? stringValue(evidence.quote) ?? "",
    line_start: lineStart,
    line_end: numberValue(evidence.line_end) ?? numberValue(evidence.lineEnd) ?? lineStart,
  };
}

function normalizedConfidence(value: unknown): number {
  const confidence = numberValue(value);
  if (confidence === undefined) {
    return 0;
  }
  return Math.max(0, Math.min(1, confidence));
}

function stripJsonCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function arrayFromUnknown(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
