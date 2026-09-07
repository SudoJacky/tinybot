use super::checkpoint_types::PhaseCheckpointInput;
use super::{AgentCheckpoint, AgentCheckpointPhase, AgentTurnContext, NativeAgentRuntimeServices};
use serde_json::Value;

pub(super) fn checkpoint_value(
    context: &AgentTurnContext,
    phase: impl Into<AgentCheckpointPhase>,
    mut input: PhaseCheckpointInput,
) -> AgentCheckpoint {
    input.completed_tool_results = checkpoint_completed_tool_results(input.completed_tool_results);
    AgentCheckpoint::new(context, phase.into(), input)
}

pub(super) fn save_phase_checkpoint(
    services: &NativeAgentRuntimeServices,
    context: &AgentTurnContext,
    phase: impl Into<AgentCheckpointPhase>,
    input: PhaseCheckpointInput,
) -> AgentCheckpoint {
    let checkpoint = checkpoint_value(context, phase, input);
    services
        .checkpoints
        .save_for_turn(&context.session_id, &context.turn_id, checkpoint.clone());
    checkpoint
}

fn checkpoint_completed_tool_results(
    mut results: Vec<super::CompletedAgentToolResult>,
) -> Vec<super::CompletedAgentToolResult> {
    for result in &mut results {
        let tool_name = result.tool_name.as_str();
        if !matches!(tool_name, "exec_command" | "write_stdin") {
            continue;
        }
        let Some(envelope) = result.envelope.as_object_mut() else {
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
    results
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
        let checkpoint = checkpoint_value(&context, crate::agent::runtime_protocol::AgentRuntimePhase::AwaitingForm,
            PhaseCheckpointInput {
                iteration: Some(2), pending_tool_calls: vec![serde_json::from_value(json!({"toolCallId":"call-1","toolName":"request_user_input","argumentsJson":"{}"})).unwrap()],
                completed_tool_results: vec![serde_json::from_value(json!({"toolCallId":"call-0","toolName":"read_file","status":"ok","envelope":{}})).unwrap()], resume_token: Some("resume-1".into()),
                stop_reason: Some(super::super::AgentStopReason::AwaitingForm), messages: Some(super::super::AgentItemHistory::from_legacy_messages(&[json!({"role":"user","content":"run"})]).unwrap()),
                payload: super::super::checkpoint_types::AgentCheckpointPayload::UserInput(super::super::checkpoint_types::UserInputCheckpoint {
                    kind: super::super::checkpoint_types::UserInputCheckpointKind::UserInput, form_id: "form-1".into(), pending_hook_context: Vec::new(),
                    form: serde_json::from_value(json!({"title":"Question", "fields":[], "form_id":"form-1", "correlation":{"form_id":"form-1","turn_id":"turn-1","session_id":"session-1","tool_call_id":"call-1"}})).unwrap(),
                }),
            });
        let checkpoint = serde_json::to_value(checkpoint).unwrap();

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
            super::super::AgentStopReason::Interrupted,
            PhaseCheckpointInput {
                iteration: Some(1),
                completed_tool_results: vec![serde_json::from_value(json!({
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
                }))
                .unwrap()],
                messages: Some(
                    super::super::AgentItemHistory::from_legacy_messages(&[json!({
                        "role": "tool",
                        "tool_call_id": "call-shell",
                        "content": model_content
                    })])
                    .unwrap(),
                ),
                ..Default::default()
            },
        );

        let checkpoint = serde_json::to_value(checkpoint).unwrap();
        assert!(checkpoint["completedToolResults"][0]["envelope"]
            .get("raw")
            .is_none());
        let serialized = serde_json::to_string(&checkpoint).expect("checkpoint should serialize");
        assert_eq!(serialized.matches("listed.txt").count(), 2);
    }
}
