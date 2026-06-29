import type { JsonObject } from "../protocol/messages.ts";
import type { NativeRpcClient } from "../tools/nativeToolProxy.ts";

export type BackgroundRunStatus = "queued" | "running" | "awaiting_approval" | "completed" | "failed" | "cancelled";

export interface BackgroundRunRecord {
  id: string;
  kind: "subagent" | "cron" | "task";
  source: "task" | "subagent" | "cron" | "approval" | "cowork" | "file" | "provider";
  status: BackgroundRunStatus;
  label?: string;
  sessionKey?: string;
  planId?: string;
  subtaskId?: string;
  cronJobId?: string;
  startedAtMs: number;
  updatedAtMs: number;
  completedAtMs?: number;
  result?: string | null;
  error?: string | null;
  metadata?: Record<string, unknown>;
}

export interface BackgroundRunCompletion {
  runId: string;
  status: Extract<BackgroundRunStatus, "completed" | "failed" | "cancelled">;
  completedAtMs: number;
  result?: string | null;
  error?: string | null;
}

export interface BackgroundTraceEvent {
  eventId: string;
  eventType: string;
  sessionKey: string;
  turnId: string;
  parentStepId?: string;
  delegateId?: string;
  childRunId?: string;
  childStepId?: string;
  traceRef?: string;
  sequence: number;
  createdAt: string;
  payload: Record<string, unknown>;
}

export interface BackgroundTraceListFilter {
  sessionKey?: string;
  delegateId?: string;
  traceRef?: string;
  eventType?: string;
  artifactId?: string;
}

export interface BackgroundDelegateTrace {
  sessionKey: string;
  delegateId?: string;
  childRunId?: string;
  traceRef?: string;
  status?: string;
  finalOutput?: string;
  events: BackgroundTraceEvent[];
  approvals: Record<string, unknown>[];
  artifacts: Record<string, unknown>[];
}

export interface BackgroundRunRegistry {
  upsertRun(run: BackgroundRunRecord, traceId: string): Promise<void>;
  completeRun(completion: BackgroundRunCompletion, traceId: string): Promise<void>;
}

export interface BackgroundRunReader {
  listRuns(traceId?: string): Promise<BackgroundRunRecord[]>;
}

export interface BackgroundTraceJournal {
  appendTraceEvent(event: BackgroundTraceEvent, traceId: string): Promise<void>;
  listTraceEvents(filter: BackgroundTraceListFilter, traceId: string): Promise<BackgroundTraceEvent[]>;
  getDelegateTrace(filter: BackgroundTraceListFilter, traceId: string): Promise<BackgroundDelegateTrace | null>;
  getArtifact(filter: BackgroundTraceListFilter, traceId: string): Promise<Record<string, unknown> | null>;
}

export class NativeBackgroundRegistryBridge implements BackgroundRunRegistry, BackgroundRunReader, BackgroundTraceJournal {
  private readonly rpcClient: NativeRpcClient;

  constructor(rpcClient: NativeRpcClient) {
    this.rpcClient = rpcClient;
  }

  async upsertRun(run: BackgroundRunRecord, traceId: string): Promise<void> {
    await this.rpcClient.request(traceId, "background.run.upsert", { run: run as unknown as JsonObject });
  }

  async completeRun(completion: BackgroundRunCompletion, traceId: string): Promise<void> {
    await this.rpcClient.request(traceId, "background.run.complete", {
      run_id: completion.runId,
      status: completion.status,
      completedAtMs: completion.completedAtMs,
      result: completion.result ?? null,
      error: completion.error ?? null,
    });
  }

  async listRuns(traceId = "trace-background-run-list"): Promise<BackgroundRunRecord[]> {
    const result = await this.rpcClient.request(traceId, "background.run.list", {});
    if (!isRecord(result) || !Array.isArray(result.runs)) {
      return [];
    }
    return result.runs.filter(isRecord).map((run) => run as unknown as BackgroundRunRecord);
  }

  async appendTraceEvent(event: BackgroundTraceEvent, traceId: string): Promise<void> {
    await this.rpcClient.request(traceId, "background.trace.append", { event: event as unknown as JsonObject });
  }

  async listTraceEvents(filter: BackgroundTraceListFilter, traceId: string): Promise<BackgroundTraceEvent[]> {
    const result = await this.rpcClient.request(traceId, "background.trace.list", { filter: filter as unknown as JsonObject });
    if (!isRecord(result) || !Array.isArray(result.events)) {
      return [];
    }
    return result.events.filter(isRecord).map((event) => event as unknown as BackgroundTraceEvent);
  }

  async getDelegateTrace(filter: BackgroundTraceListFilter, traceId: string): Promise<BackgroundDelegateTrace | null> {
    const result = await this.rpcClient.request(traceId, "background.trace.get_delegate_trace", { filter: filter as unknown as JsonObject });
    if (!isRecord(result) || !isRecord(result.trace)) {
      return null;
    }
    const trace = result.trace;
    const events = Array.isArray(trace.events)
      ? trace.events.filter(isRecord).map((event) => event as unknown as BackgroundTraceEvent)
      : [];
    const approvals = Array.isArray(trace.approvals)
      ? trace.approvals.filter(isRecord)
      : [];
    const artifacts = Array.isArray(trace.artifacts)
      ? trace.artifacts.filter(isRecord)
      : [];
    return {
      sessionKey: String(trace.sessionKey ?? trace.session_key ?? ""),
      delegateId: optionalString(trace.delegateId ?? trace.delegate_id),
      childRunId: optionalString(trace.childRunId ?? trace.child_run_id),
      traceRef: optionalString(trace.traceRef ?? trace.trace_ref),
      status: optionalString(trace.status),
      finalOutput: optionalString(trace.finalOutput ?? trace.final_output),
      events,
      approvals,
      artifacts,
    };
  }

  async getArtifact(filter: BackgroundTraceListFilter, traceId: string): Promise<Record<string, unknown> | null> {
    const result = await this.rpcClient.request(traceId, "background.trace.get_artifact", { filter: filter as unknown as JsonObject });
    if (!isRecord(result) || !isRecord(result.artifact)) {
      return null;
    }
    return result.artifact;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
