import type { AgentMessage } from "../agent/agentRunSpec.ts";
import { SubagentRuntime, type SubagentRunRequest } from "../background/subagentRuntime.ts";
import type { ModelProvider } from "../model/provider.ts";
import type { SpawnSubtaskRequest } from "./taskRuntime.ts";

export interface TaskProviderSubagentExecutorOptions {
  provider: ModelProvider;
  model?: string;
  maxConcurrent?: number;
  timeoutMs?: number;
  idGenerator?: () => string;
}

export class TaskProviderSubagentExecutor {
  private readonly provider: ModelProvider;
  private readonly model?: string;
  private readonly runtime: SubagentRuntime;

  constructor(options: TaskProviderSubagentExecutorOptions) {
    this.provider = options.provider;
    this.model = options.model;
    this.runtime = new SubagentRuntime({
      maxConcurrent: options.maxConcurrent,
      timeoutMs: options.timeoutMs,
      idGenerator: options.idGenerator,
      runner: (request) => this.runSubagent(request),
    });
  }

  async spawnSubtask(request: SpawnSubtaskRequest, traceId: string): Promise<void> {
    await this.runtime.spawn({
      task: request.task,
      label: request.label,
      sessionKey: typeof request.plan.context.sessionKey === "string" ? request.plan.context.sessionKey : undefined,
      metadata: { planId: request.plan.id, subtaskId: request.subtask.id, traceId },
      onComplete: async (completion) => {
        await request.onComplete({
          status: completion.status === "completed" ? "completed" : "failed",
          result: completion.result,
          error: completion.error,
        });
      },
    });
  }

  private async runSubagent(request: SubagentRunRequest) {
    try {
      const response = await this.provider.complete(messagesFor(request), { model: this.model });
      return {
        status: "completed",
        result: response.content || "Completed",
      } as const;
    } catch (error) {
      return {
        status: "failed",
        result: errorMessage(error),
        error: errorMessage(error),
      } as const;
    }
  }
}

function messagesFor(request: Pick<SubagentRunRequest, "task">): AgentMessage[] {
  return [
    {
      role: "system",
      content: [
        "You are a focused task execution subagent.",
        "Complete only the assigned subtask and return a concise result summary.",
      ].join("\n"),
    },
    { role: "user", content: request.task },
  ];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
