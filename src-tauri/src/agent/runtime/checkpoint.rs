use super::{string_field, AgentTurnContext, NativeAgentRuntimeServices};
use serde_json::Value;

pub(super) fn checkpoint_value(context: &AgentTurnContext, phase: &str, payload: Value) -> Value {
    let activated_tool_ids = if matches!(
        phase,
        "cancelled"
            | "interrupted"
            | "runtime_restarted"
            | "completed"
            | "failed"
            | "final_response"
            | "max_iterations"
    ) {
        Vec::new()
    } else {
        context.tool_router.activated_tool_ids()
    };
    let iteration = payload.get("iteration").cloned().unwrap_or(Value::Null);
    let pending_tool_calls = checkpoint_pending_tool_calls(&payload);
    let completed_tool_results = checkpoint_completed_tool_results(&payload);
    let resume_token = payload.get("resumeToken").cloned().unwrap_or(Value::Null);
    let stop_reason = payload.get("stopReason").cloned().unwrap_or(Value::Null);
    let messages = payload
        .get("messages")
        .cloned()
        .or_else(|| context.spec.get("messages").cloned())
        .unwrap_or_else(|| serde_json::json!([]));
    let mut phase_payload = payload;
    if let Some(phase_payload) = phase_payload.as_object_mut() {
        for promoted_field in [
            "iteration",
            "maxIterations",
            "pendingToolCalls",
            "completedToolResults",
            "resumeToken",
            "stopReason",
            "messages",
        ] {
            phase_payload.remove(promoted_field);
        }
    }
    serde_json::json!({
        "schemaVersion": 1,
        "runtime": "rust",
        "turnId": context.turn_id,
        "sessionId": context.session_id,
        "threadId": string_field(&context.metadata, "threadId")
            .or_else(|| string_field(&context.metadata, "thread_id")),
        "traceContext": context.trace_context,
        "phase": phase,
        "iteration": iteration,
        "maxIterations": context.max_iterations,
        "pendingToolCalls": pending_tool_calls,
        "activatedToolIds": activated_tool_ids,
        "completedToolResults": completed_tool_results,
        "resumeToken": resume_token,
        "stopReason": stop_reason,
        "payload": phase_payload,
        "messages": messages,
    })
}

fn checkpoint_pending_tool_calls(payload: &Value) -> Value {
    if let Some(pending) = payload.get("pendingToolCalls") {
        return pending.clone();
    }
    let Some(tool_call_id) = payload.get("toolCallId").cloned() else {
        return serde_json::json!([]);
    };
    serde_json::json!([{
        "toolCallId": tool_call_id,
        "toolName": payload.get("toolName").cloned().unwrap_or(Value::Null),
        "argumentsJson": payload.get("argumentsJson").cloned().unwrap_or(Value::Null),
    }])
}

pub(super) fn save_phase_checkpoint(
    services: &NativeAgentRuntimeServices,
    context: &AgentTurnContext,
    phase: &str,
    payload: Value,
) -> Value {
    let checkpoint = checkpoint_value(context, phase, payload);
    services
        .checkpoints
        .save_for_turn(&context.session_id, &context.turn_id, checkpoint.clone());
    checkpoint
}

fn checkpoint_completed_tool_results(payload: &Value) -> Value {
    let mut completed = payload
        .get("completedToolResults")
        .cloned()
        .unwrap_or_else(|| serde_json::json!([]));
    let Some(results) = completed.as_array_mut() else {
        return completed;
    };
    for result in results {
        let tool_name = result.get("toolName").and_then(Value::as_str);
        if !matches!(tool_name, Some("exec_command" | "write_stdin")) {
            continue;
        }
        let Some(envelope) = result.get_mut("envelope").and_then(Value::as_object_mut) else {
            continue;
        };
        let is_shell_process = envelope
            .get("raw")
            .and_then(Value::as_object)
            .is_some_and(|raw| {
                raw.get("processId").and_then(Value::as_str).is_some()
                    && raw.get("output").and_then(Value::as_str).is_some()
            });
        if is_shell_process {
            envelope.remove("raw");
        }
    }
    completed
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn checkpoint_payload_keeps_only_phase_specific_fields() {
        let context = AgentTurnContext::from_spec(
            json!({
                "turnId": "turn-1",
                "sessionId": "session-1",
                "maxIterations": 4,
                "messages": [{ "role": "user", "content": "run" }]
            }),
            json!({}),
        );
        let checkpoint = checkpoint_value(
            &context,
            "awaiting_form",
            json!({
                "kind": "user_input",
                "formId": "form-1",
                "form": { "questions": [] },
                "iteration": 2,
                "maxIterations": 4,
                "pendingToolCalls": [{ "toolCallId": "call-1" }],
                "completedToolResults": [{ "toolCallId": "call-0" }],
                "resumeToken": "resume-1",
                "stopReason": "awaiting_form",
                "messages": [{ "role": "user", "content": "run" }]
            }),
        );

        assert_eq!(checkpoint["iteration"], 2);
        assert_eq!(checkpoint["maxIterations"], 4);
        assert_eq!(checkpoint["pendingToolCalls"][0]["toolCallId"], "call-1");
        assert_eq!(
            checkpoint["completedToolResults"][0]["toolCallId"],
            "call-0"
        );
        assert_eq!(checkpoint["resumeToken"], "resume-1");
        assert_eq!(checkpoint["stopReason"], "awaiting_form");
        assert_eq!(checkpoint["messages"][0]["content"], "run");
        assert_eq!(checkpoint["payload"]["kind"], "user_input");
        assert_eq!(checkpoint["payload"]["formId"], "form-1");
        for duplicate in [
            "iteration",
            "maxIterations",
            "pendingToolCalls",
            "completedToolResults",
            "resumeToken",
            "stopReason",
            "messages",
        ] {
            assert!(
                checkpoint["payload"].get(duplicate).is_none(),
                "checkpoint payload repeated promoted field `{duplicate}`"
            );
        }
    }

    #[test]
    fn checkpoint_shell_result_keeps_output_once_per_protocol_history() {
        let context = AgentTurnContext::from_spec(
            json!({
                "turnId": "turn-shell",
                "sessionId": "session-shell",
                "messages": []
            }),
            json!({}),
        );
        let model_content = json!({
            "processId": "process-1",
            "status": "exited",
            "running": false,
            "exitCode": 0,
            "output": "listed.txt\n",
            "cursor": 1,
            "truncated": false,
            "droppedBytes": 0
        })
        .to_string();
        let checkpoint = checkpoint_value(
            &context,
            "interrupted",
            json!({
                "iteration": 1,
                "completedToolResults": [{
                    "toolCallId": "call-shell",
                    "toolName": "exec_command",
                    "status": "ok",
                    "envelope": {
                        "status": "ok",
                        "summary": "Command completed",
                        "modelContent": model_content,
                        "raw": {
                            "processId": "process-1",
                            "status": "exited",
                            "running": false,
                            "exitCode": 0,
                            "stdout": "listed.txt\n",
                            "stderr": "",
                            "output": "listed.txt\n",
                            "chunks": [
                                { "sequence": 1, "stream": "stdout", "content": "listed.txt\n" }
                            ],
                            "command": "dir /b",
                            "workingDir": "D:/workspace"
                        }
                    }
                }],
                "messages": [{
                    "role": "tool",
                    "tool_call_id": "call-shell",
                    "content": model_content
                }]
            }),
        );

        assert!(checkpoint["completedToolResults"][0]["envelope"]
            .get("raw")
            .is_none());
        let serialized = serde_json::to_string(&checkpoint).expect("checkpoint should serialize");
        assert_eq!(serialized.matches("listed.txt").count(), 2);
    }
}
