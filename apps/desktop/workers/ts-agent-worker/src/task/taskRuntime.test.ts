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
});
