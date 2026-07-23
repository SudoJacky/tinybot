use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

pub const AGENT_RUNTIME_EVENT_SCHEMA_VERSION: &str = "tinybot.agent_event.v1";
pub const AGENT_TURN_ITEM_SCHEMA_VERSION: &str = "tinybot.turn_item.v2";
pub const AGENT_TIMELINE_SCHEMA_VERSION: &str = "tinybot.timeline.v2";
pub const AGENT_TIMELINE_PATCH_SCHEMA_VERSION: &str = "tinybot.timeline_patch.v2";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTraceContext {
    pub request_id: String,
    pub trace_id: String,
    pub turn_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_turn_id: Option<String>,
}

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
    Paused,
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
            Self::Paused => "paused",
            Self::Finalizing => "finalizing",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelling => "cancelling",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn for_legacy_event(event_name: &str) -> Self {
        match event_name {
            "agent.reasoning_delta" | "agent.reasoning.completed" | "agent.delta" => {
                Self::StreamingModel
            }
            "agent.tool_call.delta" => Self::ToolCalling,
            "agent.tool.start" | "agent.tool.result" => Self::ToolRunning,
            "agent.awaiting_approval" | "agent.approval.decision" => Self::AwaitingApproval,
            "agent.awaiting_form" | "agent.form.resolution" => Self::AwaitingForm,
            "agent.paused" => Self::Paused,
            "agent.resumed" => Self::Planning,
            event_name if event_name.starts_with("agent.delegate.") => Self::AwaitingSubagent,
            "agent.checkpoint" => Self::Planning,
            "agent.usage" => Self::CallingModel,
            "agent.message.classified"
            | "agent.message.completed"
            | "agent.command.acknowledged"
            | "agent.done" => Self::Completed,
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
    #[serde(alias = "approval_request")]
    Approval,
    #[serde(alias = "form_request")]
    Form,
    #[serde(alias = "subagent_activity")]
    SubagentLifecycle,
    SubagentMessage,
    PlanProgress,
    ContextCompaction,
    Usage,
    FileReference,
    Error,
    SystemNotice,
}

impl AgentTurnItemKind {
    pub fn for_legacy_event(event_name: &str) -> Option<Self> {
        match event_name {
            "agent.reasoning_delta" | "agent.reasoning.completed" => Some(Self::Reasoning),
            "agent.delta"
            | "agent.message.phase"
            | "agent.message.classified"
            | "agent.message.completed"
            | "agent.done" => Some(Self::AssistantMessage),
            "agent.tool_call.delta" | "agent.tool.start" | "agent.tool.result" => {
                Some(Self::ToolCall)
            }
            "agent.awaiting_approval" | "agent.approval.decision" => Some(Self::Approval),
            "agent.awaiting_form" | "agent.form.resolution" => Some(Self::Form),
            "agent.error" | "agent.cancelled" => Some(Self::Error),
            "agent.checkpoint"
            | "agent.command.acknowledged"
            | "agent.paused"
            | "agent.resumed" => Some(Self::SystemNotice),
            _ if event_name.starts_with("agent.delegate.") => Some(Self::SubagentLifecycle),
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

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentAssistantMessagePhase {
    Unknown,
    Commentary,
    FinalAnswer,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trace_context: Option<AgentTraceContext>,
    pub payload: Value,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AgentTurnItemData {
    UserMessage {
        message_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        client_event_id: Option<String>,
        content: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        references: Vec<Value>,
    },
    AssistantMessage {
        message_id: Option<String>,
        model_call_id: String,
        phase: AgentAssistantMessagePhase,
        content: String,
    },
    Reasoning {
        model_call_id: String,
        summary: String,
    },
    ToolCall {
        tool_call_id: String,
        name: String,
        status: String,
        args: Value,
        result: Value,
        detail_id: Option<String>,
        timing: Value,
    },
    Approval {
        approval_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        command_id: Option<String>,
        tool_call_id: Option<String>,
        status: String,
        reason: Option<String>,
        decision: Option<String>,
        scope: Option<String>,
        guidance: Option<String>,
        detail_id: Option<String>,
    },
    Form {
        form_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        command_id: Option<String>,
        status: String,
        title: Option<String>,
        action: Option<String>,
        field_ids: Vec<String>,
        values: Value,
        errors: Value,
        detail_id: Option<String>,
    },
    SubagentLifecycle {
        agent_id: String,
        action: String,
        status: String,
        message: Option<String>,
        child_turn_id: Option<String>,
        child_thread_id: Option<String>,
        parent_agent_id: Option<String>,
        parent_turn_id: Option<String>,
        name: Option<String>,
        task: Option<String>,
        trace_ref: Option<String>,
    },
    SubagentMessage {
        agent_id: String,
        message_id: String,
        content: String,
        visibility: String,
    },
    PlanProgress {
        id: String,
        explanation: Option<String>,
        steps: Vec<crate::agent::runtime::AgentPlanStep>,
        summary: String,
        completed: u32,
        total: u32,
        current_step: Option<String>,
    },
    ContextCompaction {
        id: String,
        summary: String,
        dropped_item_count: usize,
        estimated_tokens_before: Option<u64>,
        estimated_tokens_after: Option<u64>,
    },
    Usage {
        id: Option<String>,
        input_tokens: Option<i64>,
        output_tokens: Option<i64>,
        total_tokens: Option<i64>,
        provider_payload: Value,
    },
    FileReference {
        id: String,
        path: String,
        mime_type: Option<String>,
        reference_kind: String,
    },
    Error {
        id: Option<String>,
        code: String,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        command_id: Option<String>,
        cancelled: bool,
    },
    SystemNotice {
        message: String,
        detail: Value,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnItem {
    pub schema_version: String,
    pub item_id: String,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    pub turn_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_item_id: Option<String>,
    pub sequence: u64,
    pub revision: u64,
    pub kind: AgentTurnItemKind,
    pub status: AgentTurnItemStatus,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    pub data: AgentTurnItemData,
    #[serde(skip)]
    pub payload: Value,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTimelineSnapshot {
    pub schema_version: String,
    pub session_id: String,
    pub turn_id: String,
    pub snapshot_revision: u64,
    pub items: Vec<AgentTurnItem>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTimelinePatch {
    pub schema_version: String,
    pub session_id: String,
    pub turn_id: String,
    pub snapshot_revision: u64,
    pub item: AgentTurnItem,
}

#[derive(Clone, Debug)]
pub struct AgentTimelineProjector {
    session_id: String,
    turn_id: String,
    order: Vec<String>,
    items: HashMap<String, AgentTurnItem>,
    snapshot_revision: u64,
    final_answer: Option<(u64, String)>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyNativeAgentEventEnvelopeInput {
    pub session_id: String,
    #[serde(default)]
    pub thread_id: Option<String>,
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

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct LegacyNativeAgentEventProjection {
    #[serde(rename = "eventName")]
    pub event_name: String,
    pub payload: Value,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentRuntimeEventAppender {
    session_id: String,
    thread_id: Option<String>,
    turn_id: String,
    trace_context: Option<AgentTraceContext>,
    next_sequence: u64,
}

impl AgentRuntimeEventAppender {
    #[cfg(test)]
    pub fn new(session_id: impl Into<String>, turn_id: impl Into<String>) -> Self {
        Self::new_with_thread_id(session_id, turn_id, None)
    }

    #[cfg(test)]
    pub fn new_with_thread_id(
        session_id: impl Into<String>,
        turn_id: impl Into<String>,
        thread_id: Option<String>,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            thread_id,
            turn_id: turn_id.into(),
            trace_context: None,
            next_sequence: 1,
        }
    }

    pub fn new_with_trace_context(
        session_id: impl Into<String>,
        trace_context: AgentTraceContext,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            thread_id: trace_context.thread_id.clone(),
            turn_id: trace_context.turn_id.clone(),
            trace_context: Some(trace_context),
            next_sequence: 1,
        }
    }

    #[cfg(test)]
    pub fn from_existing_events(
        session_id: impl Into<String>,
        turn_id: impl Into<String>,
        events: &[AgentRuntimeEventEnvelope],
    ) -> Self {
        Self::from_existing_events_with_thread_id(session_id, turn_id, None, events)
    }

    pub fn from_existing_events_with_thread_id(
        session_id: impl Into<String>,
        turn_id: impl Into<String>,
        thread_id: Option<String>,
        events: &[AgentRuntimeEventEnvelope],
    ) -> Self {
        let next_sequence = events
            .iter()
            .map(|event| event.sequence)
            .max()
            .unwrap_or(0)
            .saturating_add(1);
        let thread_id =
            thread_id.or_else(|| events.iter().find_map(|event| event.thread_id.clone()));
        Self {
            session_id: session_id.into(),
            thread_id,
            turn_id: turn_id.into(),
            trace_context: events.iter().find_map(|event| event.trace_context.clone()),
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
            thread_id: self.thread_id.clone(),
            turn_id: self.turn_id.clone(),
            parent_turn_id: input.parent_turn_id,
            item_id: input.item_id,
            event_name: input.event_name,
            phase: input.phase,
            timestamp: input.timestamp,
            source: input.source,
            visibility: input.visibility,
            trace_context: self.trace_context.clone(),
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
        let mut event = AgentRuntimeEventEnvelope::from_legacy_native_event(
            LegacyNativeAgentEventEnvelopeInput {
                session_id: self.session_id.clone(),
                thread_id: self.thread_id.clone(),
                turn_id: self.turn_id.clone(),
                parent_turn_id: None,
                item_id,
                event_name,
                sequence,
                timestamp: timestamp.into(),
                payload,
            },
        );
        event.trace_context = self.trace_context.clone();
        event
    }

    #[cfg(test)]
    pub fn next_sequence(&self) -> u64 {
        self.next_sequence
    }

    fn take_next_sequence(&mut self) -> u64 {
        let sequence = self.next_sequence;
        self.next_sequence = self.next_sequence.saturating_add(1);
        sequence
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct AgentTurnEmitter {
    appender: AgentRuntimeEventAppender,
    events: Vec<AgentRuntimeEventEnvelope>,
}

impl AgentTurnEmitter {
    #[cfg(test)]
    pub fn new(session_id: impl Into<String>, turn_id: impl Into<String>) -> Self {
        Self::new_with_thread_id(session_id, turn_id, None)
    }

    #[cfg(test)]
    pub fn new_with_thread_id(
        session_id: impl Into<String>,
        turn_id: impl Into<String>,
        thread_id: Option<String>,
    ) -> Self {
        Self {
            appender: AgentRuntimeEventAppender::new_with_thread_id(session_id, turn_id, thread_id),
            events: Vec::new(),
        }
    }

    pub fn new_with_trace_context(
        session_id: impl Into<String>,
        trace_context: AgentTraceContext,
    ) -> Self {
        Self {
            appender: AgentRuntimeEventAppender::new_with_trace_context(session_id, trace_context),
            events: Vec::new(),
        }
    }

    pub fn from_existing_events_with_thread_id(
        session_id: impl Into<String>,
        turn_id: impl Into<String>,
        thread_id: Option<String>,
        events: &[AgentRuntimeEventEnvelope],
    ) -> Self {
        Self {
            appender: AgentRuntimeEventAppender::from_existing_events_with_thread_id(
                session_id, turn_id, thread_id, events,
            ),
            events: Vec::new(),
        }
    }

    pub fn emit(&mut self, input: AgentRuntimeEventAppendInput) -> AgentRuntimeEventEnvelope {
        let event = self.appender.append(input);
        self.events.push(event.clone());
        event
    }

    pub fn events(&self) -> &[AgentRuntimeEventEnvelope] {
        &self.events
    }

    pub fn take_events(&mut self) -> Vec<AgentRuntimeEventEnvelope> {
        std::mem::take(&mut self.events)
    }

    #[cfg(test)]
    pub fn next_sequence(&self) -> u64 {
        self.appender.next_sequence()
    }

    #[cfg(test)]
    pub fn phase_changed(
        &mut self,
        timestamp: impl Into<String>,
        from: AgentRuntimePhase,
        to: AgentRuntimePhase,
    ) -> AgentRuntimeEventEnvelope {
        let to_phase = to.clone();
        self.emit(AgentRuntimeEventAppendInput {
            parent_turn_id: None,
            item_id: None,
            event_name: "agent.phase.changed".to_string(),
            phase: to_phase,
            timestamp: timestamp.into(),
            source: AgentRuntimeEventSource::RustBackend,
            visibility: AgentRuntimeEventVisibility::Debug,
            payload: serde_json::json!({
                "from": from.as_str(),
                "to": to.as_str()
            }),
        })
    }

    #[cfg(test)]
    pub fn status(
        &mut self,
        timestamp: impl Into<String>,
        phase: AgentRuntimePhase,
        label: impl Into<String>,
        detail: Option<String>,
        iteration: Option<i64>,
        is_blocking: bool,
    ) -> AgentRuntimeEventEnvelope {
        let mut payload = serde_json::Map::new();
        payload.insert(
            "phase".to_string(),
            Value::String(phase.as_str().to_string()),
        );
        payload.insert("label".to_string(), Value::String(label.into()));
        if let Some(detail) = detail {
            payload.insert("detail".to_string(), Value::String(detail));
        }
        if let Some(iteration) = iteration {
            payload.insert("iteration".to_string(), Value::from(iteration));
        }
        payload.insert("isBlocking".to_string(), Value::Bool(is_blocking));
        self.emit(AgentRuntimeEventAppendInput {
            parent_turn_id: None,
            item_id: None,
            event_name: "agent.status".to_string(),
            phase,
            timestamp: timestamp.into(),
            source: AgentRuntimeEventSource::RustBackend,
            visibility: AgentRuntimeEventVisibility::User,
            payload: Value::Object(payload),
        })
    }

    pub fn user_turn_started(
        &mut self,
        timestamp: impl Into<String>,
        message_id: Option<String>,
        client_event_id: Option<String>,
        content: impl Into<String>,
        references: Vec<Value>,
    ) -> AgentRuntimeEventEnvelope {
        let content = content.into();
        let mut payload = serde_json::json!({
            "clientEventId": client_event_id,
            "userMessageId": message_id,
            "userMessage": {
                "id": message_id,
                "clientEventId": client_event_id,
                "content": content,
                "references": references.clone()
            }
        });
        if client_event_id.is_none() {
            payload
                .as_object_mut()
                .expect("turn-started payload must be an object")
                .remove("clientEventId");
            payload["userMessage"]
                .as_object_mut()
                .expect("turn-started user message must be an object")
                .remove("clientEventId");
        }
        if references.is_empty() {
            payload["userMessage"]
                .as_object_mut()
                .expect("turn-started user message must be an object")
                .remove("references");
        }
        self.emit(AgentRuntimeEventAppendInput {
            parent_turn_id: None,
            item_id: None,
            event_name: "agent.turn.started".to_string(),
            phase: AgentRuntimePhase::Planning,
            timestamp: timestamp.into(),
            source: AgentRuntimeEventSource::User,
            visibility: AgentRuntimeEventVisibility::User,
            payload,
        })
    }

    #[cfg(test)]
    pub fn assistant_delta(
        &mut self,
        timestamp: impl Into<String>,
        delta: impl Into<String>,
    ) -> AgentRuntimeEventEnvelope {
        self.emit(AgentRuntimeEventAppendInput {
            parent_turn_id: None,
            item_id: None,
            event_name: "agent.delta".to_string(),
            phase: AgentRuntimePhase::StreamingModel,
            timestamp: timestamp.into(),
            source: AgentRuntimeEventSource::Provider,
            visibility: AgentRuntimeEventVisibility::User,
            payload: serde_json::json!({ "delta": delta.into() }),
        })
    }

    #[cfg(test)]
    pub fn message_completed(
        &mut self,
        timestamp: impl Into<String>,
        message_id: Option<String>,
        content: impl Into<String>,
    ) -> AgentRuntimeEventEnvelope {
        self.emit(AgentRuntimeEventAppendInput {
            parent_turn_id: None,
            item_id: None,
            event_name: "agent.message.completed".to_string(),
            phase: AgentRuntimePhase::Completed,
            timestamp: timestamp.into(),
            source: AgentRuntimeEventSource::Provider,
            visibility: AgentRuntimeEventVisibility::User,
            payload: serde_json::json!({
                "messageId": message_id,
                "content": content.into()
            }),
        })
    }

    #[cfg(test)]
    pub fn tool_start(
        &mut self,
        timestamp: impl Into<String>,
        tool_call_id: impl Into<String>,
        tool_name: impl Into<String>,
        args: Value,
    ) -> AgentRuntimeEventEnvelope {
        let tool_call_id = tool_call_id.into();
        self.emit(AgentRuntimeEventAppendInput {
            parent_turn_id: None,
            item_id: Some(tool_call_id.clone()),
            event_name: "agent.tool.start".to_string(),
            phase: AgentRuntimePhase::ToolRunning,
            timestamp: timestamp.into(),
            source: AgentRuntimeEventSource::Tool,
            visibility: AgentRuntimeEventVisibility::User,
            payload: serde_json::json!({
                "toolCallId": tool_call_id,
                "toolName": tool_name.into(),
                "args": args
            }),
        })
    }

    #[cfg(test)]
    pub fn tool_result(
        &mut self,
        timestamp: impl Into<String>,
        tool_call_id: impl Into<String>,
        tool_name: impl Into<String>,
        envelope: Value,
    ) -> AgentRuntimeEventEnvelope {
        let tool_call_id = tool_call_id.into();
        self.emit(AgentRuntimeEventAppendInput {
            parent_turn_id: None,
            item_id: Some(tool_call_id.clone()),
            event_name: "agent.tool.result".to_string(),
            phase: AgentRuntimePhase::ToolRunning,
            timestamp: timestamp.into(),
            source: AgentRuntimeEventSource::Tool,
            visibility: AgentRuntimeEventVisibility::User,
            payload: serde_json::json!({
                "toolCallId": tool_call_id,
                "toolName": tool_name.into(),
                "envelope": envelope
            }),
        })
    }

    #[cfg(test)]
    pub fn awaiting_approval(
        &mut self,
        timestamp: impl Into<String>,
        approval_id: impl Into<String>,
        payload: Value,
    ) -> AgentRuntimeEventEnvelope {
        let approval_id = approval_id.into();
        let mut payload = object_payload(payload);
        payload
            .entry("approvalId".to_string())
            .or_insert_with(|| Value::String(approval_id.clone()));
        self.emit(AgentRuntimeEventAppendInput {
            parent_turn_id: None,
            item_id: Some(approval_id),
            event_name: "agent.awaiting_approval".to_string(),
            phase: AgentRuntimePhase::AwaitingApproval,
            timestamp: timestamp.into(),
            source: AgentRuntimeEventSource::RustBackend,
            visibility: AgentRuntimeEventVisibility::User,
            payload: Value::Object(payload),
        })
    }

    #[cfg(test)]
    pub fn approval_decision(
        &mut self,
        timestamp: impl Into<String>,
        approval_id: impl Into<String>,
        decision: AgentApprovalDecision,
        scope: AgentApprovalScope,
        guidance: Option<String>,
    ) -> AgentRuntimeEventEnvelope {
        let approval_id = approval_id.into();
        let mut payload = serde_json::Map::new();
        payload.insert("approvalId".to_string(), Value::String(approval_id.clone()));
        payload.insert(
            "decision".to_string(),
            serde_json::to_value(decision).unwrap_or(Value::Null),
        );
        payload.insert(
            "scope".to_string(),
            serde_json::to_value(scope).unwrap_or(Value::Null),
        );
        if let Some(guidance) = guidance {
            payload.insert("guidance".to_string(), Value::String(guidance));
        }
        self.emit(AgentRuntimeEventAppendInput {
            parent_turn_id: None,
            item_id: Some(approval_id),
            event_name: "agent.approval.decision".to_string(),
            phase: AgentRuntimePhase::AwaitingApproval,
            timestamp: timestamp.into(),
            source: AgentRuntimeEventSource::User,
            visibility: AgentRuntimeEventVisibility::User,
            payload: Value::Object(payload),
        })
    }

    pub fn cancelled_with_payload(
        &mut self,
        timestamp: impl Into<String>,
        reason: impl Into<String>,
        payload: Value,
    ) -> AgentRuntimeEventEnvelope {
        let reason = reason.into();
        let mut payload = object_payload(payload);
        payload
            .entry("reason".to_string())
            .or_insert_with(|| Value::String(reason));
        self.emit(AgentRuntimeEventAppendInput {
            parent_turn_id: None,
            item_id: None,
            event_name: "agent.cancelled".to_string(),
            phase: AgentRuntimePhase::Cancelled,
            timestamp: timestamp.into(),
            source: AgentRuntimeEventSource::RustBackend,
            visibility: AgentRuntimeEventVisibility::User,
            payload: Value::Object(payload),
        })
    }

    #[cfg(test)]
    pub fn done(
        &mut self,
        timestamp: impl Into<String>,
        stop_reason: impl Into<String>,
        payload: Value,
    ) -> AgentRuntimeEventEnvelope {
        let mut payload = object_payload(payload);
        payload.insert("stopReason".to_string(), Value::String(stop_reason.into()));
        self.emit(AgentRuntimeEventAppendInput {
            parent_turn_id: None,
            item_id: None,
            event_name: "agent.done".to_string(),
            phase: AgentRuntimePhase::Completed,
            timestamp: timestamp.into(),
            source: AgentRuntimeEventSource::RustBackend,
            visibility: AgentRuntimeEventVisibility::Debug,
            payload: Value::Object(payload),
        })
    }
}

pub fn project_legacy_native_agent_events(
    events: &[AgentRuntimeEventEnvelope],
) -> Vec<LegacyNativeAgentEventProjection> {
    events
        .iter()
        .map(project_legacy_native_agent_event)
        .collect()
}

pub fn project_legacy_native_agent_event(
    event: &AgentRuntimeEventEnvelope,
) -> LegacyNativeAgentEventProjection {
    LegacyNativeAgentEventProjection {
        event_name: event.event_name.clone(),
        payload: event.payload.clone(),
    }
}

fn object_payload(payload: Value) -> serde_json::Map<String, Value> {
    payload.as_object().cloned().unwrap_or_default()
}

pub fn project_turn_items_from_trace_events(
    events: &[AgentRuntimeEventEnvelope],
) -> Vec<AgentTurnItem> {
    let mut order = Vec::new();
    let mut items = HashMap::<String, AgentTurnItem>::new();

    for event in events {
        apply_trace_event_to_items(&mut order, &mut items, event);
    }

    order
        .into_iter()
        .filter_map(|item_id| items.remove(&item_id))
        .collect()
}

fn apply_trace_event_to_items(
    order: &mut Vec<String>,
    items: &mut HashMap<String, AgentTurnItem>,
    event: &AgentRuntimeEventEnvelope,
) -> Option<String> {
    let kind = projected_item_kind(event)?;
    let item_id = event
        .item_id
        .clone()
        .unwrap_or_else(|| projected_item_id(event, &kind));
    let status = projected_item_status(event);
    let payload = projected_item_payload(items.get(&item_id).map(|item| &item.payload), event);
    let title = projected_item_title(&kind, items.get(&item_id), &payload);
    let summary = projected_item_summary(&kind, items.get(&item_id), &payload);
    let data = projected_item_data(&kind, &payload, event);

    if let Some(item) = items.get_mut(&item_id) {
        if item.kind != kind {
            panic!(
                "canonical timeline item `{item_id}` changed kind from {:?} to {:?}",
                item.kind, kind
            );
        }
        if matches!(
            item.status,
            AgentTurnItemStatus::Completed
                | AgentTurnItemStatus::Failed
                | AgentTurnItemStatus::Cancelled
        ) && item.status != status
        {
            panic!(
                "canonical timeline item `{item_id}` cannot transition from {:?} to {:?}",
                item.status, status
            );
        }
        validate_assistant_phase_transition(&item.data, &data, &item_id);
        item.status = status;
        item.updated_at = Some(event.timestamp.clone());
        item.revision += 1;
        if title.is_some() {
            item.title = title;
        }
        if summary.is_some() {
            item.summary = summary;
        }
        item.data = data;
        item.payload = payload;
    } else {
        order.push(item_id.clone());
        items.insert(
            item_id.clone(),
            AgentTurnItem {
                schema_version: AGENT_TURN_ITEM_SCHEMA_VERSION.to_string(),
                item_id: item_id.clone(),
                session_id: event.session_id.clone(),
                thread_id: event.thread_id.clone(),
                turn_id: event
                    .trace_context
                    .as_ref()
                    .map(|trace| trace.turn_id.clone())
                    .unwrap_or_else(|| event.turn_id.clone()),
                parent_item_id: parent_item_id(&event.payload),
                sequence: event.sequence,
                revision: 1,
                kind,
                status,
                created_at: event.timestamp.clone(),
                updated_at: None,
                title,
                summary,
                data,
                payload,
            },
        );
    }
    Some(item_id)
}

impl AgentTimelineProjector {
    pub fn new(session_id: impl Into<String>, turn_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            turn_id: turn_id.into(),
            order: Vec::new(),
            items: HashMap::new(),
            snapshot_revision: 0,
            final_answer: None,
        }
    }

    pub fn from_events(
        session_id: impl Into<String>,
        turn_id: impl Into<String>,
        events: &[AgentRuntimeEventEnvelope],
    ) -> Result<Self, String> {
        let mut projector = Self::new(session_id, turn_id);
        for event in events {
            projector.apply_event(event)?;
        }
        Ok(projector)
    }

    pub fn apply_event(
        &mut self,
        event: &AgentRuntimeEventEnvelope,
    ) -> Result<Option<AgentTimelinePatch>, String> {
        validate_timeline_event_identity(
            &self.session_id,
            &self.turn_id,
            std::slice::from_ref(event),
        )?;
        let Some(item_id) = apply_trace_event_to_items(&mut self.order, &mut self.items, event)
        else {
            return Ok(None);
        };
        if is_durable_agent_timeline_event(&event.event_name) {
            self.snapshot_revision = self.snapshot_revision.saturating_add(1);
        }
        self.validate_final_answer_boundary_for_item(&item_id)?;
        let item = self
            .items
            .get(&item_id)
            .cloned()
            .ok_or_else(|| format!("projected timeline item `{item_id}` is missing"))?;
        Ok(Some(AgentTimelinePatch {
            schema_version: AGENT_TIMELINE_PATCH_SCHEMA_VERSION.to_string(),
            session_id: self.session_id.clone(),
            turn_id: self.turn_id.clone(),
            snapshot_revision: self.snapshot_revision,
            item,
        }))
    }

    #[cfg(test)]
    pub fn snapshot(&self) -> Result<AgentTimelineSnapshot, String> {
        let mut items = self
            .order
            .iter()
            .filter_map(|item_id| self.items.get(item_id).cloned())
            .collect::<Vec<_>>();
        items.sort_by(|left, right| {
            left.sequence
                .cmp(&right.sequence)
                .then_with(|| left.item_id.cmp(&right.item_id))
        });
        validate_final_answer_boundary(&items)?;
        Ok(AgentTimelineSnapshot {
            schema_version: AGENT_TIMELINE_SCHEMA_VERSION.to_string(),
            session_id: self.session_id.clone(),
            turn_id: self.turn_id.clone(),
            snapshot_revision: self.snapshot_revision,
            items,
        })
    }

    fn validate_final_answer_boundary_for_item(&mut self, item_id: &str) -> Result<(), String> {
        let item = self
            .items
            .get(item_id)
            .ok_or_else(|| format!("projected timeline item `{item_id}` is missing"))?;
        if let Some((final_sequence, final_item_id)) = self.final_answer.as_ref() {
            if item.sequence > *final_sequence && item_is_disallowed_after_final(item) {
                return Err(format!(
                    "canonical timeline item `{}` appears after final answer `{}`",
                    item.item_id, final_item_id
                ));
            }
        }
        if !item_is_final_answer(item) || self.final_answer.is_some() {
            return Ok(());
        }
        if let Some(invalid) = self.items.values().find(|candidate| {
            candidate.sequence > item.sequence && item_is_disallowed_after_final(candidate)
        }) {
            return Err(format!(
                "canonical timeline item `{}` appears after final answer `{}`",
                invalid.item_id, item.item_id
            ));
        }
        self.final_answer = Some((item.sequence, item.item_id.clone()));
        Ok(())
    }
}

pub fn project_timeline_snapshot(
    session_id: &str,
    turn_id: &str,
    events: &[AgentRuntimeEventEnvelope],
) -> Result<AgentTimelineSnapshot, String> {
    validate_timeline_event_identity(session_id, turn_id, events)?;
    let mut items = project_turn_items_from_trace_events(events);
    items.sort_by(|left, right| {
        left.sequence
            .cmp(&right.sequence)
            .then_with(|| left.item_id.cmp(&right.item_id))
    });
    validate_final_answer_boundary(&items)?;
    Ok(AgentTimelineSnapshot {
        schema_version: AGENT_TIMELINE_SCHEMA_VERSION.to_string(),
        session_id: session_id.to_string(),
        turn_id: turn_id.to_string(),
        snapshot_revision: events
            .iter()
            .filter(|event| {
                projected_item_kind(event).is_some()
                    && is_durable_agent_timeline_event(&event.event_name)
            })
            .count() as u64,
        items,
    })
}

pub fn is_durable_agent_timeline_event(event_name: &str) -> bool {
    matches!(
        event_name,
        "agent.turn.started"
            | "agent.reasoning.completed"
            | "agent.message.classified"
            | "agent.message.completed"
            | "agent.tool_call.delta"
            | "agent.tool.result"
            | "agent.awaiting_approval"
            | "agent.approval.decision"
            | "agent.error"
            | "agent.cancelled"
            | "agent.delegate.spawned"
            | "agent.delegate.message"
            | "agent.delegate.completed"
    )
}

#[cfg(test)]
pub fn project_timeline_patch(
    session_id: &str,
    turn_id: &str,
    events: &[AgentRuntimeEventEnvelope],
) -> Result<Option<AgentTimelinePatch>, String> {
    let snapshot = project_timeline_snapshot(session_id, turn_id, events)?;
    let Some(event) = events.last() else {
        return Ok(None);
    };
    let Some(kind) = projected_item_kind(event) else {
        return Ok(None);
    };
    let item_id = event
        .item_id
        .clone()
        .unwrap_or_else(|| projected_item_id(event, &kind));
    let item = snapshot
        .items
        .iter()
        .find(|item| item.item_id == item_id)
        .cloned()
        .ok_or_else(|| format!("projected timeline item `{item_id}` is missing from snapshot"))?;
    Ok(Some(AgentTimelinePatch {
        schema_version: AGENT_TIMELINE_PATCH_SCHEMA_VERSION.to_string(),
        session_id: session_id.to_string(),
        turn_id: turn_id.to_string(),
        snapshot_revision: snapshot.snapshot_revision,
        item,
    }))
}

fn validate_timeline_event_identity(
    session_id: &str,
    turn_id: &str,
    events: &[AgentRuntimeEventEnvelope],
) -> Result<(), String> {
    for event in events {
        if event.session_id != session_id {
            return Err(format!(
                "timeline event `{}` belongs to session `{}`, expected `{session_id}`",
                event.event_id, event.session_id
            ));
        }
        let event_turn_id = event
            .trace_context
            .as_ref()
            .map(|trace| trace.turn_id.as_str())
            .unwrap_or(event.turn_id.as_str());
        if event_turn_id != turn_id {
            return Err(format!(
                "timeline event `{}` belongs to turn `{event_turn_id}`, expected `{turn_id}`",
                event.event_id
            ));
        }
    }
    Ok(())
}

fn projected_item_id(event: &AgentRuntimeEventEnvelope, kind: &AgentTurnItemKind) -> String {
    match kind {
        AgentTurnItemKind::UserMessage => format!("{}:user", event.turn_id),
        AgentTurnItemKind::AssistantMessage => format!(
            "{}:assistant:{}",
            event.turn_id,
            safe_event_fragment(&model_call_identity(event))
        ),
        AgentTurnItemKind::Reasoning => format!(
            "{}:reasoning:{}",
            event.turn_id,
            safe_event_fragment(&model_call_identity(event))
        ),
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

fn projected_item_kind(event: &AgentRuntimeEventEnvelope) -> Option<AgentTurnItemKind> {
    if let Some(item_type) = event
        .payload
        .get("agentItem")
        .and_then(|item| item.get("type"))
        .and_then(Value::as_str)
    {
        let kind = match item_type {
            "user_message" => AgentTurnItemKind::UserMessage,
            "assistant_message" => AgentTurnItemKind::AssistantMessage,
            "reasoning" => AgentTurnItemKind::Reasoning,
            "tool_result" => AgentTurnItemKind::ToolCall,
            "approval" => AgentTurnItemKind::Approval,
            "user_input" => AgentTurnItemKind::Form,
            "plan_progress" => AgentTurnItemKind::PlanProgress,
            "subagent" => AgentTurnItemKind::SubagentLifecycle,
            "subagent_message" => AgentTurnItemKind::SubagentMessage,
            "context_compaction" => AgentTurnItemKind::ContextCompaction,
            "error" => AgentTurnItemKind::Error,
            "usage" => AgentTurnItemKind::Usage,
            "file_reference" => AgentTurnItemKind::FileReference,
            "instruction" => AgentTurnItemKind::SystemNotice,
            _ => panic!("unsupported typed agent item `{item_type}`"),
        };
        return visible_item_kind(event, kind);
    }
    match event.event_name.as_str() {
        "agent.turn.started" => Some(AgentTurnItemKind::UserMessage),
        "agent.plan.progress" | "agent.task_progress" => Some(AgentTurnItemKind::PlanProgress),
        "agent.context.compacted" | "agent.context.trimmed" => {
            Some(AgentTurnItemKind::ContextCompaction)
        }
        "agent.usage" => Some(AgentTurnItemKind::Usage),
        "agent.file.reference" => Some(AgentTurnItemKind::FileReference),
        "agent.done" if !done_event_has_final_content(&event.payload) => None,
        _ => AgentTurnItemKind::for_legacy_event(&event.event_name)
            .and_then(|kind| visible_item_kind(event, kind)),
    }
}

fn parent_item_id(payload: &Value) -> Option<String> {
    string_field_any(payload, &["parentItemId", "parent_item_id"])
}

fn visible_item_kind(
    event: &AgentRuntimeEventEnvelope,
    kind: AgentTurnItemKind,
) -> Option<AgentTurnItemKind> {
    if matches!(
        kind,
        AgentTurnItemKind::AssistantMessage | AgentTurnItemKind::Reasoning
    ) && event.visibility != AgentRuntimeEventVisibility::User
    {
        return None;
    }
    Some(kind)
}

fn model_call_identity(event: &AgentRuntimeEventEnvelope) -> String {
    model_call_identity_from_payload(&event.payload, event)
}

fn model_call_identity_from_payload(payload: &Value, _event: &AgentRuntimeEventEnvelope) -> String {
    item_string(
        payload,
        &[
            "modelCallId",
            "model_call_id",
            "providerAttemptId",
            "provider_attempt_id",
        ],
    )
    .or_else(|| {
        payload
            .get("iteration")
            .and_then(Value::as_i64)
            .map(|iteration| format!("iteration-{iteration}"))
    })
    .unwrap_or_else(|| "legacy".to_string())
}

fn assistant_message_phase(
    payload: &Value,
    event: &AgentRuntimeEventEnvelope,
) -> AgentAssistantMessagePhase {
    match item_string(payload, &["messagePhase", "message_phase", "phase"]).as_deref() {
        Some("commentary") => AgentAssistantMessagePhase::Commentary,
        Some("final_answer") => AgentAssistantMessagePhase::FinalAnswer,
        Some("unknown") | None if event.event_name == "agent.message.completed" => {
            AgentAssistantMessagePhase::FinalAnswer
        }
        Some("unknown") | None => AgentAssistantMessagePhase::Unknown,
        Some(other) => panic!("unsupported assistant message phase `{other}`"),
    }
}

fn merge_message_identity_fields(target: &mut serde_json::Map<String, Value>, source: &Value) {
    for key in [
        "modelCallId",
        "model_call_id",
        "providerAttemptId",
        "provider_attempt_id",
        "iteration",
        "messageId",
        "message_id",
        "reasoningId",
        "reasoning_id",
        "messagePhase",
        "message_phase",
    ] {
        if let Some(value) = source.get(key) {
            target.insert(key.to_string(), value.clone());
        }
    }
}

fn validate_assistant_phase_transition(
    previous: &AgentTurnItemData,
    next: &AgentTurnItemData,
    item_id: &str,
) {
    let (
        AgentTurnItemData::AssistantMessage {
            phase: previous_phase,
            ..
        },
        AgentTurnItemData::AssistantMessage {
            phase: next_phase, ..
        },
    ) = (previous, next)
    else {
        return;
    };
    if previous_phase == next_phase || *previous_phase == AgentAssistantMessagePhase::Unknown {
        return;
    }
    panic!(
        "canonical assistant item `{item_id}` cannot transition phase from {previous_phase:?} to {next_phase:?}"
    );
}

fn validate_final_answer_boundary(items: &[AgentTurnItem]) -> Result<(), String> {
    let Some(final_item) = items.iter().find(|item| item_is_final_answer(item)) else {
        return Ok(());
    };
    if let Some(invalid) = items
        .iter()
        .find(|item| item.sequence > final_item.sequence && item_is_disallowed_after_final(item))
    {
        return Err(format!(
            "canonical timeline item `{}` appears after final answer `{}`",
            invalid.item_id, final_item.item_id
        ));
    }
    Ok(())
}

fn item_is_final_answer(item: &AgentTurnItem) -> bool {
    matches!(
        &item.data,
        AgentTurnItemData::AssistantMessage {
            phase: AgentAssistantMessagePhase::FinalAnswer,
            ..
        }
    )
}

fn item_is_disallowed_after_final(item: &AgentTurnItem) -> bool {
    matches!(
        item.kind,
        AgentTurnItemKind::AssistantMessage
            | AgentTurnItemKind::Reasoning
            | AgentTurnItemKind::ToolCall
            | AgentTurnItemKind::Approval
            | AgentTurnItemKind::Form
            | AgentTurnItemKind::SubagentLifecycle
            | AgentTurnItemKind::SubagentMessage
            | AgentTurnItemKind::PlanProgress
            | AgentTurnItemKind::ContextCompaction
    )
}

fn projected_item_data(
    kind: &AgentTurnItemKind,
    payload: &Value,
    event: &AgentRuntimeEventEnvelope,
) -> AgentTurnItemData {
    let typed_item = event.payload.get("agentItem");
    match kind {
        AgentTurnItemKind::PlanProgress => {
            let source = typed_item.unwrap_or(payload);
            let mut plan = serde_json::from_value::<crate::agent::runtime::AgentPlanProgressItem>(
                source.clone(),
            )
            .unwrap_or_else(|error| panic!("invalid typed plan progress item: {error}"));
            let derived = crate::agent::runtime::validate_and_normalize_plan_steps(&mut plan.steps)
                .unwrap_or_else(|error| panic!("invalid typed plan progress item: {error}"));
            if plan.completed != derived.completed
                || plan.total != derived.total
                || plan.current_step != derived.current_step
            {
                panic!("typed plan progress derived fields do not match its steps");
            }
            AgentTurnItemData::PlanProgress {
                id: plan.id,
                explanation: plan.explanation,
                steps: plan.steps,
                summary: plan.summary,
                completed: derived.completed,
                total: derived.total,
                current_step: derived.current_step,
            }
        }
        AgentTurnItemKind::ContextCompaction
        | AgentTurnItemKind::Usage
        | AgentTurnItemKind::FileReference
        | AgentTurnItemKind::Error => {
            if let Some(typed_item) = typed_item {
                return serde_json::from_value(typed_item.clone()).unwrap_or_else(|error| {
                    panic!("invalid typed agent item for `{kind:?}`: {error}")
                });
            }
            legacy_item_data(kind, payload, event)
        }
        AgentTurnItemKind::Approval => {
            let source = typed_item.unwrap_or(payload);
            AgentTurnItemData::Approval {
                approval_id: required_item_string(
                    source,
                    &["id", "approvalId", "approval_id"],
                    kind,
                ),
                command_id: item_string(payload, &["commandId", "command_id"]),
                tool_call_id: item_string(source, &["toolCallId", "tool_call_id"]),
                status: item_string(source, &["status"]).unwrap_or_else(|| "waiting".to_string()),
                reason: item_string(source, &["reason"])
                    .or_else(|| item_string(payload, &["summary", "content"])),
                decision: item_string(source, &["decision"]),
                scope: item_string(source, &["scope"]),
                guidance: item_string(payload, &["guidance"]),
                detail_id: item_string(payload, &["detailId", "detail_id"]),
            }
        }
        AgentTurnItemKind::Form => {
            let source = typed_item.unwrap_or(payload);
            AgentTurnItemData::Form {
                form_id: required_item_string(source, &["id", "formId", "form_id"], kind),
                command_id: item_string(source, &["commandId", "command_id"])
                    .or_else(|| item_string(payload, &["commandId", "command_id"])),
                status: item_string(source, &["status"]).unwrap_or_else(|| "waiting".to_string()),
                title: item_string(payload, &["title"]),
                action: item_string(source, &["action"]),
                field_ids: source
                    .get("fieldIds")
                    .or_else(|| source.get("field_ids"))
                    .and_then(Value::as_array)
                    .map(|values| {
                        values
                            .iter()
                            .filter_map(Value::as_str)
                            .map(ToString::to_string)
                            .collect()
                    })
                    .unwrap_or_default(),
                values: source
                    .get("values")
                    .or_else(|| payload.get("values"))
                    .cloned()
                    .unwrap_or(Value::Null),
                errors: source
                    .get("errors")
                    .or_else(|| payload.get("errors"))
                    .cloned()
                    .unwrap_or(Value::Null),
                detail_id: item_string(payload, &["detailId", "detail_id"]),
            }
        }
        AgentTurnItemKind::SubagentLifecycle => {
            let source = typed_item.unwrap_or(payload);
            AgentTurnItemData::SubagentLifecycle {
                agent_id: item_string(source, &["agentId", "agent_id", "delegateId", "subagentId"])
                    .or_else(|| {
                        item_string(
                            payload,
                            &["agentId", "agent_id", "delegateId", "subagentId"],
                        )
                    })
                    .unwrap_or_else(|| "multiple".to_string()),
                action: item_string(source, &["action"])
                    .or_else(|| item_string(payload, &["action"]))
                    .unwrap_or_else(|| {
                        event
                            .event_name
                            .strip_prefix("agent.delegate.")
                            .unwrap_or("updated")
                            .to_string()
                    }),
                status: item_string(source, &["status"])
                    .or_else(|| item_string(payload, &["status"]))
                    .unwrap_or_else(|| "running".to_string()),
                message: item_string(source, &["message"])
                    .or_else(|| item_string(payload, &["message"])),
                child_turn_id: item_string(source, &["childTurnId", "child_turn_id"])
                    .or_else(|| item_string(payload, &["childTurnId", "child_turn_id"])),
                child_thread_id: item_string(source, &["childThreadId", "child_thread_id"])
                    .or_else(|| item_string(payload, &["childThreadId", "child_thread_id"])),
                parent_agent_id: item_string(
                    source,
                    &[
                        "parentAgentId",
                        "parent_agent_id",
                        "parentSubagentId",
                        "parent_subagent_id",
                    ],
                )
                .or_else(|| {
                    item_string(
                        payload,
                        &[
                            "parentAgentId",
                            "parent_agent_id",
                            "parentSubagentId",
                            "parent_subagent_id",
                        ],
                    )
                }),
                parent_turn_id: item_string(source, &["parentTurnId", "parent_turn_id"])
                    .or_else(|| item_string(payload, &["parentTurnId", "parent_turn_id"])),
                name: item_string(source, &["name"]).or_else(|| item_string(payload, &["name"])),
                task: item_string(source, &["task"]).or_else(|| item_string(payload, &["task"])),
                trace_ref: item_string(source, &["traceRef", "trace_ref"])
                    .or_else(|| item_string(payload, &["traceRef", "trace_ref"])),
            }
        }
        AgentTurnItemKind::SubagentMessage => {
            let source = typed_item.unwrap_or(payload);
            AgentTurnItemData::SubagentMessage {
                agent_id: required_item_string(source, &["agentId", "agent_id"], kind),
                message_id: required_item_string(source, &["id", "messageId", "message_id"], kind),
                content: required_item_string(source, &["content", "message"], kind),
                visibility: item_string(source, &["visibility"])
                    .unwrap_or_else(|| "user".to_string()),
            }
        }
        _ => legacy_item_data(kind, payload, event),
    }
}

fn legacy_item_data(
    kind: &AgentTurnItemKind,
    payload: &Value,
    event: &AgentRuntimeEventEnvelope,
) -> AgentTurnItemData {
    match kind {
        AgentTurnItemKind::UserMessage => AgentTurnItemData::UserMessage {
            message_id: item_string(payload, &["messageId", "message_id"]),
            client_event_id: item_string(payload, &["clientEventId", "client_event_id"]),
            content: item_string(payload, &["content", "text"]).unwrap_or_default(),
            references: payload
                .get("references")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        },
        AgentTurnItemKind::AssistantMessage => AgentTurnItemData::AssistantMessage {
            message_id: item_string(payload, &["messageId", "message_id", "id"]),
            model_call_id: model_call_identity_from_payload(payload, event),
            phase: assistant_message_phase(payload, event),
            content: item_string(payload, &["content", "text"]).unwrap_or_default(),
        },
        AgentTurnItemKind::Reasoning => AgentTurnItemData::Reasoning {
            model_call_id: model_call_identity_from_payload(payload, event),
            summary: item_string(payload, &["content", "summary", "text"]).unwrap_or_default(),
        },
        AgentTurnItemKind::ToolCall => AgentTurnItemData::ToolCall {
            tool_call_id: required_item_string(
                payload,
                &["toolCallId", "tool_call_id", "id"],
                kind,
            ),
            name: item_string(payload, &["toolName", "tool_name", "name"]).unwrap_or_default(),
            status: item_string(payload, &["status"]).unwrap_or_else(|| "running".to_string()),
            args: payload
                .get("arguments")
                .or_else(|| payload.get("args"))
                .or_else(|| payload.get("argumentsDelta"))
                .or_else(|| payload.get("input"))
                .cloned()
                .unwrap_or(Value::Null),
            result: payload
                .get("envelope")
                .filter(|value| !value.is_null())
                .or_else(|| payload.get("result").filter(|value| !value.is_null()))
                .or_else(|| payload.get("content").filter(|value| !value.is_null()))
                .cloned()
                .unwrap_or(Value::Null),
            detail_id: item_string(payload, &["detailId", "detail_id"]),
            timing: payload.get("timing").cloned().unwrap_or(Value::Null),
        },
        AgentTurnItemKind::Approval => AgentTurnItemData::Approval {
            approval_id: required_item_string(payload, &["approvalId", "approval_id", "id"], kind),
            command_id: item_string(payload, &["commandId", "command_id"]),
            tool_call_id: item_string(payload, &["toolCallId", "tool_call_id"]),
            status: item_string(payload, &["status"]).unwrap_or_else(|| "waiting".to_string()),
            reason: item_string(payload, &["reason", "summary", "content"]),
            decision: item_string(payload, &["decision"]),
            scope: item_string(payload, &["scope"]),
            guidance: item_string(payload, &["guidance"]),
            detail_id: item_string(payload, &["detailId", "detail_id"]),
        },
        AgentTurnItemKind::SystemNotice => AgentTurnItemData::SystemNotice {
            message: item_string(payload, &["message", "content", "summary"])
                .unwrap_or_else(|| event.event_name.clone()),
            detail: payload.clone(),
        },
        AgentTurnItemKind::PlanProgress => AgentTurnItemData::PlanProgress {
            id: item_string(payload, &["planId", "plan_id", "id"])
                .or_else(|| event.item_id.clone())
                .unwrap_or_else(|| format!("{}:plan", event.turn_id)),
            explanation: item_string(payload, &["explanation"]),
            steps: payload
                .get("steps")
                .or_else(|| payload.get("plan"))
                .cloned()
                .map(|steps| {
                    serde_json::from_value(steps).unwrap_or_else(|error| {
                        panic!("canonical plan progress steps are invalid: {error}")
                    })
                })
                .unwrap_or_default(),
            summary: item_string(payload, &["summary", "content"]).unwrap_or_default(),
            completed: item_u32(payload, &["completed"]),
            total: item_u32(payload, &["total"]),
            current_step: item_string(payload, &["currentStep", "current_step"]),
        },
        AgentTurnItemKind::ContextCompaction => AgentTurnItemData::ContextCompaction {
            id: event
                .item_id
                .clone()
                .or_else(|| item_string(payload, &["id"]))
                .unwrap_or_else(|| format!("{}:context:{}", event.turn_id, event.sequence)),
            summary: item_string(payload, &["summary", "strategy"]).unwrap_or_default(),
            dropped_item_count: payload
                .get("droppedItemCount")
                .or_else(|| payload.get("droppedMessageCount"))
                .or_else(|| payload.get("dropped_item_count"))
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize,
            estimated_tokens_before: payload
                .get("estimatedTokensBefore")
                .or_else(|| payload.get("estimated_tokens_before"))
                .and_then(Value::as_u64),
            estimated_tokens_after: payload
                .get("estimatedTokensAfter")
                .or_else(|| payload.get("estimated_tokens_after"))
                .and_then(Value::as_u64),
        },
        AgentTurnItemKind::Usage => {
            let usage = payload.get("usage").unwrap_or(payload);
            AgentTurnItemData::Usage {
                id: event
                    .item_id
                    .clone()
                    .or_else(|| item_string(payload, &["id"])),
                input_tokens: item_i64(usage, &["inputTokens", "input_tokens"]),
                output_tokens: item_i64(usage, &["outputTokens", "output_tokens"]),
                total_tokens: item_i64(usage, &["totalTokens", "total_tokens"]),
                provider_payload: usage.clone(),
            }
        }
        AgentTurnItemKind::FileReference => AgentTurnItemData::FileReference {
            id: event
                .item_id
                .clone()
                .or_else(|| item_string(payload, &["referenceId", "reference_id", "id"]))
                .unwrap_or_else(|| format!("{}:file:{}", event.turn_id, event.sequence)),
            path: required_item_string(payload, &["path", "url"], kind),
            mime_type: item_string(payload, &["mimeType", "mime_type"]),
            reference_kind: item_string(payload, &["referenceKind", "reference_kind"])
                .unwrap_or_else(|| "file".to_string()),
        },
        AgentTurnItemKind::Error => AgentTurnItemData::Error {
            id: event
                .item_id
                .clone()
                .or_else(|| item_string(payload, &["id"])),
            code: item_string(payload, &["stopReason", "code"])
                .unwrap_or_else(|| event.event_name.trim_start_matches("agent.").to_string()),
            message: item_string(payload, &["message", "error"])
                .unwrap_or_else(|| event.event_name.clone()),
            command_id: item_string(payload, &["commandId", "command_id"]),
            cancelled: event.event_name == "agent.cancelled"
                || payload
                    .get("cancelled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
        },
        AgentTurnItemKind::Form
        | AgentTurnItemKind::SubagentLifecycle
        | AgentTurnItemKind::SubagentMessage => {
            panic!("canonical item `{kind:?}` requires typed agent item data")
        }
    }
}

fn item_string(payload: &Value, keys: &[&str]) -> Option<String> {
    string_field_any(payload, keys)
}

fn item_u32(payload: &Value, keys: &[&str]) -> u32 {
    keys.iter()
        .find_map(|key| payload.get(*key).and_then(Value::as_u64))
        .unwrap_or(0)
        .min(u32::MAX as u64) as u32
}

fn item_i64(payload: &Value, keys: &[&str]) -> Option<i64> {
    keys.iter()
        .find_map(|key| payload.get(*key).and_then(Value::as_i64))
}

fn required_item_string(payload: &Value, keys: &[&str], kind: &AgentTurnItemKind) -> String {
    item_string(payload, keys).unwrap_or_else(|| {
        panic!(
            "canonical item `{kind:?}` requires one of: {}",
            keys.join(", ")
        )
    })
}

fn projected_item_status(event: &AgentRuntimeEventEnvelope) -> AgentTurnItemStatus {
    match event.event_name.as_str() {
        "agent.plan.progress"
            if event
                .payload
                .get("completed")
                .and_then(Value::as_u64)
                .zip(event.payload.get("total").and_then(Value::as_u64))
                .is_some_and(|(completed, total)| total > 0 && completed == total) =>
        {
            AgentTurnItemStatus::Completed
        }
        "agent.message.classified"
        | "agent.message.completed"
        | "agent.reasoning.completed"
        | "agent.done"
        | "agent.command.acknowledged"
        | "agent.paused"
        | "agent.resumed"
        | "agent.tool.result"
        | "agent.approval.decision"
        | "agent.form.resolution" => AgentTurnItemStatus::Completed,
        "agent.error" => AgentTurnItemStatus::Failed,
        "agent.cancelled" => AgentTurnItemStatus::Cancelled,
        "agent.awaiting_approval" | "agent.awaiting_form" => AgentTurnItemStatus::Waiting,
        _ => match &event.phase {
            AgentRuntimePhase::Completed => AgentTurnItemStatus::Completed,
            AgentRuntimePhase::Failed => AgentTurnItemStatus::Failed,
            AgentRuntimePhase::Cancelled => AgentTurnItemStatus::Cancelled,
            AgentRuntimePhase::AwaitingApproval
            | AgentRuntimePhase::AwaitingForm
            | AgentRuntimePhase::AwaitingSubagent
            | AgentRuntimePhase::Paused => AgentTurnItemStatus::Waiting,
            _ => AgentTurnItemStatus::Running,
        },
    }
}

fn projected_item_payload(
    existing_payload: Option<&Value>,
    event: &AgentRuntimeEventEnvelope,
) -> Value {
    match event.event_name.as_str() {
        "agent.turn.started" => projected_user_payload(event),
        "agent.delta" | "agent.reasoning_delta" => {
            let mut payload = existing_payload
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let mut content = payload
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            content.push_str(payload_text_fragment(&event.payload).unwrap_or_default());
            payload.insert("content".to_string(), Value::String(content));
            merge_message_identity_fields(&mut payload, &event.payload);
            Value::Object(payload)
        }
        "agent.reasoning.completed" => {
            let mut payload = existing_payload
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            payload.insert(
                "content".to_string(),
                event
                    .payload
                    .get("summary")
                    .cloned()
                    .unwrap_or_else(|| Value::String(String::new())),
            );
            merge_message_identity_fields(&mut payload, &event.payload);
            Value::Object(payload)
        }
        "agent.message.phase" | "agent.message.classified" => {
            let mut payload = existing_payload
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            if let Some(event_payload) = event.payload.as_object() {
                for (key, value) in event_payload {
                    payload.insert(key.clone(), value.clone());
                }
            }
            Value::Object(payload)
        }
        "agent.message.completed" => projected_completed_message_payload(event),
        "agent.done" => projected_legacy_done_payload(event),
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

fn projected_completed_message_payload(event: &AgentRuntimeEventEnvelope) -> Value {
    let mut payload = event.payload.as_object().cloned().unwrap_or_default();
    if !payload.contains_key("content") {
        if let Some(content) = payload_text_fragment(&event.payload) {
            payload.insert("content".to_string(), Value::String(content.to_string()));
        }
    }
    Value::Object(payload)
}

fn projected_legacy_done_payload(event: &AgentRuntimeEventEnvelope) -> Value {
    if let Some(content) = payload_text_fragment(&event.payload) {
        serde_json::json!({ "content": content })
    } else {
        event.payload.clone()
    }
}

fn projected_user_payload(event: &AgentRuntimeEventEnvelope) -> Value {
    let user_message = event
        .payload
        .get("userMessage")
        .or_else(|| event.payload.get("user_message"));
    if let Some(message) = user_message {
        let mut payload = serde_json::Map::new();
        if let Some(id) = message.get("id").and_then(Value::as_str) {
            payload.insert("messageId".to_string(), Value::String(id.to_string()));
        }
        if let Some(content) = message
            .get("content")
            .or_else(|| message.get("text"))
            .and_then(Value::as_str)
        {
            payload.insert("content".to_string(), Value::String(content.to_string()));
        }
        if let Some(client_event_id) = message
            .get("clientEventId")
            .or_else(|| message.get("client_event_id"))
            .and_then(Value::as_str)
            .or_else(|| {
                event
                    .payload
                    .get("clientEventId")
                    .or_else(|| event.payload.get("client_event_id"))
                    .and_then(Value::as_str)
            })
        {
            payload.insert(
                "clientEventId".to_string(),
                Value::String(client_event_id.to_string()),
            );
        }
        if let Some(references) = message
            .get("references")
            .or_else(|| message.get("contextReferences"))
            .or_else(|| message.get("context_references"))
            .filter(|value| value.is_array())
        {
            payload.insert("references".to_string(), references.clone());
        }
        if !payload.contains_key("messageId") {
            if let Some(id) = event
                .payload
                .get("userMessageId")
                .or_else(|| event.payload.get("user_message_id"))
                .and_then(Value::as_str)
            {
                payload.insert("messageId".to_string(), Value::String(id.to_string()));
            }
        }
        if !payload.is_empty() {
            return Value::Object(payload);
        }
    }

    let mut payload = serde_json::Map::new();
    if let Some(client_event_id) = event
        .payload
        .get("clientEventId")
        .or_else(|| event.payload.get("client_event_id"))
        .and_then(Value::as_str)
    {
        payload.insert(
            "clientEventId".to_string(),
            Value::String(client_event_id.to_string()),
        );
    }
    if let Some(id) = event
        .payload
        .get("userMessageId")
        .or_else(|| event.payload.get("user_message_id"))
        .and_then(Value::as_str)
    {
        payload.insert("messageId".to_string(), Value::String(id.to_string()));
    }
    if let Some(content) = event
        .payload
        .get("input")
        .and_then(|input| input.get("content").or_else(|| input.get("text")))
        .and_then(Value::as_str)
        .or_else(|| event.payload.get("content").and_then(Value::as_str))
        .or_else(|| event.payload.get("text").and_then(Value::as_str))
    {
        payload.insert("content".to_string(), Value::String(content.to_string()));
    }
    if let Some(references) = event
        .payload
        .get("input")
        .and_then(|input| {
            input
                .get("references")
                .or_else(|| input.get("contextReferences"))
                .or_else(|| input.get("context_references"))
        })
        .or_else(|| event.payload.get("references"))
        .filter(|value| value.is_array())
    {
        payload.insert("references".to_string(), references.clone());
    }
    Value::Object(payload)
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
    if *kind == AgentTurnItemKind::Approval {
        return string_field_any(payload, &["summary", "content", "reason"])
            .or_else(|| existing_item.and_then(|item| item.title.clone()));
    }
    if *kind == AgentTurnItemKind::Form {
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
    if *kind == AgentTurnItemKind::Approval {
        return string_field_any(payload, &["summary", "content", "reason"])
            .or_else(|| existing_item.and_then(|item| item.summary.clone()));
    }
    if *kind == AgentTurnItemKind::Form {
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

    let approval_id =
        string_from_map(&payload, &["approvalId", "approval_id"]).or_else(|| event.item_id.clone());
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

fn done_event_has_final_content(payload: &Value) -> bool {
    ["finalContent", "content", "text"]
        .into_iter()
        .filter_map(|key| payload.get(key).and_then(Value::as_str))
        .any(|value| !value.trim().is_empty())
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
            thread_id: input.thread_id,
            turn_id: input.turn_id,
            parent_turn_id: input.parent_turn_id,
            item_id: input.item_id,
            event_name: input.event_name,
            phase,
            timestamp: input.timestamp,
            source: AgentRuntimeEventSource::RustBackend,
            visibility,
            trace_context: None,
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
            schema_version: AGENT_TURN_ITEM_SCHEMA_VERSION.to_string(),
            item_id: "item-1".to_string(),
            session_id: "session-1".to_string(),
            thread_id: None,
            turn_id: "turn-1".to_string(),
            parent_item_id: None,
            sequence: 7,
            revision: 1,
            kind: AgentTurnItemKind::ToolCall,
            status: AgentTurnItemStatus::Running,
            created_at: "2026-07-03T00:00:00Z".to_string(),
            updated_at: None,
            title: Some("Reading file".to_string()),
            summary: None,
            data: AgentTurnItemData::ToolCall {
                tool_call_id: "tool-1".to_string(),
                name: "read_file".to_string(),
                status: "running".to_string(),
                args: Value::Null,
                result: Value::Null,
                detail_id: None,
                timing: Value::Null,
            },
            payload: json!({ "toolName": "read_file" }),
        };

        assert_eq!(
            serde_json::to_value(item).unwrap(),
            json!({
                "schemaVersion": "tinybot.turn_item.v2",
                "itemId": "item-1",
                "sessionId": "session-1",
                "turnId": "turn-1",
                "sequence": 7,
                "revision": 1,
                "kind": "tool_call",
                "status": "running",
                "createdAt": "2026-07-03T00:00:00Z",
                "title": "Reading file",
                "data": {
                    "type": "tool_call",
                    "toolCallId": "tool-1",
                    "name": "read_file",
                    "status": "running",
                    "args": null,
                    "result": null,
                    "detailId": null,
                    "timing": null
                }
            })
        );
    }

    #[test]
    fn legacy_native_event_maps_to_runtime_envelope() {
        let envelope = AgentRuntimeEventEnvelope::from_legacy_native_event(
            LegacyNativeAgentEventEnvelopeInput {
                session_id: "session-1".to_string(),
                thread_id: None,
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
            Some(AgentTurnItemKind::Approval)
        );
        assert_eq!(
            AgentTurnItemKind::for_legacy_event("agent.delegate.completed"),
            Some(AgentTurnItemKind::SubagentLifecycle)
        );
        assert_eq!(
            AgentRuntimePhase::for_legacy_event("agent.delegate.linked"),
            AgentRuntimePhase::AwaitingSubagent
        );
    }

    #[test]
    fn subagent_lifecycle_retains_parent_and_assigned_work_correlation() {
        let items = project_turn_items_from_trace_events(&[runtime_event(
            "run-parent",
            "agent.delegate.linked",
            AgentRuntimePhase::AwaitingSubagent,
            Some("subagent-1"),
            1,
            json!({
                "delegateId": "agent-child",
                "childTurnId": "run-child",
                "childThreadId": "thread-child",
                "parentAgentId": "agent-main",
                "parentTurnId": "run-parent",
                "name": "Reviewer",
                "task": "Review the implementation",
                "status": "running",
                "traceRef": "trace-child"
            }),
        )]);

        let data = serde_json::to_value(&items[0].data).unwrap();
        assert_eq!(data["agentId"], "agent-child");
        assert_eq!(data["childTurnId"], "run-child");
        assert_eq!(data["childThreadId"], "thread-child");
        assert_eq!(data["parentAgentId"], "agent-main");
        assert_eq!(data["parentTurnId"], "run-parent");
        assert_eq!(data["name"], "Reviewer");
        assert_eq!(data["task"], "Review the implementation");
        assert_eq!(data["traceRef"], "trace-child");
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
                thread_id: None,
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
    fn run_emitter_buffers_events_and_takes_them_in_sequence_order() {
        let mut emitter = AgentTurnEmitter::new("session-1", "turn-1");

        let first = emitter.phase_changed(
            "2026-07-03T00:00:00Z",
            AgentRuntimePhase::Planning,
            AgentRuntimePhase::CallingModel,
        );
        let second = emitter.message_completed(
            "2026-07-03T00:00:01Z",
            Some("assistant-1".to_string()),
            "Hello",
        );

        assert_eq!(first.sequence, 1);
        assert_eq!(second.sequence, 2);
        assert_eq!(
            second.event_id,
            "turn-1:agent-message-completed:0000000000000002"
        );
        assert_eq!(emitter.events().len(), 2);

        let events = emitter.take_events();
        assert_eq!(
            events
                .iter()
                .map(|event| event.event_name.as_str())
                .collect::<Vec<_>>(),
            vec!["agent.phase.changed", "agent.message.completed"]
        );
        assert!(emitter.events().is_empty());
        assert_eq!(emitter.next_sequence(), 3);
    }

    #[test]
    fn run_emitter_status_event_is_user_visible_without_turn_item() {
        let mut emitter = AgentTurnEmitter::new("session-1", "run-1");

        let event = emitter.status(
            "2026-07-03T00:00:01Z",
            AgentRuntimePhase::ToolRunning,
            "Running tool",
            Some("workspace.read_file".to_string()),
            Some(2),
            false,
        );

        assert_eq!(event.event_name, "agent.status");
        assert_eq!(event.phase, AgentRuntimePhase::ToolRunning);
        assert_eq!(event.visibility, AgentRuntimeEventVisibility::User);
        assert_eq!(event.payload["phase"], "tool_running");
        assert_eq!(event.payload["label"], "Running tool");
        assert_eq!(event.payload["detail"], "workspace.read_file");
        assert_eq!(event.payload["iteration"], 2);
        assert_eq!(event.payload["isBlocking"], false);
        assert!(project_turn_items_from_trace_events(&[event]).is_empty());
    }

    #[test]
    fn run_emitter_helpers_emit_canonical_payloads() {
        let mut emitter = AgentTurnEmitter::new("session-1", "turn-1");

        emitter.user_turn_started(
            "2026-07-03T00:00:00Z",
            Some("user-1".to_string()),
            None,
            "Start",
            Vec::new(),
        );
        emitter.tool_start(
            "2026-07-03T00:00:01Z",
            "call-1",
            "workspace.read_file",
            json!({ "path": "README.md" }),
        );
        emitter.tool_result(
            "2026-07-03T00:00:02Z",
            "call-1",
            "workspace.read_file",
            json!({ "status": "ok", "summary": "read README" }),
        );
        emitter.awaiting_approval(
            "2026-07-03T00:00:03Z",
            "approval-1",
            json!({ "summary": "Allow write?" }),
        );
        emitter.approval_decision(
            "2026-07-03T00:00:04Z",
            "approval-1",
            AgentApprovalDecision::Denied,
            AgentApprovalScope::Once,
            Some("Do not write.".to_string()),
        );

        let events = emitter.take_events();
        assert_eq!(events[0].event_name, "agent.turn.started");
        assert_eq!(events[0].payload["userMessage"]["content"], "Start");
        assert_eq!(events[1].item_id.as_deref(), Some("call-1"));
        assert_eq!(events[1].payload["args"]["path"], "README.md");
        assert_eq!(events[2].payload["envelope"]["summary"], "read README");
        assert_eq!(events[3].phase, AgentRuntimePhase::AwaitingApproval);
        assert_eq!(events[4].payload["decision"], "denied");
        assert_eq!(events[4].payload["guidance"], "Do not write.");
    }

    #[test]
    fn runtime_events_project_to_legacy_native_event_shape() {
        let mut emitter = AgentTurnEmitter::new("session-1", "turn-1");
        emitter.message_completed(
            "2026-07-03T00:00:01Z",
            Some("assistant-1".to_string()),
            "Hello",
        );
        emitter.done(
            "2026-07-03T00:00:02Z",
            "final_response",
            json!({ "iterationCount": 1 }),
        );

        let legacy = project_legacy_native_agent_events(emitter.events());

        assert_eq!(legacy.len(), 2);
        assert_eq!(
            serde_json::to_value(&legacy[0]).unwrap(),
            json!({
                "eventName": "agent.message.completed",
                "payload": {
                    "messageId": "assistant-1",
                    "content": "Hello"
                }
            })
        );
        assert_eq!(legacy[1].event_name, "agent.done");
        assert_eq!(legacy[1].payload["stopReason"], "final_response");
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
        assert_eq!(items[0].item_id, "turn-1:assistant:legacy");
        assert_eq!(items[0].kind, AgentTurnItemKind::AssistantMessage);
        assert_eq!(items[0].status, AgentTurnItemStatus::Completed);
        assert_eq!(items[0].payload, json!({ "content": "Hello" }));
        assert_eq!(items[0].created_at, "2026-07-03T00:00:01Z");
        assert_eq!(items[0].updated_at.as_deref(), Some("2026-07-03T00:00:03Z"));
    }

    #[test]
    fn trace_projection_restores_user_prompt_from_turn_started() {
        let mut appender = AgentRuntimeEventAppender::new("session-1", "turn-1");
        let events = vec![appender.append(AgentRuntimeEventAppendInput {
            parent_turn_id: None,
            item_id: None,
            event_name: "agent.turn.started".to_string(),
            phase: AgentRuntimePhase::Planning,
            timestamp: "2026-07-03T00:00:00Z".to_string(),
            source: AgentRuntimeEventSource::RustBackend,
            visibility: AgentRuntimeEventVisibility::User,
            payload: json!({
                "userMessageId": "user-1",
                "userMessage": { "id": "user-1", "content": "Approve the write" }
            }),
        })];

        let items = project_turn_items_from_trace_events(&events);

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].item_id, "turn-1:user");
        assert_eq!(items[0].kind, AgentTurnItemKind::UserMessage);
        assert_eq!(
            items[0].payload,
            json!({
                "messageId": "user-1",
                "content": "Approve the write"
            })
        );
    }

    #[test]
    fn trace_projection_ignores_waiting_done_without_final_content() {
        let mut appender = AgentRuntimeEventAppender::new("session-1", "turn-1");
        let events = vec![
            appender.append_legacy_native_event(
                "agent.awaiting_approval",
                Some("approval-1".to_string()),
                "2026-07-03T00:00:01Z",
                json!({ "approvalId": "approval-1", "reason": "Needs write approval" }),
            ),
            appender.append_legacy_native_event(
                "agent.done",
                None,
                "2026-07-03T00:00:02Z",
                json!({ "stopReason": "awaiting_approval" }),
            ),
        ];

        let items = project_turn_items_from_trace_events(&events);

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].kind, AgentTurnItemKind::Approval);
        assert_eq!(items[0].status, AgentTurnItemStatus::Waiting);
    }

    #[test]
    fn trace_projection_restores_message_completed_without_legacy_done_content() {
        let mut appender = AgentRuntimeEventAppender::new("session-1", "turn-1");
        let events = vec![
            appender.append(AgentRuntimeEventAppendInput {
                parent_turn_id: None,
                item_id: None,
                event_name: "agent.message.completed".to_string(),
                phase: AgentRuntimePhase::Completed,
                timestamp: "2026-07-03T00:00:01Z".to_string(),
                source: AgentRuntimeEventSource::RustBackend,
                visibility: AgentRuntimeEventVisibility::User,
                payload: json!({
                    "messageId": "assistant-1",
                    "content": "Hello from canonical completion"
                }),
            }),
            appender.append(AgentRuntimeEventAppendInput {
                parent_turn_id: None,
                item_id: None,
                event_name: "agent.done".to_string(),
                phase: AgentRuntimePhase::Completed,
                timestamp: "2026-07-03T00:00:02Z".to_string(),
                source: AgentRuntimeEventSource::RustBackend,
                visibility: AgentRuntimeEventVisibility::Debug,
                payload: json!({ "stopReason": "final_response" }),
            }),
        ];

        let items = project_turn_items_from_trace_events(&events);

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].item_id, "turn-1:assistant:legacy");
        assert_eq!(items[0].kind, AgentTurnItemKind::AssistantMessage);
        assert_eq!(items[0].status, AgentTurnItemStatus::Completed);
        assert_eq!(
            items[0].payload,
            json!({
                "messageId": "assistant-1",
                "content": "Hello from canonical completion"
            })
        );
        assert_eq!(items[0].created_at, "2026-07-03T00:00:01Z");
        assert_eq!(items[0].updated_at, None);
    }

    #[test]
    fn trace_projection_restores_canonical_phase_changed_without_turn_item() {
        let event = runtime_event(
            "turn-1",
            "agent.phase.changed",
            AgentRuntimePhase::CallingModel,
            None,
            1,
            json!({
                "from": "planning",
                "to": "calling_model"
            }),
        );
        let encoded = serde_json::to_value(&event).expect("serialize phase event");
        let restored: AgentRuntimeEventEnvelope =
            serde_json::from_value(encoded).expect("deserialize phase event");

        assert_eq!(restored.event_name, "agent.phase.changed");
        assert_eq!(restored.phase, AgentRuntimePhase::CallingModel);
        assert_eq!(restored.payload["to"], "calling_model");
        assert!(project_turn_items_from_trace_events(&[restored]).is_empty());
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
        assert_eq!(items[0].kind, AgentTurnItemKind::Approval);
        assert_eq!(items[0].status, AgentTurnItemStatus::Completed);
        assert_eq!(
            items[0].title.as_deref(),
            Some("Allow workspace.write_file?")
        );
        assert_eq!(
            items[0].summary.as_deref(),
            Some("Allow workspace.write_file?")
        );
        assert_eq!(items[0].payload["status"], "completed");
        assert_eq!(items[0].payload["decision"], "denied");
        assert_eq!(items[0].payload["scope"], "once");
        assert_eq!(items[0].payload["guidance"], "Do not write files.");
        assert_eq!(items[0].payload["detailId"], "approval:approval-1");
        assert_eq!(
            items[0].payload["options"].as_array().map(Vec::len),
            Some(3)
        );
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
                    },
                    "errors": { "destination": "Required" }
                }),
            ),
            appender.append_legacy_native_event(
                "agent.form.resolution",
                Some("form-1".to_string()),
                "2026-07-03T00:00:02Z",
                json!({
                    "formId": "form-1",
                    "action": "submit",
                    "values": { "destination": "Paris" },
                    "errors": {}
                }),
            ),
        ];

        let items = project_turn_items_from_trace_events(&events);

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].item_id, "form-1");
        assert_eq!(items[0].kind, AgentTurnItemKind::Form);
        assert_eq!(items[0].status, AgentTurnItemStatus::Completed);
        assert_eq!(items[0].title.as_deref(), Some("Configure run"));
        assert_eq!(items[0].summary.as_deref(), Some("Configure run"));
        assert_eq!(items[0].payload["status"], "completed");
        assert_eq!(items[0].payload["action"], "submit");
        assert_eq!(items[0].payload["values"]["destination"], "Paris");
        assert_eq!(items[0].payload["detailId"], "form:form-1");
        let data = serde_json::to_value(&items[0].data).expect("form data should serialize");
        assert_eq!(data["values"]["destination"], "Paris");
        assert_eq!(data["errors"], json!({}));
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
        assert_eq!(items[4].kind, AgentTurnItemKind::Approval);
        assert_eq!(items[4].status, AgentTurnItemStatus::Waiting);
        assert_eq!(items[5].kind, AgentTurnItemKind::Form);
        assert_eq!(items[5].status, AgentTurnItemStatus::Waiting);
        assert_eq!(items[6].kind, AgentTurnItemKind::SubagentLifecycle);
        assert_eq!(items[6].status, AgentTurnItemStatus::Waiting);
    }

    #[test]
    fn canonical_turn_items_cover_typed_runtime_items_with_stable_revisions() {
        let events = vec![
            runtime_event(
                "run-typed",
                "agent.plan.progress",
                AgentRuntimePhase::ToolRunning,
                Some("plan-1"),
                1,
                json!({
                    "agentItem": {
                        "type": "plan_progress",
                        "id": "plan-1",
                        "summary": "Inspect repository",
                        "completed": 0,
                        "total": 2,
                        "currentStep": "Inspect repository",
                        "steps": [
                            { "step": "Inspect repository", "status": "in_progress" },
                            { "step": "Read runtime events", "status": "pending" }
                        ]
                    }
                }),
            ),
            runtime_event(
                "run-typed",
                "agent.plan.progress",
                AgentRuntimePhase::ToolRunning,
                Some("plan-1"),
                2,
                json!({
                    "agentItem": {
                        "type": "plan_progress",
                        "id": "plan-1",
                        "summary": "Inspect repository",
                        "completed": 1,
                        "total": 2,
                        "currentStep": "Read runtime events",
                        "explanation": "Repository inspection is complete.",
                        "steps": [
                            { "step": "Inspect repository", "status": "completed" },
                            { "step": "Read runtime events", "status": "in_progress" }
                        ]
                    }
                }),
            ),
            runtime_event(
                "run-typed",
                "agent.context.compacted",
                AgentRuntimePhase::CallingModel,
                Some("run-typed:context:1"),
                3,
                json!({
                    "agentItem": {
                        "type": "context_compaction",
                        "id": "run-typed:context:1",
                        "summary": "compact",
                        "droppedItemCount": 4,
                        "estimatedTokensBefore": 12000,
                        "estimatedTokensAfter": 4200
                    }
                }),
            ),
            runtime_event(
                "run-typed",
                "agent.usage",
                AgentRuntimePhase::CallingModel,
                Some("run-typed:usage:1"),
                4,
                json!({
                    "agentItem": {
                        "type": "usage",
                        "id": "run-typed:usage:1",
                        "inputTokens": 10,
                        "outputTokens": 5,
                        "totalTokens": 15,
                        "providerPayload": {}
                    }
                }),
            ),
            runtime_event(
                "run-typed",
                "agent.file.reference",
                AgentRuntimePhase::ToolRunning,
                Some("file-1"),
                5,
                json!({
                    "agentItem": {
                        "type": "file_reference",
                        "id": "file-1",
                        "path": "output/report.md",
                        "mimeType": "text/markdown",
                        "referenceKind": "file"
                    }
                }),
            ),
            runtime_event(
                "run-typed",
                "agent.cancelled",
                AgentRuntimePhase::Cancelled,
                Some("run-typed:error:cancelled"),
                6,
                json!({
                    "agentItem": {
                        "type": "error",
                        "id": "run-typed:error:cancelled",
                        "code": "cancelled",
                        "message": "Cancelled by user",
                        "cancelled": true
                    }
                }),
            ),
        ];

        let items = serde_json::to_value(project_turn_items_from_trace_events(&events))
            .expect("canonical turn items should serialize");
        let items = items.as_array().expect("turn items should be an array");

        assert_eq!(items.len(), 5);
        assert_eq!(items[0]["schemaVersion"], "tinybot.turn_item.v2");
        assert_eq!(items[0]["turnId"], "run-typed");
        assert_eq!(items[0]["sequence"], 1);
        assert_eq!(items[0]["revision"], 2);
        assert_eq!(items[0]["kind"], "plan_progress");
        assert_eq!(items[0]["data"]["type"], "plan_progress");
        assert_eq!(items[0]["data"]["completed"], 1);
        assert_eq!(items[0]["data"]["currentStep"], "Read runtime events");
        assert_eq!(items[0]["data"]["steps"][0]["status"], "completed");
        assert_eq!(
            items[0]["data"]["explanation"],
            "Repository inspection is complete."
        );
        assert_eq!(items[1]["kind"], "context_compaction");
        assert_eq!(items[1]["data"]["estimatedTokensBefore"], 12000);
        assert_eq!(items[1]["data"]["estimatedTokensAfter"], 4200);
        assert_eq!(items[2]["kind"], "usage");
        assert_eq!(items[3]["kind"], "file_reference");
        assert_eq!(items[4]["kind"], "error");
        assert_eq!(items[4]["status"], "cancelled");
    }

    #[test]
    fn timeline_snapshot_and_patch_share_revision_and_item_projection() {
        let events = vec![
            runtime_event(
                "run-live",
                "agent.phase.changed",
                AgentRuntimePhase::CallingModel,
                None,
                8,
                json!({ "nextPhase": "calling_model" }),
            ),
            runtime_event(
                "run-live",
                "agent.delta",
                AgentRuntimePhase::StreamingModel,
                Some("assistant-1"),
                7,
                json!({ "delta": "hel" }),
            ),
            runtime_event(
                "run-live",
                "agent.delta",
                AgentRuntimePhase::StreamingModel,
                Some("assistant-1"),
                9,
                json!({ "delta": "lo" }),
            ),
        ];

        let snapshot = project_timeline_snapshot("session-1", "run-live", &events)
            .expect("timeline snapshot should project");
        let patch = project_timeline_patch("session-1", "run-live", &events)
            .expect("timeline patch should project")
            .expect("assistant delta should create a patch");

        assert_eq!(snapshot.schema_version, AGENT_TIMELINE_SCHEMA_VERSION);
        assert_eq!(snapshot.snapshot_revision, 0);
        assert_eq!(snapshot.items.len(), 1);
        assert_eq!(snapshot.items[0].sequence, 7);
        assert_eq!(snapshot.items[0].revision, 2);
        assert_eq!(patch.schema_version, AGENT_TIMELINE_PATCH_SCHEMA_VERSION);
        assert_eq!(patch.snapshot_revision, 0);
        assert_eq!(patch.item, snapshot.items[0]);
    }

    #[test]
    #[should_panic(expected = "cannot transition from Completed to Running")]
    fn canonical_projection_rejects_terminal_status_regression() {
        let events = vec![
            runtime_event(
                "run-terminal",
                "agent.tool.result",
                AgentRuntimePhase::Completed,
                Some("tool-1"),
                1,
                json!({ "toolCallId": "tool-1", "toolName": "shell" }),
            ),
            runtime_event(
                "run-terminal",
                "agent.tool.start",
                AgentRuntimePhase::ToolRunning,
                Some("tool-1"),
                2,
                json!({ "toolCallId": "tool-1", "toolName": "shell" }),
            ),
        ];

        let _ = project_timeline_snapshot("session-1", "run-terminal", &events);
    }

    #[test]
    fn canonical_projection_preserves_explicit_subagent_messages() {
        let event = runtime_event(
            "run-subagent-message",
            "agent.delegate.user_message",
            AgentRuntimePhase::AwaitingSubagent,
            Some("child-message-1"),
            1,
            json!({
                "agentItem": {
                    "type": "subagent_message",
                    "id": "child-message-1",
                    "agentId": "child-1",
                    "content": "The child found a user-relevant result.",
                    "visibility": "user"
                }
            }),
        );

        let snapshot = project_timeline_snapshot("session-1", "run-subagent-message", &[event])
            .expect("subagent message should project");

        assert_eq!(snapshot.items[0].kind, AgentTurnItemKind::SubagentMessage);
        assert_eq!(snapshot.items[0].item_id, "child-message-1");
        assert!(matches!(
            &snapshot.items[0].data,
            AgentTurnItemData::SubagentMessage { agent_id, content, .. }
                if agent_id == "child-1" && content.contains("user-relevant")
        ));
    }

    #[test]
    fn canonical_user_item_preserves_client_event_id() {
        let mut emitter = AgentTurnEmitter::new("session-1", "run-client-event");
        let event = emitter.user_turn_started(
            "2026-07-11T00:00:00Z",
            Some("user-1".to_string()),
            Some("client-message-1".to_string()),
            "hello",
            Vec::new(),
        );
        let snapshot = project_timeline_snapshot("session-1", "run-client-event", &[event])
            .expect("user item should project");
        let data = serde_json::to_value(&snapshot.items[0].data)
            .expect("canonical user data should serialize");

        assert_eq!(data["clientEventId"], "client-message-1");
    }

    #[test]
    fn canonical_user_item_preserves_tinyos_references() {
        let event = runtime_event(
            "run-tinyos-reference",
            "agent.turn.started",
            AgentRuntimePhase::HydratingHistory,
            Some("user-1"),
            0,
            json!({
                "userMessage": {
                    "id": "user-1",
                    "content": "Explain this selection",
                    "references": [{
                        "kind": "reference",
                        "title": "src/main.ts · L2",
                        "type": "tinyos.file",
                        "sourcePath": "src/main.ts",
                        "sourceLine": 2,
                        "sourceText": "let value = 1;"
                    }]
                }
            }),
        );
        let snapshot = project_timeline_snapshot("session-1", "run-tinyos-reference", &[event])
            .expect("user reference should project");
        let data = serde_json::to_value(&snapshot.items[0].data)
            .expect("canonical user data should serialize");

        assert_eq!(data["references"][0]["type"], "tinyos.file");
        assert_eq!(data["references"][0]["sourcePath"], "src/main.ts");
    }

    #[test]
    fn canonical_timeline_preserves_interleaved_model_calls_and_message_phases() {
        let events = vec![
            runtime_event(
                "run-interleaved",
                "agent.reasoning_delta",
                AgentRuntimePhase::StreamingModel,
                Some("reasoning-call-0"),
                1,
                json!({ "delta": "Inspect the workspace.", "modelCallId": "call-0" }),
            ),
            runtime_event(
                "run-interleaved",
                "agent.delta",
                AgentRuntimePhase::StreamingModel,
                Some("message-call-0"),
                2,
                json!({ "delta": "I will inspect the workspace.", "modelCallId": "call-0" }),
            ),
            runtime_event(
                "run-interleaved",
                "agent.message.classified",
                AgentRuntimePhase::ToolRunning,
                Some("message-call-0"),
                3,
                json!({ "modelCallId": "call-0", "messagePhase": "commentary" }),
            ),
            runtime_event(
                "run-interleaved",
                "agent.tool.start",
                AgentRuntimePhase::ToolRunning,
                Some("tool-1"),
                4,
                json!({ "toolCallId": "tool-1", "toolName": "workspace.read_file" }),
            ),
            runtime_event(
                "run-interleaved",
                "agent.tool.result",
                AgentRuntimePhase::ToolRunning,
                Some("tool-1"),
                5,
                json!({
                    "toolCallId": "tool-1",
                    "toolName": "workspace.read_file",
                    "result": { "ok": true }
                }),
            ),
            runtime_event(
                "run-interleaved",
                "agent.plan.progress",
                AgentRuntimePhase::ToolRunning,
                Some("plan-1"),
                6,
                json!({
                    "id": "plan-1",
                    "summary": "Inspect workspace",
                    "completed": 1,
                    "total": 1,
                    "steps": [{ "step": "Inspect workspace", "status": "completed" }]
                }),
            ),
            runtime_event(
                "run-interleaved",
                "agent.reasoning_delta",
                AgentRuntimePhase::StreamingModel,
                Some("reasoning-call-1"),
                7,
                json!({ "delta": "Summarize the result.", "modelCallId": "call-1" }),
            ),
            runtime_event(
                "run-interleaved",
                "agent.message.completed",
                AgentRuntimePhase::Completed,
                Some("message-call-1"),
                8,
                json!({
                    "content": "The workspace was inspected.",
                    "messageId": "message-call-1",
                    "modelCallId": "call-1",
                    "messagePhase": "final_answer"
                }),
            ),
        ];

        let snapshot = project_timeline_snapshot("session-1", "run-interleaved", &events)
            .expect("interleaved timeline should project");

        assert_eq!(
            snapshot
                .items
                .iter()
                .map(|item| (&item.kind, item.sequence))
                .collect::<Vec<_>>(),
            vec![
                (&AgentTurnItemKind::Reasoning, 1),
                (&AgentTurnItemKind::AssistantMessage, 2),
                (&AgentTurnItemKind::ToolCall, 4),
                (&AgentTurnItemKind::PlanProgress, 6),
                (&AgentTurnItemKind::Reasoning, 7),
                (&AgentTurnItemKind::AssistantMessage, 8),
            ]
        );
        assert!(matches!(
            &snapshot.items[1].data,
            AgentTurnItemData::AssistantMessage {
                model_call_id,
                phase: AgentAssistantMessagePhase::Commentary,
                content,
                ..
            } if model_call_id == "call-0" && content == "I will inspect the workspace."
        ));
        assert!(matches!(
            &snapshot.items[5].data,
            AgentTurnItemData::AssistantMessage {
                model_call_id,
                phase: AgentAssistantMessagePhase::FinalAnswer,
                content,
                ..
            } if model_call_id == "call-1" && content == "The workspace was inspected."
        ));
    }

    #[test]
    fn canonical_projection_omits_non_user_reasoning() {
        let mut event = runtime_event(
            "run-hidden-reasoning",
            "agent.reasoning_delta",
            AgentRuntimePhase::StreamingModel,
            Some("reasoning-1"),
            1,
            json!({ "delta": "private provider reasoning", "modelCallId": "call-0" }),
        );
        event.visibility = AgentRuntimeEventVisibility::Debug;

        let snapshot = project_timeline_snapshot("session-1", "run-hidden-reasoning", &[event])
            .expect("hidden reasoning should be ignored");

        assert!(snapshot.items.is_empty());
    }

    #[test]
    #[should_panic(expected = "cannot transition phase from Commentary to FinalAnswer")]
    fn canonical_projection_rejects_reclassifying_commentary_as_final_answer() {
        let events = vec![
            runtime_event(
                "run-phase-regression",
                "agent.message.classified",
                AgentRuntimePhase::ToolRunning,
                Some("message-1"),
                1,
                json!({ "modelCallId": "call-0", "messagePhase": "commentary" }),
            ),
            runtime_event(
                "run-phase-regression",
                "agent.message.completed",
                AgentRuntimePhase::Completed,
                Some("message-1"),
                2,
                json!({
                    "content": "Done.",
                    "modelCallId": "call-0",
                    "messagePhase": "final_answer"
                }),
            ),
        ];

        let _ = project_turn_items_from_trace_events(&events);
    }

    #[test]
    fn canonical_timeline_rejects_work_after_final_answer() {
        let events = vec![
            runtime_event(
                "run-post-final",
                "agent.message.completed",
                AgentRuntimePhase::Completed,
                Some("message-1"),
                1,
                json!({
                    "content": "Done.",
                    "modelCallId": "call-0",
                    "messagePhase": "final_answer"
                }),
            ),
            runtime_event(
                "run-post-final",
                "agent.tool.start",
                AgentRuntimePhase::ToolRunning,
                Some("tool-1"),
                2,
                json!({ "toolCallId": "tool-1", "toolName": "shell" }),
            ),
        ];

        let error = project_timeline_snapshot("session-1", "run-post-final", &events)
            .expect_err("post-final work must be rejected");

        assert!(error.contains("appears after final answer"));
    }

    #[test]
    fn incremental_timeline_projector_matches_full_projection_at_every_event() {
        let events = vec![
            runtime_event(
                "run-incremental",
                "agent.reasoning_delta",
                AgentRuntimePhase::StreamingModel,
                Some("reasoning-call-0"),
                1,
                json!({ "delta": "Inspect.", "modelCallId": "call-0" }),
            ),
            runtime_event(
                "run-incremental",
                "agent.delta",
                AgentRuntimePhase::StreamingModel,
                Some("message-call-0"),
                2,
                json!({ "delta": "Checking.", "modelCallId": "call-0" }),
            ),
            runtime_event(
                "run-incremental",
                "agent.message.classified",
                AgentRuntimePhase::ToolRunning,
                Some("message-call-0"),
                3,
                json!({ "modelCallId": "call-0", "messagePhase": "commentary" }),
            ),
            runtime_event(
                "run-incremental",
                "agent.tool.start",
                AgentRuntimePhase::ToolRunning,
                Some("tool-1"),
                4,
                json!({ "toolCallId": "tool-1", "toolName": "workspace.read_file" }),
            ),
            runtime_event(
                "run-incremental",
                "agent.tool.result",
                AgentRuntimePhase::ToolRunning,
                Some("tool-1"),
                5,
                json!({ "toolCallId": "tool-1", "toolName": "workspace.read_file", "result": { "ok": true } }),
            ),
            runtime_event(
                "run-incremental",
                "agent.message.completed",
                AgentRuntimePhase::Completed,
                Some("message-call-1"),
                6,
                json!({
                    "content": "Done.",
                    "modelCallId": "call-1",
                    "messagePhase": "final_answer"
                }),
            ),
        ];
        let mut projector = AgentTimelineProjector::new("session-1", "run-incremental");
        let mut prefix = Vec::new();

        for event in events {
            prefix.push(event.clone());
            let patch = projector
                .apply_event(&event)
                .expect("incremental event should project");
            let incremental = projector
                .snapshot()
                .expect("incremental snapshot should build");
            let full = project_timeline_snapshot("session-1", "run-incremental", &prefix)
                .expect("full snapshot should build");

            assert_eq!(incremental, full);
            if let Some(patch) = patch {
                assert_eq!(patch.snapshot_revision, full.snapshot_revision);
                assert_eq!(
                    Some(&patch.item),
                    full.items
                        .iter()
                        .find(|item| item.item_id == patch.item.item_id)
                );
            }
        }
    }

    #[test]
    fn live_deltas_do_not_advance_durable_timeline_revision() {
        let events = vec![
            runtime_event(
                "run-durable-revision",
                "agent.reasoning_delta",
                AgentRuntimePhase::StreamingModel,
                Some("reasoning-1"),
                1,
                json!({"delta": "Inspect "}),
            ),
            runtime_event(
                "run-durable-revision",
                "agent.reasoning.completed",
                AgentRuntimePhase::StreamingModel,
                Some("reasoning-1"),
                2,
                json!({"summary": "Inspect first."}),
            ),
            runtime_event(
                "run-durable-revision",
                "agent.delta",
                AgentRuntimePhase::Finalizing,
                Some("assistant-1"),
                3,
                json!({"delta": "Done."}),
            ),
            runtime_event(
                "run-durable-revision",
                "agent.message.completed",
                AgentRuntimePhase::Completed,
                Some("assistant-1"),
                4,
                json!({"content": "Done.", "messagePhase": "final_answer"}),
            ),
        ];
        let mut projector = AgentTimelineProjector::new("session-1", "run-durable-revision");
        let revisions = events
            .iter()
            .map(|event| {
                projector
                    .apply_event(event)
                    .unwrap()
                    .map(|patch| patch.snapshot_revision)
                    .unwrap()
            })
            .collect::<Vec<_>>();

        assert_eq!(revisions, vec![0, 1, 1, 2]);
        assert_eq!(projector.snapshot().unwrap().snapshot_revision, 2);
        assert_eq!(
            project_timeline_snapshot("session-1", "run-durable-revision", &events)
                .unwrap()
                .snapshot_revision,
            2
        );
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
            thread_id: None,
            turn_id: turn_id.to_string(),
            parent_turn_id: None,
            item_id: item_id.map(str::to_string),
            event_name: event_name.to_string(),
            phase,
            timestamp: format!("2026-07-03T00:00:{sequence:02}Z"),
            source: AgentRuntimeEventSource::RustBackend,
            visibility: AgentRuntimeEventVisibility::User,
            trace_context: None,
            payload,
        }
    }
}
