import type { JsonObject } from "../protocol/messages.ts";
import type { NativeRpcClient } from "../tools/nativeToolProxy.ts";
import { normalizeTaskPlan } from "./taskDag.ts";
import type { SubTask, TaskPlan, TaskPlanInput, TaskStore, TaskStoreInput } from "./taskTypes.ts";

export interface ListTaskPlansOptions {
  includeCompleted?: boolean;
}

export class NativeTaskStoreBridge {
  private readonly rpcClient: NativeRpcClient;

  constructor(rpcClient: NativeRpcClient) {
    this.rpcClient = rpcClient;
  }

  async loadStore(traceId: string): Promise<TaskStore> {
    return normalizeTaskStore(await this.rpcClient.request(traceId, "task.store.load", {}));
  }

  async listPlans(traceId: string, options: ListTaskPlansOptions = {}): Promise<TaskPlan[]> {
    const result = await this.rpcClient.request(traceId, "task.plan.list", {
      ...(options.includeCompleted !== undefined ? { include_completed: options.includeCompleted } : {}),
    });
    const payload = asJsonObject(result);
    const plans = Array.isArray(payload?.plans) ? payload.plans : [];
    return plans.map(asTaskPlan).filter((plan): plan is TaskPlan => plan !== undefined);
  }

  async getPlan(planId: string, traceId: string): Promise<TaskPlan | null> {
    const result = await this.rpcClient.request(traceId, "task.plan.get", {
      plan_id: planId,
    });
    const payload = asJsonObject(result);
    return asTaskPlan(payload?.plan);
  }

  async savePlan(plan: TaskPlan, traceId: string): Promise<TaskPlan> {
    const result = await this.rpcClient.request(traceId, "task.plan.save", {
      plan: nativeTaskPlan(plan),
    });
    const payload = asJsonObject(result);
    return asTaskPlan(payload?.plan) ?? plan;
  }

  async deletePlan(planId: string, traceId: string): Promise<boolean> {
    const result = await this.rpcClient.request(traceId, "task.plan.delete", {
      plan_id: planId,
    });
    const payload = asJsonObject(result);
    return payload?.deleted === true;
  }
}

export function normalizeTaskStore(input: unknown): TaskStore {
  const store = asJsonObject(input) as TaskStoreInput | undefined;
  return {
    version: typeof store?.version === "number" ? store.version : 1,
    plans: Array.isArray(store?.plans)
      ? store.plans.map(asTaskPlan).filter((plan): plan is TaskPlan => plan !== undefined)
      : [],
  };
}

export function nativeTaskPlan(plan: TaskPlan): JsonObject {
  return {
    id: plan.id,
    title: plan.title,
    original_request: plan.originalRequest,
    ...(plan.createdAt != null ? { created_at: plan.createdAt } : {}),
    ...(plan.updatedAt != null ? { updated_at: plan.updatedAt } : {}),
    status: plan.status,
    current_subtask_ids: [...plan.currentSubtaskIds],
    context: { ...plan.context },
    subtasks: plan.subtasks.map(nativeSubTask),
  };
}

function nativeSubTask(subtask: SubTask): JsonObject {
  return {
    id: subtask.id,
    title: subtask.title,
    description: subtask.description,
    status: subtask.status,
    dependencies: [...subtask.dependencies],
    parallel_safe: subtask.parallelSafe,
    result: subtask.result ?? null,
    error: subtask.error ?? null,
    started_at: subtask.startedAt ?? null,
    completed_at: subtask.completedAt ?? null,
    retry_count: subtask.retryCount,
    max_retries: subtask.maxRetries,
  };
}

function asTaskPlan(value: unknown): TaskPlan | null {
  const plan = asJsonObject(value) as TaskPlanInput | undefined;
  if (!plan || typeof plan.id !== "string" || typeof plan.title !== "string") {
    return null;
  }
  return normalizeTaskPlan(plan);
}

function asJsonObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : undefined;
}
