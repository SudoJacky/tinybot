#[cfg(test)]
pub(crate) use application::TestApplicationServices;
mod application;
pub(crate) use application::AgentApplicationServices;
mod agent_flow;
mod context_checkpoint;
mod history;
mod persistence;
mod result_projection;
mod thread_flow;
mod tool_catalog;
mod tool_dispatcher;
mod trace_sink;
pub(crate) mod turn_request;
mod webui_continuation;
mod workspace_threads;

pub(crate) use agent_flow::run_agent_from_wire_with_services;
pub(crate) use context_checkpoint::native_agent_context_checkpoint_committer;
pub(crate) use history::{
    hydrate_native_agent_history_for_runtime, hydrate_native_agent_memory_snapshot_for_runtime,
    native_agent_current_user_message,
};
#[cfg(test)]
pub(crate) use persistence::native_agent_turn_start_record;
pub(crate) use persistence::{
    persist_native_agent_checkpoint_if_present, persist_native_agent_turn_start,
    persist_native_agent_turn_terminal_if_present, reject_native_agent_terminal_turn_reentry,
};
pub(crate) use result_projection::{
    native_agent_model, native_agent_provider, native_agent_string_field, native_agent_turn_id,
};
pub(crate) use thread_flow::{
    compact_thread_with_services, execute_thread_turn_with_services,
    submit_thread_form_with_services, submit_thread_turn_with_services, CompactThreadInput,
    SubmitThreadFormInput, SubmitThreadTurnInput,
};
pub(crate) use tool_dispatcher::native_agent_services_with_tool_executor;
#[cfg(test)]
pub(crate) use trace_sink::AgentTurnSemanticSink;
pub(crate) use trace_sink::{desktop_agent_event_sink, native_agent_trace_sink};
pub(crate) use webui_continuation::resolve_agent_ui_form_body_with_services;
