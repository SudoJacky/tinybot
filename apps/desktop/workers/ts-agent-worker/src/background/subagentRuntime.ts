import type {
  BackgroundRunCompletion,
  BackgroundRunRecord,
  BackgroundRunRegistry,
  BackgroundRunStatus,
} from "./backgroundRegistryBridge.ts";

export type SubagentStatus = "completed" | "failed";

export interface SubagentSpawnRequest {
  task: string;
  label?: string;
  sessionKey?: string;
  metadata?: Record<string, unknown>;
  onComplete?: (completion: SubagentCompletion) => Promise<void>;
}

export interface SubagentRunRequest {
  id: string;
  task: string;
  label: string;
  sessionKey?: string;
  metadata?: Record<string, unknown>;
  signal: AbortSignal;
}

export interface SubagentRunResult {
  status: SubagentStatus;
  result: string;
  error?: string;
}

export interface SubagentCompletion extends SubagentRunResult {
  id: string;
  label: string;
  sessionKey?: string;
  metadata?: Record<string, unknown>;
}

export interface SubagentSpawnResult {
  id: string;
  label: string;
  message: string;
  queued: boolean;
  runningCount: number;
  queuedCount: number;
}

export interface SubagentRuntimeOptions {
  maxConcurrent?: number;
  timeoutMs?: number;
  idGenerator?: () => string;
  nowMs?: () => number;
  registry?: BackgroundRunRegistry;
  source?: BackgroundRunRecord["source"];
  runner: (request: SubagentRunRequest) => Promise<SubagentRunResult>;
}

type QueuedSubagent = {
  request: SubagentSpawnRequest;
  id: string;
  label: string;
  controller: AbortController;
};

const DEFAULT_MAX_CONCURRENT = 5;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export class SubagentRuntime {
  private readonly maxConcurrent: number;
  private readonly timeoutMs: number;
  private readonly idGenerator: () => string;
  private readonly nowMs: () => number;
  private readonly registry?: BackgroundRunRegistry;
  private readonly source: BackgroundRunRecord["source"];
  private readonly runner: SubagentRuntimeOptions["runner"];
  private readonly queue: QueuedSubagent[] = [];
  private readonly active = new Map<string, QueuedSubagent>();
  private readonly sessions = new Map<string, Set<string>>();

  constructor(options: SubagentRuntimeOptions) {
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
    this.timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.idGenerator = options.idGenerator ?? randomSubagentId;
    this.nowMs = options.nowMs ?? Date.now;
    this.registry = options.registry;
    this.source = options.source ?? "task";
    this.runner = options.runner;
  }

  async spawn(request: SubagentSpawnRequest): Promise<SubagentSpawnResult> {
    const id = this.idGenerator();
    const label = request.label || shortLabel(request.task);
    const queued: QueuedSubagent = { request, id, label, controller: new AbortController() };
    this.trackSession(request.sessionKey, id);
    const shouldQueue = this.active.size >= this.maxConcurrent;
    if (shouldQueue) {
      this.queue.push(queued);
      this.recordRun(queued, "queued");
    } else {
      this.start(queued);
    }
    const runningCount = this.active.size;
    const queuedCount = this.queue.length;
    return {
      id,
      label,
      queued: shouldQueue,
      runningCount,
      queuedCount,
      message: shouldQueue
        ? `Subagent [${label}] queued (id: ${id}). ${queuedCount} waiting, ${runningCount} running.`
        : `Subagent [${label}] started (id: ${id}). Running: ${runningCount}/${this.maxConcurrent}`,
    };
  }

  getSessionSubagentIds(sessionKey: string): string[] {
    return [...(this.sessions.get(sessionKey) ?? [])];
  }

  getRunningCount(): number {
    return this.active.size + this.queue.length;
  }

  cancelSession(sessionKey: string): number {
    const ids = this.sessions.get(sessionKey);
    if (!ids) {
      return 0;
    }
    return this.cancelWhere((entry) => ids.has(entry.id));
  }

  cancelPlan(planId: string): number {
    return this.cancelWhere((entry) => entry.request.metadata?.planId === planId);
  }

  private start(entry: QueuedSubagent): void {
    this.active.set(entry.id, entry);
    this.recordRun(entry, "running");
    void this.run(entry);
  }

  private async run(entry: QueuedSubagent): Promise<void> {
    const { request, id, label } = entry;
    const startedAt = Date.now();
    let completion: SubagentRunResult;
    try {
      completion = await withTimeoutOrAbort(
        this.runner({
          id,
          label,
          task: request.task,
          sessionKey: request.sessionKey,
          metadata: request.metadata,
          signal: entry.controller.signal,
        }),
        this.timeoutMs,
        () => timeoutResult(startedAt, this.timeoutMs),
        entry.controller.signal,
        () => cancelledResult(),
      );
    } catch (error) {
      completion = {
        status: "failed",
        result: `Error: ${errorMessage(error)}`,
        error: `Error: ${errorMessage(error)}`,
      };
    }

    await this.complete(entry, completion);
  }

  private async complete(entry: QueuedSubagent, result: SubagentRunResult): Promise<void> {
    this.active.delete(entry.id);
    this.untrackSession(entry.request.sessionKey, entry.id);
    this.recordCompletion(entry, result);
    try {
      await entry.request.onComplete?.({
        id: entry.id,
        label: entry.label,
        sessionKey: entry.request.sessionKey,
        metadata: entry.request.metadata,
        ...result,
      });
    } catch {
      // Match Python SubagentManager: callback failures must not wedge cleanup or queued work.
    }
    this.startNext();
  }

  private startNext(): void {
    while (this.active.size < this.maxConcurrent && this.queue.length > 0) {
      this.start(this.queue.shift()!);
    }
  }

  private trackSession(sessionKey: string | undefined, id: string): void {
    if (!sessionKey) {
      return;
    }
    const ids = this.sessions.get(sessionKey) ?? new Set<string>();
    ids.add(id);
    this.sessions.set(sessionKey, ids);
  }

  private untrackSession(sessionKey: string | undefined, id: string): void {
    if (!sessionKey) {
      return;
    }
    const ids = this.sessions.get(sessionKey);
    if (!ids) {
      return;
    }
    ids.delete(id);
    if (ids.size === 0) {
      this.sessions.delete(sessionKey);
    }
  }

  private cancelWhere(predicate: (entry: QueuedSubagent) => boolean): number {
    let cancelled = 0;
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const queued = this.queue[index];
      if (predicate(queued)) {
        this.queue.splice(index, 1);
        this.untrackSession(queued.request.sessionKey, queued.id);
        this.recordCompletion(queued, cancelledResult());
        cancelled += 1;
      }
    }
    for (const active of this.active.values()) {
      if (predicate(active) && !active.controller.signal.aborted) {
        active.controller.abort();
        cancelled += 1;
      }
    }
    return cancelled;
  }

  private recordRun(entry: QueuedSubagent, status: Extract<BackgroundRunStatus, "queued" | "running">): void {
    const now = this.nowMs();
    const record: BackgroundRunRecord = {
      id: entry.id,
      kind: "subagent",
      source: this.source,
      status,
      label: entry.label,
      sessionKey: entry.request.sessionKey,
      planId: stringMetadata(entry.request.metadata, "planId"),
      subtaskId: stringMetadata(entry.request.metadata, "subtaskId"),
      startedAtMs: now,
      updatedAtMs: now,
      metadata: { ...(entry.request.metadata ?? {}) },
    };
    void this.registry?.upsertRun(record, traceIdFor(entry)).catch(() => {});
  }

  private recordCompletion(entry: QueuedSubagent, result: SubagentRunResult): void {
    const completion: BackgroundRunCompletion = {
      runId: entry.id,
      status: completionStatus(entry, result),
      completedAtMs: this.nowMs(),
      result: result.result,
      error: result.error ?? null,
    };
    void this.registry?.completeRun(completion, traceIdFor(entry)).catch(() => {});
  }
}

function traceIdFor(entry: QueuedSubagent): string {
  return stringMetadata(entry.request.metadata, "traceId") ?? `trace-subagent-${entry.id}`;
}

function stringMetadata(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function completionStatus(
  entry: QueuedSubagent,
  result: SubagentRunResult,
): Extract<BackgroundRunStatus, "completed" | "failed" | "cancelled"> {
  if (entry.controller.signal.aborted) {
    return "cancelled";
  }
  return result.status;
}

function shortLabel(task: string): string {
  const trimmed = task.trim();
  return trimmed.length > 30 ? `${trimmed.slice(0, 30)}...` : trimmed;
}

function randomSubagentId(): string {
  return Math.random().toString(16).slice(2, 10);
}

function timeoutResult(startedAt: number, timeoutMs: number): SubagentRunResult {
  const elapsed = Math.max(0, (Date.now() - startedAt) / 1000);
  const limit = (timeoutMs / 1000).toFixed(1);
  const message = `Subagent timed out after ${elapsed.toFixed(1)}s (limit: ${limit}s)`;
  return { status: "failed", result: message, error: message };
}

function cancelledResult(): SubagentRunResult {
  const message = "Subagent cancelled.";
  return { status: "failed", result: message, error: message };
}

function withTimeoutOrAbort<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => T,
  signal: AbortSignal,
  onAbort: () => T,
): Promise<T> {
  if (signal.aborted) {
    return Promise.resolve(onAbort());
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      resolve(onAbort());
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(onTimeout());
    }, timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
