import { invoke as tauriInvoke } from "@tauri-apps/api/core";

type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export type NativeProjectGroup = {
  projectGroupId: string;
  name: string;
  workspaceIds: string[];
};

export type NativeProjectGroupSnapshot = {
  groups: NativeProjectGroup[];
};

export type NativeProjectGroupsApi = {
  list(): Promise<NativeProjectGroupSnapshot>;
  save(input: {
    projectGroupId?: string;
    name: string;
    workspaceIds: string[];
  }): Promise<NativeProjectGroup>;
  delete(projectGroupId: string): Promise<NativeProjectGroup>;
};

export function createDesktopNativeProjectGroupsApi(
  options: { invoke?: TauriInvoke } = {},
): NativeProjectGroupsApi {
  const invoke = options.invoke ?? tauriInvoke;
  return {
    list: () => invoke("worker_project_groups_list") as Promise<NativeProjectGroupSnapshot>,
    save: (input) => invoke("worker_project_group_save", { input }) as Promise<NativeProjectGroup>,
    delete: (projectGroupId) => invoke("worker_project_group_delete", {
      input: { projectGroupId },
    }) as Promise<NativeProjectGroup>,
  };
}
