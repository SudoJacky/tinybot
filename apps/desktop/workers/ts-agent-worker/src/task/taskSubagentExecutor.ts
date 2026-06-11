import type { AgentMessage } from "../agent/agentRunSpec.ts";
import type { ModelProvider } from "../model/provider.ts";
import type { SpawnSubtaskRequest } from "./taskRuntime.ts";

export interface TaskProviderSubagentExecutorOptions {
  provider: ModelProvider;
  model?: string;
}

export class TaskProviderSubagentExecutor {
  private readonly provider: ModelProvider;
  private readonly model?: string;

  constructor(options: TaskProviderSubagentExecutorOptions) {
    this.provider = options.provider;
    this.model = options.model;
  }

  async spawnSubtask(request: SpawnSubtaskRequest, traceId: string): Promise<void> {
    void traceId;
    void this.runSubtask(request);
  }

  private async runSubtask(request: SpawnSubtaskRequest): Promise<void> {
    try {
      const response = await this.provider.complete(messagesFor(request), { model: this.model });
      await request.onComplete({
        status: "completed",
        result: response.content || "Completed",
      });
    } catch (error) {
      await request.onComplete({
        status: "failed",
        result: errorMessage(error),
        error: errorMessage(error),
      });
    }
  }
}

function messagesFor(request: SpawnSubtaskRequest): AgentMessage[] {
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
