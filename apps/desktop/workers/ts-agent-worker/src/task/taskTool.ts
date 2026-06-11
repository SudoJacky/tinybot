import type { Tool, ToolContext, ToolResult } from "../tools/tool.ts";
import { TaskRuntime, type TaskRuntimeOptions } from "./taskRuntime";
import { taskProgressPayload } from "./taskProgress";
import type { SubTask, TaskPlan } from "./taskTypes";

const TASK_ACTIONS = [
  "create",
  "status",
  "progress",
  "resume",
  "pause",
  "cancel",
  "list",
  "delete",
  "add_subtask",
  "remove_subtask",
  "summary",
] as const;

type TaskAction = typeof TASK_ACTIONS[number];

export function createTaskTool(options: TaskRuntimeOptions): Tool {
  const runtime = new TaskRuntime(options);
  return {
    name: "task",
    description: [
      "Manage complex multi-step task plans.",
      "Native TS currently supports plan creation, listing, status/progress, resume with a configured subtask executor, pause/cancel/delete, and subtask edits.",
      "Final summaries and fully isolated AgentRunner-backed subagent sessions are still being migrated.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: TASK_ACTIONS },
        request: { type: "string" },
        plan_id: { type: "string" },
        parallel: { type: "boolean", default: true },
        auto_execute: { type: "boolean", default: false },
        subtask_title: { type: "string" },
        subtask_description: { type: "string" },
        subtask_dependencies: { type: "array", items: { type: "string" } },
        subtask_parallel_safe: { type: "boolean", default: true },
        subtask_id: { type: "string" },
        after_subtask: { type: "string" },
      },
      required: ["action"],
    },
    concurrencySafe: false,
    capabilities: ["task.read", "task.write"],
    execute: async (args, context) => executeTaskAction(runtime, args, context),
  };
}

async function executeTaskAction(
  runtime: TaskRuntime,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  const action = stringArg(args, "action") as TaskAction;
  switch (action) {
    case "list":
      return { content: formatPlanList(await runtime.listPlans(traceId(context))) };
    case "status":
      return statusResult(runtime, args, context);
    case "progress":
      return progressResult(runtime, args, context);
    case "pause":
      return controlResult(args, context, "pause", (planId, traceId) => runtime.pausePlan(planId, traceId), "paused");
    case "cancel":
      return controlResult(args, context, "cancel", (planId, traceId) => runtime.cancelPlan(planId, traceId), "cancelled");
    case "delete":
      return deleteResult(runtime, args, context);
    case "add_subtask":
      return addSubtaskResult(runtime, args, context);
    case "remove_subtask":
      return removeSubtaskResult(runtime, args, context);
    case "create":
      return createResult(runtime, args, context);
    case "resume":
      return resumeResult(runtime, args, context);
    case "summary":
      return summaryResult(runtime, args, context);
    default:
      return { content: `Unknown action: ${String(args.action)}` };
  }
}

async function statusResult(runtime: TaskRuntime, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const planId = requiredPlanId(args, "status");
  if (typeof planId !== "string") {
    return { content: planId.content };
  }
  const plans = await runtime.listPlans(traceId(context), { includeCompleted: true });
  const plan = plans.find((candidate) => candidate.id === planId);
  if (!plan) {
    return { content: `Error: Plan ${planId} not found` };
  }
  return { content: formatPlanSummary(plan) };
}

async function createResult(runtime: TaskRuntime, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const request = stringArg(args, "request");
  if (!request) {
    return { content: "Error: request is required for create action" };
  }
  const plan = await runtime.createPlan(request, {
    channel: stringArg(args, "channel") || "native",
    chatId: context.sessionId ?? context.runId,
  }, traceId(context));
  if (!plan) {
    return deferredResult("Task plan creation is not available in the native TS runtime yet.", "task_planning");
  }
  const progress = taskProgressPayload(plan);
  const warning = Array.isArray(plan.context.dagErrors) && plan.context.dagErrors.length > 0
    ? `\n\nWarning: Plan has dependency issues: ${JSON.stringify(plan.context.dagErrors)}\nPlease fix before executing.`
    : "";
  return {
    content: [
      `Task plan created (plan_id: ${plan.id}).`,
      "",
      formatPlanSummary(plan),
      "",
      `Hint: use \`task action=resume plan_id=${plan.id}\` to start background execution.`,
      warning,
    ].join("\n"),
    metadata: {
      _task_event: true,
      _task_plan_id: plan.id,
      _task_progress: progress,
    },
  };
}

async function progressResult(runtime: TaskRuntime, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const planId = requiredPlanId(args, "progress");
  if (typeof planId !== "string") {
    return { content: planId.content };
  }
  const progress = await runtime.getProgress(planId, traceId(context));
  if (!progress) {
    return { content: `Error: Plan ${planId} not found` };
  }
  return {
    content: formatProgress(progress),
    metadata: {
      _task_event: true,
      _task_plan_id: planId,
      _task_progress: progress,
    },
  };
}

async function resumeResult(runtime: TaskRuntime, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const planId = requiredPlanId(args, "resume");
  if (typeof planId !== "string") {
    return { content: planId.content };
  }
  const result = await runtime.resumePlan(planId, {
    parallel: booleanArg(args, "parallel", true),
  }, traceId(context));
  if (!result) {
    return deferredResult("Task background execution is not available in the native TS runtime yet.", "subagent_runtime");
  }
  const progress = taskProgressPayload(result.plan);
  const noun = result.spawnedCount === 1 ? "subtask" : "subtasks";
  return {
    content: `Task plan ${result.plan.id} resumed. Spawned ${result.spawnedCount} ready ${noun}.`,
    metadata: {
      _task_event: true,
      _task_plan_id: result.plan.id,
      _task_progress: progress,
    },
  };
}

async function summaryResult(runtime: TaskRuntime, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const planId = requiredPlanId(args, "summary");
  if (typeof planId !== "string") {
    return { content: planId.content };
  }
  const result = await runtime.getPlanSummary(planId, traceId(context));
  if (!result) {
    return { content: `Error: Plan ${planId} not found` };
  }
  if (result.plan.status !== "completed") {
    return {
      content: `Plan is not completed yet (status: ${result.plan.status}).\nUse \`task action=status plan_id=${planId}\` to check progress.`,
    };
  }
  return {
    content: `# Task Completed: ${result.plan.title}\n\n## Results\n\n${result.summary}`,
  };
}

async function controlResult(
  args: Record<string, unknown>,
  context: ToolContext,
  action: string,
  apply: (planId: string, traceId: string) => Promise<TaskPlan | null>,
  verb: string,
): Promise<ToolResult> {
  const planId = requiredPlanId(args, action);
  if (typeof planId !== "string") {
    return { content: planId.content };
  }
  const plan = await apply(planId, traceId(context));
  if (!plan) {
    return { content: `Error: Plan ${planId} not found` };
  }
  return { content: `Plan ${plan.id} ${verb}.` };
}

async function deleteResult(runtime: TaskRuntime, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const planId = requiredPlanId(args, "delete");
  if (typeof planId !== "string") {
    return { content: planId.content };
  }
  const deleted = await runtime.deletePlan(planId, traceId(context));
  return { content: deleted ? `Deleted plan ${planId}.` : `Error: Plan ${planId} not found` };
}

async function addSubtaskResult(runtime: TaskRuntime, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const planId = requiredPlanId(args, "add_subtask");
  if (typeof planId !== "string") {
    return { content: planId.content };
  }
  const title = stringArg(args, "subtask_title");
  const description = stringArg(args, "subtask_description");
  if (!title) {
    return { content: "Error: subtask_title is required for add_subtask action" };
  }
  if (!description) {
    return { content: "Error: subtask_description is required for add_subtask action" };
  }
  const subtask = await runtime.addSubtask(planId, {
    title,
    description,
    dependencies: stringArrayArg(args, "subtask_dependencies"),
    parallelSafe: booleanArg(args, "subtask_parallel_safe", true),
    after: optionalStringArg(args, "after_subtask"),
  }, traceId(context));
  if (!subtask) {
    return { content: `Error: Plan ${planId} not found` };
  }
  return { content: `Added subtask ${subtask.id}: ${subtask.title}` };
}

async function removeSubtaskResult(runtime: TaskRuntime, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const planId = requiredPlanId(args, "remove_subtask");
  if (typeof planId !== "string") {
    return { content: planId.content };
  }
  const subtaskId = stringArg(args, "subtask_id");
  if (!subtaskId) {
    return { content: "Error: subtask_id is required for remove_subtask action" };
  }
  const removed = await runtime.removeSubtask(planId, subtaskId, traceId(context));
  return {
    content: removed
      ? `Removed subtask ${subtaskId} from plan ${planId}.`
      : `Error: Subtask ${subtaskId} could not be removed from plan ${planId}`,
  };
}

function deferredResult(content: string, deferred: string): ToolResult {
  return {
    content,
    metadata: { available: false, deferred },
  };
}

function formatPlanList(plans: TaskPlan[]): string {
  if (plans.length === 0) {
    return "No active task plans.";
  }
  return [
    "## Task Plans",
    ...plans.map((plan) => `- ${plan.id}: ${plan.title} (${plan.status})`),
  ].join("\n");
}

function formatPlanSummary(plan: TaskPlan): string {
  const progress = taskProgressPayload(plan);
  const lines = [
    `## ${plan.title} (id: ${plan.id})`,
    `Status: ${plan.status}`,
    `Progress: ${progress.completed}/${progress.total} completed, ${progress.in_progress} in progress, ${progress.pending} pending, ${progress.failed} failed`,
    "",
    "### Subtasks",
  ];
  for (const subtask of plan.subtasks) {
    const dependencies = subtask.dependencies.length ? ` (depends: ${subtask.dependencies.join(", ")})` : "";
    const sequential = subtask.parallelSafe ? "" : " [sequential]";
    lines.push(`- ${statusLabel(subtask.status)} **${subtask.id}:** ${subtask.title}${dependencies}${sequential}`);
    if (subtask.result) {
      lines.push(`  Result: ${truncate(subtask.result, 100)}`);
    }
    if (subtask.error) {
      lines.push(`  Error: ${truncate(subtask.error, 100)}`);
    }
  }
  return lines.join("\n");
}

function formatProgress(progress: ReturnType<typeof taskProgressPayload>): string {
  const lines = [
    `## Progress: ${progress.title} (${progress.plan_id})`,
    `**Status:** ${progress.status}`,
    `**Progress:** ${progress.completed}/${progress.total} completed`,
    `- In progress: ${progress.in_progress}`,
    `- Pending: ${progress.pending}`,
    `- Failed: ${progress.failed}`,
    `- Skipped: ${progress.skipped}`,
  ];
  if (progress.current_all.length > 0) {
    lines.push(`**Currently executing:** ${progress.current_all.join(", ")}`);
  } else if (progress.current) {
    lines.push(`**Current:** ${progress.current}`);
  }
  if (progress.next) {
    lines.push(`**Next:** ${progress.next}`);
  }
  return lines.join("\n");
}

function statusLabel(status: string): string {
  switch (status) {
    case "pending":
      return "[pending]";
    case "in_progress":
      return "[in_progress]";
    case "completed":
      return "[completed]";
    case "failed":
      return "[failed]";
    case "skipped":
      return "[skipped]";
    default:
      return "[unknown]";
  }
}

function requiredPlanId(args: Record<string, unknown>, action: string): string | { content: string } {
  const planId = stringArg(args, "plan_id");
  return planId || { content: `Error: plan_id is required for ${action} action` };
}

function traceId(context: ToolContext): string {
  return context.traceId ?? context.runId;
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value.trim() : "";
}

function optionalStringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = stringArg(args, key);
  return value || undefined;
}

function stringArrayArg(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function booleanArg(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = args[key];
  return typeof value === "boolean" ? value : fallback;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}
