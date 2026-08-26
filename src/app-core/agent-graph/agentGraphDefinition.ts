import type { ReasoningEffort } from "../chat/reasoningEffort";

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

export type AgentGraphModelConfig = {
  modelId: string;
  providerId?: string;
  reasoningEffort?: ReasoningEffort;
};

export type AgentLoopNodeConfig = {
  workspacePath: string;
  instructions: string;
  model?: AgentGraphModelConfig;
};

export type AgentGraphRouterRoute = {
  id: string;
  label: string;
  description: string;
};

export type AgentGraphRouterNodeConfig = {
  task?: string;
  routes: AgentGraphRouterRoute[];
  model?: AgentGraphModelConfig;
};

export type AgentGraphInputNode = AgentGraphBaseNode & {
  kind: "input";
};

export type AgentGraphAgentNode = AgentGraphBaseNode & {
  kind: "agent";
  config: AgentLoopNodeConfig;
};

export type AgentGraphConditionNode = AgentGraphBaseNode & {
  kind: "condition";
  config?: AgentGraphRouterNodeConfig;
};

export type AgentGraphNode =
  | AgentGraphInputNode
  | AgentGraphAgentNode
  | AgentGraphConditionNode
  | (AgentGraphBaseNode & { kind: "output" });

export type AgentGraphEdge = {
  id: string;
  source: string;
  target: string;
  sourceRouteId?: string;
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
  | "output_has_outgoing_edge"
  | "router_configuration_required"
  | "router_routes_required"
  | "router_route_label_required"
  | "router_route_description_required"
  | "duplicate_router_route_id"
  | "router_edge_route_required"
  | "invalid_router_edge_route"
  | "non_router_edge_route"
  | "router_route_connection_required"
  | "router_route_multiple_connections";

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
  | "output_cannot_be_source"
  | "router_route_required"
  | "router_route_not_found"
  | "non_router_route";

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
        config: { workspacePath: input.workspacePath, instructions: "" },
      },
      { id: "output", kind: "output", position: { x: 528, y: 124 } },
    ],
    edges: [
      { id: "input-agent", source: "input", target: "agent" },
      { id: "agent-output", source: "agent", target: "output" },
    ],
  };
}

export function createAgentGraphRouterConfig(nodeId: string): AgentGraphRouterNodeConfig {
  return {
    routes: [
      { id: `${nodeId}-route-a`, label: "Path A", description: "" },
      { id: `${nodeId}-route-b`, label: "Path B", description: "" },
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

  const routerNodes = definition.nodes.filter((node): node is AgentGraphConditionNode => node.kind === "condition");
  if (routerNodes.some((node) => !node.config)) {
    issues.push("router_configuration_required");
  }
  if (routerNodes.some((node) => node.config && node.config.routes.length < 2)) {
    issues.push("router_routes_required");
  }
  if (routerNodes.some((node) => node.config?.routes.some((route) => !route.label.trim()))) {
    issues.push("router_route_label_required");
  }
  if (routerNodes.some((node) => node.config?.routes.some((route) => !route.description.trim()))) {
    issues.push("router_route_description_required");
  }
  if (routerNodes.some((node) => {
    if (!node.config) return false;
    const routeIds = node.config.routes.map((route) => route.id);
    return routeIds.some((routeId) => !routeId.trim()) || new Set(routeIds).size !== routeIds.length;
  })) {
    issues.push("duplicate_router_route_id");
  }
  if (!duplicateNodeId && definition.edges.some((edge) => (
    routerNodes.some((node) => node.id === edge.source) && !edge.sourceRouteId
  ))) {
    issues.push("router_edge_route_required");
  }
  if (!duplicateNodeId && definition.edges.some((edge) => {
    const source = routerNodes.find((node) => node.id === edge.source);
    return source?.config && edge.sourceRouteId
      ? !source.config.routes.some((route) => route.id === edge.sourceRouteId)
      : false;
  })) {
    issues.push("invalid_router_edge_route");
  }
  if (!duplicateNodeId && definition.edges.some((edge) => (
    edge.sourceRouteId
    && definition.nodes.find((node) => node.id === edge.source)?.kind !== "condition"
  ))) {
    issues.push("non_router_edge_route");
  }
  if (!duplicateNodeId && routerNodes.some((node) => node.config?.routes.some((route) => (
    definition.edges.filter((edge) => edge.source === node.id && edge.sourceRouteId === route.id).length === 0
  )))) {
    issues.push("router_route_connection_required");
  }
  if (!duplicateNodeId && routerNodes.some((node) => node.config?.routes.some((route) => (
    definition.edges.filter((edge) => edge.source === node.id && edge.sourceRouteId === route.id).length > 1
  )))) {
    issues.push("router_route_multiple_connections");
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

export function configureAgentGraphNode(
  definition: AgentGraphDefinition,
  nodeId: string,
  config: AgentLoopNodeConfig,
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
        candidate.id === nodeId && candidate.kind === "agent"
          ? {
              ...candidate,
              config: {
                ...config,
                workspacePath: config.workspacePath.trim(),
              },
            }
          : candidate
      )),
    },
  };
}

export function configureAgentGraphRouter(
  definition: AgentGraphDefinition,
  nodeId: string,
  config: AgentGraphRouterNodeConfig,
): AgentGraphEditResult {
  const node = definition.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) {
    return { ok: false, reason: "node_not_found" };
  }
  if (node.kind !== "condition") {
    return { ok: false, reason: "node_not_configurable" };
  }

  const routeIds = new Set(config.routes.map((route) => route.id));
  return {
    ok: true,
    definition: {
      ...definition,
      nodes: definition.nodes.map((candidate) => (
        candidate.id === nodeId && candidate.kind === "condition" ? { ...candidate, config } : candidate
      )),
      edges: definition.edges.filter((edge) => (
        edge.source !== nodeId || (edge.sourceRouteId != null && routeIds.has(edge.sourceRouteId))
      )),
    },
  };
}

export function connectAgentGraphNodes(
  definition: AgentGraphDefinition,
  source: string,
  target: string,
  sourceRouteId?: string,
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
  if (sourceNode.kind === "condition") {
    if (!sourceRouteId) {
      return { ok: false, reason: "router_route_required" };
    }
    if (!sourceNode.config?.routes.some((route) => route.id === sourceRouteId)) {
      return { ok: false, reason: "router_route_not_found" };
    }
  } else if (sourceRouteId) {
    return { ok: false, reason: "non_router_route" };
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
      edges: [...definition.edges, {
        id: edgeId,
        source,
        target,
        ...(sourceRouteId ? { sourceRouteId } : {}),
      }],
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
    x: Math.round(position.x),
    y: Math.round(position.y),
  };
}
