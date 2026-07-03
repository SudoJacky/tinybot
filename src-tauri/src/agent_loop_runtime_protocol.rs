use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

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
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::HydratingHistory => "hydrating_history",
            Self::Planning => "planning",
            Self::CallingModel => "calling_model",
            Self::StreamingModel => "streaming_model",
            Self::ToolCalling => "tool_calling",
            Self::ToolRunning => "tool_running",
            Self::AwaitingApproval => "awaiting_approval",
            Self::AwaitingForm => "awaiting_form",
            Self::AwaitingSubagent => "awaiting_subagent",
            Self::Finalizing => "finalizing",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelling => "cancelling",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn for_legacy_event(event_name: &str) -> Self {
        match event_name {
            "agent.reasoning_delta" | "agent.delta" => Self::StreamingModel,
            "agent.tool_call.delta" => Self::ToolCalling,
            "agent.tool.start" | "agent.tool.result" => Self::ToolRunning,
            "agent.awaiting_approval" | "agent.approval.decision" => Self::AwaitingApproval,
            "agent.awaiting_form" | "agent.form.resolution" => Self::AwaitingForm,
            event_name if event_name.starts_with("agent.delegate.") => Self::AwaitingSubagent,
            "agent.checkpoint" => Self::Planning,
            "agent.usage" => Self::CallingModel,
            "agent.done" => Self::Completed,
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
            "agent.awaiting_approval" | "agent.approval.decision" => Some(Self::ApprovalRequest),
            "agent.awaiting_form" | "agent.form.resolution" => Some(Self::FormRequest),
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

pub fn project_turn_items_from_trace_events(
    events: &[AgentRuntimeEventEnvelope],
) -> Vec<AgentTurnItem> {
    let mut order = Vec::new();
    let mut items = HashMap::<String, AgentTurnItem>::new();

    for event in events {
        let Some(kind) = AgentTurnItemKind::for_legacy_event(&event.event_name) else {
            continue;
        };
        let item_id = event
            .item_id
            .clone()
            .unwrap_or_else(|| projected_item_id(event, &kind));
        let status = projected_item_status(event);
        let payload = projected_item_payload(items.get(&item_id).map(|item| &item.payload), event);
        let title = projected_item_title(&kind, items.get(&item_id), &payload);
        let summary = projected_item_summary(&kind, items.get(&item_id), &payload);

        if let Some(item) = items.get_mut(&item_id) {
            item.status = status;
            item.updated_at = Some(event.timestamp.clone());
            if title.is_some() {
                item.title = title;
            }
            if summary.is_some() {
                item.summary = summary;
            }
            item.payload = payload;
        } else {
            order.push(item_id.clone());
            items.insert(
                item_id.clone(),
                AgentTurnItem {
                    item_id,
                    session_id: event.session_id.clone(),
                    turn_id: event.turn_id.clone(),
                    kind,
                    status,
                    created_at: event.timestamp.clone(),
                    updated_at: None,
                    title,
                    summary,
                    payload,
                },
            );
        }
    }

    order
        .into_iter()
        .filter_map(|item_id| items.remove(&item_id))
        .collect()
}

fn projected_item_id(event: &AgentRuntimeEventEnvelope, kind: &AgentTurnItemKind) -> String {
    match kind {
        AgentTurnItemKind::AssistantMessage => format!("{}:assistant", event.turn_id),
        AgentTurnItemKind::Reasoning => format!("{}:reasoning", event.turn_id),
        AgentTurnItemKind::SystemNotice => {
            format!(
                "{}:{}:{}",
                event.turn_id,
                safe_event_fragment(&event.event_name),
                event.sequence
            )
        }
        _ => format!(
            "{}:{}:{}",
            event.turn_id,
            safe_event_fragment(&event.event_name),
            event.sequence
        ),
    }
}

fn projected_item_status(event: &AgentRuntimeEventEnvelope) -> AgentTurnItemStatus {
    match event.event_name.as_str() {
        "agent.done" | "agent.tool.result" | "agent.approval.decision" | "agent.form.resolution" => {
            AgentTurnItemStatus::Completed
        }
        "agent.error" => AgentTurnItemStatus::Failed,
        "agent.cancelled" => AgentTurnItemStatus::Cancelled,
        "agent.awaiting_approval" | "agent.awaiting_form" => AgentTurnItemStatus::Waiting,
        _ => match &event.phase {
            AgentRuntimePhase::Completed => AgentTurnItemStatus::Completed,
            AgentRuntimePhase::Failed => AgentTurnItemStatus::Failed,
            AgentRuntimePhase::Cancelled => AgentTurnItemStatus::Cancelled,
            AgentRuntimePhase::AwaitingApproval
            | AgentRuntimePhase::AwaitingForm
            | AgentRuntimePhase::AwaitingSubagent => AgentTurnItemStatus::Waiting,
            _ => AgentTurnItemStatus::Running,
        },
    }
}

fn projected_item_payload(
    existing_payload: Option<&Value>,
    event: &AgentRuntimeEventEnvelope,
) -> Value {
    match event.event_name.as_str() {
        "agent.delta" | "agent.reasoning_delta" => {
            let mut content = existing_payload
                .and_then(|payload| payload.get("content"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            content.push_str(payload_text_fragment(&event.payload).unwrap_or_default());
            serde_json::json!({ "content": content })
        }
        "agent.done" => {
            if let Some(content) = payload_text_fragment(&event.payload) {
                serde_json::json!({ "content": content })
            } else {
                event.payload.clone()
            }
        }
        "agent.tool.start" | "agent.tool.result" => projected_tool_payload(existing_payload, event),
        "agent.awaiting_approval" | "agent.approval.decision" => {
            projected_approval_payload(existing_payload, event)
        }
        "agent.awaiting_form" | "agent.form.resolution" => {
            projected_form_payload(existing_payload, event)
        }
        _ => event.payload.clone(),
    }
}

fn projected_tool_payload(
    existing_payload: Option<&Value>,
    event: &AgentRuntimeEventEnvelope,
) -> Value {
    let mut payload = existing_payload
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(event_payload) = event.payload.as_object() {
        for (key, value) in event_payload {
            payload.insert(key.clone(), value.clone());
        }
    }

    let tool_call_id = string_from_map(&payload, &["toolCallId", "tool_call_id"])
        .or_else(|| event.item_id.clone());
    if let Some(tool_call_id) = tool_call_id.clone() {
        payload
            .entry("toolCallId".to_string())
            .or_insert_with(|| Value::String(tool_call_id.clone()));
        payload
            .entry("detailId".to_string())
            .or_insert_with(|| Value::String(format!("tool:{tool_call_id}")));
    }

    let lifecycle_status = if event.event_name == "agent.tool.result" {
        "completed"
    } else {
        "running"
    };
    payload.insert(
        "status".to_string(),
        Value::String(lifecycle_status.to_string()),
    );
    if let Some(result_status) = payload
        .get("envelope")
        .and_then(|envelope| envelope.get("status"))
        .cloned()
    {
        payload.insert("resultStatus".to_string(), result_status);
    }

    let summary = string_from_map(&payload, &["summary"])
        .or_else(|| {
            payload
                .get("envelope")
                .and_then(|envelope| envelope.get("summary"))
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .or_else(|| string_from_map(&payload, &["content"]));
    if let Some(summary) = summary {
        payload.insert("summary".to_string(), Value::String(summary));
    }

    let mut timing = payload
        .get("timing")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if event.event_name == "agent.tool.start" {
        timing
            .entry("startedAt".to_string())
            .or_insert_with(|| Value::String(event.timestamp.clone()));
    }
    if event.event_name == "agent.tool.result" {
        timing
            .entry("completedAt".to_string())
            .or_insert_with(|| Value::String(event.timestamp.clone()));
        if let Some(duration_ms) = payload
            .get("envelope")
            .and_then(|envelope| envelope.get("metrics"))
            .and_then(|metrics| metrics.get("durationMs"))
            .filter(|value| !value.is_null())
            .cloned()
        {
            timing.insert("durationMs".to_string(), duration_ms);
        }
    }
    if !timing.is_empty() {
        payload.insert("timing".to_string(), Value::Object(timing));
    }

    Value::Object(payload)
}

fn projected_item_title(
    kind: &AgentTurnItemKind,
    existing_item: Option<&AgentTurnItem>,
    payload: &Value,
) -> Option<String> {
    if *kind == AgentTurnItemKind::ToolCall {
        return string_field_any(payload, &["toolName", "name", "tool_name"])
            .or_else(|| existing_item.and_then(|item| item.title.clone()));
    }
    if *kind == AgentTurnItemKind::ApprovalRequest {
        return string_field_any(payload, &["summary", "content", "reason"])
            .or_else(|| existing_item.and_then(|item| item.title.clone()));
    }
    if *kind == AgentTurnItemKind::FormRequest {
        return string_field_any(payload, &["title", "summary", "content"])
            .or_else(|| existing_item.and_then(|item| item.title.clone()));
    }
    existing_item.and_then(|item| item.title.clone())
}

fn projected_item_summary(
    kind: &AgentTurnItemKind,
    existing_item: Option<&AgentTurnItem>,
    payload: &Value,
) -> Option<String> {
    if *kind == AgentTurnItemKind::ToolCall {
        return string_field_any(payload, &["summary", "content"])
            .or_else(|| existing_item.and_then(|item| item.summary.clone()));
    }
    if *kind == AgentTurnItemKind::ApprovalRequest {
        return string_field_any(payload, &["summary", "content", "reason"])
            .or_else(|| existing_item.and_then(|item| item.summary.clone()));
    }
    if *kind == AgentTurnItemKind::FormRequest {
        return string_field_any(payload, &["summary", "title", "content"])
            .or_else(|| existing_item.and_then(|item| item.summary.clone()));
    }
    existing_item.and_then(|item| item.summary.clone())
}

fn string_from_map(payload: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| payload.get(*key).and_then(Value::as_str))
        .map(ToString::to_string)
}

fn string_field_any(payload: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| payload.get(*key).and_then(Value::as_str))
        .map(ToString::to_string)
}

fn projected_approval_payload(
    existing_payload: Option<&Value>,
    event: &AgentRuntimeEventEnvelope,
) -> Value {
    let mut payload = existing_payload
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(event_payload) = event.payload.as_object() {
        for (key, value) in event_payload {
            payload.insert(key.clone(), value.clone());
        }
    }

    let approval_id = string_from_map(&payload, &["approvalId", "approval_id"])
        .or_else(|| event.item_id.clone());
    if let Some(approval_id) = approval_id.clone() {
        payload
            .entry("approvalId".to_string())
            .or_insert_with(|| Value::String(approval_id.clone()));
        payload
            .entry("detailId".to_string())
            .or_insert_with(|| Value::String(format!("approval:{approval_id}")));
    }

    if event.event_name == "agent.approval.decision" {
        payload.insert("status".to_string(), Value::String("completed".to_string()));
        payload
            .entry("decidedAt".to_string())
            .or_insert_with(|| Value::String(event.timestamp.clone()));
    } else {
        payload.insert("status".to_string(), Value::String("waiting".to_string()));
        payload
            .entry("requestedAt".to_string())
            .or_insert_with(|| Value::String(event.timestamp.clone()));
    }

    if let Some(summary) = string_from_map(&payload, &["summary", "content", "reason"]) {
        payload.insert("summary".to_string(), Value::String(summary));
    }

    Value::Object(payload)
}

fn projected_form_payload(
    existing_payload: Option<&Value>,
    event: &AgentRuntimeEventEnvelope,
) -> Value {
    let mut payload = existing_payload
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(event_payload) = event.payload.as_object() {
        for (key, value) in event_payload {
            payload.insert(key.clone(), value.clone());
        }
    }

    let form_id =
        string_from_map(&payload, &["formId", "form_id"]).or_else(|| event.item_id.clone());
    if let Some(form_id) = form_id.clone() {
        payload
            .entry("formId".to_string())
            .or_insert_with(|| Value::String(form_id.clone()));
        payload
            .entry("detailId".to_string())
            .or_insert_with(|| Value::String(format!("form:{form_id}")));
    }

    if event.event_name == "agent.form.resolution" {
        payload.insert("status".to_string(), Value::String("completed".to_string()));
        payload
            .entry("resolvedAt".to_string())
            .or_insert_with(|| Value::String(event.timestamp.clone()));
    } else {
        payload.insert("status".to_string(), Value::String("waiting".to_string()));
        payload
            .entry("requestedAt".to_string())
            .or_insert_with(|| Value::String(event.timestamp.clone()));
    }

    let form_title = payload
        .get("form")
        .and_then(Value::as_object)
        .and_then(|form| form.get("title"))
        .and_then(Value::as_str)
        .map(str::to_string);
    if let Some(title) = form_title {
        payload
            .entry("title".to_string())
            .or_insert_with(|| Value::String(title.clone()));
        payload
            .entry("summary".to_string())
            .or_insert_with(|| Value::String(title));
    }

    Value::Object(payload)
}

fn payload_text_fragment(payload: &Value) -> Option<&str> {
    ["delta", "finalContent", "content", "text", "message"]
        .into_iter()
        .find_map(|key| payload.get(key).and_then(Value::as_str))
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
        safe_event_fragment(event_name),
        sequence
    )
}

fn safe_event_fragment(event_name: &str) -> String {
    event_name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '-'
            }
        })
        .collect()
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
        assert_eq!(
            AgentRuntimePhase::for_legacy_event("agent.delegate.linked"),
            AgentRuntimePhase::AwaitingSubagent
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

    #[test]
    fn trace_projection_combines_assistant_deltas_into_one_item() {
        let mut appender = AgentRuntimeEventAppender::new("session-1", "turn-1");
        let events = vec![
            appender.append_legacy_native_event(
                "agent.delta",
                None,
                "2026-07-03T00:00:01Z",
                json!({ "delta": "Hel" }),
            ),
            appender.append_legacy_native_event(
                "agent.delta",
                None,
                "2026-07-03T00:00:02Z",
                json!({ "delta": "lo" }),
            ),
            appender.append_legacy_native_event(
                "agent.done",
                None,
                "2026-07-03T00:00:03Z",
                json!({ "finalContent": "Hello" }),
            ),
        ];

        let items = project_turn_items_from_trace_events(&events);

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].item_id, "turn-1:assistant");
        assert_eq!(items[0].kind, AgentTurnItemKind::AssistantMessage);
        assert_eq!(items[0].status, AgentTurnItemStatus::Completed);
        assert_eq!(items[0].payload, json!({ "content": "Hello" }));
        assert_eq!(items[0].created_at, "2026-07-03T00:00:01Z");
        assert_eq!(items[0].updated_at.as_deref(), Some("2026-07-03T00:00:03Z"));
    }

    #[test]
    fn trace_projection_combines_tool_lifecycle_into_one_item() {
        let mut appender = AgentRuntimeEventAppender::new("session-1", "turn-1");
        let events = vec![
            appender.append_legacy_native_event(
                "agent.tool.start",
                Some("call-1".to_string()),
                "2026-07-03T00:00:01Z",
                json!({ "toolName": "workspace.read_file" }),
            ),
            appender.append_legacy_native_event(
                "agent.tool.result",
                Some("call-1".to_string()),
                "2026-07-03T00:00:02Z",
                json!({
                    "toolName": "workspace.read_file",
                    "envelope": {
                        "status": "ok",
                        "summary": "read README",
                        "metrics": { "durationMs": 42 }
                    }
                }),
            ),
        ];

        let items = project_turn_items_from_trace_events(&events);

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].item_id, "call-1");
        assert_eq!(items[0].kind, AgentTurnItemKind::ToolCall);
        assert_eq!(items[0].status, AgentTurnItemStatus::Completed);
        assert_eq!(items[0].title.as_deref(), Some("workspace.read_file"));
        assert_eq!(items[0].summary.as_deref(), Some("read README"));
        assert_eq!(items[0].payload["status"], "completed");
        assert_eq!(items[0].payload["resultStatus"], "ok");
        assert_eq!(items[0].payload["summary"], "read README");
        assert_eq!(items[0].payload["detailId"], "tool:call-1");
        assert_eq!(
            items[0].payload["timing"],
            json!({
                "startedAt": "2026-07-03T00:00:01Z",
                "completedAt": "2026-07-03T00:00:02Z",
                "durationMs": 42
            })
        );
        assert_eq!(items[0].created_at, "2026-07-03T00:00:01Z");
        assert_eq!(items[0].updated_at.as_deref(), Some("2026-07-03T00:00:02Z"));
    }

    #[test]
    fn trace_projection_combines_approval_request_and_decision() {
        let mut appender = AgentRuntimeEventAppender::new("session-1", "turn-1");
        let events = vec![
            appender.append_legacy_native_event(
                "agent.awaiting_approval",
                Some("approval-1".to_string()),
                "2026-07-03T00:00:01Z",
                json!({
                    "approvalId": "approval-1",
                    "summary": "Allow workspace.write_file?",
                    "options": [
                        { "decision": "approved", "scope": "once" },
                        { "decision": "approved", "scope": "session" },
                        { "decision": "denied" }
                    ]
                }),
            ),
            appender.append_legacy_native_event(
                "agent.approval.decision",
                Some("approval-1".to_string()),
                "2026-07-03T00:00:02Z",
                json!({
                    "approvalId": "approval-1",
                    "decision": "denied",
                    "scope": "once",
                    "guidance": "Do not write files."
                }),
            ),
        ];

        let items = project_turn_items_from_trace_events(&events);

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].item_id, "approval-1");
        assert_eq!(items[0].kind, AgentTurnItemKind::ApprovalRequest);
        assert_eq!(items[0].status, AgentTurnItemStatus::Completed);
        assert_eq!(items[0].title.as_deref(), Some("Allow workspace.write_file?"));
        assert_eq!(items[0].summary.as_deref(), Some("Allow workspace.write_file?"));
        assert_eq!(items[0].payload["status"], "completed");
        assert_eq!(items[0].payload["decision"], "denied");
        assert_eq!(items[0].payload["scope"], "once");
        assert_eq!(items[0].payload["guidance"], "Do not write files.");
        assert_eq!(items[0].payload["detailId"], "approval:approval-1");
        assert_eq!(items[0].payload["options"].as_array().map(Vec::len), Some(3));
        assert_eq!(items[0].created_at, "2026-07-03T00:00:01Z");
        assert_eq!(items[0].updated_at.as_deref(), Some("2026-07-03T00:00:02Z"));
    }

    #[test]
    fn trace_projection_combines_form_request_and_resolution() {
        let mut appender = AgentRuntimeEventAppender::new("session-1", "turn-1");
        let events = vec![
            appender.append_legacy_native_event(
                "agent.awaiting_form",
                Some("form-1".to_string()),
                "2026-07-03T00:00:01Z",
                json!({
                    "formId": "form-1",
                    "form": {
                        "title": "Configure run",
                        "fields": [{ "name": "destination", "required": true }]
                    }
                }),
            ),
            appender.append_legacy_native_event(
                "agent.form.resolution",
                Some("form-1".to_string()),
                "2026-07-03T00:00:02Z",
                json!({
                    "formId": "form-1",
                    "action": "submit",
                    "values": { "destination": "Paris" }
                }),
            ),
        ];

        let items = project_turn_items_from_trace_events(&events);

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].item_id, "form-1");
        assert_eq!(items[0].kind, AgentTurnItemKind::FormRequest);
        assert_eq!(items[0].status, AgentTurnItemStatus::Completed);
        assert_eq!(items[0].title.as_deref(), Some("Configure run"));
        assert_eq!(items[0].summary.as_deref(), Some("Configure run"));
        assert_eq!(items[0].payload["status"], "completed");
        assert_eq!(items[0].payload["action"], "submit");
        assert_eq!(items[0].payload["values"]["destination"], "Paris");
        assert_eq!(items[0].payload["detailId"], "form:form-1");
        assert_eq!(items[0].created_at, "2026-07-03T00:00:01Z");
        assert_eq!(items[0].updated_at.as_deref(), Some("2026-07-03T00:00:02Z"));
    }

    #[test]
    fn trace_projection_restores_active_terminal_and_waiting_items() {
        let events = vec![
            runtime_event(
                "turn-1",
                "agent.delta",
                AgentRuntimePhase::StreamingModel,
                None,
                1,
                json!({ "delta": "working" }),
            ),
            runtime_event(
                "turn-2",
                "agent.done",
                AgentRuntimePhase::Completed,
                None,
                1,
                json!({ "finalContent": "done" }),
            ),
            runtime_event(
                "turn-3",
                "agent.error",
                AgentRuntimePhase::Failed,
                None,
                1,
                json!({ "message": "failed" }),
            ),
            runtime_event(
                "turn-4",
                "agent.cancelled",
                AgentRuntimePhase::Cancelled,
                None,
                1,
                json!({ "message": "cancelled" }),
            ),
            runtime_event(
                "turn-5",
                "agent.awaiting_approval",
                AgentRuntimePhase::AwaitingApproval,
                Some("approval-1"),
                1,
                json!({ "approvalId": "approval-1" }),
            ),
            runtime_event(
                "turn-6",
                "agent.awaiting_form",
                AgentRuntimePhase::AwaitingForm,
                Some("form-1"),
                1,
                json!({ "formId": "form-1" }),
            ),
            runtime_event(
                "turn-7",
                "agent.delegate.running",
                AgentRuntimePhase::AwaitingSubagent,
                Some("subagent-1"),
                1,
                json!({ "delegateId": "subagent-1" }),
            ),
        ];

        let items = project_turn_items_from_trace_events(&events);

        assert_eq!(items.len(), 7);
        assert_eq!(items[0].status, AgentTurnItemStatus::Running);
        assert_eq!(items[1].status, AgentTurnItemStatus::Completed);
        assert_eq!(items[2].status, AgentTurnItemStatus::Failed);
        assert_eq!(items[3].status, AgentTurnItemStatus::Cancelled);
        assert_eq!(items[4].kind, AgentTurnItemKind::ApprovalRequest);
        assert_eq!(items[4].status, AgentTurnItemStatus::Waiting);
        assert_eq!(items[5].kind, AgentTurnItemKind::FormRequest);
        assert_eq!(items[5].status, AgentTurnItemStatus::Waiting);
        assert_eq!(items[6].kind, AgentTurnItemKind::SubagentActivity);
        assert_eq!(items[6].status, AgentTurnItemStatus::Waiting);
    }

    fn runtime_event(
        turn_id: &str,
        event_name: &str,
        phase: AgentRuntimePhase,
        item_id: Option<&str>,
        sequence: u64,
        payload: Value,
    ) -> AgentRuntimeEventEnvelope {
        AgentRuntimeEventEnvelope {
            schema_version: AGENT_RUNTIME_EVENT_SCHEMA_VERSION.to_string(),
            event_id: format!("{turn_id}:{event_name}:{sequence}"),
            sequence,
            session_id: "session-1".to_string(),
            turn_id: turn_id.to_string(),
            parent_turn_id: None,
            item_id: item_id.map(str::to_string),
            event_name: event_name.to_string(),
            phase,
            timestamp: format!("2026-07-03T00:00:{sequence:02}Z"),
            source: AgentRuntimeEventSource::RustBackend,
            visibility: AgentRuntimeEventVisibility::User,
            payload,
        }
    }
}
