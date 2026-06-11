import { describe, expect, test } from "vitest";

import { createTaskTool } from "./taskTool";
import type { TaskPlan } from "./taskTypes";

function basePlan(): TaskPlan {
  return {
    id: "plan-1",
    title: "Backend migration",
    originalRequest: "Move backend runtime to TS",
    status: "executing",
    currentSubtaskIds: [],
    context: {},
    subtasks: [
      {
        id: "a",
        title: "Foundation",
        description: "Build foundation",
        status: "completed",
        dependencies: [],
        parallelSafe: true,
        result: "Foundation done",
        error: null,
        startedAt: null,
        completedAt: null,
        retryCount: 0,
        maxRetries: 2,
      },
      {
        id: "b",
        title: "Runtime",
        description: "Build runtime",
        status: "pending",
        dependencies: ["a"],
        parallelSafe: false,
        result: null,
        error: null,
        startedAt: null,
        completedAt: null,
        retryCount: 0,
        maxRetries: 2,
      },
    ],
  };
}

function memoryBridge(initialPlans: TaskPlan[]) {
  const plans = new Map(initialPlans.map((plan) => [plan.id, structuredClone(plan)]));
  return {
    listPlans: async () => [...plans.values()].map((plan) => structuredClone(plan)),
    getPlan: async (planId: string) => structuredClone(plans.get(planId) ?? null),
    savePlan: async (plan: TaskPlan) => {
      const copy = structuredClone(plan);
      plans.set(copy.id, copy);
      return structuredClone(copy);
    },
    deletePlan: async (planId: string) => plans.delete(planId),
  };
}

const context = { runId: "run-1", traceId: "trace-1", sessionId: "session-1" };

describe("createTaskTool", () => {
  test("renders list, status, and progress from TaskRuntime", async () => {
    const tool = createTaskTool({ store: memoryBridge([basePlan()]) });

    await expect(tool.execute({ action: "list" }, context)).resolves.toMatchObject({
      content: expect.stringContaining("Backend migration"),
    });
    await expect(tool.execute({ action: "status", plan_id: "plan-1" }, context)).resolves.toMatchObject({
      content: expect.stringContaining("## Backend migration (id: plan-1)"),
    });
    await expect(tool.execute({ action: "progress", plan_id: "plan-1" }, context)).resolves.toMatchObject({
      content: expect.stringContaining("**Progress:** 1/2 completed"),
      metadata: {
        _task_event: true,
        _task_plan_id: "plan-1",
        _task_progress: expect.objectContaining({ completed: 1, pending: 1, next: "Runtime" }),
      },
    });
  });

  test("controls plans and mutates subtasks through TaskRuntime", async () => {
    const tool = createTaskTool({ store: memoryBridge([basePlan()]), idGenerator: () => "new1" });

    await expect(tool.execute({ action: "pause", plan_id: "plan-1" }, context)).resolves.toMatchObject({
      content: "Plan plan-1 paused.",
    });
    await expect(tool.execute({ action: "cancel", plan_id: "plan-1" }, context)).resolves.toMatchObject({
      content: "Plan plan-1 cancelled.",
    });
    await expect(tool.execute({
      action: "add_subtask",
      plan_id: "plan-1",
      subtask_title: "Review",
      subtask_description: "Review the runtime",
      subtask_dependencies: ["b"],
      subtask_parallel_safe: false,
    }, context)).resolves.toMatchObject({
      content: expect.stringContaining("Added subtask new1"),
    });
    await expect(tool.execute({ action: "remove_subtask", plan_id: "plan-1", subtask_id: "new1" }, context)).resolves.toMatchObject({
      content: "Removed subtask new1 from plan plan-1.",
    });
    await expect(tool.execute({ action: "delete", plan_id: "plan-1" }, context)).resolves.toMatchObject({
      content: "Deleted plan plan-1.",
    });
  });

  test("returns Python-compatible validation and not-found errors", async () => {
    const tool = createTaskTool({ store: memoryBridge([]) });

    await expect(tool.execute({ action: "progress" }, context)).resolves.toEqual({
      content: "Error: plan_id is required for progress action",
    });
    await expect(tool.execute({ action: "pause" }, context)).resolves.toEqual({
      content: "Error: plan_id is required for pause action",
    });
    await expect(tool.execute({ action: "status", plan_id: "missing" }, context)).resolves.toEqual({
      content: "Error: Plan missing not found",
    });
  });

  test("reports deferred backend work for create, resume, and summary", async () => {
    const tool = createTaskTool({ store: memoryBridge([basePlan()]) });

    await expect(tool.execute({ action: "create", request: "Do the work" }, context)).resolves.toMatchObject({
      content: "Task plan creation is not available in the native TS runtime yet.",
      metadata: { available: false, deferred: "task_planning" },
    });
    await expect(tool.execute({ action: "resume", plan_id: "plan-1" }, context)).resolves.toMatchObject({
      content: "Task background execution is not available in the native TS runtime yet.",
      metadata: { available: false, deferred: "subagent_runtime" },
    });
    await expect(tool.execute({ action: "summary", plan_id: "plan-1" }, context)).resolves.toMatchObject({
      content: "Task summary generation is not available in the native TS runtime yet.",
      metadata: { available: false, deferred: "task_summary" },
    });
  });

  test("creates a task plan when a planner is configured", async () => {
    const bridge = memoryBridge([]);
    const tool = createTaskTool({
      store: bridge,
      planner: {
        createPlan: async (request, planContext) => ({
          id: "plan-new",
          title: "Created native plan",
          originalRequest: request,
          status: "planning",
          currentSubtaskIds: [],
          context: planContext,
          subtasks: [
            {
              id: "a",
              title: "Inspect",
              description: "Inspect Python",
              status: "pending",
              dependencies: [],
              parallelSafe: true,
              result: null,
              error: null,
              startedAt: null,
              completedAt: null,
              retryCount: 0,
              maxRetries: 2,
            },
          ],
        }),
      },
    });

    await expect(tool.execute({ action: "create", request: "Plan this" }, context)).resolves.toMatchObject({
      content: expect.stringContaining("Task plan created (plan_id: plan-new)."),
      metadata: {
        _task_event: true,
        _task_plan_id: "plan-new",
        _task_progress: expect.objectContaining({ plan_id: "plan-new", pending: 1 }),
      },
    });
    await expect(tool.execute({ action: "status", plan_id: "plan-new" }, context)).resolves.toMatchObject({
      content: expect.stringContaining("## Created native plan (id: plan-new)"),
    });
  });
});
