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

  return {
    title: firstNonEmpty(normalized.doc_name, normalized.doc_id, "Unknown source"),
    location: locationParts.join(" / "),
    meta: metaParts.join(" / "),
  };
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
      return {
        title: context.title,
        meta: context.meta,
        text: firstNonEmpty(sourceEvidence.evidence_text, item.text),
        claimId: firstNonEmpty(item.claim_id),
      };
    }),
  };
}

export function buildKnowledgeClaimInspection(claim = {}) {
  const source = sourceFromEvidence(claim.source || claim);
  const context = buildKnowledgeSourceContext(source);
  return {
    id: firstNonEmpty(claim.id),
    title: firstNonEmpty(claim.text, claim.evidence_text, source.evidence_text, "Claim"),
    status: firstNonEmpty(claim.status),
    confidenceLabel: formatNumber(claim.confidence ?? source.confidence),
    sourceTitle: context.title,
    sourceMeta: context.meta,
    evidenceText: firstNonEmpty(source.evidence_text, claim.text),
  };
}

function conflictSide(label, recordType, recordId, source = {}) {
  const normalized = sourceFromEvidence(source);
  const context = buildKnowledgeSourceContext(normalized);
  return {
    label: `${label} ${recordType || "record"} ${recordId || ""}`.trim(),
    recordId: firstNonEmpty(recordId),
    recordType: firstNonEmpty(recordType),
    sourceTitle: context.title,
    sourceMeta: context.meta,
    evidenceText: firstNonEmpty(normalized.evidence_text, source.text),
  };
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
