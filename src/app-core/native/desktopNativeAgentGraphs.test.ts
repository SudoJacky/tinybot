import { describe, expect, test, vi } from "vitest";
import { createAgentGraphDraft } from "../agent-graph/agentGraphDefinition";
import { createDesktopNativeAgentGraphsApi } from "./desktopNativeAgentGraphs";

describe("desktop native Agent Graph API", () => {
  test("uses the Agent Graph Tauri command contract", async () => {
    const invoke = vi.fn(async () => undefined);
    const api = createDesktopNativeAgentGraphsApi({ invoke });
    const definition = createAgentGraphDraft({
      id: "graph-1",
      name: "Research",
      workspacePath: "D:\\work",
    });

    await api.list("D:\\work");
    await api.save({ workspacePath: "D:\\work", definition, expectedRevision: "sha256:before" });
    await api.delete({ workspacePath: "D:\\work", graphId: "graph-1", expectedRevision: "sha256:after" });

    expect(invoke.mock.calls).toEqual([
      ["worker_agent_graphs_list", { input: { workspacePath: "D:\\work" } }],
      ["worker_agent_graph_save", {
        input: { workspacePath: "D:\\work", definition, expectedRevision: "sha256:before" },
      }],
      ["worker_agent_graph_delete", {
        input: { workspacePath: "D:\\work", graphId: "graph-1", expectedRevision: "sha256:after" },
      }],
    ]);
  });
});
