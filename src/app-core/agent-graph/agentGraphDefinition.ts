export const AGENT_GRAPH_SCHEMA_VERSION = "tinybot.agent_graph.v1" as const;

export type AgentGraphNodeKind = "input" | "agent" | "condition" | "output";

export type AgentGraphNodePosition = {
  x: number;
  y: number;
};

type AgentGraphBaseNode = {
  id: string;
  position: AgentGraphNodePosition;
};

export type AgentLoopNodeConfig = {
  workspacePath: string;
};

export type AgentGraphAgentNode = AgentGraphBaseNode & {
  kind: "agent";
  config: AgentLoopNodeConfig;
};

export type AgentGraphNode = AgentGraphAgentNode | (AgentGraphBaseNode & {
  kind: Exclude<AgentGraphNodeKind, "agent">;
});

export type AgentGraphEdge = {
  id: string;
  source: string;
  target: string;
};

export type AgentGraphDefinition = {
  schemaVersion: typeof AGENT_GRAPH_SCHEMA_VERSION;
  id: string;
  name: string;
  nodes: AgentGraphNode[];
  edges: AgentGraphEdge[];
};

export type AgentGraphValidationIssue =
  | "name_required"
  | "single_input_required"
  | "single_output_required"
  | "duplicate_node_id"
  | "missing_edge_endpoint"
  | "duplicate_edge"
  | "self_edge"
  | "input_has_incoming_edge"
  | "output_has_outgoing_edge";

export type AgentGraphEditError =
  | "duplicate_node_id"
  | "unique_node_kind"
  | "node_not_found"
  | "edge_not_found"
  | "protected_node_kind"
  | "node_not_configurable"
  | "self_edge"
  | "duplicate_edge"
  | "input_cannot_be_target"
  | "output_cannot_be_source";

export type AgentGraphEditResult =
  | { ok: true; definition: AgentGraphDefinition }
  | { ok: false; reason: AgentGraphEditError };

export function createAgentGraphDraft(input: {
  id: string;
  name: string;
  workspacePath: string;
}): AgentGraphDefinition {
  return {
    schemaVersion: AGENT_GRAPH_SCHEMA_VERSION,
    id: input.id,
    name: input.name,
    nodes: [
      { id: "input", kind: "input", position: { x: 72, y: 124 } },
      {
        id: "agent",
        kind: "agent",
        position: { x: 300, y: 124 },
        config: { workspacePath: input.workspacePath },
      },
      { id: "output", kind: "output", position: { x: 528, y: 124 } },
    ],
    edges: [
      { id: "input-agent", source: "input", target: "agent" },
      { id: "agent-output", source: "agent", target: "output" },
    ],
  };
}

export function validateAgentGraphDefinition(
  definition: AgentGraphDefinition,
): AgentGraphValidationIssue[] {
  const issues: AgentGraphValidationIssue[] = [];
  const nodeIds = new Set<string>();
  const edgeEndpoints = new Set<string>();
  let duplicateNodeId = false;
  let duplicateEdge = false;

  for (const node of definition.nodes) {
    if (nodeIds.has(node.id)) {
      duplicateNodeId = true;
    }
    nodeIds.add(node.id);
  }

  for (const edge of definition.edges) {
    const endpointKey = `${edge.source}\u0000${edge.target}`;
    if (edgeEndpoints.has(endpointKey)) {
      duplicateEdge = true;
    }
    edgeEndpoints.add(endpointKey);
  }

  if (!definition.name.trim()) {
    issues.push("name_required");
  }
  if (definition.nodes.filter((node) => node.kind === "input").length !== 1) {
    issues.push("single_input_required");
  }
  if (definition.nodes.filter((node) => node.kind === "output").length !== 1) {
    issues.push("single_output_required");
  }
  if (duplicateNodeId) {
    issues.push("duplicate_node_id");
  }
  if (definition.edges.some((edge) => !nodeIds.has(edge.source) || !nodeIds.has(edge.target))) {
    issues.push("missing_edge_endpoint");
  }
  if (duplicateEdge) {
    issues.push("duplicate_edge");
  }
  if (definition.edges.some((edge) => edge.source === edge.target)) {
    issues.push("self_edge");
  }
  if (definition.edges.some((edge) => definition.nodes.find((node) => node.id === edge.target)?.kind === "input")) {
    issues.push("input_has_incoming_edge");
  }
  if (definition.edges.some((edge) => definition.nodes.find((node) => node.id === edge.source)?.kind === "output")) {
    issues.push("output_has_outgoing_edge");
  }

  return issues;
}

export function addAgentGraphNode(
  definition: AgentGraphDefinition,
  node: AgentGraphNode,
): AgentGraphEditResult {
  if (definition.nodes.some((candidate) => candidate.id === node.id)) {
    return { ok: false, reason: "duplicate_node_id" };
  }
  if (
    (node.kind === "input" || node.kind === "output")
    && definition.nodes.some((candidate) => candidate.kind === node.kind)
  ) {
    return { ok: false, reason: "unique_node_kind" };
  }

  return {
    ok: true,
    definition: {
      ...definition,
      nodes: [...definition.nodes, { ...node, position: normalizePosition(node.position) }],
    },
  };
}

export function moveAgentGraphNode(
  definition: AgentGraphDefinition,
  nodeId: string,
  position: AgentGraphNodePosition,
): AgentGraphEditResult {
  if (!definition.nodes.some((node) => node.id === nodeId)) {
    return { ok: false, reason: "node_not_found" };
  }

  return {
    ok: true,
    definition: {
      ...definition,
      nodes: definition.nodes.map((node) => (
        node.id === nodeId ? { ...node, position: normalizePosition(position) } : node
      )),
    },
  };
}

export function setAgentGraphNodeWorkspace(
  definition: AgentGraphDefinition,
  nodeId: string,
  workspacePath: string,
): AgentGraphEditResult {
  const node = definition.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) {
    return { ok: false, reason: "node_not_found" };
  }
  if (node.kind !== "agent") {
    return { ok: false, reason: "node_not_configurable" };
  }

  return {
    ok: true,
    definition: {
      ...definition,
      nodes: definition.nodes.map((candidate) => (
        candidate.id === nodeId
          ? { ...candidate, config: { workspacePath: workspacePath.trim() } }
          : candidate
      )),
    },
  };
}

export function connectAgentGraphNodes(
  definition: AgentGraphDefinition,
  source: string,
  target: string,
): AgentGraphEditResult {
  const sourceNode = definition.nodes.find((node) => node.id === source);
  const targetNode = definition.nodes.find((node) => node.id === target);
  if (!sourceNode || !targetNode) {
    return { ok: false, reason: "node_not_found" };
  }
  if (source === target) {
    return { ok: false, reason: "self_edge" };
  }
  if (sourceNode.kind === "output") {
    return { ok: false, reason: "output_cannot_be_source" };
  }
  if (targetNode.kind === "input") {
    return { ok: false, reason: "input_cannot_be_target" };
  }
  if (definition.edges.some((edge) => edge.source === source && edge.target === target)) {
    return { ok: false, reason: "duplicate_edge" };
  }

  const baseEdgeId = `edge-${source}-${target}`;
  let edgeId = baseEdgeId;
  let suffix = 2;
  while (definition.edges.some((edge) => edge.id === edgeId)) {
    edgeId = `${baseEdgeId}-${suffix}`;
    suffix += 1;
  }

  return {
    ok: true,
    definition: {
      ...definition,
      edges: [...definition.edges, { id: edgeId, source, target }],
    },
  };
}

export function removeAgentGraphNode(
  definition: AgentGraphDefinition,
  nodeId: string,
): AgentGraphEditResult {
  const node = definition.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) {
    return { ok: false, reason: "node_not_found" };
  }
  if (node.kind === "input" || node.kind === "output") {
    return { ok: false, reason: "protected_node_kind" };
  }

  return {
    ok: true,
    definition: {
      ...definition,
      nodes: definition.nodes.filter((candidate) => candidate.id !== nodeId),
      edges: definition.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId),
    },
  };
}

export function removeAgentGraphEdge(
  definition: AgentGraphDefinition,
  edgeId: string,
): AgentGraphEditResult {
  if (!definition.edges.some((edge) => edge.id === edgeId)) {
    return { ok: false, reason: "edge_not_found" };
  }

  return {
    ok: true,
    definition: {
      ...definition,
      edges: definition.edges.filter((edge) => edge.id !== edgeId),
    },
  };
}

function normalizePosition(position: AgentGraphNodePosition): AgentGraphNodePosition {
  return {
    x: Math.max(0, Math.round(position.x)),
    y: Math.max(0, Math.round(position.y)),
  };
}
