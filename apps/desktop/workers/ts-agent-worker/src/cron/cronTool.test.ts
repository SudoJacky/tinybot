import { describe, expect, test } from "vitest";

import { createCronTool } from "./cronTool";
import type { CronJob } from "./cronTypes";

function memoryBridge(initialJobs: CronJob[] = []) {
  const jobs = new Map(initialJobs.map((job) => [job.id, structuredClone(job)]));
  const addRequests: Array<Omit<CronJob, "id" | "createdAtMs" | "updatedAtMs" | "state" | "enabled">> = [];
  return {
    addRequests,
    addJob: async (request: Omit<CronJob, "id" | "createdAtMs" | "updatedAtMs" | "state" | "enabled">) => {
      addRequests.push(structuredClone(request));
      const now = 1_775_000_000_000;
      const job: CronJob = {
        ...structuredClone(request),
        id: "job-1",
        enabled: true,
        state: { nextRunAtMs: request.schedule.kind === "every" ? now + (request.schedule.everyMs ?? 0) : null },
        createdAtMs: now,
        updatedAtMs: now,
      };
      jobs.set(job.id, structuredClone(job));
      return structuredClone(job);
    },
    listJobs: async () => [...jobs.values()].map((job) => structuredClone(job)),
    removeJob: async (jobId: string) => {
      if (jobId === "protected" || jobId === "dream") {
        return "protected" as const;
      }
      return jobs.delete(jobId) ? "removed" as const : "not_found" as const;
    },
  };
}

const context = { runId: "run-1", traceId: "trace-1", sessionId: "chat-1" };

describe("createCronTool", () => {
  test("adds every schedules with session delivery context and lists them", async () => {
    const bridge = memoryBridge();
    const tool = createCronTool({ bridge, defaultTimezone: "UTC" });

    await expect(tool.execute({
      action: "add",
      message: "Check status",
      every_seconds: 60,
      deliver: true,
    }, context)).resolves.toEqual({ content: "Created job 'Check status' (id: job-1)" });

    await expect(tool.execute({ action: "list" }, context)).resolves.toMatchObject({
      content: expect.stringContaining("Scheduled jobs:\n- Check status (id: job-1, every 1m)"),
    });
  });

  test("validates add inputs and formats remove outcomes", async () => {
    const tool = createCronTool({ bridge: memoryBridge(), defaultTimezone: "UTC" });

    await expect(tool.execute({ action: "add", every_seconds: 60 }, context)).resolves.toEqual({
      content: "Error: message is required for add",
    });
    await expect(tool.execute({ action: "add", message: "Bad tz", tz: "UTC" }, context)).resolves.toEqual({
      content: "Error: tz can only be used with cron_expr",
    });
    await expect(tool.execute({ action: "add", message: "Bad timezone", cron_expr: "0 9 * * *", tz: "Mars/Phobos" }, context)).resolves.toEqual({
      content: "Error: unknown timezone 'Mars/Phobos'",
    });
    await expect(tool.execute({ action: "add", message: "Missing schedule" }, context)).resolves.toEqual({
      content: "Error: either every_seconds, cron_expr, or at is required",
    });
    await expect(tool.execute({ action: "remove" }, context)).resolves.toEqual({
      content: "Error: job_id is required for remove",
    });
    await expect(tool.execute({ action: "remove", job_id: "missing" }, context)).resolves.toEqual({
      content: "Job missing not found",
    });
    await expect(tool.execute({ action: "remove", job_id: "protected" }, context)).resolves.toEqual({
      content: "Cannot remove job `protected`.\nThis is a protected system-managed cron job.",
    });
  });

  test("rejects scheduling new jobs from cron-triggered sessions", async () => {
    const bridge = memoryBridge();
    const tool = createCronTool({ bridge, defaultTimezone: "UTC" });

    await expect(tool.execute({
      action: "add",
      message: "Nested reminder",
      every_seconds: 60,
    }, { ...context, sessionId: "cron:job-1" })).resolves.toEqual({
      content: "Error: cannot schedule new jobs from within a cron job execution",
    });
    expect(bridge.addRequests).toEqual([]);
  });

  test("formats protected system jobs like Python", async () => {
    const tool = createCronTool({
      bridge: memoryBridge([
        {
          id: "dream",
          name: "dream",
          enabled: true,
          schedule: { kind: "every", everyMs: 3_600_000 },
          payload: { kind: "system_event", message: "dream", deliver: false },
          state: { nextRunAtMs: 1_775_003_600_000 },
          createdAtMs: 1_775_000_000_000,
          updatedAtMs: 1_775_000_000_000,
          deleteAfterRun: false,
        },
      ]),
      defaultTimezone: "UTC",
    });

    await expect(tool.execute({ action: "list" }, context)).resolves.toEqual({
      content: [
        "Scheduled jobs:",
        "- dream (id: dream, every 1h)",
        "  Purpose: Dream memory consolidation for long-term memory.",
        "  Protected: visible for inspection, but cannot be removed.",
        "  Next run: 2026-04-01T00:33:20.000Z (UTC)",
      ].join("\n"),
    });
    await expect(tool.execute({ action: "remove", job_id: "dream" }, context)).resolves.toEqual({
      content: [
        "Cannot remove job `dream`.",
        "This is a system-managed Dream memory consolidation job for long-term memory.",
        "It remains visible so you can inspect it, but it cannot be removed.",
      ].join("\n"),
    });
  });
});
