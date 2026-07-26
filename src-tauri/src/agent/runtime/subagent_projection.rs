use super::tool_dispatcher::is_subagent_tool;
use super::{string_field, AgentTurnContext, NativeAgentToolCall, NativeAgentToolResult};
use crate::agent::runtime_protocol::{AgentEventKind, PendingAgentEvent};
use serde_json::{Map, Value};

pub(super) fn project_subagent_tool_result(
    context: &AgentTurnContext,
    tool_call: &NativeAgentToolCall,
    result: &NativeAgentToolResult,
) -> Result<Vec<PendingAgentEvent>, String> {
    let mut events = Vec::new();
    if let Some(link_event) = subagent_link_event(context, tool_call, result) {
        events.push(link_event);
    }
    events.extend(subagent_activity_events(context, tool_call, result)?);
    Ok(events)
}

fn subagent_link_event(
    context: &AgentTurnContext,
    tool_call: &NativeAgentToolCall,
    result: &NativeAgentToolResult,
) -> Option<PendingAgentEvent> {
    if !matches!(tool_call.name.as_str(), "subagent.spawn" | "spawn_agent") {
        return None;
    }
    let raw = result.envelope.get("raw")?;
    if raw.get("accepted").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let subagent = raw.get("subagent")?;
    let subagent_id = string_field(subagent, "subagentId").or_else(|| {
        raw.get("event")
            .and_then(|event| string_field(event, "delegateId"))
    })?;
    let child_turn_id = string_field(subagent, "childTurnId")
        .or_else(|| {
            raw.get("event")
                .and_then(|event| string_field(event, "childTurnId"))
        })
        .unwrap_or_else(|| subagent_id.clone());
    let mut payload = common_payload(&context.turn_id, &tool_call.id);
    payload.insert("delegateId".to_string(), Value::String(subagent_id.clone()));
    payload.insert("subagentId".to_string(), Value::String(subagent_id));
    payload.insert("childTurnId".to_string(), Value::String(child_turn_id));
    copy_field(&mut payload, subagent, "traceRef");
    copy_field(&mut payload, subagent, "name");
    copy_field(&mut payload, subagent, "task");
    copy_field(&mut payload, subagent, "status");
    payload.insert(
        "linkType".to_string(),
        Value::String("parent_child".to_string()),
    );
    Some(
        PendingAgentEvent::new(AgentEventKind::DelegateLinked, Value::Object(payload))
            .with_parent_turn_id(Some(context.turn_id.clone())),
    )
}

fn subagent_activity_events(
    context: &AgentTurnContext,
    tool_call: &NativeAgentToolCall,
    result: &NativeAgentToolResult,
) -> Result<Vec<PendingAgentEvent>, String> {
    if !is_subagent_tool(&tool_call.name) {
        return Ok(Vec::new());
    }
    let Some(raw) = result.envelope.get("raw") else {
        return Ok(Vec::new());
    };
    let mut events = Vec::new();
    if let Some(background_event) = raw.get("event") {
        if let Some(event) =
            subagent_background_activity_event(context, background_event, &tool_call.id)?
        {
            if event.kind() != AgentEventKind::DelegateStarted {
                events.push(event);
            }
        }
    }

    match tool_call.name.as_str() {
        "subagent.wait" | "wait_agent" => {
            let mut payload = common_payload(&context.turn_id, &tool_call.id);
            copy_field(&mut payload, raw, "timedOut");
            payload.insert(
                "statuses".to_string(),
                raw.get("statuses")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!([])),
            );
            events.push(
                PendingAgentEvent::new(AgentEventKind::DelegateWait, Value::Object(payload))
                    .with_parent_turn_id(Some(context.turn_id.clone())),
            );
            if let Some(statuses) = raw.get("statuses").and_then(Value::as_array) {
                for status in statuses {
                    if status
                        .get("terminalResult")
                        .and_then(Value::as_str)
                        .is_some()
                    {
                        events.push(subagent_status_activity_event(
                            context,
                            AgentEventKind::DelegateResult,
                            "result",
                            status,
                            &tool_call.id,
                        ));
                    }
                    if status
                        .get("blockerSummary")
                        .and_then(Value::as_str)
                        .is_some()
                        || status
                            .get("pendingApproval")
                            .is_some_and(|value| !value.is_null())
                    {
                        events.push(subagent_status_activity_event(
                            context,
                            AgentEventKind::DelegateNotification,
                            "notification",
                            status,
                            &tool_call.id,
                        ));
                    }
                }
            }
        }
        "subagent.query" => {
            if let Some(subagent) = raw.get("subagent") {
                events.push(subagent_status_activity_event(
                    context,
                    AgentEventKind::DelegateQueried,
                    "query",
                    subagent,
                    &tool_call.id,
                ));
            }
        }
        _ => {}
    }
    Ok(events)
}

fn subagent_background_activity_event(
    context: &AgentTurnContext,
    background_event: &Value,
    source_tool_call_id: &str,
) -> Result<Option<PendingAgentEvent>, String> {
    let Some(event_name) = string_field(background_event, "eventType") else {
        return Ok(None);
    };
    let parent_turn_id =
        string_field(background_event, "turnId").unwrap_or_else(|| context.turn_id.clone());
    let mut payload = background_event
        .get("payload")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    payload.extend(common_payload(&parent_turn_id, source_tool_call_id));
    if let Some(delegate_id) = string_field(background_event, "delegateId") {
        payload.insert("delegateId".to_string(), Value::String(delegate_id.clone()));
        payload.insert("subagentId".to_string(), Value::String(delegate_id));
    }
    copy_string_field(&mut payload, background_event, "childTurnId");
    copy_string_field(&mut payload, background_event, "traceRef");
    if let Some(sequence) = background_event.get("sequence").cloned() {
        payload.insert("delegateSequence".to_string(), sequence);
    }
    if let Some(event_id) = string_field(background_event, "eventId") {
        payload.insert("delegateEventId".to_string(), Value::String(event_id));
    }
    Ok(Some(
        PendingAgentEvent::try_from_wire_name(&event_name, Value::Object(payload))?
            .with_parent_turn_id(Some(parent_turn_id)),
    ))
}

fn subagent_status_activity_event(
    context: &AgentTurnContext,
    kind: AgentEventKind,
    activity: &str,
    subagent: &Value,
    source_tool_call_id: &str,
) -> PendingAgentEvent {
    let parent_turn_id =
        string_field(subagent, "parentTurnId").unwrap_or_else(|| context.turn_id.clone());
    let mut payload = common_payload(&parent_turn_id, source_tool_call_id);
    let subagent_id = subagent.get("subagentId").cloned().unwrap_or(Value::Null);
    payload.insert("delegateId".to_string(), subagent_id.clone());
    payload.insert("subagentId".to_string(), subagent_id);
    for field in [
        "childTurnId",
        "traceRef",
        "name",
        "task",
        "status",
        "terminalResult",
        "blockerSummary",
        "pendingApproval",
    ] {
        copy_field(&mut payload, subagent, field);
    }
    payload.insert("activity".to_string(), Value::String(activity.to_string()));
    PendingAgentEvent::new(kind, Value::Object(payload)).with_parent_turn_id(Some(parent_turn_id))
}

fn common_payload(parent_turn_id: &str, source_tool_call_id: &str) -> Map<String, Value> {
    Map::from_iter([
        (
            "parentTurnId".to_string(),
            Value::String(parent_turn_id.to_string()),
        ),
        (
            "sourceToolCallId".to_string(),
            Value::String(source_tool_call_id.to_string()),
        ),
    ])
}

fn copy_field(payload: &mut Map<String, Value>, source: &Value, field: &str) {
    payload.insert(
        field.to_string(),
        source.get(field).cloned().unwrap_or(Value::Null),
    );
}

fn copy_string_field(payload: &mut Map<String, Value>, source: &Value, field: &str) {
    if let Some(value) = string_field(source, field) {
        payload.insert(field.to_string(), Value::String(value));
    }
}
