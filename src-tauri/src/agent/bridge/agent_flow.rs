use crate::agent::bridge::{
    hydrate_native_agent_history_for_runtime, native_agent_context_checkpoint_committer,
    native_agent_services_with_tool_executor, native_agent_trace_sink,
    persist_native_agent_checkpoint_if_present, persist_native_agent_turn_start,
    persist_native_agent_turn_terminal_if_present, reject_native_agent_terminal_turn_reentry,
};
use crate::agent::runtime::{
    ensure_agent_trace_context, run_native_agent_turn_with_workspace_and_instructions_async,
    InstructionComposer, NativeAgentRuntimeServices, NativeAgentTraceSink,
};
use std::path::PathBuf;
use std::sync::Arc;

pub(crate) async fn run_agent_with_services(
    base_services: NativeAgentRuntimeServices,
    mut spec: serde_json::Value,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    live_trace_sink: Option<Arc<dyn NativeAgentTraceSink>>,
) -> Result<serde_json::Value, String> {
    let trace_context = ensure_agent_trace_context(&mut spec)?;
    if let Some(mut rejection) = reject_native_agent_terminal_turn_reentry(
        &spec,
        workspace_root.clone(),
        config_snapshot.clone(),
    )? {
        rejection["traceContext"] = serde_json::to_value(trace_context)
            .map_err(|error| format!("failed to serialize terminal turn trace context: {error}"))?;
        return Ok(rejection);
    }
    let mut persistence_spec = spec.clone();
    let instructions = InstructionComposer::default().compose_with_config(
        &workspace_root,
        &spec,
        &config_snapshot,
    )?;
    instructions.attach_diagnostics(&mut persistence_spec)?;
    persistence_spec["materializedSystemPrompt"] =
        serde_json::Value::String(instructions.rendered_prompt().to_string());
    persist_native_agent_turn_start(
        persistence_spec.clone(),
        workspace_root.clone(),
        config_snapshot.clone(),
    )?;
    let runtime_spec = hydrate_native_agent_history_for_runtime(
        spec,
        workspace_root.clone(),
        config_snapshot.clone(),
    )?;
    let services = native_agent_services_with_tool_executor(
        base_services,
        workspace_root.clone(),
        config_snapshot.clone(),
    )
    .with_context_checkpoint_committer(native_agent_context_checkpoint_committer(
        workspace_root.clone(),
        config_snapshot.clone(),
    ));
    let services = services.with_trace_sink(native_agent_trace_sink(
        workspace_root.clone(),
        config_snapshot.clone(),
        live_trace_sink,
    ));
    let turn_result = run_native_agent_turn_with_workspace_and_instructions_async(
        &services,
        runtime_spec,
        config_snapshot.clone(),
        &workspace_root,
        instructions,
    )
    .await;
    let flush_result = services.flush_trace_sink();
    let mut result = match (turn_result, flush_result) {
        (Ok(result), Ok(())) => result,
        (Err(turn_error), Ok(())) => return Err(turn_error),
        (Ok(_), Err(flush_error)) => return Err(flush_error),
        (Err(turn_error), Err(flush_error)) => {
            return Err(format!(
            "native agent turn failed: {turn_error}; trace persistence flush failed: {flush_error}"
        ))
        }
    };
    persist_native_agent_turn_terminal_if_present(
        persistence_spec.clone(),
        &mut result,
        workspace_root.clone(),
        config_snapshot.clone(),
    )?;
    persist_native_agent_checkpoint_if_present(
        &result,
        workspace_root.clone(),
        config_snapshot.clone(),
    )?;
    Ok(result)
}
