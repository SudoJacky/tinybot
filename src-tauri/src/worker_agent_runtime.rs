use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeAgentRuntimeMode {
    Rust,
    TsCompatibility,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct NativeAgentEvent {
    #[serde(rename = "eventName")]
    pub event_name: String,
    pub payload: Value,
}

#[derive(Clone, Debug)]
pub struct NativeAgentRunContext {
    pub run_id: String,
    pub session_id: String,
    pub spec: Value,
    pub metadata: Value,
    pub stream: bool,
    pub max_iterations: i64,
}

#[derive(Clone, Debug)]
pub struct NativeAgentProviderResponse {
    pub final_content: String,
    pub reasoning_delta: Option<String>,
    pub usage: Option<Value>,
    pub tool_call: Option<NativeAgentToolCall>,
}

#[derive(Clone, Debug)]
pub struct NativeAgentToolCall {
    pub id: String,
    pub name: String,
    pub arguments_json: String,
    pub result: Value,
}

#[derive(Clone, Debug)]
pub struct NativeAgentToolResult {
    pub content: Value,
}

pub trait NativeAgentProvider: Send + Sync {
    fn complete(
        &self,
        context: &NativeAgentRunContext,
    ) -> Result<NativeAgentProviderResponse, String>;
}

pub trait NativeAgentToolDispatcher: Send + Sync {
    fn dispatch(
        &self,
        context: &NativeAgentRunContext,
        tool_call: &NativeAgentToolCall,
    ) -> Result<NativeAgentToolResult, String>;
}

pub trait NativeAgentCheckpointStore: Send + Sync {
    fn save(&self, session_id: &str, checkpoint: Value);
    fn restore(&self, session_id: &str) -> Option<Value>;
    fn clear(&self, session_id: &str);
}

pub trait NativeAgentCancellation: Send + Sync {
    fn cancel(&self, run_id: &str);
    fn is_cancelled(&self, run_id: &str) -> bool;
}

#[derive(Clone)]
pub struct NativeAgentRuntimeServices {
    provider: Arc<dyn NativeAgentProvider>,
    tools: Arc<dyn NativeAgentToolDispatcher>,
    checkpoints: Arc<dyn NativeAgentCheckpointStore>,
    cancellations: Arc<dyn NativeAgentCancellation>,
}

impl NativeAgentRuntimeServices {
    pub fn new(
        provider: Arc<dyn NativeAgentProvider>,
        tools: Arc<dyn NativeAgentToolDispatcher>,
        checkpoints: Arc<dyn NativeAgentCheckpointStore>,
        cancellations: Arc<dyn NativeAgentCancellation>,
    ) -> Self {
        Self {
            provider,
            tools,
            checkpoints,
            cancellations,
        }
    }

    pub fn cancel(&self, run_id: &str) -> Value {
        self.cancellations.cancel(run_id);
        serde_json::json!({
            "runtime": "rust",
            "runId": run_id,
            "cancelled": true,
            "events": [event_value("agent.cancelled", serde_json::json!({
                "runId": run_id,
                "cancelled": true,
            }))],
        })
    }

    pub fn restore_checkpoint(&self, session_id: &str) -> Value {
        serde_json::json!({
            "runtime": "rust",
            "sessionId": session_id,
            "checkpoint": self.checkpoints.restore(session_id),
        })
    }
}

impl Default for NativeAgentRuntimeServices {
    fn default() -> Self {
        Self::new(
            Arc::new(FakeNativeAgentProvider),
            Arc::new(FakeNativeAgentToolDispatcher),
            Arc::new(InMemoryNativeAgentCheckpointStore::default()),
            Arc::new(InMemoryNativeAgentCancellation::default()),
        )
    }
}

#[derive(Default)]
pub struct InMemoryNativeAgentCheckpointStore {
    checkpoints: Mutex<HashMap<String, Value>>,
}

impl NativeAgentCheckpointStore for InMemoryNativeAgentCheckpointStore {
    fn save(&self, session_id: &str, checkpoint: Value) {
        self.checkpoints
            .lock()
            .expect("checkpoint store lock should not be poisoned")
            .insert(session_id.to_string(), checkpoint);
    }

    fn restore(&self, session_id: &str) -> Option<Value> {
        self.checkpoints
            .lock()
            .expect("checkpoint store lock should not be poisoned")
            .get(session_id)
            .cloned()
    }

    fn clear(&self, session_id: &str) {
        self.checkpoints
            .lock()
            .expect("checkpoint store lock should not be poisoned")
            .remove(session_id);
    }
}

#[derive(Default)]
pub struct InMemoryNativeAgentCancellation {
    cancelled_runs: Mutex<HashSet<String>>,
}

impl NativeAgentCancellation for InMemoryNativeAgentCancellation {
    fn cancel(&self, run_id: &str) {
        self.cancelled_runs
            .lock()
            .expect("cancellation store lock should not be poisoned")
            .insert(run_id.to_string());
    }

    fn is_cancelled(&self, run_id: &str) -> bool {
        self.cancelled_runs
            .lock()
            .expect("cancellation store lock should not be poisoned")
            .contains(run_id)
    }
}

pub struct FakeNativeAgentProvider;

impl NativeAgentProvider for FakeNativeAgentProvider {
    fn complete(
        &self,
        context: &NativeAgentRunContext,
    ) -> Result<NativeAgentProviderResponse, String> {
        if let Some(error) = string_field(&context.metadata, "fakeProviderError") {
            return Err(error);
        }
        let final_content = string_field(&context.metadata, "fakeFinalContent")
            .or_else(|| string_field(&context.metadata, "finalContent"))
            .unwrap_or_else(|| format!("Echo: {}", last_user_content(&context.spec)));
        let tool_call = context
            .metadata
            .get("fakeToolCall")
            .and_then(Value::as_object)
            .map(|tool| NativeAgentToolCall {
                id: tool
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("tool-call-1")
                    .to_string(),
                name: tool
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("native_tool")
                    .to_string(),
                arguments_json: tool
                    .get("argumentsJson")
                    .or_else(|| tool.get("arguments_json"))
                    .and_then(Value::as_str)
                    .unwrap_or("{}")
                    .to_string(),
                result: tool
                    .get("result")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({ "ok": true })),
            });

        Ok(NativeAgentProviderResponse {
            final_content,
            reasoning_delta: string_field(&context.metadata, "fakeReasoningDelta"),
            usage: context.metadata.get("fakeUsage").cloned(),
            tool_call,
        })
    }
}

pub struct FakeNativeAgentToolDispatcher;

impl NativeAgentToolDispatcher for FakeNativeAgentToolDispatcher {
    fn dispatch(
        &self,
        _context: &NativeAgentRunContext,
        tool_call: &NativeAgentToolCall,
    ) -> Result<NativeAgentToolResult, String> {
        Ok(NativeAgentToolResult {
            content: tool_call.result.clone(),
        })
    }
}

pub fn resolve_native_agent_runtime_mode(
    spec: &Value,
    config_snapshot: &Value,
) -> NativeAgentRuntimeMode {
    let spec_runtime = string_field(spec, "runtime")
        .or_else(|| string_field(spec, "runtimeMode"))
        .or_else(|| string_field(spec, "runtime_mode"))
        .or_else(|| {
            spec.get("metadata")
                .and_then(|metadata| string_field(metadata, "runtime"))
        })
        .or_else(|| {
            spec.get("metadata")
                .and_then(|metadata| string_field(metadata, "nativeAgentRuntime"))
        });
    let config_runtime = config_snapshot
        .get("desktop")
        .and_then(|desktop| {
            string_field(desktop, "nativeAgentRuntime")
                .or_else(|| string_field(desktop, "native_agent_runtime"))
        })
        .or_else(|| {
            config_snapshot.get("agents").and_then(|agents| {
                string_field(agents, "nativeRuntime")
                    .or_else(|| string_field(agents, "native_runtime"))
            })
        });

    if matches!(
        spec_runtime.as_deref().or(config_runtime.as_deref()),
        Some("rust") | Some("native-rust")
    ) {
        NativeAgentRuntimeMode::Rust
    } else {
        NativeAgentRuntimeMode::TsCompatibility
    }
}

pub fn run_native_agent_turn(spec: Value) -> Result<Value, String> {
    let services = NativeAgentRuntimeServices::default();
    run_native_agent_turn_with_services(&services, spec)
}

pub fn run_native_agent_turn_with_services(
    services: &NativeAgentRuntimeServices,
    spec: Value,
) -> Result<Value, String> {
    let context = NativeAgentRunContext::from_spec(spec);
    if context.max_iterations <= 0 {
        return Ok(error_result(
            &context.run_id,
            &context.session_id,
            "max_iterations_exceeded",
            "Rust agent runtime reached max iterations before provider call.",
        ));
    }
    if services.cancellations.is_cancelled(&context.run_id)
        || bool_field(&context.metadata, "fakeCancel")
    {
        return Ok(cancelled_result(&context.run_id, &context.session_id));
    }
    if let Some(result) = maybe_awaiting_approval_result(services, &context) {
        return Ok(result);
    }
    if let Some(result) = maybe_approval_resume_result(services, &context) {
        return Ok(result);
    }
    if let Some(result) = maybe_awaiting_form_result(services, &context) {
        return Ok(result);
    }
    if let Some(result) = maybe_form_submit_result(services, &context) {
        return Ok(result);
    }

    let provider_response = match services.provider.complete(&context) {
        Ok(response) => response,
        Err(error) => {
            return Ok(error_result(
                &context.run_id,
                &context.session_id,
                "provider_error",
                &error,
            ));
        }
    };

    let mut events = Vec::new();
    maybe_emit_checkpoint(services, &context, &mut events, "running");
    if let Some(reasoning_delta) = provider_response.reasoning_delta {
        events.push(event(
            "agent.reasoning_delta",
            serde_json::json!({
                "runId": context.run_id,
                "sessionId": context.session_id,
                "delta": reasoning_delta,
            }),
        ));
    }
    if context.stream {
        events.push(event(
            "agent.delta",
            serde_json::json!({
                "runId": context.run_id,
                "sessionId": context.session_id,
                "delta": provider_response.final_content,
            }),
        ));
    }

    let mut tools_used = Vec::new();
    if let Some(tool_call) = provider_response.tool_call {
        tools_used.push(tool_call.name.clone());
        events.push(event(
            "agent.tool_call.delta",
            serde_json::json!({
                "runId": context.run_id,
                "sessionId": context.session_id,
                "toolCallId": tool_call.id,
                "toolName": tool_call.name,
                "name": tool_call.name,
                "argumentsDelta": tool_call.arguments_json,
            }),
        ));
        events.push(event(
            "agent.tool.start",
            serde_json::json!({
                "runId": context.run_id,
                "sessionId": context.session_id,
                "toolCallId": tool_call.id,
                "toolName": tool_call.name,
                "name": tool_call.name,
            }),
        ));
        let result = services.tools.dispatch(&context, &tool_call)?;
        events.push(event(
            "agent.tool.result",
            serde_json::json!({
                "runId": context.run_id,
                "sessionId": context.session_id,
                "toolCallId": tool_call.id,
                "toolName": tool_call.name,
                "name": tool_call.name,
                "content": result.content,
            }),
        ));
    }

    if let Some(usage) = provider_response.usage {
        events.push(event(
            "agent.usage",
            serde_json::json!({
                "runId": context.run_id,
                "sessionId": context.session_id,
                "usage": usage,
            }),
        ));
    }
    services.checkpoints.clear(&context.session_id);
    events.push(event(
        "agent.done",
        serde_json::json!({
            "runId": context.run_id,
            "sessionId": context.session_id,
            "stopReason": "final_response",
        }),
    ));

    Ok(serde_json::json!({
        "runtime": "rust",
        "runId": context.run_id,
        "sessionId": context.session_id,
        "finalContent": provider_response.final_content,
        "stopReason": "final_response",
        "messages": [{
            "role": "assistant",
            "content": provider_response.final_content
        }],
        "toolsUsed": tools_used,
        "events": events,
    }))
}

impl NativeAgentRunContext {
    fn from_spec(spec: Value) -> Self {
        let run_id = string_field(&spec, "runId")
            .or_else(|| string_field(&spec, "run_id"))
            .unwrap_or_else(|| "native-rust-run".to_string());
        let session_id = string_field(&spec, "sessionId")
            .or_else(|| string_field(&spec, "session_id"))
            .unwrap_or_else(|| "native-rust-session".to_string());
        let metadata = spec
            .get("metadata")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        let max_iterations = spec
            .get("maxIterations")
            .or_else(|| spec.get("max_iterations"))
            .and_then(Value::as_i64)
            .unwrap_or(1);
        let stream = spec.get("stream").and_then(Value::as_bool).unwrap_or(false);
        Self {
            run_id,
            session_id,
            spec,
            metadata,
            stream,
            max_iterations,
        }
    }
}

fn maybe_awaiting_approval_result(
    services: &NativeAgentRuntimeServices,
    context: &NativeAgentRunContext,
) -> Option<Value> {
    let approval = context.metadata.get("fakeAwaitingApproval")?.clone();
    let approval_id = string_field(&approval, "approvalId")
        .or_else(|| string_field(&approval, "approval_id"))
        .unwrap_or_else(|| "approval-1".to_string());
    let tool_name = string_field(&approval, "toolName")
        .or_else(|| string_field(&approval, "tool_name"))
        .unwrap_or_else(|| "approval".to_string());
    let checkpoint = checkpoint_value(
        context,
        "awaiting_approval",
        serde_json::json!({
            "approval_id": approval_id,
            "operation": approval,
        }),
    );
    services
        .checkpoints
        .save(&context.session_id, checkpoint.clone());
    let events = vec![
        event(
            "agent.checkpoint",
            serde_json::json!({
                "runId": context.run_id,
                "sessionId": context.session_id,
                "phase": "awaiting_approval",
                "checkpoint": checkpoint,
            }),
        ),
        event(
            "agent.awaiting_approval",
            serde_json::json!({
                "runId": context.run_id,
                "sessionId": context.session_id,
                "approvalId": approval_id,
                "toolName": tool_name,
                "operation": approval,
                "content": format!("Approval required: {tool_name}"),
            }),
        ),
        event(
            "agent.done",
            serde_json::json!({
                "runId": context.run_id,
                "sessionId": context.session_id,
                "stopReason": "awaiting_approval",
            }),
        ),
    ];
    Some(serde_json::json!({
        "runtime": "rust",
        "runId": context.run_id,
        "sessionId": context.session_id,
        "finalContent": "",
        "stopReason": "awaiting_approval",
        "messages": [],
        "toolsUsed": [],
        "checkpoint": checkpoint,
        "events": events,
    }))
}

fn maybe_approval_resume_result(
    services: &NativeAgentRuntimeServices,
    context: &NativeAgentRunContext,
) -> Option<Value> {
    let approval = context.metadata.get("fakeApprovalResume")?.clone();
    let approved = approval
        .get("approved")
        .and_then(Value::as_bool)
        .unwrap_or_else(|| string_field(&approval, "decision").as_deref() == Some("approved"));
    let checkpoint = services.checkpoints.restore(&context.session_id);
    if !approved {
        services.checkpoints.clear(&context.session_id);
        return Some(error_result(
            &context.run_id,
            &context.session_id,
            "approval_denied",
            "Rust agent approval was denied.",
        ));
    }
    services.checkpoints.clear(&context.session_id);
    let final_content = string_field(&approval, "finalContent")
        .or_else(|| string_field(&approval, "final_content"))
        .unwrap_or_else(|| "Approved tool completed.".to_string());
    let events = vec![
        event(
            "agent.tool.result",
            serde_json::json!({
                "runId": context.run_id,
                "sessionId": context.session_id,
                "toolCallId": string_field(&approval, "toolCallId").unwrap_or_else(|| "approval-1".to_string()),
                "toolName": string_field(&approval, "toolName").unwrap_or_else(|| "approval".to_string()),
                "content": string_field(&approval, "toolResult").unwrap_or_else(|| "approved".to_string()),
            }),
        ),
        event(
            "agent.delta",
            serde_json::json!({
                "runId": context.run_id,
                "sessionId": context.session_id,
                "delta": final_content,
            }),
        ),
        event(
            "agent.done",
            serde_json::json!({
                "runId": context.run_id,
                "sessionId": context.session_id,
                "stopReason": "final_response",
            }),
        ),
    ];
    Some(serde_json::json!({
        "runtime": "rust",
        "runId": context.run_id,
        "sessionId": context.session_id,
        "finalContent": final_content,
        "stopReason": "final_response",
        "messages": [{ "role": "assistant", "content": final_content }],
        "toolsUsed": [],
        "restoredCheckpoint": checkpoint,
        "events": events,
    }))
}

fn maybe_awaiting_form_result(
    services: &NativeAgentRuntimeServices,
    context: &NativeAgentRunContext,
) -> Option<Value> {
    let form = context.metadata.get("fakeAwaitingForm")?.clone();
    let form_id = string_field(&form, "formId")
        .or_else(|| string_field(&form, "form_id"))
        .unwrap_or_else(|| "form-1".to_string());
    let checkpoint = checkpoint_value(
        context,
        "awaiting_form",
        serde_json::json!({
            "form_id": form_id,
            "form": form,
        }),
    );
    services
        .checkpoints
        .save(&context.session_id, checkpoint.clone());
    let events = vec![
        event(
            "agent.checkpoint",
            serde_json::json!({
                "runId": context.run_id,
                "sessionId": context.session_id,
                "phase": "awaiting_form",
                "checkpoint": checkpoint,
            }),
        ),
        event(
            "agent.awaiting_form",
            serde_json::json!({
                "runId": context.run_id,
                "sessionId": context.session_id,
                "formId": form_id,
                "form": form,
            }),
        ),
        event(
            "agent.done",
            serde_json::json!({
                "runId": context.run_id,
                "sessionId": context.session_id,
                "stopReason": "awaiting_form",
            }),
        ),
    ];
    Some(serde_json::json!({
        "runtime": "rust",
        "runId": context.run_id,
        "sessionId": context.session_id,
        "finalContent": "",
        "stopReason": "awaiting_form",
        "messages": [],
        "toolsUsed": [],
        "checkpoint": checkpoint,
        "events": events,
    }))
}

fn maybe_form_submit_result(
    services: &NativeAgentRuntimeServices,
    context: &NativeAgentRunContext,
) -> Option<Value> {
    let form = context.metadata.get("fakeFormSubmit")?.clone();
    if bool_field(&form, "cancelled") {
        services.checkpoints.clear(&context.session_id);
        return Some(error_result(
            &context.run_id,
            &context.session_id,
            "form_cancelled",
            "Rust agent form was cancelled.",
        ));
    }
    let checkpoint = services.checkpoints.restore(&context.session_id);
    services.checkpoints.clear(&context.session_id);
    let final_content = string_field(&form, "finalContent")
        .or_else(|| string_field(&form, "final_content"))
        .unwrap_or_else(|| "Form submitted.".to_string());
    let events = vec![
        event(
            "agent.delta",
            serde_json::json!({
                "runId": context.run_id,
                "sessionId": context.session_id,
                "delta": final_content,
            }),
        ),
        event(
            "agent.done",
            serde_json::json!({
                "runId": context.run_id,
                "sessionId": context.session_id,
                "stopReason": "final_response",
            }),
        ),
    ];
    Some(serde_json::json!({
        "runtime": "rust",
        "runId": context.run_id,
        "sessionId": context.session_id,
        "finalContent": final_content,
        "stopReason": "final_response",
        "messages": [{ "role": "assistant", "content": final_content }],
        "toolsUsed": [],
        "restoredCheckpoint": checkpoint,
        "events": events,
    }))
}

fn maybe_emit_checkpoint(
    services: &NativeAgentRuntimeServices,
    context: &NativeAgentRunContext,
    events: &mut Vec<NativeAgentEvent>,
    default_phase: &str,
) {
    let Some(checkpoint_metadata) = context.metadata.get("fakeCheckpoint") else {
        return;
    };
    let phase =
        string_field(checkpoint_metadata, "phase").unwrap_or_else(|| default_phase.to_string());
    let checkpoint = checkpoint_value(context, &phase, checkpoint_metadata.clone());
    services
        .checkpoints
        .save(&context.session_id, checkpoint.clone());
    events.push(event(
        "agent.checkpoint",
        serde_json::json!({
            "runId": context.run_id,
            "sessionId": context.session_id,
            "phase": phase,
            "checkpoint": checkpoint,
        }),
    ));
}

fn checkpoint_value(context: &NativeAgentRunContext, phase: &str, payload: Value) -> Value {
    serde_json::json!({
        "runtime": "rust",
        "runId": context.run_id,
        "sessionId": context.session_id,
        "phase": phase,
        "payload": payload,
        "messages": context.spec.get("messages").cloned().unwrap_or_else(|| serde_json::json!([])),
    })
}

fn error_result(run_id: &str, session_id: &str, stop_reason: &str, message: &str) -> Value {
    let events = vec![event(
        "agent.error",
        serde_json::json!({
            "runId": run_id,
            "sessionId": session_id,
            "message": message,
        }),
    )];
    serde_json::json!({
        "runtime": "rust",
        "runId": run_id,
        "sessionId": session_id,
        "finalContent": "",
        "stopReason": stop_reason,
        "messages": [],
        "toolsUsed": [],
        "error": message,
        "events": events,
    })
}

fn cancelled_result(run_id: &str, session_id: &str) -> Value {
    let events = vec![event(
        "agent.cancelled",
        serde_json::json!({
            "runId": run_id,
            "sessionId": session_id,
            "cancelled": true,
        }),
    )];
    serde_json::json!({
        "runtime": "rust",
        "runId": run_id,
        "sessionId": session_id,
        "finalContent": "",
        "stopReason": "cancelled",
        "messages": [],
        "toolsUsed": [],
        "events": events,
    })
}

fn event(event_name: &str, payload: Value) -> NativeAgentEvent {
    NativeAgentEvent {
        event_name: event_name.to_string(),
        payload,
    }
}

fn event_value(event_name: &str, payload: Value) -> Value {
    serde_json::json!({
        "eventName": event_name,
        "payload": payload,
    })
}

fn last_user_content(spec: &Value) -> String {
    spec.get("messages")
        .and_then(Value::as_array)
        .and_then(|messages| {
            messages.iter().rev().find_map(|message| {
                if message.get("role").and_then(Value::as_str) == Some("user") {
                    message
                        .get("content")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                } else {
                    None
                }
            })
        })
        .unwrap_or_default()
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn bool_field(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn selects_rust_runtime_from_spec_or_config() {
        assert_eq!(
            resolve_native_agent_runtime_mode(&json!({ "runtime": "rust" }), &json!({})),
            NativeAgentRuntimeMode::Rust
        );
        assert_eq!(
            resolve_native_agent_runtime_mode(
                &json!({}),
                &json!({ "desktop": { "nativeAgentRuntime": "rust" } })
            ),
            NativeAgentRuntimeMode::Rust
        );
        assert_eq!(
            resolve_native_agent_runtime_mode(&json!({}), &json!({})),
            NativeAgentRuntimeMode::TsCompatibility
        );
    }

    #[test]
    fn runs_fake_streaming_final_answer_with_frontend_events() {
        let result = run_native_agent_turn(json!({
            "runtime": "rust",
            "runId": "run-1",
            "sessionId": "websocket:chat-1",
            "stream": true,
            "messages": [{ "role": "user", "content": "hello" }]
        }))
        .expect("fake provider run should succeed");

        assert_eq!(result["runtime"], "rust");
        assert_eq!(result["finalContent"], "Echo: hello");
        assert_eq!(result["events"][0]["eventName"], "agent.delta");
        assert_eq!(result["events"][1]["eventName"], "agent.done");
    }

    #[test]
    fn runs_fake_tool_event_sequence() {
        let result = run_native_agent_turn(json!({
            "runtime": "rust",
            "runId": "run-tool",
            "sessionId": "websocket:chat-1",
            "metadata": {
                "fakeFinalContent": "tool complete",
                "fakeToolCall": {
                    "id": "call-1",
                    "name": "workspace.read_file",
                    "argumentsJson": "{\"path\":\"README.md\"}",
                    "result": { "content": "README" }
                }
            }
        }))
        .expect("fake tool run should succeed");

        let event_names = event_names(&result);
        assert_eq!(
            event_names,
            vec![
                "agent.tool_call.delta",
                "agent.tool.start",
                "agent.tool.result",
                "agent.done"
            ]
        );
        assert_eq!(result["toolsUsed"][0], "workspace.read_file");
    }

    #[test]
    fn reports_fake_provider_and_iteration_errors_as_frontend_events() {
        let provider_error = run_native_agent_turn(json!({
            "runtime": "rust",
            "runId": "run-error",
            "sessionId": "websocket:chat-1",
            "metadata": { "fakeProviderError": "provider unavailable" }
        }))
        .expect("provider error should return compatibility result");
        let iteration_error = run_native_agent_turn(json!({
            "runtime": "rust",
            "runId": "run-iteration",
            "sessionId": "websocket:chat-1",
            "maxIterations": 0
        }))
        .expect("iteration error should return compatibility result");

        assert_eq!(provider_error["stopReason"], "provider_error");
        assert_eq!(provider_error["events"][0]["eventName"], "agent.error");
        assert_eq!(iteration_error["stopReason"], "max_iterations_exceeded");
        assert_eq!(iteration_error["events"][0]["eventName"], "agent.error");
    }

    #[test]
    fn saves_and_restores_approval_checkpoint_before_resume() {
        let services = NativeAgentRuntimeServices::default();
        let awaiting = run_native_agent_turn_with_services(
            &services,
            json!({
                "runtime": "rust",
                "runId": "run-approval",
                "sessionId": "websocket:chat-approval",
                "metadata": {
                    "fakeAwaitingApproval": {
                        "approvalId": "approval-1",
                        "toolName": "workspace.write_file"
                    }
                }
            }),
        )
        .expect("approval checkpoint should be created");

        assert_eq!(awaiting["stopReason"], "awaiting_approval");
        assert_eq!(
            services.restore_checkpoint("websocket:chat-approval")["checkpoint"]["phase"],
            "awaiting_approval"
        );

        let resumed = run_native_agent_turn_with_services(
            &services,
            json!({
                "runtime": "rust",
                "runId": "run-approval",
                "sessionId": "websocket:chat-approval",
                "metadata": {
                    "fakeApprovalResume": {
                        "approved": true,
                        "finalContent": "Approved write completed."
                    }
                }
            }),
        )
        .expect("approval resume should complete");

        assert_eq!(resumed["stopReason"], "final_response");
        assert_eq!(resumed["restoredCheckpoint"]["phase"], "awaiting_approval");
        assert!(services.restore_checkpoint("websocket:chat-approval")["checkpoint"].is_null());
    }

    #[test]
    fn handles_approval_denial_form_submit_and_cancel_events() {
        let services = NativeAgentRuntimeServices::default();
        let denied = run_native_agent_turn_with_services(
            &services,
            json!({
                "runtime": "rust",
                "runId": "run-denied",
                "sessionId": "websocket:chat-denied",
                "metadata": { "fakeApprovalResume": { "approved": false } }
            }),
        )
        .expect("approval denial should return error compatibility result");
        let awaiting_form = run_native_agent_turn_with_services(
            &services,
            json!({
                "runtime": "rust",
                "runId": "run-form",
                "sessionId": "websocket:chat-form",
                "metadata": {
                    "fakeAwaitingForm": {
                        "formId": "form-1",
                        "title": "Configure run"
                    }
                }
            }),
        )
        .expect("form checkpoint should be created");
        let submitted = run_native_agent_turn_with_services(
            &services,
            json!({
                "runtime": "rust",
                "runId": "run-form",
                "sessionId": "websocket:chat-form",
                "metadata": {
                    "fakeFormSubmit": {
                        "finalContent": "Form values accepted."
                    }
                }
            }),
        )
        .expect("form submit should complete");
        let cancelled = services.cancel("run-cancel");
        let cancel_result = run_native_agent_turn_with_services(
            &services,
            json!({
                "runtime": "rust",
                "runId": "run-cancel",
                "sessionId": "websocket:chat-cancel"
            }),
        )
        .expect("cancelled run should return cancellation result");

        assert_eq!(denied["stopReason"], "approval_denied");
        assert_eq!(
            awaiting_form["events"][1]["eventName"],
            "agent.awaiting_form"
        );
        assert_eq!(submitted["finalContent"], "Form values accepted.");
        assert_eq!(cancelled["events"][0]["eventName"], "agent.cancelled");
        assert_eq!(cancel_result["stopReason"], "cancelled");
    }

    fn event_names(result: &Value) -> Vec<&str> {
        result["events"]
            .as_array()
            .expect("events should be an array")
            .iter()
            .map(|event| event["eventName"].as_str().unwrap_or_default())
            .collect::<Vec<_>>()
    }
}
