export type KnowledgeGraphExtractionResult = {
  entities: Record<string, unknown>[];
  relations: Record<string, unknown>[];
};

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
