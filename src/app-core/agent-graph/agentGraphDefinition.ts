export const AGENT_GRAPH_SCHEMA_VERSION = "tinybot.agent_graph.v1" as const;

export type AgentGraphNodeKind = "input" | "agent" | "condition" | "output";

export type AgentGraphNode = {
  id: string;
  kind: AgentGraphNodeKind;
};

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
  | "missing_edge_endpoint";

export function createAgentGraphDraft(input: { id: string; name: string }): AgentGraphDefinition {
  return {
    schemaVersion: AGENT_GRAPH_SCHEMA_VERSION,
    id: input.id,
    name: input.name,
    nodes: [
      { id: "input", kind: "input" },
      { id: "agent", kind: "agent" },
      { id: "output", kind: "output" },
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
  let duplicateNodeId = false;

  for (const node of definition.nodes) {
    if (nodeIds.has(node.id)) {
      duplicateNodeId = true;
    }
    nodeIds.add(node.id);
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

  return issues;
}
