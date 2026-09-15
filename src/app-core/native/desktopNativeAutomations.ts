import { invoke as tauriInvoke } from "@tauri-apps/api/core";

export type SavedAutomation = {
  id: string;
  name: string;
  instructions: string;
  workspacePath: string;
  revision: number;
  modelPolicy: "inherit_default" | "explicit";
  updatedAtMs: number;
  execution?: AutomationExecution;
  schedule?: AutomationSchedule;
  nextRunAtMs?: number | null;
};
export type AutomationExecution = {
  threadId?: string | null;
  provider?: string | null;
  profile?: string | null;
  model?: string | null;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max" | null;
};
export type AutomationSchedule = { repeat: "manual" | "once" | "daily" | "weekdays" | "weekly"; startAtMs?: number | null };
export type AutomationRun = {
  id: string;
  definition: SavedAutomation;
  effectiveModel: ({ model: string; provider: string; apiMode: string } & Record<string, unknown>) | null;
  threadId: string | null;
  status: "running" | "waiting" | "completed" | "failed" | "cancelled" | "interrupted" | "missed";
  error: string | null;
  startedAtMs: number;
  scheduledAtMs?: number | null;
  finishedAtMs: number | null;
  stopReason: string | null;
};
export type AutomationSnapshot = { definitions: SavedAutomation[]; runs: AutomationRun[] };
export type SaveAutomation = Pick<SavedAutomation, "name" | "instructions" | "workspacePath" | "execution" | "schedule"> & {
  id?: string;
  expectedRevision?: number;
};
export type AutomationStore = {
  list(): Promise<AutomationSnapshot>;
  save(input: SaveAutomation): Promise<SavedAutomation>;
  delete(id: string, expectedRevision: number): Promise<void>;
  run(id: string): Promise<AutomationRun>;
  output(id: string): Promise<string>;
};

export function createDesktopNativeAutomationsApi(
  { invoke = tauriInvoke }: { invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown> } = {},
): AutomationStore {
  return {
    list: () => invoke("worker_automations_list") as Promise<AutomationSnapshot>,
    save: (input) => invoke("worker_automation_save", { input }) as Promise<SavedAutomation>,
    delete: async (id, expectedRevision) => { await invoke("worker_automation_delete", { id, expectedRevision }); },
    run: (id) => invoke("worker_automation_run", { id }) as Promise<AutomationRun>,
    output: (id) => invoke("worker_automation_output", { id }) as Promise<string>,
  };
}
