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
      if (isCronExecutionContext(context)) {
        return { content: "Error: cannot schedule new jobs from within a cron job execution" };
      }
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
    const chatId = context.sessionId;
    if (!chatId) {
      return "Error: no session context (channel/chat_id)";
    }
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
      const timezone = tz || this.defaultTimezone;
      if (!isValidTimezone(timezone)) {
        return `Error: unknown timezone '${timezone}'`;
      }
      return { schedule: { kind: "cron", expr: cronExpr, tz: timezone }, deleteAfterRun: false };
    }
    if (at) {
      const parsed = parseAtTimestampMs(at, this.defaultTimezone);
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
    const lines = [`- ${job.name} (id: ${job.id}, ${this.formatTiming(job.schedule)})`];
    if (job.payload.kind === "system_event") {
      lines.push(`  Purpose: ${systemJobPurpose(job)}`);
      lines.push("  Protected: visible for inspection, but cannot be removed.");
    }
    lines.push(...this.formatState(job));
    return lines.join("\n");
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

  private formatState(job: CronJob): string[] {
    const lines: string[] = [];
    const timezone = displayTimezone(job.schedule, this.defaultTimezone);
    if (job.state.lastRunAtMs) {
      let line = `  Last run: ${formatTimestamp(job.state.lastRunAtMs, timezone)} - ${job.state.lastStatus ?? "unknown"}`;
      if (job.state.lastError) {
        line += ` (${job.state.lastError})`;
      }
      lines.push(line);
    }
    if (job.state.nextRunAtMs) {
      lines.push(`  Next run: ${formatTimestamp(job.state.nextRunAtMs, timezone)}`);
    }
    return lines;
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
    if (jobId === "dream") {
      return [
        "Cannot remove job `dream`.",
        "This is a system-managed Dream memory consolidation job for long-term memory.",
        "It remains visible so you can inspect it, but it cannot be removed.",
      ].join("\n");
    }
    return `Cannot remove job \`${jobId}\`.\nThis is a protected system-managed cron job.`;
  }
  return `Job ${jobId} not found`;
}

function systemJobPurpose(job: CronJob): string {
  if (job.name === "dream") {
    return "Dream memory consolidation for long-term memory.";
  }
  return "System-managed internal job.";
}

function displayTimezone(schedule: CronSchedule, defaultTimezone: string): string {
  return schedule.tz || defaultTimezone;
}

function formatTimestamp(ms: number, timezone: string): string {
  return `${new Date(ms).toISOString()} (${timezone})`;
}

function parseAtTimestampMs(value: string, defaultTimezone: string): number {
  if (hasExplicitTimezone(value)) {
    return Date.parse(value);
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?$/.exec(value);
  if (!match || !isValidTimezone(defaultTimezone)) {
    return NaN;
  }
  const [, year, month, day, hour, minute, second = "00"] = match;
  const utcGuess = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  return utcGuess - timezoneOffsetMs(utcGuess, defaultTimezone);
}

function hasExplicitTimezone(value: string): boolean {
  return /(?:Z|[+-]\d{2}:\d{2})$/i.test(value);
}

function timezoneOffsetMs(timestampMs: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(timestampMs));
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"), value("second"));
  return asUtc - timestampMs;
}

function traceId(context: ToolContext): string {
  return context.traceId ?? context.runId;
}

function isCronExecutionContext(context: ToolContext): boolean {
  return context.sessionId?.startsWith("cron:") === true;
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

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch (error) {
    if (error instanceof RangeError) {
      return false;
    }
    throw error;
  }
}
