import { canExecuteSubtask } from "./taskDag.ts";
import type { SubTaskStatus, TaskPlan, TaskPlanStatus } from "./taskTypes.ts";

export interface TaskProgressPayload {
  plan_id: string;
  title: string;
  status: TaskPlanStatus;
  total: number;
  completed: number;
  in_progress: number;
  pending: number;
  failed: number;
  skipped: number;
  current: string | null;
  current_all: string[];
  next: string | null;
}

export function taskProgressPayload(plan: TaskPlan): TaskProgressPayload {
  const currentAll = plan.subtasks
    .filter((subtask) => subtask.status === "in_progress")
    .map((subtask) => subtask.title);
  const nextExecutable = plan.subtasks.find(
    (subtask) => subtask.status === "pending" && canExecuteSubtask(subtask, plan),
  );

  return {
    plan_id: plan.id,
    title: plan.title,
    status: plan.status,
    total: plan.subtasks.length,
    completed: countByStatus(plan, "completed"),
    in_progress: countByStatus(plan, "in_progress"),
    pending: countByStatus(plan, "pending"),
    failed: countByStatus(plan, "failed"),
    skipped: countByStatus(plan, "skipped"),
    current: currentAll[0] ?? null,
    current_all: currentAll,
    next: nextExecutable?.title ?? null,
  };
}

function countByStatus(plan: TaskPlan, status: SubTaskStatus): number {
  return plan.subtasks.filter((subtask) => subtask.status === status).length;
}
