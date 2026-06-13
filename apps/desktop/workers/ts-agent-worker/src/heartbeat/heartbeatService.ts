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
};

export class HeartbeatService {
  private readonly readHeartbeatFile: HeartbeatServiceOptions["readHeartbeatFile"];
  private readonly decide: HeartbeatServiceOptions["decide"];
  private readonly executeTasks?: HeartbeatServiceOptions["executeTasks"];
  private readonly evaluateResponse?: HeartbeatServiceOptions["evaluateResponse"];
  private readonly notify?: HeartbeatServiceOptions["notify"];
  private running = false;
  private lastResult: HeartbeatTickResult | null = null;

  constructor(options: HeartbeatServiceOptions) {
    this.readHeartbeatFile = options.readHeartbeatFile;
    this.decide = options.decide;
    this.executeTasks = options.executeTasks;
    this.evaluateResponse = options.evaluateResponse;
    this.notify = options.notify;
  }

  async tick(): Promise<HeartbeatTickResult> {
    return await this.runHeartbeat({ notify: true });
  }

  async triggerNow(): Promise<HeartbeatTickResult> {
    return await this.runHeartbeat({ notify: false });
  }

  getStatus(): HeartbeatStatus {
    return {
      running: this.running,
      lastResult: this.lastResult,
      lastError: this.lastResult?.status === "failed" ? this.lastResult.error : null,
    };
  }

  private async runHeartbeat(options: { notify: boolean }): Promise<HeartbeatTickResult> {
    this.running = true;
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
      this.running = false;
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
