import { describe, expect, test, vi } from "vitest";

import { HeartbeatService } from "./heartbeatService";

describe("HeartbeatService", () => {
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
      running: false,
      lastResult: null,
      lastError: null,
    });

    await service.tick();

    expect(service.getStatus()).toEqual({
      running: false,
      lastResult: {
        status: "executed",
        tasks: "Inspect heartbeat diagnostics.",
        response: "Diagnostics captured.",
      },
      lastError: null,
    });
  });
});
