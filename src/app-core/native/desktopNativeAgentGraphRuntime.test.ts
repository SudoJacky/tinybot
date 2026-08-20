import { describe, expect, it, vi } from "vitest";
import { createDesktopNativeAgentGraphRuntime } from "./desktopNativeAgentGraphRuntime";

describe("desktopNativeAgentGraphRuntime", () => {
  it("invokes the typed Graph Run commands", async () => {
    const invoke = vi.fn().mockResolvedValue([]);
    const runtime = createDesktopNativeAgentGraphRuntime({ invoke });
    const identity = {
      graphId: "graph-1",
      definitionWorkspacePath: "D:\\code\\tinybot",
    };

    await runtime.list(identity);
    await runtime.start({
      ...identity,
      graphRevision: "sha256:test",
      input: "Review this repository",
    });

    expect(invoke).toHaveBeenNthCalledWith(1, "worker_agent_graph_runs_list", { input: identity });
    expect(invoke).toHaveBeenNthCalledWith(2, "worker_agent_graph_run", {
      input: {
        ...identity,
        graphRevision: "sha256:test",
        input: "Review this repository",
      },
    });
  });
});
