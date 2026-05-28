import assert from "node:assert/strict";

import {
  buildKnowledgeClaimInspection,
  buildKnowledgeConflictInspection,
  buildKnowledgeProjectionInspection,
  buildKnowledgeRelationInspection,
  buildKnowledgeSourceContext,
  knowledgeEvidenceRowsForEdge,
} from "./knowledge-traceability.js";

const nodes = [
  { id: "entity:tinybot", label: "TinyBot" },
  { id: "entity:rag", label: "RAG" },
];

const edge = {
  id: "rel:1",
  source: "entity:tinybot",
  target: "entity:rag",
  predicate: "supports",
  confidence: 0.82,
  weight: 2,
  supporting_claim_ids: ["claim:1"],
  evidence: [
    {
      relation_id: "rel:1",
      claim_id: "claim:1",
      doc_name: "Architecture Notes",
      chunk_id: "chunk:7",
      line_start: 12,
      line_end: 13,
      text: "TinyBot supports RAG with source citations.",
      confidence: 0.91,
      source: {
        doc_id: "doc:1",
        doc_name: "Architecture Notes",
        chunk_id: "chunk:7",
        evidence_text: "TinyBot supports RAG with source citations.",
        start_char: 120,
        end_char: 168,
        page: 3,
        extraction_method: "rule",
        confidence: 0.91,
      },
    },
  ],
};

assert.deepEqual(knowledgeEvidenceRowsForEdge(edge, nodes), [
  {
    id: "rel:1:claim:1:chunk:7:0",
    edgeId: "rel:1",
    sourceNodeId: "entity:tinybot",
    targetNodeId: "entity:rag",
    title: "TinyBot -[supports]-> RAG",
    docName: "Architecture Notes",
    location: "L12-L13 / p.3 / chunk:7",
    evidenceText: "TinyBot supports RAG with source citations.",
    confidenceLabel: "0.910",
    claimId: "claim:1",
  },
]);

assert.deepEqual(buildKnowledgeRelationInspection(edge, nodes), {
  title: "TinyBot -[supports]-> RAG",
  predicate: "supports",
  endpoints: "TinyBot -> RAG",
  confidenceLabel: "0.820",
  weightLabel: "2.000",
  supportingClaimIds: ["claim:1"],
  evidence: [
    {
      title: "Architecture Notes",
      meta: "L12-L13 / p.3 / chunk:7 / rule / confidence 0.910",
      text: "TinyBot supports RAG with source citations.",
      claimId: "claim:1",
    },
  ],
});

assert.deepEqual(buildKnowledgeClaimInspection({
  id: "claim:1",
  text: "TinyBot supports RAG.",
  status: "TRUE",
  confidence: 0.88,
  source: {
    doc_name: "Architecture Notes",
    chunk_id: "chunk:7",
    evidence_text: "TinyBot supports RAG with source citations.",
    page: 3,
    extraction_method: "llm",
    confidence: 0.88,
  },
}), {
  id: "claim:1",
  title: "TinyBot supports RAG.",
  status: "TRUE",
  confidenceLabel: "0.880",
  sourceTitle: "Architecture Notes",
  sourceMeta: "p.3 / chunk:7 / llm / confidence 0.880",
  evidenceText: "TinyBot supports RAG with source citations.",
});

assert.deepEqual(buildKnowledgeSourceContext({
  doc_name: "Architecture Notes",
  chunk_id: "chunk:7",
  page: 3,
  start_char: 120,
  end_char: 168,
  extraction_method: "rule",
  confidence: 0.91,
}), {
  title: "Architecture Notes",
  location: "p.3 / chars 120-168 / chunk:7",
  meta: "p.3 / chars 120-168 / chunk:7 / rule / confidence 0.910",
});

assert.deepEqual(buildKnowledgeConflictInspection({
  id: "conflict:1",
  conflict_type: "claim_polarity",
  left_record_id: "claim:left",
  left_record_type: "claim",
  right_record_id: "claim:right",
  right_record_type: "claim",
  status: "open",
  confidence: 0.77,
  sources: [
    {
      doc_name: "Release Notes",
      chunk_id: "chunk:left",
      evidence_text: "The GraphRAG projection is ready.",
      extraction_method: "llm",
      confidence: 0.81,
    },
    {
      doc_name: "Incident Notes",
      chunk_id: "chunk:right",
      evidence_text: "The GraphRAG projection is stale.",
      extraction_method: "rule",
      confidence: 0.73,
    },
  ],
}), {
  id: "conflict:1",
  title: "claim claim:left conflicts with claim claim:right",
  type: "claim_polarity",
  status: "open",
  confidenceLabel: "0.770",
  sides: [
    {
      label: "Left claim claim:left",
      recordId: "claim:left",
      recordType: "claim",
      sourceTitle: "Release Notes",
      sourceMeta: "chunk:left / llm / confidence 0.810",
      evidenceText: "The GraphRAG projection is ready.",
    },
    {
      label: "Right claim claim:right",
      recordId: "claim:right",
      recordType: "claim",
      sourceTitle: "Incident Notes",
      sourceMeta: "chunk:right / rule / confidence 0.730",
      evidenceText: "The GraphRAG projection is stale.",
    },
  ],
});

assert.deepEqual(buildKnowledgeProjectionInspection({
  id: "report:1",
  title: "Retrieval architecture",
  summary: "Derived from source-backed claims and relationships.",
  projection_type: "community_report",
  projection_status: "fresh",
  community: 3,
  rank: 0.92,
  supporting_claim_ids: ["claim:1", "claim:2"],
  supporting_relation_ids: ["rel:1"],
  source_refs: [
    {
      doc_name: "Architecture Notes",
      chunk_id: "chunk:7",
      evidence_text: "TinyBot supports RAG with source citations.",
      context_text: "Before. TinyBot supports RAG with source citations. After.",
      extraction_method: "llm",
      confidence: 0.88,
    },
  ],
}), {
  id: "report:1",
  title: "Retrieval architecture",
  summary: "Derived from source-backed claims and relationships.",
  type: "community_report",
  status: "fresh",
  derivedLabel: "Derived projection",
  communityLabel: "Community 3",
  rankLabel: "0.920",
  supportingClaimIds: ["claim:1", "claim:2"],
  supportingRelationIds: ["rel:1"],
  sources: [
    {
      title: "Architecture Notes",
      meta: "chunk:7 / llm / confidence 0.880",
      text: "TinyBot supports RAG with source citations.",
      contextText: "Before. TinyBot supports RAG with source citations. After.",
      claimId: "",
    },
  ],
});

assert.deepEqual(buildKnowledgeSourceContext({
  doc_name: "Architecture Notes",
  chunk_id: "chunk:7",
  evidence_text: "TinyBot supports RAG with source citations.",
  surrounding_text: "Before. TinyBot supports RAG with source citations. After.",
}), {
  title: "Architecture Notes",
  location: "chunk:7",
  meta: "chunk:7",
  contextText: "Before. TinyBot supports RAG with source citations. After.",
  hasContext: true,
});
