#[cfg(test)]
use super::PendingAgentEvent;
use super::{
    AgentEventKind, AgentRuntimeEventEnvelope, AgentRuntimePhase, AgentTraceContext,
    AGENT_RUNTIME_EVENT_SCHEMA_VERSION,
};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct AgentRuntimeEventAppendInput {
    pub(crate) parent_turn_id: Option<String>,
    pub(crate) item_id: Option<String>,
    pub(crate) event_kind: AgentEventKind,
    pub(crate) phase: AgentRuntimePhase,
    pub(crate) timestamp: String,
    pub(crate) payload: Value,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct AgentRuntimeEventEnvelopeInput {
    pub(crate) session_id: String,
    pub(crate) thread_id: Option<String>,
    pub(crate) turn_id: String,
    pub(crate) parent_turn_id: Option<String>,
    pub(crate) item_id: Option<String>,
    pub(crate) event_kind: AgentEventKind,
    pub(crate) phase: AgentRuntimePhase,
    pub(crate) sequence: u64,
    pub(crate) timestamp: String,
    pub(crate) trace_context: Option<AgentTraceContext>,
    pub(crate) payload: Value,
}

impl AgentRuntimeEventEnvelope {
    pub(crate) fn from_event_kind(input: AgentRuntimeEventEnvelopeInput) -> Self {
        let definition = input.event_kind.definition();
        let event_name = definition.wire_name.to_string();
        Self {
            schema_version: AGENT_RUNTIME_EVENT_SCHEMA_VERSION.to_string(),
            event_id: deterministic_event_id(&input.turn_id, &event_name, input.sequence),
            sequence: input.sequence,
            session_id: input.session_id,
            thread_id: input.thread_id,
            turn_id: input.turn_id,
            parent_turn_id: input.parent_turn_id,
            item_id: input.item_id,
            event_name,
            phase: input.phase,
            timestamp: input.timestamp,
            source: definition.source,
            visibility: definition.visibility,
            trace_context: input.trace_context,
            payload: input.payload,
        }
    }
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
        AgentRuntimeEventEnvelope::from_event_kind(AgentRuntimeEventEnvelopeInput {
            session_id: self.session_id.clone(),
            thread_id: self.thread_id.clone(),
            turn_id: self.turn_id.clone(),
            trace_context: self.trace_context.clone(),
            sequence,
            event_kind: input.event_kind,
            phase: input.phase,
            timestamp: input.timestamp,
            payload: input.payload,
            parent_turn_id: input.parent_turn_id,
            item_id: input.item_id,
        })
    }

    #[cfg(test)]
    pub fn append_event(
        &mut self,
        event_kind: AgentEventKind,
        item_id: Option<String>,
        timestamp: impl Into<String>,
        payload: Value,
    ) -> AgentRuntimeEventEnvelope {
        let definition = event_kind.definition();
        let phase = definition
            .resolve_phase(&AgentRuntimePhase::Planning, &payload)
            .expect("typed test event must resolve catalog metadata");
        self.append(AgentRuntimeEventAppendInput {
            parent_turn_id: None,
            item_id,
            event_kind,
            phase,
            timestamp: timestamp.into(),
            payload,
        })
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

    #[cfg(test)]
    fn emit_pending(
        &mut self,
        timestamp: impl Into<String>,
        event: PendingAgentEvent,
    ) -> AgentRuntimeEventEnvelope {
        let (kind, payload, parent_turn_id, item_id) = event.into_parts();
        let definition = kind.definition();
        let phase = definition
            .resolve_phase(&AgentRuntimePhase::Planning, &payload)
            .expect("typed test event must resolve catalog metadata");
        self.emit(AgentRuntimeEventAppendInput {
            parent_turn_id,
            item_id,
            event_kind: kind,
            phase,
            timestamp: timestamp.into(),
            payload,
        })
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
        self.emit_pending(
            timestamp,
            PendingAgentEvent::new(
                AgentEventKind::PhaseChanged,
                serde_json::json!({
                    "previousPhase": from.as_str(),
                    "nextPhase": to.as_str()
                }),
            ),
        )
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
        self.emit_pending(
            timestamp,
            PendingAgentEvent::new(AgentEventKind::Status, Value::Object(payload)),
        )
    }

    #[cfg(test)]
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
        self.emit_pending(
            timestamp,
            PendingAgentEvent::new(AgentEventKind::TurnStarted, payload),
        )
    }

    #[cfg(test)]
    pub fn assistant_delta(
        &mut self,
        timestamp: impl Into<String>,
        delta: impl Into<String>,
    ) -> AgentRuntimeEventEnvelope {
        self.emit_pending(
            timestamp,
            PendingAgentEvent::new(
                AgentEventKind::MessageDelta,
                serde_json::json!({ "delta": delta.into() }),
            ),
        )
    }

    #[cfg(test)]
    pub fn message_completed(
        &mut self,
        timestamp: impl Into<String>,
        message_id: Option<String>,
        content: impl Into<String>,
    ) -> AgentRuntimeEventEnvelope {
        self.emit_pending(
            timestamp,
            PendingAgentEvent::new(
                AgentEventKind::MessageCompleted,
                serde_json::json!({
                    "messageId": message_id,
                    "content": content.into()
                }),
            ),
        )
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
        self.emit_pending(
            timestamp,
            PendingAgentEvent::new(
                AgentEventKind::ToolStarted,
                serde_json::json!({
                    "toolCallId": tool_call_id.clone(),
                    "toolName": tool_name.into(),
                    "args": args
                }),
            )
            .with_item_id(Some(tool_call_id)),
        )
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
        self.emit_pending(
            timestamp,
            PendingAgentEvent::new(
                AgentEventKind::ToolResult,
                serde_json::json!({
                    "toolCallId": tool_call_id.clone(),
                    "toolName": tool_name.into(),
                    "envelope": envelope
                }),
            )
            .with_item_id(Some(tool_call_id)),
        )
    }
}
pub(super) fn deterministic_event_id(turn_id: &str, event_name: &str, sequence: u64) -> String {
    format!(
        "{}:{}:{:016}",
        turn_id,
        safe_event_fragment(event_name),
        sequence
    )
}

pub(super) fn safe_event_fragment(event_name: &str) -> String {
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
