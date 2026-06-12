import { isPlanCompleted, readySubtasks, validateTaskDag } from "./taskDag";
import { taskProgressPayload, type TaskProgressPayload } from "./taskProgress";
import type { TaskPlanContext } from "./taskPlanner";
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
  planner?: {
    createPlan(request: string, context: TaskPlanContext, traceId: string): Promise<TaskPlan>;
  };
  executor?: {
    spawnSubtask(request: SpawnSubtaskRequest, traceId: string): Promise<void>;
    cancelPlan?(plan: TaskPlan, traceId: string): Promise<number>;
  };
  idGenerator?: () => string;
  now?: () => string;
}

export interface SpawnSubtaskRequest {
  plan: TaskPlan;
  subtask: SubTask;
  task: string;
  label: string;
  onComplete: (request: UpdateSubtaskResultRequest) => Promise<void>;
}

export interface ResumePlanResult {
  plan: TaskPlan;
  spawnedCount: number;
}

export interface TaskPlanSummaryResult {
  plan: TaskPlan;
  summary: string;
}

export class TaskRuntime {
  private readonly store: TaskStoreBridge;
  private readonly planner?: TaskRuntimeOptions["planner"];
  private readonly executor?: TaskRuntimeOptions["executor"];
  private readonly idGenerator: () => string;
  private readonly now: () => string;

  constructor(options: TaskRuntimeOptions) {
    this.store = options.store;
    this.planner = options.planner;
    this.executor = options.executor;
    this.idGenerator = options.idGenerator ?? randomTaskId;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  listPlans(traceId: string, options?: { includeCompleted?: boolean }): Promise<TaskPlan[]> {
    return this.store.listPlans(traceId, options);
  }

  async createPlan(request: string, context: TaskPlanContext, traceId: string): Promise<TaskPlan | null> {
    if (!this.planner) {
      return null;
    }
    const plan = await this.planner.createPlan(request, context, traceId);
    return this.store.savePlan(plan, traceId);
  }

  async getProgress(planId: string, traceId: string): Promise<TaskProgressPayload | null> {
    const plan = await this.store.getPlan(planId, traceId);
    return plan ? taskProgressPayload(plan) : null;
  }

  async getPlanSummary(planId: string, traceId: string): Promise<TaskPlanSummaryResult | null> {
    const plan = await this.store.getPlan(planId, traceId);
    if (!plan) {
      return null;
    }
    const results = plan.subtasks
      .filter((subtask) => subtask.status === "completed" && !!subtask.result)
      .map((subtask) => `[${subtask.title}] ${subtask.result}`);
    return {
      plan,
      summary: results.length > 0 ? results.join("\n\n") : "No completed subtasks.",
    };
  }

  async resumePlan(planId: string, options: { parallel?: boolean }, traceId: string): Promise<ResumePlanResult | null> {
    if (!this.executor) {
      return null;
    }
    const plan = await this.store.getPlan(planId, traceId);
    if (!plan) {
      return null;
    }
    if (plan.status !== "completed") {
      plan.status = "executing";
    }
    const ready = readySubtasks(plan);
    const toSpawn = options.parallel === false ? ready.slice(0, 1) : ready;
    for (const subtask of toSpawn) {
      subtask.status = "in_progress";
      subtask.startedAt = this.now();
      plan.currentSubtaskIds = [...new Set([...plan.currentSubtaskIds, subtask.id])];
    }
    const saved = await this.store.savePlan(plan, traceId);
    for (const subtask of toSpawn) {
      await this.executor.spawnSubtask({
        plan: saved,
        subtask,
        task: buildTaskDescription(saved, subtask),
        label: subtask.title,
        onComplete: async (completion) => {
          await this.completeSubtask(saved.id, subtask.id, completion, options, traceId);
        },
      }, traceId);
    }
    return { plan: saved, spawnedCount: toSpawn.length };
  }

  async completeSubtask(
    planId: string,
    subtaskId: string,
    request: UpdateSubtaskResultRequest,
    options: { parallel?: boolean },
    traceId: string,
  ): Promise<ResumePlanResult | null> {
    if (!this.executor) {
      return null;
    }
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
    if (request.status === "completed" || request.status === "failed" || request.status === "skipped") {
      subtask.completedAt = this.now();
      plan.currentSubtaskIds = plan.currentSubtaskIds.filter((id) => id !== subtask.id);
    }
    if (isPlanCompleted(plan)) {
      plan.status = "completed";
      const saved = await this.store.savePlan(plan, traceId);
      return { plan: saved, spawnedCount: 0 };
    }
    if (plan.status === "paused") {
      const saved = await this.store.savePlan(plan, traceId);
      return { plan: saved, spawnedCount: 0 };
    }
    plan.status = "executing";
    const ready = readySubtasks(plan);
    const toSpawn = options.parallel === false ? ready.slice(0, 1) : ready;
    for (const readySubtask of toSpawn) {
      readySubtask.status = "in_progress";
      readySubtask.startedAt = this.now();
      plan.currentSubtaskIds = [...new Set([...plan.currentSubtaskIds, readySubtask.id])];
    }
    const saved = await this.store.savePlan(plan, traceId);
    for (const readySubtask of toSpawn) {
      await this.executor.spawnSubtask({
        plan: saved,
        subtask: readySubtask,
        task: buildTaskDescription(saved, readySubtask),
        label: readySubtask.title,
        onComplete: async (completion) => {
          await this.completeSubtask(saved.id, readySubtask.id, completion, options, traceId);
        },
      }, traceId);
    }
    return { plan: saved, spawnedCount: toSpawn.length };
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
    const plan = await this.store.getPlan(planId, traceId);
    if (!plan || plan.status === "completed") {
      return plan;
    }
    await this.executor?.cancelPlan?.(plan, traceId);
    plan.status = "paused";
    return this.store.savePlan(plan, traceId);
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

function buildTaskDescription(plan: TaskPlan, subtask: SubTask): string {
  const dependencyContext = subtask.dependencies
    .map((dependencyId) => plan.subtasks.find((candidate) => candidate.id === dependencyId))
    .filter((dependency): dependency is SubTask => dependency !== undefined && !!dependency.result)
    .map((dependency) => `**${dependency.title}:** ${dependency.result}`)
    .join("\n");
  return [
    `Execute subtask: ${subtask.title}`,
    "",
    "## Description",
    subtask.description,
    "",
    "## Context from Completed Subtasks",
    dependencyContext,
    "",
    "## Instructions",
    "1. Focus on completing only this subtask",
    "2. Use available tools to gather information and produce results",
    "3. Provide a clear, concise summary of what was accomplished",
  ].join("\n");
}
