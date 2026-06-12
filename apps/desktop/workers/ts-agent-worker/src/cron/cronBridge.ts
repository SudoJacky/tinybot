import type { JsonObject } from "../protocol/messages.ts";
import type { NativeRpcClient } from "../tools/nativeToolProxy.ts";
import type { CronJob, CronJobInput } from "./cronTypes.ts";

export type CronRemoveStatus = "removed" | "protected" | "not_found";

export interface CronBridge {
  addJob(job: Omit<CronJob, "id" | "createdAtMs" | "updatedAtMs" | "state" | "enabled">, traceId: string): Promise<CronJob>;
  listJobs(traceId: string): Promise<CronJob[]>;
  removeJob(jobId: string, traceId: string): Promise<CronRemoveStatus>;
}

export class NativeCronBridge implements CronBridge {
  private readonly rpcClient: NativeRpcClient;

  constructor(rpcClient: NativeRpcClient) {
    this.rpcClient = rpcClient;
  }

  async addJob(job: Omit<CronJob, "id" | "createdAtMs" | "updatedAtMs" | "state" | "enabled">, traceId: string): Promise<CronJob> {
    const result = await this.rpcClient.request(traceId, "cron.job.add", { job: nativeCronJobRequest(job) });
    const payload = asObject(result);
    const normalized = normalizeCronJob(payload?.job) ?? normalizeCronJob({
      id: "",
      name: job.name,
      schedule: job.schedule,
      payload: job.payload,
      deleteAfterRun: job.deleteAfterRun,
    } as CronJobInput);
    if (!normalized) {
      throw new Error("cron.job.add returned invalid job");
    }
    return normalized;
  }

  async listJobs(traceId: string): Promise<CronJob[]> {
    const result = await this.rpcClient.request(traceId, "cron.job.list", {});
    const payload = asObject(result);
    const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
    return jobs.map(normalizeCronJob).filter((job): job is CronJob => job !== null);
  }

  async removeJob(jobId: string, traceId: string): Promise<CronRemoveStatus> {
    const result = await this.rpcClient.request(traceId, "cron.job.remove", { job_id: jobId });
    const status = asObject(result)?.status;
    return status === "removed" || status === "protected" || status === "not_found" ? status : "not_found";
  }
}

export function normalizeCronJob(value: unknown): CronJob | null {
  const input = asObject(value) as CronJobInput | undefined;
  if (!input || typeof input.id !== "string" || typeof input.name !== "string") {
    return null;
  }
  const schedule = asObject(input.schedule);
  const payload = asObject(input.payload);
  const state = asObject(input.state);
  return {
    id: input.id,
    name: input.name,
    enabled: input.enabled ?? true,
    schedule: {
      kind: schedule?.kind === "at" || schedule?.kind === "cron" ? schedule.kind : "every",
      atMs: numberValue(schedule?.atMs ?? schedule?.at_ms),
      everyMs: numberValue(schedule?.everyMs ?? schedule?.every_ms),
      expr: stringValue(schedule?.expr),
      tz: stringValue(schedule?.tz),
    },
    payload: {
      kind: payload?.kind === "system_event" ? "system_event" : "agent_turn",
      message: stringValue(payload?.message) ?? "",
      deliver: payload?.deliver === true,
      channel: stringValue(payload?.channel),
      to: stringValue(payload?.to),
    },
    state: {
      nextRunAtMs: numberValue(state?.nextRunAtMs ?? state?.next_run_at_ms),
      lastRunAtMs: numberValue(state?.lastRunAtMs ?? state?.last_run_at_ms),
      lastStatus: state?.lastStatus === "ok" || state?.lastStatus === "error" || state?.lastStatus === "skipped"
        ? state.lastStatus
        : state?.last_status === "ok" || state?.last_status === "error" || state?.last_status === "skipped"
          ? state.last_status
          : null,
      lastError: stringValue(state?.lastError ?? state?.last_error),
      runHistory: [],
    },
    createdAtMs: numberValue(input.createdAtMs ?? input.created_at_ms) ?? 0,
    updatedAtMs: numberValue(input.updatedAtMs ?? input.updated_at_ms) ?? 0,
    deleteAfterRun: input.deleteAfterRun ?? input.delete_after_run ?? false,
  };
}

function nativeCronJobRequest(job: Omit<CronJob, "id" | "createdAtMs" | "updatedAtMs" | "state" | "enabled">): JsonObject {
  return {
    name: job.name,
    schedule: { ...job.schedule },
    payload: { ...job.payload },
    deleteAfterRun: job.deleteAfterRun,
  };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
