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
      content: "Active task plans:\n- plan-1: Backend migration [1/2] (executing)",
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

  test("renders Python-compatible plan summary details", async () => {
    const plan = basePlan();
    plan.createdAt = "2026-06-12T08:15:30.000Z";
    plan.context = { dag_errors: ["missing dependency"] };
    const tool = createTaskTool({ store: memoryBridge([plan]) });

    await expect(tool.execute({ action: "status", plan_id: "plan-1" }, context)).resolves.toMatchObject({
      content: [
        "## Backend migration (id: plan-1)",
        "Status: executing",
        "Created: 2026-06-12 08:15",
        "⚠️ DAG Errors: ['missing dependency']",
        "Progress: 1/2 completed, 0 in progress, 1 pending, 0 failed",
        "",
        "### Subtasks",
        "- ✅ **a:** Foundation",
        "  Result: Foundation done...",
        "- ⏳ **b:** Runtime (depends: a) [sequential]",
      ].join("\n"),
    });
  });

  test("controls plans and mutates subtasks through TaskRuntime", async () => {
    const tool = createTaskTool({ store: memoryBridge([basePlan()]), idGenerator: () => "new1" });

    await expect(tool.execute({ action: "pause", plan_id: "plan-1" }, context)).resolves.toMatchObject({
      content: "Paused plan 'Backend migration' (plan-1). Use 'resume' to continue.",
    });
    await expect(tool.execute({ action: "cancel", plan_id: "plan-1" }, context)).resolves.toMatchObject({
      content: "Cancelled plan 'Backend migration' (plan-1).",
    });
    await expect(tool.execute({
      action: "add_subtask",
      plan_id: "plan-1",
      subtask_title: "Review",
      subtask_description: "Review the runtime",
      subtask_dependencies: ["b"],
      subtask_parallel_safe: false,
    }, context)).resolves.toMatchObject({
      content: "Added subtask 'Review' (id: new1) to plan plan-1.",
    });
    await expect(tool.execute({ action: "remove_subtask", plan_id: "plan-1", subtask_id: "new1" }, context)).resolves.toMatchObject({
      content: "Removed subtask new1 from plan plan-1.",
    });
    await expect(tool.execute({ action: "remove_subtask", plan_id: "plan-1", subtask_id: "a" }, context)).resolves.toMatchObject({
      content: "Error: Could not remove subtask a. It may not be pending or not found.",
    });
    await expect(tool.execute({ action: "delete", plan_id: "plan-1" }, context)).resolves.toMatchObject({
      content: "Deleted plan plan-1.",
    });
  });

  test("returns Python-compatible dependency warnings after adding a subtask", async () => {
    const tool = createTaskTool({ store: memoryBridge([basePlan()]), idGenerator: () => "new-dag" });

    await expect(tool.execute({
      action: "add_subtask",
      plan_id: "plan-1",
      subtask_title: "Blocked follow-up",
      subtask_description: "This depends on a missing subtask",
      subtask_dependencies: ["missing"],
    }, context)).resolves.toMatchObject({
      content: expect.stringContaining("Added subtask 'Blocked follow-up' (id: new-dag) to plan plan-1.\nWarning: New dependency issues:"),
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
    await expect(tool.execute({ action: "delete", plan_id: "missing" }, context)).resolves.toEqual({
      content: "Error: Plan missing not found.",
    });
    await expect(tool.execute({ action: "resume", plan_id: "missing" }, context)).resolves.toEqual({
      content: "Error: Plan missing not found",
    });
  });

  test("reports deferred backend work for create and resume without configured backends", async () => {
    const plan = basePlan();
    plan.status = "planning";
    const tool = createTaskTool({ store: memoryBridge([plan]) });

    await expect(tool.execute({ action: "create", request: "Do the work" }, context)).resolves.toMatchObject({
      content: "Task plan creation is not available in the native TS runtime yet.",
      metadata: { available: false, deferred: "task_planning" },
    });
    await expect(tool.execute({ action: "resume", plan_id: "plan-1" }, context)).resolves.toMatchObject({
      content: "Task background execution is not available in the native TS runtime yet.",
      metadata: { available: false, deferred: "subagent_runtime" },
    });
  });

  test("preserves Python resume guards for completed and executing plans", async () => {
    const completed = basePlan();
    completed.status = "completed";
    completed.subtasks[1] = {
      ...completed.subtasks[1],
      status: "completed",
      result: "Runtime done",
    };
    const executing = basePlan();
    executing.id = "running";
    executing.subtasks[1] = {
      ...executing.subtasks[1],
      status: "in_progress",
      result: null,
    };
    const spawned: string[] = [];
    const tool = createTaskTool({
      store: memoryBridge([completed, executing]),
      executor: {
        spawnSubtask: async ({ subtask }) => {
          spawned.push(subtask.id);
        },
      },
    });

    await expect(tool.execute({ action: "resume", plan_id: "plan-1" }, context)).resolves.toEqual({
      content: "Plan already completed. Use `task action=summary plan_id={plan_id}` to get the final results.",
    });
    await expect(tool.execute({ action: "resume", plan_id: "running" }, context)).resolves.toEqual({
      content: [
        "Plan is already executing.",
        "",
        "## Progress: Backend migration (running)",
        "**Status:** executing",
        "**Progress:** 1/2 completed",
        "- In progress: 1",
        "- Pending: 0",
        "- Failed: 0",
        "- Skipped: 0",
        "**Currently executing:** Runtime",
      ].join("\n"),
    });
    expect(spawned).toEqual([]);
  });

  test("preserves Python resume guards before spawning ready subtasks", async () => {
    const dagError = basePlan();
    dagError.id = "dag-error";
    dagError.status = "planning";
    dagError.context = { dag_errors: ["cycle detected"] };

    const blocked = basePlan();
    blocked.id = "blocked";
    blocked.status = "planning";
    blocked.subtasks[1] = {
      ...blocked.subtasks[1],
      dependencies: ["missing"],
    };

    const allDone = basePlan();
    allDone.id = "all-done";
    allDone.status = "planning";
    allDone.subtasks[1] = {
      ...allDone.subtasks[1],
      status: "completed",
      result: "Runtime done",
    };

    const noReady = basePlan();
    noReady.id = "no-ready";
    noReady.status = "planning";
    noReady.subtasks[1] = {
      ...noReady.subtasks[1],
      status: "failed",
      result: null,
      error: "failed",
    };
    const spawned: string[] = [];
    const tool = createTaskTool({
      store: memoryBridge([dagError, blocked, allDone, noReady]),
      executor: {
        spawnSubtask: async ({ subtask }) => {
          spawned.push(subtask.id);
        },
      },
    });

    await expect(tool.execute({ action: "resume", plan_id: "dag-error" }, context)).resolves.toEqual({
      content: "Cannot execute plan due to dependency errors: ['cycle detected']\nUse 'add_subtask' or 'remove_subtask' to fix the plan.",
    });
    await expect(tool.execute({ action: "resume", plan_id: "blocked" }, context)).resolves.toEqual({
      content: "Error: Plan is blocked. All pending tasks have unmet dependencies.\nUse `task action=status plan_id=blocked` to inspect.",
    });
    await expect(tool.execute({ action: "resume", plan_id: "all-done" }, context)).resolves.toEqual({
      content: "All subtasks are completed. Use `task action=summary plan_id={plan_id}` to get the final results.",
    });
    await expect(tool.execute({ action: "resume", plan_id: "no-ready" }, context)).resolves.toEqual({
      content: "No ready subtasks found. Check plan status.",
    });
    expect(spawned).toEqual([]);
  });

  test("returns final summary only for completed plans", async () => {
    const completed = basePlan();
    completed.status = "completed";
    completed.subtasks[1] = {
      ...completed.subtasks[1],
      status: "completed",
      result: "Runtime done",
    };
    const active = basePlan();
    active.id = "active";
    active.status = "executing";
    const tool = createTaskTool({ store: memoryBridge([completed, active]) });

    await expect(tool.execute({ action: "summary", plan_id: "plan-1" }, context)).resolves.toEqual({
      content: "# Task Completed: Backend migration\n\n## Results\n\n[Foundation] Foundation done\n\n[Runtime] Runtime done",
    });
    await expect(tool.execute({ action: "summary", plan_id: "active" }, context)).resolves.toEqual({
      content: "Plan is not completed yet (status: executing).\nUse `task action=status plan_id=active` to check progress.",
    });
    await expect(tool.execute({ action: "summary" }, context)).resolves.toEqual({
      content: "Error: plan_id is required for summary action",
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
      content: expect.stringContaining("任务计划已创建（plan_id: plan-new）。"),
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

  test("auto-executes a newly created task plan when requested", async () => {
    const spawned: string[] = [];
    const tool = createTaskTool({
      store: memoryBridge([]),
      now: () => "2026-06-12T00:00:00.000Z",
      planner: {
        createPlan: async (request, planContext) => ({
          id: "plan-auto",
          title: "Auto native plan",
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
      executor: {
        spawnSubtask: async ({ subtask }) => {
          spawned.push(subtask.id);
        },
      },
    });

    await expect(tool.execute({ action: "create", request: "Plan this", auto_execute: true }, context)).resolves.toMatchObject({
      content: "任务已后台启动，SubAgent自动执行中。完成后会通知你。无需主动干预。（plan_id: plan-auto，启动 1 个子任务）",
      metadata: {
        _task_event: true,
        _task_plan_id: "plan-auto",
        _task_progress: expect.objectContaining({ plan_id: "plan-auto", in_progress: 1 }),
      },
    });
    expect(spawned).toEqual(["a"]);
  });

  test("resumes a task plan through the configured executor", async () => {
    const plan = basePlan();
    plan.status = "planning";
    plan.subtasks[0].status = "pending";
    plan.subtasks[0].result = null;
    const spawned: string[] = [];
    const tool = createTaskTool({
      store: memoryBridge([plan]),
      now: () => "2026-06-12T00:00:00.000Z",
      executor: {
        spawnSubtask: async ({ subtask }) => {
          spawned.push(subtask.id);
        },
      },
    });

    await expect(tool.execute({ action: "resume", plan_id: "plan-1" }, context)).resolves.toMatchObject({
      content: "任务已后台启动，SubAgent自动执行中。完成后会通知你。无需主动干预。（plan_id: plan-1，启动 1 个子任务）",
      metadata: {
        _task_event: true,
        _task_plan_id: "plan-1",
        _task_progress: expect.objectContaining({ plan_id: "plan-1", in_progress: 1, pending: 1 }),
      },
    });
    expect(spawned).toEqual(["a"]);
  });
});
