import type { JsonObject } from "../protocol/messages.ts";
import type { NativeRpcClient } from "../tools/nativeToolProxy.ts";
import type { TaskProgressEvent } from "./taskRuntime.ts";
import type { TaskPlan } from "./taskTypes";

export interface TaskNotificationBridge {
  notifyPlanCompleted(sessionKey: string, plan: TaskPlan, summary: string, traceId: string): Promise<void>;
}

export interface TaskProgressCardBridge {
  persistTaskProgress(sessionKey: string, event: TaskProgressEvent, traceId: string): Promise<void>;
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

export class NativeTaskProgressCardBridge implements TaskProgressCardBridge {
  private readonly rpcClient: NativeRpcClient;

  constructor(rpcClient: NativeRpcClient) {
    this.rpcClient = rpcClient;
  }

  async persistTaskProgress(sessionKey: string, event: TaskProgressEvent, traceId: string): Promise<void> {
    await this.rpcClient.request(traceId, "session.task_progress.upsert", {
      session_id: sessionKey,
      plan_id: event.planId,
      progress: event.progress,
      content: renderTaskProgressCard(event),
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

export function renderTaskProgressCard(event: TaskProgressEvent): string {
  const progress = event.progress;
  const lines = [
    `## Task Progress: ${progress.title}`,
    `**Status:** ${progress.status}`,
    `**Progress:** ${progress.completed}/${progress.total} completed`,
    `**Current:** ${progress.current_all.length > 0 ? progress.current_all.join(", ") : "None"}`,
    `**Next:** ${progress.next ?? "None"}`,
    `**Last event:** ${taskProgressEventLabel(event)}`,
  ];
  if (event.error) {
    lines.push(`**Error:** ${event.error}`);
  }
  return lines.join("\n");
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

function taskProgressEventLabel(event: TaskProgressEvent): string {
  switch (event.event) {
    case "started":
      return `Started ${event.subtaskTitle}`;
    case "completed":
      return `Completed ${event.subtaskTitle}`;
    case "failed":
      return `Failed ${event.subtaskTitle}`;
    case "skipped":
      return `Skipped ${event.subtaskTitle}`;
  }
}
