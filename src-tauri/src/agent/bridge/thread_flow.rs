use super::AgentApplicationServices;
use crate::agent::bridge::{
    native_agent_current_user_message, native_agent_model, native_agent_provider,
    native_agent_string_field, native_agent_turn_id,
};
use crate::agent::conversation_title::{should_generate_title, ConversationTitleTask};
use crate::agent::runtime::AgentError;
use crate::agent::runtime::{AgentHookInvocation, AgentHookStage, NativeAgentTraceSink};
use crate::agent::runtime::{AgentResultError, AgentStopReason, AgentTurnResult};
use crate::agent::runtime_protocol::AgentTraceContext;
use crate::threads::domain::{StartThreadTurnRequest, ThreadRecord, ThreadSnapshot};
use crate::threads::workspace_store::WorkspaceThreadStore;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use super::agent_flow::run_agent_with_services;
use super::turn_request::AgentTurnRequest;
use super::webui_continuation::{
    native_session_checkpoint, resolve_agent_ui_form_body_with_checkpoint,
};

pub(crate) struct SubmitThreadTurnInput {
    pub(crate) thread_id: Option<String>,
    pub(crate) input: serde_json::Value,
    pub(crate) spec: serde_json::Value,
}

pub(crate) struct ExecutedThreadTurn {
    pub(crate) thread_id: String,
    pub(crate) session_id: String,
    pub(crate) turn_id: String,
    pub(crate) result: AgentTurnResult,
}

pub(crate) struct SubmitThreadFormInput {
    pub(crate) command_id: String,
    pub(crate) thread_id: String,
    pub(crate) form_id: String,
    pub(crate) source: serde_json::Value,
    pub(crate) target: serde_json::Value,
    pub(crate) values: serde_json::Value,
    pub(crate) action: Option<String>,
}

pub(crate) struct CompactThreadInput {
    pub(crate) thread_id: String,
    pub(crate) client_event_id: Option<String>,
}

pub(crate) async fn compact_thread_with_services(
    base_services: AgentApplicationServices,
    input: CompactThreadInput,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    live_trace_sink: Option<Arc<dyn NativeAgentTraceSink>>,
) -> Result<serde_json::Value, AgentError> {
    let thread_store = base_services.thread_store.clone();
    let snapshot = read_thread_snapshot(
        &input.thread_id,
        &thread_store,
        "thread compaction target read",
    )?;
    if snapshot.active_turn.is_some() {
        return Err(
            "Cannot compact context while the thread has an active turn."
                .to_string()
                .into(),
        );
    }
    let thread = &snapshot.thread;
    let thread_id = thread.thread_id.clone();
    let turn_id = generate_thread_compaction_turn_id();
    let mut spec = serde_json::json!({
        "runtime": "rust",
        "sessionId": thread_id,
        "threadId": thread_id,
        "turnId": turn_id,
        "messages": [],
        "contextCompaction": {
            "trigger": "manual",
            "reason": "user_requested",
            "phase": "standalone_turn"
        },
        "metadata": {
            "threadId": thread_id,
            "workingDirectory": thread_working_directory(thread),
            "clientEventId": input.client_event_id,
        }
    });
    if let Some(model) = thread.metadata.model.as_ref() {
        spec["model"] = serde_json::Value::String(model.clone());
    }
    if let Some(provider) = native_agent_string_field(&thread.metadata.extra, "modelProvider") {
        spec["provider"] = serde_json::Value::String(provider);
    }
    let request = AgentTurnRequest::from_wire(spec, &config_snapshot, &workspace_root)?;
    let result = run_agent_with_services(
        base_services,
        request,
        workspace_root,
        config_snapshot,
        live_trace_sink,
    )
    .await?;
    if result.stop_reason != AgentStopReason::ContextCompacted {
        return Err(match result.error {
            Some(AgentResultError::Structured(error)) => error,
            Some(AgentResultError::Message(message)) => message.into(),
            None => "Context compaction failed.".into(),
        });
    }
    result
        .into_value()
        .map_err(crate::agent::runtime::AgentError::from)
}

pub(crate) async fn submit_thread_turn_with_services(
    base_services: AgentApplicationServices,
    input: SubmitThreadTurnInput,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    live_trace_sink: Option<Arc<dyn NativeAgentTraceSink>>,
) -> Result<serde_json::Value, AgentError> {
    let completed = execute_thread_turn_with_services(
        base_services,
        input,
        workspace_root,
        config_snapshot,
        live_trace_sink,
    )
    .await?;
    Ok(serde_json::json!({
        "threadId": completed.thread_id,
        "sessionId": completed.session_id,
        "turnId": completed.turn_id,
    }))
}

pub(crate) async fn execute_thread_turn_with_services(
    base_services: AgentApplicationServices,
    input: SubmitThreadTurnInput,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    live_trace_sink: Option<Arc<dyn NativeAgentTraceSink>>,
) -> Result<ExecutedThreadTurn, AgentError> {
    let thread_store = base_services.thread_store.clone();
    let thread =
        ensure_thread_turn_target(input.thread_id, &thread_store, config_snapshot.clone())?;
    let thread_id = thread.thread_id.clone();
    let thread_working_directory = thread_working_directory(&thread);
    let is_project_coordinator = thread.source == "project_coordinator";
    let coordinator_project_group_id = is_project_coordinator
        .then(|| thread_project_group_id(&thread))
        .flatten();
    let permission_profile = if is_project_coordinator {
        "project-coordinator"
    } else {
        "local-worker"
    };
    let session_id = thread_id.clone();
    let turn_id = native_agent_turn_id(&input.spec).unwrap_or_else(generate_thread_turn_id);
    let spec_has_working_directory = native_agent_string_field(&input.spec, "cwd")
        .or_else(|| native_agent_string_field(&input.spec, "workingDirectory"))
        .or_else(|| native_agent_string_field(&input.spec, "working_directory"))
        .or_else(|| {
            input
                .spec
                .get("metadata")
                .and_then(|metadata| native_agent_string_field(metadata, "cwd"))
        })
        .or_else(|| {
            input
                .spec
                .get("metadata")
                .and_then(|metadata| native_agent_string_field(metadata, "workingDirectory"))
        })
        .or_else(|| {
            input
                .spec
                .get("metadata")
                .and_then(|metadata| native_agent_string_field(metadata, "working_directory"))
        })
        .is_some();
    let mut spec = input.spec;
    let spec_object = spec
        .as_object_mut()
        .ok_or_else(|| "thread turn spec must be a JSON object".to_string())?;
    spec_object.insert(
        "runtime".to_string(),
        spec_object
            .get("runtime")
            .cloned()
            .unwrap_or_else(|| serde_json::Value::String("rust".to_string())),
    );
    spec_object.insert(
        "sessionId".to_string(),
        serde_json::Value::String(session_id.clone()),
    );
    spec_object.insert(
        "turnId".to_string(),
        serde_json::Value::String(turn_id.clone()),
    );
    bind_thread_turn_role(spec_object, &thread_id, permission_profile);
    if !spec_object.contains_key("messages") {
        spec_object.insert(
            "messages".to_string(),
            normalize_thread_turn_messages(input.input)?,
        );
    }
    validate_turn_messages(
        spec_object
            .get("messages")
            .ok_or_else(|| "thread turn spec must include messages".to_string())?,
    )?;
    let metadata = spec_object
        .entry("metadata".to_string())
        .or_insert_with(|| serde_json::json!({}));
    if let Some(metadata_object) = metadata.as_object_mut() {
        bind_thread_turn_role(metadata_object, &thread_id, permission_profile);
        if let Some(project_group_id) = coordinator_project_group_id {
            metadata_object.insert(
                "projectGroupId".to_string(),
                serde_json::Value::String(project_group_id),
            );
        }
        if !spec_has_working_directory {
            if let Some(working_directory) = thread_working_directory {
                metadata_object.insert(
                    "workingDirectory".to_string(),
                    serde_json::Value::String(working_directory),
                );
            }
        }
    }
    let request = AgentTurnRequest::from_wire(spec.clone(), &config_snapshot, &workspace_root)?;
    let trace_context = request.input.trace_context.clone();
    let title_task = should_generate_title(&thread.title, thread.metadata.turn_count)
        .then(|| native_agent_current_user_message(&spec))
        .flatten()
        .and_then(|message| {
            message
                .get("content")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|content| !content.is_empty())
                .map(|content| ConversationTitleTask {
                    thread_id: thread_id.clone(),
                    source_turn_id: turn_id.clone(),
                    input: content.to_string(),
                    model: native_agent_model(&spec, &config_snapshot),
                    provider: native_agent_provider(&spec, &config_snapshot),
                    turn_spec: spec.clone(),
                })
        });
    let thread_hook_services = base_services.clone();
    let thread_start_invocation =
        AgentHookInvocation::lifecycle(AgentHookStage::ThreadStart, trace_context.clone());
    let thread_start_evaluation = thread_hook_services
        .runtime
        .evaluate_hook_invocation(thread_start_invocation)?;
    if let Some(reason) = thread_start_evaluation.denied_reason.clone() {
        return Err(format!("thread start hook denied: {reason}").into());
    }

    start_native_agent_thread_turn(
        &thread_id,
        &turn_id,
        &spec,
        &trace_context,
        &thread_store,
        config_snapshot.clone(),
    )?;
    if let Some(title_task) = title_task {
        title_task.spawn(
            thread_store.clone(),
            config_snapshot.clone(),
            live_trace_sink.clone(),
        );
    }
    let result = run_agent_with_services(
        base_services,
        request,
        workspace_root,
        config_snapshot,
        live_trace_sink,
    )
    .await?;
    let thread_stop_invocation =
        AgentHookInvocation::lifecycle(AgentHookStage::ThreadStop, trace_context);
    thread_hook_services
        .runtime
        .evaluate_hook_invocation(thread_stop_invocation)?;
    Ok(ExecutedThreadTurn {
        thread_id,
        session_id,
        turn_id,
        result,
    })
}

fn bind_thread_turn_role(
    fields: &mut serde_json::Map<String, serde_json::Value>,
    thread_id: &str,
    permission_profile: &str,
) {
    fields.insert(
        "threadId".to_string(),
        serde_json::Value::String(thread_id.to_string()),
    );
    fields.insert(
        "permissionProfile".to_string(),
        serde_json::Value::String(permission_profile.to_string()),
    );
}

#[cfg(test)]
mod role_binding_tests {
    use super::bind_thread_turn_role;
    use serde_json::json;

    #[test]
    fn persisted_thread_identity_overrides_caller_role_fields() {
        let mut fields = json!({
            "threadId": "spoofed-coordinator",
            "permissionProfile": "project-coordinator"
        })
        .as_object()
        .expect("test fields should be an object")
        .clone();

        bind_thread_turn_role(&mut fields, "ordinary-thread", "local-worker");

        assert_eq!(fields["threadId"], "ordinary-thread");
        assert_eq!(fields["permissionProfile"], "local-worker");
    }
}

pub(crate) async fn submit_thread_form_with_services(
    base_services: AgentApplicationServices,
    input: SubmitThreadFormInput,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    live_trace_sink: Option<Arc<dyn NativeAgentTraceSink>>,
) -> Result<serde_json::Value, AgentError> {
    let command_id = input.command_id.trim();
    if command_id.is_empty() {
        return Err("thread form commandId must not be empty".to_string().into());
    }
    let thread_store = base_services.thread_store.clone();
    let target_snapshot =
        read_thread_snapshot(&input.thread_id, &thread_store, "thread form target read")?;
    let thread_id = target_snapshot.thread.thread_id.clone();
    let session_id = thread_id.clone();
    let thread_checkpoint = native_session_checkpoint(
        &session_id,
        &thread_store,
        "thread form Rollout checkpoint lookup",
    )?
    .ok_or_else(|| "thread form target has no Rollout checkpoint".to_string())?;
    let cancelled = thread_form_action_is_cancel(input.action.as_deref());
    let body = serde_json::json!({
        "commandId": command_id,
        "session_key": session_id.clone(),
        "source": input.source,
        "target": input.target,
        "thread_id": thread_id.clone(),
        "values": input.values,
        "action": input.action,
    });
    let (status_code, mut result) = resolve_agent_ui_form_body_with_checkpoint(
        base_services,
        input.form_id,
        &body,
        cancelled,
        Some(thread_checkpoint),
        workspace_root.clone(),
        config_snapshot.clone(),
        live_trace_sink,
    )
    .await?;
    result["statusCode"] = serde_json::Value::Number(status_code.into());
    let snapshot = read_thread_snapshot(&thread_id, &thread_store, "thread form snapshot")?;
    result["threadId"] = serde_json::Value::String(thread_id.clone());
    result["threadSnapshot"] =
        serde_json::to_value(&snapshot).expect("thread snapshot must serialize");
    Ok(serde_json::json!({
        "threadId": thread_id,
        "sessionId": session_id,
        "formResult": result,
        "snapshot": snapshot,
    }))
}

fn ensure_thread_turn_target(
    thread_id: Option<String>,
    thread_store: &WorkspaceThreadStore,
    config_snapshot: serde_json::Value,
) -> Result<ThreadRecord, AgentError> {
    match thread_id {
        Some(thread_id) if !thread_id.trim().is_empty() => {
            Ok(thread_store.read_agent_thread(&thread_id)?.thread)
        }
        _ => thread_store
            .create_agent_thread(generate_thread_turn_thread_id(), &config_snapshot)
            .map_err(AgentError::from),
    }
}

pub(crate) fn read_thread_snapshot(
    thread_id: &str,
    thread_store: &WorkspaceThreadStore,
    label: &str,
) -> Result<ThreadSnapshot, AgentError> {
    thread_store
        .read_agent_thread(thread_id)
        .map_err(|error| AgentError::persistence(label, error))
}

fn thread_working_directory(thread: &ThreadRecord) -> Option<String> {
    thread.metadata.working_directory.clone()
}

fn thread_project_group_id(thread: &ThreadRecord) -> Option<String> {
    native_agent_string_field(&thread.metadata.extra, "projectGroupId")
}

fn normalize_thread_turn_messages(
    input: serde_json::Value,
) -> Result<serde_json::Value, AgentError> {
    if input
        .as_array()
        .is_some_and(|messages| !messages.is_empty())
    {
        validate_turn_messages(&input)?;
        return Ok(input);
    }
    if input
        .get("messages")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|messages| !messages.is_empty())
    {
        let messages = input
            .get("messages")
            .cloned()
            .unwrap_or_else(|| serde_json::json!([]));
        validate_turn_messages(&messages)?;
        return Ok(messages);
    }
    let content = input
        .get("content")
        .or_else(|| input.get("text"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| {
            if input.is_string() {
                input.as_str().unwrap_or_default().to_string()
            } else {
                input.to_string()
            }
        });
    let mut message = if input.is_object() {
        input
    } else {
        serde_json::json!({})
    };
    let object = message
        .as_object_mut()
        .ok_or_else(|| "thread turn input must be a JSON object or string".to_string())?;
    object.insert(
        "role".to_string(),
        serde_json::Value::String("user".to_string()),
    );
    object.insert("content".to_string(), serde_json::Value::String(content));
    object.remove("text");
    let messages = serde_json::json!([message]);
    validate_turn_messages(&messages)?;
    Ok(messages)
}

fn validate_turn_messages(messages: &serde_json::Value) -> Result<(), AgentError> {
    if !messages.is_array() {
        return Err("thread turn messages must be a JSON array"
            .to_string()
            .into());
    }
    Ok(())
}

fn generate_thread_turn_id() -> String {
    format!("turn-thread-{}", now_unix_ms())
}

fn generate_thread_compaction_turn_id() -> String {
    format!("turn-compact-{}", now_unix_ms())
}

fn generate_thread_turn_thread_id() -> String {
    format!("thread-turn-{}", now_unix_ms())
}

fn now_unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn thread_form_action_is_cancel(action: Option<&str>) -> bool {
    matches!(action, Some("cancel" | "cancelled" | "dismiss"))
}

fn start_native_agent_thread_turn(
    thread_id: &str,
    turn_id: &str,
    spec: &serde_json::Value,
    trace_context: &AgentTraceContext,
    thread_store: &WorkspaceThreadStore,
    config_snapshot: serde_json::Value,
) -> Result<(), AgentError> {
    let mut input = native_agent_current_user_message(spec)
        .unwrap_or_else(|| serde_json::json!({ "role": "user", "content": "" }));
    let message_id = input
        .get("id")
        .or_else(|| input.get("messageId"))
        .cloned()
        .unwrap_or_else(|| serde_json::Value::String(format!("user:{turn_id}")));
    input["id"] = message_id.clone();
    input["messageId"] = message_id;
    thread_store
        .start_agent_thread_turn(StartThreadTurnRequest {
            thread_id: thread_id.into(),
            client_event_id: Some(format!("native-agent-thread-start:{turn_id}")),
            turn_id: Some(turn_id.into()),
            input,
            model: Some(native_agent_model(spec, &config_snapshot)),
            provider: native_agent_provider(spec, &config_snapshot),
            trace_context: Some(trace_context.clone()),
            ..Default::default()
        })
        .map(|_| ())
        .map_err(AgentError::from)
}
