import { describe, expect, test } from "vitest";

import { TaskRuntime } from "./taskRuntime";
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
        result: null,
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
        parallelSafe: true,
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
  const saves: TaskPlan[] = [];
  return {
    saves,
    bridge: {
      listPlans: async () => [...plans.values()].map((plan) => structuredClone(plan)),
      getPlan: async (planId: string) => structuredClone(plans.get(planId) ?? null),
      savePlan: async (plan: TaskPlan) => {
        const copy = structuredClone(plan);
        plans.set(copy.id, copy);
        saves.push(copy);
        return structuredClone(copy);
      },
      deletePlan: async (planId: string) => plans.delete(planId),
    },
  };
}

describe("TaskRuntime", () => {
  test("returns Python-shaped progress through the store bridge", async () => {
    const { bridge } = memoryBridge([basePlan()]);
    const runtime = new TaskRuntime({ store: bridge });

    await expect(runtime.getProgress("plan-1", "trace-1")).resolves.toMatchObject({
      plan_id: "plan-1",
      completed: 1,
      pending: 1,
      next: "Runtime",
    });
    await expect(runtime.getProgress("missing", "trace-2")).resolves.toBeNull();
  });

  test("pauses, cancels, deletes, and lists plans", async () => {
    const { bridge, saves } = memoryBridge([basePlan()]);
    const runtime = new TaskRuntime({ store: bridge });

    await expect(runtime.pausePlan("plan-1", "trace-pause")).resolves.toMatchObject({ status: "paused" });
    await expect(runtime.cancelPlan("plan-1", "trace-cancel")).resolves.toMatchObject({ status: "paused" });
    await expect(runtime.listPlans("trace-list")).resolves.toHaveLength(1);
    await expect(runtime.deletePlan("plan-1", "trace-delete")).resolves.toBe(true);
    await expect(runtime.listPlans("trace-list-2")).resolves.toEqual([]);
    expect(saves.map((plan) => plan.status)).toEqual(["paused", "paused"]);
  });

  test("cancels active executor subagents when cancelling a plan", async () => {
    const plan = basePlan();
    plan.currentSubtaskIds = ["b"];
    plan.subtasks[1].status = "in_progress";
    const { bridge, saves } = memoryBridge([plan]);
    const cancelledPlans: Array<{ planId: string; traceId: string }> = [];
    const runtime = new TaskRuntime({
      store: bridge,
      executor: {
        spawnSubtask: async () => {},
        cancelPlan: async (candidate, traceId) => {
          cancelledPlans.push({ planId: candidate.id, traceId });
          return 2;
        },
      },
    });

    await expect(runtime.cancelPlan("plan-1", "trace-cancel")).resolves.toMatchObject({ status: "paused" });

    expect(cancelledPlans).toEqual([{ planId: "plan-1", traceId: "trace-cancel" }]);
    expect(saves.at(-1)).toMatchObject({ id: "plan-1", status: "paused" });
  });

  test("adds and removes pending subtasks while maintaining DAG errors", async () => {
    const { bridge, saves } = memoryBridge([basePlan()]);
    const runtime = new TaskRuntime({ store: bridge, idGenerator: () => "new1" });

    const added = await runtime.addSubtask("plan-1", {
      title: "Blocked",
      description: "Waits on a missing dependency",
      dependencies: ["missing"],
      parallelSafe: false,
    }, "trace-add");

    expect(added?.id).toBe("new1");
    expect(saves.at(-1)?.context.dagErrors).toEqual(["Subtask 'new1' depends on non-existent 'missing'"]);
    await expect(runtime.removeSubtask("plan-1", "new1", "trace-remove")).resolves.toBe(true);
    expect(saves.at(-1)?.subtasks.map((subtask) => subtask.id)).toEqual(["a", "b"]);
    expect(saves.at(-1)?.context.dagErrors).toEqual([]);
  });

  test("updates subtask results and completion timestamps", async () => {
    const { bridge, saves } = memoryBridge([basePlan()]);
    const runtime = new TaskRuntime({
      store: bridge,
      now: () => "2026-06-12T00:00:00.000Z",
    });

    const updated = await runtime.updateSubtaskResult("plan-1", "b", {
      status: "completed",
      result: "runtime complete",
    }, "trace-update");

    expect(updated).toMatchObject({
      id: "b",
      status: "completed",
      result: "runtime complete",
      completedAt: "2026-06-12T00:00:00.000Z",
    });
    expect(saves.at(-1)?.subtasks[1]).toMatchObject({
      status: "completed",
      result: "runtime complete",
      completedAt: "2026-06-12T00:00:00.000Z",
    });
  });

  test("creates and persists a planner-generated task plan", async () => {
    const { bridge, saves } = memoryBridge([]);
    const runtime = new TaskRuntime({
      store: bridge,
      planner: {
        createPlan: async (request, planContext) => ({
          id: "plan-created",
          title: "Created plan",
          originalRequest: request,
          status: "planning",
          currentSubtaskIds: [],
          context: planContext,
          subtasks: [],
        }),
      },
    });

    const plan = await runtime.createPlan(
      "Create a TS plan",
      { channel: "desktop", chatId: "chat-1", sessionKey: "desktop:chat-1" },
      "trace-create",
    );

    expect(plan.id).toBe("plan-created");
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ id: "plan-created", originalRequest: "Create a TS plan" });
  });

  test("resumes a plan by marking ready subtasks in progress and spawning executors", async () => {
    const { bridge, saves } = memoryBridge([{
      ...basePlan(),
      status: "planning",
      subtasks: [
        {
          ...basePlan().subtasks[0],
          status: "pending",
          result: null,
        },
        basePlan().subtasks[1],
      ],
    }]);
    const spawned: Array<{ planId: string; subtaskId: string; task: string; label: string }> = [];
    const runtime = new TaskRuntime({
      store: bridge,
      now: () => "2026-06-12T00:00:00.000Z",
      executor: {
        spawnSubtask: async (request) => {
          spawned.push({
            planId: request.plan.id,
            subtaskId: request.subtask.id,
            task: request.task,
            label: request.label,
          });
        },
      },
    });

    const result = await runtime.resumePlan("plan-1", { parallel: true }, "trace-resume");

    expect(result).toMatchObject({
      plan: expect.objectContaining({ id: "plan-1", status: "executing" }),
      spawnedCount: 1,
    });
    expect(spawned).toEqual([
      {
        planId: "plan-1",
        subtaskId: "a",
        label: "Foundation",
        task: expect.stringContaining("Execute subtask: Foundation"),
      },
    ]);
    expect(saves.at(-1)).toMatchObject({
      status: "executing",
      currentSubtaskIds: ["a"],
      subtasks: [
        expect.objectContaining({ id: "a", status: "in_progress", startedAt: "2026-06-12T00:00:00.000Z" }),
        expect.objectContaining({ id: "b", status: "pending" }),
      ],
    });
  });

  test("publishes task progress when resume starts ready subtasks", async () => {
    const plan = basePlan();
    plan.status = "planning";
    plan.subtasks[0].status = "pending";
    plan.subtasks[0].result = null;
    const { bridge } = memoryBridge([plan]);
    const events: Array<Record<string, unknown>> = [];
    const runtime = new TaskRuntime({
      store: bridge,
      now: () => "2026-06-12T00:00:00.000Z",
      executor: {
        spawnSubtask: async () => {},
      },
      progressPublisher: {
        publishTaskProgress: async (event, traceId) => {
          events.push({ ...event, traceId });
        },
      },
    });

    await runtime.resumePlan("plan-1", { parallel: true }, "trace-resume");

    expect(events).toEqual([
      expect.objectContaining({
        event: "started",
        planId: "plan-1",
        subtaskId: "a",
        subtaskTitle: "Foundation",
        traceId: "trace-resume",
        progress: expect.objectContaining({
          plan_id: "plan-1",
          in_progress: 1,
          pending: 1,
          current: "Foundation",
        }),
      }),
    ]);
  });

  test("persists task progress cards for plans with an owning session", async () => {
    const plan = basePlan();
    plan.status = "planning";
    plan.context = { sessionKey: "desktop:chat-1" };
    plan.subtasks[0].status = "pending";
    plan.subtasks[0].result = null;
    const { bridge } = memoryBridge([plan]);
    const persisted: Array<{ sessionKey: string; event: string; planId: string; subtaskId: string; traceId: string }> = [];
    const runtime = new TaskRuntime({
      store: bridge,
      now: () => "2026-06-12T00:00:00.000Z",
      executor: {
        spawnSubtask: async () => {},
      },
      progressCard: {
        persistTaskProgress: async (sessionKey, event, traceId) => {
          persisted.push({
            sessionKey,
            event: event.event,
            planId: event.planId,
            subtaskId: event.subtaskId,
            traceId,
          });
        },
      },
    });

    await runtime.resumePlan("plan-1", { parallel: true }, "trace-resume");

    expect(persisted).toEqual([
      {
        sessionKey: "desktop:chat-1",
        event: "started",
        planId: "plan-1",
        subtaskId: "a",
        traceId: "trace-resume",
      },
    ]);
  });

  test("completes a subtask and spawns the next ready subtask", async () => {
    const plan = basePlan();
    plan.status = "executing";
    plan.currentSubtaskIds = ["a"];
    plan.subtasks[0].status = "in_progress";
    plan.subtasks[0].result = null;
    const { bridge, saves } = memoryBridge([plan]);
    const spawned: string[] = [];
    const runtime = new TaskRuntime({
      store: bridge,
      now: () => "2026-06-12T00:00:00.000Z",
      executor: {
        spawnSubtask: async ({ subtask }) => {
          spawned.push(subtask.id);
        },
      },
    });

    const result = await runtime.completeSubtask(
      "plan-1",
      "a",
      { status: "completed", result: "foundation complete" },
      { parallel: true },
      "trace-complete",
    );

    expect(result).toMatchObject({
      plan: expect.objectContaining({ id: "plan-1", status: "executing" }),
      spawnedCount: 1,
    });
    expect(spawned).toEqual(["b"]);
    expect(saves.at(-1)).toMatchObject({
      currentSubtaskIds: ["b"],
      subtasks: [
        expect.objectContaining({ id: "a", status: "completed", result: "foundation complete" }),
        expect.objectContaining({ id: "b", status: "in_progress", startedAt: "2026-06-12T00:00:00.000Z" }),
      ],
    });
  });

  test("publishes task progress when subtasks complete and chain to ready work", async () => {
    const plan = basePlan();
    plan.status = "executing";
    plan.currentSubtaskIds = ["a"];
    plan.subtasks[0].status = "in_progress";
    plan.subtasks[0].result = null;
    const { bridge } = memoryBridge([plan]);
    const events: Array<Record<string, unknown>> = [];
    const runtime = new TaskRuntime({
      store: bridge,
      now: () => "2026-06-12T00:00:00.000Z",
      executor: {
        spawnSubtask: async () => {},
      },
      progressPublisher: {
        publishTaskProgress: async (event, traceId) => {
          events.push({ ...event, traceId });
        },
      },
    });

    await runtime.completeSubtask(
      "plan-1",
      "a",
      { status: "completed", result: "foundation complete" },
      { parallel: true },
      "trace-complete",
    );

    expect(events).toEqual([
      expect.objectContaining({
        event: "completed",
        planId: "plan-1",
        subtaskId: "a",
        subtaskTitle: "Foundation",
        traceId: "trace-complete",
        progress: expect.objectContaining({ completed: 1, in_progress: 1, current: "Runtime" }),
      }),
      expect.objectContaining({
        event: "started",
        planId: "plan-1",
        subtaskId: "b",
        subtaskTitle: "Runtime",
        traceId: "trace-complete",
        progress: expect.objectContaining({ completed: 1, in_progress: 1, current: "Runtime" }),
      }),
    ]);
  });

  test("retries failed subtasks before exhausting failure", async () => {
    const plan = basePlan();
    plan.status = "executing";
    plan.currentSubtaskIds = ["b"];
    plan.subtasks[1].status = "in_progress";
    plan.subtasks[1].retryCount = 1;
    plan.subtasks[1].maxRetries = 2;
    const { bridge, saves } = memoryBridge([plan]);
    const spawned: string[] = [];
    const runtime = new TaskRuntime({
      store: bridge,
      now: () => "2026-06-12T00:00:00.000Z",
      executor: {
        spawnSubtask: async ({ subtask }) => {
          spawned.push(subtask.id);
        },
      },
    });

    const result = await runtime.completeSubtask(
      "plan-1",
      "b",
      { status: "failed", error: "temporary failure" },
      { parallel: true },
      "trace-retry",
    );

    expect(result).toMatchObject({
      plan: expect.objectContaining({ id: "plan-1", status: "executing" }),
      spawnedCount: 1,
    });
    expect(spawned).toEqual(["b"]);
    expect(saves.at(-1)).toMatchObject({
      status: "executing",
      currentSubtaskIds: ["b"],
      subtasks: [
        expect.objectContaining({ id: "a", status: "completed" }),
        expect.objectContaining({
          id: "b",
          status: "in_progress",
          retryCount: 2,
          error: "temporary failure",
          startedAt: "2026-06-12T00:00:00.000Z",
          completedAt: null,
        }),
      ],
    });
  });

  test("pauses plans when failed subtasks exhaust retries", async () => {
    const plan = basePlan();
    plan.status = "executing";
    plan.currentSubtaskIds = ["b"];
    plan.subtasks[1].status = "in_progress";
    plan.subtasks[1].retryCount = 2;
    plan.subtasks[1].maxRetries = 2;
    const { bridge, saves } = memoryBridge([plan]);
    const spawned: string[] = [];
    const runtime = new TaskRuntime({
      store: bridge,
      now: () => "2026-06-12T00:00:00.000Z",
      executor: {
        spawnSubtask: async ({ subtask }) => {
          spawned.push(subtask.id);
        },
      },
    });

    const result = await runtime.completeSubtask(
      "plan-1",
      "b",
      { status: "failed", error: "permanent failure" },
      { parallel: true },
      "trace-exhausted",
    );

    expect(result).toMatchObject({
      plan: expect.objectContaining({ id: "plan-1", status: "paused" }),
      spawnedCount: 0,
    });
    expect(spawned).toEqual([]);
    expect(saves.at(-1)).toMatchObject({
      status: "paused",
      currentSubtaskIds: [],
      subtasks: [
        expect.objectContaining({ id: "a", status: "completed" }),
        expect.objectContaining({
          id: "b",
          status: "failed",
          retryCount: 3,
          error: "permanent failure",
          completedAt: "2026-06-12T00:00:00.000Z",
        }),
      ],
    });
  });

  test("notifies the owning session when retries pause a task plan", async () => {
    const plan = basePlan();
    plan.status = "executing";
    plan.context = { sessionKey: "desktop:chat-1" };
    plan.currentSubtaskIds = ["b"];
    plan.subtasks[0].result = "Foundation done";
    plan.subtasks[1].status = "in_progress";
    plan.subtasks[1].retryCount = 2;
    plan.subtasks[1].maxRetries = 2;
    const { bridge } = memoryBridge([plan]);
    const notifications: Array<{ sessionKey: string; content: string; metadata: Record<string, unknown>; traceId: string }> = [];
    const runtime = new TaskRuntime({
      store: bridge,
      now: () => "2026-06-12T00:00:00.000Z",
      executor: {
        spawnSubtask: async () => {},
      },
      notifier: {
        notifyPlanCompleted: async (sessionKey, completedPlan, summary, traceId) => {
          notifications.push({
            sessionKey,
            content: summary,
            metadata: { planId: completedPlan.id, status: completedPlan.status, error: completedPlan.context.error },
            traceId,
          });
        },
      },
    });

    await runtime.completeSubtask(
      "plan-1",
      "b",
      { status: "failed", error: "permanent failure" },
      { parallel: true },
      "trace-paused",
    );

    expect(notifications).toEqual([
      {
        sessionKey: "desktop:chat-1",
        content: "[Foundation] Foundation done",
        metadata: {
          planId: "plan-1",
          status: "paused",
          error: "Subtask 'Runtime' failed after 2 retries.",
        },
        traceId: "trace-paused",
      },
    ]);
  });

  test("pauses plans when completed subtasks leave pending work blocked", async () => {
    const plan = basePlan();
    plan.status = "executing";
    plan.context = { sessionKey: "desktop:chat-1" };
    plan.currentSubtaskIds = ["a"];
    plan.subtasks[0].status = "in_progress";
    plan.subtasks[1].status = "pending";
    const { bridge, saves } = memoryBridge([plan]);
    const spawned: string[] = [];
    const notifications: Array<{ sessionKey: string; status: string; error: unknown; traceId: string }> = [];
    const runtime = new TaskRuntime({
      store: bridge,
      now: () => "2026-06-12T00:00:00.000Z",
      executor: {
        spawnSubtask: async ({ subtask }) => {
          spawned.push(subtask.id);
        },
      },
      notifier: {
        notifyPlanCompleted: async (sessionKey, completedPlan, _summary, traceId) => {
          notifications.push({
            sessionKey,
            status: completedPlan.status,
            error: completedPlan.context.error,
            traceId,
          });
        },
      },
    });

    const result = await runtime.completeSubtask(
      "plan-1",
      "a",
      { status: "skipped", result: "dependency not needed" },
      { parallel: true },
      "trace-blocked",
    );

    expect(result).toMatchObject({
      plan: expect.objectContaining({ id: "plan-1", status: "paused" }),
      spawnedCount: 0,
    });
    expect(spawned).toEqual([]);
    expect(saves.at(-1)).toMatchObject({
      status: "paused",
      currentSubtaskIds: [],
      context: {
        error: "Tasks blocked by unresolvable dependencies",
      },
      subtasks: [
        expect.objectContaining({ id: "a", status: "skipped" }),
        expect.objectContaining({ id: "b", status: "pending" }),
      ],
    });
    expect(notifications).toEqual([
      {
        sessionKey: "desktop:chat-1",
        status: "paused",
        error: "Tasks blocked by unresolvable dependencies",
        traceId: "trace-blocked",
      },
    ]);
  });

  test("notifies the owning session when a task plan completes", async () => {
    const plan = basePlan();
    plan.status = "executing";
    plan.currentSubtaskIds = ["b"];
    plan.context = { sessionKey: "desktop:chat-1" };
    plan.subtasks[0].result = "Foundation done";
    plan.subtasks[1].status = "in_progress";
    const { bridge } = memoryBridge([plan]);
    const notifications: Array<{ sessionKey: string; content: string; metadata: Record<string, unknown>; traceId: string }> = [];
    const runtime = new TaskRuntime({
      store: bridge,
      now: () => "2026-06-12T00:00:00.000Z",
      executor: {
        spawnSubtask: async () => {},
      },
      notifier: {
        notifyPlanCompleted: async (sessionKey, completedPlan, summary, traceId) => {
          notifications.push({
            sessionKey,
            content: summary,
            metadata: { planId: completedPlan.id, status: completedPlan.status },
            traceId,
          });
        },
      },
    });

    await runtime.completeSubtask(
      "plan-1",
      "b",
      { status: "completed", result: "runtime complete" },
      { parallel: true },
      "trace-complete",
    );

    expect(notifications).toEqual([
      {
        sessionKey: "desktop:chat-1",
        content: "[Foundation] Foundation done\n\n[Runtime] runtime complete",
        metadata: { planId: "plan-1", status: "completed" },
        traceId: "trace-complete",
      },
    ]);
  });

  test("keeps paused plans paused when cancelled subagents complete later", async () => {
    const plan = basePlan();
    plan.status = "paused";
    plan.currentSubtaskIds = ["b"];
    plan.subtasks[1].status = "in_progress";
    const { bridge, saves } = memoryBridge([plan]);
    const spawned: string[] = [];
    const runtime = new TaskRuntime({
      store: bridge,
      now: () => "2026-06-12T00:00:00.000Z",
      executor: {
        spawnSubtask: async ({ subtask }) => {
          spawned.push(subtask.id);
        },
      },
    });

    const result = await runtime.completeSubtask(
      "plan-1",
      "b",
      { status: "failed", result: "Subagent cancelled.", error: "Subagent cancelled." },
      { parallel: true },
      "trace-complete",
    );

    expect(result).toMatchObject({
      plan: expect.objectContaining({ id: "plan-1", status: "paused" }),
      spawnedCount: 0,
    });
    expect(spawned).toEqual([]);
    expect(saves.at(-1)).toMatchObject({
      status: "paused",
      currentSubtaskIds: [],
      subtasks: [
        expect.objectContaining({ id: "a", status: "completed" }),
        expect.objectContaining({
          id: "b",
          status: "failed",
          result: "Subagent cancelled.",
          error: "Subagent cancelled.",
          completedAt: "2026-06-12T00:00:00.000Z",
        }),
      ],
    });
  });

  test("summarizes completed subtask results for finished plans", async () => {
    const completed = basePlan();
    completed.status = "completed";
    completed.subtasks[0] = {
      ...completed.subtasks[0],
      result: "Foundation done",
    };
    completed.subtasks[1] = {
      ...completed.subtasks[1],
      status: "completed",
      result: "Runtime done",
    };
    const { bridge } = memoryBridge([completed]);
    const runtime = new TaskRuntime({ store: bridge });

    await expect(runtime.getPlanSummary("plan-1", "trace-summary")).resolves.toEqual({
      plan: completed,
      summary: "[Foundation] Foundation done\n\n[Runtime] Runtime done",
    });
    await expect(runtime.getPlanSummary("missing", "trace-summary")).resolves.toBeNull();
  });
});
