export const DEFAULT_KNOWLEDGE_GRAPH_STACK = {
  renderer: "sigma",
  model: "graphology",
  defaultMode: "2d",
  optional3d: ["three", "3d-force-graph"],
} as const;

export type KnowledgeGraphNodeType = "document" | "entity" | "claim" | "community" | "conflict" | "unknown";

export interface NormalizedKnowledgeGraphNode {
  id: string;
  label: string;
  type: KnowledgeGraphNodeType;
  attributes: {
    communityId: string | null;
    confidence: number | null;
    conflict: boolean;
    evidenceIds: string[];
  };
}

export interface NormalizedKnowledgeGraphEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  label: string;
  evidenceIds: string[];
  attributes: Record<string, unknown>;
}

export interface NormalizedKnowledgeGraphData {
  nodes: NormalizedKnowledgeGraphNode[];
  edges: NormalizedKnowledgeGraphEdge[];
  communities: Array<Record<string, unknown>>;
  conflicts: Array<Record<string, unknown>>;
  metadata: {
    nodeCount: number;
    edgeCount: number;
    communityCount: number;
    conflictCount: number;
    indexReady: boolean;
    indexVersion: string;
    updatedAt: string;
  };
}

export interface KnowledgeGraphViewportState {
  x: number;
  y: number;
  ratio: number;
}

export interface KnowledgeGraphViewportEventInput {
  type: "select" | "hover" | "filter" | "viewport";
  nodeId?: string | null;
  edgeId?: string | null;
  filters?: Record<string, string[]>;
  viewport?: KnowledgeGraphViewportState;
}

export interface KnowledgeGraphViewportEvent {
  type: KnowledgeGraphViewportEventInput["type"];
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  hoveredNodeId: string | null;
  filters: Record<string, string[]>;
  viewport: KnowledgeGraphViewportState;
}

export interface KnowledgeGraphHighlightInput {
  queryResultIds?: string[];
  selectedNodeId?: string | null;
  selectedEdgeId?: string | null;
  evidenceIds?: string[];
}

export interface KnowledgeGraphHighlightState {
  highlightedNodeIds: string[];
  highlightedEdgeIds: string[];
  highlightedEvidenceIds: string[];
}

export interface LazyKnowledgeGraph3dModules {
  three: unknown;
  forceGraph3d: unknown;
}

type ImportModule = (name: "three" | "3d-force-graph") => Promise<unknown>;

export function normalizeKnowledgeGraphData(payload: unknown): NormalizedKnowledgeGraphData {
  const root = asRecord(payload);
  const conflicts = asArray(root.conflicts).map(asRecord);
  const conflictNodeIds = new Set(conflicts.flatMap((conflict) => asTextArray(conflict.node_ids ?? conflict.nodeIds)));
  const nodes = asArray(root.nodes).map((node) => normalizeNode(asRecord(node), conflictNodeIds));
  const edges = asArray(root.edges).map((edge, index) => normalizeEdge(asRecord(edge), index));
  const index = asRecord(root.index ?? root.index_metadata ?? root.indexMetadata);

  return {
    nodes,
    edges,
    communities: asArray(root.communities).map(asRecord),
    conflicts,
    metadata: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      communityCount: asArray(root.communities).length,
      conflictCount: conflicts.length,
      indexReady: index.ready === true,
      indexVersion: asText(index.version),
      updatedAt: asText(index.updated_at ?? index.updatedAt),
    },
  };
}

export function buildKnowledgeGraphViewportEvent(input: KnowledgeGraphViewportEventInput): KnowledgeGraphViewportEvent {
  return {
    type: input.type,
    selectedNodeId: input.type === "select" ? asOptionalText(input.nodeId) : null,
    selectedEdgeId: input.type === "select" ? asOptionalText(input.edgeId) : null,
    hoveredNodeId: input.type === "hover" ? asOptionalText(input.nodeId) : null,
    filters: cloneStringArrayRecord(input.filters),
    viewport: {
      x: input.viewport?.x ?? 0,
      y: input.viewport?.y ?? 0,
      ratio: input.viewport?.ratio ?? 1,
    },
  };
}

export function buildKnowledgeGraphHighlightState(input: KnowledgeGraphHighlightInput): KnowledgeGraphHighlightState {
  return {
    highlightedNodeIds: uniqueStrings([...(input.queryResultIds ?? []), input.selectedNodeId ?? ""]),
    highlightedEdgeIds: uniqueStrings([input.selectedEdgeId ?? ""]),
    highlightedEvidenceIds: uniqueStrings(input.evidenceIds ?? []),
  };
}

export function createLazyKnowledgeGraph3dLoader(importModule: ImportModule = defaultImportModule) {
  return {
    load: async (): Promise<LazyKnowledgeGraph3dModules> => {
      const [three, forceGraph3d] = await Promise.all([
        importModule("three"),
        importModule("3d-force-graph"),
      ]);
      return { three, forceGraph3d };
    },
  };
}

function normalizeNode(node: Record<string, unknown>, conflictNodeIds: Set<string>): NormalizedKnowledgeGraphNode {
  const id = asText(node.id);
  return {
    id,
    label: asText(node.label || node.title || id),
    type: normalizeNodeType(asText(node.type)),
    attributes: {
      communityId: asOptionalText(node.community_id ?? node.communityId),
      confidence: asOptionalNumber(node.confidence),
      conflict: node.conflict === true || conflictNodeIds.has(id),
      evidenceIds: asTextArray(node.evidence_ids ?? node.evidenceIds),
    },
  };
}

function normalizeEdge(edge: Record<string, unknown>, index: number): NormalizedKnowledgeGraphEdge {
  const source = asText(edge.source);
  const target = asText(edge.target);
  const type = asText(edge.predicate || edge.type || "related");
  const evidenceIds = asArray(edge.evidence).map((item) => asText(asRecord(item).id)).filter(Boolean);
  return {
    id: asText(edge.id) || `${source}:${type}:${target}:${index}`,
    source,
    target,
    type,
    label: type,
    evidenceIds,
    attributes: { ...edge },
  };
}

function normalizeNodeType(type: string): KnowledgeGraphNodeType {
  if (["document", "entity", "claim", "community", "conflict"].includes(type)) {
    return type as KnowledgeGraphNodeType;
  }
  return "unknown";
}

async function defaultImportModule(name: "three" | "3d-force-graph"): Promise<unknown> {
  return import(name);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

function asOptionalText(value: unknown): string | null {
  const text = asText(value).trim();
  return text ? text : null;
}

function asOptionalNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number.parseFloat(asText(value));
  return Number.isFinite(number) ? number : null;
}

function asTextArray(value: unknown): string[] {
  return asArray(value).map(asText).filter(Boolean);
}

function cloneStringArrayRecord(value: unknown): Record<string, string[]> {
  const record = asRecord(value);
  return Object.fromEntries(Object.entries(record).map(([key, list]) => [key, asTextArray(list)]));
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}
