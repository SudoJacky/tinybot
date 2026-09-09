use super::AgentApplicationServices;
use crate::agent::bridge::{
    persist_native_agent_checkpoint_if_present, persist_native_agent_turn_terminal_if_present,
};
use crate::agent::instruction_sources::InstructionLoader;
use crate::agent::runtime::AgentError;
use crate::agent::runtime::{
    run_native_agent_turn_with_workspace_and_instructions_async, AgentCheckpoint,
    AgentCheckpointPayload, AgentTurnInput, NativeAgentTraceSink,
};
use crate::threads::workspace_store::WorkspaceThreadStore;
use std::path::PathBuf;
use std::sync::Arc;

#[cfg(test)]
#[path = "webui_continuation_tests.rs"]
mod tests;

fn finish_native_agent_turn<T>(
    turn_result: Result<T, AgentError>,
    flush_result: Result<(), AgentError>,
    label: &str,
) -> Result<T, AgentError> {
    match (turn_result, flush_result) {
        (Ok(result), Ok(())) => Ok(result),
        (Err(turn_error), Ok(())) => Err(turn_error),
        (Ok(_), Err(flush_error)) => Err(flush_error),
        (Err(turn_error), Err(flush_error)) => Err(turn_error
            .context(format!("{label} failed"))
            .combine(flush_error.context("trace persistence flush failed"))),
    }
}

pub(crate) fn native_webui_agent_ui_form_not_found_body(form_id: String) -> serde_json::Value {
    serde_json::json!({
        "submitted": false,
        "cancelled": false,
        "form_id": form_id,
        "source": "rust",
        "error": "pending form checkpoint not found",
    })
}

pub(crate) async fn resolve_agent_ui_form_body_with_services(
    base_services: AgentApplicationServices,
    form_id: String,
    body: &serde_json::Value,
    cancelled: bool,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    live_trace_sink: Option<Arc<dyn NativeAgentTraceSink>>,
) -> Result<(u16, serde_json::Value), AgentError> {
    resolve_agent_ui_form_body_with_checkpoint(
        base_services,
        form_id,
        body,
        cancelled,
        None,
        workspace_root,
        config_snapshot,
        live_trace_sink,
    )
    .await
}

pub(crate) async fn resolve_agent_ui_form_body_with_checkpoint(
    base_services: AgentApplicationServices,
    form_id: String,
    body: &serde_json::Value,
    cancelled: bool,
    supplied_checkpoint: Option<AgentCheckpoint>,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    live_trace_sink: Option<Arc<dyn NativeAgentTraceSink>>,
) -> Result<(u16, serde_json::Value), AgentError> {
    let thread_store = base_services.thread_store.clone();
    let session_key = agent_ui_form_session_key(body).unwrap_or_default();
    let values = body
        .get("values")
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let canonical_thread_checkpoint = supplied_checkpoint.or(body
        .get("threadCheckpoint")
        .cloned()
        .map(AgentCheckpoint::from_wire)
        .transpose()?);
    let is_canonical = canonical_thread_checkpoint.is_some();
    let checkpoint = match canonical_thread_checkpoint {
        Some(checkpoint) => Some(checkpoint),
        None => native_session_checkpoint(
            &session_key,
            &thread_store,
            "native Agent UI form checkpoint lookup",
        )?,
    };
    let Some(checkpoint) = checkpoint else {
        return Ok((404, native_webui_agent_ui_form_not_found_body(form_id)));
    };
    let AgentCheckpointPayload::UserInput(payload) = &checkpoint.payload else {
        return Ok((404, native_webui_agent_ui_form_not_found_body(form_id)));
    };
    if checkpoint.phase.as_str() != "awaiting_form" || payload.form_id != form_id {
        return Ok((404, native_webui_agent_ui_form_not_found_body(form_id)));
    }
    let errors = validate_agent_ui_form_values(&payload.form, &values);
    if !cancelled && !errors.is_empty() {
        return Ok((
            400,
            serde_json::json!({
                "submitted": false,
                "form_id": form_id,
                "values": values,
                "errors": errors,
                "event": native_agent_ui_form_event("ui.form.validation_failed", &form_id, &values),
                "source": "rust",
            }),
        ));
    }

    let continuation = resolve_agent_ui_form_with_services(
        base_services,
        &session_key,
        checkpoint,
        is_canonical,
        form_id,
        body,
        values,
        cancelled,
        workspace_root,
        config_snapshot,
        live_trace_sink,
    )
    .await?;
    Ok((200, continuation))
}

pub(crate) fn agent_ui_form_session_key(body: &serde_json::Value) -> Option<String> {
    body.get("correlation")
        .and_then(|correlation| {
            correlation
                .get("session_key")
                .or_else(|| correlation.get("sessionId"))
                .or_else(|| correlation.get("session_id"))
                .and_then(serde_json::Value::as_str)
        })
        .or_else(|| {
            body.get("session_key")
                .or_else(|| body.get("sessionId"))
                .or_else(|| body.get("session_id"))
                .and_then(serde_json::Value::as_str)
        })
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub(crate) fn validate_agent_ui_form_values(
    form: &crate::agent::runtime::AgentUserInputForm,
    values: &serde_json::Value,
) -> serde_json::Map<String, serde_json::Value> {
    let mut errors = serde_json::Map::new();
    for name in form.required_field_names() {
        let missing = values
            .get(name)
            .is_none_or(|value| value.is_null() || value.as_str().is_some_and(str::is_empty));
        if missing {
            errors.insert(
                name.to_string(),
                serde_json::Value::String("Required".to_string()),
            );
        }
    }
    errors
}

pub(crate) fn native_agent_ui_form_continuation_spec(
    checkpoint: &AgentCheckpoint,
    body: &serde_json::Value,
    form_id: &str,
    values: &serde_json::Value,
    cancelled: bool,
) -> serde_json::Value {
    let turn_id = &checkpoint.turn_id;
    let session_id = &checkpoint.session_id;
    let mut metadata = serde_json::json!({
        "agentContinuation": {
            "kind": "form",
            "formId": form_id,
            "action": if cancelled { "cancel" } else { "submit" },
            "values": values,
        },
    });
    if let Some(command_id) = body
        .get("commandId")
        .or_else(|| body.get("command_id"))
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
    {
        metadata["commandId"] = serde_json::Value::String(command_id.to_string());
        metadata["_threadCommand"] = serde_json::json!({
            "commandId": command_id,
            "commandKind": if cancelled { "form.cancel" } else { "form.submit" },
            "form": { "formId": form_id },
            "source": body.get("source").cloned().unwrap_or(serde_json::Value::Null),
            "target": body.get("target").cloned().unwrap_or(serde_json::Value::Null),
        });
    }
    copy_thread_id_to_continuation_metadata(&mut metadata, checkpoint, body);
    if let Some(final_content) = body
        .get("finalContent")
        .or_else(|| body.get("final_content"))
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
    {
        metadata["finalContent"] = serde_json::Value::String(final_content.to_string());
    }
    serde_json::json!({
        "runtime": "rust",
        "turnId": turn_id,
        "sessionId": session_id,
        "metadata": metadata,
    })
}

fn copy_thread_id_to_continuation_metadata(
    metadata: &mut serde_json::Value,
    checkpoint: &AgentCheckpoint,
    body: &serde_json::Value,
) {
    let thread_id = checkpoint
        .thread_id
        .as_deref()
        .or_else(|| {
            body.get("threadId")
                .or_else(|| body.get("thread_id"))
                .and_then(serde_json::Value::as_str)
        })
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(thread_id) = thread_id {
        metadata["threadId"] = serde_json::Value::String(thread_id.to_string());
    }
}

pub(crate) fn native_agent_ui_form_event(
    event_type: &str,
    form_id: &str,
    values: &serde_json::Value,
) -> serde_json::Value {
    let mut payload = serde_json::json!({ "form_id": form_id });
    if event_type == "ui.form.submitted" || event_type == "ui.form.validation_failed" {
        payload["values"] = values.clone();
    }
    serde_json::json!({
        "event_type": event_type,
        "payload": payload,
    })
}

pub(crate) async fn resolve_agent_ui_form_with_services(
    base_services: AgentApplicationServices,
    session_key: &str,
    checkpoint: AgentCheckpoint,
    is_canonical: bool,
    form_id: String,
    body: &serde_json::Value,
    values: serde_json::Value,
    cancelled: bool,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    live_trace_sink: Option<Arc<dyn NativeAgentTraceSink>>,
) -> Result<serde_json::Value, AgentError> {
    let thread_store = base_services.thread_store.clone();
    let continuation_spec =
        native_agent_ui_form_continuation_spec(&checkpoint, body, &form_id, &values, cancelled);
    let mut input = AgentTurnInput::from_wire(&continuation_spec, &config_snapshot)
        .map_err(AgentError::invalid_input)?;
    input.messages = checkpoint.messages.clone();
    let trace = input.trace_context.clone();
    let instructions = InstructionLoader::new(thread_store.data_root().join("plugins"))
        .compose(&workspace_root, &continuation_spec)?;
    let graph_base_config_snapshot = config_snapshot.clone();
    let mut config_snapshot = config_snapshot;
    crate::workspace_extensions::merge_workspace_mcp_servers(
        &mut config_snapshot,
        &instructions.working_directory,
    )?;
    base_services.runtime.save_checkpoint(checkpoint);
    let services = base_services.prepare_turn(
        &workspace_root,
        &instructions.working_directory,
        graph_base_config_snapshot,
        live_trace_sink,
    );
    let turn_result = run_native_agent_turn_with_workspace_and_instructions_async(
        &services,
        input,
        config_snapshot.clone(),
        &workspace_root,
        instructions,
    )
    .await;
    let mut continuation = finish_native_agent_turn(
        turn_result,
        services.flush_trace_sink(),
        "native Agent UI form continuation",
    )?;
    persist_native_agent_turn_terminal_if_present(&trace, &mut continuation, &thread_store)?;
    persist_native_agent_checkpoint_if_present(&continuation, &thread_store)?;
    if !is_canonical {
        clear_native_session_checkpoint(
            session_key,
            &thread_store,
            "native Agent UI form checkpoint clear",
        )?;
    }
    let mut continuation = continuation.into_value()?;
    continuation["form_id"] = serde_json::Value::String(form_id.clone());
    continuation["source"] = serde_json::Value::String("rust".to_string());
    continuation["continuation"] = serde_json::json!({
        "mode": "resume",
        "delivered": true,
        "target": "agent_loop",
    });
    if cancelled {
        continuation["cancelled"] = serde_json::Value::Bool(true);
        continuation["event"] = native_agent_ui_form_event("ui.form.cancelled", &form_id, &values);
    } else {
        continuation["submitted"] = serde_json::Value::Bool(true);
        continuation["values"] = values.clone();
        continuation["event"] = native_agent_ui_form_event("ui.form.submitted", &form_id, &values);
    }
    Ok(continuation)
}

pub(crate) fn clear_native_session_checkpoint(
    session_key: &str,
    thread_store: &WorkspaceThreadStore,
    label: &str,
) -> Result<(), AgentError> {
    thread_store
        .clear_latest_agent_checkpoint(session_key)
        .map_err(|error| AgentError::persistence(label, error))
}

pub(crate) fn native_session_checkpoint(
    session_key: &str,
    thread_store: &WorkspaceThreadStore,
    label: &str,
) -> Result<Option<AgentCheckpoint>, AgentError> {
    thread_store
        .latest_agent_checkpoint(session_key)
        .map_err(|error| error.context(label))
}
