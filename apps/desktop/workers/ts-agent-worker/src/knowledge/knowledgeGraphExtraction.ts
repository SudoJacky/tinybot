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

export type KnowledgeGraphExtractionProgressPhase = "estimated" | "running" | "completed" | "skipped";

const KNOWLEDGE_GRAPH_EXTRACTION_STAGES = [
  "resolved_document",
  "loaded_content",
  "estimated_tokens",
  "checked_existing_graph",
  "checked_budget",
  "llm_extraction",
  "parsed_graph_json",
  "persisted_entity_graph",
] as const;

const CONTROLLED_RELATION_PREDICATES = [
  "depends_on",
  "causes",
  "implements",
  "configures",
  "mentions",
  "conflicts_with",
  "supports",
] as const;

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

export function buildKnowledgeGraphBatchEstimateBody(
  plans: KnowledgeGraphExtractionPlan[],
  maxTokens: number,
  maxJobTokens: number | null,
  scope: string,
  skippedDocs: KnowledgeGraphSkippedDoc[] = [],
): Record<string, unknown> {
  const skippedByDocId = new Map(skippedDocs.map((item) => [item.doc_id, item]));
  const runnablePlans = plans.filter((plan) => !skippedByDocId.has(plan.docId));
  const totals = knowledgeGraphPlansTokenTotals(runnablePlans);
  return {
    object: "knowledge_graph_extraction_estimate",
    scope,
    document_count: plans.length,
    runnable_document_count: runnablePlans.length,
    skipped_count: skippedDocs.length,
    progress: buildKnowledgeGraphExtractionProgress(plans, skippedDocs, "estimated"),
    estimates: plans.map((plan) => ({
      doc_id: plan.docId,
      doc_name: plan.docName,
      token_estimate: plan.tokenEstimate,
      extraction_scope: plan.extractionScope,
      ...(skippedByDocId.has(plan.docId)
        ? {
          skipped: true,
          skipped_reason: skippedByDocId.get(plan.docId)?.reason,
        }
        : {}),
    })),
    token_estimate: {
      prompt_tokens: totals.prompt,
      completion_tokens: totals.completion,
      total_tokens: totals.total,
      max_tokens: maxTokens,
      ...(maxJobTokens !== null ? { max_job_tokens: maxJobTokens } : {}),
      within_budget: runnablePlans.every((plan) => plan.tokenEstimate.within_budget !== false)
        && areKnowledgeGraphPlansWithinJobBudget(runnablePlans, maxJobTokens),
    },
    ...(skippedDocs.length ? { skipped_docs: skippedDocs } : {}),
  };
}

export function buildKnowledgeGraphSingleEstimateBody(
  plan: KnowledgeGraphExtractionPlan,
  skipped?: KnowledgeGraphSkippedDoc,
): Record<string, unknown> {
  const tokenEstimate = skipped
    ? {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      max_tokens: numberValue(plan.tokenEstimate.max_tokens) ?? 0,
      within_budget: true,
    }
    : plan.tokenEstimate;
  return {
    object: "knowledge_graph_extraction_estimate",
    doc_id: plan.docId,
    doc_name: plan.docName,
    token_estimate: tokenEstimate,
    extraction_scope: plan.extractionScope,
    runnable_document_count: skipped ? 0 : 1,
    skipped_count: skipped ? 1 : 0,
    progress: buildKnowledgeGraphExtractionProgress([plan], skipped ? [skipped] : [], "estimated"),
    ...(skipped
      ? {
        skipped: true,
        skipped_reason: skipped.reason,
        skipped_docs: [skipped],
      }
      : {}),
  };
}

export function buildKnowledgeGraphExtractionProgress(
  plans: KnowledgeGraphExtractionPlan[],
  skippedDocs: KnowledgeGraphSkippedDoc[],
  phase: KnowledgeGraphExtractionProgressPhase,
  jobs: Record<string, unknown>[] = [],
): Record<string, unknown> {
  const skippedByDocId = new Map(skippedDocs.map((item) => [item.doc_id, item]));
  const jobsByDocId = new Map<string, Record<string, unknown>>();
  jobs.forEach((job, index) => {
    const docId = stringValue(job.doc_id) ?? plans[index]?.docId;
    if (docId) {
      jobsByDocId.set(docId, job);
    }
  });
  const documents = plans.map((plan) => knowledgeGraphDocumentProgress(
    plan,
    skippedByDocId.get(plan.docId),
    phase,
    jobsByDocId.get(plan.docId),
  ));
  const completedPhase = phase === "completed";
  const completed = completedPhase
    ? documents.reduce((total, document) => total + (numberValue(document.completed) ?? 0), 0)
    : Math.min(5, KNOWLEDGE_GRAPH_EXTRACTION_STAGES.length);
  const total = completedPhase
    ? documents.reduce((sum, document) => sum + (numberValue(document.total) ?? KNOWLEDGE_GRAPH_EXTRACTION_STAGES.length), 0)
    : KNOWLEDGE_GRAPH_EXTRACTION_STAGES.length;
  return {
    stage: phase,
    completed,
    total,
    document_count: plans.length,
    runnable_document_count: plans.length - skippedDocs.length,
    skipped_count: skippedDocs.length,
    documents,
  };
}

export function areKnowledgeGraphPlansWithinJobBudget(plans: KnowledgeGraphExtractionPlan[], maxJobTokens: number | null): boolean {
  return maxJobTokens === null || knowledgeGraphPlansTokenTotals(plans).total <= maxJobTokens;
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

function knowledgeGraphPlansTokenTotals(plans: KnowledgeGraphExtractionPlan[]): { prompt: number; completion: number; total: number } {
  return plans.reduce((acc, plan) => {
    acc.prompt += numberValue(plan.tokenEstimate.prompt_tokens) ?? 0;
    acc.completion += numberValue(plan.tokenEstimate.completion_tokens) ?? 0;
    acc.total += numberValue(plan.tokenEstimate.total_tokens) ?? 0;
    return acc;
  }, { prompt: 0, completion: 0, total: 0 });
}

function knowledgeGraphDocumentProgress(
  plan: KnowledgeGraphExtractionPlan,
  skipped: KnowledgeGraphSkippedDoc | undefined,
  phase: KnowledgeGraphExtractionProgressPhase,
  job: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const completed = phase === "completed" ? KNOWLEDGE_GRAPH_EXTRACTION_STAGES.length : 5;
  const skippedDoc = Boolean(skipped);
  const status = skippedDoc ? "skipped" : phase === "completed" ? "completed" : phase === "running" ? "running" : "ready";
  const stage = skippedDoc ? "skipped_existing_graph" : phase === "completed" ? "persisted_entity_graph" : "budget_checked";
  return {
    doc_id: plan.docId,
    doc_name: plan.docName,
    status,
    stage,
    completed,
    total: KNOWLEDGE_GRAPH_EXTRACTION_STAGES.length,
    token_estimate: skippedDoc
      ? {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        max_tokens: numberValue(plan.tokenEstimate.max_tokens) ?? 0,
        within_budget: true,
      }
      : plan.tokenEstimate,
    extraction_scope: plan.extractionScope,
    ...(skipped ? { skipped_reason: skipped.reason } : {}),
    ...(job?.id ? { job_id: job.id } : {}),
    ...(job?.result ? { result: job.result } : {}),
    stages: KNOWLEDGE_GRAPH_EXTRACTION_STAGES.map((stageName, index) => ({
      stage: stageName,
      status: knowledgeGraphStageStatus(index, skippedDoc, phase),
    })),
  };
}

function knowledgeGraphStageStatus(index: number, skipped: boolean, phase: KnowledgeGraphExtractionProgressPhase): string {
  if (index < 5) {
    return "completed";
  }
  if (skipped) {
    return "skipped";
  }
  if (phase === "completed") {
    return "completed";
  }
  if (phase === "running" && index === 5) {
    return "running";
  }
  return "pending";
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
    `Allowed relation predicates: ${CONTROLLED_RELATION_PREDICATES.join(", ")}.`,
    "Use mentions for generic, containment, storage, or unclear relations.",
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
    relations: arrayFromUnknown(root.relations)
      .map(normalizeExtractedRelation)
      .filter((relation) =>
        stringValue(relation.source)
        && stringValue(relation.target)
        && stringValue(relation.predicate)
        && arrayFromUnknown(relation.evidence).some((evidence) => Boolean(stringValue(asObject(evidence)?.text)))
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

type NormalizedRelationPredicate = {
  predicate: string;
  inverse: boolean;
};

function normalizeExtractedRelation(value: unknown): Record<string, unknown> {
  const relation = asObject(value) ?? {};
  const source = stringValue(relation.source) ?? "";
  const target = stringValue(relation.target) ?? "";
  const normalizedPredicate = normalizeRelationPredicate(stringValue(relation.predicate) ?? stringValue(relation.type));
  return {
    source: normalizedPredicate.inverse ? target : source,
    target: normalizedPredicate.inverse ? source : target,
    predicate: normalizedPredicate.predicate,
    confidence: normalizedConfidence(relation.confidence),
    evidence: arrayFromUnknown(relation.evidence).map(normalizeExtractionEvidence),
  };
}

function normalizeRelationPredicate(value: string | undefined): NormalizedRelationPredicate {
  const normalized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if ((CONTROLLED_RELATION_PREDICATES as readonly string[]).includes(normalized)) {
    return { predicate: normalized, inverse: false };
  }
  if (["depends", "depends_on", "dependency", "requires", "uses", "relies_on"].includes(normalized)) {
    return { predicate: "depends_on", inverse: false };
  }
  if (["cause", "leads_to", "produces"].includes(normalized)) {
    return { predicate: "causes", inverse: false };
  }
  if (normalized === "caused_by") {
    return { predicate: "causes", inverse: true };
  }
  if (["implement", "built_by"].includes(normalized)) {
    return { predicate: "implements", inverse: false };
  }
  if (normalized === "implemented_by") {
    return { predicate: "implements", inverse: true };
  }
  if (["configure", "sets", "controls"].includes(normalized)) {
    return { predicate: "configures", inverse: false };
  }
  if (normalized === "configured_by") {
    return { predicate: "configures", inverse: true };
  }
  if (["conflict", "conflicts", "contradicts", "opposes"].includes(normalized)) {
    return { predicate: "conflicts_with", inverse: false };
  }
  if (["support", "validates"].includes(normalized)) {
    return { predicate: "supports", inverse: false };
  }
  if (normalized === "supported_by") {
    return { predicate: "supports", inverse: true };
  }
  return { predicate: "mentions", inverse: false };
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
