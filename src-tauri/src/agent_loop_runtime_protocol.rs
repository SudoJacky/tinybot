use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const AGENT_RUNTIME_EVENT_SCHEMA_VERSION: &str = "tinybot.agent_event.v1";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRuntimePhase {
    Queued,
    HydratingHistory,
    Planning,
    CallingModel,
    StreamingModel,
    ToolCalling,
    ToolRunning,
    AwaitingApproval,
    AwaitingForm,
    AwaitingSubagent,
    Finalizing,
    Completed,
    Failed,
    Cancelling,
    Cancelled,
}

impl AgentRuntimePhase {
    pub fn for_legacy_event(event_name: &str) -> Self {
        match event_name {
            "agent.reasoning_delta" | "agent.delta" => Self::StreamingModel,
            "agent.tool_call.delta" => Self::ToolCalling,
            "agent.tool.start" | "agent.tool.result" => Self::ToolRunning,
            "agent.awaiting_approval" => Self::AwaitingApproval,
            "agent.awaiting_form" => Self::AwaitingForm,
            "agent.checkpoint" => Self::Planning,
            "agent.done" | "agent.usage" => Self::Completed,
            "agent.error" => Self::Failed,
            "agent.cancelled" => Self::Cancelled,
            _ => Self::Planning,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentTurnItemKind {
    UserMessage,
    AssistantMessage,
    Reasoning,
    ToolCall,
    ApprovalRequest,
    FormRequest,
    SubagentActivity,
    SystemNotice,
}

impl AgentTurnItemKind {
    pub fn for_legacy_event(event_name: &str) -> Option<Self> {
        match event_name {
            "agent.reasoning_delta" => Some(Self::Reasoning),
            "agent.delta" | "agent.done" => Some(Self::AssistantMessage),
            "agent.tool_call.delta" | "agent.tool.start" | "agent.tool.result" => {
                Some(Self::ToolCall)
            }
            "agent.awaiting_approval" => Some(Self::ApprovalRequest),
            "agent.awaiting_form" => Some(Self::FormRequest),
            "agent.error" | "agent.cancelled" | "agent.checkpoint" => Some(Self::SystemNotice),
            _ if event_name.starts_with("agent.delegate.") => Some(Self::SubagentActivity),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentTurnItemStatus {
    Queued,
    Running,
    Waiting,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRuntimeEventSource {
    RustBackend,
    Provider,
    Tool,
    Subagent,
    User,
    System,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRuntimeEventVisibility {
    User,
    Debug,
    Hidden,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentApprovalDecision {
    Approved,
    Denied,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentApprovalScope {
    Once,
    Session,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentFormAction {
    Submit,
    Cancel,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentContinuationInput {
    Approval {
        #[serde(rename = "approvalId")]
        approval_id: String,
        decision: AgentApprovalDecision,
        scope: AgentApprovalScope,
        #[serde(skip_serializing_if = "Option::is_none")]
        guidance: Option<String>,
    },
    Form {
        #[serde(rename = "formId")]
        form_id: String,
        action: AgentFormAction,
        #[serde(skip_serializing_if = "Option::is_none")]
        values: Option<Value>,
    },
    QueuedUserMessage {
        #[serde(rename = "messageId", skip_serializing_if = "Option::is_none")]
        message_id: Option<String>,
        content: String,
    },
    Guidance {
        #[serde(rename = "messageId", skip_serializing_if = "Option::is_none")]
        message_id: Option<String>,
        content: String,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeEventEnvelope {
    pub schema_version: String,
    pub event_id: String,
    pub sequence: u64,
    pub session_id: String,
    pub turn_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    pub event_name: String,
    pub phase: AgentRuntimePhase,
    pub timestamp: String,
    pub source: AgentRuntimeEventSource,
    pub visibility: AgentRuntimeEventVisibility,
    pub payload: Value,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnItem {
    pub item_id: String,
    pub session_id: String,
    pub turn_id: String,
    pub kind: AgentTurnItemKind,
    pub status: AgentTurnItemStatus,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    pub payload: Value,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyNativeAgentEventEnvelopeInput {
    pub session_id: String,
    pub turn_id: String,
    #[serde(default)]
    pub parent_turn_id: Option<String>,
    #[serde(default)]
    pub item_id: Option<String>,
    pub event_name: String,
    pub sequence: u64,
    pub timestamp: String,
    pub payload: Value,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeEventAppendInput {
    #[serde(default)]
    pub parent_turn_id: Option<String>,
    #[serde(default)]
    pub item_id: Option<String>,
    pub event_name: String,
    pub phase: AgentRuntimePhase,
    pub timestamp: String,
    pub source: AgentRuntimeEventSource,
    pub visibility: AgentRuntimeEventVisibility,
    pub payload: Value,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentRuntimeEventAppender {
    session_id: String,
    turn_id: String,
    next_sequence: u64,
}

impl AgentRuntimeEventAppender {
    pub fn new(session_id: impl Into<String>, turn_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            turn_id: turn_id.into(),
            next_sequence: 1,
        }
    }

    pub fn from_existing_events(
        session_id: impl Into<String>,
        turn_id: impl Into<String>,
        events: &[AgentRuntimeEventEnvelope],
    ) -> Self {
        let next_sequence = events
            .iter()
            .map(|event| event.sequence)
            .max()
            .unwrap_or(0)
            .saturating_add(1);
        Self {
            session_id: session_id.into(),
            turn_id: turn_id.into(),
            next_sequence,
        }
    }

    pub fn append(&mut self, input: AgentRuntimeEventAppendInput) -> AgentRuntimeEventEnvelope {
        let sequence = self.take_next_sequence();
        AgentRuntimeEventEnvelope {
            schema_version: AGENT_RUNTIME_EVENT_SCHEMA_VERSION.to_string(),
            event_id: deterministic_event_id(&self.turn_id, &input.event_name, sequence),
            sequence,
            session_id: self.session_id.clone(),
            turn_id: self.turn_id.clone(),
            parent_turn_id: input.parent_turn_id,
            item_id: input.item_id,
            event_name: input.event_name,
            phase: input.phase,
            timestamp: input.timestamp,
            source: input.source,
            visibility: input.visibility,
            payload: input.payload,
        }
    }

    pub fn append_legacy_native_event(
        &mut self,
        event_name: impl Into<String>,
        item_id: Option<String>,
        timestamp: impl Into<String>,
        payload: Value,
    ) -> AgentRuntimeEventEnvelope {
        let event_name = event_name.into();
        let sequence = self.take_next_sequence();
        AgentRuntimeEventEnvelope::from_legacy_native_event(LegacyNativeAgentEventEnvelopeInput {
            session_id: self.session_id.clone(),
            turn_id: self.turn_id.clone(),
            parent_turn_id: None,
            item_id,
            event_name,
            sequence,
            timestamp: timestamp.into(),
            payload,
        })
    }

    pub fn next_sequence(&self) -> u64 {
        self.next_sequence
    }

    fn take_next_sequence(&mut self) -> u64 {
        let sequence = self.next_sequence;
        self.next_sequence = self.next_sequence.saturating_add(1);
        sequence
    }
}

impl AgentRuntimeEventEnvelope {
    pub fn from_legacy_native_event(input: LegacyNativeAgentEventEnvelopeInput) -> Self {
        let phase = AgentRuntimePhase::for_legacy_event(&input.event_name);
        let visibility = legacy_event_visibility(&input.event_name);
        Self {
            schema_version: AGENT_RUNTIME_EVENT_SCHEMA_VERSION.to_string(),
            event_id: deterministic_event_id(&input.turn_id, &input.event_name, input.sequence),
            sequence: input.sequence,
            session_id: input.session_id,
            turn_id: input.turn_id,
            parent_turn_id: input.parent_turn_id,
            item_id: input.item_id,
            event_name: input.event_name,
            phase,
            timestamp: input.timestamp,
            source: AgentRuntimeEventSource::RustBackend,
            visibility,
            payload: input.payload,
        }
    }
}

fn legacy_event_visibility(event_name: &str) -> AgentRuntimeEventVisibility {
    match event_name {
        "agent.checkpoint" | "agent.usage" => AgentRuntimeEventVisibility::Debug,
        _ => AgentRuntimeEventVisibility::User,
    }
}

fn deterministic_event_id(turn_id: &str, event_name: &str, sequence: u64) -> String {
    format!(
        "{}:{}:{:016}",
        turn_id,
        event_name
            .chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() {
                    character
                } else {
                    '-'
                }
            })
            .collect::<String>(),
        sequence
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn runtime_phase_serializes_as_snake_case() {
        assert_eq!(
            serde_json::to_value(AgentRuntimePhase::HydratingHistory).unwrap(),
            json!("hydrating_history")
        );
        assert_eq!(
            serde_json::to_value(AgentRuntimePhase::AwaitingApproval).unwrap(),
            json!("awaiting_approval")
        );
        assert_eq!(
            serde_json::to_value(AgentRuntimePhase::Cancelled).unwrap(),
            json!("cancelled")
        );
    }

    #[test]
    fn continuation_input_serializes_stable_shape() {
        let approval = AgentContinuationInput::Approval {
            approval_id: "approval-1".to_string(),
            decision: AgentApprovalDecision::Denied,
            scope: AgentApprovalScope::Session,
            guidance: Some("Use a read-only command instead.".to_string()),
        };

        assert_eq!(
            serde_json::to_value(approval).unwrap(),
            json!({
                "kind": "approval",
                "approvalId": "approval-1",
                "decision": "denied",
                "scope": "session",
                "guidance": "Use a read-only command instead."
            })
        );

        let form = AgentContinuationInput::Form {
            form_id: "form-1".to_string(),
            action: AgentFormAction::Submit,
            values: Some(json!({ "path": "README.md" })),
        };

        assert_eq!(
            serde_json::to_value(form).unwrap(),
            json!({
                "kind": "form",
                "formId": "form-1",
                "action": "submit",
                "values": { "path": "README.md" }
            })
        );
    }

    #[test]
    fn turn_item_serializes_stable_shape() {
        let item = AgentTurnItem {
            item_id: "item-1".to_string(),
            session_id: "session-1".to_string(),
            turn_id: "turn-1".to_string(),
            kind: AgentTurnItemKind::ToolCall,
            status: AgentTurnItemStatus::Running,
            created_at: "2026-07-03T00:00:00Z".to_string(),
            updated_at: None,
            title: Some("Reading file".to_string()),
            summary: None,
            payload: json!({ "toolName": "read_file" }),
        };

        assert_eq!(
            serde_json::to_value(item).unwrap(),
            json!({
                "itemId": "item-1",
                "sessionId": "session-1",
                "turnId": "turn-1",
                "kind": "tool_call",
                "status": "running",
                "createdAt": "2026-07-03T00:00:00Z",
                "title": "Reading file",
                "payload": { "toolName": "read_file" }
            })
        );
    }

    #[test]
    fn legacy_native_event_maps_to_runtime_envelope() {
        let envelope = AgentRuntimeEventEnvelope::from_legacy_native_event(
            LegacyNativeAgentEventEnvelopeInput {
                session_id: "session-1".to_string(),
                turn_id: "turn-1".to_string(),
                parent_turn_id: None,
                item_id: Some("item-1".to_string()),
                event_name: "agent.tool.start".to_string(),
                sequence: 7,
                timestamp: "2026-07-03T00:00:07Z".to_string(),
                payload: json!({ "toolName": "read_file" }),
            },
        );

        assert_eq!(
            serde_json::to_value(envelope).unwrap(),
            json!({
                "schemaVersion": "tinybot.agent_event.v1",
                "eventId": "turn-1:agent-tool-start:0000000000000007",
                "sequence": 7,
                "sessionId": "session-1",
                "turnId": "turn-1",
                "itemId": "item-1",
                "eventName": "agent.tool.start",
                "phase": "tool_running",
                "timestamp": "2026-07-03T00:00:07Z",
                "source": "rust_backend",
                "visibility": "user",
                "payload": { "toolName": "read_file" }
            })
        );
    }

    #[test]
    fn legacy_native_event_name_maps_to_turn_item_kind() {
        assert_eq!(
            AgentTurnItemKind::for_legacy_event("agent.tool.result"),
            Some(AgentTurnItemKind::ToolCall)
        );
        assert_eq!(
            AgentTurnItemKind::for_legacy_event("agent.awaiting_approval"),
            Some(AgentTurnItemKind::ApprovalRequest)
        );
        assert_eq!(
            AgentTurnItemKind::for_legacy_event("agent.delegate.completed"),
            Some(AgentTurnItemKind::SubagentActivity)
        );
    }

    #[test]
    fn event_appender_assigns_monotonic_sequences_and_stable_ids() {
        let mut appender = AgentRuntimeEventAppender::new("session-1", "turn-1");

        let first = appender.append(AgentRuntimeEventAppendInput {
            parent_turn_id: None,
            item_id: None,
            event_name: "agent.turn.started".to_string(),
            phase: AgentRuntimePhase::Planning,
            timestamp: "2026-07-03T00:00:00Z".to_string(),
            source: AgentRuntimeEventSource::RustBackend,
            visibility: AgentRuntimeEventVisibility::User,
            payload: json!({}),
        });
        let second = appender.append(AgentRuntimeEventAppendInput {
            parent_turn_id: None,
            item_id: Some("item-1".to_string()),
            event_name: "agent.delta".to_string(),
            phase: AgentRuntimePhase::StreamingModel,
            timestamp: "2026-07-03T00:00:01Z".to_string(),
            source: AgentRuntimeEventSource::Provider,
            visibility: AgentRuntimeEventVisibility::User,
            payload: json!({ "delta": "hello" }),
        });

        assert_eq!(first.sequence, 1);
        assert_eq!(first.event_id, "turn-1:agent-turn-started:0000000000000001");
        assert_eq!(second.sequence, 2);
        assert_eq!(second.event_id, "turn-1:agent-delta:0000000000000002");
        assert_eq!(appender.next_sequence(), 3);
    }

    #[test]
    fn event_appender_resumes_after_existing_events() {
        let existing = AgentRuntimeEventEnvelope::from_legacy_native_event(
            LegacyNativeAgentEventEnvelopeInput {
                session_id: "session-1".to_string(),
                turn_id: "turn-1".to_string(),
                parent_turn_id: None,
                item_id: None,
                event_name: "agent.delta".to_string(),
                sequence: 12,
                timestamp: "2026-07-03T00:00:12Z".to_string(),
                payload: json!({ "delta": "existing" }),
            },
        );
        let mut appender =
            AgentRuntimeEventAppender::from_existing_events("session-1", "turn-1", &[existing]);

        let next = appender.append_legacy_native_event(
            "agent.done",
            None,
            "2026-07-03T00:00:13Z",
            json!({ "finalContent": "done" }),
        );

        assert_eq!(next.sequence, 13);
        assert_eq!(next.event_id, "turn-1:agent-done:0000000000000013");
        assert_eq!(next.phase, AgentRuntimePhase::Completed);
        assert_eq!(appender.next_sequence(), 14);
    }
}
