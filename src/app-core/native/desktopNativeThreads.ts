import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { NativeThreadsApi } from "../gateway/gatewayHttpClient";

type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export function createDesktopNativeThreadsApi(options: { invoke?: TauriInvoke } = {}): NativeThreadsApi {
  const invoke = options.invoke ?? tauriInvoke;
  const thread = (command: string, body: unknown = {}) => invoke(command, { input: { body } });
  return {
    create: (body) => thread("worker_thread_create", body),
    read: (body) => thread("worker_thread_read", body),
    resume: (body) => thread("worker_thread_resume", body),
    list: (body) => thread("worker_threads_list", body),
    search: (body) => thread("worker_thread_search", body),
    activity: (body) => thread("worker_thread_activity", body),
    status: (body) => thread("worker_thread_status", body),
    updateMetadata: (body) => thread("worker_thread_update_metadata", body),
    agentRegistry: (body) => thread("worker_thread_agent_registry", body),
    startTurn: (body) => thread("worker_thread_start_turn", body),
    continueTurn: (body) => thread("worker_thread_continue_turn", body),
    interrupt: (body) => thread("worker_thread_interrupt", body),
    applyOp: (body) => thread("worker_thread_apply_op", body),
    archive: (body) => thread("worker_thread_archive", body),
    unarchive: (body) => thread("worker_thread_unarchive", body),
    delete: (body) => thread("worker_thread_delete", body),
    fork: (body) => thread("worker_thread_fork", body),
    events: (body) => thread("worker_thread_events", body),
    restoreCheckpoint: (body) => thread("worker_thread_restore_checkpoint", body),
    submitTurn: (body) => invoke("worker_submit_thread_turn", { input: body }),
    resolveApproval: (body) => invoke("worker_resolve_thread_approval", { input: body }),
    submitForm: (body) => invoke("worker_submit_thread_form", { input: body }),
  };
}
