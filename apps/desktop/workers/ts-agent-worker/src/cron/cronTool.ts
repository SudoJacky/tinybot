import type { Tool, ToolContext, ToolResult } from "../tools/tool.ts";
import type { CronBridge, CronRemoveStatus } from "./cronBridge.ts";
import type { CronJob, CronSchedule } from "./cronTypes.ts";

export interface CreateCronToolOptions {
  bridge: CronBridge;
  defaultTimezone?: CronDefaultTimezone;
}

type CronDefaultTimezone = string | (() => string | Promise<string>);

export function createCronTool(options: CreateCronToolOptions): Tool {
  const defaultTimezone = options.defaultTimezone ?? "UTC";
  const runtime = new CronToolRuntime(options.bridge, defaultTimezone);
  const defaultTimezoneLabel = typeof defaultTimezone === "string" && defaultTimezone.trim()
    ? defaultTimezone.trim()
    : "the configured timezone";
  return {
    name: "cron",
    description: `Schedule reminders and recurring tasks. Actions: add, list, remove. If tz is omitted, cron expressions and naive ISO times default to ${defaultTimezoneLabel}.`,
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
  private readonly defaultTimezone: CronDefaultTimezone;

  constructor(bridge: CronBridge, defaultTimezone: CronDefaultTimezone) {
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
    const deliveryContext = cronDeliveryContext(args, context);
    if (!deliveryContext) {
      return "Error: no session context (channel/chat_id)";
    }
    const tz = stringArg(args, "tz");
    const cronExpr = stringArg(args, "cron_expr");
    if (tz && !cronExpr) {
      return "Error: tz can only be used with cron_expr";
    }
    const defaultTimezone = await this.resolveDefaultTimezone();
    const scheduleResult = this.scheduleFromArgs(args, defaultTimezone);
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
        channel: deliveryContext.channel,
        to: deliveryContext.chatId,
      },
      deleteAfterRun: scheduleResult.deleteAfterRun,
    }, traceId(context));
    return `Created job '${job.name}' (id: ${job.id})`;
  }

  private scheduleFromArgs(args: Record<string, unknown>, defaultTimezone: string): { schedule: CronSchedule; deleteAfterRun: boolean } | string {
    const everySeconds = numberArg(args, "every_seconds");
    const cronExpr = stringArg(args, "cron_expr");
    const at = stringArg(args, "at");
    const tz = stringArg(args, "tz");
    const scheduleSourceCount = [
      everySeconds !== null && everySeconds > 0,
      !!cronExpr,
      !!at,
    ].filter(Boolean).length;
    if (scheduleSourceCount > 1) {
      return "Error: exactly one of every_seconds, cron_expr, or at is required";
    }
    if (everySeconds && everySeconds > 0) {
      return { schedule: { kind: "every", everyMs: everySeconds * 1000 }, deleteAfterRun: false };
    }
    if (cronExpr) {
      return "Error: cron_expr schedules are not supported yet";
    }
    if (at) {
      const parsed = parseAtTimestampMs(at, defaultTimezone);
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
    const defaultTimezone = await this.resolveDefaultTimezone();
    return `Scheduled jobs:\n${jobs.map((job) => this.formatJob(job, defaultTimezone)).join("\n")}`;
  }

  private formatJob(job: CronJob, defaultTimezone: string): string {
    const lines = [`- ${job.name} (id: ${job.id}, ${this.formatTiming(job.schedule, defaultTimezone)})`];
    if (job.payload.kind === "system_event") {
      lines.push(`  Purpose: ${systemJobPurpose(job)}`);
      lines.push("  Protected: visible for inspection, but cannot be removed.");
    }
    lines.push(...this.formatState(job, defaultTimezone));
    return lines.join("\n");
  }

  private formatTiming(schedule: CronSchedule, defaultTimezone: string): string {
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
      return `at ${formatTimestamp(schedule.atMs, displayTimezone(schedule, defaultTimezone))}`;
    }
    return schedule.kind;
  }

  private formatState(job: CronJob, defaultTimezone: string): string[] {
    const lines: string[] = [];
    const timezone = displayTimezone(job.schedule, defaultTimezone);
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

  private async resolveDefaultTimezone(): Promise<string> {
    if (typeof this.defaultTimezone === "string") {
      return this.defaultTimezone.trim() || "UTC";
    }
    try {
      const value = await this.defaultTimezone();
      return value.trim() || "UTC";
    } catch {
      return "UTC";
    }
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
  const parts = timezoneDateTimeParts(ms, timezone);
  const offset = timezoneOffsetMs(ms, timezone);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${formatOffset(offset)} (${timezone})`;
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
  const parts = timezoneDateTimeFormat(timezone).formatToParts(new Date(timestampMs));
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"), value("second"));
  return asUtc - timestampMs;
}

function timezoneDateTimeParts(timestampMs: number, timezone: string): Record<"year" | "month" | "day" | "hour" | "minute" | "second", string> {
  const parts = timezoneDateTimeFormat(timezone).formatToParts(new Date(timestampMs));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "00";
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

function timezoneDateTimeFormat(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

function formatOffset(offsetMs: number): string {
  if (offsetMs === 0) {
    return "+00:00";
  }
  const sign = offsetMs < 0 ? "-" : "+";
  const absMinutes = Math.abs(offsetMs) / 60_000;
  const hours = Math.floor(absMinutes / 60).toString().padStart(2, "0");
  const minutes = Math.floor(absMinutes % 60).toString().padStart(2, "0");
  return `${sign}${hours}:${minutes}`;
}

function traceId(context: ToolContext): string {
  return context.traceId ?? context.runId;
}

function isCronExecutionContext(context: ToolContext): boolean {
  return context.sessionId?.startsWith("cron:") === true;
}

function cronDeliveryContext(args: Record<string, unknown>, context: ToolContext): { channel: string; chatId: string } | null {
  const sessionId = context.sessionId;
  if (!sessionId) {
    return null;
  }
  const explicitChannel = stringArg(args, "channel");
  if (!explicitChannel) {
    const separator = sessionId.indexOf(":");
    if (separator > 0) {
      return {
        channel: sessionId.slice(0, separator),
        chatId: sessionId.slice(separator + 1),
      };
    }
  }
  return {
    channel: explicitChannel || "native",
    chatId: sessionId,
  };
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
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    return value.length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "object") {
    return Object.keys(value).length > 0;
  }
  return Boolean(value);
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
