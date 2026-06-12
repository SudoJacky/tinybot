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
  runner: (request: SubagentRunRequest) => Promise<SubagentRunResult>;
}

type QueuedSubagent = {
  request: SubagentSpawnRequest;
  id: string;
  label: string;
};

const DEFAULT_MAX_CONCURRENT = 3;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export class SubagentRuntime {
  private readonly maxConcurrent: number;
  private readonly timeoutMs: number;
  private readonly idGenerator: () => string;
  private readonly runner: SubagentRuntimeOptions["runner"];
  private readonly queue: QueuedSubagent[] = [];
  private readonly active = new Map<string, QueuedSubagent>();
  private readonly sessions = new Map<string, Set<string>>();

  constructor(options: SubagentRuntimeOptions) {
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
    this.timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.idGenerator = options.idGenerator ?? randomSubagentId;
    this.runner = options.runner;
  }

  async spawn(request: SubagentSpawnRequest): Promise<SubagentSpawnResult> {
    const id = this.idGenerator();
    const label = request.label || shortLabel(request.task);
    const queued: QueuedSubagent = { request, id, label };
    this.trackSession(request.sessionKey, id);
    const shouldQueue = this.active.size >= this.maxConcurrent;
    if (shouldQueue) {
      this.queue.push(queued);
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
    let cancelled = 0;
    for (const id of ids) {
      const queuedIndex = this.queue.findIndex((candidate) => candidate.id === id);
      if (queuedIndex >= 0) {
        this.queue.splice(queuedIndex, 1);
        cancelled += 1;
      }
    }
    if (cancelled > 0) {
      this.sessions.set(sessionKey, new Set([...ids].filter((id) => this.active.has(id))));
      if (this.sessions.get(sessionKey)?.size === 0) {
        this.sessions.delete(sessionKey);
      }
    }
    return cancelled;
  }

  private start(entry: QueuedSubagent): void {
    this.active.set(entry.id, entry);
    void this.run(entry);
  }

  private async run(entry: QueuedSubagent): Promise<void> {
    const { request, id, label } = entry;
    const startedAt = Date.now();
    let completion: SubagentRunResult;
    try {
      completion = await withTimeout(
        this.runner({
          id,
          label,
          task: request.task,
          sessionKey: request.sessionKey,
          metadata: request.metadata,
        }),
        this.timeoutMs,
        () => timeoutResult(startedAt, this.timeoutMs),
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

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => T,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve(onTimeout());
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
