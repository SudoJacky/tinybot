import type { SubTask, SubTaskInput, TaskPlan, TaskPlanInput } from "./taskTypes";

export function normalizeSubTask(input: SubTaskInput): SubTask {
  return {
    id: input.id,
    title: input.title,
    description: input.description,
    status: input.status ?? "pending",
    dependencies: [...(input.dependencies ?? [])],
    parallelSafe: input.parallelSafe ?? input.parallel_safe ?? true,
    result: input.result ?? null,
    error: input.error ?? null,
    startedAt: input.startedAt ?? input.started_at ?? null,
    completedAt: input.completedAt ?? input.completed_at ?? null,
    retryCount: input.retryCount ?? input.retry_count ?? 0,
    maxRetries: input.maxRetries ?? input.max_retries ?? 2,
  };
}

export function normalizeTaskPlan(input: TaskPlanInput): TaskPlan {
  return {
    id: input.id,
    title: input.title,
    originalRequest: input.originalRequest ?? input.original_request ?? "",
    subtasks: (input.subtasks ?? []).map(normalizeSubTask),
    createdAt: input.createdAt ?? input.created_at ?? null,
    updatedAt: input.updatedAt ?? input.updated_at ?? null,
    status: input.status ?? "planning",
    currentSubtaskIds: [...(input.currentSubtaskIds ?? input.current_subtask_ids ?? [])],
    context: { ...(input.context ?? {}) },
  };
}

export function validateTaskDag(plan: TaskPlan): string[] {
  const errors: string[] = [];
  const allIds = new Set(plan.subtasks.map((subtask) => subtask.id));
  const graph = new Map<string, string[]>();

  for (const subtask of plan.subtasks) {
    for (const dependencyId of subtask.dependencies) {
      if (!allIds.has(dependencyId)) {
        errors.push(`Subtask '${subtask.id}' depends on non-existent '${dependencyId}'`);
        continue;
      }
      const neighbors = graph.get(dependencyId) ?? [];
      neighbors.push(subtask.id);
      graph.set(dependencyId, neighbors);
    }
  }

  const white = 0;
  const gray = 1;
  const black = 2;
  const color = new Map(plan.subtasks.map((subtask) => [subtask.id, white]));

  function visit(nodeId: string, path: string[]): boolean {
    color.set(nodeId, gray);
    path.push(nodeId);

    for (const neighbor of graph.get(nodeId) ?? []) {
      if (color.get(neighbor) === gray) {
        const cycleStart = path.indexOf(neighbor);
        const cycle = [...path.slice(cycleStart), neighbor];
        errors.push(`Cycle detected: ${cycle.join(" -> ")}`);
        return true;
      }
      if (color.get(neighbor) === white && visit(neighbor, path)) {
        return true;
      }
    }

    path.pop();
    color.set(nodeId, black);
    return false;
  }

  for (const subtask of plan.subtasks) {
    if (color.get(subtask.id) === white) {
      visit(subtask.id, []);
    }
  }

  return errors;
}

export function getSubtask(plan: TaskPlan, subtaskId: string): SubTask | undefined {
  return plan.subtasks.find((subtask) => subtask.id === subtaskId);
}

export function canExecuteSubtask(subtask: SubTask, plan: TaskPlan): boolean {
  if (subtask.status !== "pending") {
    return false;
  }

  return subtask.dependencies.every((dependencyId) => getSubtask(plan, dependencyId)?.status === "completed");
}

export function readySubtasks(plan: TaskPlan): SubTask[] {
  return plan.subtasks.filter((subtask) => canExecuteSubtask(subtask, plan));
}

export function isPlanCompleted(plan: TaskPlan): boolean {
  return plan.subtasks.every((subtask) => subtask.status === "completed" || subtask.status === "skipped");
}

export function isPlanBlocked(plan: TaskPlan): boolean {
  const pending = plan.subtasks.filter((subtask) => subtask.status === "pending");
  if (pending.length === 0) {
    return false;
  }
  return pending.every((subtask) => !canExecuteSubtask(subtask, plan)) && !plan.subtasks.some((subtask) => subtask.status === "in_progress");
}
