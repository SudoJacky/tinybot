import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { NativeWorkspaceApi } from "../gateway/gatewayHttpClient";

type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export function createDesktopNativeWorkspaceApi(options: { invoke?: TauriInvoke } = {}): NativeWorkspaceApi {
  const invoke = options.invoke ?? tauriInvoke;
  return {
    files: () => invoke("worker_workspace_files"),
    file: (path: string) => invoke("worker_workspace_file", { input: { path } }),
    putFile: (path: string, body: unknown) => invoke("worker_workspace_put_file", { input: { path, body } }),
    directory: (request) => invoke("worker_workspace_directory", { input: request }),
    fileChunk: (request) => invoke("worker_workspace_file_chunk", { input: request }),
  };
}
