import type { Tool, ToolContext, ToolResult } from "../tools/tool.ts";
import type { CronBridge, CronRemoveStatus } from "./cronBridge.ts";
import type { CronJob, CronSchedule } from "./cronTypes.ts";

export interface CreateCronToolOptions {
  bridge: CronBridge;
  defaultTimezone?: string;
}

export function createCronTool(options: CreateCronToolOptions): Tool {
  const runtime = new CronToolRuntime(options.bridge, options.defaultTimezone ?? "UTC");
  return {
    name: "cron",
    description: `Schedule reminders and recurring tasks. Actions: add, list, remove. If tz is omitted, cron expressions and naive ISO times default to ${options.defaultTimezone ?? "UTC"}.`,
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "list", "remove"] },
        message: { type: "string" },
        every_seconds: { type: "integer" },
        cron_expr: { type: "string" },
        tz: { type: "string" },
        at: { type: "string" },
        deliver: { type: "boolean", default: true },
        job_id: { type: "string" },
      },
      required: ["action"],
    },
    capabilities: ["cron.read", "cron.write"],
    concurrencySafe: false,
    execute: (args, context) => runtime.execute(args, context),
  };
}

class CronToolRuntime {
  private readonly bridge: CronBridge;
  private readonly defaultTimezone: string;

  constructor(bridge: CronBridge, defaultTimezone: string) {
    this.bridge = bridge;
    this.defaultTimezone = defaultTimezone;
  }

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const action = stringArg(args, "action");
    if (action === "add") {
      return { content: await this.addJob(args, context) };
    }
    if (action === "list") {
      return { content: await this.listJobs(context) };
    }
    if (action === "remove") {
      return { content: await this.removeJob(args, context) };
    }
    return { content: `Unknown action: ${action}` };
  }

  private async addJob(args: Record<string, unknown>, context: ToolContext): Promise<string> {
    const message = stringArg(args, "message");
    if (!message) {
      return "Error: message is required for add";
    }
    const channel = stringArg(args, "channel") || "native";
    const chatId = context.sessionId ?? context.runId;
    const tz = stringArg(args, "tz");
    const cronExpr = stringArg(args, "cron_expr");
    if (tz && !cronExpr) {
      return "Error: tz can only be used with cron_expr";
    }
    const scheduleResult = this.scheduleFromArgs(args);
    if (typeof scheduleResult === "string") {
      return scheduleResult;
    }
    const job = await this.bridge.addJob({
      name: message.slice(0, 30),
      schedule: scheduleResult.schedule,
      payload: {
        kind: "agent_turn",
        message,
        deliver: booleanArg(args, "deliver", true),
        channel,
        to: chatId,
      },
      deleteAfterRun: scheduleResult.deleteAfterRun,
    }, traceId(context));
    return `Created job '${job.name}' (id: ${job.id})`;
  }

  private scheduleFromArgs(args: Record<string, unknown>): { schedule: CronSchedule; deleteAfterRun: boolean } | string {
    const everySeconds = numberArg(args, "every_seconds");
    const cronExpr = stringArg(args, "cron_expr");
    const at = stringArg(args, "at");
    const tz = stringArg(args, "tz");
    if (everySeconds && everySeconds > 0) {
      return { schedule: { kind: "every", everyMs: everySeconds * 1000 }, deleteAfterRun: false };
    }
    if (cronExpr) {
      return { schedule: { kind: "cron", expr: cronExpr, tz: tz || this.defaultTimezone }, deleteAfterRun: false };
    }
    if (at) {
      const parsed = Date.parse(at);
      if (Number.isNaN(parsed)) {
        return `Error: invalid ISO datetime format '${at}'. Expected format: YYYY-MM-DDTHH:MM:SS`;
      }
      return { schedule: { kind: "at", atMs: parsed }, deleteAfterRun: true };
    }
    return "Error: either every_seconds, cron_expr, or at is required";
  }

  private async listJobs(context: ToolContext): Promise<string> {
    const jobs = await this.bridge.listJobs(traceId(context));
    if (jobs.length === 0) {
      return "No scheduled jobs.";
    }
    return `Scheduled jobs:\n${jobs.map((job) => this.formatJob(job)).join("\n")}`;
  }

  private formatJob(job: CronJob): string {
    return `- ${job.name} (id: ${job.id}, ${this.formatTiming(job.schedule)})`;
  }

  private formatTiming(schedule: CronSchedule): string {
    if (schedule.kind === "cron") {
      return `cron: ${schedule.expr ?? ""}${schedule.tz ? ` (${schedule.tz})` : ""}`;
    }
    if (schedule.kind === "every" && schedule.everyMs) {
      if (schedule.everyMs % 3_600_000 === 0) {
        return `every ${schedule.everyMs / 3_600_000}h`;
      }
      if (schedule.everyMs % 60_000 === 0) {
        return `every ${schedule.everyMs / 60_000}m`;
      }
      if (schedule.everyMs % 1000 === 0) {
        return `every ${schedule.everyMs / 1000}s`;
      }
      return `every ${schedule.everyMs}ms`;
    }
    if (schedule.kind === "at" && schedule.atMs) {
      return `at ${new Date(schedule.atMs).toISOString()} (${this.defaultTimezone})`;
    }
    return schedule.kind;
  }

  private async removeJob(args: Record<string, unknown>, context: ToolContext): Promise<string> {
    const jobId = stringArg(args, "job_id");
    if (!jobId) {
      return "Error: job_id is required for remove";
    }
    return removeStatusText(jobId, await this.bridge.removeJob(jobId, traceId(context)));
  }
}

function removeStatusText(jobId: string, status: CronRemoveStatus): string {
  if (status === "removed") {
    return `Removed job ${jobId}`;
  }
  if (status === "protected") {
    return `Cannot remove job \`${jobId}\`.\nThis is a protected system-managed cron job.`;
  }
  return `Job ${jobId} not found`;
}

function traceId(context: ToolContext): string {
  return context.traceId ?? context.runId;
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value.trim() : "";
}

function numberArg(args: Record<string, unknown>, key: string): number | null {
  const value = args[key];
  return typeof value === "number" ? value : null;
}

function booleanArg(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = args[key];
  return typeof value === "boolean" ? value : fallback;
}
