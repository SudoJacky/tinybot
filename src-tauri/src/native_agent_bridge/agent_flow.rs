use crate::native_agent_bridge::{
    hydrate_native_agent_history_for_runtime, native_agent_services_with_tool_executor,
    native_agent_trace_sink, persist_native_agent_checkpoint_if_present,
    persist_native_agent_run_record, persist_native_agent_run_start,
    persist_native_agent_turn_if_final, reject_native_agent_terminal_run_reentry,
};
use crate::worker_agent_runtime::{
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
    let mut persistence_spec = spec.clone();
    if let Some(mut rejection) = reject_native_agent_terminal_run_reentry(
        &persistence_spec,
        workspace_root.clone(),
        config_snapshot.clone(),
    )? {
        rejection["traceContext"] = serde_json::to_value(trace_context)
            .map_err(|error| format!("failed to serialize terminal run trace context: {error}"))?;
        return Ok(rejection);
    }
    let instructions = InstructionComposer::default().compose(&workspace_root, &spec)?;
    instructions.attach_diagnostics(&mut persistence_spec)?;
    let runtime_spec = hydrate_native_agent_history_for_runtime(
        spec,
        workspace_root.clone(),
        config_snapshot.clone(),
    )?;
    let start_persistence_error = persist_native_agent_run_start(
        persistence_spec.clone(),
        workspace_root.clone(),
        config_snapshot.clone(),
    )
    .err();
    let services = native_agent_services_with_tool_executor(
        base_services,
        workspace_root.clone(),
        config_snapshot.clone(),
    )
    .with_trace_sink(native_agent_trace_sink(
        workspace_root.clone(),
        config_snapshot.clone(),
        live_trace_sink,
    ));
    let mut result = run_native_agent_turn_with_workspace_and_instructions_async(
        &services,
        runtime_spec,
        config_snapshot.clone(),
        &workspace_root,
        instructions,
    )
    .await?;
    if let Err(error) = persist_native_agent_run_record(
        persistence_spec.clone(),
        &mut result,
        workspace_root.clone(),
        config_snapshot.clone(),
    ) {
        result["runPersistence"] = serde_json::json!({
            "ok": false,
            "error": error,
        });
    }
    if let Some(error) = start_persistence_error {
        result["runPersistenceDiagnostics"] = serde_json::json!([{
            "phase": "start",
            "ok": false,
            "error": error,
        }]);
    }
    persist_native_agent_checkpoint_if_present(
        &result,
        workspace_root.clone(),
        config_snapshot.clone(),
    )?;
    persist_native_agent_turn_if_final(
        persistence_spec,
        &mut result,
        workspace_root,
        config_snapshot,
    )?;
    Ok(result)
}
