use super::appender::safe_event_fragment;
use super::{
    resolve_event_name, AgentAssistantMessagePhase, AgentEventKind, AgentRuntimeEventEnvelope,
    AgentRuntimeEventVisibility, AgentRuntimePhase, AgentTimelinePatch, AgentTimelineSnapshot,
    AgentTurnItem, AgentTurnItemData, AgentTurnItemKind, AgentTurnItemStatus, EventNameResolution,
    AGENT_TIMELINE_PATCH_SCHEMA_VERSION, AGENT_TIMELINE_SCHEMA_VERSION,
    AGENT_TURN_ITEM_SCHEMA_VERSION,
};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Clone, Debug)]
pub struct AgentTimelineProjector {
    session_id: String,
    turn_id: String,
    order: Vec<String>,
    items: HashMap<String, AgentTurnItem>,
    assistant_phases: HashMap<String, AgentAssistantMessagePhase>,
    snapshot_revision: u64,
    final_answer: Option<String>,
}

pub fn project_turn_items_from_trace_events(
    events: &[AgentRuntimeEventEnvelope],
) -> Vec<AgentTurnItem> {
    let mut order = Vec::new();
    let mut items = HashMap::<String, AgentTurnItem>::new();
    let mut assistant_phases = HashMap::<String, AgentAssistantMessagePhase>::new();

    for event in events {
        match canonical_event_kind(event) {
            Ok(Some(kind)) => {
                apply_trace_event_to_items(
                    &mut order,
                    &mut items,
                    &mut assistant_phases,
                    event,
                    kind,
                )
                .unwrap_or_else(|error| panic!("{error}"));
            }
            Ok(None) => {}
            Err(error) => panic!("{error}"),
        }
    }

    order
        .into_iter()
        .filter_map(|item_id| items.remove(&item_id))
        .collect()
}

fn apply_trace_event_to_items(
    order: &mut Vec<String>,
    items: &mut HashMap<String, AgentTurnItem>,
    assistant_phases: &mut HashMap<String, AgentAssistantMessagePhase>,
    event: &AgentRuntimeEventEnvelope,
    event_kind: AgentEventKind,
) -> Result<Option<String>, String> {
    let Some(kind) = projected_item_kind(event, event_kind) else {
        return Ok(None);
    };
    let item_id = event
        .item_id
        .clone()
        .unwrap_or_else(|| projected_item_id(event, &kind));
    if kind == AgentTurnItemKind::AssistantMessage
        && matches!(
            event_kind,
            AgentEventKind::MessageClassified | AgentEventKind::MessageCompleted
        )
    {
        validate_and_record_assistant_phase(
            assistant_phases,
            &item_id,
            assistant_message_phase(&event.payload, event_kind),
        )?;
    }
    if kind == AgentTurnItemKind::AssistantMessage
        && !items.contains_key(&item_id)
        && matches!(
            event_kind,
            AgentEventKind::MessageClassified | AgentEventKind::MessageCompleted
        )
        && !assistant_event_has_content(event)
    {
        return Ok(None);
    }
    let status = projected_item_status(event, event_kind);
    let payload = projected_item_payload(
        items.get(&item_id).map(|item| &item.payload),
        event,
        event_kind,
    );
    let title = projected_item_title(&kind, items.get(&item_id), &payload);
    let summary = projected_item_summary(&kind, items.get(&item_id), &payload);
    let data = projected_item_data(&kind, &payload, event, event_kind);

    if let Some(item) = items.get_mut(&item_id) {
        if item.kind != kind {
            return Err(format!(
                "canonical timeline item `{item_id}` changed kind from {:?} to {:?}",
                item.kind, kind
            ));
        }
        if matches!(
            item.status,
            AgentTurnItemStatus::Completed
                | AgentTurnItemStatus::Failed
                | AgentTurnItemStatus::Cancelled
        ) && item.status != status
        {
            return Err(format!(
                "canonical timeline item `{item_id}` cannot transition from {:?} to {:?}",
                item.status, status
            ));
        }
        validate_assistant_phase_transition(&item.data, &data, &item_id)?;
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
    Ok(Some(item_id))
}

impl AgentTimelineProjector {
    pub fn new(session_id: impl Into<String>, turn_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            turn_id: turn_id.into(),
            order: Vec::new(),
            items: HashMap::new(),
            assistant_phases: HashMap::new(),
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
        let Some(event_kind) = canonical_event_kind(event)? else {
            return Ok(None);
        };
        let Some(item_id) = apply_trace_event_to_items(
            &mut self.order,
            &mut self.items,
            &mut self.assistant_phases,
            event,
            event_kind,
        )?
        else {
            return Ok(None);
        };
        if event_kind.definition().is_durable() {
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

    pub fn snapshot(&self) -> Result<AgentTimelineSnapshot, String> {
        let items = self
            .order
            .iter()
            .filter_map(|item_id| self.items.get(item_id).cloned())
            .collect::<Vec<_>>();
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
        if let Some(final_item_id) = self.final_answer.as_ref() {
            if item.item_id != *final_item_id && item_is_disallowed_after_final(item) {
                return Err(format!(
                    "canonical timeline item `{}` appears after final answer `{}`",
                    item.item_id, final_item_id
                ));
            }
        }
        if !item_is_final_answer(item) || self.final_answer.is_some() {
            return Ok(());
        }
        self.final_answer = Some(item.item_id.clone());
        Ok(())
    }
}

pub fn project_timeline_snapshot(
    session_id: &str,
    turn_id: &str,
    events: &[AgentRuntimeEventEnvelope],
) -> Result<AgentTimelineSnapshot, String> {
    AgentTimelineProjector::from_events(session_id, turn_id, events)?.snapshot()
}

pub fn is_durable_agent_timeline_event(event_name: &str) -> bool {
    match resolve_event_name(event_name) {
        EventNameResolution::Canonical(kind) => kind.definition().is_durable(),
        EventNameResolution::DeprecatedIgnored(_) => false,
        EventNameResolution::Unknown => {
            panic!("unknown canonical runtime event `{event_name}`")
        }
    }
}

fn canonical_event_kind(
    event: &AgentRuntimeEventEnvelope,
) -> Result<Option<AgentEventKind>, String> {
    match resolve_event_name(&event.event_name) {
        EventNameResolution::Canonical(kind) => Ok(Some(kind)),
        EventNameResolution::DeprecatedIgnored(kind) => {
            eprintln!(
                "agent_runtime_deprecated_event_ignored event_name={} session_id={} turn_id={} terminal_reason=deprecated_provider_lifecycle",
                kind.wire_name(),
                event.session_id,
                event.turn_id,
            );
            Ok(None)
        }
        EventNameResolution::Unknown => Err(format!(
            "unknown canonical runtime event `{}`",
            event.event_name
        )),
    }
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
    let Some(event_kind) = canonical_event_kind(event)? else {
        return Ok(None);
    };
    let Some(kind) = projected_item_kind(event, event_kind) else {
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

fn projected_item_kind(
    event: &AgentRuntimeEventEnvelope,
    event_kind: AgentEventKind,
) -> Option<AgentTurnItemKind> {
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
    if event_kind == AgentEventKind::Done {
        return done_event_has_final_content(&event.payload)
            .then_some(AgentTurnItemKind::AssistantMessage);
    }
    event_kind
        .definition()
        .item_kind
        .and_then(|kind| visible_item_kind(event, kind))
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
    event_kind: AgentEventKind,
) -> AgentAssistantMessagePhase {
    match item_string(payload, &["messagePhase", "message_phase", "phase"]).as_deref() {
        Some("commentary") => AgentAssistantMessagePhase::Commentary,
        Some("final_answer") => AgentAssistantMessagePhase::FinalAnswer,
        Some("unknown") | None if event_kind == AgentEventKind::MessageCompleted => {
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
) -> Result<(), String> {
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
        return Ok(());
    };
    validate_assistant_phase_change(*previous_phase, *next_phase, item_id)
}

fn validate_and_record_assistant_phase(
    phases: &mut HashMap<String, AgentAssistantMessagePhase>,
    item_id: &str,
    next_phase: AgentAssistantMessagePhase,
) -> Result<(), String> {
    let previous_phase = phases
        .get(item_id)
        .copied()
        .unwrap_or(AgentAssistantMessagePhase::Unknown);
    validate_assistant_phase_change(previous_phase, next_phase, item_id)?;
    if previous_phase == AgentAssistantMessagePhase::Unknown {
        phases.insert(item_id.to_string(), next_phase);
    }
    Ok(())
}

fn validate_assistant_phase_change(
    previous_phase: AgentAssistantMessagePhase,
    next_phase: AgentAssistantMessagePhase,
    item_id: &str,
) -> Result<(), String> {
    if previous_phase == next_phase || previous_phase == AgentAssistantMessagePhase::Unknown {
        return Ok(());
    }
    Err(format!(
        "canonical assistant item `{item_id}` cannot transition phase from {previous_phase:?} to {next_phase:?}"
    ))
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
    event_kind: AgentEventKind,
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
            legacy_item_data(kind, payload, event, event_kind)
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
                        event_kind
                            .delegate_action()
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
        _ => legacy_item_data(kind, payload, event, event_kind),
    }
}

fn legacy_item_data(
    kind: &AgentTurnItemKind,
    payload: &Value,
    event: &AgentRuntimeEventEnvelope,
    event_kind: AgentEventKind,
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
            phase: assistant_message_phase(payload, event_kind),
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
            result_status: item_string(payload, &["resultStatus", "result_status"]),
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
            context_window_tokens: payload
                .get("contextWindowTokens")
                .or_else(|| payload.get("context_window_tokens"))
                .and_then(Value::as_u64),
            strategy: item_string(
                payload,
                &[
                    "strategy",
                    "contextWindowStrategy",
                    "context_window_strategy",
                ],
            ),
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
                context_window_remaining_tokens: item_i64(
                    usage,
                    &[
                        "contextWindowRemainingTokens",
                        "context_window_remaining_tokens",
                    ],
                ),
                context_window_strategy: item_string(
                    usage,
                    &["contextWindowStrategy", "context_window_strategy"],
                ),
                context_window_tokens: item_i64(
                    usage,
                    &["contextWindowTokens", "context_window_tokens"],
                ),
                context_window_used_tokens: item_i64(
                    usage,
                    &["contextWindowUsedTokens", "context_window_used_tokens"],
                ),
                estimated_context_tokens: item_i64(
                    usage,
                    &["estimatedContextTokens", "estimated_context_tokens"],
                ),
                percent: item_f64(usage, &["percent"]),
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
            code: item_string(payload, &["stopReason", "code"]).unwrap_or_else(|| {
                event_kind
                    .wire_name()
                    .trim_start_matches("agent.")
                    .to_string()
            }),
            message: item_string(payload, &["message", "error"])
                .unwrap_or_else(|| event.event_name.clone()),
            command_id: item_string(payload, &["commandId", "command_id"]),
            cancelled: event_kind == AgentEventKind::Cancelled
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

fn item_f64(payload: &Value, keys: &[&str]) -> Option<f64> {
    keys.iter()
        .find_map(|key| payload.get(*key).and_then(Value::as_f64))
}

fn required_item_string(payload: &Value, keys: &[&str], kind: &AgentTurnItemKind) -> String {
    item_string(payload, keys).unwrap_or_else(|| {
        panic!(
            "canonical item `{kind:?}` requires one of: {}",
            keys.join(", ")
        )
    })
}

fn projected_item_status(
    event: &AgentRuntimeEventEnvelope,
    event_kind: AgentEventKind,
) -> AgentTurnItemStatus {
    match event_kind {
        AgentEventKind::PlanProgress
            if event
                .payload
                .get("completed")
                .and_then(Value::as_u64)
                .zip(event.payload.get("total").and_then(Value::as_u64))
                .is_some_and(|(completed, total)| total > 0 && completed == total) =>
        {
            AgentTurnItemStatus::Completed
        }
        AgentEventKind::MessageClassified
        | AgentEventKind::MessageCompleted
        | AgentEventKind::ReasoningCompleted
        | AgentEventKind::Done
        | AgentEventKind::CommandAcknowledged
        | AgentEventKind::Paused
        | AgentEventKind::Resumed
        | AgentEventKind::ToolResult
        | AgentEventKind::FormResolution => AgentTurnItemStatus::Completed,
        AgentEventKind::Error | AgentEventKind::CleanupTimeout => AgentTurnItemStatus::Failed,
        AgentEventKind::Cancelled => AgentTurnItemStatus::Cancelled,
        AgentEventKind::AwaitingForm => AgentTurnItemStatus::Waiting,
        _ => match &event.phase {
            AgentRuntimePhase::Completed => AgentTurnItemStatus::Completed,
            AgentRuntimePhase::Failed => AgentTurnItemStatus::Failed,
            AgentRuntimePhase::Cancelled => AgentTurnItemStatus::Cancelled,
            AgentRuntimePhase::AwaitingForm
            | AgentRuntimePhase::AwaitingSubagent
            | AgentRuntimePhase::Paused => AgentTurnItemStatus::Waiting,
            _ => AgentTurnItemStatus::Running,
        },
    }
}

fn projected_item_payload(
    existing_payload: Option<&Value>,
    event: &AgentRuntimeEventEnvelope,
    event_kind: AgentEventKind,
) -> Value {
    match event_kind {
        AgentEventKind::TurnStarted => projected_user_payload(event),
        AgentEventKind::MessageDelta | AgentEventKind::ReasoningDelta => {
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
        AgentEventKind::ReasoningCompleted => {
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
        AgentEventKind::MessagePhase | AgentEventKind::MessageClassified => {
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
        AgentEventKind::MessageCompleted => projected_completed_message_payload(event),
        AgentEventKind::Done => projected_legacy_done_payload(event),
        AgentEventKind::ToolStarted | AgentEventKind::ToolResult => {
            projected_tool_payload(existing_payload, event, event_kind)
        }
        AgentEventKind::AwaitingForm | AgentEventKind::FormResolution => {
            projected_form_payload(existing_payload, event, event_kind)
        }
        AgentEventKind::Usage => projected_usage_payload(event),
        _ => event.payload.clone(),
    }
}

fn projected_usage_payload(event: &AgentRuntimeEventEnvelope) -> Value {
    let mut payload = event.payload.as_object().cloned().unwrap_or_default();
    let has_typed_usage = payload
        .get("agentItem")
        .and_then(|item| item.get("type"))
        .and_then(Value::as_str)
        == Some("usage");
    if has_typed_usage {
        payload.remove("usage");
        payload.remove("providerUsage");
        payload.remove("provider_usage");
    }
    Value::Object(payload)
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
    event_kind: AgentEventKind,
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

    let lifecycle_status = if event_kind == AgentEventKind::ToolResult {
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
    if event_kind == AgentEventKind::ToolResult && !payload.contains_key("result") {
        if let Some(result) = payload
            .get("envelope")
            .and_then(|envelope| envelope.get("raw"))
            .filter(|result| !result.is_null())
            .cloned()
        {
            payload.insert("result".to_string(), result);
        }
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
    if event_kind == AgentEventKind::ToolStarted {
        timing
            .entry("startedAt".to_string())
            .or_insert_with(|| Value::String(event.timestamp.clone()));
    }
    if event_kind == AgentEventKind::ToolResult {
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

fn projected_form_payload(
    existing_payload: Option<&Value>,
    event: &AgentRuntimeEventEnvelope,
    event_kind: AgentEventKind,
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

    if event_kind == AgentEventKind::FormResolution {
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

fn assistant_event_has_content(event: &AgentRuntimeEventEnvelope) -> bool {
    let payload = event.payload.get("agentItem").unwrap_or(&event.payload);
    payload_text_fragment(payload).is_some_and(|content| !content.trim().is_empty())
}

fn done_event_has_final_content(payload: &Value) -> bool {
    ["finalContent", "content", "text"]
        .into_iter()
        .filter_map(|key| payload.get(key).and_then(Value::as_str))
        .any(|value| !value.trim().is_empty())
}
