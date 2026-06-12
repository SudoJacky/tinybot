import { describe, expect, it } from "vitest";

import type { AgentMessage } from "../agent/agentRunSpec";
import type { ModelProvider, ModelRequestOptions, ModelResponse } from "../model/provider";
import { CoworkScheduler } from "./coworkScheduler";
import { createCoworkTool } from "./coworkTool";
import { CoworkService, createMemoryCoworkStore, type CoworkServiceStore } from "./coworkService";
import { CoworkTeamPlanner } from "./coworkTeamPlanner";

const fixedNow = "2026-06-12T08:00:00.000Z";

function deterministicIds() {
  const counters = new Map<string, number>();
  return (prefix: string) => {
    const next = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, next);
    return `${prefix}_${next}`;
  };
}

function serviceWithStore(store: CoworkServiceStore = createMemoryCoworkStore()) {
  return new CoworkService({
    store,
    now: () => fixedNow,
    idGenerator: deterministicIds(),
  });
}

class QueueProvider implements ModelProvider {
  readonly options: ModelRequestOptions[] = [];

  constructor(private readonly responses: ModelResponse[]) {}

  async complete(_messages: AgentMessage[], options: ModelRequestOptions = {}): Promise<ModelResponse> {
    this.options.push({ ...options });
    const response = this.responses.shift();
    if (!response) {
      throw new Error("no queued model response");
    }
    return response;
  }
}

describe("createCoworkTool", () => {
  it("starts a cowork session from a blueprint and exposes read-only facade actions", async () => {
    const service = serviceWithStore();
    const tool = createCoworkTool({ service });
    const context = { runId: "run_1", traceId: "trace-tool" };

    const started = await tool.execute({
      action: "start",
      blueprint: {
        goal: "Migrate cowork tool facade",
        title: "Cowork facade",
        workflow_mode: "team",
        agents: [{ id: "lead", name: "Lead", role: "Coordinator" }],
        tasks: [{ id: "draft", title: "Draft facade", description: "Draft TS facade", assigned_agent_id: "lead" }],
      },
    }, context);

    expect(started.content).toContain("Cowork session started from blueprint: cw_1");
    expect(started.content).toContain("Cowork facade");
    expect(started.metadata).toMatchObject({ session_id: "cw_1", action: "start" });

    await expect(tool.execute({ action: "list" }, context)).resolves.toMatchObject({
      content: expect.stringContaining("- cw_1: Cowork facade [active]"),
    });
    await expect(tool.execute({ action: "status", session_id: "cw_1" }, context)).resolves.toMatchObject({
      content: expect.stringContaining("## Cowork facade (cw_1)"),
    });
    await expect(tool.execute({ action: "summary", session_id: "cw_1" }, context)).resolves.toMatchObject({
      content: expect.stringContaining("## Cowork facade (cw_1)"),
    });
    await expect(tool.execute({ action: "export_blueprint", session_id: "cw_1" }, context)).resolves.toMatchObject({
      content: expect.stringContaining('"schema_version": "cowork.blueprint.v1"'),
    });
  });

  it("uses the team planner when starting from a goal without explicit agents or tasks", async () => {
    const service = serviceWithStore();
    const provider = new QueueProvider([{
      content: "",
      stopReason: "tool_calls",
      toolCalls: [{
        id: "team-1",
        name: "submit_cowork_team",
        argumentsJson: JSON.stringify({
          title: "Planner Session",
          agents: [{ id: "lead", name: "Lead", role: "Coordinator", goal: "Plan", responsibilities: ["Coordinate"] }],
          tasks: [{ id: "lead_start", title: "Plan", description: "Plan work", assigned_agent_id: "lead" }],
        }),
      }],
    }]);
    const planner = new CoworkTeamPlanner({ provider, model: "test-model", workspace: "D:/code/tinybot/tinybot" });
    const tool = createCoworkTool({ service, planner });
    const context = { runId: "run_1", traceId: "trace-tool" };

    const started = await tool.execute({
      action: "start",
      goal: "Coordinate TS planner migration",
      workflow_mode: "team",
    }, context);

    expect(started.content).toContain("Cowork session started: cw_1");
    expect(started.content).toContain("Planner Session");
    const session = await service.getSession("cw_1", "assert");
    expect(session?.title).toBe("Planner Session");
    expect(Object.keys(session?.agents ?? {})).toEqual(["lead"]);
    expect(Object.keys(session?.tasks ?? {})).toEqual(["lead_start"]);
    expect(provider.options[0].toolChoice).toMatchObject({ type: "function", function: { name: "submit_cowork_team" } });
  });

  it("mutates an existing session through message, task, assignment, and control facade actions", async () => {
    const store = createMemoryCoworkStore();
    const service = serviceWithStore(store);
    const tool = createCoworkTool({ service });
    const context = { runId: "run_1", traceId: "trace-tool" };
    await service.createSession({
      traceId: "seed",
      goal: "Coordinate the migration",
      title: "Migration session",
      workflowMode: "team",
      agents: [{ id: "lead", name: "Lead" }],
      tasks: [{ id: "draft", title: "Draft", description: "Draft answer", assigned_agent_id: "lead" }],
    });

    await expect(tool.execute({
      action: "send_message",
      session_id: "cw_1",
      recipient_ids: ["lead"],
      content: "Please review the TS facade.",
    }, context)).resolves.toMatchObject({
      content: "Sent message msg_2.",
      metadata: { session_id: "cw_1", message_id: "msg_2", action: "send_message" },
    });

    await expect(tool.execute({
      action: "add_task",
      session_id: "cw_1",
      title: "Review facade",
      assigned_agent_id: "lead",
    }, context)).resolves.toMatchObject({
      content: "Added task task_1: Review facade",
      metadata: { session_id: "cw_1", task_id: "task_1", action: "add_task" },
    });

    await expect(tool.execute({
      action: "assign_task",
      session_id: "cw_1",
      task_id: "task_1",
      assigned_agent_id: "lead",
    }, context)).resolves.toMatchObject({
      content: "Task 'Review facade' assigned to Lead.",
    });

    await expect(tool.execute({ action: "pause", session_id: "cw_1" }, context)).resolves.toMatchObject({
      content: "Paused cowork session cw_1.",
    });
    await expect(tool.execute({ action: "resume", session_id: "cw_1" }, context)).resolves.toMatchObject({
      content: "Resumed cowork session cw_1.",
    });

    const snapshot = await store.readSnapshot("cw_1", "assert");
    expect(snapshot?.messages.msg_2.content).toBe("Please review the TS facade.");
    expect(snapshot?.tasks.task_1.assigned_agent_id).toBe("lead");
    expect(snapshot?.status).toBe("active");
  });

  it("runs an existing session through the TS scheduler facade", async () => {
    const store = createMemoryCoworkStore();
    const idGenerator = deterministicIds();
    const service = new CoworkService({
      store,
      now: () => fixedNow,
      idGenerator,
    });
    const scheduler = new CoworkScheduler({
      store,
      now: () => fixedNow,
      idGenerator,
    });
    const tool = createCoworkTool({ service, scheduler });
    const context = { runId: "run_1", traceId: "trace-tool" };
    await service.createSession({
      traceId: "seed",
      goal: "Coordinate the migration",
      title: "Migration session",
      workflowMode: "team",
      agents: [{ id: "lead", name: "Lead" }],
      tasks: [{ id: "draft", title: "Draft", description: "Draft answer", assigned_agent_id: "lead" }],
    });

    const result = await tool.execute({
      action: "run",
      session_id: "cw_1",
      max_rounds: 2,
      max_agents: 2,
    }, context);

    expect(result.content).toContain("Round 1: no ready agents.");
    expect(result.metadata).toMatchObject({ session_id: "cw_1", action: "run", run_id: "run_1" });
    expect(result.metadata).not.toMatchObject({ deferred: true });
    const snapshot = await store.readSnapshot("cw_1", "assert");
    expect(snapshot?.stop_reason).toBe("idle");
    expect(snapshot?.run_metrics).toHaveLength(1);
  });
});
