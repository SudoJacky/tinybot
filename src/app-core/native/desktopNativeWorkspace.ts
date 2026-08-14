import { invoke as tauriInvoke } from "@tauri-apps/api/core";

type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export type NativeWorkspaceApi = {
  files: () => Promise<unknown>;
  file: (path: string) => Promise<unknown>;
  bootstrapFiles: (files: string[]) => Promise<unknown>;
  putFile: (path: string, body: unknown) => Promise<unknown>;
  directory: (request: { cursor?: string; nameQuery?: string; path: string }) => Promise<unknown>;
  fileChunk: (request: { cursor?: string; path: string }) => Promise<unknown>;
};

export function createDesktopNativeWorkspaceApi(options: { invoke?: TauriInvoke } = {}): NativeWorkspaceApi {
  const invoke = options.invoke ?? tauriInvoke;
  return {
    files: () => invoke("worker_workspace_files"),
    file: (path: string) => invoke("worker_workspace_file", { input: { path } }),
    bootstrapFiles: (files: string[]) => invoke("worker_workspace_bootstrap_files", { input: { files } }),
    putFile: (path: string, body: unknown) => invoke("worker_workspace_put_file", { input: { path, body } }),
    directory: (request) => invoke("worker_workspace_directory", { input: request }),
    fileChunk: (request) => invoke("worker_workspace_file_chunk", { input: request }),
  };
}
