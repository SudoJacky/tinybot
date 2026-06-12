import type { JsonObject } from "../protocol/messages.ts";
import type { NativeRpcClient } from "../tools/nativeToolProxy.ts";
import type { TaskPlan } from "./taskTypes";

export interface TaskNotificationBridge {
  notifyPlanCompleted(sessionKey: string, plan: TaskPlan, summary: string, traceId: string): Promise<void>;
}

export class NativeTaskNotificationBridge implements TaskNotificationBridge {
  private readonly rpcClient: NativeRpcClient;

  constructor(rpcClient: NativeRpcClient) {
    this.rpcClient = rpcClient;
  }

  async notifyPlanCompleted(sessionKey: string, plan: TaskPlan, summary: string, traceId: string): Promise<void> {
    await this.rpcClient.request(traceId, "session.append_messages", {
      session_id: sessionKey,
      messages: [nativeTaskCompletionMessage(plan, summary)],
    });
  }
}

export function renderTaskCompletionNotification(plan: TaskPlan, summary: string): string {
  return [
    "A multi-step task plan has finished execution (may be completed or paused due to failure). Present the results to the user naturally.",
    "",
    `## Plan: ${plan.title}`,
    `**Status:** ${plan.status}`,
    `**Plan ID:** ${plan.id}`,
    "",
    "## Results Summary",
    summary,
    "",
    "## Instructions",
    instructionForStatus(plan),
  ].join("\n");
}

function instructionForStatus(plan: TaskPlan): string {
  if (plan.status === "paused") {
    return [
      "The plan has been paused due to a failure. Inform the user about the failure and the current progress.",
      "Suggest possible next steps such as:",
      `1. Use \`task action=status plan_id=${plan.id}\` to inspect the detailed status`,
      `2. Use \`task action=resume plan_id=${plan.id}\` to retry execution after fixing issues`,
      "3. Use `task action=add_subtask` to add alternative subtasks",
      `4. Use \`task action=cancel plan_id=${plan.id}\` to cancel the plan`,
      "Focus on the completed results so far and clearly explain what failed and why. Do not mention technical details like `plan_id` unless suggesting next steps.",
    ].join("\n");
  }
  return "The plan has completed successfully. Summarize and present the results to the user in a clear, helpful format. Focus on the key outcomes and what was accomplished. Do not mention technical details like `plan_id` or `subtask`.";
}

export function nativeTaskCompletionMessage(plan: TaskPlan, summary: string): JsonObject {
  return {
    role: "user",
    content: renderTaskCompletionNotification(plan, summary),
    metadata: {
      _task_event: true,
      _task_completion_notification: true,
      _task_plan_id: plan.id,
      _task_status: plan.status,
      _tool_name: "task",
    },
  };
}
