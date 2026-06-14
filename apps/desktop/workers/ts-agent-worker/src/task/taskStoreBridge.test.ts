import { describe, expect, test } from "vitest";

import { NativeTaskStoreBridge } from "./taskStoreBridge";
import type { TaskPlan } from "./taskTypes";

function rpcClient(responses: Record<string, unknown>) {
  const calls: Array<{ traceId: string; method: string; params: Record<string, unknown> }> = [];
  return {
    calls,
    client: {
      request: async (traceId: string, method: string, params: Record<string, unknown>) => {
        calls.push({ traceId, method, params });
        return responses[method];
      },
    },
  };
}

const nativePlan = {
  id: "plan-1",
  title: "Backend migration",
  original_request: "Move backend runtime to TS",
  status: "executing",
  current_subtask_ids: ["sub-2"],
  context: { channel: "desktop", session_key: "desktop:session-1" },
  subtasks: [
    {
      id: "sub-1",
      title: "Foundation",
      description: "Build foundation",
      status: "completed",
      parallel_safe: true,
      retry_count: 1,
      max_retries: 3,
    },
    {
      id: "sub-2",
      title: "Runtime",
      description: "Build runtime",
      status: "in_progress",
      dependencies: ["sub-1"],
      parallel_safe: false,
    },
  ],
};

describe("NativeTaskStoreBridge", () => {
  test("loads and normalizes the native task store", async () => {
    const { client, calls } = rpcClient({
      "task.store.load": {
        version: 1,
        plans: [nativePlan],
      },
    });
    const bridge = new NativeTaskStoreBridge(client);

    const store = await bridge.loadStore("trace-1");

    expect(calls).toEqual([{ traceId: "trace-1", method: "task.store.load", params: {} }]);
    expect(store).toEqual({
      version: 1,
      plans: [
        expect.objectContaining({
          id: "plan-1",
          originalRequest: "Move backend runtime to TS",
          currentSubtaskIds: ["sub-2"],
          context: { channel: "desktop", session_key: "desktop:session-1" },
        }),
      ],
    });
    expect(store.plans[0]?.subtasks[0]).toMatchObject({
      id: "sub-1",
      dependencies: [],
      parallelSafe: true,
      retryCount: 1,
      maxRetries: 3,
    });
    expect(store.plans[0]?.subtasks[1]).toMatchObject({
      id: "sub-2",
      dependencies: ["sub-1"],
      parallelSafe: false,
      retryCount: 0,
      maxRetries: 2,
    });
  });

  test("lists, gets, deletes, and saves plans through native task RPCs", async () => {
    const { client, calls } = rpcClient({
      "task.plan.list": { plans: [nativePlan] },
      "task.plan.get": { plan: nativePlan },
      "task.plan.delete": { deleted: true },
      "task.plan.save": { plan: nativePlan },
    });
    const bridge = new NativeTaskStoreBridge(client);

    const listed = await bridge.listPlans("trace-list", { includeCompleted: true });
    const fetched = await bridge.getPlan("plan-1", "trace-get");
    const deleted = await bridge.deletePlan("plan-1", "trace-delete");
    const saved = await bridge.savePlan(fetched as TaskPlan, "trace-save");

    expect(listed.map((plan) => plan.id)).toEqual(["plan-1"]);
    expect(fetched?.id).toBe("plan-1");
    expect(deleted).toBe(true);
    expect(saved.id).toBe("plan-1");
    expect(calls).toEqual([
      {
        traceId: "trace-list",
        method: "task.plan.list",
        params: { include_completed: true },
      },
      {
        traceId: "trace-get",
        method: "task.plan.get",
        params: { plan_id: "plan-1" },
      },
      {
        traceId: "trace-delete",
        method: "task.plan.delete",
        params: { plan_id: "plan-1" },
      },
      {
        traceId: "trace-save",
        method: "task.plan.save",
        params: {
          plan: {
            id: "plan-1",
            title: "Backend migration",
            original_request: "Move backend runtime to TS",
            status: "executing",
            current_subtask_ids: ["sub-2"],
            context: { channel: "desktop", session_key: "desktop:session-1" },
            subtasks: [
              {
                id: "sub-1",
                title: "Foundation",
                description: "Build foundation",
                status: "completed",
                dependencies: [],
                parallel_safe: true,
                result: null,
                error: null,
                started_at: null,
                completed_at: null,
                retry_count: 1,
                max_retries: 3,
              },
              {
                id: "sub-2",
                title: "Runtime",
                description: "Build runtime",
                status: "in_progress",
                dependencies: ["sub-1"],
                parallel_safe: false,
                result: null,
                error: null,
                started_at: null,
                completed_at: null,
                retry_count: 0,
                max_retries: 2,
              },
            ],
          },
        },
      },
    ]);
  });

  test("handles missing native store payloads defensively", async () => {
    const { client } = rpcClient({
      "task.store.load": null,
      "task.plan.list": null,
      "task.plan.get": { plan: null },
      "task.plan.delete": {},
    });
    const bridge = new NativeTaskStoreBridge(client);

    await expect(bridge.loadStore("trace-load")).resolves.toEqual({ version: 1, plans: [] });
    await expect(bridge.listPlans("trace-list")).resolves.toEqual([]);
    await expect(bridge.getPlan("missing", "trace-get")).resolves.toBeNull();
    await expect(bridge.deletePlan("missing", "trace-delete")).resolves.toBe(false);
  });
});
