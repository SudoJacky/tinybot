mod agent_flow;
mod attachments;
mod context_checkpoint;
mod history;
mod persistence;
mod result_projection;
mod thread_flow;
mod tool_dispatcher;
mod trace_sink;
mod webui_continuation;

pub(crate) use agent_flow::run_agent_with_services;
pub(crate) use attachments::{
    cleanup_turn_attachments, materialize_turn_attachments, turn_result_needs_attachment_files,
    TurnAttachmentLease,
};
pub(crate) use context_checkpoint::native_agent_context_checkpoint_committer;
pub(crate) use history::{
    hydrate_native_agent_history_for_runtime, native_agent_current_user_message,
    native_agent_thread_id, native_agent_user_messages,
};
#[cfg(test)]
pub(crate) use persistence::native_agent_run_record;
pub(crate) use persistence::{
    cancel_agent_with_services, persist_native_agent_checkpoint_if_present,
    persist_native_agent_run_record, persist_native_agent_run_start,
    persist_native_agent_turn_if_final, reject_native_agent_terminal_run_reentry,
    restore_agent_checkpoint_with_services,
};
pub(crate) use result_projection::{
    native_agent_artifacts, native_agent_current_iteration, native_agent_max_iterations,
    native_agent_model, native_agent_persisted_trace_values, native_agent_provider,
    native_agent_run_completed_at, native_agent_run_id, native_agent_run_phase_from_stop_reason,
    native_agent_run_status, native_agent_session_id, native_agent_string_field,
    native_agent_token_usage_info, native_agent_usage,
};
pub(crate) use thread_flow::{
    resolve_thread_approval_with_services, submit_thread_form_with_services,
    submit_thread_turn_with_services, ResolveThreadApprovalInput, SubmitThreadFormInput,
    SubmitThreadTurnInput,
};
pub(crate) use tool_dispatcher::native_agent_services_with_tool_executor;
#[cfg(test)]
pub(crate) use tool_dispatcher::{dispatch_agent_browser_interact, dispatch_agent_browser_observe};
#[cfg(test)]
pub(crate) use trace_sink::NativeAgentRunTraceSink;
pub(crate) use trace_sink::{desktop_agent_event_sink, native_agent_trace_sink};
pub(crate) use webui_continuation::{
    native_session_checkpoint, pending_approvals_from_checkpoint,
    resolve_agent_ui_form_body_with_services, resolve_approval_body_with_services,
};
