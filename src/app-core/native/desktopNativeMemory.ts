import { invoke as tauriInvoke } from "@tauri-apps/api/core";

type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export type NativeWorkspaceMemory = {
  path: string;
  current: boolean;
  memories: string[];
};

export type NativeMemorySnapshot = {
  currentWorkspacePath: string;
  userMemories: string[];
  workspaces: NativeWorkspaceMemory[];
};

export type NativeMemoryApi = {
  snapshot(): Promise<NativeMemorySnapshot>;
};

export function createDesktopNativeMemoryApi(options: { invoke?: TauriInvoke } = {}): NativeMemoryApi {
  const invoke = options.invoke ?? tauriInvoke;
  return {
    snapshot: () => invoke("worker_memory_snapshot") as Promise<NativeMemorySnapshot>,
  };
}
