use serde::{Deserialize, Serialize};
use serde_json::Value;

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
    if max_iterations <= 0 {
        return Ok(error_result(
            &run_id,
            &session_id,
            "max_iterations_exceeded",
            "Rust agent runtime reached max iterations before provider call.",
        ));
    }
    if let Some(error) = string_field(&metadata, "fakeProviderError") {
        return Ok(error_result(&run_id, &session_id, "provider_error", &error));
    }

    let mut events = Vec::new();
    let final_content = string_field(&metadata, "fakeFinalContent")
        .or_else(|| string_field(&metadata, "finalContent"))
        .unwrap_or_else(|| format!("Echo: {}", last_user_content(&spec)));
    if spec.get("stream").and_then(Value::as_bool).unwrap_or(false) {
        events.push(event(
            "agent.delta",
            serde_json::json!({
                "runId": run_id,
                "sessionId": session_id,
                "delta": final_content,
            }),
        ));
    }

    let mut tools_used = Vec::new();
    if let Some(tool) = metadata.get("fakeToolCall").and_then(Value::as_object) {
        let tool_name = tool
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("native_tool");
        let tool_call_id = tool
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("tool-call-1");
        let arguments = tool
            .get("argumentsJson")
            .or_else(|| tool.get("arguments_json"))
            .and_then(Value::as_str)
            .unwrap_or("{}");
        let result = tool
            .get("result")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({ "ok": true }));
        tools_used.push(tool_name.to_string());
        events.push(event(
            "agent.tool_call.delta",
            serde_json::json!({
                "runId": run_id,
                "sessionId": session_id,
                "toolCallId": tool_call_id,
                "name": tool_name,
                "argumentsDelta": arguments,
            }),
        ));
        events.push(event(
            "agent.tool.start",
            serde_json::json!({
                "runId": run_id,
                "sessionId": session_id,
                "toolCallId": tool_call_id,
                "name": tool_name,
            }),
        ));
        events.push(event(
            "agent.tool.result",
            serde_json::json!({
                "runId": run_id,
                "sessionId": session_id,
                "toolCallId": tool_call_id,
                "name": tool_name,
                "content": result,
            }),
        ));
    }

    if let Some(usage) = metadata.get("fakeUsage").cloned() {
        events.push(event(
            "agent.usage",
            serde_json::json!({
                "runId": run_id,
                "sessionId": session_id,
                "usage": usage,
            }),
        ));
    }
    events.push(event(
        "agent.done",
        serde_json::json!({
            "runId": run_id,
            "sessionId": session_id,
            "stopReason": "final_response",
        }),
    ));

    Ok(serde_json::json!({
        "runtime": "rust",
        "runId": run_id,
        "sessionId": session_id,
        "finalContent": final_content,
        "stopReason": "final_response",
        "messages": [{
            "role": "assistant",
            "content": final_content
        }],
        "toolsUsed": tools_used,
        "events": events,
    }))
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

fn event(event_name: &str, payload: Value) -> NativeAgentEvent {
    NativeAgentEvent {
        event_name: event_name.to_string(),
        payload,
    }
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

        let event_names = result["events"]
            .as_array()
            .expect("events should be an array")
            .iter()
            .map(|event| event["eventName"].as_str().unwrap_or_default())
            .collect::<Vec<_>>();
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
}
