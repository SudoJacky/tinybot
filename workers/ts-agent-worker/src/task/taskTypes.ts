export type SubTaskStatus = "pending" | "in_progress" | "completed" | "failed" | "skipped";

export type TaskPlanStatus = "planning" | "executing" | "completed" | "failed" | "paused";

export interface SubTask {
  id: string;
  title: string;
  description: string;
  status: SubTaskStatus;
  dependencies: string[];
  parallelSafe: boolean;
  result?: string | null;
  error?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  retryCount: number;
  maxRetries: number;
}

export interface TaskPlan {
  id: string;
  title: string;
  originalRequest: string;
  subtasks: SubTask[];
  createdAt?: string | null;
  updatedAt?: string | null;
  status: TaskPlanStatus;
  currentSubtaskIds: string[];
  context: Record<string, unknown>;
}

export interface TaskStore {
  version: number;
  plans: TaskPlan[];
}

export type TaskStoreInput = {
  version?: number;
  plans?: TaskPlanInput[];
};

export type SubTaskInput = Partial<
  Omit<SubTask, "parallelSafe" | "retryCount" | "maxRetries" | "dependencies" | "status">
> & {
  id: string;
  title: string;
  description: string;
  status?: SubTaskStatus;
  dependencies?: string[];
  parallelSafe?: boolean;
  parallel_safe?: boolean;
  startedAt?: string | null;
  started_at?: string | null;
  completedAt?: string | null;
  completed_at?: string | null;
  retryCount?: number;
  retry_count?: number;
  maxRetries?: number;
  max_retries?: number;
};

export type TaskPlanInput = Partial<
  Omit<TaskPlan, "originalRequest" | "subtasks" | "currentSubtaskIds" | "status" | "context">
> & {
  id: string;
  title: string;
  originalRequest?: string;
  original_request?: string;
  subtasks?: SubTaskInput[];
  createdAt?: string | null;
  created_at?: string | null;
  updatedAt?: string | null;
  updated_at?: string | null;
  status?: TaskPlanStatus;
  currentSubtaskIds?: string[];
  current_subtask_ids?: string[];
  context?: Record<string, unknown>;
};
