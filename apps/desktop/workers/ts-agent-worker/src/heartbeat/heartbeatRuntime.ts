import type { AgentRunResult, AgentRunSpec } from "../agent/agentRunSpec.ts";
import type { AgentRunner } from "../agent/agentRunner.ts";
import type { ModelProvider } from "../model/provider.ts";
import { decideHeartbeat } from "./heartbeatDecision.ts";
import { HeartbeatService } from "./heartbeatService.ts";
import type { HeartbeatStatus, HeartbeatTickResult } from "./heartbeatTypes.ts";
import type { HeartbeatTarget } from "./heartbeatTarget.ts";

export type HeartbeatRuntimeOptions = {
  model: string;
  provider: ModelProvider;
  runner: Pick<AgentRunner, "run">;
  readHeartbeatFile: () => Promise<string | null | undefined> | string | null | undefined;
  selectTarget: () => HeartbeatTarget;
  currentTime: () => string;
  evaluateResponse?: (input: { response: string; taskContext: string }) => Promise<boolean> | boolean;
  notifyExternal?: (input: {
    channel: string;
    chatId: string;
    content: string;
    tasks: string;
  }) => Promise<void> | void;
  trimHeartbeatSession?: (keepRecentMessages: number) => Promise<void> | void;
  keepRecentMessages?: number;
  enabled?: boolean;
  intervalMs?: number;
  maxIterations?: number;
  idGenerator?: () => string;
};

export class HeartbeatRuntime {
  private readonly model: string;
  private readonly runner: Pick<AgentRunner, "run">;
  private readonly selectTarget: () => HeartbeatTarget;
  private readonly notifyExternal?: HeartbeatRuntimeOptions["notifyExternal"];
  private readonly trimHeartbeatSession?: HeartbeatRuntimeOptions["trimHeartbeatSession"];
  private readonly keepRecentMessages: number;
  private readonly maxIterations: number;
  private readonly idGenerator: () => string;
  private readonly service: HeartbeatService;

  constructor(options: HeartbeatRuntimeOptions) {
    this.model = options.model;
    this.runner = options.runner;
    this.selectTarget = options.selectTarget;
    this.notifyExternal = options.notifyExternal;
    this.trimHeartbeatSession = options.trimHeartbeatSession;
    this.keepRecentMessages = Math.max(0, options.keepRecentMessages ?? 8);
    this.maxIterations = Math.max(1, options.maxIterations ?? 4);
    this.idGenerator = options.idGenerator ?? randomHeartbeatRunId;
    this.service = new HeartbeatService({
      readHeartbeatFile: options.readHeartbeatFile,
      decide: ({ content }) => decideHeartbeat({
        provider: options.provider,
        model: this.model,
        content,
        currentTime: options.currentTime(),
      }),
      executeTasks: ({ tasks }) => this.executeTasks(tasks),
      evaluateResponse: options.evaluateResponse,
      notify: ({ response, tasks }) => this.notify(response, tasks),
      enabled: options.enabled,
      intervalMs: options.intervalMs,
    });
  }

  start(): boolean {
    return this.service.start();
  }

  stop(): void {
    this.service.stop();
  }

  tick(): Promise<HeartbeatTickResult> {
    return this.service.tick();
  }

  triggerNow(): Promise<HeartbeatTickResult> {
    return this.service.triggerNow();
  }

  getStatus(): HeartbeatStatus {
    return this.service.getStatus();
  }

  private async executeTasks(tasks: string): Promise<string> {
    const target = this.selectTarget();
    const runId = this.idGenerator();
    const result = await this.runner.run({
      runId,
      traceId: `trace-${runId}`,
      sessionId: "heartbeat",
      messages: [{ role: "user", content: tasks }],
      model: this.model,
      maxIterations: this.maxIterations,
      stream: false,
      metadata: {
        source: "heartbeat",
        channel: target.channel,
        chatId: target.chatId,
      },
    } satisfies AgentRunSpec);
    await this.trimHeartbeatSession?.(this.keepRecentMessages);
    return finalContent(result);
  }

  private async notify(response: string, tasks: string): Promise<boolean> {
    const target = this.selectTarget();
    if (!target.external || target.channel === "cli") {
      return false;
    }
    await this.notifyExternal?.({
      channel: target.channel,
      chatId: target.chatId,
      content: response,
      tasks,
    });
    return true;
  }
}

function finalContent(result: AgentRunResult): string {
  return result.finalContent.trim();
}

function randomHeartbeatRunId(): string {
  return `heartbeat-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;
}
