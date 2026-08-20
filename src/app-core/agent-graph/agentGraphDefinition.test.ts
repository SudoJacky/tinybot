import { describe, expect, it } from "vitest";
import {
  AGENT_GRAPH_SCHEMA_VERSION,
  addAgentGraphNode,
  connectAgentGraphNodes,
  createAgentGraphDraft,
  moveAgentGraphNode,
  removeAgentGraphEdge,
  removeAgentGraphNode,
  setAgentGraphNodeWorkspace,
  validateAgentGraphDefinition,
} from "./agentGraphDefinition";

const WORKSPACE_PATH = "D:\\code\\tinybot";

describe("agentGraphDefinition", () => {
  it("creates a versioned Input to Agent to Output draft", () => {
    const definition = createAgentGraphDraft({ id: "graph-1", name: "Research flow", workspacePath: WORKSPACE_PATH });

    expect(definition.schemaVersion).toBe(AGENT_GRAPH_SCHEMA_VERSION);
    expect(definition.nodes.map((node) => node.kind)).toEqual(["input", "agent", "output"]);
    expect(definition.nodes.map((node) => node.position.x)).toEqual([72, 300, 528]);
    expect(definition.nodes.find((node) => node.kind === "agent")?.config.workspacePath).toBe(WORKSPACE_PATH);
    expect(definition.edges.map((edge) => [edge.source, edge.target])).toEqual([
      ["input", "agent"],
      ["agent", "output"],
    ]);
    expect(validateAgentGraphDefinition(definition)).toEqual([]);
  });

  it("reports caller-actionable structural issues", () => {
    const definition = createAgentGraphDraft({ id: "graph-1", name: " ", workspacePath: WORKSPACE_PATH });
    definition.nodes.push({ id: "agent", kind: "condition", position: { x: 0, y: 0 } });
    definition.nodes = definition.nodes.filter((node) => node.kind !== "output");

    expect(validateAgentGraphDefinition(definition)).toEqual([
      "name_required",
      "single_output_required",
      "duplicate_node_id",
      "missing_edge_endpoint",
    ]);
  });

  it("adds and moves nodes without mutating the existing definition", () => {
    const definition = createAgentGraphDraft({ id: "graph-1", name: "Flow", workspacePath: WORKSPACE_PATH });
    const added = addAgentGraphNode(definition, {
      id: "condition-1",
      kind: "condition",
      position: { x: 220.4, y: -12 },
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
    })).toEqual({ ok: false, reason: "unique_node_kind" });
  });

  it("updates only Agent node workspace configuration", () => {
    const definition = createAgentGraphDraft({ id: "graph-1", name: "Flow", workspacePath: WORKSPACE_PATH });
    const updated = setAgentGraphNodeWorkspace(definition, "agent", " E:\\services\\payments ");

    expect(updated).toMatchObject({ ok: true });
    if (!updated.ok) return;
    expect(definition.nodes.find((node) => node.kind === "agent")?.config.workspacePath).toBe(WORKSPACE_PATH);
    expect(updated.definition.nodes.find((node) => node.kind === "agent")?.config.workspacePath).toBe("E:\\services\\payments");
    expect(setAgentGraphNodeWorkspace(definition, "input", WORKSPACE_PATH)).toEqual({
      ok: false,
      reason: "node_not_configurable",
    });
  });
});
