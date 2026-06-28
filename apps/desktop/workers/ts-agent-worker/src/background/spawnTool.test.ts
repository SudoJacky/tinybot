import { describe, expect, test } from "vitest";

import { DelegatedRunManager } from "./delegatedRun";
import { createDelegatedAgentTools, createSpawnTool } from "./spawnTool";
import { SubagentRuntime, type SubagentRunRequest } from "./subagentRuntime";

describe("createSpawnTool", () => {
  test("creates a delegated run and returns its final compact result with compatibility metadata", async () => {
    const requests: SubagentRunRequest[] = [];
    const runtime = new SubagentRuntime({
      idGenerator: () => "delegate-1",
      runner: async (request) => {
        requests.push(request);
        return { status: "completed", result: "inspection complete" };
      },
    });
    const manager = new DelegatedRunManager({
      runtime,
      now: () => "2026-06-27T12:00:00.000Z",
    });
    const tool = createSpawnTool({ manager });

    const result = await tool.execute(
      { task: "Inspect the migration docs", label: "Inspect docs" },
      { runId: "run-1", traceId: "trace-1", sessionId: "desktop:chat-1" },
    );

    expect(tool.name).toBe("spawn");
    expect(tool.capabilities).toEqual(["background.write"]);
    expect(tool.requiresApproval).toBe(true);
    expect(result).toMatchObject({
      content: "inspection complete",
      metadata: {
        _background_event: true,
        _background_run_id: "delegate-1",
        _background_label: "Inspect docs",
        _background_task: "Inspect the migration docs",
        _background_status: "completed",
        _delegate_event: true,
        _delegate_id: "delegate-1",
        _delegate_task_name: "inspect_docs",
        _delegate_status: "completed",
        _delegate_trace_ref: "trace-1",
        _delegate_task: "Inspect the migration docs",
      },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      id: "delegate-1",
      task: "Inspect the migration docs",
      label: "Inspect docs",
      sessionKey: "desktop:chat-1",
      metadata: {
        traceId: "trace-1",
        runId: "run-1",
        parentRunId: "run-1",
        parentTurnId: "run-1",
        origin: "delegated_run",
        taskName: "inspect_docs",
      },
    });
  });

  test("rejects blank tasks before spawning", async () => {
    const runtime = new SubagentRuntime({
      runner: async () => {
        throw new Error("should not spawn");
      },
    });
    const tool = createSpawnTool({ manager: new DelegatedRunManager({ runtime }) });

    await expect(tool.execute({ task: "  " }, { runId: "run-1" })).resolves.toEqual({
      content: "Error: task is required for spawn action",
    });
  });
});

describe("createDelegatedAgentTools", () => {
  test("exposes delegated agent schemas and operations", async () => {
    const runtime = new SubagentRuntime({
      idGenerator: () => "delegate-1",
      runner: async () => ({ status: "completed", result: "review complete" }),
    });
    const manager = new DelegatedRunManager({
      runtime,
      now: () => "2026-06-27T12:00:00.000Z",
    });
    const tools = Object.fromEntries(createDelegatedAgentTools({ manager }).map((tool) => [tool.name, tool]));

    expect(Object.keys(tools)).toEqual([
      "spawn_agent",
      "wait_agent",
      "list_agents",
      "send_message",
      "close_agent",
    ]);
    expect(tools.spawn_agent.parameters).toMatchObject({
      required: ["task_name", "message"],
      properties: {
        task_name: { type: "string" },
        message: { type: "string" },
        fork_turns: { type: "string" },
        permission_profile: { type: "string" },
      },
    });
    expect(tools.wait_agent.parameters).toMatchObject({
      properties: {
        target: { type: "string" },
        targets: { type: "array" },
        timeout_ms: { type: "integer" },
      },
    });

    const spawn = await tools.spawn_agent.execute(
      {
        task_name: "Review Docs",
        message: "Review docs",
        label: "Docs",
        fork_turns: "3",
        permission_profile: "workspace_write",
      },
      { runId: "run-1", traceId: "trace-1", sessionId: "desktop:chat-1" },
    );
    expect(spawn.metadata).toMatchObject({
      _delegate_id: "delegate-1",
      _delegate_task_name: "review_docs",
      _delegate_status: "running",
      _delegate_trace_ref: "trace-1",
      _delegate_task: "Review docs",
      _delegate_parent_run_id: "run-1",
    });
    expect(spawn.content).toContain("\"delegateId\": \"delegate-1\"");
    expect(spawn.content).not.toContain("review complete");

    const wait = await tools.wait_agent.execute(
      { target: "delegate-1", timeout_ms: 1000 },
      { runId: "run-1", traceId: "trace-1", sessionId: "desktop:chat-1" },
    );
    expect(wait.content).toContain("\"summary\": \"review complete\"");
    expect(wait.metadata).toMatchObject({
      _delegated_wait: true,
      _delegated_active: [],
      _delegated_timed_out: [],
    });

    const list = await tools.list_agents.execute({}, { runId: "run-1", sessionId: "desktop:chat-1" });
    expect(list.content).toContain("\"delegateId\": \"delegate-1\"");

    const message = await tools.send_message.execute(
      { target: "delegate-1", message: "Please include tests", trigger_followup: true },
      { runId: "run-1" },
    );
    expect(message.content).toContain("\"message\": \"Please include tests\"");

    const close = await tools.close_agent.execute({ target: "delegate-1" }, { runId: "run-1" });
    expect(close.metadata).toMatchObject({
      _delegate_id: "delegate-1",
      _delegate_status: "closed",
    });
  });
});
