import { AgentRunner } from "../agent/agentRunner.ts";
import type { AgentMessage } from "../agent/agentRunSpec.ts";
import type { BackgroundRunRegistry } from "../background/backgroundRegistryBridge.ts";
import { SubagentRuntime, type SubagentRunRequest } from "../background/subagentRuntime.ts";
import type { ModelProvider } from "../model/provider.ts";
import { resolveRuntimeModel, type RuntimeModel } from "../model/runtimeModel.ts";
import { ToolRegistry } from "../tools/toolRegistry.ts";
import type { SpawnSubtaskRequest } from "./taskRuntime.ts";
import type { TaskPlan } from "./taskTypes.ts";

export interface TaskProviderSubagentExecutorOptions {
  provider: ModelProvider;
  model?: RuntimeModel;
  maxConcurrent?: number;
  timeoutMs?: number;
  idGenerator?: () => string;
  runnerTools?: ToolRegistry;
  registry?: BackgroundRunRegistry;
  maxIterations?: number;
  toolResultBudget?: number;
}

export class TaskProviderSubagentExecutor {
  private readonly provider: ModelProvider;
  private readonly model?: RuntimeModel;
  private readonly runtime: SubagentRuntime;
  private readonly runnerTools?: ToolRegistry;
  private readonly maxIterations: number;
  private readonly toolResultBudget?: number;

  constructor(options: TaskProviderSubagentExecutorOptions) {
    this.provider = options.provider;
    this.model = options.model;
    this.runnerTools = options.runnerTools;
    this.maxIterations = options.maxIterations ?? 15;
    this.toolResultBudget = options.toolResultBudget;
    this.runtime = new SubagentRuntime({
      maxConcurrent: options.maxConcurrent,
      timeoutMs: options.timeoutMs,
      idGenerator: options.idGenerator,
      registry: options.registry,
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

  async cancelPlan(plan: TaskPlan): Promise<number> {
    return this.runtime.cancelPlan(plan.id);
  }

  private async runSubagent(request: SubagentRunRequest) {
    if (this.runnerTools) {
      return this.runAgentSubagent(request);
    }
    try {
      const response = await this.provider.complete(messagesFor(request), { model: await resolveRuntimeModel(this.model) });
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

  private async runAgentSubagent(request: SubagentRunRequest) {
    const runner = new AgentRunner({
      provider: this.provider,
      tools: this.runnerTools ?? new ToolRegistry(),
      isCancelled: () => request.signal.aborted,
    });
    const result = await runner.run({
      runId: request.id,
      traceId: typeof request.metadata?.traceId === "string" ? request.metadata.traceId : undefined,
      sessionId: request.sessionKey,
      messages: messagesFor(request),
      model: await resolveRuntimeModel(this.model),
      maxIterations: this.maxIterations,
      stream: false,
      toolResultBudget: this.toolResultBudget,
      failOnToolError: true,
    });
    if (result.stopReason === "tool_error" || result.stopReason === "error") {
      const error = result.error || result.finalContent || "Error: subagent execution failed.";
      return { status: "failed", result: error, error } as const;
    }
    return {
      status: "completed",
      result: result.finalContent || "Task completed but no final response was generated.",
    } as const;
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
