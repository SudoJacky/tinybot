import { afterEach, describe, expect, test, vi } from "vitest";

import { HeartbeatService } from "./heartbeatService";

describe("HeartbeatService", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("skips missing or empty HEARTBEAT.md content without calling the provider path", async () => {
    const decide = vi.fn();
    const executeTasks = vi.fn();
    const evaluateResponse = vi.fn();
    const notify = vi.fn();
    const service = new HeartbeatService({
      readHeartbeatFile: async () => "   ",
      decide,
      executeTasks,
      evaluateResponse,
      notify,
    });

    await expect(service.tick()).resolves.toEqual({ status: "missing_file" });
    expect(decide).not.toHaveBeenCalled();
    expect(executeTasks).not.toHaveBeenCalled();
    expect(evaluateResponse).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  test("executes heartbeat tasks and notifies only when the evaluator allows it", async () => {
    const notify = vi.fn();
    const service = new HeartbeatService({
      readHeartbeatFile: async () => "- [ ] Review stalled tasks.",
      decide: async ({ content }) => ({
        action: "run",
        tasks: `Parsed from ${content}`,
      }),
      executeTasks: async ({ tasks }) => `Completed ${tasks}`,
      evaluateResponse: async ({ response, taskContext }) =>
        response.includes("Completed") && taskContext.includes("Parsed"),
      notify,
    });

    await expect(service.tick()).resolves.toEqual({
      status: "notified",
      tasks: "Parsed from - [ ] Review stalled tasks.",
      response: "Completed Parsed from - [ ] Review stalled tasks.",
    });
    expect(notify).toHaveBeenCalledWith({
      response: "Completed Parsed from - [ ] Review stalled tasks.",
      tasks: "Parsed from - [ ] Review stalled tasks.",
    });
  });

  test("silences executed heartbeat responses when evaluator suppresses them", async () => {
    const notify = vi.fn();
    const service = new HeartbeatService({
      readHeartbeatFile: async () => "- [ ] Check routine status.",
      decide: async () => ({ action: "run", tasks: "Check routine status." }),
      executeTasks: async () => "Everything normal.",
      evaluateResponse: async () => false,
      notify,
    });

    await expect(service.tick()).resolves.toEqual({
      status: "silenced",
      tasks: "Check routine status.",
      response: "Everything normal.",
    });
    expect(notify).not.toHaveBeenCalled();
  });

  test("defaults to notification when post-run evaluation fails", async () => {
    const notify = vi.fn();
    const service = new HeartbeatService({
      readHeartbeatFile: async () => "- [ ] Check important status.",
      decide: async () => ({ action: "run", tasks: "Check important status." }),
      executeTasks: async () => "Potential issue found.",
      evaluateResponse: async () => {
        throw new Error("evaluator unavailable");
      },
      notify,
    });

    await expect(service.tick()).resolves.toEqual({
      status: "notified",
      tasks: "Check important status.",
      response: "Potential issue found.",
    });
    expect(notify).toHaveBeenCalledWith({
      response: "Potential issue found.",
      tasks: "Check important status.",
    });
  });

  test("triggerNow executes the heartbeat task without evaluator notification", async () => {
    const evaluateResponse = vi.fn();
    const notify = vi.fn();
    const service = new HeartbeatService({
      readHeartbeatFile: async () => "- [ ] Manual heartbeat task.",
      decide: async () => ({ action: "run", tasks: "Manual heartbeat task." }),
      executeTasks: async ({ tasks }) => `Completed ${tasks}`,
      evaluateResponse,
      notify,
    });

    await expect(service.triggerNow()).resolves.toEqual({
      status: "executed",
      tasks: "Manual heartbeat task.",
      response: "Completed Manual heartbeat task.",
    });
    expect(evaluateResponse).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  test("tracks the latest heartbeat status for scheduler diagnostics", async () => {
    const service = new HeartbeatService({
      readHeartbeatFile: async () => "- [ ] Inspect heartbeat diagnostics.",
      decide: async () => ({ action: "run", tasks: "Inspect heartbeat diagnostics." }),
      executeTasks: async () => "Diagnostics captured.",
    });

    expect(service.getStatus()).toEqual({
      enabled: true,
      running: false,
      executing: false,
      intervalMs: 1_800_000,
      lastResult: null,
      lastError: null,
    });

    await service.tick();

    expect(service.getStatus()).toEqual({
      enabled: true,
      running: false,
      executing: false,
      intervalMs: 1_800_000,
      lastResult: {
        status: "executed",
        tasks: "Inspect heartbeat diagnostics.",
        response: "Diagnostics captured.",
      },
      lastError: null,
    });
  });

  test("starts an enabled interval after the first delay and stops future ticks", async () => {
    vi.useFakeTimers();
    const executeTasks = vi.fn(async ({ tasks }: { tasks: string }) => `Completed ${tasks}`);
    const service = new HeartbeatService({
      intervalMs: 1_000,
      readHeartbeatFile: async () => "- [ ] Scheduled heartbeat task.",
      decide: async () => ({ action: "run", tasks: "Scheduled heartbeat task." }),
      executeTasks,
    });

    expect(service.start()).toBe(true);
    expect(service.getStatus()).toMatchObject({
      enabled: true,
      running: true,
      executing: false,
      intervalMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(executeTasks).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(executeTasks).toHaveBeenCalledTimes(1);

    service.stop();
    expect(service.getStatus()).toMatchObject({ running: false });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(executeTasks).toHaveBeenCalledTimes(1);
  });

  test("does not start disabled heartbeat scheduling", async () => {
    vi.useFakeTimers();
    const executeTasks = vi.fn();
    const service = new HeartbeatService({
      enabled: false,
      intervalMs: 10,
      readHeartbeatFile: async () => "- [ ] Disabled task.",
      decide: async () => ({ action: "run", tasks: "Disabled task." }),
      executeTasks,
    });

    expect(service.start()).toBe(false);
    expect(service.getStatus()).toMatchObject({
      enabled: false,
      running: false,
      executing: false,
      intervalMs: 10,
    });

    await vi.advanceTimersByTimeAsync(20);
    expect(executeTasks).not.toHaveBeenCalled();
  });

  test("reconfigures enabled state and interval before starting", async () => {
    vi.useFakeTimers();
    const executeTasks = vi.fn(async ({ tasks }: { tasks: string }) => `Completed ${tasks}`);
    const service = new HeartbeatService({
      enabled: false,
      intervalMs: 10,
      readHeartbeatFile: async () => "- [ ] Reconfigured heartbeat task.",
      decide: async () => ({ action: "run", tasks: "Reconfigured heartbeat task." }),
      executeTasks,
    });

    expect(service.start()).toBe(false);
    service.configure({ enabled: true, intervalMs: 25 });
    expect(service.start()).toBe(true);
    expect(service.getStatus()).toMatchObject({
      enabled: true,
      running: true,
      intervalMs: 25,
    });

    await vi.advanceTimersByTimeAsync(24);
    expect(executeTasks).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(executeTasks).toHaveBeenCalledTimes(1);

    service.configure({ enabled: false });
    expect(service.getStatus()).toMatchObject({
      enabled: false,
      running: false,
    });
  });

  test("skips overlapping scheduled ticks while one heartbeat is executing", async () => {
    vi.useFakeTimers();
    let resolveExecute: ((value: string) => void) | undefined;
    const executeTasks = vi.fn(() => new Promise<string>((resolve) => {
      resolveExecute = resolve;
    }));
    const service = new HeartbeatService({
      intervalMs: 10,
      readHeartbeatFile: async () => "- [ ] Slow heartbeat task.",
      decide: async () => ({ action: "run", tasks: "Slow heartbeat task." }),
      executeTasks,
    });

    service.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(executeTasks).toHaveBeenCalledTimes(1);
    expect(service.getStatus()).toMatchObject({
      running: true,
      executing: true,
    });

    await vi.advanceTimersByTimeAsync(30);
    expect(executeTasks).toHaveBeenCalledTimes(1);

    resolveExecute?.("Completed slow heartbeat task.");
    await vi.runOnlyPendingTimersAsync();
    service.stop();
  });
});
