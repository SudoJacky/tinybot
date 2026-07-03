import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { NativeSessionsApi } from "../gateway/gatewayHttpClient";

type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export function createDesktopNativeSessionsApi(options: { invoke?: TauriInvoke } = {}): NativeSessionsApi {
  const invoke = options.invoke ?? tauriInvoke;
  return {
    list: () => invoke("worker_sessions_list"),
    messages: (key: string) => invoke("worker_session_messages", { input: { key } }),
    agentRuns: (key: string) => invoke("worker_agent_runs_list", { input: { key } }),
    agentRunRuntimeState: (key: string, runId: string) => invoke("worker_agent_run_runtime_state", { input: { sessionKey: key, runId } }),
    temporaryFiles: (key: string) => invoke("worker_session_temporary_files", { input: { key } }),
    uploadTemporaryFile: (key: string, body: unknown) => invoke("worker_session_upload_temporary_file", { input: { key, body } }),
    clearTemporaryFiles: (key: string) => invoke("worker_session_clear_temporary_files", { input: { key } }),
    delete: (key: string) => invoke("worker_session_delete", { input: { key } }),
    patch: (key: string, body: unknown) => invoke("worker_session_patch", { input: { key, body } }),
    branch: (body: unknown) => invoke("worker_session_branch", { input: { body } }),
    clear: (key: string) => invoke("worker_session_clear", { input: { key } }),
    upsertTaskProgress: (key: string, body: unknown) => invoke("worker_session_task_progress", { input: { key, body } }),
  };
}
