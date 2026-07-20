use super::{EventKind, ResponseItemKind, RolloutItem};
use crate::worker_protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource,
};
use serde_json::Value;

pub const ROLLOUT_TRACE_STRING_LIMIT: usize = 256;

pub fn should_persist_rollout_item(item: &RolloutItem) -> Result<bool, WorkerProtocolError> {
    match item {
        RolloutItem::SessionMeta(_)
        | RolloutItem::TurnContext(_)
        | RolloutItem::WorldState(_)
        | RolloutItem::Compacted(_)
        | RolloutItem::InterAgentCommunication(_)
        | RolloutItem::InterAgentCommunicationMetadata { .. } => Ok(true),
        RolloutItem::ResponseItem(item) => match item.kind() {
            ResponseItemKind::Message
            | ResponseItemKind::FunctionCall
            | ResponseItemKind::FunctionCallOutput
            | ResponseItemKind::Reasoning
            | ResponseItemKind::CustomToolCall
            | ResponseItemKind::CustomToolCallOutput
            | ResponseItemKind::WebSearchCall
            | ResponseItemKind::LocalShellCall
            | ResponseItemKind::ComputerCall => Ok(true),
            ResponseItemKind::Unspecified => Err(persistence_policy_error(
                "untyped response item cannot enter canonical Rollout",
                serde_json::json!({ "item": item.as_value() }),
            )),
            ResponseItemKind::Other(kind) => Err(persistence_policy_error(
                "unsupported response item cannot enter canonical Rollout",
                serde_json::json!({ "responseItemKind": kind, "item": item.as_value() }),
            )),
        },
        RolloutItem::EventMsg(event) => match event.kind() {
            EventKind::AgentRunTrace => Ok(!is_transient_agent_trace(event.payload())),
            EventKind::TurnStarted
            | EventKind::TaskStarted
            | EventKind::TurnComplete
            | EventKind::TaskComplete
            | EventKind::TurnAborted
            | EventKind::UserMessage
            | EventKind::ThreadRolledBack
            | EventKind::TokenCount
            | EventKind::MetadataUpdated
            | EventKind::SessionCleared
            | EventKind::SessionTrimmed
            | EventKind::TaskProgressUpdated
            | EventKind::ThreadItem
            | EventKind::AgentRunUpsert
            | EventKind::AgentRunCheckpointSet
            | EventKind::AgentRunCheckpointClear
            | EventKind::AgentRunTerminal => Ok(true),
            EventKind::Legacy(kind) => Err(persistence_policy_error(
                "unknown event type cannot enter canonical Rollout",
                serde_json::json!({ "eventType": kind, "event": event.as_value() }),
            )),
        },
    }
}

pub fn bound_persisted_trace_value(value: Value) -> Value {
    bound_persisted_trace_value_inner(value).0
}

fn bound_persisted_trace_value_inner(value: Value) -> (Value, bool) {
    match value {
        Value::String(content) => {
            let char_count = content.chars().count();
            if char_count <= ROLLOUT_TRACE_STRING_LIMIT {
                (Value::String(content), false)
            } else {
                (
                    Value::String(content.chars().take(ROLLOUT_TRACE_STRING_LIMIT).collect()),
                    true,
                )
            }
        }
        Value::Array(items) => {
            let mut truncated = false;
            let items = items
                .into_iter()
                .map(|item| {
                    let (item, item_truncated) = bound_persisted_trace_value_inner(item);
                    truncated |= item_truncated;
                    item
                })
                .collect();
            (Value::Array(items), truncated)
        }
        Value::Object(mut entries) => {
            let mut truncated = false;
            let retain_trace_context = entries
                .get("eventName")
                .and_then(Value::as_str)
                .map(persisted_event_needs_trace_context)
                .unwrap_or(true);
            if !retain_trace_context {
                entries.remove("traceContext");
            }
            let mut entries = entries
                .into_iter()
                .map(|(key, value)| {
                    let (value, value_truncated) = bound_persisted_trace_value_inner(value);
                    truncated |= value_truncated;
                    (key, value)
                })
                .collect::<serde_json::Map<_, _>>();
            if truncated {
                entries.insert(
                    "tracePersistence".to_string(),
                    serde_json::json!({
                        "truncated": true,
                        "maxStringChars": ROLLOUT_TRACE_STRING_LIMIT,
                    }),
                );
            }
            (Value::Object(entries), truncated)
        }
        value => (value, false),
    }
}

fn persisted_event_needs_trace_context(event_name: &str) -> bool {
    matches!(
        event_name,
        "agent.provider.completed" | "agent.tool.result" | "agent.hook.decision"
    )
}

fn is_transient_agent_trace(payload: &Value) -> bool {
    matches!(
        payload
            .get("event")
            .and_then(|event| event.get("eventName"))
            .and_then(Value::as_str),
        Some("agent.delta" | "agent.reasoning_delta" | "agent.timeline.patch")
    )
}

fn persistence_policy_error(message: &str, detail: Value) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        message,
        serde_json::json!({
            "method": "rollout.persistence_policy",
            "detail": detail,
        }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worker_rollout::{EventMsg, ResponseItem};
    use serde_json::json;

    #[test]
    fn policy_drops_streaming_trace_but_keeps_durable_trace() {
        let transient = RolloutItem::EventMsg(EventMsg::new(
            EventKind::AgentRunTrace,
            json!({
                "runId": "run-1",
                "event": {"eventName": "agent.delta", "payload": {"delta": "x"}}
            }),
        ));
        let durable = RolloutItem::EventMsg(EventMsg::new(
            EventKind::AgentRunTrace,
            json!({
                "runId": "run-1",
                "event": {"eventName": "agent.tool.result", "payload": {"content": "ok"}}
            }),
        ));

        assert!(!should_persist_rollout_item(&transient).unwrap());
        assert!(should_persist_rollout_item(&durable).unwrap());
    }

    #[test]
    fn policy_rejects_unknown_events_and_response_items() {
        let unknown_event = RolloutItem::EventMsg(EventMsg::new(
            EventKind::Legacy("future_event".to_string()),
            json!({}),
        ));
        let unknown_response = RolloutItem::ResponseItem(
            ResponseItem::from_value(json!({"type": "future_response"})).unwrap(),
        );

        assert!(should_persist_rollout_item(&unknown_event).is_err());
        assert!(should_persist_rollout_item(&unknown_response).is_err());
    }

    #[test]
    fn persisted_trace_bounding_is_lossy_only_for_diagnostics() {
        for length in [255, 256, 257] {
            let value = bound_persisted_trace_value(json!({
                "eventName": "agent.message.completed",
                "traceContext": {"traceId": "trace-1"},
                "payload": {"content": "界".repeat(length)}
            }));

            assert_eq!(
                value["payload"]["content"]
                    .as_str()
                    .unwrap()
                    .chars()
                    .count(),
                length.min(ROLLOUT_TRACE_STRING_LIMIT)
            );
            assert_eq!(
                value
                    .get("tracePersistence")
                    .and_then(|metadata| metadata.get("truncated"))
                    .and_then(Value::as_bool),
                (length > ROLLOUT_TRACE_STRING_LIMIT).then_some(true)
            );
            assert!(value.get("traceContext").is_none());
        }
    }
}
