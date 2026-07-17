use crate::native_agent_bridge::{
    hydrate_native_agent_history_for_runtime, materialize_turn_attachments,
    native_agent_context_checkpoint_committer, native_agent_run_id,
    native_agent_services_with_tool_executor, native_agent_session_id, native_agent_thread_id,
    native_agent_trace_sink, persist_native_agent_checkpoint_if_present,
    persist_native_agent_run_record, persist_native_agent_run_start,
    persist_native_agent_turn_if_final, reject_native_agent_terminal_run_reentry,
    turn_result_needs_attachment_files, TurnAttachmentLease,
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
    if let Some(mut rejection) = reject_native_agent_terminal_run_reentry(
        &spec,
        workspace_root.clone(),
        config_snapshot.clone(),
    )? {
        rejection["traceContext"] = serde_json::to_value(trace_context)
            .map_err(|error| format!("failed to serialize terminal run trace context: {error}"))?;
        return Ok(rejection);
    }
    materialize_turn_attachments(&mut spec, &workspace_root)?;
    let mut attachment_lease = TurnAttachmentLease::for_spec(&spec, &workspace_root);
    let mut persistence_spec = spec.clone();
    let thread_owned = native_agent_thread_id(&persistence_spec).is_some();
    let instructions = InstructionComposer::default().compose_with_config(
        &workspace_root,
        &spec,
        &config_snapshot,
    )?;
    instructions.attach_diagnostics(&mut persistence_spec)?;
    let runtime_spec = hydrate_native_agent_history_for_runtime(
        spec,
        workspace_root.clone(),
        config_snapshot.clone(),
    )?;
    persist_native_agent_run_start(
        persistence_spec.clone(),
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
    let services = if thread_owned {
        if let Some(live_trace_sink) = live_trace_sink {
            services.with_trace_sink(live_trace_sink)
        } else {
            services
        }
    } else {
        services.with_trace_sink(native_agent_trace_sink(
            workspace_root.clone(),
            config_snapshot.clone(),
            live_trace_sink,
        ))
    };
    let run_result = run_native_agent_turn_with_workspace_and_instructions_async(
        &services,
        runtime_spec,
        config_snapshot.clone(),
        &workspace_root,
        instructions,
    )
    .await;
    let flush_result = services.flush_trace_sink();
    let mut result = match (run_result, flush_result) {
        (Ok(result), Ok(())) => result,
        (Err(run_error), Ok(())) => return Err(run_error),
        (Ok(_), Err(flush_error)) => return Err(flush_error),
        (Err(run_error), Err(flush_error)) => {
            return Err(format!(
            "native agent run failed: {run_error}; trace persistence flush failed: {flush_error}"
        ))
        }
    };
    if turn_result_needs_attachment_files(&result) {
        attachment_lease.preserve();
    }
    if !thread_owned {
        merge_persisted_runtime_events(&services, &persistence_spec, &mut result)?;
    }
    persist_native_agent_run_record(
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
    persist_native_agent_turn_if_final(
        persistence_spec,
        &mut result,
        workspace_root,
        config_snapshot,
    )?;
    Ok(result)
}

fn merge_persisted_runtime_events(
    services: &NativeAgentRuntimeServices,
    spec: &serde_json::Value,
    result: &mut serde_json::Value,
) -> Result<(), String> {
    let runtime_events = result
        .get("runtimeEvents")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let needs_command_acknowledgement = runtime_events.iter().any(|event| {
        event
            .get("payload")
            .and_then(|payload| payload.get("commandId"))
            .and_then(serde_json::Value::as_str)
            .is_some_and(|command_id| !command_id.trim().is_empty())
    });
    if !needs_command_acknowledgement {
        return Ok(());
    }
    let session_id = native_agent_session_id(result)
        .or_else(|| native_agent_session_id(spec))
        .ok_or_else(|| "Rust agent run missing session id for trace merge".to_string())?;
    let run_id = native_agent_run_id(result)
        .or_else(|| native_agent_run_id(spec))
        .ok_or_else(|| "Rust agent run missing run id for trace merge".to_string())?;
    let persisted_runtime_events = services.load_runtime_events(&session_id, &run_id)?;
    let mut merged_runtime_events = runtime_events;
    for event in persisted_runtime_events {
        if event.event_name != "agent.command.acknowledged"
            || merged_runtime_events.iter().any(|existing| {
                existing.get("eventId").and_then(serde_json::Value::as_str)
                    == Some(event.event_id.as_str())
            })
        {
            continue;
        }
        merged_runtime_events.push(serde_json::to_value(event).map_err(|error| {
            format!("failed to serialize merged command acknowledgement: {error}")
        })?);
    }
    if merged_runtime_events.len()
        > result
            .get("runtimeEvents")
            .and_then(serde_json::Value::as_array)
            .map(Vec::len)
            .unwrap_or_default()
    {
        merged_runtime_events.sort_by_key(|event| {
            (
                event
                    .get("sequence")
                    .and_then(serde_json::Value::as_u64)
                    .unwrap_or(u64::MAX),
                event.get("eventName").and_then(serde_json::Value::as_str)
                    != Some("agent.command.acknowledged"),
            )
        });
        for (sequence, event) in merged_runtime_events.iter_mut().enumerate() {
            event["sequence"] = serde_json::json!(sequence);
        }
        result["runtimeEvents"] = serde_json::Value::Array(merged_runtime_events);
    }
    Ok(())
}
