import { describe, expect, test } from "vitest";

import { NativeBackgroundRegistryBridge } from "./backgroundRegistryBridge";

class FakeRpc {
  readonly requests: Array<{ traceId: string; method: string; params: Record<string, unknown> }> = [];

  async request(traceId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    this.requests.push({ traceId, method, params });
    return {};
  }
}

describe("NativeBackgroundRegistryBridge", () => {
  test("maps upsert and complete to native background registry RPC methods", async () => {
    const rpc = new FakeRpc();
    const bridge = new NativeBackgroundRegistryBridge(rpc);

    await bridge.upsertRun({
      id: "subagent-1",
      kind: "subagent",
      source: "task",
      status: "running",
      label: "Inspect",
      sessionKey: "desktop:chat-1",
      planId: "plan-1",
      subtaskId: "a",
      startedAtMs: 1000,
      updatedAtMs: 1000,
      metadata: { traceId: "trace-1" },
    }, "trace-1");
    await bridge.completeRun({
      runId: "subagent-1",
      status: "completed",
      completedAtMs: 2000,
      result: "done",
      error: null,
    }, "trace-1");

    expect(rpc.requests).toEqual([
      {
        traceId: "trace-1",
        method: "background.run.upsert",
        params: {
          run: {
            id: "subagent-1",
            kind: "subagent",
            source: "task",
            status: "running",
            label: "Inspect",
            sessionKey: "desktop:chat-1",
            planId: "plan-1",
            subtaskId: "a",
            startedAtMs: 1000,
            updatedAtMs: 1000,
            metadata: { traceId: "trace-1" },
          },
        },
      },
      {
        traceId: "trace-1",
        method: "background.run.complete",
        params: {
          run_id: "subagent-1",
          status: "completed",
          completedAtMs: 2000,
          result: "done",
          error: null,
        },
      },
    ]);
  });
});
