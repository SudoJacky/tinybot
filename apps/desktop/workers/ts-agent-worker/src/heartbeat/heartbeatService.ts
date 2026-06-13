import type { HeartbeatDecision, HeartbeatStatus, HeartbeatTickResult } from "./heartbeatTypes.ts";

export type HeartbeatDecisionInput = {
  content: string;
};

export type HeartbeatExecuteInput = {
  tasks: string;
};

export type HeartbeatEvaluationInput = {
  response: string;
  taskContext: string;
};

export type HeartbeatNotifyInput = {
  response: string;
  tasks: string;
};

export type HeartbeatServiceOptions = {
  readHeartbeatFile: () => Promise<string | null | undefined> | string | null | undefined;
  decide: (input: HeartbeatDecisionInput) => Promise<HeartbeatDecision> | HeartbeatDecision;
  executeTasks?: (input: HeartbeatExecuteInput) => Promise<string> | string;
  evaluateResponse?: (input: HeartbeatEvaluationInput) => Promise<boolean> | boolean;
  notify?: (input: HeartbeatNotifyInput) => Promise<void> | void;
  enabled?: boolean;
  intervalMs?: number;
};

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;

export class HeartbeatService {
  private readonly readHeartbeatFile: HeartbeatServiceOptions["readHeartbeatFile"];
  private readonly decide: HeartbeatServiceOptions["decide"];
  private readonly executeTasks?: HeartbeatServiceOptions["executeTasks"];
  private readonly evaluateResponse?: HeartbeatServiceOptions["evaluateResponse"];
  private readonly notify?: HeartbeatServiceOptions["notify"];
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private executing = false;
  private lastResult: HeartbeatTickResult | null = null;

  constructor(options: HeartbeatServiceOptions) {
    this.readHeartbeatFile = options.readHeartbeatFile;
    this.decide = options.decide;
    this.executeTasks = options.executeTasks;
    this.evaluateResponse = options.evaluateResponse;
    this.notify = options.notify;
    this.enabled = options.enabled ?? true;
    this.intervalMs = Math.max(1, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  }

  start(): boolean {
    if (!this.enabled || this.timer) {
      return false;
    }
    this.timer = setInterval(() => {
      void this.runScheduledTick();
    }, this.intervalMs);
    return true;
  }

  stop(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<HeartbeatTickResult> {
    return await this.runHeartbeat({ notify: true });
  }

  async triggerNow(): Promise<HeartbeatTickResult> {
    return await this.runHeartbeat({ notify: false });
  }

  getStatus(): HeartbeatStatus {
    return {
      enabled: this.enabled,
      running: this.timer !== null,
      executing: this.executing,
      intervalMs: this.intervalMs,
      lastResult: this.lastResult,
      lastError: this.lastResult?.status === "failed" ? this.lastResult.error : null,
    };
  }

  private async runScheduledTick(): Promise<void> {
    if (this.executing) {
      return;
    }
    await this.tick();
  }

  private async runHeartbeat(options: { notify: boolean }): Promise<HeartbeatTickResult> {
    this.executing = true;
    try {
      const content = (await this.readHeartbeatFile())?.trim() ?? "";
      if (!content) {
        return this.recordResult({ status: "missing_file" });
      }

      const decision = await this.decide({ content });
      if (decision.action !== "run" || !decision.tasks.trim()) {
        return this.recordResult({ status: "skipped", tasks: "" });
      }

      if (!this.executeTasks) {
        return this.recordResult({ status: "skipped", tasks: decision.tasks });
      }
      const response = await this.executeTasks({ tasks: decision.tasks });
      if (!response) {
        return this.recordResult({ status: "executed", tasks: decision.tasks, response: "" });
      }

      const shouldNotify = options.notify ? await this.shouldNotify(response, decision.tasks) : false;
      if (!shouldNotify) {
        const status = options.notify ? "silenced" : "executed";
        return this.recordResult({ status, tasks: decision.tasks, response });
      }
      if (this.notify) {
        await this.notify({ response, tasks: decision.tasks });
        return this.recordResult({ status: "notified", tasks: decision.tasks, response });
      }
      return this.recordResult({ status: "executed", tasks: decision.tasks, response });
    } catch (error) {
      return this.recordResult({ status: "failed", error: errorMessage(error) });
    } finally {
      this.executing = false;
    }
  }

  private async shouldNotify(response: string, taskContext: string): Promise<boolean> {
    if (!this.evaluateResponse) {
      return true;
    }
    try {
      return await this.evaluateResponse({ response, taskContext });
    } catch {
      return true;
    }
  }

  private recordResult<T extends HeartbeatTickResult>(result: T): T {
    this.lastResult = result;
    return result;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
