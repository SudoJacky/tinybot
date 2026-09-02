import { invoke as tauriInvoke } from "@tauri-apps/api/core";

type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export type NativeWorkspaceRegistryEntry = {
  path: string;
  name: string;
  exists: boolean;
  addedAtMs: number;
  updatedAtMs: number;
};

export type NativeWorkspaceRegistrySnapshot = {
  workspaces: NativeWorkspaceRegistryEntry[];
};

export type NativeWorkspaceRegistryApi = {
  list(): Promise<NativeWorkspaceRegistrySnapshot>;
  register(path: string): Promise<NativeWorkspaceRegistryEntry>;
  rename(path: string, name: string): Promise<NativeWorkspaceRegistryEntry>;
  forget(path: string): Promise<NativeWorkspaceRegistryEntry>;
};

export function createDesktopNativeWorkspaceRegistryApi(
  options: { invoke?: TauriInvoke } = {},
): NativeWorkspaceRegistryApi {
  const invoke = options.invoke ?? tauriInvoke;
  return {
    list: () => invoke("worker_workspace_registry_list") as Promise<NativeWorkspaceRegistrySnapshot>,
    register: (path) => invoke("worker_workspace_register", {
      input: { path },
    }) as Promise<NativeWorkspaceRegistryEntry>,
    rename: (path, name) => invoke("worker_workspace_rename", {
      input: { path, name },
    }) as Promise<NativeWorkspaceRegistryEntry>,
    forget: (path) => invoke("worker_workspace_forget", {
      input: { path },
    }) as Promise<NativeWorkspaceRegistryEntry>,
  };
}
