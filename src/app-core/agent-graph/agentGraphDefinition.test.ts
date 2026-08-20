import { describe, expect, it } from "vitest";
import {
  AGENT_GRAPH_SCHEMA_VERSION,
  createAgentGraphDraft,
  validateAgentGraphDefinition,
} from "./agentGraphDefinition";

describe("agentGraphDefinition", () => {
  it("creates a versioned Input to Agent to Output draft", () => {
    const definition = createAgentGraphDraft({ id: "graph-1", name: "Research flow" });

    expect(definition.schemaVersion).toBe(AGENT_GRAPH_SCHEMA_VERSION);
    expect(definition.nodes.map((node) => node.kind)).toEqual(["input", "agent", "output"]);
    expect(definition.edges.map((edge) => [edge.source, edge.target])).toEqual([
      ["input", "agent"],
      ["agent", "output"],
    ]);
    expect(validateAgentGraphDefinition(definition)).toEqual([]);
  });

  it("reports caller-actionable structural issues", () => {
    const definition = createAgentGraphDraft({ id: "graph-1", name: " " });
    definition.nodes.push({ id: "agent", kind: "condition" });
    definition.nodes = definition.nodes.filter((node) => node.kind !== "output");

    expect(validateAgentGraphDefinition(definition)).toEqual([
      "name_required",
      "single_output_required",
      "duplicate_node_id",
      "missing_edge_endpoint",
    ]);
  });
});
