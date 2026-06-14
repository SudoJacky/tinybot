import { describe, expect, it } from "vitest";

import { createMemoryCoworkStore, CoworkService, type CoworkIdGenerator } from "./coworkService";
import { createCoworkInternalTool } from "./coworkInternalTool";

const fixedNow = "2026-06-12T08:00:00.000Z";

function deterministicIds(): CoworkIdGenerator {
  const counters = new Map<string, number>();
  return (prefix: string) => {
    const next = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, next);
    return `${prefix}_${next}`;
  };
}

describe("cowork_internal tool", () => {
  it("marks non-swarm sessions completed after the final task is completed", async () => {
    const store = createMemoryCoworkStore();
    const idGenerator = deterministicIds();
    const service = new CoworkService({
      store,
      now: () => fixedNow,
      idGenerator,
    });
    const session = await service.createSession({
      traceId: "trace-create",
      goal: "Finish the migration",
      title: "Migration",
      workflowMode: "team",
      agents: [{
        id: "lead",
        name: "Lead",
        role: "Lead",
        goal: "Coordinate",
        responsibilities: ["Finish"],
      }],
      tasks: [{
        id: "finish",
        title: "Finish",
        description: "Complete the work",
        assigned_agent_id: "lead",
      }],
    });
    const tool = createCoworkInternalTool({
      store,
      sessionId: session.id,
      senderId: "lead",
      now: () => fixedNow,
      idGenerator,
    });

    await tool.execute({
      action: "complete_task",
      task_id: "finish",
      content: "All migration work is complete.",
    }, { runId: "run-1", traceId: "trace-complete" });

    const saved = await store.readSnapshot(session.id, "trace-read");
    expect(saved).toMatchObject({
      status: "completed",
      current_focus_task: "",
      completion_decision: {
        next_action: "complete",
        ready_to_finish: true,
        reason: "All tasks are complete and there are no unresolved reply requests.",
      },
    });
    expect(saved?.agents.lead.status).toBe("done");
    expect(saved?.tasks.finish.status).toBe("completed");
    expect(saved?.tasks.finish.result_data).toEqual({});
    expect(saved?.tasks.finish.confidence).toBeNull();
  });

  it("preserves skipped status when completing internal tasks", async () => {
    const store = createMemoryCoworkStore();
    const idGenerator = deterministicIds();
    const service = new CoworkService({
      store,
      now: () => fixedNow,
      idGenerator,
    });
    const session = await service.createSession({
      traceId: "trace-create",
      goal: "Skip optional work",
      title: "Skip task",
      workflowMode: "team",
      agents: [{
        id: "lead",
        name: "Lead",
        role: "Lead",
        goal: "Coordinate",
        responsibilities: ["Decide"],
      }],
      tasks: [{
        id: "optional",
        title: "Optional",
        description: "Optional work",
        assigned_agent_id: "lead",
      }],
    });
    const tool = createCoworkInternalTool({
      store,
      sessionId: session.id,
      senderId: "lead",
      now: () => fixedNow,
      idGenerator,
    });

    await tool.execute({
      action: "complete_task",
      task_id: "optional",
      status: "skipped",
      content: "No longer needed.",
    }, { runId: "run-1", traceId: "trace-skip" });

    const saved = await store.readSnapshot(session.id, "trace-read");
    expect(saved?.tasks.optional).toMatchObject({
      status: "skipped",
      result: "No longer needed.",
      error: null,
    });
    expect(saved?.events.at(-1)).toMatchObject({
      type: "task.skipped",
      message: "Task 'Optional' skipped by lead",
    });
    expect(saved?.trace_spans.at(-1)).toMatchObject({
      name: "Task skipped",
      status: "skipped",
    });
    expect(saved?.status).toBe("active");
    expect(saved?.agents.lead.status).toBe("idle");
    expect(saved?.completion_decision).toMatchObject({
      next_action: "review_goal_completion",
      reason: "Known task results appear sufficient.",
      ready_to_finish: false,
      goal_review: {
        ready: false,
        missing: [],
      },
    });
  });

  it("leaves confidence unset when structured task results omit confidence", async () => {
    const store = createMemoryCoworkStore();
    const idGenerator = deterministicIds();
    const service = new CoworkService({
      store,
      now: () => fixedNow,
      idGenerator,
    });
    const session = await service.createSession({
      traceId: "trace-create",
      goal: "Capture structured output",
      title: "Structured result",
      workflowMode: "team",
      agents: [{
        id: "lead",
        name: "Lead",
        role: "Lead",
        goal: "Coordinate",
        responsibilities: ["Finish"],
      }],
      tasks: [{
        id: "finish",
        title: "Finish",
        description: "Complete the work",
        assigned_agent_id: "lead",
      }],
    });
    const tool = createCoworkInternalTool({
      store,
      sessionId: session.id,
      senderId: "lead",
      now: () => fixedNow,
      idGenerator,
    });

    await tool.execute({
      action: "complete_task",
      task_id: "finish",
      content: JSON.stringify({ answer: "All work is complete." }),
    }, { runId: "run-1", traceId: "trace-complete" });

    const saved = await store.readSnapshot(session.id, "trace-read");
    expect(saved?.tasks.finish.result_data).toEqual({ answer: "All work is complete." });
    expect(saved?.tasks.finish.confidence).toBeNull();
    expect(saved?.trace_spans.at(-1)?.data).toMatchObject({
      task_id: "finish",
      confidence: null,
      result_data: { answer: "All work is complete." },
    });
  });

  it("ignores non-string workspace directories in structured task results", async () => {
    const store = createMemoryCoworkStore();
    const idGenerator = deterministicIds();
    const service = new CoworkService({
      store,
      now: () => fixedNow,
      idGenerator,
    });
    const session = await service.createSession({
      traceId: "trace-create",
      goal: "Keep workspace stable",
      title: "Workspace result",
      workflowMode: "team",
      agents: [{
        id: "lead",
        name: "Lead",
        role: "Lead",
        goal: "Coordinate",
        responsibilities: ["Finish"],
      }],
      tasks: [{
        id: "finish",
        title: "Finish",
        description: "Complete the work",
        assigned_agent_id: "lead",
      }],
    });
    const originalWorkspaceDir = session.workspace_dir;
    const tool = createCoworkInternalTool({
      store,
      sessionId: session.id,
      senderId: "lead",
      now: () => fixedNow,
      idGenerator,
    });

    await tool.execute({
      action: "complete_task",
      task_id: "finish",
      content: JSON.stringify({
        answer: "All work is complete.",
        output_dir: 123,
        workspace_dir: { path: "bad" },
      }),
    }, { runId: "run-1", traceId: "trace-complete" });

    const saved = await store.readSnapshot(session.id, "trace-read");
    expect(saved?.workspace_dir).toBe(originalWorkspaceDir);
  });

  it("ignores non-list non-string artifact fields in structured task results", async () => {
    const store = createMemoryCoworkStore();
    const idGenerator = deterministicIds();
    const service = new CoworkService({
      store,
      now: () => fixedNow,
      idGenerator,
    });
    const session = await service.createSession({
      traceId: "trace-create",
      goal: "Keep artifacts clean",
      title: "Artifact result",
      workflowMode: "team",
      agents: [{
        id: "lead",
        name: "Lead",
        role: "Lead",
        goal: "Coordinate",
        responsibilities: ["Finish"],
      }],
      tasks: [{
        id: "finish",
        title: "Finish",
        description: "Complete the work",
        assigned_agent_id: "lead",
      }],
    });
    const tool = createCoworkInternalTool({
      store,
      sessionId: session.id,
      senderId: "lead",
      now: () => fixedNow,
      idGenerator,
    });

    await tool.execute({
      action: "complete_task",
      task_id: "finish",
      content: JSON.stringify({
        answer: "All work is complete.",
        artifacts: 123,
        files: { path: "bad" },
        paths: "/tmp/report.md",
      }),
    }, { runId: "run-1", traceId: "trace-complete" });

    const saved = await store.readSnapshot(session.id, "trace-read");
    expect(saved?.artifacts).toEqual(["/tmp/report.md"]);
    expect(saved?.shared_memory.artifacts.map((entry) => entry.text)).toEqual(["/tmp/report.md"]);
  });

  it("ignores non-list non-string shared-memory fields in structured task results", async () => {
    const store = createMemoryCoworkStore();
    const idGenerator = deterministicIds();
    const service = new CoworkService({
      store,
      now: () => fixedNow,
      idGenerator,
    });
    const session = await service.createSession({
      traceId: "trace-create",
      goal: "Keep shared memory clean",
      title: "Shared memory result",
      workflowMode: "team",
      agents: [{
        id: "lead",
        name: "Lead",
        role: "Lead",
        goal: "Coordinate",
        responsibilities: ["Finish"],
      }],
      tasks: [{
        id: "finish",
        title: "Finish",
        description: "Complete the work",
        assigned_agent_id: "lead",
      }],
    });
    const tool = createCoworkInternalTool({
      store,
      sessionId: session.id,
      senderId: "lead",
      now: () => fixedNow,
      idGenerator,
    });

    await tool.execute({
      action: "complete_task",
      task_id: "finish",
      content: JSON.stringify({
        answer: "All work is complete.",
        findings: 123,
        claims: { claim: "bad" },
        risks: "Valid risk",
        decisions: ["Valid decision"],
        open_questions: 456,
      }),
    }, { runId: "run-1", traceId: "trace-complete" });

    const saved = await store.readSnapshot(session.id, "trace-read");
    expect(saved?.shared_memory.findings).toEqual([]);
    expect(saved?.shared_memory.claims.map((entry) => entry.text)).toEqual(["All work is complete."]);
    expect(saved?.shared_memory.risks.map((entry) => entry.text)).toEqual(["Valid risk"]);
    expect(saved?.shared_memory.decisions.map((entry) => entry.text)).toEqual(["Valid decision"]);
    expect(saved?.shared_memory.open_questions).toEqual([]);
  });

  it("falls back to workspace_dir when structured output_dir is blank", async () => {
    const store = createMemoryCoworkStore();
    const idGenerator = deterministicIds();
    const service = new CoworkService({
      store,
      now: () => fixedNow,
      idGenerator,
    });
    const session = await service.createSession({
      traceId: "trace-create",
      goal: "Use workspace fallback",
      title: "Workspace fallback",
      workflowMode: "team",
      agents: [{
        id: "lead",
        name: "Lead",
        role: "Lead",
        goal: "Coordinate",
        responsibilities: ["Finish"],
      }],
      tasks: [{
        id: "finish",
        title: "Finish",
        description: "Complete the work",
        assigned_agent_id: "lead",
      }],
    });
    const tool = createCoworkInternalTool({
      store,
      sessionId: session.id,
      senderId: "lead",
      now: () => fixedNow,
      idGenerator,
    });

    await tool.execute({
      action: "complete_task",
      task_id: "finish",
      content: JSON.stringify({
        answer: "All work is complete.",
        output_dir: "   ",
        workspace_dir: " /tmp/cowork-output ",
      }),
    }, { runId: "run-1", traceId: "trace-complete" });

    const saved = await store.readSnapshot(session.id, "trace-read");
    expect(saved?.workspace_dir).toBe("/tmp/cowork-output");
  });

  it("keeps sessions active when completed task results still contain open questions", async () => {
    const store = createMemoryCoworkStore();
    const idGenerator = deterministicIds();
    const service = new CoworkService({
      store,
      now: () => fixedNow,
      idGenerator,
    });
    const session = await service.createSession({
      traceId: "trace-create",
      goal: "Resolve the architecture decision",
      title: "Open questions",
      workflowMode: "team",
      agents: [{
        id: "lead",
        name: "Lead",
        role: "Lead",
        goal: "Coordinate",
        responsibilities: ["Finish"],
      }],
      tasks: [{
        id: "finish",
        title: "Finish",
        description: "Complete the decision",
        assigned_agent_id: "lead",
      }],
    });
    const tool = createCoworkInternalTool({
      store,
      sessionId: session.id,
      senderId: "lead",
      now: () => fixedNow,
      idGenerator,
    });

    await tool.execute({
      action: "complete_task",
      task_id: "finish",
      content: JSON.stringify({
        answer: "The decision is mostly complete.",
        open_questions: ["Confirm rollout owner."],
      }),
    }, { runId: "run-1", traceId: "trace-complete" });

    const saved = await store.readSnapshot(session.id, "trace-read");
    expect(saved?.status).toBe("active");
    expect(saved?.current_focus_task).toBe("Completed work still contains open questions.");
    expect(saved?.completion_decision).toMatchObject({
      next_action: "review_goal_completion",
      reason: "Completed work still contains open questions.",
      ready_to_finish: false,
      goal_review: {
        ready: false,
        missing: ["open_questions"],
      },
    });
    expect(saved?.agents.lead.status).toBe("idle");
  });

  it("keeps sessions active when review-required task results have not passed review", async () => {
    const store = createMemoryCoworkStore();
    const idGenerator = deterministicIds();
    const service = new CoworkService({
      store,
      now: () => fixedNow,
      idGenerator,
    });
    const session = await service.createSession({
      traceId: "trace-create",
      goal: "Review the migration result",
      title: "Review gates",
      workflowMode: "team",
      agents: [{
        id: "lead",
        name: "Lead",
        role: "Lead",
        goal: "Coordinate",
        responsibilities: ["Finish"],
      }],
      tasks: [{
        id: "finish",
        title: "Finish",
        description: "Complete the reviewed output",
        assigned_agent_id: "lead",
        review_required: true,
        reviewer_agent_ids: ["lead"],
      }],
    });
    const tool = createCoworkInternalTool({
      store,
      sessionId: session.id,
      senderId: "lead",
      now: () => fixedNow,
      idGenerator,
    });

    await tool.execute({
      action: "complete_task",
      task_id: "finish",
      content: JSON.stringify({
        answer: "The reviewed output is ready.",
      }),
    }, { runId: "run-1", traceId: "trace-complete" });

    const saved = await store.readSnapshot(session.id, "trace-read");
    expect(saved?.status).toBe("active");
    expect(saved?.current_focus_task).toBe("Review-required outputs have not passed review.");
    expect(saved?.completion_decision).toMatchObject({
      next_action: "review_goal_completion",
      reason: "Review-required outputs have not passed review.",
      ready_to_finish: false,
      goal_review: {
        ready: false,
        missing: ["review_gates"],
      },
    });
    expect(saved?.agents.lead.status).toBe("idle");
  });

  it("keeps delivery-oriented sessions active until artifact paths are confirmed", async () => {
    const store = createMemoryCoworkStore();
    const idGenerator = deterministicIds();
    const service = new CoworkService({
      store,
      now: () => fixedNow,
      idGenerator,
    });
    const session = await service.createSession({
      traceId: "trace-create",
      goal: "Write file with the migration summary",
      title: "Artifact gate",
      workflowMode: "team",
      agents: [{
        id: "lead",
        name: "Lead",
        role: "Lead",
        goal: "Coordinate",
        responsibilities: ["Finish"],
      }],
      tasks: [{
        id: "finish",
        title: "Finish",
        description: "Write the file",
        assigned_agent_id: "lead",
      }],
    });
    const tool = createCoworkInternalTool({
      store,
      sessionId: session.id,
      senderId: "lead",
      now: () => fixedNow,
      idGenerator,
    });

    await tool.execute({
      action: "complete_task",
      task_id: "finish",
      content: JSON.stringify({
        answer: "The migration summary is described here.",
      }),
    }, { runId: "run-1", traceId: "trace-complete" });

    const saved = await store.readSnapshot(session.id, "trace-read");
    expect(saved?.status).toBe("active");
    expect(saved?.current_focus_task).toBe("The goal appears to require concrete deliverables, but no artifact paths are confirmed yet.");
    expect(saved?.completion_decision).toMatchObject({
      next_action: "review_goal_completion",
      reason: "The goal appears to require concrete deliverables, but no artifact paths are confirmed yet.",
      ready_to_finish: false,
      goal_review: {
        ready: false,
        missing: ["artifacts"],
      },
    });
    expect(saved?.agents.lead.status).toBe("idle");
  });

  it("keeps Chinese delivery-oriented sessions active until artifact paths are confirmed", async () => {
    const store = createMemoryCoworkStore();
    const idGenerator = deterministicIds();
    const service = new CoworkService({
      store,
      now: () => fixedNow,
      idGenerator,
    });
    const session = await service.createSession({
      traceId: "trace-create",
      goal: "写文件，总结迁移结果",
      title: "中文交付物检查",
      workflowMode: "team",
      agents: [{
        id: "lead",
        name: "Lead",
        role: "Lead",
        goal: "Coordinate",
        responsibilities: ["Finish"],
      }],
      tasks: [{
        id: "finish",
        title: "Finish",
        description: "Write the file",
        assigned_agent_id: "lead",
      }],
    });
    const tool = createCoworkInternalTool({
      store,
      sessionId: session.id,
      senderId: "lead",
      now: () => fixedNow,
      idGenerator,
    });

    await tool.execute({
      action: "complete_task",
      task_id: "finish",
      content: JSON.stringify({
        answer: "迁移结果已总结。",
      }),
    }, { runId: "run-1", traceId: "trace-complete" });

    const saved = await store.readSnapshot(session.id, "trace-read");
    expect(saved?.status).toBe("active");
    expect(saved?.completion_decision).toMatchObject({
      next_action: "review_goal_completion",
      reason: "The goal appears to require concrete deliverables, but no artifact paths are confirmed yet.",
      ready_to_finish: false,
      goal_review: {
        ready: false,
        missing: ["artifacts"],
      },
    });
  });

  it("keeps fanout sessions active until fanout work has an explicit merge", async () => {
    const store = createMemoryCoworkStore();
    const idGenerator = deterministicIds();
    const service = new CoworkService({
      store,
      now: () => fixedNow,
      idGenerator,
    });
    const session = await service.createSession({
      traceId: "trace-create",
      goal: "Compare implementation options",
      title: "Fanout gate",
      workflowMode: "team",
      agents: [{
        id: "lead",
        name: "Lead",
        role: "Lead",
        goal: "Coordinate",
        responsibilities: ["Finish"],
      }],
      tasks: [
        {
          id: "option-a",
          title: "Option A",
          description: "Evaluate option A",
          assigned_agent_id: "lead",
          fanout_group_id: "compare",
        },
        {
          id: "option-b",
          title: "Option B",
          description: "Evaluate option B",
          assigned_agent_id: "lead",
          fanout_group_id: "compare",
        },
      ],
    });
    const tool = createCoworkInternalTool({
      store,
      sessionId: session.id,
      senderId: "lead",
      now: () => fixedNow,
      idGenerator,
    });

    await tool.execute({
      action: "complete_task",
      task_id: "option-a",
      content: JSON.stringify({ answer: "Option A works." }),
    }, { runId: "run-1", traceId: "trace-a" });
    await tool.execute({
      action: "complete_task",
      task_id: "option-b",
      content: JSON.stringify({ answer: "Option B works." }),
    }, { runId: "run-2", traceId: "trace-b" });

    const saved = await store.readSnapshot(session.id, "trace-read");
    expect(saved?.status).toBe("active");
    expect(saved?.current_focus_task).toBe("Fanout work needs an explicit merge or synthesis task.");
    expect(saved?.completion_decision).toMatchObject({
      next_action: "review_goal_completion",
      reason: "Fanout work needs an explicit merge or synthesis task.",
      ready_to_finish: false,
      goal_review: {
        ready: false,
        missing: ["fanout_merge"],
      },
    });
  });

  it("keeps sessions active when completed task results contain disagreement signals", async () => {
    const store = createMemoryCoworkStore();
    const idGenerator = deterministicIds();
    const service = new CoworkService({
      store,
      now: () => fixedNow,
      idGenerator,
    });
    const session = await service.createSession({
      traceId: "trace-create",
      goal: "Choose the safest runtime option",
      title: "Disagreement gate",
      workflowMode: "team",
      agents: [{
        id: "lead",
        name: "Lead",
        role: "Lead",
        goal: "Coordinate",
        responsibilities: ["Finish"],
      }],
      tasks: [{
        id: "finish",
        title: "Finish",
        description: "Resolve the runtime option",
        assigned_agent_id: "lead",
      }],
    });
    const tool = createCoworkInternalTool({
      store,
      sessionId: session.id,
      senderId: "lead",
      now: () => fixedNow,
      idGenerator,
    });

    await tool.execute({
      action: "complete_task",
      task_id: "finish",
      content: JSON.stringify({
        answer: "Option A is likely safest.",
        disagreements: ["Reviewer says option B has lower migration risk."],
      }),
    }, { runId: "run-1", traceId: "trace-complete" });

    const saved = await store.readSnapshot(session.id, "trace-read");
    expect(saved?.status).toBe("active");
    expect(saved?.current_focus_task).toBe("Completed work contains disagreement signals requiring synthesis.");
    expect(saved?.completion_decision).toMatchObject({
      next_action: "review_goal_completion",
      reason: "Completed work contains disagreement signals requiring synthesis.",
      ready_to_finish: false,
      goal_review: {
        ready: false,
        missing: ["disagreements"],
      },
    });
  });
});
