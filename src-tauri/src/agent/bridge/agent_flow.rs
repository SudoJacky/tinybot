use super::AgentApplicationServices;
use crate::agent::bridge::{
    hydrate_native_agent_history_for_runtime, hydrate_native_agent_memory_snapshot_for_runtime,
    persist_native_agent_checkpoint_if_present, persist_native_agent_turn_start,
    persist_native_agent_turn_terminal_if_present, reject_native_agent_terminal_turn_reentry,
};
use crate::agent::instruction_sources::InstructionLoader;
use crate::agent::runtime::AgentError;
#[cfg(test)]
use crate::agent::runtime::NativeAgentRuntimeServices;
use crate::agent::runtime::{
    run_native_agent_turn_with_workspace_and_instructions_async, NativeAgentTraceSink,
};
#[cfg(not(test))]
use crate::agent::runtime::{AgentExecutionStatus, AgentStopReason};
use crate::agent::runtime::{AgentResultError, AgentTurnResult};
use std::path::PathBuf;
use std::sync::Arc;

#[cfg(test)]
#[path = "agent_flow_tests.rs"]
mod tests;

pub(crate) async fn run_agent_from_wire_with_services(
    services: AgentApplicationServices,
    spec: serde_json::Value,
    workspace_root: PathBuf,
    config: serde_json::Value,
    live_sink: Option<Arc<dyn NativeAgentTraceSink>>,
) -> Result<AgentTurnResult, AgentError> {
    let request = super::turn_request::AgentTurnRequest::from_wire(spec, &config, &workspace_root)?;
    run_agent_with_services(services, request, workspace_root, config, live_sink).await
}

pub(super) async fn run_agent_with_services(
    base_services: AgentApplicationServices,
    mut request: super::turn_request::AgentTurnRequest,
    workspace_root: PathBuf,
    mut config_snapshot: serde_json::Value,
    live_trace_sink: Option<Arc<dyn NativeAgentTraceSink>>,
) -> Result<AgentTurnResult, AgentError> {
    let thread_store = base_services.thread_store.clone();
    let trace_context = request.input.trace_context.clone();
    if let Some(mut rejection) =
        reject_native_agent_terminal_turn_reentry(&request.input, &thread_store)?
    {
        rejection.trace_context = Some(trace_context);
        return Ok(rejection);
    }
    hydrate_native_agent_memory_snapshot_for_runtime(&mut request, &thread_store)?;
    let instructions = InstructionLoader::new(thread_store.data_root().join("plugins"))
        .compose_input(&workspace_root, &request.instructions)?;
    let graph_base_config_snapshot = config_snapshot.clone();
    crate::workspace_extensions::merge_workspace_mcp_servers(
        &mut config_snapshot,
        &instructions.working_directory,
    )?;
    #[cfg(not(test))]
    let memory_scope_root = instructions.working_directory.clone();
    persist_native_agent_turn_start(&request, &instructions, &thread_store)?;
    hydrate_native_agent_history_for_runtime(&mut request.input, &thread_store)?;
    #[cfg(not(test))]
    let memory_runtime = base_services.memory_runtime.clone();
    let services = base_services
        .prepare_turn(
            &workspace_root,
            &instructions.working_directory,
            graph_base_config_snapshot,
            live_trace_sink,
        )
        .map_err(|error| {
            persist_failed_agent_turn(
                &request.input.session_id,
                &trace_context,
                &thread_store,
                error.into(),
            )
        })?;
    let session_id = request.input.session_id.clone();
    let turn_result = run_native_agent_turn_with_workspace_and_instructions_async(
        &services,
        request.input,
        config_snapshot.clone(),
        &workspace_root,
        instructions,
    )
    .await;
    let flush_result = services.flush_trace_sink();
    let mut result = match (turn_result, flush_result) {
        (Ok(result), Ok(())) => result,
        (Err(turn_error), Ok(())) => {
            return Err(persist_failed_agent_turn(
                &session_id,
                &trace_context,
                &thread_store,
                turn_error,
            ))
        }
        (Ok(_), Err(flush_error)) => {
            return Err(persist_failed_agent_turn(
                &session_id,
                &trace_context,
                &thread_store,
                flush_error,
            ))
        }
        (Err(turn_error), Err(flush_error)) => {
            return Err(persist_failed_agent_turn(
                &session_id,
                &trace_context,
                &thread_store,
                turn_error.combine(flush_error.context("trace persistence flush failed")),
            ))
        }
    };
    persist_native_agent_turn_terminal_if_present(&trace_context, &mut result, &thread_store)?;
    persist_native_agent_checkpoint_if_present(&result, &thread_store)?;
    #[cfg(not(test))]
    schedule_completed_turn_memory_extraction(
        &memory_runtime,
        &trace_context,
        &result,
        &workspace_root,
        &memory_scope_root,
        &thread_store,
        &config_snapshot,
    );
    Ok(result)
}

fn persist_failed_agent_turn(
    session_id: &str,
    trace_context: &crate::agent::runtime_protocol::AgentTraceContext,
    thread_store: &crate::threads::workspace_store::WorkspaceThreadStore,
    runtime_error: AgentError,
) -> AgentError {
    let turn_id = &trace_context.turn_id;
    let mut failure = AgentTurnResult {
        error: Some(AgentResultError::Structured(runtime_error.clone())),
        ..AgentTurnResult::new(&turn_id, &session_id, runtime_error.stop_reason())
    };
    if let Err(persistence_error) =
        persist_native_agent_turn_terminal_if_present(&trace_context, &mut failure, thread_store)
    {
        return runtime_error
            .combine(persistence_error.context("failed to persist terminal turn state"));
    }
    runtime_error
}

#[cfg(not(test))]
fn schedule_completed_turn_memory_extraction(
    memory_runtime: &crate::memory::MemoryRuntime,
    trace_context: &crate::agent::runtime_protocol::AgentTraceContext,
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
    let thread_id = trace_context
        .thread_id
        .clone()
        .unwrap_or_else(|| result.session_id.clone());
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
    if let Err(error) = memory_runtime.schedule_turn_extraction(
        thread_store.clone(),
        config_snapshot.clone(),
        thread_id,
        turn_id,
        workspace_path,
    ) {
        eprintln!(
            "memory_phase1_schedule_failed workspace={} error={error}",
            workspace_root.display()
        );
    }
}
