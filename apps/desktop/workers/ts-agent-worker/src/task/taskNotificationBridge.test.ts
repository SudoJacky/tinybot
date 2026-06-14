import { describe, expect, test } from "vitest";

import { NativeTaskNotificationBridge, NativeTaskProgressCardBridge } from "./taskNotificationBridge";
import type { TaskPlan } from "./taskTypes";

class FakeRpc {
  readonly requests: Array<{ traceId: string; method: string; params: Record<string, unknown> }> = [];

  async request(traceId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    this.requests.push({ traceId, method, params });
    return {};
  }
}

function completedPlan(): TaskPlan {
  return {
    id: "plan-1",
    title: "Backend migration",
    originalRequest: "Move backend runtime to TS",
    status: "completed",
    currentSubtaskIds: [],
    context: { sessionKey: "desktop:chat-1" },
    subtasks: [],
  };
}

describe("NativeTaskNotificationBridge", () => {
  test("appends an internal task completion notification to the owning session", async () => {
    const rpc = new FakeRpc();
    const bridge = new NativeTaskNotificationBridge(rpc);

    await bridge.notifyPlanCompleted(
      "desktop:chat-1",
      completedPlan(),
      "[Inspect] done",
      "trace-complete",
    );

    expect(rpc.requests).toEqual([
      {
        traceId: "trace-complete",
        method: "session.append_messages",
        params: {
          session_id: "desktop:chat-1",
          messages: [
            {
              role: "user",
              content: expect.stringContaining("A multi-step task plan has finished execution"),
              metadata: {
                _task_event: true,
                _task_completion_notification: true,
                _task_plan_id: "plan-1",
                _task_status: "completed",
                _tool_name: "task",
              },
            },
          ],
        },
      },
    ]);
    expect(rpc.requests[0]?.params.messages).toEqual([
      expect.objectContaining({
        content: expect.stringContaining("## Results Summary\n[Inspect] done"),
      }),
    ]);
  });
});

describe("NativeTaskProgressCardBridge", () => {
  test("upserts the owning session task progress card", async () => {
    const rpc = new FakeRpc();
    const bridge = new NativeTaskProgressCardBridge(rpc);

    await bridge.persistTaskProgress(
      "desktop:chat-1",
      {
        event: "completed",
        planId: "plan-1",
        subtaskId: "b",
        subtaskTitle: "Runtime",
        progress: {
          plan_id: "plan-1",
          title: "Backend migration",
          status: "executing",
          total: 2,
          completed: 1,
          in_progress: 1,
          pending: 0,
          failed: 0,
          skipped: 0,
          current: "Runtime",
          current_all: ["Runtime"],
          next: null,
        },
      },
      "trace-progress",
    );

    expect(rpc.requests).toEqual([
      {
        traceId: "trace-progress",
        method: "session.task_progress.upsert",
        params: {
          session_id: "desktop:chat-1",
          plan_id: "plan-1",
          progress: expect.objectContaining({
            plan_id: "plan-1",
            completed: 1,
            in_progress: 1,
          }),
          content: expect.stringContaining("## Task Progress: Backend migration"),
        },
      },
    ]);
    expect(rpc.requests[0]?.params.content).toEqual(expect.stringContaining("**Last event:** Completed Runtime"));
  });
});
