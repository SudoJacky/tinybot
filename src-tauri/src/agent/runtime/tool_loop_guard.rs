use super::{NativeAgentToolCall, NativeToolResultEnvelope};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct ToolLoopBlock {
    pub(super) previous_effect: String,
    pub(super) previous_reason_code: String,
}

#[derive(Clone, Default)]
pub(super) struct ToolLoopGuard {
    no_progress_calls: HashMap<String, NoProgressObservation>,
}

#[derive(Clone)]
struct NoProgressObservation {
    effect: String,
    reason_code: String,
}

impl ToolLoopGuard {
    pub(super) fn block_for(&self, tool_call: &NativeAgentToolCall) -> Option<ToolLoopBlock> {
        let call_fingerprint = tool_call_fingerprint(tool_call);
        let previous = self.no_progress_calls.get(&call_fingerprint)?;
        Some(ToolLoopBlock {
            previous_effect: previous.effect.clone(),
            previous_reason_code: previous.reason_code.clone(),
        })
    }

    pub(super) fn observe(
        &mut self,
        tool_call: &NativeAgentToolCall,
        envelope: &NativeToolResultEnvelope,
        state_changed: bool,
    ) {
        match no_progress_observation(tool_call, envelope) {
            Some(observation) => {
                self.no_progress_calls
                    .insert(tool_call_fingerprint(tool_call), observation);
            }
            None if state_changed && !is_tool_outcome(envelope) => {
                self.no_progress_calls.clear();
            }
            None => {}
        }
    }
}

fn no_progress_observation(
    tool_call: &NativeAgentToolCall,
    envelope: &NativeToolResultEnvelope,
) -> Option<NoProgressObservation> {
    if let Some(outcome) = envelope
        .pointer("/structured/outcome")
        .filter(|_| is_tool_outcome(envelope))
    {
        if next_action_repeats_call(tool_call, outcome) {
            return None;
        }
        return Some(NoProgressObservation {
            effect: outcome
                .get("effect")
                .and_then(Value::as_str)
                .unwrap_or("no_progress")
                .to_string(),
            reason_code: outcome
                .get("reasonCode")
                .and_then(Value::as_str)
                .unwrap_or("tool_outcome")
                .to_string(),
        });
    }

    match envelope.get("status").and_then(Value::as_str) {
        Some("error" | "denied") => Some(NoProgressObservation {
            effect: "failed".to_string(),
            reason_code: "tool_result_error".to_string(),
        }),
        _ => None,
    }
}

fn is_tool_outcome(envelope: &NativeToolResultEnvelope) -> bool {
    envelope.pointer("/structured/kind").and_then(Value::as_str) == Some("tool_outcome")
}

fn next_action_repeats_call(tool_call: &NativeAgentToolCall, outcome: &Value) -> bool {
    let Some(next_action) = outcome.get("nextAction") else {
        return false;
    };
    if next_action.get("tool").and_then(Value::as_str) != Some(tool_call.name.as_str()) {
        return false;
    }
    let Some(arguments) = next_action.get("arguments") else {
        return false;
    };
    canonical_json(arguments)
        == serde_json::from_str::<Value>(&tool_call.arguments_json)
            .map(|arguments| canonical_json(&arguments))
            .unwrap_or_else(|_| tool_call.arguments_json.clone())
}

fn tool_call_fingerprint(tool_call: &NativeAgentToolCall) -> String {
    let canonical_arguments = serde_json::from_str::<Value>(&tool_call.arguments_json)
        .map(|arguments| canonical_json(&arguments))
        .unwrap_or_else(|_| tool_call.arguments_json.clone());
    let encoded = format!("{}\0{canonical_arguments}", tool_call.name);
    format!("sha256:{:x}", Sha256::digest(encoded.as_bytes()))
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => value.to_string(),
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort_unstable();
            let fields = keys
                .into_iter()
                .map(|key| {
                    format!(
                        "{}:{}",
                        Value::String(key.clone()),
                        canonical_json(&values[key])
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{fields}}}")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::runtime::{
        NativeAgentToolResult, NativeToolNextAction, NativeToolOutcome, NativeToolRetry,
    };
    use serde_json::json;

    fn call(arguments_json: &str) -> NativeAgentToolCall {
        NativeAgentToolCall {
            id: "call-1".to_string(),
            name: "web.act".to_string(),
            arguments_json: arguments_json.to_string(),
            result: Value::Null,
        }
    }

    fn unchanged_result(tool_call: &NativeAgentToolCall) -> NativeAgentToolResult {
        NativeAgentToolResult::success_with_outcome(
            tool_call,
            json!({ "status": "unchanged" }),
            NativeToolOutcome {
                effect: "unchanged".to_string(),
                action_executed: Some(true),
                reason_code: "page_unchanged".to_string(),
                reason: "The page did not change.".to_string(),
                retry: NativeToolRetry::DoNotRetry,
                next_action: None,
            },
        )
    }

    #[test]
    fn blocks_equivalent_arguments_after_no_progress() {
        let first = call(r#"{"snapshotId":"one","action":{"type":"clickTarget","targetRef":"a"}}"#);
        let reordered =
            call(r#"{"action":{"targetRef":"a","type":"clickTarget"},"snapshotId":"one"}"#);
        let mut guard = ToolLoopGuard::default();
        let result = unchanged_result(&first);

        guard.observe(&first, &result.envelope, false);

        let blocked = guard
            .block_for(&reordered)
            .expect("canonical equivalent call should be blocked");
        assert_eq!(blocked.previous_effect, "unchanged");
        assert_eq!(blocked.previous_reason_code, "page_unchanged");
    }

    #[test]
    fn changed_arguments_or_successful_state_mutation_allow_the_call() {
        let first = call(r#"{"snapshotId":"one","action":{"type":"clickTarget"}}"#);
        let changed = call(r#"{"snapshotId":"two","action":{"type":"clickTarget"}}"#);
        let mut guard = ToolLoopGuard::default();
        let result = unchanged_result(&first);
        guard.observe(&first, &result.envelope, false);

        assert!(guard.block_for(&changed).is_none());

        let mutation = NativeAgentToolResult::generic_success(&changed, json!({ "saved": true }));
        guard.observe(&changed, &mutation.envelope, true);
        assert!(guard.block_for(&first).is_none());
    }

    #[test]
    fn explicitly_recommended_same_call_is_not_recorded_as_a_loop() {
        let poll = NativeAgentToolCall {
            id: "call-poll".to_string(),
            name: "write_stdin".to_string(),
            arguments_json: r#"{"cursor":4,"input":"","processId":"p-1"}"#.to_string(),
            result: Value::Null,
        };
        let result = NativeAgentToolResult::success_with_outcome(
            &poll,
            json!({ "status": "running" }),
            NativeToolOutcome {
                effect: "in_progress".to_string(),
                action_executed: Some(true),
                reason_code: "shell_process_running".to_string(),
                reason: "The process is still running.".to_string(),
                retry: NativeToolRetry::RetryWithUpdatedState,
                next_action: Some(NativeToolNextAction {
                    tool: "write_stdin".to_string(),
                    arguments: json!({ "processId": "p-1", "input": "", "cursor": 4 }),
                }),
            },
        );
        let mut guard = ToolLoopGuard::default();

        guard.observe(&poll, &result.envelope, false);

        assert!(guard.block_for(&poll).is_none());
    }
}
