use super::{typed_response_item, value_event, EventKind, ThreadLogItem, ThreadLogLine};
use crate::agent::runtime_protocol::{resolve_event_name, AgentEventKind, EventNameResolution};
use crate::protocol::{WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource};
use crate::threads::rollout::format::SessionApiMode;
use serde_json::Value;
use std::collections::HashSet;

#[derive(Clone, Debug, PartialEq)]
pub(super) enum ProtocolEventProjection {
    ResponseItems(Vec<Value>),
    AlreadyRepresented { call_id: String },
}

pub(super) enum SemanticBatchProjection {
    AlreadyRepresented,
    Append {
        items: Vec<ThreadLogItem>,
        latest_total_tokens: Option<i64>,
        appended_response_items: bool,
    },
}

pub(super) fn project_validated_semantic_batch(
    session_id: &str,
    turn_id: &str,
    timestamp: &str,
    events: &[Value],
    api_mode: SessionApiMode,
    existing_lines: &[ThreadLogLine],
) -> Result<SemanticBatchProjection, WorkerProtocolError> {
    let mut items = Vec::new();
    let mut represented_function_calls = response_function_call_ids(existing_lines, turn_id);
    let mut appended_response_items = false;
    let mut already_represented_events = 0usize;
    for (index, event) in events.iter().cloned().enumerate() {
        let projected = project_validated_semantic_event(
            session_id,
            turn_id,
            timestamp,
            index,
            event,
            api_mode,
            &mut represented_function_calls,
        )?;
        if projected.already_represented {
            already_represented_events = already_represented_events.saturating_add(1);
        }
        appended_response_items |= projected.appended_response_items;
        items.extend(projected.items);
    }
    if items.is_empty() {
        if already_represented_events == events.len() {
            return Ok(SemanticBatchProjection::AlreadyRepresented);
        }
        return Err(invalid_turn_semantic_event_error(
            "agent turn semantic batch contains no canonical records",
            session_id,
            turn_id,
            0,
            None,
        ));
    }
    Ok(SemanticBatchProjection::Append {
        items,
        latest_total_tokens: latest_total_tokens(events),
        appended_response_items,
    })
}

struct ProjectedSemanticEvent {
    items: Vec<ThreadLogItem>,
    appended_response_items: bool,
    already_represented: bool,
}

#[allow(clippy::too_many_arguments)]
fn project_validated_semantic_event(
    session_id: &str,
    turn_id: &str,
    timestamp: &str,
    index: usize,
    event: Value,
    api_mode: SessionApiMode,
    represented_function_calls: &mut HashSet<String>,
) -> Result<ProjectedSemanticEvent, WorkerProtocolError> {
    let (response_items, already_represented) = match project_response_items(&event, api_mode) {
        ProtocolEventProjection::ResponseItems(response_items) => (response_items, false),
        ProtocolEventProjection::AlreadyRepresented { call_id } => {
            if !represented_function_calls.contains(&call_id) {
                return Err(unrepresented_responses_tool_call_error(
                    session_id, turn_id, index, &event, &call_id,
                ));
            }
            eprintln!(
                "turn_semantic_event_already_represented session_id={} turn_id={} api_mode=responses event_name=agent.tool_call.delta call_id={}",
                session_id, turn_id, call_id,
            );
            (Vec::new(), true)
        }
    };
    for call_id in response_items.iter().filter_map(response_function_call_id) {
        represented_function_calls.insert(call_id);
    }
    let appended_response_items = !response_items.is_empty();
    let response_items = enrich_response_items(response_items, &event, turn_id, api_mode)?;
    let mut items = Vec::with_capacity(response_items.len().saturating_add(2));
    if let Some(token_count) = token_count_item(session_id, turn_id, &event)? {
        items.push(token_count);
    }
    items.extend(response_items.into_iter().map(ThreadLogItem::ResponseItem));
    if let Some(thread_item) =
        semantic_thread_item_from_runtime_event(session_id, turn_id, timestamp, &event, api_mode)
    {
        items.push(value_event(
            EventKind::ThreadItem,
            serde_json::json!({ "item": thread_item }),
        ));
    }
    Ok(ProjectedSemanticEvent {
        items,
        appended_response_items,
        already_represented,
    })
}

fn enrich_response_items(
    response_items: Vec<Value>,
    event: &Value,
    turn_id: &str,
    api_mode: SessionApiMode,
) -> Result<Vec<super::ResponseItem>, WorkerProtocolError> {
    let preserve_event_identity = api_mode == SessionApiMode::ChatCompletions
        || matches!(
            runtime_event_kind(event),
            Some(AgentEventKind::TurnStarted | AgentEventKind::ToolResult)
        );
    let contains_assistant_message = matches!(
        runtime_event_kind(event),
        Some(AgentEventKind::MessageClassified | AgentEventKind::MessageCompleted)
    );
    let sequence = event.get("sequence").and_then(Value::as_u64);
    let timestamp = event
        .get("timestamp")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|timestamp| !timestamp.is_empty());
    let model_call_id = event
        .get("payload")
        .and_then(|payload| {
            payload
                .get("modelCallId")
                .or_else(|| payload.get("model_call_id"))
        })
        .cloned();
    let message_phase = event
        .get("payload")
        .and_then(|payload| {
            payload
                .get("messagePhase")
                .or_else(|| payload.get("message_phase"))
        })
        .cloned();
    let mut enriched = Vec::with_capacity(response_items.len());
    for mut item in response_items {
        if let Some(object) = item.as_object_mut() {
            object.insert(
                "turnId".to_string(),
                Value::String(
                    event
                        .get("turnId")
                        .and_then(Value::as_str)
                        .unwrap_or(turn_id)
                        .to_string(),
                ),
            );
            let is_assistant_message = object.get("type").and_then(Value::as_str)
                == Some("message")
                && object.get("role").and_then(Value::as_str) == Some("assistant");
            let is_reasoning = object.get("type").and_then(Value::as_str) == Some("reasoning");
            if contains_assistant_message && is_assistant_message {
                insert_if_missing(object, "modelCallId", model_call_id.as_ref());
                insert_if_missing(object, "phase", message_phase.as_ref());
            }
            if contains_assistant_message && is_reasoning {
                insert_if_missing(object, "modelCallId", model_call_id.as_ref());
            }
            if preserve_event_identity || (contains_assistant_message && is_assistant_message) {
                if let Some(sequence) = sequence {
                    object.insert(
                        "threadItemSequence".to_string(),
                        Value::Number(sequence.into()),
                    );
                }
                if let Some(timestamp) = timestamp {
                    object.insert(
                        "timestamp".to_string(),
                        Value::String(timestamp.to_string()),
                    );
                }
            }
        }
        enriched.push(typed_response_item(item, "agent turn semantic event")?);
    }
    Ok(enriched)
}

fn insert_if_missing(
    object: &mut serde_json::Map<String, Value>,
    key: &str,
    value: Option<&Value>,
) {
    if !object.contains_key(key) {
        if let Some(value) = value {
            object.insert(key.to_string(), value.clone());
        }
    }
}

fn token_count_item(
    session_id: &str,
    turn_id: &str,
    event: &Value,
) -> Result<Option<ThreadLogItem>, WorkerProtocolError> {
    if runtime_event_kind(event) != Some(AgentEventKind::TokenCount) {
        return Ok(None);
    }
    let info = event
        .get("payload")
        .and_then(|payload| payload.get("info"))
        .cloned();
    let usage = info
        .as_ref()
        .and_then(canonical_provider_call_usage)
        .ok_or_else(|| {
            invalid_turn_semantic_event_error(
                "agent.token_count is missing lastTokenUsage",
                session_id,
                turn_id,
                0,
                Some(AgentEventKind::TokenCount.wire_name()),
            )
        })?;
    Ok(Some(value_event(
        EventKind::TokenCount,
        serde_json::json!({
            "turnId": event.get("turnId").cloned().unwrap_or_else(|| Value::String(turn_id.to_string())),
            "providerCallId": event
                .get("payload")
                .and_then(|payload| payload.get("modelCallId").or_else(|| payload.get("providerCallId")))
                .cloned()
                .unwrap_or(Value::Null),
            "info": usage,
        }),
    )))
}

fn latest_total_tokens(events: &[Value]) -> Option<i64> {
    events.iter().rev().find_map(|event| {
        if runtime_event_kind(event) != Some(AgentEventKind::TokenCount) {
            return None;
        }
        event
            .get("payload")
            .and_then(|payload| payload.get("info"))
            .and_then(|info| {
                info.get("totalTokenUsage")
                    .or_else(|| info.get("total_token_usage"))
            })
            .and_then(|total| {
                total
                    .get("totalTokens")
                    .or_else(|| total.get("total_tokens"))
            })
            .and_then(Value::as_i64)
    })
}

pub(super) fn project_response_items(
    event: &Value,
    api_mode: SessionApiMode,
) -> ProtocolEventProjection {
    match api_mode {
        SessionApiMode::ChatCompletions => ProtocolEventProjection::ResponseItems(
            response_item_from_runtime_event(event)
                .into_iter()
                .collect(),
        ),
        SessionApiMode::Responses => project_responses_items(event),
    }
}

pub(super) fn response_items_from_runtime_event(
    event: &Value,
    api_mode: SessionApiMode,
) -> Vec<Value> {
    match project_response_items(event, api_mode) {
        ProtocolEventProjection::ResponseItems(items) => items,
        ProtocolEventProjection::AlreadyRepresented { .. } => Vec::new(),
    }
}

pub(super) fn response_item_from_runtime_event(event: &Value) -> Option<Value> {
    let payload = event.get("payload")?;
    match runtime_event_kind(event)? {
        AgentEventKind::TurnStarted => {
            let mut message = payload.get("userMessage")?.clone();
            let content = message.get("content").cloned().unwrap_or(Value::Null);
            message["type"] = Value::String("message".to_string());
            message["role"] = Value::String("user".to_string());
            message["content"] = canonical_message_content(content, "input_text");
            if message.get("id").is_none() {
                message["id"] = message
                    .get("messageId")
                    .or_else(|| message.get("message_id"))
                    .or_else(|| payload.get("userMessageId"))
                    .cloned()
                    .unwrap_or(Value::Null);
            }
            if message.get("messageId").is_none() {
                message["messageId"] = message.get("id").cloned().unwrap_or(Value::Null);
            }
            Some(message)
        }
        AgentEventKind::MessageCompleted => {
            let content = payload.get("content")?.as_str()?;
            let message_id = payload.get("messageId").cloned().unwrap_or(Value::Null);
            Some(serde_json::json!({
                "type": "message",
                "id": message_id,
                "role": "assistant",
                "content": canonical_message_content(Value::String(content.to_string()), "output_text"),
                "messageId": message_id,
                "phase": payload
                    .get("messagePhase")
                    .cloned()
                    .unwrap_or_else(|| Value::String("final_answer".to_string())),
            }))
        }
        AgentEventKind::MessageClassified => {
            let message_id = payload.get("messageId").cloned().unwrap_or(Value::Null);
            Some(serde_json::json!({
                "type": "message",
                "id": message_id,
                "role": "assistant",
                "content": canonical_message_content(
                    payload.get("content").cloned().unwrap_or(Value::Null),
                    "output_text",
                ),
                "messageId": message_id,
                "phase": payload
                    .get("messagePhase")
                    .cloned()
                    .unwrap_or_else(|| Value::String("commentary".to_string())),
            }))
        }
        AgentEventKind::ReasoningCompleted => {
            let summary = payload.get("summary")?.as_str()?;
            Some(serde_json::json!({
                "type": "reasoning",
                "id": payload
                    .get("reasoningId")
                    .cloned()
                    .unwrap_or_else(|| payload.get("modelCallId").cloned().unwrap_or(Value::Null)),
                "summary": [{
                    "type": "summary_text",
                    "text": summary,
                }],
                "content": null,
                "encrypted_content": null,
                "modelCallId": payload.get("modelCallId").cloned().unwrap_or(Value::Null),
                "reasoningId": payload.get("reasoningId").cloned().unwrap_or(Value::Null),
            }))
        }
        AgentEventKind::ToolCallDelta => Some(serde_json::json!({
            "type": "custom_tool_call",
            "id": payload.get("toolCallId")?.clone(),
            "call_id": payload.get("toolCallId")?.clone(),
            "name": payload
                .get("toolName")
                .or_else(|| payload.get("name"))?
                .clone(),
            "input": payload
                .get("argumentsDelta")
                .cloned()
                .unwrap_or_else(|| serde_json::json!("{}")),
        })),
        AgentEventKind::CommandAcknowledged => Some(serde_json::json!({
            "type": "custom_tool_call",
            "id": payload.get("commandId")?.clone(),
            "call_id": payload.get("commandId")?.clone(),
            "name": payload.get("commandKind")?.clone(),
            "input": payload.get("target").cloned().unwrap_or_else(|| serde_json::json!({})),
        })),
        AgentEventKind::ToolResult => {
            let call_id = payload.get("toolCallId")?.clone();
            let item_id = call_id
                .as_str()
                .map(|call_id| format!("tool-output:{call_id}"))?;
            let mut item = serde_json::json!({
                "type": "custom_tool_call_output",
                "id": item_id,
                "call_id": call_id,
                "tool_name": payload
                    .get("toolName")
                    .or_else(|| payload.get("name"))
                    .cloned()
                    .unwrap_or(Value::Null),
                "status": payload
                    .get("resultStatus")
                    .or_else(|| payload.get("result_status"))
                    .or_else(|| payload.get("envelope").and_then(|envelope| envelope.get("status")))
                    .cloned()
                    .unwrap_or(Value::Null),
                "output": payload
                    .get("content")
                    .or_else(|| payload.get("result"))
                    .or_else(|| payload.get("summary"))
                    .cloned()
                    .unwrap_or(Value::Null),
            });
            if let Some(result) = structured_tool_result(payload) {
                item["tinybot_result"] = result;
            }
            Some(item)
        }
        _ => None,
    }
}

pub(super) fn runtime_event_kind(event: &Value) -> Option<AgentEventKind> {
    let event_name = event.get("eventName").and_then(Value::as_str)?;
    match resolve_event_name(event_name) {
        EventNameResolution::Canonical(kind) => Some(kind),
        EventNameResolution::DeprecatedIgnored(_) | EventNameResolution::Unknown => None,
    }
}

fn project_responses_items(event: &Value) -> ProtocolEventProjection {
    let Some(payload) = event.get("payload") else {
        return ProtocolEventProjection::ResponseItems(Vec::new());
    };
    match runtime_event_kind(event) {
        Some(AgentEventKind::TurnStarted) => ProtocolEventProjection::ResponseItems(
            response_item_from_runtime_event(event)
                .into_iter()
                .collect(),
        ),
        Some(AgentEventKind::MessageClassified | AgentEventKind::MessageCompleted) => {
            ProtocolEventProjection::ResponseItems(
                payload
                    .get("responseItems")
                    .or_else(|| payload.get("response_items"))
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default(),
            )
        }
        Some(AgentEventKind::ToolCallDelta) => payload
            .get("toolCallId")
            .and_then(Value::as_str)
            .filter(|call_id| !call_id.trim().is_empty())
            .map(|call_id| ProtocolEventProjection::AlreadyRepresented {
                call_id: call_id.to_string(),
            })
            .unwrap_or_else(|| ProtocolEventProjection::ResponseItems(Vec::new())),
        Some(AgentEventKind::ToolResult) => {
            let Some(call_id) = payload.get("toolCallId").cloned() else {
                return ProtocolEventProjection::ResponseItems(Vec::new());
            };
            let output = payload
                .get("content")
                .or_else(|| payload.get("result"))
                .or_else(|| payload.get("summary"))
                .cloned()
                .unwrap_or(Value::Null);
            let mut item = serde_json::json!({
                "type": "function_call_output",
                "call_id": call_id,
                "tool_name": payload
                    .get("toolName")
                    .or_else(|| payload.get("name"))
                    .cloned()
                    .unwrap_or(Value::Null),
                "status": payload
                    .get("resultStatus")
                    .or_else(|| payload.get("result_status"))
                    .cloned()
                    .unwrap_or(Value::Null),
                "output": output,
            });
            if let Some(result) = structured_tool_result(payload) {
                item["tinybot_result"] = result;
            }
            ProtocolEventProjection::ResponseItems(vec![item])
        }
        _ => ProtocolEventProjection::ResponseItems(Vec::new()),
    }
}

fn structured_tool_result(payload: &Value) -> Option<Value> {
    if let Some(envelope) = payload.get("envelope").filter(|envelope| {
        envelope
            .get("artifacts")
            .and_then(Value::as_array)
            .is_some_and(|artifacts| !artifacts.is_empty())
    }) {
        return Some(envelope.clone());
    }
    let result = payload
        .get("result")
        .or_else(|| {
            payload
                .get("envelope")
                .and_then(|envelope| envelope.get("raw"))
        })
        .filter(|result| !result.is_null())
        .cloned()?;
    if is_shell_process_result(payload, &result) {
        return None;
    }
    Some(result)
}

fn is_shell_process_result(payload: &Value, result: &Value) -> bool {
    let tool_name = payload
        .get("toolName")
        .or_else(|| payload.get("name"))
        .and_then(Value::as_str);
    if !matches!(tool_name, Some("exec_command" | "write_stdin")) {
        return false;
    }
    let result = result.get("result").unwrap_or(result);
    result.get("processId").and_then(Value::as_str).is_some()
        && result.get("output").and_then(Value::as_str).is_some()
}

fn canonical_message_content(content: Value, part_type: &str) -> Value {
    match content {
        Value::Array(_) => content,
        Value::String(text) => serde_json::json!([{
            "type": part_type,
            "text": text,
        }]),
        Value::Null => Value::Array(Vec::new()),
        value => serde_json::json!([{
            "type": part_type,
            "text": value.to_string(),
        }]),
    }
}

fn canonical_provider_call_usage(info: &Value) -> Option<Value> {
    let usage = info
        .get("lastTokenUsage")
        .or_else(|| info.get("last_token_usage"))?
        .clone();
    Some(serde_json::json!({
        "usage": usage,
        "modelContextWindow": info
            .get("modelContextWindow")
            .or_else(|| info.get("model_context_window"))
            .cloned()
            .unwrap_or(Value::Null),
    }))
}

pub(super) fn semantic_thread_item_from_runtime_event(
    session_id: &str,
    turn_id: &str,
    timestamp: &str,
    event: &Value,
    api_mode: SessionApiMode,
) -> Option<crate::threads::domain::ThreadItem> {
    let payload = event.get("payload").cloned().unwrap_or(Value::Null);
    let kind = match runtime_event_kind(event)? {
        AgentEventKind::Error => crate::threads::domain::ThreadItemKind::Error(payload),
        AgentEventKind::Cancelled => crate::threads::domain::ThreadItemKind::Cancelled(payload),
        AgentEventKind::DelegateSpawned => {
            crate::threads::domain::ThreadItemKind::SubagentSpawned(payload)
        }
        AgentEventKind::DelegateMessage => {
            crate::threads::domain::ThreadItemKind::SubagentMessage(payload)
        }
        AgentEventKind::DelegateCompleted => {
            crate::threads::domain::ThreadItemKind::SubagentCompleted(payload)
        }
        AgentEventKind::ContextCompacted | AgentEventKind::ContextTrimmed => {
            crate::threads::domain::ThreadItemKind::Event(event.clone())
        }
        AgentEventKind::PlanProgress => {
            crate::threads::domain::ThreadItemKind::Event(event.clone())
        }
        AgentEventKind::Usage => {
            crate::threads::domain::ThreadItemKind::Event(compact_persisted_usage_event(event))
        }
        AgentEventKind::ReasoningCompleted if api_mode == SessionApiMode::Responses => {
            crate::threads::domain::ThreadItemKind::Event(event.clone())
        }
        AgentEventKind::ToolCallDelta if api_mode == SessionApiMode::Responses => {
            crate::threads::domain::ThreadItemKind::Event(event.clone())
        }
        _ => return None,
    };
    let event_id = event.get("eventId").and_then(Value::as_str)?;
    Some(crate::threads::domain::ThreadItem {
        item_id: format!("semantic:{session_id}:{turn_id}:{event_id}"),
        thread_id: session_id.to_string(),
        turn_id: turn_id.to_string(),
        parent_item_id: None,
        sequence: 0,
        created_at: timestamp.to_string(),
        kind,
    })
}

fn compact_persisted_usage_event(event: &Value) -> Value {
    let mut compacted = event.clone();
    let Some(payload) = compacted.get_mut("payload").and_then(Value::as_object_mut) else {
        return compacted;
    };
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
    compacted
}

pub(crate) fn is_turn_semantic_event(event_name: &str) -> bool {
    match resolve_event_name(event_name) {
        EventNameResolution::Canonical(kind) => {
            (kind != AgentEventKind::TurnStarted && kind.definition().is_durable())
                || matches!(
                    kind,
                    AgentEventKind::CommandAcknowledged | AgentEventKind::TokenCount
                )
        }
        EventNameResolution::DeprecatedIgnored(_) => false,
        EventNameResolution::Unknown => {
            panic!("unknown canonical runtime event `{event_name}`")
        }
    }
}

fn response_item_from_runtime_event_name(event_name: &str) -> bool {
    matches!(
        resolve_event_name(event_name),
        EventNameResolution::Canonical(
            AgentEventKind::TurnStarted
                | AgentEventKind::ReasoningCompleted
                | AgentEventKind::MessageClassified
                | AgentEventKind::MessageCompleted
                | AgentEventKind::ToolCallDelta
                | AgentEventKind::ToolResult
                | AgentEventKind::CommandAcknowledged
        )
    )
}

fn response_function_call_ids(lines: &[ThreadLogLine], turn_id: &str) -> HashSet<String> {
    lines
        .iter()
        .filter_map(|line| match &line.item {
            ThreadLogItem::ResponseItem(item)
                if item.get("turnId").and_then(Value::as_str) == Some(turn_id) =>
            {
                response_function_call_id(item.as_value())
            }
            _ => None,
        })
        .collect()
}

fn response_function_call_id(item: &Value) -> Option<String> {
    (item.get("type").and_then(Value::as_str) == Some("function_call"))
        .then(|| item.get("call_id").and_then(Value::as_str))
        .flatten()
        .filter(|call_id| !call_id.trim().is_empty())
        .map(str::to_string)
}

fn unrepresented_responses_tool_call_error(
    session_id: &str,
    turn_id: &str,
    index: usize,
    event: &Value,
    call_id: &str,
) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        "Responses tool lifecycle event has no persisted native function_call",
        serde_json::json!({
            "session_id": session_id,
            "turn_id": turn_id,
            "event_index": index,
            "event_id": event.get("eventId"),
            "event_name": event.get("eventName"),
            "call_id": call_id,
            "api_mode": "responses",
        }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

pub(super) fn validate_turn_semantic_event(
    session_id: &str,
    turn_id: &str,
    index: usize,
    event: &Value,
    api_mode: SessionApiMode,
) -> Result<(), WorkerProtocolError> {
    let event_name = event
        .get("eventName")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            invalid_turn_semantic_event_error(
                "agent turn semantic event is missing eventName",
                session_id,
                turn_id,
                index,
                None,
            )
        })?;
    event
        .get("eventId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            invalid_turn_semantic_event_error(
                "agent turn semantic event is missing eventId",
                session_id,
                turn_id,
                index,
                Some(event_name),
            )
        })?;
    if !is_turn_semantic_event(event_name) {
        return Err(invalid_turn_semantic_event_error(
            "runtime event has no canonical semantic representation",
            session_id,
            turn_id,
            index,
            Some(event_name),
        ));
    }
    let requires_response_item = if api_mode == SessionApiMode::Responses {
        matches!(
            runtime_event_kind(event),
            Some(
                AgentEventKind::TurnStarted
                    | AgentEventKind::MessageClassified
                    | AgentEventKind::MessageCompleted
                    | AgentEventKind::ToolResult
            )
        )
    } else {
        response_item_from_runtime_event_name(event_name)
    };
    if requires_response_item && response_items_from_runtime_event(event, api_mode).is_empty() {
        return Err(invalid_turn_semantic_event_error(
            "semantic runtime event cannot be materialized as a typed response item",
            session_id,
            turn_id,
            index,
            Some(event_name),
        ));
    }
    Ok(())
}

fn invalid_turn_semantic_event_error(
    message: &str,
    session_id: &str,
    turn_id: &str,
    index: usize,
    event_name: Option<&str>,
) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        message,
        serde_json::json!({
            "session_id": session_id,
            "turn_id": turn_id,
            "event_index": index,
            "event_name": event_name,
        }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}
