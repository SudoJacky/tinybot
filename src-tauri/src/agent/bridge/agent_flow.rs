#[cfg(not(test))]
use crate::agent::bridge::native_agent_thread_id;
use crate::agent::bridge::{
    hydrate_native_agent_history_for_runtime, hydrate_native_agent_memory_snapshot_for_runtime,
    native_agent_context_checkpoint_committer, native_agent_services_with_tool_executor,
    native_agent_trace_sink, persist_native_agent_checkpoint_if_present,
    persist_native_agent_turn_start, persist_native_agent_turn_terminal_if_present,
    reject_native_agent_terminal_turn_reentry,
};
use crate::agent::runtime::AgentError;
use crate::agent::runtime::{
    ensure_agent_trace_context, run_native_agent_turn_with_workspace_and_instructions_async,
    InstructionComposer, NativeAgentRuntimeServices, NativeAgentTraceSink,
};
#[cfg(not(test))]
use crate::agent::runtime::{AgentExecutionStatus, AgentStopReason};
use crate::agent::runtime::{AgentResultError, AgentTurnInput, AgentTurnResult};
use std::path::PathBuf;
use std::sync::Arc;

#[cfg(test)]
#[path = "agent_flow_tests.rs"]
mod tests;

pub(crate) async fn run_agent_with_services(
    base_services: NativeAgentRuntimeServices,
    mut spec: serde_json::Value,
    workspace_root: PathBuf,
    mut config_snapshot: serde_json::Value,
    live_trace_sink: Option<Arc<dyn NativeAgentTraceSink>>,
) -> Result<AgentTurnResult, AgentError> {
    let thread_store = base_services.thread_store()?;
    let trace_context = ensure_agent_trace_context(&mut spec)?;
    if let Some(mut rejection) =
        reject_native_agent_terminal_turn_reentry(&spec, &thread_store, config_snapshot.clone())?
    {
        rejection.trace_context = Some(trace_context);
        return Ok(rejection);
    }
    spec = hydrate_native_agent_memory_snapshot_for_runtime(spec, &thread_store)?;
    let mut persistence_spec = spec.clone();
    let instructions = InstructionComposer::default().compose_with_config(
        &workspace_root,
        &spec,
        &config_snapshot,
    )?;
    let graph_base_config_snapshot = config_snapshot.clone();
    crate::workspace_extensions::merge_workspace_mcp_servers(
        &mut config_snapshot,
        &instructions.working_directory,
    )?;
    #[cfg(not(test))]
    let memory_scope_root = instructions.working_directory.clone();
    instructions.attach_diagnostics(&mut persistence_spec)?;
    persistence_spec["materializedSystemPrompt"] =
        serde_json::Value::String(instructions.rendered_prompt().to_string());
    persist_native_agent_turn_start(
        persistence_spec.clone(),
        &thread_store,
        config_snapshot.clone(),
    )?;
    let runtime_spec =
        hydrate_native_agent_history_for_runtime(spec, &thread_store, config_snapshot.clone())?;
    let services = native_agent_services_with_tool_executor(
        base_services,
        workspace_root.clone(),
        graph_base_config_snapshot,
    )?
    .with_context_checkpoint_committer(native_agent_context_checkpoint_committer(
        thread_store.clone(),
        config_snapshot.clone(),
    ));
    let services = match live_trace_sink {
        Some(live_trace_sink) => services.with_trace_sink(native_agent_trace_sink(
            thread_store.clone(),
            config_snapshot.clone(),
            Some(live_trace_sink),
        )),
        None => services.with_trace_sink_if_missing(|| {
            native_agent_trace_sink(thread_store.clone(), config_snapshot.clone(), None)
        }),
    };
    #[cfg(not(test))]
    let services = services.with_command_hooks(crate::command_hooks::CommandHookEngine::load(
        &crate::config::application::tinybot_data_root(),
        &instructions.working_directory,
    ));
    let turn_result = match AgentTurnInput::from_wire(&runtime_spec, &config_snapshot) {
        Ok(input) => {
            run_native_agent_turn_with_workspace_and_instructions_async(
                &services,
                input,
                config_snapshot.clone(),
                &workspace_root,
                instructions,
            )
            .await
        }
        Err(error) => Err(AgentError::invalid_input(error)),
    };
    let flush_result = services.flush_trace_sink();
    let mut result = match (turn_result, flush_result) {
        (Ok(result), Ok(())) => result,
        (Err(turn_error), Ok(())) => {
            return Err(persist_failed_agent_turn(
                &persistence_spec,
                &thread_store,
                config_snapshot,
                turn_error,
            ))
        }
        (Ok(_), Err(flush_error)) => {
            return Err(persist_failed_agent_turn(
                &persistence_spec,
                &thread_store,
                config_snapshot,
                flush_error,
            ))
        }
        (Err(turn_error), Err(flush_error)) => {
            return Err(persist_failed_agent_turn(
                &persistence_spec,
                &thread_store,
                config_snapshot,
                turn_error.combine(flush_error.context("trace persistence flush failed")),
            ))
        }
    };
    persist_native_agent_turn_terminal_if_present(
        persistence_spec.clone(),
        &mut result,
        &thread_store,
        config_snapshot.clone(),
    )?;
    persist_native_agent_checkpoint_if_present(&result, &thread_store, config_snapshot.clone())?;
    #[cfg(not(test))]
    schedule_completed_turn_memory_extraction(
        &persistence_spec,
        &result,
        &workspace_root,
        &memory_scope_root,
        &thread_store,
        &config_snapshot,
    );
    Ok(result)
}

fn persist_failed_agent_turn(
    persistence_spec: &serde_json::Value,
    thread_store: &crate::threads::workspace_store::WorkspaceThreadStore,
    config_snapshot: serde_json::Value,
    runtime_error: AgentError,
) -> AgentError {
    let turn_id = crate::agent::runtime::agent_trace_context_from_value(persistence_spec).turn_id;
    let session_id = crate::agent::bridge::native_agent_thread_id(persistence_spec)
        .or_else(|| crate::agent::bridge::native_agent_session_id(persistence_spec))
        .unwrap_or_else(|| "native-rust-session".to_string());
    let mut failure = AgentTurnResult {
        error: Some(AgentResultError::Structured(runtime_error.clone())),
        ..AgentTurnResult::new(&turn_id, &session_id, runtime_error.stop_reason())
    };
    if let Err(persistence_error) = persist_native_agent_turn_terminal_if_present(
        persistence_spec.clone(),
        &mut failure,
        thread_store,
        config_snapshot,
    ) {
        return runtime_error
            .combine(persistence_error.context("failed to persist terminal turn state"));
    }
    runtime_error
}

#[cfg(not(test))]
fn schedule_completed_turn_memory_extraction(
    spec: &serde_json::Value,
    result: &AgentTurnResult,
    workspace_root: &std::path::Path,
    memory_scope_root: &std::path::Path,
    thread_store: &crate::threads::workspace_store::WorkspaceThreadStore,
    config_snapshot: &serde_json::Value,
) {
    if result.stop_reason == AgentStopReason::ContextCompacted
        || result.stop_reason.status() != AgentExecutionStatus::Completed
    {
        return;
    }
    let thread_id = native_agent_thread_id(spec).unwrap_or_else(|| result.session_id.clone());
    let turn_id = result.turn_id.clone();
    let workspace_path = match crate::memory::normalized_workspace_path(memory_scope_root) {
        Ok(path) => path,
        Err(error) => {
            eprintln!(
                "memory_phase1_schedule_skipped reason=invalid_workspace_path thread_id={} turn_id={} error={}",
                thread_id, turn_id, error
            );
            return;
        }
    };
    crate::memory::schedule_turn_extraction(
        workspace_root.to_path_buf(),
        thread_store.clone(),
        config_snapshot.clone(),
        thread_id,
        turn_id,
        workspace_path,
    );
}
