import type { JsonObject } from "../protocol/messages.ts";
import type { NativeRpcClient } from "../tools/nativeToolProxy.ts";

export type BackgroundRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

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

export interface BackgroundRunRegistry {
  upsertRun(run: BackgroundRunRecord, traceId: string): Promise<void>;
  completeRun(completion: BackgroundRunCompletion, traceId: string): Promise<void>;
}

export class NativeBackgroundRegistryBridge implements BackgroundRunRegistry {
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
}
