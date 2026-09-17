import { invoke as tauriInvoke } from "@tauri-apps/api/core";

export type TeamModel = {
  modelId: string;
  providerId?: string | null;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max" | null;
};
export type TeamMember = {
  id: string;
  displayName: string;
  instructions: string;
  model?: TeamModel | null;
};
export type TeamTask = {
  id: string;
  title: string;
  memberId: string;
  instructions: string;
  dependencies: string[];
};
export type TeamPlan = { tasks: TeamTask[]; finalTaskId: string };
export type TeamSpec = {
  goal: string;
  workspacePath: string;
  members: TeamMember[];
  maxConcurrency: number;
};
export type TeamTaskStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";
export type TeamAttempt = {
  threadId: string;
  turnId: string;
  status: TeamTaskStatus;
  startedAt: string;
  finishedAt: string | null;
  output: string | null;
  error: string | null;
};
export type TeamTaskRecord = {
  task: TeamTask;
  status: TeamTaskStatus;
  attempts: TeamAttempt[];
};
export type TeamRun = {
  schemaVersion: number;
  id: string;
  revision: number;
  spec: TeamSpec;
  finalTaskId: string;
  tasks: TeamTaskRecord[];
  status:
    | "planned"
    | "running"
    | "paused"
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted";
  createdAt: string;
  updatedAt: string;
  error: string | null;
};
export type TeamStore = {
  list(): Promise<TeamRun[]>;
  get(runId: string): Promise<TeamRun>;
  prepare(input: { spec: TeamSpec; plan?: TeamPlan; plannerModel?: TeamModel }): Promise<TeamRun>;
  revise(input: {
    runId: string;
    expectedRevision: number;
    plan: TeamPlan;
  }): Promise<TeamRun>;
  execute(input: { runId: string; expectedRevision: number }): Promise<TeamRun>;
  control(input: {
    runId: string;
    expectedRevision: number;
    action: "pause" | "cancel" | "retry";
    taskIds?: string[];
  }): Promise<TeamRun>;
};

export function createDesktopNativeTeamsApi({
  invoke = tauriInvoke,
}: {
  invoke?: (
    command: string,
    args?: Record<string, unknown>,
  ) => Promise<unknown>;
} = {}): TeamStore {
  return {
    list: () => invoke("worker_team_runs_list") as Promise<TeamRun[]>,
    get: (runId) =>
      invoke("worker_team_run_get", { runId }) as Promise<TeamRun>,
    prepare: (input) =>
      invoke("worker_team_prepare", { input }) as Promise<TeamRun>,
    revise: (input) =>
      invoke("worker_team_revise", { input }) as Promise<TeamRun>,
    execute: (input) =>
      invoke("worker_team_execute", { input }) as Promise<TeamRun>,
    control: (input) =>
      invoke("worker_team_control", { input }) as Promise<TeamRun>,
  };
}
