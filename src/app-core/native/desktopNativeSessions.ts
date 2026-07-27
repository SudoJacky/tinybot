import { invoke as tauriInvoke } from "@tauri-apps/api/core";

type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export type NativeSessionsApi = {
  list: () => Promise<unknown>;
  messages: (key: string) => Promise<unknown>;
  effectiveCapabilities?: (key: string) => Promise<unknown>;
  turns?: (key: string) => Promise<unknown>;
  agentTurnRuntimeState?: (key: string, turnId: string) => Promise<unknown>;
  delete?: (key: string) => Promise<unknown>;
  patch?: (key: string, body: unknown) => Promise<unknown>;
  branch?: (body: unknown) => Promise<unknown>;
  clear?: (key: string) => Promise<unknown>;
  upsertTaskProgress?: (key: string, body: unknown) => Promise<unknown>;
};

export function createDesktopNativeSessionsApi(options: { invoke?: TauriInvoke } = {}): NativeSessionsApi {
  const invoke = options.invoke ?? tauriInvoke;
  return {
    list: () => invoke("worker_sessions_list"),
    messages: (key: string) => invoke("worker_session_messages", { input: { key } }),
    effectiveCapabilities: (key: string) => invoke("worker_session_effective_capabilities", { input: { key } }),
    turns: (key: string) => invoke("worker_turns_list", { input: { key } }),
    agentTurnRuntimeState: (key: string, turnId: string) => invoke("worker_turn_runtime_state", { input: { sessionKey: key, turnId } }),
    delete: (key: string) => invoke("worker_session_delete", { input: { key } }),
    patch: (key: string, body: unknown) => invoke("worker_session_patch", { input: { key, body } }),
    branch: (body: unknown) => invoke("worker_session_branch", { input: { body } }),
    clear: (key: string) => invoke("worker_session_clear", { input: { key } }),
    upsertTaskProgress: (key: string, body: unknown) => invoke("worker_session_task_progress", { input: { key, body } }),
  };
}
