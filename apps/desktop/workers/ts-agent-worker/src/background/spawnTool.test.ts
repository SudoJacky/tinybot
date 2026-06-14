import { describe, expect, test } from "vitest";

import { createSpawnTool } from "./spawnTool";
import type { SubagentSpawnRequest, SubagentSpawnResult } from "./subagentRuntime";

describe("createSpawnTool", () => {
  test("spawns a background subagent with the active session context", async () => {
    const requests: SubagentSpawnRequest[] = [];
    const tool = createSpawnTool({
      runtime: {
        spawn: async (request): Promise<SubagentSpawnResult> => {
          requests.push(request);
          return {
            id: "subagent-1",
            label: "Inspect docs",
            message: "Subagent [Inspect docs] started (id: subagent-1). Running: 1/5",
            queued: false,
            runningCount: 1,
            queuedCount: 0,
          };
        },
      },
    });

    const result = await tool.execute(
      { task: "Inspect the migration docs", label: "Inspect docs" },
      { runId: "run-1", traceId: "trace-1", sessionId: "desktop:chat-1" },
    );

    expect(tool.name).toBe("spawn");
    expect(tool.capabilities).toEqual(["background.write"]);
    expect(tool.requiresApproval).toBe(true);
    expect(result).toEqual({
      content: "Subagent [Inspect docs] started (id: subagent-1). Running: 1/5",
      metadata: {
        _background_event: true,
        _background_run_id: "subagent-1",
        _background_label: "Inspect docs",
        _background_status: "running",
      },
    });
    expect(requests).toEqual([
      {
        task: "Inspect the migration docs",
        label: "Inspect docs",
        sessionKey: "desktop:chat-1",
        metadata: { traceId: "trace-1", runId: "run-1", origin: "spawn_tool" },
      },
    ]);
  });

  test("rejects blank tasks before spawning", async () => {
    const tool = createSpawnTool({
      runtime: {
        spawn: async () => {
          throw new Error("should not spawn");
        },
      },
    });

    await expect(tool.execute({ task: "  " }, { runId: "run-1" })).resolves.toEqual({
      content: "Error: task is required for spawn action",
    });
  });
});
