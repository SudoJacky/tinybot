export const NATIVE_BACKEND_COMMAND_NAMES = [
  "worker_probe_status",
  "worker_run_agent",
  "worker_run_agent_input",
  "worker_submit_thread_turn",
  "worker_cancel_agent",
  "worker_restore_agent_checkpoint",
  "worker_submit_agent_form",
  "worker_resume_agent_approval",
  "worker_resolve_thread_approval",
  "worker_submit_thread_form",
  "worker_background_trace_list",
  "worker_background_trace_get_delegate_trace",
  "worker_background_trace_get_artifact",
  "worker_background_trace_append",
  "worker_background_subagent_enqueue_input",
  "worker_subagent_spawn",
  "worker_subagent_list",
  "worker_subagent_query",
  "worker_subagent_send_input",
  "worker_subagent_wait",
  "worker_subagent_cancel",
  "worker_subagent_close",
  "worker_task_plan_list",
  "worker_task_plan_get",
  "worker_task_plan_save",
  "worker_task_plan_delete",
  "worker_knowledge_documents",
  "worker_knowledge_add_document",
  "worker_knowledge_document",
  "worker_knowledge_delete_document",
  "worker_knowledge_job",
  "worker_knowledge_rebuild_index",
  "worker_knowledge_stats",
  "worker_knowledge_graph",
  "worker_webui_route",
  "worker_cowork_route",
  "worker_transport_gateway_frame",
  "worker_transport_websocket_message",
  "worker_transport_dispatch_websocket_message",
  "worker_channel_dispatch_inbound",
  "worker_channel_start",
  "worker_channel_status",
  "worker_channel_stop",
  "worker_channel_login",
  "worker_skills_list",
  "worker_skills_detail",
  "worker_skills_create",
  "worker_skills_update",
  "worker_skills_delete",
  "worker_skills_validate",
  "worker_workspace_files",
  "worker_workspace_file",
  "worker_workspace_put_file",
  "worker_sessions_list",
  "worker_session_messages",
  "worker_agent_runs_list",
  "worker_agent_run_runtime_state",
  "worker_session_temporary_files",
  "worker_session_upload_temporary_file",
  "worker_session_clear_temporary_files",
  "worker_session_delete",
  "worker_session_patch",
  "worker_session_branch",
  "worker_session_clear",
  "worker_session_task_progress",
  "worker_thread_create",
  "worker_thread_read",
  "worker_thread_resume",
  "worker_threads_list",
  "worker_thread_search",
  "worker_thread_activity",
  "worker_thread_status",
  "worker_thread_update_metadata",
  "worker_thread_agent_registry",
  "worker_thread_start_turn",
  "worker_thread_continue_turn",
  "worker_thread_interrupt",
  "worker_thread_apply_op",
  "worker_thread_archive",
  "worker_thread_unarchive",
  "worker_thread_delete",
  "worker_thread_fork",
  "worker_thread_events",
  "worker_thread_restore_checkpoint",
] as const;

export type NativeBackendCommandName = typeof NATIVE_BACKEND_COMMAND_NAMES[number];

export const NATIVE_BACKEND_AGENT_EVENT_NAMES = [
  "agent.delta",
  "agent.reasoning_delta",
  "agent.tool_call.delta",
  "agent.tool.start",
  "agent.tool.result",
  "agent.usage",
  "agent.checkpoint",
  "agent.turn.started",
  "agent.status",
  "agent.phase.changed",
  "agent.guidance",
  "agent.approval.decision",
  "agent.form.resolution",
  "agent.message.completed",
  "agent.awaiting_form",
  "agent.awaiting_approval",
  "agent.memory_reference",
  "agent.task_progress",
  "agent.browser_frame",
  "agent.delegate.started",
  "agent.delegate.running",
  "agent.delegate.message_queued",
  "agent.delegate.awaiting_approval",
  "agent.delegate.tool.approval_required",
  "agent.delegate.tool.completed",
  "agent.delegate.trace.updated",
  "agent.delegate.completed",
  "agent.delegate.failed",
  "agent.delegate.interrupted",
  "agent.delegate.closed",
  "heartbeat.delivery",
  "agent.cancelled",
  "agent.done",
  "agent.error",
  "diagnostics.log",
  "worker.status",
] as const;

export type NativeBackendEventName = typeof NATIVE_BACKEND_AGENT_EVENT_NAMES[number];
export type NativeBackendRuntimeEventVisibility =
  | "trace-only"
  | "debug"
  | "status"
  | "websocket-visible"
  | "user-visible";

export const NATIVE_BACKEND_RUNTIME_EVENT_VISIBILITY = {
  "agent.turn.started": "user-visible",
  "agent.status": "user-visible",
  "agent.phase.changed": "debug",
  "agent.guidance": "status",
  "agent.approval.decision": "websocket-visible",
  "agent.form.resolution": "websocket-visible",
  "agent.message.completed": "user-visible",
} as const satisfies Partial<Record<NativeBackendEventName, NativeBackendRuntimeEventVisibility>>;

export type NativeBackendWorkerEventName = Exclude<
  NativeBackendEventName,
  "agent.browser_frame" | "diagnostics.log" | "worker.status"
>;
export type NativeBackendWebSocketAgentEventName = Exclude<
  NativeBackendEventName,
  "agent.checkpoint" | "heartbeat.delivery" | "diagnostics.log" | "worker.status"
>;

export type NativeBackendKind = "rust";
export type NativeBackendEventSource = "rust_backend";
export type NativeBackendWorkerTransportMode = "stdio" | "local_pipe";

export type NativeBackendDiagnosticLine = {
  stream: string;
  line: string;
};

export type NativeBackendRuntimeStatus = {
  backendKind: NativeBackendKind;
  backendLabel: "rust";
};

export type NativeBackendEventEnvelope<TPayload = unknown> = {
  sessionId: string;
  runId?: string | null;
  traceId: string;
  eventName: NativeBackendEventName;
  timestamp: string;
  source: NativeBackendEventSource;
  payload: TPayload;
};

export function isNativeBackendEventEnvelope(value: unknown): value is NativeBackendEventEnvelope {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.sessionId === "string" &&
    typeof value.traceId === "string" &&
    typeof value.eventName === "string" &&
    typeof value.timestamp === "string" &&
    typeof value.source === "string" &&
    "payload" in value
  );
}

export function normalizeNativeBackendEventPayload(value: unknown): unknown {
  return isNativeBackendEventEnvelope(value) ? value.payload : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
