import { describe, expect, test } from "vitest";

import { SubagentRuntime, type SubagentRunRequest } from "./subagentRuntime";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

describe("SubagentRuntime", () => {
  test("limits concurrency and starts queued subagents after active runs complete", async () => {
    const gates = [deferred<string>(), deferred<string>()];
    const started: string[] = [];
    const completions: Array<{ id: string; status: string; result: string }> = [];
    const runtime = new SubagentRuntime({
      maxConcurrent: 1,
      timeoutMs: 1000,
      idGenerator: (() => {
        let index = 0;
        return () => `subagent-${index += 1}`;
      })(),
      runner: async (request: SubagentRunRequest) => {
        started.push(request.id);
        return { status: "completed", result: await gates[started.length - 1].promise };
      },
    });

    const first = await runtime.spawn({
      task: "Inspect Python task runtime",
      label: "Inspect",
      sessionKey: "desktop:chat-1",
      metadata: { planId: "plan-1", subtaskId: "a" },
      onComplete: async (completion) => {
        completions.push({ id: completion.id, status: completion.status, result: completion.result });
      },
    });
    const second = await runtime.spawn({
      task: "Implement TS runtime",
      label: "Implement",
      sessionKey: "desktop:chat-1",
      metadata: { planId: "plan-1", subtaskId: "b" },
      onComplete: async (completion) => {
        completions.push({ id: completion.id, status: completion.status, result: completion.result });
      },
    });

    expect(first.message).toContain("Subagent [Inspect] started");
    expect(second.message).toContain("Subagent [Implement] queued");
    await waitFor(() => started.length === 1);
    expect(runtime.getSessionSubagentIds("desktop:chat-1")).toEqual(["subagent-1", "subagent-2"]);

    gates[0].resolve("inspection complete");
    await waitFor(() => started.length === 2);
    gates[1].resolve("implementation complete");
    await waitFor(() => completions.length === 2);

    expect(completions).toEqual([
      { id: "subagent-1", status: "completed", result: "inspection complete" },
      { id: "subagent-2", status: "completed", result: "implementation complete" },
    ]);
    expect(runtime.getSessionSubagentIds("desktop:chat-1")).toEqual([]);
  });

  test("reports timed out subagents as failed completions and releases session ownership", async () => {
    const completions: Array<{ status: string; result: string; error?: string }> = [];
    const runtime = new SubagentRuntime({
      maxConcurrent: 1,
      timeoutMs: 5,
      idGenerator: () => "subagent-timeout",
      runner: async () => new Promise(() => {}),
    });

    await runtime.spawn({
      task: "Never finishes",
      label: "Timeout",
      sessionKey: "desktop:chat-2",
      onComplete: async (completion) => {
        completions.push({ status: completion.status, result: completion.result, error: completion.error });
      },
    });

    await waitFor(() => completions.length === 1, 50);

    expect(completions[0]).toMatchObject({
      status: "failed",
      result: expect.stringContaining("Subagent timed out"),
      error: expect.stringContaining("Subagent timed out"),
    });
    expect(runtime.getSessionSubagentIds("desktop:chat-2")).toEqual([]);
  });

  test("continues queued work when a completion callback fails", async () => {
    const gates = [deferred<string>(), deferred<string>()];
    const started: string[] = [];
    const runtime = new SubagentRuntime({
      maxConcurrent: 1,
      timeoutMs: 1000,
      idGenerator: (() => {
        let index = 0;
        return () => `subagent-${index += 1}`;
      })(),
      runner: async (request: SubagentRunRequest) => {
        started.push(request.id);
        return { status: "completed", result: await gates[started.length - 1].promise };
      },
    });

    await runtime.spawn({
      task: "First",
      label: "First",
      onComplete: async () => {
        throw new Error("callback failed");
      },
    });
    await runtime.spawn({
      task: "Second",
      label: "Second",
      onComplete: async () => {},
    });

    await waitFor(() => started.length === 1);
    gates[0].resolve("first done");
    await waitFor(() => started.length === 2);
    gates[1].resolve("second done");
    await waitFor(() => runtime.getRunningCount() === 0);

    expect(started).toEqual(["subagent-1", "subagent-2"]);
  });

  test("cancels active subagents for a session and reports failed completion", async () => {
    const completions: Array<{ id: string; status: string; result: string; error?: string }> = [];
    const runtime = new SubagentRuntime({
      maxConcurrent: 1,
      timeoutMs: 1000,
      idGenerator: () => "subagent-active",
      runner: async (request: SubagentRunRequest) => new Promise((resolve) => {
        request.signal.addEventListener("abort", () => {
          resolve({ status: "failed", result: "cancelled by session", error: "cancelled by session" });
        });
      }),
    });

    await runtime.spawn({
      task: "Long running",
      label: "Active",
      sessionKey: "desktop:chat-3",
      onComplete: async (completion) => {
        completions.push({
          id: completion.id,
          status: completion.status,
          result: completion.result,
          error: completion.error,
        });
      },
    });
    await waitFor(() => runtime.getSessionSubagentIds("desktop:chat-3").length === 1);

    expect(runtime.cancelSession("desktop:chat-3")).toBe(1);
    await waitFor(() => completions.length === 1);

    expect(completions).toEqual([
      {
        id: "subagent-active",
        status: "failed",
        result: "Subagent cancelled.",
        error: "Subagent cancelled.",
      },
    ]);
    expect(runtime.getSessionSubagentIds("desktop:chat-3")).toEqual([]);
  });

  test("cancels queued and active subagents by plan metadata", async () => {
    const completions: Array<{ id: string; status: string; result: string; error?: string }> = [];
    const runtime = new SubagentRuntime({
      maxConcurrent: 1,
      timeoutMs: 1000,
      idGenerator: (() => {
        let index = 0;
        return () => `subagent-${index += 1}`;
      })(),
      runner: async () => new Promise(() => {}),
    });

    await runtime.spawn({
      task: "Active",
      label: "Active",
      sessionKey: "desktop:chat-4",
      metadata: { planId: "plan-1", subtaskId: "a" },
      onComplete: async (completion) => {
        completions.push({
          id: completion.id,
          status: completion.status,
          result: completion.result,
          error: completion.error,
        });
      },
    });
    await runtime.spawn({
      task: "Queued",
      label: "Queued",
      sessionKey: "desktop:chat-4",
      metadata: { planId: "plan-1", subtaskId: "b" },
      onComplete: async (completion) => {
        completions.push({
          id: completion.id,
          status: completion.status,
          result: completion.result,
          error: completion.error,
        });
      },
    });

    expect(runtime.cancelPlan("plan-1")).toBe(2);
    await waitFor(() => completions.length === 1);

    expect(completions).toEqual([
      {
        id: "subagent-1",
        status: "failed",
        result: "Subagent cancelled.",
        error: "Subagent cancelled.",
      },
    ]);
    expect(runtime.getSessionSubagentIds("desktop:chat-4")).toEqual([]);
    expect(runtime.getRunningCount()).toBe(0);
  });
});

async function waitFor(condition: () => boolean, attempts = 20): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not met");
}
