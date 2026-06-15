import type { DesktopTaskSourceOperation } from "./desktopTaskCenter";

export interface DesktopKnowledgeReadinessRow {
  id: "retrieval" | "claims" | "relations" | "expansion" | "graph";
  titleKey: string;
  textKey: string;
  statusKey: string;
  tone: "ready" | "warn" | "error" | "muted";
  replacements: Record<string, number>;
}

export interface DesktopKnowledgeReadinessView {
  score: number;
  titleKey: string;
  descKey: string;
  descReplacements: Record<string, number>;
  partialAvailability: boolean;
  failedStageCount: number;
  staleStageCount: number;
  rows: DesktopKnowledgeReadinessRow[];
}

export interface DesktopKnowledgeDocumentRow {
  id: string;
  title: string;
  path: string;
  category: string;
  typeLabel?: string;
  sizeLabel?: string;
  addedLabel?: string;
  tags: string[];
  chunkCount: number;
  status: string;
  updatedAt: string;
  meta: string;
}

export interface DesktopKnowledgeQueryRequestInput {
  query: string;
  mode?: string;
  topK?: number;
}

export interface DesktopKnowledgeQueryRequest {
  query: string;
  mode: string;
  top_k: number;
}

export interface DesktopKnowledgeTraceabilitySection {
  kind: "source" | "claims" | "relations" | "conflicts";
  title: string;
  rows: DesktopKnowledgeEvidenceRow[];
}

export interface DesktopKnowledgeQueryResultView {
  summary: {
    count: number;
    docs: string[];
    lowConfidence: boolean;
  };
  rows: DesktopKnowledgeQueryResultRow[];
}

export interface DesktopKnowledgeQueryResultRow {
  id: string;
  docName: string;
  content: string;
  relevance: "high" | "medium" | "low";
  scoreLabel: string;
  meta: string;
  why: string;
  traceabilitySections: DesktopKnowledgeTraceabilitySection[];
  graphHighlight: DesktopKnowledgeGraphHighlight;
  raw: unknown;
}

export interface DesktopKnowledgeGraphHighlight {
  query: string;
  entities: string[];
  relations: string[];
  communities: string[];
  docId: string;
  docName: string;
}

export interface DesktopKnowledgeGraphNode {
  id: string;
  label: string;
  type: string;
  raw: UnknownRecord;
}

export interface DesktopKnowledgeGraphEdge {
  id: string;
  title: string;
  sourceId: string;
  targetId: string;
  sourceLabel: string;
  targetLabel: string;
  predicate: string;
  confidenceLabel: string;
  evidenceCount: number;
  raw: UnknownRecord;
}

export interface DesktopKnowledgeGraphView {
  nodes: DesktopKnowledgeGraphNode[];
  edges: DesktopKnowledgeGraphEdge[];
  evidenceRows: DesktopKnowledgeEvidenceRow[];
}

export interface DesktopKnowledgeEvidenceRow {
  id: string;
  edgeId: string;
  sourceNodeId: string;
  targetNodeId: string;
  title: string;
  docName: string;
  location: string;
  meta: string;
  evidenceText: string;
  confidenceLabel: string;
  claimId: string;
  text?: string;
  contextText?: string;
}

export interface DesktopKnowledgeInspectionInput {
  kind: "claim" | "relation" | "conflict" | "projection";
  value: unknown;
  graphNodes?: unknown[];
}

export interface DesktopKnowledgeInspection {
  kind: DesktopKnowledgeInspectionInput["kind"];
  id: string;
  title: string;
  rows: Array<{ label: string; value: string }>;
  evidence: Array<{ title: string; meta: string; text: string; claimId?: string; contextText?: string }>;
}

export interface DesktopKnowledgePaneInput {
  statsPayload?: unknown;
  config?: unknown;
  documentsPayload?: unknown;
  selectedDocumentId?: string | null;
  queryDraft?: Partial<DesktopKnowledgeQueryRequestInput>;
  queryResultPayload?: unknown;
  graphPayload?: unknown;
}

export interface DesktopKnowledgePaneDocument extends DesktopKnowledgeDocumentRow {
  detail: string;
}

export interface DesktopKnowledgePaneReferenceRow {
  id: string;
  title: string;
  meta: string;
  text: string;
}

export interface DesktopKnowledgePaneGraph {
  view: DesktopKnowledgeGraphView;
  summary: string;
  communities: DesktopKnowledgePaneReferenceRow[];
  reports: DesktopKnowledgePaneReferenceRow[];
  claims: DesktopKnowledgePaneReferenceRow[];
  relations: DesktopKnowledgePaneReferenceRow[];
  conflicts: DesktopKnowledgePaneReferenceRow[];
  evidence: DesktopKnowledgeEvidenceRow[];
}

export interface DesktopKnowledgePaneModel {
  status: string;
  lastIndexedLabel: string;
  readiness: DesktopKnowledgeReadinessView;
  configHints: string[];
  documentRows: DesktopKnowledgeDocumentRow[];
  selectedDocument: DesktopKnowledgePaneDocument | null;
  query: {
    draft: Required<DesktopKnowledgeQueryRequestInput>;
    request: DesktopKnowledgeQueryRequest;
    results: DesktopKnowledgeQueryResultView;
  };
  graph: DesktopKnowledgePaneGraph;
  actions: {
    upload: boolean;
    deleteDocument: boolean;
    rebuild: boolean;
    query: boolean;
    refreshGraph: boolean;
  };
}

type UnknownRecord = Record<string, unknown>;

function asText(value: unknown): string {
  return String(value ?? "").trim();
}

function firstNonEmpty(...values: unknown[]): string {
  for (const value of values) {
    const text = asText(value);
    if (text) {
      return text;
    }
  }
  return "";
}

function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as UnknownRecord) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeKnowledgeQueryDraft(input: Partial<DesktopKnowledgeQueryRequestInput> = {}): Required<DesktopKnowledgeQueryRequestInput> {
  return {
    query: asText(input.query),
    mode: asText(input.mode) || "hybrid",
    topK: numberValue(input.topK) > 0 ? Math.trunc(numberValue(input.topK)) : 5,
  };
}

function buildKnowledgeConfigHints(configInput: unknown): string[] {
  const knowledge = asRecord(asRecord(configInput).knowledge);
  const enabled = knowledge.enabled !== false;
  const retrievalMode = firstNonEmpty(knowledge.retrieval_mode, knowledge.retrievalMode, "hybrid");
  const maxChunks = numberValue(knowledge.max_chunks ?? knowledge.maxChunks) || 5;
  const reportLlm = knowledge.graphrag_report_llm_enabled === true || knowledge.graphRagReportLlmEnabled === true;
  return [
    enabled ? "Knowledge enabled" : "Knowledge disabled",
    `Retrieval ${retrievalMode}`,
    `Max chunks ${maxChunks}`,
    reportLlm ? "GraphRAG reports use LLM summaries" : "GraphRAG reports use deterministic summaries",
  ];
}

function numberValue(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function booleanValue(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

function formatNumber(value: unknown): string {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(number >= 10 ? 0 : 3) : "";
}

function formatFileSize(value: unknown): string {
  const bytes = numberValue(value);
  if (bytes <= 0) {
    return "-";
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 2)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${Math.round(bytes)} B`;
}

function fileExtension(path: string): string {
  const match = path.match(/\.([a-z0-9]+)$/i);
  return match ? match[1].toUpperCase() : "";
}

function formatKnowledgeTimestamp(value: unknown): string {
  const text = asText(value);
  if (!text) {
    return "Not indexed";
  }
  const iso = text.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  if (iso) {
    return `${iso[1]} ${iso[2]}`;
  }
  return text;
}

function stageEntriesFor(stats: UnknownRecord, stages: string[]): UnknownRecord[] {
  const readiness = asRecord(stats.stage_readiness);
  const details = asArray(stats.stage_details).map(asRecord);
  const entries: UnknownRecord[] = [];
  for (const stage of stages) {
    if (readiness[stage]) {
      entries.push({ stage, ...asRecord(readiness[stage]) });
    }
  }
  for (const detail of details) {
    if (stages.includes(asText(detail.stage))) {
      entries.push(detail);
    }
  }
  return entries;
}

function summarizeStages(stats: UnknownRecord, stages: string[]) {
  const entries = stageEntriesFor(stats, stages);
  const statuses = entries.map((entry) => asText(entry.status)).filter(Boolean);
  const failed = entries.reduce((total, entry) => total + numberValue(entry.failed), 0);
  const stale = entries.reduce((total, entry) => total + numberValue(entry.stale), 0);
  const processed = entries.reduce((total, entry) => total + numberValue(entry.processed), 0);
  const total = entries.reduce((sum, entry) => sum + numberValue(entry.total), 0);
  let status = entries.length ? "pending" : "not_started";
  if (failed || statuses.includes("failed") || statuses.includes("partial_failed")) {
    status = "failed";
  } else if (stale || statuses.includes("stale")) {
    status = "stale";
  } else if (statuses.includes("budget_limited")) {
    status = "budget_limited";
  } else if (statuses.includes("partial") || statuses.includes("running")) {
    status = "partial";
  } else if (entries.length && statuses.every((item) => item === "complete" || item === "skipped")) {
    status = statuses.every((item) => item === "skipped") ? "skipped" : "complete";
  }
  return {
    status,
    ready: entries.length ? entries.every((entry) => booleanValue(entry.ready) || ["complete", "skipped"].includes(asText(entry.status))) : false,
    failed,
    stale,
    processed,
    total,
  };
}

function stageTone(status: string, ready = false): DesktopKnowledgeReadinessRow["tone"] {
  if (status === "failed") {
    return "error";
  }
  if (status === "stale" || status === "budget_limited" || status === "partial") {
    return "warn";
  }
  if (ready || status === "complete" || status === "skipped") {
    return "ready";
  }
  return "muted";
}

function stageStatusKey(status: string, ready = false): string {
  if (status === "failed") return "knowledge.stageStatusFailed";
  if (status === "stale") return "knowledge.stageStatusStale";
  if (status === "budget_limited") return "knowledge.stageStatusBudgetLimited";
  if (status === "partial") return "knowledge.stageStatusPartial";
  if (ready || status === "complete" || status === "skipped") return "knowledge.stageStatusReady";
  return "knowledge.stageStatusPending";
}

export function buildDesktopKnowledgeReadinessView(statsInput: unknown = {}): DesktopKnowledgeReadinessView {
  const stats = asRecord(statsInput);
  const docs = numberValue(stats.total_documents ?? stats.document_count);
  const chunks = numberValue(stats.total_chunks ?? stats.chunk_count);
  const entities = numberValue(stats.entity_count);
  const claims = numberValue(stats.claim_count);
  const relations = numberValue(stats.relation_count);
  const communities = numberValue(stats.community_count);
  const reports = numberValue(stats.community_report_count);
  const indexedDense = numberValue(stats.indexed_dense);
  const indexedSparse = numberValue(stats.indexed_sparse);
  const retrievalStages = summarizeStages(stats, ["dense_indexing", "sparse_indexing"]);
  const claimStages = summarizeStages(stats, ["claim_extraction", "claim_validation"]);
  const relationStages = summarizeStages(stats, ["relation_extraction", "relation_validation"]);
  const expansionStages = summarizeStages(stats, ["evidence_expansion"]);
  const graphStages = summarizeStages(stats, ["graph_projection", "community_report_projection"]);
  const retrievalReady = booleanValue(stats.retrieval_ready) || indexedDense > 0 || indexedSparse > 0;
  const claimsReady = booleanValue(stats.claims_ready) || claimStages.ready;
  const relationsReady = booleanValue(stats.relations_ready) || relationStages.ready;
  const graphReady = stats.graph_ready !== undefined && stats.graph_ready !== null ? booleanValue(stats.graph_ready) : graphStages.ready;
  const failedStageCount = stats.failed_stage_count !== undefined && stats.failed_stage_count !== null
    ? numberValue(stats.failed_stage_count)
    : [retrievalStages, claimStages, relationStages, expansionStages, graphStages].filter((stage) => stage.status === "failed").length;
  const staleStageCount = stats.stale_stage_count !== undefined && stats.stale_stage_count !== null
    ? numberValue(stats.stale_stage_count)
    : [retrievalStages, claimStages, relationStages, expansionStages, graphStages].filter((stage) => stage.status === "stale").length;
  const graphStatus = graphReady || ["failed", "stale", "budget_limited", "partial"].includes(graphStages.status)
    ? graphStages.status
    : "pending";
  const partialAvailability = booleanValue(stats.partial_availability)
    || Boolean(retrievalReady && (failedStageCount || staleStageCount || !claimsReady || !relationsReady || !graphReady));
  const checks = [
    docs > 0,
    chunks > 0,
    retrievalReady,
    claimsReady,
    relationsReady,
    expansionStages.ready || expansionStages.status === "skipped",
    graphReady,
  ];
  const score = Math.round((checks.filter(Boolean).length / checks.length) * 100);
  const titleKey = docs <= 0
    ? "knowledge.healthEmpty"
    : failedStageCount
      ? "knowledge.healthPartialFailed"
      : staleStageCount
        ? "knowledge.healthStale"
        : graphReady
          ? "knowledge.healthReady"
          : retrievalReady || partialAvailability
            ? "knowledge.healthSearchable"
            : "knowledge.healthNeedsSemantic";

  return {
    score,
    titleKey,
    descKey: docs ? "knowledge.healthDescTraceable" : "knowledge.healthDescEmpty",
    descReplacements: { docs, chunks, entities, claims, relations, communities, reports, failed: failedStageCount, stale: staleStageCount },
    partialAvailability,
    failedStageCount,
    staleStageCount,
    rows: [
      {
        id: "retrieval",
        titleKey: "knowledge.stageRetrieval",
        textKey: retrievalReady ? "knowledge.stageRetrievalReady" : "knowledge.stageRetrievalPending",
        replacements: { dense: indexedDense, sparse: indexedSparse },
        statusKey: stageStatusKey(retrievalStages.status, retrievalReady),
        tone: stageTone(retrievalStages.status, retrievalReady),
      },
      {
        id: "claims",
        titleKey: "knowledge.stageClaims",
        textKey: claimsReady ? "knowledge.stageClaimsReady" : "knowledge.stageClaimsPending",
        replacements: { claims },
        statusKey: stageStatusKey(claimStages.status, claimsReady),
        tone: stageTone(claimStages.status, claimsReady),
      },
      {
        id: "relations",
        titleKey: "knowledge.stageRelations",
        textKey: relationsReady ? "knowledge.stageRelationsReady" : "knowledge.stageRelationsPending",
        replacements: { relations },
        statusKey: stageStatusKey(relationStages.status, relationsReady),
        tone: stageTone(relationStages.status, relationsReady),
      },
      {
        id: "expansion",
        titleKey: "knowledge.stageEvidenceExpansion",
        textKey: expansionStages.status === "budget_limited"
          ? "knowledge.stageExpansionBudgetLimited"
          : expansionStages.status === "failed"
            ? "knowledge.stageExpansionFailed"
            : expansionStages.ready || expansionStages.status === "skipped"
              ? "knowledge.stageExpansionReady"
              : "knowledge.stageExpansionPending",
        replacements: { processed: expansionStages.processed, total: expansionStages.total },
        statusKey: stageStatusKey(expansionStages.status, expansionStages.ready),
        tone: stageTone(expansionStages.status, expansionStages.ready),
      },
      {
        id: "graph",
        titleKey: "knowledge.stageGraph",
        textKey: graphReady ? "knowledge.stageGraphReady" : "knowledge.stageGraphPending",
        replacements: { communities, reports },
        statusKey: stageStatusKey(graphStatus, graphReady),
        tone: stageTone(graphStatus, graphReady),
      },
    ],
  };
}

export function buildDesktopKnowledgePaneModel(input: DesktopKnowledgePaneInput = {}): DesktopKnowledgePaneModel {
  const readiness = buildDesktopKnowledgeReadinessView(input.statsPayload);
  const documentRows = buildDesktopKnowledgeDocumentRows(input.documentsPayload);
  const selectedDocumentRow = documentRows.find((document) => document.id === input.selectedDocumentId) ?? documentRows[0] ?? null;
  const graphPayload = normalizeKnowledgeGraphPayload(input.graphPayload);
  const graphView = buildDesktopKnowledgeGraphView(graphPayload);
  const queryDraft = normalizeKnowledgeQueryDraft(input.queryDraft);
  const request = buildDesktopKnowledgeQueryRequest(queryDraft);
  const edgeLabel = graphView.edges.length === 1 ? "edge" : "edges";

  return {
    status: `${documentRows.length} ${documentRows.length === 1 ? "doc" : "docs"} / readiness ${readiness.score}% / graph ${graphView.nodes.length} nodes / ${graphView.edges.length} ${edgeLabel}`,
    lastIndexedLabel: knowledgeLastIndexedLabel(input.statsPayload, documentRows),
    readiness,
    configHints: buildKnowledgeConfigHints(input.config),
    documentRows,
    selectedDocument: selectedDocumentRow
      ? {
          ...selectedDocumentRow,
          detail: [selectedDocumentRow.path, selectedDocumentRow.status, selectedDocumentRow.chunkCount ? `${selectedDocumentRow.chunkCount} chunks` : ""]
            .filter(Boolean)
            .join(" / "),
        }
      : null,
    query: {
      draft: queryDraft,
      request,
      results: buildDesktopKnowledgeQueryResultRows(input.queryResultPayload, { query: request.query }),
    },
    graph: buildDesktopKnowledgePaneGraph(graphPayload, graphView, edgeLabel),
    actions: {
      upload: true,
      deleteDocument: Boolean(selectedDocumentRow),
      rebuild: true,
      query: Boolean(request.query),
      refreshGraph: true,
    },
  };
}

function knowledgeLastIndexedLabel(statsPayload: unknown, documentRows: DesktopKnowledgeDocumentRow[]): string {
  const stats = asRecord(statsPayload);
  return formatKnowledgeTimestamp(
    stats.last_indexed_at
      ?? stats.lastIndexedAt
      ?? stats.last_indexed
      ?? documentRows.find((document) => document.addedLabel)?.addedLabel,
  );
}

export function buildDesktopKnowledgeDocumentRows(payload: unknown): DesktopKnowledgeDocumentRow[] {
  const root = asRecord(payload);
  const documents = Array.isArray(payload) ? payload : asArray(root.items).length ? asArray(root.items) : asArray(root.documents);
  return documents.map(asRecord).map((document, index) => {
    const id = firstNonEmpty(document.id, document.doc_id, document.path, index);
    const title = firstNonEmpty(document.title, document.name, document.path, id);
    const path = firstNonEmpty(document.path, document.file_path);
    const category = firstNonEmpty(document.category, document.type);
    const typeLabel = firstNonEmpty(category, document.mime_type, document.file_type, fileExtension(path), "DOC");
    const sizeLabel = formatFileSize(document.size_bytes ?? document.sizeBytes ?? document.file_size ?? document.size);
    const status = firstNonEmpty(document.status, document.index_status);
    const updatedAt = firstNonEmpty(document.updated_at, document.updatedAt, document.created_at, document.createdAt, document.modified_at);
    const addedLabel = formatKnowledgeTimestamp(updatedAt);
    const chunkCount = numberValue(document.chunk_count ?? document.chunks);
    const tags = asArray(document.tags).map(asText).filter(Boolean);
    const meta = [
      category,
      status,
      chunkCount ? `${chunkCount} chunks` : "",
      updatedAt,
    ].filter(Boolean).join(" / ");
    return { id, title, path, category, typeLabel, sizeLabel, addedLabel, tags, chunkCount, status, updatedAt, meta };
  });
}

export function buildDesktopKnowledgeTaskOperations(payloads: unknown[]): DesktopTaskSourceOperation[] {
  return payloads.map(buildDesktopKnowledgeTaskOperation).filter((operation): operation is DesktopTaskSourceOperation => Boolean(operation));
}

export function buildDesktopKnowledgeTaskOperation(payload: unknown): DesktopTaskSourceOperation | null {
  const root = asRecord(payload);
  const job = normalizeKnowledgeJobPayload(root);
  const id = firstNonEmpty(job.id, root.job_id, root.id);
  if (!id) {
    return null;
  }
  const name = firstNonEmpty(job.name, root.name, root.title, root.type);
  const docId = firstNonEmpty(job.doc_id, root.doc_id, root.id);
  const stage = firstNonEmpty(job.stage);
  const message = firstNonEmpty(job.message, root.message);
  const processed = numberValue(job.processed ?? job.completed);
  const total = numberValue(job.total);
  const sourceTitle = firstNonEmpty(job.source_title, job.doc_name, job.document_name, root.source_title, root.doc_name, root.document_name, name, docId);
  const sourceDetail = firstNonEmpty(job.source_path, job.path, job.file_path, root.source_path, root.path, root.file_path, stage);
  const diagnostics = firstNonEmpty(job.error, root.error);
  return {
    id: `knowledge:${id}`,
    title: knowledgeTaskTitle(name),
    status: firstNonEmpty(job.status, root.status, stage, "indexing"),
    detail: [message, stage].filter(Boolean).join(" / "),
    progress: total ? { completed: processed, total } : undefined,
    canonical: { module: "knowledge", entityId: docId || id, href: "/knowledge" },
    diagnostics,
    relatedResources: sourceTitle ? [
      {
        kind: "evidence",
        id: `knowledge-source:${docId || id}`,
        title: sourceTitle,
        detail: sourceDetail,
        route: { module: "knowledge", entityId: docId || id, href: "/knowledge" },
      },
    ] : [],
    outputs: diagnostics ? [
      {
        kind: "diagnostic",
        id: `knowledge-diagnostic:${id}`,
        title: "Knowledge diagnostics",
        detail: diagnostics,
        route: { module: "knowledge", entityId: docId || id, href: "/knowledge" },
      },
    ] : [],
    retryable: false,
    updatedAt: firstNonEmpty(job.updated_at, job.updatedAt, root.updated_at, root.updatedAt),
  };
}

export function buildDesktopKnowledgeUploadTaskOperation(fileName: string): DesktopTaskSourceOperation {
  const name = firstNonEmpty(fileName, "knowledge document");
  return {
    id: `knowledge:upload:${name}`,
    title: `Upload ${name}`,
    status: "uploading",
    detail: "Uploading knowledge document",
    progress: { completed: 0, total: 1 },
    canonical: { module: "knowledge", entityId: name, href: "/knowledge" },
    diagnostics: "",
    retryable: false,
    updatedAt: "",
  };
}

function normalizeKnowledgeJobPayload(root: UnknownRecord): UnknownRecord {
  const directJob = asRecord(root.job);
  if (Object.keys(directJob).length) {
    return directJob;
  }
  const data = asRecord(root.data);
  const dataJob = asRecord(data.job);
  if (Object.keys(dataJob).length) {
    return dataJob;
  }
  if (Object.keys(data).length) {
    return data;
  }
  return root;
}

function knowledgeTaskTitle(name: string): string {
  if (name.startsWith("rebuild:")) {
    return "Rebuild knowledge index";
  }
  return `Index ${name || "knowledge document"}`;
}

export function buildDesktopKnowledgeQueryRequest(input: DesktopKnowledgeQueryRequestInput): DesktopKnowledgeQueryRequest {
  return {
    query: input.query.trim(),
    mode: input.mode || "hybrid",
    top_k: input.topK && input.topK > 0 ? Math.trunc(input.topK) : 5,
  };
}

export function buildDesktopKnowledgeQueryResultRows(resultInput: unknown, options: { query?: string } = {}): DesktopKnowledgeQueryResultView {
  const result = asRecord(resultInput);
  const items = asArray(result.data).map(asRecord);
  const rows = items.map((item, index) => buildQueryResultRow(item, options.query || asText(result.query), index));
  return {
    summary: {
      count: rows.length,
      docs: Array.from(new Set(rows.map((row) => row.docName).filter(Boolean))).slice(0, 3),
      lowConfidence: rows.length > 0 && rows.every((row) => row.relevance === "low"),
    },
    rows,
  };
}

function buildQueryResultRow(item: UnknownRecord, query: string, index: number): DesktopKnowledgeQueryResultRow {
  const docId = firstNonEmpty(item.doc_id, item.document_id);
  const docName = firstNonEmpty(item.doc_name, item.document_name, "unknown");
  const methods = asArray(item.matched_methods).length ? asArray(item.matched_methods).map(asText).filter(Boolean).join("+") : firstNonEmpty(item.method, "unknown");
  const lineText = item.line_start && item.line_end ? `L${item.line_start}-${item.line_end}` : "";
  const meta = [methods, item.rerank_model ? `rerank ${asText(item.rerank_model)}` : "", item.section_path, lineText, item.block_type]
    .map(asText)
    .filter(Boolean)
    .join(" / ");
  return {
    id: `${docId || docName}:${index}`,
    docName,
    content: asText(item.content),
    relevance: knowledgeRelevanceLevel(item),
    scoreLabel: formatKnowledgeScore(item),
    meta,
    why: queryResultWhyMatched(item),
    traceabilitySections: buildTraceabilitySections(item),
    graphHighlight: {
      query,
      entities: asArray(item.matched_entities).map(asText).filter(Boolean),
      relations: asArray(item.matched_relations).map(asText).filter(Boolean),
      communities: asArray(item.matched_communities).map(asText).filter(Boolean),
      docId,
      docName,
    },
    raw: item,
  };
}

function buildTraceabilitySections(item: UnknownRecord): DesktopKnowledgeTraceabilitySection[] {
  const sections: DesktopKnowledgeTraceabilitySection[] = [];
  const sourceSnippets = asArray(item.source_snippets).map(asRecord);
  const claimEvidence = asArray(item.matched_claim_evidence).map(asRecord);
  const relationEvidence = asArray(item.matched_relation_evidence).map(asRecord);
  const conflictMetadata = asArray(item.conflict_metadata).map(asRecord);
  if (sourceSnippets.length) {
    sections.push({
      kind: "source",
      title: "Source evidence",
      rows: sourceSnippets.slice(0, 4).map((snippet, index) => {
        const claim = buildClaimInspection({ source: snippet, text: firstNonEmpty(snippet.text, snippet.evidence_text) });
        return {
          id: `source:${index}`,
          edgeId: "",
          sourceNodeId: "",
          targetNodeId: "",
          title: claim.sourceTitle,
          docName: claim.sourceTitle,
          location: "",
          meta: claim.sourceMeta,
          evidenceText: claim.evidenceText,
          text: claim.evidenceText,
          confidenceLabel: claim.confidenceLabel,
          claimId: "",
        };
      }),
    });
  }
  if (claimEvidence.length) {
    sections.push({
      kind: "claims",
      title: "Claim evidence",
      rows: claimEvidence.slice(0, 5).map((claim) => {
        const view = buildClaimInspection(claim);
        return {
          id: view.id,
          edgeId: "",
          sourceNodeId: "",
          targetNodeId: "",
          title: view.title,
          docName: view.sourceTitle,
          location: "",
          meta: [view.sourceTitle, view.sourceMeta, view.status ? `status ${view.status}` : ""].filter(Boolean).join(" / "),
          evidenceText: view.evidenceText,
          text: view.evidenceText,
          confidenceLabel: view.confidenceLabel,
          claimId: view.id,
        };
      }),
    });
  }
  if (relationEvidence.length) {
    sections.push({
      kind: "relations",
      title: "Relation evidence",
      rows: relationEvidence.slice(0, 5).map((relation, index) => {
        const view = buildRelationInspection({
          ...relation,
          source: relation.subject_entity_id,
          target: relation.object_entity_id,
          evidence: relation.evidence ? relation.evidence : [{ ...relation, text: relation.evidence_text }],
          supporting_claim_ids: relation.claim_ids,
        });
        const evidence = view.evidence[0];
        return {
          id: firstNonEmpty(relation.id, `relation:${index}`),
          edgeId: firstNonEmpty(relation.id),
          sourceNodeId: firstNonEmpty(relation.subject_entity_id),
          targetNodeId: firstNonEmpty(relation.object_entity_id),
          title: view.title,
          docName: evidence?.title || "",
          location: "",
          meta: [view.predicate, view.confidenceLabel ? `confidence ${view.confidenceLabel}` : ""].filter(Boolean).join(" / "),
          evidenceText: evidence?.text || firstNonEmpty(relation.evidence_text),
          text: evidence?.text || firstNonEmpty(relation.evidence_text),
          confidenceLabel: view.confidenceLabel,
          claimId: view.supportingClaimIds[0] || "",
        };
      }),
    });
  }
  if (conflictMetadata.length) {
    sections.push({
      kind: "conflicts",
      title: "Conflict evidence",
      rows: conflictMetadata.slice(0, 5).map((conflict, index) => {
        const view = buildConflictInspection(conflict);
        return {
          id: view.id || `conflict:${index}`,
          edgeId: "",
          sourceNodeId: "",
          targetNodeId: "",
          title: view.title,
          docName: view.sides[0]?.sourceTitle || "",
          location: "",
          meta: [view.type, view.status, view.confidenceLabel ? `confidence ${view.confidenceLabel}` : ""].filter(Boolean).join(" / "),
          evidenceText: view.sides.map((side) => side.evidenceText).filter(Boolean).join("\n"),
          confidenceLabel: view.confidenceLabel,
          claimId: "",
        };
      }),
    });
  }
  return sections;
}

export function buildDesktopKnowledgeGraphView(graphInput: unknown): DesktopKnowledgeGraphView {
  const graph = asRecord(normalizeKnowledgeGraphPayload(graphInput));
  const nodes = asArray(graph.nodes).map(asRecord).map((node) => ({
    id: firstNonEmpty(node.id),
    label: firstNonEmpty(node.label, node.canonical_name, node.title, node.id),
    type: firstNonEmpty(node.type, node.kind),
    raw: node,
  }));
  const edges = asArray(graph.edges).map(asRecord).map((edge) => {
    const relation = buildRelationInspection(edge, nodes.map((node) => node.raw));
    return {
      id: firstNonEmpty(edge.id, `${edge.source}:${edge.predicate}:${edge.target}`),
      title: relation.title,
      sourceId: firstNonEmpty(edge.source),
      targetId: firstNonEmpty(edge.target),
      sourceLabel: nodeLabel(nodes.map((node) => node.raw), firstNonEmpty(edge.source)),
      targetLabel: nodeLabel(nodes.map((node) => node.raw), firstNonEmpty(edge.target)),
      predicate: relation.predicate,
      confidenceLabel: relation.confidenceLabel,
      evidenceCount: asArray(edge.evidence || edge.source_refs).length,
      raw: edge,
    };
  });
  return {
    nodes,
    edges,
    evidenceRows: asArray(graph.edges).map(asRecord).flatMap((edge) => knowledgeEvidenceRowsForEdge(edge, nodes.map((node) => node.raw))),
  };
}

function normalizeKnowledgeGraphPayload(graphInput: unknown): UnknownRecord {
  const graph = asRecord(graphInput);
  if (graph.object !== "graphrag_index") {
    return graph;
  }
  const documents = new Map(asArray(graph.documents).map(asRecord).map((document) => [
    firstNonEmpty(document.id),
    document,
  ]));
  const textUnits = new Map(asArray(graph.text_units).map(asRecord).map((unit) => [
    firstNonEmpty(unit.id),
    unit,
  ]));
  const claims = new Map(asArray(graph.covariates).map(asRecord).map((claim) => [
    firstNonEmpty(claim.id),
    claim,
  ]));
  const entities = asArray(graph.entities).map(asRecord);
  const entityNodes = entities.map((entity) => ({
    ...entity,
    id: firstNonEmpty(entity.id, entity.title),
    label: firstNonEmpty(entity.title, entity.label, entity.id),
    canonical_name: firstNonEmpty(entity.title, entity.canonical_name, entity.id),
    type: firstNonEmpty(entity.type, "concept"),
  }));
  const entityByLabel = new Map<string, UnknownRecord>();
  for (const entity of entityNodes) {
    entityByLabel.set(firstNonEmpty(entity.id), entity);
    entityByLabel.set(firstNonEmpty(entity.label), entity);
    entityByLabel.set(firstNonEmpty(entity.canonical_name), entity);
  }
  const edges = asArray(graph.relationships).map(asRecord).map((relationship) => {
    const source = entityByLabel.get(firstNonEmpty(relationship.source));
    const target = entityByLabel.get(firstNonEmpty(relationship.target));
    const evidence = asArray(relationship.text_unit_ids).map(asText).filter(Boolean).map((textUnitId) => {
      const textUnit = textUnits.get(textUnitId) ?? {};
      const document = documents.get(firstNonEmpty(textUnit.document_id)) ?? {};
      const claimId = asArray(textUnit.covariate_ids).map(asText).filter(Boolean)[0] || "";
      const claim = claims.get(claimId) ?? {};
      return {
        relation_id: firstNonEmpty(relationship.id),
        claim_id: claimId,
        chunk_id: textUnitId,
        doc_id: firstNonEmpty(textUnit.document_id),
        doc_name: firstNonEmpty(document.title, textUnit.document_id),
        line_start: textUnit.line_start,
        line_end: textUnit.line_end,
        page: textUnit.page,
        section_path: textUnit.section_path,
        text: firstNonEmpty(claim.source_text, claim.description, claim.text, relationship.description, textUnit.text),
        confidence: relationship.confidence,
      };
    });
    return {
      ...relationship,
      id: firstNonEmpty(relationship.id, `${source?.id || relationship.source}:${relationship.predicate}:${target?.id || relationship.target}`),
      source: firstNonEmpty(source?.id, relationship.source),
      target: firstNonEmpty(target?.id, relationship.target),
      predicate: firstNonEmpty(relationship.predicate, "related_to"),
      confidence: relationship.confidence,
      confidence_avg: relationship.confidence,
      weight: relationship.weight,
      evidence,
    };
  });
  return {
    ...graph,
    nodes: entityNodes,
    edges,
    reports: asArray(graph.community_reports),
    claims: asArray(graph.covariates),
  };
}

function buildDesktopKnowledgePaneGraph(
  graphPayload: unknown,
  view: DesktopKnowledgeGraphView,
  edgeLabel: string,
): DesktopKnowledgePaneGraph {
  return {
    view,
    summary: `${view.nodes.length} nodes / ${view.edges.length} ${edgeLabel} / ${view.evidenceRows.length} evidence`,
    communities: buildKnowledgeReferenceRows(graphPayload, "communities", "community"),
    reports: buildKnowledgeReferenceRows(graphPayload, "reports", "report"),
    claims: buildKnowledgeClaimReferenceRows(graphPayload),
    relations: view.edges.map((edge) => ({
      id: edge.id,
      title: edge.title,
      meta: [edge.predicate, edge.confidenceLabel ? `confidence ${edge.confidenceLabel}` : "", `${edge.evidenceCount} evidence`]
        .filter(Boolean)
        .join(" / "),
      text: firstNonEmpty(edge.raw.description, edge.raw.summary),
    })),
    conflicts: buildKnowledgeConflictReferenceRows(graphPayload),
    evidence: view.evidenceRows,
  };
}

function buildKnowledgeReferenceRows(
  payload: unknown,
  key: "communities" | "reports",
  fallbackMeta: string,
): DesktopKnowledgePaneReferenceRow[] {
  return asArray(asRecord(payload)[key]).map(asRecord).map((item, index) => {
    const id = firstNonEmpty(item.id, item.community_id, item.community, `${fallbackMeta}:${index}`);
    return {
      id,
      title: firstNonEmpty(item.title, item.name, item.label, id),
      meta: firstNonEmpty(item.type, item.kind, fallbackMeta),
      text: firstNonEmpty(item.summary, item.description, item.text),
    };
  });
}

function buildKnowledgeClaimReferenceRows(payload: unknown): DesktopKnowledgePaneReferenceRow[] {
  return asArray(asRecord(payload).claims).map(asRecord).map((claim, index) => {
    const inspection = buildDesktopKnowledgeTraceabilityInspection({ kind: "claim", value: claim });
    return {
      id: inspection.id || `claim:${index}`,
      title: inspection.title,
      meta: inspection.rows.map((row) => `${row.label} ${row.value}`).join(" / "),
      text: inspection.evidence[0]?.text || "",
    };
  });
}

function buildKnowledgeConflictReferenceRows(payload: unknown): DesktopKnowledgePaneReferenceRow[] {
  return asArray(asRecord(payload).conflicts).map(asRecord).map((conflict, index) => {
    const inspection = buildDesktopKnowledgeTraceabilityInspection({ kind: "conflict", value: conflict });
    return {
      id: inspection.id || `conflict:${index}`,
      title: inspection.title,
      meta: inspection.rows.map((row) => `${row.label} ${row.value}`).join(" / "),
      text: inspection.evidence.map((item) => item.text).filter(Boolean).join("\n"),
    };
  });
}

export function buildDesktopKnowledgeTraceabilityInspection(input: DesktopKnowledgeInspectionInput): DesktopKnowledgeInspection {
  if (input.kind === "relation") {
    const relation = buildRelationInspection(asRecord(input.value), input.graphNodes || []);
    return {
      kind: "relation",
      id: "",
      title: relation.title,
      rows: [
        { label: "Endpoints", value: relation.endpoints },
        { label: "Predicate", value: relation.predicate },
        { label: "Confidence", value: relation.confidenceLabel },
        { label: "Weight", value: relation.weightLabel },
      ].filter((row) => row.value),
      evidence: relation.evidence,
    };
  }
  if (input.kind === "claim") {
    const claim = buildClaimInspection(asRecord(input.value));
    return {
      kind: "claim",
      id: claim.id,
      title: claim.title,
      rows: [
        { label: "Status", value: claim.status },
        { label: "Confidence", value: claim.confidenceLabel },
        { label: "Source", value: claim.sourceTitle },
        { label: "Location", value: claim.sourceMeta },
      ].filter((row) => row.value),
      evidence: [{ title: claim.sourceTitle, meta: claim.sourceMeta, text: claim.evidenceText, claimId: claim.id, contextText: claim.sourceContextText }],
    };
  }
  if (input.kind === "conflict") {
    const conflict = buildConflictInspection(asRecord(input.value));
    return {
      kind: "conflict",
      id: conflict.id,
      title: conflict.title,
      rows: [
        { label: "Type", value: conflict.type },
        { label: "Status", value: conflict.status },
        { label: "Confidence", value: conflict.confidenceLabel },
      ].filter((row) => row.value),
      evidence: conflict.sides.map((side) => ({
        title: side.label,
        meta: [side.sourceTitle, side.sourceMeta].filter(Boolean).join(" / "),
        text: side.evidenceText,
        contextText: side.contextText,
      })),
    };
  }
  const projection = buildProjectionInspection(asRecord(input.value));
  return {
    kind: "projection",
    id: projection.id,
    title: projection.title,
    rows: [
      { label: "Type", value: projection.type },
      { label: "Status", value: projection.status },
      { label: "Community", value: projection.communityLabel },
      { label: "Rank", value: projection.rankLabel },
    ].filter((row) => row.value),
    evidence: projection.sources,
  };
}

function sourceFromEvidence(item: UnknownRecord): UnknownRecord {
  const nested = asRecord(item.source);
  return {
    ...item,
    ...nested,
    evidence_text: firstNonEmpty(nested.evidence_text, item.evidence_text, item.text, item.source_text),
    doc_name: firstNonEmpty(nested.doc_name, item.doc_name),
    doc_id: firstNonEmpty(nested.doc_id, item.doc_id),
    chunk_id: firstNonEmpty(nested.chunk_id, item.chunk_id),
    confidence: nested.confidence ?? item.confidence,
    context_text: firstNonEmpty(
      nested.context_text,
      nested.surrounding_text,
      nested.chunk_text,
      item.context_text,
      item.surrounding_text,
      item.chunk_text,
      item.source_context,
    ),
  };
}

function buildSourceContext(sourceInput: UnknownRecord) {
  const normalized = sourceFromEvidence(sourceInput);
  const locationParts = [];
  if (normalized.line_start) {
    locationParts.push(`L${normalized.line_start}-L${normalized.line_end || normalized.line_start}`);
  }
  if (normalized.page != null && normalized.page !== "") {
    locationParts.push(`p.${normalized.page}`);
  }
  if (!normalized.line_start && normalized.start_char != null && normalized.end_char != null) {
    locationParts.push(`chars ${normalized.start_char}-${normalized.end_char}`);
  }
  if (normalized.chunk_id) {
    locationParts.push(asText(normalized.chunk_id));
  }
  const confidence = formatNumber(normalized.confidence);
  const metaParts = [...locationParts];
  if (normalized.extraction_method) {
    metaParts.push(asText(normalized.extraction_method));
  }
  if (confidence) {
    metaParts.push(`confidence ${confidence}`);
  }
  return {
    title: firstNonEmpty(normalized.doc_name, normalized.doc_id, "Unknown source"),
    location: locationParts.join(" / "),
    meta: metaParts.join(" / "),
    contextText: asText(normalized.context_text),
  };
}

function nodeLabel(nodesInput: unknown[], nodeId: string): string {
  const node = nodesInput.map(asRecord).find((item) => item.id === nodeId);
  return firstNonEmpty(node?.label, node?.canonical_name, node?.title, nodeId);
}

function relationTitle(edge: UnknownRecord, nodes: unknown[] = []): string {
  const source = nodeLabel(nodes, asText(edge.source));
  const target = nodeLabel(nodes, asText(edge.target));
  const predicate = firstNonEmpty(edge.predicate, "related_to");
  return `${source} -[${predicate}]-> ${target}`;
}

function knowledgeEvidenceRowsForEdge(edge: UnknownRecord, nodes: unknown[] = []): DesktopKnowledgeEvidenceRow[] {
  return asArray(edge.evidence).map(asRecord).map((item, index) => {
    const source = sourceFromEvidence(item);
    const context = buildSourceContext(source);
    return {
      id: firstNonEmpty(item.id, `${edge.id || ""}:${item.claim_id || ""}:${source.chunk_id || ""}:${index}`),
      edgeId: firstNonEmpty(edge.id, item.relation_id, `${edge.source}:${edge.predicate}:${edge.target}`),
      sourceNodeId: firstNonEmpty(edge.source),
      targetNodeId: firstNonEmpty(edge.target),
      title: relationTitle(edge, nodes),
      docName: context.title,
      location: context.location,
      meta: context.meta,
      evidenceText: firstNonEmpty(source.evidence_text, item.text),
      confidenceLabel: formatNumber(source.confidence),
      claimId: firstNonEmpty(item.claim_id),
    };
  });
}

function buildRelationInspection(edge: UnknownRecord, nodes: unknown[] = []) {
  const source = nodeLabel(nodes, asText(edge.source));
  const target = nodeLabel(nodes, asText(edge.target));
  return {
    title: relationTitle(edge, nodes),
    predicate: firstNonEmpty(edge.predicate, "related_to"),
    endpoints: `${source} -> ${target}`,
    confidenceLabel: formatNumber(edge.confidence ?? edge.confidence_avg),
    weightLabel: formatNumber(edge.weight ?? edge.count),
    supportingClaimIds: asArray(edge.supporting_claim_ids || edge.claim_ids).map(asText).filter(Boolean),
    evidence: asArray(edge.evidence || edge.source_refs).map(asRecord).map((item) => {
      const sourceEvidence = sourceFromEvidence(item);
      const context = buildSourceContext(sourceEvidence);
      return {
        title: context.title,
        meta: context.meta,
        text: firstNonEmpty(sourceEvidence.evidence_text, item.text),
        claimId: firstNonEmpty(item.claim_id),
        contextText: context.contextText || undefined,
      };
    }),
  };
}

function buildClaimInspection(claim: UnknownRecord) {
  const source = sourceFromEvidence(asRecord(claim.source) || claim);
  const context = buildSourceContext(source);
  return {
    id: firstNonEmpty(claim.id),
    title: firstNonEmpty(claim.text, claim.evidence_text, source.evidence_text, "Claim"),
    status: firstNonEmpty(claim.status),
    confidenceLabel: formatNumber(claim.confidence ?? source.confidence),
    sourceTitle: context.title,
    sourceMeta: context.meta,
    evidenceText: firstNonEmpty(source.evidence_text, claim.text),
    sourceContextText: context.contextText || undefined,
  };
}

function conflictSide(label: string, recordType: string, recordId: string, sourceInput: UnknownRecord) {
  const normalized = sourceFromEvidence(sourceInput);
  const context = buildSourceContext(normalized);
  return {
    label: `${label} ${recordType || "record"} ${recordId || ""}`.trim(),
    sourceTitle: context.title,
    sourceMeta: context.meta,
    evidenceText: firstNonEmpty(normalized.evidence_text, sourceInput.text),
    contextText: context.contextText || undefined,
  };
}

function buildConflictInspection(conflict: UnknownRecord) {
  const sources = asArray(conflict.sources).map(asRecord);
  const leftType = firstNonEmpty(conflict.left_record_type, "record");
  const leftId = firstNonEmpty(conflict.left_record_id);
  const rightType = firstNonEmpty(conflict.right_record_type, "record");
  const rightId = firstNonEmpty(conflict.right_record_id);
  return {
    id: firstNonEmpty(conflict.id),
    title: `${leftType} ${leftId || "left"} conflicts with ${rightType} ${rightId || "right"}`,
    type: firstNonEmpty(conflict.conflict_type),
    status: firstNonEmpty(conflict.status),
    confidenceLabel: formatNumber(conflict.confidence),
    sides: [
      conflictSide("Left", leftType, leftId, sources[0] || asRecord(conflict.left_source)),
      conflictSide("Right", rightType, rightId, sources[1] || asRecord(conflict.right_source)),
    ],
  };
}

function buildProjectionInspection(projection: UnknownRecord) {
  const type = firstNonEmpty(projection.projection_type, projection.type, "projection");
  const community = projection.community ?? projection.community_id;
  return {
    id: firstNonEmpty(projection.id),
    title: firstNonEmpty(projection.title, projection.name, projection.summary, type),
    type,
    status: firstNonEmpty(projection.projection_status, projection.status),
    communityLabel: community == null || community === "" ? "" : `Community ${community}`,
    rankLabel: formatNumber(projection.rank ?? projection.rating),
    sources: asArray(projection.source_refs || projection.sources || projection.evidence || projection.supporting_sources)
      .map(asRecord)
      .map((item) => {
        const source = sourceFromEvidence(item);
        const context = buildSourceContext(source);
        return {
          title: context.title,
          meta: context.meta,
          text: firstNonEmpty(source.evidence_text, item.text),
          claimId: firstNonEmpty(item.claim_id),
          contextText: context.contextText || undefined,
        };
      }),
  };
}

function knowledgeNumericScore(item: UnknownRecord): number {
  if (item.rerank_score != null) return Number(item.rerank_score);
  if (item.rrf_score != null) return Number(item.rrf_score);
  if (item.semantic_fusion_score != null) return Number(item.semantic_fusion_score);
  if (item.semantic_score != null) return Number(item.semantic_score);
  if (item.bm25_score != null) return Number(item.bm25_score);
  if (item.score != null) return Number(item.score);
  return 0;
}

function knowledgeRelevanceLevel(item: UnknownRecord): DesktopKnowledgeQueryResultRow["relevance"] {
  if (item.rerank_score != null) {
    return Number(item.rerank_score) >= 0.35 ? "high" : "low";
  }
  if (item.dense_distance != null && knowledgeNumericScore(item) <= 0) {
    return Number(item.dense_distance) <= 0.65 ? "medium" : "low";
  }
  const score = knowledgeNumericScore(item);
  if (score >= 0.5) return "high";
  if (score >= 0.18) return "medium";
  return "low";
}

function formatKnowledgeScore(item: UnknownRecord): string {
  if (item.rerank_score != null) return `rerank ${Number(item.rerank_score).toFixed(4)}`;
  if (item.rrf_score != null) return `rrf ${Number(item.rrf_score).toFixed(4)}`;
  if (item.semantic_fusion_score != null) return `graph ${Number(item.semantic_fusion_score).toFixed(4)}`;
  if (item.semantic_score != null) return `semantic ${Number(item.semantic_score).toFixed(3)}`;
  if (item.bm25_score != null) return `bm25 ${Number(item.bm25_score).toFixed(3)}`;
  if (item.dense_distance != null) return `dist ${Number(item.dense_distance).toFixed(3)}`;
  return `${Number(item.score || 0).toFixed(3)}`;
}

function queryResultWhyMatched(item: UnknownRecord): string {
  const reasons = [];
  if (item.section_path) {
    reasons.push(`section ${item.section_path}`);
  }
  const entities = asArray(item.matched_entities).map(asText).filter(Boolean);
  if (entities.length) {
    reasons.push(`entities ${entities.slice(0, 3).join(", ")}`);
  }
  const methods = asArray(item.matched_methods).length ? asArray(item.matched_methods).map(asText).filter(Boolean).join("+") : asText(item.method);
  if (methods) {
    reasons.push(`method ${methods}`);
  }
  if (item.content) {
    reasons.push("content match");
  }
  return `Matched by ${reasons.slice(0, 3).join("; ") || "available context"}`;
}
