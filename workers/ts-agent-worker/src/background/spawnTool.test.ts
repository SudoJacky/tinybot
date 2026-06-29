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
      "followup_task",
      "interrupt_agent",
      "close_agent",
    ]);
    expect(tools.spawn_agent.parameters).toMatchObject({
      required: ["task_name", "message"],
      properties: {
        task_name: { type: "string" },
        message: { type: "string" },
        fork_context: { type: "boolean" },
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
    expect(tools.list_agents.parameters).toMatchObject({
      properties: {
        path_prefix: { type: "string" },
        status: { type: "string" },
      },
    });
    expect(tools.send_message.parameters.properties).not.toHaveProperty("trigger_followup");

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
      _delegated_awaiting_approval: [],
      _delegated_timed_out: [],
    });

    const list = await tools.list_agents.execute({}, { runId: "run-1", sessionId: "desktop:chat-1" });
    expect(list.content).toContain("\"delegateId\": \"delegate-1\"");

    const message = await tools.send_message.execute(
      { target: "delegate-1", message: "Please include tests", trigger_followup: true },
      { runId: "run-1" },
    );
    expect(message.content).toContain("\"message\": \"Please include tests\"");
    expect(message.content).toContain("\"triggerFollowup\": false");

    const followup = await tools.followup_task.execute(
      { target: "delegate-1", message: "Now summarize the tests" },
      { runId: "run-1" },
    );
    expect(followup.metadata).toMatchObject({
      _delegate_id: "delegate-1",
      _delegate_status: "running",
    });
    const followupWait = await tools.wait_agent.execute(
      { target: "delegate-1", timeout_ms: 1000 },
      { runId: "run-1" },
    );
    expect(followupWait.content).toContain("\"summary\": \"review complete\"");

    const close = await tools.close_agent.execute({ target: "delegate-1" }, { runId: "run-1" });
    expect(close.metadata).toMatchObject({
      _delegate_id: "delegate-1",
      _delegate_status: "closed",
    });
  });

  test("interrupt_agent cancels an active delegated run", async () => {
    const runtime = new SubagentRuntime({
      idGenerator: () => "delegate-interrupt",
      runner: async (request) => new Promise((resolve) => {
        request.signal.addEventListener("abort", () => resolve({
          status: "failed",
          result: "Subagent cancelled.",
          error: "Subagent cancelled.",
        }), { once: true });
      }),
    });
    const manager = new DelegatedRunManager({
      runtime,
      now: () => "2026-06-27T12:00:00.000Z",
    });
    const tools = Object.fromEntries(createDelegatedAgentTools({ manager }).map((tool) => [tool.name, tool]));

    await tools.spawn_agent.execute(
      { task_name: "Long task", message: "Keep running" },
      { runId: "run-1", traceId: "trace-1", sessionId: "desktop:chat-1" },
    );
    const interrupt = await tools.interrupt_agent.execute(
      { target: "delegate-interrupt" },
      { runId: "run-1" },
    );

    expect(interrupt.content).toContain("\"status\": \"cancelled\"");
    expect(interrupt.metadata).toMatchObject({
      _delegate_id: "delegate-interrupt",
      _delegate_status: "cancelled",
    });
  });

  test("requires a stable task_name for Codex-style spawn_agent arguments", async () => {
    const requests: SubagentRunRequest[] = [];
    const runtime = new SubagentRuntime({
      idGenerator: () => "delegate-codex",
      runner: async (request) => {
        requests.push(request);
        return { status: "completed", result: "child final output" };
      },
    });
    const manager = new DelegatedRunManager({
      runtime,
      now: () => "2026-06-27T12:00:00.000Z",
    });
    const tools = Object.fromEntries(createDelegatedAgentTools({ manager }).map((tool) => [tool.name, tool]));

    await expect(tools.spawn_agent.execute(
      {
        message: "Review the approval flow and summarize risks",
        fork_context: true,
        model: "test-model",
      },
      { runId: "run-1", traceId: "trace-1", sessionId: "desktop:chat-1" },
    )).rejects.toThrow("task_name is required for spawn_agent");
    expect(requests).toEqual([]);
  });

  test("filters listed delegated agents by path prefix", async () => {
    const runtime = new SubagentRuntime({
      idGenerator: (() => {
        let index = 0;
        return () => `delegate-${index += 1}`;
      })(),
      runner: async () => new Promise(() => {}),
    });
    const manager = new DelegatedRunManager({
      runtime,
      now: () => "2026-06-27T12:00:00.000Z",
    });
    const tools = Object.fromEntries(createDelegatedAgentTools({ manager }).map((tool) => [tool.name, tool]));

    await tools.spawn_agent.execute(
      { task_name: "Research API", message: "Research API docs" },
      { runId: "run-1", sessionId: "desktop:chat-1" },
    );
    await tools.spawn_agent.execute(
      { task_name: "Write Summary", message: "Write a summary" },
      { runId: "run-1", sessionId: "desktop:chat-1" },
    );

    const result = await tools.list_agents.execute(
      { path_prefix: "/research" },
      { runId: "run-1", sessionId: "desktop:chat-1" },
    );

    expect(result.content).toContain("\"taskName\": \"research_api\"");
    expect(result.content).not.toContain("\"taskName\": \"write_summary\"");
    expect(result.metadata?._delegated_runs).toEqual([
      expect.objectContaining({ _delegate_task_name: "research_api" }),
    ]);
  });

  test("restores persisted delegated runs before listing and waiting", async () => {
    const runtime = new SubagentRuntime({
      runner: async () => {
        throw new Error("restored completed run should not start a child turn");
      },
    });
    const manager = new DelegatedRunManager({
      runtime,
      runStore: {
        listRuns: async () => [{
          id: "delegate-restored",
          kind: "subagent",
          source: "subagent",
          status: "completed",
          label: "Say hello",
          sessionKey: "WebSocket:chat-1",
          startedAtMs: 1000,
          updatedAtMs: 2000,
          completedAtMs: 2000,
          result: "你好",
          error: null,
          metadata: {
            parentRunId: "parent-run",
            parentTurnId: "turn-1",
            taskName: "say_hello",
            traceId: "trace-restored",
            delegatedContextPack: {
              kind: "delegated_context_pack",
              taskName: "say_hello",
              message: "Say hello",
              parentRunId: "parent-run",
              parentTurnId: "turn-1",
              parentSessionKey: "WebSocket:chat-1",
              forkTurns: "none",
              forkedMessages: [],
              runtimePolicy: {
                permissionProfile: "read_only",
                approvalPolicy: "ask_on_sensitive_action",
              },
              outputContract: "Return a compact result.",
            },
          },
        }],
      },
      now: () => "2026-06-27T12:00:00.000Z",
    });
    const tools = Object.fromEntries(createDelegatedAgentTools({ manager }).map((tool) => [tool.name, tool]));

    const list = await tools.list_agents.execute({}, { runId: "run-live", sessionId: "WebSocket:chat-1" });
    expect(list.content).toContain("\"delegateId\": \"delegate-restored\"");
    expect(list.content).toContain("\"status\": \"completed\"");
    expect(list.content).toContain("\"traceRef\": \"trace-restored\"");

    const wait = await tools.wait_agent.execute(
      { target: "delegate-restored", timeout_ms: 0 },
      { runId: "run-live", sessionId: "WebSocket:chat-1" },
    );
    expect(wait.content).toContain("\"completed\": [");
    expect(wait.content).toContain("\"delegate-restored\"");
    expect(wait.content).toContain("\"summary\": \"你好\"");
  });

  test("marks persisted active delegated runs as failed when no live runtime owns them", async () => {
    const runtime = new SubagentRuntime({
      runner: async () => {
        throw new Error("orphaned persisted run should not restart implicitly");
      },
    });
    const manager = new DelegatedRunManager({
      runtime,
      runStore: {
        listRuns: async () => [{
          id: "delegate-orphaned",
          kind: "subagent",
          source: "subagent",
          status: "running",
          label: "Long review",
          sessionKey: "WebSocket:chat-1",
          startedAtMs: 1000,
          updatedAtMs: 2000,
          result: "Subagent [Long review] started",
          error: null,
          metadata: {
            parentRunId: "parent-run",
            parentTurnId: "turn-1",
            taskName: "long_review",
            traceId: "trace-orphaned",
            delegatedContextPack: {
              kind: "delegated_context_pack",
              taskName: "long_review",
              message: "Review for a long time",
              parentRunId: "parent-run",
              parentTurnId: "turn-1",
              parentSessionKey: "WebSocket:chat-1",
              forkTurns: "none",
              forkedMessages: [],
              runtimePolicy: {
                permissionProfile: "read_only",
                approvalPolicy: "ask_on_sensitive_action",
              },
              outputContract: "Return a compact result.",
            },
          },
        }],
      },
      now: () => "2026-06-27T12:00:00.000Z",
    });
    const tools = Object.fromEntries(createDelegatedAgentTools({ manager }).map((tool) => [tool.name, tool]));

    const wait = await tools.wait_agent.execute(
      { target: "delegate-orphaned", timeout_ms: 0 },
      { runId: "run-live", sessionId: "WebSocket:chat-1" },
    );

    expect(wait.content).toContain("\"failed\": [");
    expect(wait.content).toContain("\"delegate-orphaned\"");
    expect(wait.content).toContain("no live delegated runtime owns it");
    expect(wait.metadata).toMatchObject({
      _delegated_active: [],
      _delegated_failed: ["delegate-orphaned"],
      _delegated_timed_out: [],
    });
  });

  test("buckets wait_agent results by final delegated status", async () => {
    const runtime = new SubagentRuntime({
      idGenerator: (() => {
        let index = 0;
        return () => `delegate-${index += 1}`;
      })(),
      runner: async (request) => request.id === "delegate-2"
        ? { status: "failed", result: "failed summary", error: "failed summary" }
        : { status: "completed", result: "completed summary" },
    });
    const manager = new DelegatedRunManager({
      runtime,
      now: () => "2026-06-27T12:00:00.000Z",
    });
    const tools = Object.fromEntries(createDelegatedAgentTools({ manager }).map((tool) => [tool.name, tool]));

    await tools.spawn_agent.execute(
      { task_name: "Done Task", message: "Complete this task" },
      { runId: "run-1", sessionId: "desktop:chat-1" },
    );
    await tools.spawn_agent.execute(
      { task_name: "Fail Task", message: "Fail this task" },
      { runId: "run-1", sessionId: "desktop:chat-1" },
    );

    const result = await tools.wait_agent.execute(
      { targets: ["delegate-1", "delegate-2"], timeout_ms: 1000 },
      { runId: "run-1", sessionId: "desktop:chat-1" },
    );

    expect(result.content).toContain("\"completed\": [");
    expect(result.content).toContain("\"delegate-1\"");
    expect(result.content).toContain("\"failed\": [");
    expect(result.content).toContain("\"delegate-2\"");
    expect(result.metadata).toMatchObject({
      _delegated_completed: ["delegate-1"],
      _delegated_failed: ["delegate-2"],
    });
  });
});
