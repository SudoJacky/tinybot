export type CronScheduleKind = "at" | "every" | "cron";

export interface CronSchedule {
  kind: CronScheduleKind;
  atMs?: number | null;
  everyMs?: number | null;
  expr?: string | null;
  tz?: string | null;
}

export interface CronPayload {
  kind: "agent_turn" | "system_event";
  message: string;
  deliver: boolean;
  channel?: string | null;
  to?: string | null;
}

export interface CronRunRecord {
  runAtMs: number;
  status: "ok" | "error" | "skipped";
  durationMs?: number;
  error?: string | null;
}

export interface CronJobState {
  nextRunAtMs?: number | null;
  lastRunAtMs?: number | null;
  lastStatus?: "ok" | "error" | "skipped" | null;
  lastError?: string | null;
  runHistory?: CronRunRecord[];
}

export interface CronJob {
  id: string;
  name: string;
  enabled: boolean;
  schedule: CronSchedule;
  payload: CronPayload;
  state: CronJobState;
  createdAtMs: number;
  updatedAtMs: number;
  deleteAfterRun: boolean;
}

export interface CronJobInput extends Partial<Omit<CronJob, "schedule" | "payload" | "state">> {
  id: string;
  name: string;
  schedule?: Partial<CronSchedule> & { kind: CronScheduleKind };
  payload?: Partial<CronPayload>;
  state?: Partial<CronJobState>;
  created_at_ms?: number;
  updated_at_ms?: number;
  delete_after_run?: boolean;
}
