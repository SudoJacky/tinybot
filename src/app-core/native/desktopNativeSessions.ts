import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { NativeSessionsApi } from "../gateway/gatewayHttpClient";

type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

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
