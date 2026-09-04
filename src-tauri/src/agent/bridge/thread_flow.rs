use crate::agent::bridge::{
    native_agent_current_user_message, native_agent_model, native_agent_provider,
    native_agent_string_field, native_agent_turn_id,
};
use crate::agent::conversation_title::{should_generate_title, ConversationTitleTask};
use crate::agent::runtime::{
    ensure_agent_trace_context, AgentHookInvocation, AgentHookStage, NativeAgentRuntimeServices,
    NativeAgentTraceSink,
};
use crate::agent::runtime_protocol::AgentTraceContext;
use crate::protocol::request_id::next_worker_request_correlation;
use crate::protocol::WorkerRequest;
use crate::rpc::call_rust_state_service;
use crate::threads::workspace_store::WorkspaceThreadStore;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use super::agent_flow::run_agent_with_services;
use super::webui_continuation::{
    native_session_checkpoint, resolve_agent_ui_form_body_with_services,
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
    pub(crate) result: serde_json::Value,
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
    base_services: NativeAgentRuntimeServices,
    input: CompactThreadInput,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    live_trace_sink: Option<Arc<dyn NativeAgentTraceSink>>,
) -> Result<serde_json::Value, String> {
    let thread_store = base_services.thread_store()?;
    let snapshot = read_thread_snapshot(
        &input.thread_id,
        &thread_store,
        config_snapshot.clone(),
        "thread compaction target read",
    )?;
    if snapshot
        .get("activeTurn")
        .or_else(|| snapshot.get("active_turn"))
        .is_some_and(|turn| !turn.is_null())
    {
        return Err("Cannot compact context while the thread has an active turn.".to_string());
    }
    let thread = snapshot
        .get("thread")
        .ok_or_else(|| "thread compaction target read returned no thread".to_string())?;
    let thread_id = thread_thread_id(thread)?;
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
    if let Some(model) = native_agent_string_field(thread, "model") {
        spec["model"] = serde_json::Value::String(model);
    }
    if let Some(provider) = native_agent_string_field(thread, "modelProvider")
        .or_else(|| native_agent_string_field(thread, "model_provider"))
        .or_else(|| native_agent_string_field(thread, "provider"))
    {
        spec["provider"] = serde_json::Value::String(provider);
    }
    let result = run_agent_with_services(
        base_services,
        spec,
        workspace_root,
        config_snapshot,
        live_trace_sink,
    )
    .await?;
    if result.get("stopReason").and_then(serde_json::Value::as_str) != Some("context_compacted") {
        return Err(result
            .get("error")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("Context compaction failed.")
            .to_string());
    }
    Ok(result)
}

pub(crate) async fn submit_thread_turn_with_services(
    base_services: NativeAgentRuntimeServices,
    input: SubmitThreadTurnInput,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    live_trace_sink: Option<Arc<dyn NativeAgentTraceSink>>,
) -> Result<serde_json::Value, String> {
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
    base_services: NativeAgentRuntimeServices,
    input: SubmitThreadTurnInput,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    live_trace_sink: Option<Arc<dyn NativeAgentTraceSink>>,
) -> Result<ExecutedThreadTurn, String> {
    let thread_store = base_services.thread_store()?;
    let thread =
        ensure_thread_turn_target(input.thread_id, &thread_store, config_snapshot.clone())?;
    let thread_id = thread_thread_id(&thread)?;
    let thread_working_directory = thread_working_directory(&thread);
    let is_project_coordinator =
        thread.get("source").and_then(serde_json::Value::as_str) == Some("project_coordinator");
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
    let mut spec = if input.spec.is_object() {
        input.spec
    } else {
        serde_json::json!({})
    };
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
    let trace_context = ensure_agent_trace_context(&mut spec)?;
    let title_task = should_generate_title(&thread)
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
                })
        });
    let thread_hook_services = base_services.clone();
    let thread_start_invocation =
        AgentHookInvocation::lifecycle(AgentHookStage::ThreadStart, trace_context.clone());
    let thread_start_evaluation =
        thread_hook_services.evaluate_hook_invocation(thread_start_invocation)?;
    if let Some(reason) = thread_start_evaluation.denied_reason.clone() {
        return Err(format!("thread start hook denied: {reason}"));
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
        spec,
        workspace_root,
        config_snapshot,
        live_trace_sink,
    )
    .await?;
    let thread_stop_invocation =
        AgentHookInvocation::lifecycle(AgentHookStage::ThreadStop, trace_context);
    thread_hook_services.evaluate_hook_invocation(thread_stop_invocation)?;
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
    base_services: NativeAgentRuntimeServices,
    input: SubmitThreadFormInput,
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    live_trace_sink: Option<Arc<dyn NativeAgentTraceSink>>,
) -> Result<serde_json::Value, String> {
    let command_id = input.command_id.trim();
    if command_id.is_empty() {
        return Err("thread form commandId must not be empty".to_string());
    }
    let thread_store = base_services.thread_store()?;
    let target_snapshot = read_thread_snapshot(
        &input.thread_id,
        &thread_store,
        config_snapshot.clone(),
        "thread form target read",
    )?;
    let thread = target_snapshot
        .get("thread")
        .cloned()
        .ok_or_else(|| "thread form target read returned no thread".to_string())?;
    let thread_id = thread_thread_id(&thread)?;
    let session_id = thread_id.clone();
    let thread_checkpoint = native_session_checkpoint(
        &session_id,
        &thread_store,
        config_snapshot.clone(),
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
        "threadCheckpoint": thread_checkpoint,
    });
    let (status_code, mut result) = resolve_agent_ui_form_body_with_services(
        base_services,
        input.form_id,
        &body,
        cancelled,
        workspace_root.clone(),
        config_snapshot.clone(),
        live_trace_sink,
    )
    .await?;
    result["statusCode"] = serde_json::Value::Number(status_code.into());
    let snapshot = read_thread_snapshot(
        &thread_id,
        &thread_store,
        config_snapshot,
        "thread form snapshot",
    )?;
    result["threadId"] = serde_json::Value::String(thread_id.clone());
    result["threadSnapshot"] = snapshot.clone();
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
) -> Result<serde_json::Value, String> {
    match thread_id {
        Some(thread_id) if !thread_id.trim().is_empty() => {
            let snapshot = read_thread_snapshot(
                &thread_id,
                thread_store,
                config_snapshot,
                "thread turn target read",
            )?;
            snapshot
                .get("thread")
                .cloned()
                .ok_or_else(|| "thread turn target read returned no thread".to_string())
        }
        _ => {
            let generated_thread_id = generate_thread_turn_thread_id();
            let request_id = next_worker_request_correlation();
            call_rust_state_service(
                thread_store,
                config_snapshot,
                WorkerRequest::new(
                    request_id.id("thread-turn-create"),
                    request_id.trace_id("thread-turn-create"),
                    "thread.create",
                    serde_json::json!({
                        "threadId": generated_thread_id,
                    }),
                ),
                "thread turn target create",
            )
        }
    }
}

pub(crate) fn read_thread_snapshot(
    thread_id: &str,
    thread_store: &WorkspaceThreadStore,
    config_snapshot: serde_json::Value,
    label: &str,
) -> Result<serde_json::Value, String> {
    let request_id = next_worker_request_correlation();
    call_rust_state_service(
        thread_store,
        config_snapshot,
        WorkerRequest::new(
            request_id.id("thread-turn-read"),
            request_id.trace_id("thread-turn-read"),
            "thread.read",
            serde_json::json!({ "threadId": thread_id }),
        ),
        label,
    )
}

pub(crate) fn thread_thread_id(thread: &serde_json::Value) -> Result<String, String> {
    thread
        .get("threadId")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| "thread target is missing threadId".to_string())
}

fn thread_working_directory(thread: &serde_json::Value) -> Option<String> {
    thread
        .get("metadata")
        .and_then(|metadata| {
            native_agent_string_field(metadata, "workingDirectory")
                .or_else(|| native_agent_string_field(metadata, "working_directory"))
                .or_else(|| native_agent_string_field(metadata, "cwd"))
        })
        .or_else(|| native_agent_string_field(thread, "workingDirectory"))
        .or_else(|| native_agent_string_field(thread, "working_directory"))
        .or_else(|| native_agent_string_field(thread, "cwd"))
}

fn thread_project_group_id(thread: &serde_json::Value) -> Option<String> {
    thread
        .get("metadata")
        .and_then(|metadata| metadata.get("extra"))
        .and_then(|extra| native_agent_string_field(extra, "projectGroupId"))
}

fn normalize_thread_turn_messages(input: serde_json::Value) -> Result<serde_json::Value, String> {
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

fn validate_turn_messages(messages: &serde_json::Value) -> Result<(), String> {
    if !messages.is_array() {
        return Err("thread turn messages must be a JSON array".to_string());
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
) -> Result<serde_json::Value, String> {
    let mut input = native_agent_current_user_message(spec)
        .unwrap_or_else(|| serde_json::json!({ "role": "user", "content": "" }));
    let message_id = input
        .get("id")
        .or_else(|| input.get("messageId"))
        .cloned()
        .unwrap_or_else(|| serde_json::Value::String(format!("user:{turn_id}")));
    input["id"] = message_id.clone();
    input["messageId"] = message_id;
    call_rust_state_service(
        thread_store,
        config_snapshot.clone(),
        WorkerRequest::new(
            format!("{}:thread-start", trace_context.request_id),
            trace_context.trace_id.clone(),
            "thread.start_turn",
            serde_json::json!({
                "threadId": thread_id,
                "clientEventId": format!("native-agent-thread-start:{turn_id}"),
                "turnId": turn_id,
                "input": input,
                "model": native_agent_model(spec, &config_snapshot),
                "provider": native_agent_provider(spec, &config_snapshot),
                "traceContext": trace_context,
            }),
        ),
        "native agent thread turn start",
    )
}
