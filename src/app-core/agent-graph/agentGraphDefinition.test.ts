import { describe, expect, it } from "vitest";
import {
  AGENT_GRAPH_SCHEMA_VERSION,
  addAgentGraphNode,
  configureAgentGraphInput,
  configureAgentGraphNode,
  configureAgentGraphRouter,
  connectAgentGraphNodes,
  createAgentGraphDraft,
  createAgentGraphRouterConfig,
  moveAgentGraphNode,
  removeAgentGraphEdge,
  removeAgentGraphNode,
  validateAgentGraphDefinition,
} from "./agentGraphDefinition";

const WORKSPACE_PATH = "D:\\code\\tinybot";

describe("agentGraphDefinition", () => {
  it("creates a versioned Input to Agent to Output draft", () => {
    const definition = createAgentGraphDraft({ id: "graph-1", name: "Research flow", workspacePath: WORKSPACE_PATH });

    expect(definition.schemaVersion).toBe(AGENT_GRAPH_SCHEMA_VERSION);
    expect(definition.nodes.map((node) => node.kind)).toEqual(["input", "agent", "output"]);
    expect(definition.nodes.map((node) => node.position.x)).toEqual([72, 300, 528]);
    expect(definition.nodes.find((node) => node.kind === "input")?.config).toEqual({ prompt: "" });
    expect(definition.nodes.find((node) => node.kind === "agent")?.config).toEqual({
      instructions: "",
      workspacePath: WORKSPACE_PATH,
    });
    expect(definition.edges.map((edge) => [edge.source, edge.target])).toEqual([
      ["input", "agent"],
      ["agent", "output"],
    ]);
    expect(validateAgentGraphDefinition(definition)).toEqual(["input_prompt_required"]);

    const configured = configureAgentGraphInput(definition, "input", { prompt: "Research the repository." });
    expect(configured).toMatchObject({ ok: true });
    if (!configured.ok) return;
    expect(validateAgentGraphDefinition(configured.definition)).toEqual([]);
  });

  it("reports caller-actionable structural issues", () => {
    const definition = createAgentGraphDraft({ id: "graph-1", name: " ", workspacePath: WORKSPACE_PATH });
    definition.nodes.push({ id: "agent", kind: "condition", position: { x: 0, y: 0 } });
    definition.nodes = definition.nodes.filter((node) => node.kind !== "output");

    expect(validateAgentGraphDefinition(definition)).toEqual([
      "name_required",
      "single_output_required",
      "input_prompt_required",
      "duplicate_node_id",
      "missing_edge_endpoint",
      "router_configuration_required",
    ]);
  });

  it("adds and moves nodes without mutating the existing definition", () => {
    const definition = createAgentGraphDraft({ id: "graph-1", name: "Flow", workspacePath: WORKSPACE_PATH });
    const added = addAgentGraphNode(definition, {
      id: "condition-1",
      kind: "condition",
      position: { x: 220.4, y: -12 },
      config: createAgentGraphRouterConfig("condition-1"),
    });

    expect(added).toMatchObject({ ok: true });
    if (!added.ok) return;
    expect(definition.nodes).toHaveLength(3);
    expect(added.definition.nodes[added.definition.nodes.length - 1]?.position).toEqual({ x: 220, y: 0 });

    const moved = moveAgentGraphNode(added.definition, "condition-1", { x: 340, y: 210 });
    expect(moved).toMatchObject({ ok: true });
    if (!moved.ok) return;
    expect(moved.definition.nodes.find((node) => node.id === "condition-1")?.position).toEqual({ x: 340, y: 210 });
  });

  it("connects nodes while rejecting invalid or duplicate edges", () => {
    const definition = createAgentGraphDraft({ id: "graph-1", name: "Flow", workspacePath: WORKSPACE_PATH });
    const connected = connectAgentGraphNodes(definition, "input", "output");

    expect(connected).toMatchObject({ ok: true });
    if (!connected.ok) return;
    expect(connected.definition.edges[connected.definition.edges.length - 1]).toMatchObject({ source: "input", target: "output" });
    expect(connectAgentGraphNodes(connected.definition, "input", "output")).toEqual({ ok: false, reason: "duplicate_edge" });
    expect(connectAgentGraphNodes(definition, "output", "agent")).toEqual({ ok: false, reason: "output_cannot_be_source" });
    expect(connectAgentGraphNodes(definition, "agent", "input")).toEqual({ ok: false, reason: "input_cannot_be_target" });
  });

  it("keeps generated edge ids unique when node ids make the base id collide", () => {
    const definition = createAgentGraphDraft({ id: "graph-1", name: "Flow", workspacePath: WORKSPACE_PATH });
    definition.edges[0] = { ...definition.edges[0], id: "edge-input-output" };

    const connected = connectAgentGraphNodes(definition, "input", "output");

    expect(connected).toMatchObject({ ok: true });
    if (!connected.ok) return;
    expect(connected.definition.edges[connected.definition.edges.length - 1]?.id).toBe("edge-input-output-2");
  });

  it("removes editable nodes and their incident edges but protects boundary nodes", () => {
    const definition = createAgentGraphDraft({ id: "graph-1", name: "Flow", workspacePath: WORKSPACE_PATH });
    const removed = removeAgentGraphNode(definition, "agent");

    expect(removed).toMatchObject({ ok: true });
    if (!removed.ok) return;
    expect(removed.definition.nodes.map((node) => node.id)).toEqual(["input", "output"]);
    expect(removed.definition.edges).toEqual([]);
    expect(removeAgentGraphNode(definition, "input")).toEqual({ ok: false, reason: "protected_node_kind" });
  });

  it("removes a connection by its stable edge id", () => {
    const definition = createAgentGraphDraft({ id: "graph-1", name: "Flow", workspacePath: WORKSPACE_PATH });
    const removed = removeAgentGraphEdge(definition, "input-agent");

    expect(removed).toMatchObject({ ok: true });
    if (!removed.ok) return;
    expect(removed.definition.edges.map((edge) => edge.id)).toEqual(["agent-output"]);
    expect(removeAgentGraphEdge(definition, "missing")).toEqual({ ok: false, reason: "edge_not_found" });
  });

  it("keeps Input and Output unique", () => {
    const definition = createAgentGraphDraft({ id: "graph-1", name: "Flow", workspacePath: WORKSPACE_PATH });

    expect(addAgentGraphNode(definition, {
      id: "another-input",
      kind: "input",
      position: { x: 0, y: 0 },
      config: { prompt: "Another prompt" },
    })).toEqual({ ok: false, reason: "unique_node_kind" });
  });

  it("updates only Agent node configuration", () => {
    const definition = createAgentGraphDraft({ id: "graph-1", name: "Flow", workspacePath: WORKSPACE_PATH });
    const updated = configureAgentGraphNode(definition, "agent", {
      instructions: "Review the previous report.",
      model: {
        modelId: "gpt-5.6-sol",
        providerId: "openai",
        reasoningEffort: "high",
      },
      workspacePath: " E:\\services\\payments ",
    });

    expect(updated).toMatchObject({ ok: true });
    if (!updated.ok) return;
    expect(definition.nodes.find((node) => node.kind === "agent")?.config.workspacePath).toBe(WORKSPACE_PATH);
    expect(updated.definition.nodes.find((node) => node.kind === "agent")?.config).toEqual({
      instructions: "Review the previous report.",
      model: {
        modelId: "gpt-5.6-sol",
        providerId: "openai",
        reasoningEffort: "high",
      },
      workspacePath: "E:\\services\\payments",
    });
    expect(configureAgentGraphNode(definition, "input", {
      instructions: "",
      workspacePath: WORKSPACE_PATH,
    })).toEqual({
      ok: false,
      reason: "node_not_configurable",
    });
  });

  it("configures Router paths and connects a stable route to an edge", () => {
    const definition = createAgentGraphDraft({ id: "graph-1", name: "Flow", workspacePath: WORKSPACE_PATH });
    const added = addAgentGraphNode(definition, {
      id: "condition-1",
      kind: "condition",
      position: { x: 420, y: 124 },
      config: createAgentGraphRouterConfig("condition-1"),
    });
    expect(added).toMatchObject({ ok: true });
    if (!added.ok) return;

    const configured = configureAgentGraphRouter(added.definition, "condition-1", {
      task: "Choose whether the review passed.",
      routes: [
        { id: "approved", label: "Approved", description: "The review has no blocking issues." },
        { id: "changes", label: "Needs changes", description: "The review found actionable issues." },
      ],
      model: { modelId: "gpt-5.6-sol", providerId: "openai", reasoningEffort: "low" },
    });
    expect(configured).toMatchObject({ ok: true });
    if (!configured.ok) return;

    const connected = connectAgentGraphNodes(configured.definition, "condition-1", "output", "approved");
    expect(connected).toMatchObject({ ok: true });
    if (!connected.ok) return;
    expect(connected.definition.edges[connected.definition.edges.length - 1]).toMatchObject({
      source: "condition-1",
      sourceRouteId: "approved",
      target: "output",
    });
    expect(connectAgentGraphNodes(configured.definition, "condition-1", "output")).toEqual({
      ok: false,
      reason: "router_route_required",
    });
  });

  it("reports incomplete Router configuration and prunes removed route edges", () => {
    const definition = createAgentGraphDraft({ id: "graph-1", name: "Flow", workspacePath: WORKSPACE_PATH });
    definition.nodes.push({
      id: "condition-1",
      kind: "condition",
      position: { x: 420, y: 124 },
      config: createAgentGraphRouterConfig("condition-1"),
    });

    expect(validateAgentGraphDefinition(definition)).toEqual([
      "input_prompt_required",
      "router_route_description_required",
      "router_route_connection_required",
    ]);

    definition.edges.push({
      id: "condition-output",
      source: "condition-1",
      sourceRouteId: "condition-1-route-b",
      target: "output",
    });
    const configured = configureAgentGraphRouter(definition, "condition-1", {
      routes: [
        { id: "condition-1-route-a", label: "Approved", description: "No blocking issues." },
        { id: "condition-1-route-c", label: "Manual", description: "A person must decide." },
      ],
    });
    expect(configured).toMatchObject({ ok: true });
    if (!configured.ok) return;
    expect(configured.definition.edges.some((edge) => edge.id === "condition-output")).toBe(false);
  });
});
