export const NATIVE_BACKEND_COMMAND_NAMES = [
  "worker_probe_status",
  "worker_run_agent",
  "worker_run_agent_input",
  "worker_cancel_agent",
  "worker_restore_agent_checkpoint",
  "worker_submit_agent_form",
  "worker_resume_agent_approval",
  "worker_background_trace_list",
  "worker_background_trace_get_delegate_trace",
  "worker_background_trace_get_artifact",
  "worker_background_trace_append",
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
  "worker_session_temporary_files",
  "worker_session_upload_temporary_file",
  "worker_session_clear_temporary_files",
  "worker_session_delete",
  "worker_session_patch",
  "worker_session_clear",
  "worker_session_task_progress",
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
