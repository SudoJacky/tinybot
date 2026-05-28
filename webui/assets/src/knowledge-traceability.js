function asText(value) {
  return String(value ?? "").trim();
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = asText(value);
    if (text) {
      return text;
    }
  }
  return "";
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function formatNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(number >= 10 ? 0 : 3) : "";
}

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function booleanValue(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

function stageEntriesFor(stats = {}, stages = []) {
  const readiness = stats.stage_readiness && typeof stats.stage_readiness === "object"
    ? stats.stage_readiness
    : {};
  const details = asArray(stats.stage_details);
  const entries = [];
  for (const stage of stages) {
    if (readiness[stage]) {
      entries.push({ stage, ...readiness[stage] });
    }
  }
  for (const detail of details) {
    if (stages.includes(detail?.stage)) {
      entries.push(detail);
    }
  }
  return entries;
}

function summarizeStages(stats = {}, stages = []) {
  const entries = stageEntriesFor(stats, stages);
  const statuses = entries.map((entry) => asText(entry.status)).filter(Boolean);
  const failed = entries.reduce((total, entry) => total + numberValue(entry.failed), 0);
  const stale = entries.reduce((total, entry) => total + numberValue(entry.stale), 0);
  const processed = entries.reduce((total, entry) => total + numberValue(entry.processed), 0);
  const total = entries.reduce((sum, entry) => sum + numberValue(entry.total), 0);
  const lastError = firstNonEmpty(...entries.map((entry) => entry.last_error));

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
    lastError,
  };
}

function stageTone(status, ready = false) {
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

function stageStatusKey(status, ready = false) {
  if (status === "failed") return "knowledge.stageStatusFailed";
  if (status === "stale") return "knowledge.stageStatusStale";
  if (status === "budget_limited") return "knowledge.stageStatusBudgetLimited";
  if (status === "partial") return "knowledge.stageStatusPartial";
  if (ready || status === "complete" || status === "skipped") return "knowledge.stageStatusReady";
  return "knowledge.stageStatusPending";
}

export function buildKnowledgeReadinessView(stats = {}) {
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
  const graphReady = booleanValue(stats.graph_ready) || graphStages.ready;
  const failedStageCount = numberValue(stats.failed_stage_count)
    + [retrievalStages, claimStages, relationStages, expansionStages, graphStages].filter((stage) => stage.status === "failed").length;
  const staleStageCount = numberValue(stats.stale_stage_count)
    + [retrievalStages, claimStages, relationStages, expansionStages, graphStages].filter((stage) => stage.status === "stale").length;
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
    descReplacements: {
      docs,
      chunks,
      entities,
      claims,
      relations,
      communities,
      reports,
      failed: failedStageCount,
      stale: staleStageCount,
    },
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
        statusKey: stageStatusKey(graphStages.status, graphReady),
        tone: stageTone(graphStages.status, graphReady),
      },
    ],
  };
}

function sourceFromEvidence(item = {}) {
  const nested = item.source && typeof item.source === "object" ? item.source : {};
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

export function buildKnowledgeSourceContext(source = {}) {
  const normalized = sourceFromEvidence(source);
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
    locationParts.push(normalized.chunk_id);
  }

  const metaParts = [...locationParts];
  if (normalized.extraction_method) {
    metaParts.push(normalized.extraction_method);
  }
  const confidence = formatNumber(normalized.confidence);
  if (confidence) {
    metaParts.push(`confidence ${confidence}`);
  }

  const result = {
    title: firstNonEmpty(normalized.doc_name, normalized.doc_id, "Unknown source"),
    location: locationParts.join(" / "),
    meta: metaParts.join(" / "),
  };
  if (normalized.context_text) {
    result.contextText = normalized.context_text;
    result.hasContext = true;
  }
  return result;
}

function nodeLabel(nodes = [], nodeId = "") {
  const node = asArray(nodes).find((item) => item?.id === nodeId);
  return firstNonEmpty(node?.label, node?.canonical_name, node?.title, nodeId);
}

function relationTitle(edge = {}, nodes = []) {
  const source = nodeLabel(nodes, edge.source);
  const target = nodeLabel(nodes, edge.target);
  const predicate = firstNonEmpty(edge.predicate, "related_to");
  return `${source} -[${predicate}]-> ${target}`;
}

export function knowledgeEvidenceRowsForEdge(edge = {}, nodes = []) {
  return asArray(edge.evidence).map((item, index) => {
    const source = sourceFromEvidence(item);
    const context = buildKnowledgeSourceContext(source);
    return {
      id: firstNonEmpty(
        item.id,
        `${edge.id || ""}:${item.claim_id || ""}:${source.chunk_id || ""}:${index}`,
      ),
      edgeId: firstNonEmpty(edge.id, item.relation_id, `${edge.source}:${edge.predicate}:${edge.target}`),
      sourceNodeId: firstNonEmpty(edge.source),
      targetNodeId: firstNonEmpty(edge.target),
      title: relationTitle(edge, nodes),
      docName: context.title,
      location: context.location,
      evidenceText: firstNonEmpty(source.evidence_text, item.text),
      confidenceLabel: formatNumber(source.confidence),
      claimId: firstNonEmpty(item.claim_id),
    };
  });
}

export function buildKnowledgeRelationInspection(edge = {}, nodes = []) {
  const source = nodeLabel(nodes, edge.source);
  const target = nodeLabel(nodes, edge.target);
  return {
    title: relationTitle(edge, nodes),
    predicate: firstNonEmpty(edge.predicate, "related_to"),
    endpoints: `${source} -> ${target}`,
    confidenceLabel: formatNumber(edge.confidence ?? edge.confidence_avg),
    weightLabel: formatNumber(edge.weight ?? edge.count),
    supportingClaimIds: asArray(edge.supporting_claim_ids || edge.claim_ids).map(asText).filter(Boolean),
    evidence: asArray(edge.evidence || edge.source_refs).map((item) => {
      const sourceEvidence = sourceFromEvidence(item);
      const context = buildKnowledgeSourceContext(sourceEvidence);
      const row = {
        title: context.title,
        meta: context.meta,
        text: firstNonEmpty(sourceEvidence.evidence_text, item.text),
        claimId: firstNonEmpty(item.claim_id),
      };
      if (context.contextText) {
        row.contextText = context.contextText;
      }
      return row;
    }),
  };
}

export function buildKnowledgeClaimInspection(claim = {}) {
  const source = sourceFromEvidence(claim.source || claim);
  const context = buildKnowledgeSourceContext(source);
  const result = {
    id: firstNonEmpty(claim.id),
    title: firstNonEmpty(claim.text, claim.evidence_text, source.evidence_text, "Claim"),
    status: firstNonEmpty(claim.status),
    confidenceLabel: formatNumber(claim.confidence ?? source.confidence),
    sourceTitle: context.title,
    sourceMeta: context.meta,
    evidenceText: firstNonEmpty(source.evidence_text, claim.text),
  };
  if (context.contextText) {
    result.sourceContextText = context.contextText;
  }
  return result;
}

function conflictSide(label, recordType, recordId, source = {}) {
  const normalized = sourceFromEvidence(source);
  const context = buildKnowledgeSourceContext(normalized);
  const result = {
    label: `${label} ${recordType || "record"} ${recordId || ""}`.trim(),
    recordId: firstNonEmpty(recordId),
    recordType: firstNonEmpty(recordType),
    sourceTitle: context.title,
    sourceMeta: context.meta,
    evidenceText: firstNonEmpty(normalized.evidence_text, source.text),
  };
  if (context.contextText) {
    result.contextText = context.contextText;
  }
  return result;
}

export function buildKnowledgeConflictInspection(conflict = {}) {
  const sources = asArray(conflict.sources);
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
      conflictSide("Left", leftType, leftId, sources[0] || conflict.left_source || {}),
      conflictSide("Right", rightType, rightId, sources[1] || conflict.right_source || {}),
    ],
  };
}

function sourceRowsForProjection(projection = {}) {
  return asArray(projection.source_refs || projection.sources || projection.evidence || projection.supporting_sources)
    .map((item) => {
      const source = sourceFromEvidence(item);
      const context = buildKnowledgeSourceContext(source);
      const row = {
        title: context.title,
        meta: context.meta,
        text: firstNonEmpty(source.evidence_text, item.text),
        claimId: firstNonEmpty(item.claim_id),
      };
      if (context.contextText) {
        row.contextText = context.contextText;
      }
      return row;
    });
}

export function buildKnowledgeProjectionInspection(projection = {}) {
  const type = firstNonEmpty(projection.projection_type, projection.type, "projection");
  const community = projection.community ?? projection.community_id;
  return {
    id: firstNonEmpty(projection.id),
    title: firstNonEmpty(projection.title, projection.name, projection.summary, type),
    summary: firstNonEmpty(projection.summary, projection.full_content, projection.description),
    type,
    status: firstNonEmpty(projection.projection_status, projection.status),
    derivedLabel: "Derived projection",
    communityLabel: community == null || community === "" ? "" : `Community ${community}`,
    rankLabel: formatNumber(projection.rank ?? projection.rating),
    supportingClaimIds: asArray(projection.supporting_claim_ids || projection.claim_ids).map(asText).filter(Boolean),
    supportingRelationIds: asArray(projection.supporting_relation_ids || projection.relation_ids).map(asText).filter(Boolean),
    sources: sourceRowsForProjection(projection),
  };
}
