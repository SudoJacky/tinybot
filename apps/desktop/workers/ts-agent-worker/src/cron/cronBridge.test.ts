import { describe, expect, test } from "vitest";

import { NativeCronBridge } from "./cronBridge";

class FakeRpc {
  readonly requests: Array<{ traceId: string; method: string; params: Record<string, unknown> }> = [];

  constructor(private readonly responses: unknown[]) {}

  async request(traceId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    this.requests.push({ traceId, method, params });
    return this.responses.shift();
  }
}

describe("NativeCronBridge", () => {
  test("maps add/list/remove to native cron RPC methods", async () => {
    const rpc = new FakeRpc([
      {
        job: {
          id: "job-1",
          name: "Check status",
          enabled: true,
          schedule: { kind: "every", everyMs: 60000 },
          payload: { kind: "agent_turn", message: "Check status", deliver: true, channel: "native", to: "chat-1" },
          state: { nextRunAtMs: 1775000060000 },
          createdAtMs: 1775000000000,
          updatedAtMs: 1775000000000,
          deleteAfterRun: false,
        },
      },
      { jobs: [] },
      { status: "removed" },
    ]);
    const bridge = new NativeCronBridge(rpc);

    await expect(bridge.addJob({
      name: "Check status",
      schedule: { kind: "every", everyMs: 60000 },
      payload: { kind: "agent_turn", message: "Check status", deliver: true, channel: "native", to: "chat-1" },
      deleteAfterRun: false,
    }, "trace-add")).resolves.toMatchObject({ id: "job-1", schedule: { everyMs: 60000 } });
    await expect(bridge.listJobs("trace-list")).resolves.toEqual([]);
    await expect(bridge.removeJob("job-1", "trace-remove")).resolves.toBe("removed");

    expect(rpc.requests).toEqual([
      {
        traceId: "trace-add",
        method: "cron.job.add",
        params: {
          job: {
            name: "Check status",
            schedule: { kind: "every", everyMs: 60000 },
            payload: { kind: "agent_turn", message: "Check status", deliver: true, channel: "native", to: "chat-1" },
            deleteAfterRun: false,
          },
        },
      },
      { traceId: "trace-list", method: "cron.job.list", params: {} },
      { traceId: "trace-remove", method: "cron.job.remove", params: { job_id: "job-1" } },
    ]);
  });

  test("preserves Python-shaped run history when normalizing listed jobs", async () => {
    const rpc = new FakeRpc([
      {
        jobs: [
          {
            id: "job-1",
            name: "Check status",
            enabled: true,
            schedule: { kind: "every", every_ms: 60000 },
            payload: { kind: "agent_turn", message: "Check status", deliver: true, channel: "native", to: "chat-1" },
            state: {
              next_run_at_ms: 1775000060000,
              last_run_at_ms: 1775000000000,
              last_status: "error",
              last_error: "network unavailable",
              run_history: [
                { run_at_ms: 1774999940000, status: "ok", duration_ms: 1234 },
                { run_at_ms: 1775000000000, status: "error", duration_ms: 2500, error: "network unavailable" },
              ],
            },
            created_at_ms: 1774999900000,
            updated_at_ms: 1775000000000,
            delete_after_run: false,
          },
        ],
      },
    ]);
    const bridge = new NativeCronBridge(rpc);

    await expect(bridge.listJobs("trace-list")).resolves.toEqual([
      expect.objectContaining({
        id: "job-1",
        state: expect.objectContaining({
          nextRunAtMs: 1775000060000,
          lastRunAtMs: 1775000000000,
          lastStatus: "error",
          lastError: "network unavailable",
          runHistory: [
            { runAtMs: 1774999940000, status: "ok", durationMs: 1234, error: null },
            { runAtMs: 1775000000000, status: "error", durationMs: 2500, error: "network unavailable" },
          ],
        }),
      }),
    ]);
  });
});
