use super::{EventKind, ResponseItemKind, RolloutItem};
use crate::worker_protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource,
};
use serde_json::Value;

pub fn should_persist_rollout_item(item: &RolloutItem) -> Result<bool, WorkerProtocolError> {
    match item {
        RolloutItem::SessionMeta(_)
        | RolloutItem::TurnContext(_)
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
            | EventKind::ThreadItem
            | EventKind::AgentRunCheckpointSet
            | EventKind::AgentRunCheckpointClear => Ok(true),
        },
    }
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
    use crate::worker_rollout::ResponseItem;
    use serde_json::json;

    #[test]
    fn policy_rejects_unknown_response_items() {
        let unknown_response = RolloutItem::ResponseItem(
            ResponseItem::from_value(json!({"type": "future_response"})).unwrap(),
        );

        assert!(should_persist_rollout_item(&unknown_response).is_err());
    }
}
