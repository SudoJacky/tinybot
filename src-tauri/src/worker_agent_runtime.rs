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
    pub config_snapshot: Value,
    pub metadata: Value,
    pub model: String,
    pub provider: Option<String>,
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
            "finalContent": "",
            "stopReason": "cancelled",
            "error": "cancelled",
            "messages": [],
            "toolsUsed": [],
            "events": [event_value("agent.cancelled", serde_json::json!({
                "runId": run_id,
                "cancelled": true,
                "stopReason": "cancelled",
                "error": "cancelled",
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

    pub fn save_checkpoint(&self, session_id: &str, checkpoint: Value) {
        self.checkpoints.save(session_id, checkpoint);
    }
}

impl Default for NativeAgentRuntimeServices {
    fn default() -> Self {
        Self::new(
            Arc::new(RustNativeAgentProvider),
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

pub struct RustNativeAgentProvider;

impl NativeAgentProvider for RustNativeAgentProvider {
    fn complete(
        &self,
        context: &NativeAgentRunContext,
    ) -> Result<NativeAgentProviderResponse, String> {
        let request = agent_chat_completion_request(context)?;
        let provider_config = agent_provider_config(context);
        let completion =
            crate::native_provider_runtime::complete_chat_for_agent(&provider_config, &request)?;

        Ok(NativeAgentProviderResponse {
            final_content: chat_completion_content(&completion),
            reasoning_delta: chat_completion_reasoning_delta(&completion),
            usage: completion.get("usage").cloned(),
            tool_call: chat_completion_tool_call(&completion)
                .or_else(|| fixture_agent_tool_call(&context.config_snapshot)),
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
        if !native_tool_is_permitted(&tool_call.name) {
            return Err(format!(
                "native tool `{}` is not permitted by Rust capability policy",
                tool_call.name
            ));
        }
        let _: Value = serde_json::from_str(&tool_call.arguments_json).map_err(|error| {
            format!(
                "native tool `{}` arguments are invalid JSON: {error}",
                tool_call.name
            )
        })?;
        Ok(NativeAgentToolResult {
            content: tool_call.result.clone(),
        })
    }
}

fn native_tool_is_permitted(name: &str) -> bool {
    matches!(
        name,
        "workspace.read_file" | "workspace.list_files" | "knowledge.search" | "mcp.call_tool"
    )
}

fn agent_chat_completion_request(context: &NativeAgentRunContext) -> Result<Value, String> {
    let messages = agent_chat_messages(context)?;
    let mut request = serde_json::json!({
        "model": context.model.clone(),
        "messages": messages,
        "stream": false,
    });
    if let Some(max_tokens) = context
        .spec
        .get("maxCompletionTokens")
        .or_else(|| context.spec.get("max_completion_tokens"))
        .or_else(|| context.spec.get("max_tokens"))
        .cloned()
    {
        request["max_completion_tokens"] = max_tokens;
    }
    Ok(request)
}

fn agent_provider_config(context: &NativeAgentRunContext) -> Value {
    let mut config = context.config_snapshot.clone();
    set_agent_default(&mut config, "model", Value::String(context.model.clone()));
    if let Some(provider) = context.provider.as_deref() {
        set_agent_default(&mut config, "provider", Value::String(provider.to_string()));
    }
    config
}

fn set_agent_default(config: &mut Value, key: &str, value: Value) {
    if !config.is_object() {
        *config = serde_json::json!({});
    }
    let config_object = config
        .as_object_mut()
        .expect("config should be an object after normalization");
    let agents = config_object
        .entry("agents".to_string())
        .or_insert_with(|| serde_json::json!({}));
    if !agents.is_object() {
        *agents = serde_json::json!({});
    }
    let agents_object = agents
        .as_object_mut()
        .expect("agents should be an object after normalization");
    let defaults = agents_object
        .entry("defaults".to_string())
        .or_insert_with(|| serde_json::json!({}));
    if !defaults.is_object() {
        *defaults = serde_json::json!({});
    }
    defaults
        .as_object_mut()
        .expect("defaults should be an object after normalization")
        .insert(key.to_string(), value);
}

fn agent_chat_messages(context: &NativeAgentRunContext) -> Result<Value, String> {
    if let Some(messages) = context.spec.get("messages").and_then(Value::as_array) {
        if !messages.is_empty() {
            return Ok(Value::Array(messages.clone()));
        }
    }
    if let Some(input) = context.spec.get("input").and_then(Value::as_object) {
        let role = input
            .get("role")
            .and_then(Value::as_str)
            .filter(|role| !role.trim().is_empty())
            .unwrap_or("user");
        let content = input
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !content.trim().is_empty() {
            return Ok(serde_json::json!([{ "role": role, "content": content }]));
        }
    }
    Err("agent run requires at least one chat message".to_string())
}

fn chat_completion_content(completion: &Value) -> String {
    completion
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn chat_completion_reasoning_delta(completion: &Value) -> Option<String> {
    completion
        .pointer("/choices/0/message/reasoning_content")
        .or_else(|| completion.pointer("/choices/0/message/reasoningContent"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn chat_completion_tool_call(completion: &Value) -> Option<NativeAgentToolCall> {
    let tool = completion
        .pointer("/choices/0/message/tool_calls")
        .and_then(Value::as_array)
        .and_then(|tools| tools.first())?;
    let function = tool.get("function")?;
    let name = string_field(function, "name")?;
    Some(NativeAgentToolCall {
        id: string_field(tool, "id").unwrap_or_else(|| "tool-call-1".to_string()),
        name,
        arguments_json: string_field(function, "arguments").unwrap_or_else(|| "{}".to_string()),
        result: serde_json::json!({ "ok": true }),
    })
}

fn fixture_agent_tool_call(config_snapshot: &Value) -> Option<NativeAgentToolCall> {
    let tool = config_snapshot
        .get("providers")
        .and_then(|providers| providers.get("fixture"))
        .and_then(|fixture| fixture.get("responses"))
        .and_then(Value::as_array)
        .and_then(|responses| responses.first())
        .and_then(|response| {
            response
                .get("toolCalls")
                .or_else(|| response.get("tool_calls"))
                .and_then(Value::as_array)
        })
        .and_then(|tools| tools.first())?;
    let name = string_field(tool, "name")?;
    Some(NativeAgentToolCall {
        id: string_field(tool, "id").unwrap_or_else(|| "fixture-call-0".to_string()),
        name,
        arguments_json: string_field(tool, "argumentsJson")
            .or_else(|| string_field(tool, "arguments_json"))
            .unwrap_or_else(|| "{}".to_string()),
        result: tool
            .get("result")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({ "ok": true })),
    })
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
    let config_snapshot = spec
        .get("config")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    run_native_agent_turn_with_config(&services, spec, config_snapshot)
}

pub fn run_native_agent_turn_with_services(
    services: &NativeAgentRuntimeServices,
    spec: Value,
) -> Result<Value, String> {
    run_native_agent_turn_with_config(services, spec, serde_json::json!({}))
}

pub fn run_native_agent_turn_with_config(
    services: &NativeAgentRuntimeServices,
    spec: Value,
    config_snapshot: Value,
) -> Result<Value, String> {
    let context = NativeAgentRunContext::from_spec(spec, config_snapshot);
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
        let checkpoint = save_phase_checkpoint(
            services,
            &context,
            "cancelled",
            serde_json::json!({ "cancelled": true }),
        );
        return Ok(cancelled_result(
            &context.run_id,
            &context.session_id,
            checkpoint,
        ));
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

    save_phase_checkpoint(
        services,
        &context,
        "active_turn",
        serde_json::json!({ "status": "running" }),
    );
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
        save_phase_checkpoint(
            services,
            &context,
            "awaiting_tool",
            serde_json::json!({
                "toolCallId": tool_call.id,
                "toolName": tool_call.name,
                "argumentsJson": tool_call.arguments_json,
            }),
        );
        let result = match services.tools.dispatch(&context, &tool_call) {
            Ok(result) => result,
            Err(error) => {
                events.push(event(
                    "agent.error",
                    serde_json::json!({
                        "runId": context.run_id,
                        "sessionId": context.session_id,
                        "stopReason": "tool_error",
                        "error": error,
                        "toolCallId": tool_call.id,
                        "toolName": tool_call.name,
                        "name": tool_call.name,
                    }),
                ));
                services.checkpoints.clear(&context.session_id);
                return Ok(serde_json::json!({
                    "runtime": "rust",
                    "runId": context.run_id,
                    "sessionId": context.session_id,
                    "finalContent": "",
                    "stopReason": "tool_error",
                    "messages": [],
                    "toolsUsed": tools_used,
                    "error": error,
                    "events": events,
                }));
            }
        };
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
    fn from_spec(spec: Value, config_snapshot: Value) -> Self {
        let run_id = string_field(&spec, "runId")
            .or_else(|| string_field(&spec, "run_id"))
            .unwrap_or_else(|| "native-rust-run".to_string());
        let session_id =
            normalized_session_id(&spec).unwrap_or_else(|| "native-rust-session".to_string());
        let metadata = spec
            .get("metadata")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        let model = normalized_model(&spec, &metadata, &config_snapshot);
        let provider = normalized_provider(&spec, &metadata, &config_snapshot);
        let max_iterations = spec
            .get("maxIterations")
            .or_else(|| spec.get("max_iterations"))
            .or_else(|| metadata.get("maxIterations"))
            .or_else(|| metadata.get("max_iterations"))
            .or_else(|| {
                config_snapshot
                    .get("agents")
                    .and_then(|agents| agents.get("defaults"))
                    .and_then(|defaults| {
                        defaults
                            .get("maxIterations")
                            .or_else(|| defaults.get("max_iterations"))
                    })
            })
            .and_then(Value::as_i64)
            .unwrap_or(1);
        let stream = spec
            .get("stream")
            .or_else(|| metadata.get("stream"))
            .or_else(|| metadata.get("_wants_stream"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        Self {
            run_id,
            session_id,
            spec,
            config_snapshot,
            metadata,
            model,
            provider,
            stream,
            max_iterations,
        }
    }
}

fn normalized_session_id(spec: &Value) -> Option<String> {
    string_field(spec, "sessionId")
        .or_else(|| string_field(spec, "session_id"))
        .or_else(|| string_field(spec, "activeSessionId"))
        .or_else(|| string_field(spec, "active_session_id"))
        .or_else(|| string_field(spec, "sessionKey"))
        .or_else(|| string_field(spec, "session_key"))
}

fn normalized_model(spec: &Value, metadata: &Value, config_snapshot: &Value) -> String {
    string_field(spec, "model")
        .or_else(|| string_field(spec, "modelId"))
        .or_else(|| string_field(spec, "model_id"))
        .or_else(|| string_field(metadata, "model"))
        .unwrap_or_else(|| crate::native_provider_runtime::configured_model(config_snapshot))
}

fn normalized_provider(spec: &Value, metadata: &Value, config_snapshot: &Value) -> Option<String> {
    string_field(spec, "provider")
        .or_else(|| string_field(spec, "providerId"))
        .or_else(|| string_field(spec, "provider_id"))
        .or_else(|| string_field(metadata, "provider"))
        .or_else(|| {
            config_snapshot
                .get("agents")
                .and_then(|agents| agents.get("defaults"))
                .and_then(|defaults| string_field(defaults, "provider"))
        })
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

fn save_phase_checkpoint(
    services: &NativeAgentRuntimeServices,
    context: &NativeAgentRunContext,
    phase: &str,
    payload: Value,
) -> Value {
    let checkpoint = checkpoint_value(context, phase, payload);
    services
        .checkpoints
        .save(&context.session_id, checkpoint.clone());
    checkpoint
}

fn cancelled_result(run_id: &str, session_id: &str, checkpoint: Value) -> Value {
    let events = vec![event(
        "agent.cancelled",
        serde_json::json!({
            "runId": run_id,
            "sessionId": session_id,
            "cancelled": true,
            "stopReason": "cancelled",
            "error": "cancelled",
        }),
    )];
    serde_json::json!({
        "runtime": "rust",
        "runId": run_id,
        "sessionId": session_id,
        "finalContent": "",
        "stopReason": "cancelled",
        "error": "cancelled",
        "messages": [],
        "toolsUsed": [],
        "checkpoint": checkpoint,
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
    use std::sync::Arc;

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
    fn normalizes_desktop_run_spec_inputs_for_rust_turns() {
        let context = NativeAgentRunContext::from_spec(
            json!({
                "runtime": "rust",
                "runId": "run-normalized",
                "activeSessionId": "websocket:active-chat",
                "provider": "fixture",
                "model": "fixture-model",
                "max_iterations": 4,
                "input": { "role": "user", "content": "hello normalized" },
                "metadata": {
                    "_wants_stream": true,
                    "source": "desktop"
                }
            }),
            json!({
                "agents": { "defaults": { "provider": "auto", "model": "fallback-model" } },
                "providers": { "fixture": { "responses": [{ "content": "normalized answer" }] } }
            }),
        );
        let request = agent_chat_completion_request(&context)
            .expect("normalized run spec should produce a chat completion request");
        let provider_config = agent_provider_config(&context);

        assert_eq!(context.session_id, "websocket:active-chat");
        assert_eq!(context.model, "fixture-model");
        assert_eq!(context.provider.as_deref(), Some("fixture"));
        assert_eq!(context.max_iterations, 4);
        assert!(context.stream);
        assert_eq!(context.metadata["source"], "desktop");
        assert_eq!(request["model"], "fixture-model");
        assert_eq!(request["messages"][0]["content"], "hello normalized");
        assert_eq!(provider_config["agents"]["defaults"]["provider"], "fixture");
        assert_eq!(
            provider_config["agents"]["defaults"]["model"],
            "fixture-model"
        );
    }

    #[test]
    fn runs_fixture_streaming_final_answer_with_frontend_events() {
        let result = run_native_agent_turn(json!({
            "runtime": "rust",
            "runId": "run-1",
            "sessionId": "websocket:chat-1",
            "stream": true,
            "messages": [{ "role": "user", "content": "hello" }],
            "config": fixture_provider_config("fixture answer")
        }))
        .expect("fixture provider run should succeed");

        assert_eq!(result["runtime"], "rust");
        assert_eq!(result["finalContent"], "fixture answer");
        assert_eq!(result["events"][0]["eventName"], "agent.delta");
        assert_eq!(result["events"][1]["eventName"], "agent.usage");
        assert_eq!(result["events"][2]["eventName"], "agent.done");
    }

    #[test]
    fn runs_fixture_tool_event_sequence() {
        let services = NativeAgentRuntimeServices::default();
        let result = run_native_agent_turn_with_config(
            &services,
            json!({
                "runtime": "rust",
                "runId": "run-tool",
                "sessionId": "websocket:chat-1",
                "messages": [{ "role": "user", "content": "read" }]
            }),
            json!({
                "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
                "providers": {
                    "fixture": {
                        "responses": [{
                            "content": "tool complete",
                            "toolCalls": [{
                                "id": "call-1",
                                "name": "workspace.read_file",
                                "argumentsJson": "{\"path\":\"README.md\"}",
                                "result": { "content": "README" }
                            }]
                        }]
                    }
                }
            }),
        )
        .expect("fixture tool run should succeed");

        let event_names = event_names(&result);
        assert_eq!(
            event_names,
            vec![
                "agent.tool_call.delta",
                "agent.tool.start",
                "agent.tool.result",
                "agent.usage",
                "agent.done"
            ]
        );
        assert_eq!(result["toolsUsed"][0], "workspace.read_file");
    }

    #[test]
    fn rejects_unpermitted_native_tool_with_structured_error_result() {
        let services = NativeAgentRuntimeServices::default();
        let result = run_native_agent_turn_with_config(
            &services,
            json!({
                "runtime": "rust",
                "runId": "run-tool-denied",
                "sessionId": "websocket:chat-tool-denied",
                "messages": [{ "role": "user", "content": "run shell" }]
            }),
            json!({
                "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
                "providers": {
                    "fixture": {
                        "responses": [{
                            "content": "should not finish",
                            "toolCalls": [{
                                "id": "call-denied",
                                "name": "shell.exec",
                                "argumentsJson": "{\"command\":\"rm -rf .\"}",
                                "result": { "content": "denied" }
                            }]
                        }]
                    }
                }
            }),
        )
        .expect("tool denial should return a structured result");

        assert_eq!(result["stopReason"], "tool_error");
        assert_eq!(result["toolsUsed"][0], "shell.exec");
        assert!(result["error"]
            .as_str()
            .expect("tool error should be a string")
            .contains("not permitted"));
        assert_eq!(
            event_names(&result),
            vec!["agent.tool_call.delta", "agent.tool.start", "agent.error"]
        );
        assert_eq!(result["events"][2]["payload"]["toolName"], "shell.exec");
    }

    #[test]
    fn reports_provider_and_iteration_errors_as_frontend_events() {
        let provider_error = run_native_agent_turn(json!({
            "runtime": "rust",
            "runId": "run-error",
            "sessionId": "websocket:chat-1",
            "messages": [{ "role": "user", "content": "hello" }],
            "config": {
                "agents": { "defaults": { "provider": "openai", "model": "gpt-4.1" } },
                "providers": { "openai": { "api_key": "" } }
            }
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
    fn stores_active_turn_tool_wait_and_cancellation_checkpoints() {
        struct CheckpointAwareProvider {
            checkpoints: Arc<InMemoryNativeAgentCheckpointStore>,
        }

        impl NativeAgentProvider for CheckpointAwareProvider {
            fn complete(
                &self,
                context: &NativeAgentRunContext,
            ) -> Result<NativeAgentProviderResponse, String> {
                let checkpoint = self
                    .checkpoints
                    .restore(&context.session_id)
                    .expect("active turn checkpoint should be present during provider call");
                assert_eq!(checkpoint["phase"], "active_turn");
                Ok(NativeAgentProviderResponse {
                    final_content: "needs tool".to_string(),
                    reasoning_delta: None,
                    usage: None,
                    tool_call: Some(NativeAgentToolCall {
                        id: "call-checkpoint".to_string(),
                        name: "workspace.read_file".to_string(),
                        arguments_json: "{\"path\":\"README.md\"}".to_string(),
                        result: json!({ "content": "README" }),
                    }),
                })
            }
        }

        struct CheckpointAwareToolDispatcher {
            checkpoints: Arc<InMemoryNativeAgentCheckpointStore>,
        }

        impl NativeAgentToolDispatcher for CheckpointAwareToolDispatcher {
            fn dispatch(
                &self,
                context: &NativeAgentRunContext,
                tool_call: &NativeAgentToolCall,
            ) -> Result<NativeAgentToolResult, String> {
                let checkpoint = self
                    .checkpoints
                    .restore(&context.session_id)
                    .expect("tool wait checkpoint should be present during tool dispatch");
                assert_eq!(checkpoint["phase"], "awaiting_tool");
                assert_eq!(checkpoint["payload"]["toolCallId"], tool_call.id);
                Ok(NativeAgentToolResult {
                    content: tool_call.result.clone(),
                })
            }
        }

        let checkpoints = Arc::new(InMemoryNativeAgentCheckpointStore::default());
        let services = NativeAgentRuntimeServices::new(
            Arc::new(CheckpointAwareProvider {
                checkpoints: checkpoints.clone(),
            }),
            Arc::new(CheckpointAwareToolDispatcher {
                checkpoints: checkpoints.clone(),
            }),
            checkpoints.clone(),
            Arc::new(InMemoryNativeAgentCancellation::default()),
        );
        let result = run_native_agent_turn_with_services(
            &services,
            json!({
                "runtime": "rust",
                "runId": "run-checkpoint-storage",
                "sessionId": "websocket:chat-checkpoint-storage",
                "messages": [{ "role": "user", "content": "read" }]
            }),
        )
        .expect("checkpoint-aware run should complete");

        assert_eq!(result["stopReason"], "final_response");
        assert!(
            services.restore_checkpoint("websocket:chat-checkpoint-storage")["checkpoint"]
                .is_null()
        );

        services.cancel("run-cancel-checkpoint");
        let cancelled = run_native_agent_turn_with_services(
            &services,
            json!({
                "runtime": "rust",
                "runId": "run-cancel-checkpoint",
                "sessionId": "websocket:chat-cancel-checkpoint"
            }),
        )
        .expect("cancelled run should return a checkpointed cancellation result");

        assert_eq!(cancelled["stopReason"], "cancelled");
        assert_eq!(cancelled["checkpoint"]["phase"], "cancelled");
        assert_eq!(
            services.restore_checkpoint("websocket:chat-cancel-checkpoint")["checkpoint"]["phase"],
            "cancelled"
        );
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
        assert_eq!(cancelled["stopReason"], "cancelled");
        assert_eq!(cancelled["error"], "cancelled");
        assert_eq!(cancelled["events"][0]["eventName"], "agent.cancelled");
        assert_eq!(cancelled["events"][0]["payload"]["stopReason"], "cancelled");
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

    fn fixture_provider_config(content: &str) -> Value {
        json!({
            "agents": { "defaults": { "provider": "fixture", "model": "fixture-model" } },
            "providers": { "fixture": { "responses": [{ "content": content }] } }
        })
    }
}
