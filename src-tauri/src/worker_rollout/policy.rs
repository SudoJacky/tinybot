use super::{EventKind, ResponseItemKind, RolloutItem};
use crate::worker_protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource,
};
use serde_json::Value;

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
            | ResponseItemKind::ComputerCall
            | ResponseItemKind::Unspecified => Ok(true),
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
}
