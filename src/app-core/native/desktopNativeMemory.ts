import { invoke as tauriInvoke } from "@tauri-apps/api/core";

type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export type NativeMemoryEntry = {
  id: number;
  scope: "user" | "workspace";
  path: string | null;
  content: string;
  userManaged: boolean;
};
export type NativeMemorySnapshot = {
  currentWorkspacePath: string;
  revision: number;
  entries: NativeMemoryEntry[];
};
export type MemoryMutation =
  | { operation: "create"; scope: "user" | "workspace"; path: string | null; content: string }
  | { operation: "update"; id: number; scope: "user" | "workspace"; path: string | null; content: string }
  | { operation: "delete"; ids: number[] };
export type MemoryMutationRequest = { expectedRevision: number; mutation: MemoryMutation };
export type NativeMemoryApi = {
  snapshot(): Promise<NativeMemorySnapshot>;
  mutate(request: MemoryMutationRequest): Promise<NativeMemorySnapshot>;
};

export function createDesktopNativeMemoryApi(options: { invoke?: TauriInvoke } = {}): NativeMemoryApi {
  const invoke = options.invoke ?? tauriInvoke;
  return {
    snapshot: () => invoke("worker_memory_snapshot") as Promise<NativeMemorySnapshot>,
    mutate: (request) => invoke("worker_memory_mutate", request) as Promise<NativeMemorySnapshot>,
  };
}
