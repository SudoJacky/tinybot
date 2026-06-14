import type { Tool } from "../tools/tool.ts";
import type { SubagentRuntime, SubagentSpawnResult } from "./subagentRuntime.ts";

export type SpawnToolRuntime = Pick<SubagentRuntime, "spawn">;

export function createSpawnTool(options: { runtime: SpawnToolRuntime }): Tool {
  return {
    name: "spawn",
    description: [
      "Spawn a subagent to handle a task in the background.",
      "Use this for complex or time-consuming tasks that can run independently.",
      "The subagent will complete the task and report back when done.",
      "For deliverables or existing projects, inspect the workspace first and use a dedicated subdirectory when helpful.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "The task for the subagent to complete" },
        label: { type: "string", description: "Optional short label for the task (for display)" },
      },
      required: ["task"],
    },
    capabilities: ["background.write"],
    requiresApproval: true,
    approvalCategory: "agent_control",
    approvalRisk: "high",
    concurrencySafe: true,
    execute: async (args, context) => {
      const task = stringArg(args, "task")?.trim();
      if (!task) {
        return { content: "Error: task is required for spawn action" };
      }
      const label = cleanOptionalString(args.label);
      const result = await options.runtime.spawn({
        task,
        label,
        sessionKey: context.sessionId,
        metadata: {
          ...(context.traceId ? { traceId: context.traceId } : {}),
          runId: context.runId,
          origin: "spawn_tool",
        },
      });
      return spawnToolResult(result);
    },
  };
}

function spawnToolResult(result: SubagentSpawnResult) {
  return {
    content: result.message,
    metadata: {
      _background_event: true,
      _background_run_id: result.id,
      _background_label: result.label,
      _background_status: result.queued ? "queued" : "running",
    },
  };
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

function cleanOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
