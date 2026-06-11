import { validateTaskDag } from "./taskDag";
import { taskProgressPayload, type TaskProgressPayload } from "./taskProgress";
import type { SubTask, SubTaskStatus, TaskPlan } from "./taskTypes";

export interface TaskStoreBridge {
  listPlans(traceId: string, options?: { includeCompleted?: boolean }): Promise<TaskPlan[]>;
  getPlan(planId: string, traceId: string): Promise<TaskPlan | null>;
  savePlan(plan: TaskPlan, traceId: string): Promise<TaskPlan>;
  deletePlan(planId: string, traceId: string): Promise<boolean>;
}

export interface AddSubtaskRequest {
  title: string;
  description: string;
  dependencies?: string[];
  parallelSafe?: boolean;
  after?: string;
}

export interface UpdateSubtaskResultRequest {
  status: SubTaskStatus;
  result?: string | null;
  error?: string | null;
}

export interface TaskRuntimeOptions {
  store: TaskStoreBridge;
  idGenerator?: () => string;
  now?: () => string;
}

export class TaskRuntime {
  private readonly store: TaskStoreBridge;
  private readonly idGenerator: () => string;
  private readonly now: () => string;

  constructor(options: TaskRuntimeOptions) {
    this.store = options.store;
    this.idGenerator = options.idGenerator ?? randomTaskId;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  listPlans(traceId: string, options?: { includeCompleted?: boolean }): Promise<TaskPlan[]> {
    return this.store.listPlans(traceId, options);
  }

  async getProgress(planId: string, traceId: string): Promise<TaskProgressPayload | null> {
    const plan = await this.store.getPlan(planId, traceId);
    return plan ? taskProgressPayload(plan) : null;
  }

  async pausePlan(planId: string, traceId: string): Promise<TaskPlan | null> {
    const plan = await this.store.getPlan(planId, traceId);
    if (!plan || plan.status === "completed") {
      return plan;
    }
    plan.status = "paused";
    return this.store.savePlan(plan, traceId);
  }

  async cancelPlan(planId: string, traceId: string): Promise<TaskPlan | null> {
    return this.pausePlan(planId, traceId);
  }

  deletePlan(planId: string, traceId: string): Promise<boolean> {
    return this.store.deletePlan(planId, traceId);
  }

  async addSubtask(planId: string, request: AddSubtaskRequest, traceId: string): Promise<SubTask | null> {
    const plan = await this.store.getPlan(planId, traceId);
    if (!plan || plan.status === "completed") {
      return null;
    }
    const subtask: SubTask = {
      id: this.idGenerator(),
      title: request.title,
      description: request.description,
      status: "pending",
      dependencies: [...(request.dependencies ?? [])],
      parallelSafe: request.parallelSafe ?? true,
      result: null,
      error: null,
      startedAt: null,
      completedAt: null,
      retryCount: 0,
      maxRetries: 2,
    };

    if (request.after) {
      const index = plan.subtasks.findIndex((candidate) => candidate.id === request.after);
      if (index >= 0) {
        plan.subtasks.splice(index + 1, 0, subtask);
      } else {
        plan.subtasks.push(subtask);
      }
    } else {
      plan.subtasks.push(subtask);
    }
    plan.context = { ...plan.context, dagErrors: validateTaskDag(plan) };
    await this.store.savePlan(plan, traceId);
    return subtask;
  }

  async removeSubtask(planId: string, subtaskId: string, traceId: string): Promise<boolean> {
    const plan = await this.store.getPlan(planId, traceId);
    if (!plan || plan.status === "completed") {
      return false;
    }
    const subtask = plan.subtasks.find((candidate) => candidate.id === subtaskId);
    if (!subtask || subtask.status !== "pending") {
      return false;
    }
    plan.subtasks = plan.subtasks.filter((candidate) => candidate.id !== subtaskId);
    for (const candidate of plan.subtasks) {
      candidate.dependencies = candidate.dependencies.filter((dependency) => dependency !== subtaskId);
    }
    plan.context = { ...plan.context, dagErrors: validateTaskDag(plan) };
    await this.store.savePlan(plan, traceId);
    return true;
  }

  async updateSubtaskResult(
    planId: string,
    subtaskId: string,
    request: UpdateSubtaskResultRequest,
    traceId: string,
  ): Promise<SubTask | null> {
    const plan = await this.store.getPlan(planId, traceId);
    if (!plan) {
      return null;
    }
    const subtask = plan.subtasks.find((candidate) => candidate.id === subtaskId);
    if (!subtask) {
      return null;
    }
    subtask.status = request.status;
    if (request.result !== undefined) {
      subtask.result = request.result;
    }
    if (request.error !== undefined) {
      subtask.error = request.error;
    }
    if (request.status === "in_progress") {
      subtask.startedAt = this.now();
      plan.currentSubtaskIds = [...new Set([...plan.currentSubtaskIds, subtask.id])];
    }
    if (request.status === "completed" || request.status === "failed" || request.status === "skipped") {
      subtask.completedAt = this.now();
      plan.currentSubtaskIds = plan.currentSubtaskIds.filter((id) => id !== subtask.id);
    }
    plan.context = { ...plan.context, dagErrors: validateTaskDag(plan) };
    await this.store.savePlan(plan, traceId);
    return subtask;
  }
}

function randomTaskId(): string {
  return Math.random().toString(16).slice(2, 6);
}
