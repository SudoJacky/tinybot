use super::{
    CompactedItem, EventKind, EventMsg, ResponseItem, RolloutItem, RolloutLine,
    RolloutReconstruction, SessionMeta, TokenUsage, TokenUsageInfo, TurnContextItem,
};
use crate::protocol::{WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource};
use serde_json::{json, Value};

const DEFAULT_TITLE: &str = "New session";
const USER_MESSAGE_EVENT_MARKER: &str = "_tinybotUserMessageEvent";
const PRESERVED_MESSAGE_FIELDS: &[&str] = &[
    "id",
    "messageId",
    "message_id",
    "turnId",
    "turn_id",
    "usage",
    "tokenUsageInfo",
    "token_usage_info",
    "metadata",
    "references",
    "contextReferences",
    "context_references",
    "toolActivities",
    "tool_activities",
    "artifacts",
    "reasoningContent",
    "reasoning_content",
    "toolCalls",
    "tool_calls",
    "toolCallId",
    "tool_call_id",
    "toolName",
    "tool_name",
    "name",
    "arguments",
    "argumentsJson",
    "arguments_json",
    "function",
    "phase",
    "status",
    "_progress",
    "_task_event",
    "_task_progress",
    "_task_plan_id",
    "_tool_name",
    "_agent_item",
];

pub fn reconstruct_rollout(
    lines: &[RolloutLine],
) -> Result<RolloutReconstruction, WorkerProtocolError> {
    reconstruct_rollout_with_mode(lines, true)
}

pub fn reconstruct_transcript(
    lines: &[RolloutLine],
) -> Result<RolloutReconstruction, WorkerProtocolError> {
    reconstruct_rollout_with_mode(lines, false)
}

fn reconstruct_rollout_with_mode(
    lines: &[RolloutLine],
    apply_context_checkpoints: bool,
) -> Result<RolloutReconstruction, WorkerProtocolError> {
    let effective_line_indexes = effective_rollout_line_indexes(lines);
    let mut replay = RolloutReconstruction {
        effective_line_indexes: effective_line_indexes.clone(),
        ..Default::default()
    };
    for index in effective_line_indexes {
        let line = &lines[index];
        match &line.item {
            RolloutItem::SessionMeta(meta) => apply_meta(&mut replay, meta, &line.timestamp),
            RolloutItem::ResponseItem(item) => {
                apply_response_item(&mut replay, item, &line.timestamp)
            }
            RolloutItem::EventMsg(event) => apply_event(&mut replay, event, &line.timestamp)?,
            RolloutItem::Compacted(compacted) => {
                apply_compaction_metadata(&mut replay, compacted);
                if apply_context_checkpoints {
                    apply_compacted(&mut replay, compacted, &line.timestamp)?;
                }
            }
            RolloutItem::TurnContext(context) => apply_turn_context(&mut replay, context),
            RolloutItem::InterAgentCommunication(_)
            | RolloutItem::InterAgentCommunicationMetadata { .. } => {}
        }
    }
    for message in &mut replay.messages {
        if let Some(object) = message.as_object_mut() {
            object.remove(USER_MESSAGE_EVENT_MARKER);
        }
    }
    attach_token_usage_to_history(&mut replay);
    Ok(replay)
}

#[derive(Default)]
struct TurnSegment {
    line_indexes: Vec<usize>,
    counts_as_user_turn: bool,
    removed: bool,
}

pub fn effective_rollout_line_indexes(lines: &[RolloutLine]) -> Vec<usize> {
    let mut segments = Vec::<TurnSegment>::new();
    let mut active_segment = None::<usize>;

    for (line_index, line) in lines.iter().enumerate() {
        let event_kind = event_kind(&line.item);
        if event_kind.is_some_and(EventKind::starts_turn) {
            let segment_index = segments.len();
            segments.push(TurnSegment::default());
            active_segment = Some(segment_index);
        }

        if let Some(segment_index) = active_segment {
            let segment = &mut segments[segment_index];
            segment.line_indexes.push(line_index);
            segment.counts_as_user_turn |= counts_as_user_turn(&line.item);
        }

        if let Some(num_turns) = rolled_back_turns(&line.item) {
            let mut remaining = usize::try_from(num_turns).unwrap_or(usize::MAX);
            for segment in segments.iter_mut().rev() {
                if remaining == 0 {
                    break;
                }
                if segment.removed || !segment.counts_as_user_turn {
                    continue;
                }
                segment.removed = true;
                remaining -= 1;
            }
        }

        if event_kind.is_some_and(EventKind::ends_turn) {
            active_segment = None;
        }
    }

    let mut removed_lines = vec![false; lines.len()];
    for segment in segments.into_iter().filter(|segment| segment.removed) {
        for line_index in segment.line_indexes {
            removed_lines[line_index] = true;
        }
    }
    lines
        .iter()
        .enumerate()
        .filter_map(|(index, _line)| (!removed_lines[index]).then_some(index))
        .collect()
}

fn event_kind(item: &RolloutItem) -> Option<&EventKind> {
    let RolloutItem::EventMsg(event) = item else {
        return None;
    };
    Some(event.kind())
}

fn counts_as_user_turn(item: &RolloutItem) -> bool {
    match item {
        RolloutItem::EventMsg(event) => matches!(event.kind(), EventKind::UserMessage),
        RolloutItem::ResponseItem(item) => item.is_user_message(),
        RolloutItem::InterAgentCommunication(_) => true,
        RolloutItem::SessionMeta(_)
        | RolloutItem::TurnContext(_)
        | RolloutItem::Compacted(_)
        | RolloutItem::InterAgentCommunicationMetadata { .. } => false,
    }
}

fn rolled_back_turns(item: &RolloutItem) -> Option<u32> {
    let RolloutItem::EventMsg(event) = item else {
        return None;
    };
    if !matches!(event.kind(), EventKind::ThreadRolledBack) {
        return None;
    }
    let payload = event.payload();
    payload
        .get("num_turns")
        .or_else(|| payload.get("numTurns"))
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
}

fn apply_meta(replay: &mut RolloutReconstruction, meta: &SessionMeta, timestamp: &str) {
    replay.thread_id = meta.thread_id.clone();
    replay.session_id = meta
        .session_id
        .clone()
        .unwrap_or_else(|| meta.thread_id.clone());
    replay.title = DEFAULT_TITLE.to_string();
    replay.updated_at = timestamp.to_string();
    replay.forked_from_thread_id = meta.forked_from_thread_id.clone();
    replay.parent_thread_id = meta.parent_thread_id.clone();
}

fn apply_turn_context(replay: &mut RolloutReconstruction, context: &TurnContextItem) {
    replay.previous_turn_settings = Some(super::PreviousTurnSettings {
        model: context.model.clone(),
        provider: context.provider.clone(),
        comp_hash: context.comp_hash.clone(),
    });
    replay.reference_context = Some(context.clone());
}

fn apply_compaction_metadata(replay: &mut RolloutReconstruction, compacted: &CompactedItem) {
    replay.compaction_window.window_number = compacted
        .window_number()
        .unwrap_or_else(|| replay.compaction_window.window_number.saturating_add(1));
    replay.compaction_window.first_window_id = compacted.first_window_id().map(str::to_string);
    replay.compaction_window.previous_window_id =
        compacted.previous_window_id().map(str::to_string);
    replay.compaction_window.window_id = compacted.window_id().map(str::to_string);
    replay.reference_context = None;
}

fn apply_response_item(replay: &mut RolloutReconstruction, item: &ResponseItem, timestamp: &str) {
    let Some(item) = response_item_message_projection(item) else {
        return;
    };
    let role = item
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or("assistant");
    let content = thread_item_content(&item);
    let mut message = json!({
        "role": role,
        "content": content,
        "timestamp": timestamp
    });
    copy_optional_message_fields(&item, &mut message, PRESERVED_MESSAGE_FIELDS);
    if let Some(plan_id) = message.get("_task_plan_id").and_then(Value::as_str) {
        if let Some(existing) = replay
            .messages
            .iter_mut()
            .find(|existing| existing.get("_task_plan_id").and_then(Value::as_str) == Some(plan_id))
        {
            *existing = message;
            replay.updated_at = timestamp.to_string();
            return;
        }
    }
    if role == "user" {
        if let Some(index) = replay.messages.iter().rposition(|candidate| {
            candidate
                .get(USER_MESSAGE_EVENT_MARKER)
                .and_then(Value::as_bool)
                == Some(true)
                && same_message_identity(candidate, &message)
        }) {
            replay.messages[index] = message;
            replay.updated_at = timestamp.to_string();
            return;
        }
    }
    if let Some(candidate) = replay.compaction_overlap_candidate.take() {
        if same_message_identity(&candidate, &message) {
            replay.updated_at = timestamp.to_string();
            return;
        }
    }
    replay.messages.push(message);
    replay.updated_at = timestamp.to_string();
}

fn response_item_message_projection(item: &ResponseItem) -> Option<Value> {
    match item.kind() {
        super::ResponseItemKind::Message => Some(item.as_value().clone()),
        super::ResponseItemKind::FunctionCall | super::ResponseItemKind::CustomToolCall => {
            let call_id = field_any(item, &["call_id", "callId", "id"])?.clone();
            let name = field_any(item, &["name"]).cloned().unwrap_or(Value::Null);
            let arguments = field_any(item, &["input", "arguments", "argumentsJson"])
                .cloned()
                .unwrap_or_else(|| Value::String("{}".to_string()));
            Some(json!({
                "role": "assistant",
                "content": "",
                "tool_calls": [{
                    "id": call_id,
                    "type": "function",
                    "function": {
                        "name": name,
                        "arguments": arguments,
                    }
                }]
            }))
        }
        super::ResponseItemKind::FunctionCallOutput
        | super::ResponseItemKind::CustomToolCallOutput => {
            let call_id = field_any(item, &["call_id", "callId", "id"])?.clone();
            let output = field_any(item, &["output", "content"])
                .cloned()
                .unwrap_or(Value::Null);
            Some(json!({
                "role": "tool",
                "content": output,
                "tool_call_id": call_id,
            }))
        }
        super::ResponseItemKind::Reasoning
        | super::ResponseItemKind::WebSearchCall
        | super::ResponseItemKind::LocalShellCall
        | super::ResponseItemKind::ComputerCall
        | super::ResponseItemKind::Other(_)
        | super::ResponseItemKind::Unspecified => None,
    }
}

fn apply_event(
    replay: &mut RolloutReconstruction,
    event: &EventMsg,
    timestamp: &str,
) -> Result<(), WorkerProtocolError> {
    replay.updated_at = timestamp.to_string();
    match event.kind() {
        EventKind::MetadataUpdated => {
            if let Some(user_profile) = event
                .payload()
                .get("metadata")
                .and_then(|metadata| metadata.get("userProfile"))
            {
                replay.user_profile = user_profile.clone();
            }
            Ok(())
        }
        EventKind::TokenCount => {
            let info = token_usage_info_value(event.as_value()).ok_or_else(|| {
                replay_semantic_error(
                    "thread log token_count event is missing token usage info",
                    timestamp,
                    json!({ "event": event }),
                )
            })?;
            let (usage, context_window) = parse_provider_call_usage(info, timestamp)?;
            replay.token_usage_info = Some(TokenUsageInfo::new_or_append(
                replay.token_usage_info.as_ref(),
                usage,
                context_window,
            ));
            Ok(())
        }
        EventKind::SessionCleared => {
            replay.messages.clear();
            replay.user_profile = json!({});
            replay.token_usage_info = None;
            replay.compaction_overlap_candidate = None;
            Ok(())
        }
        EventKind::SessionTrimmed => {
            let messages = event
                .payload()
                .get("messages")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    replay_semantic_error(
                        "session_trimmed event is missing messages",
                        timestamp,
                        json!({ "event": event }),
                    )
                })?;
            replay.messages = messages.clone();
            if replay.messages.is_empty() {
                replay.user_profile = json!({});
                replay.token_usage_info = None;
            }
            replay.compaction_overlap_candidate = None;
            Ok(())
        }
        EventKind::UserMessage => {
            let payload = event.payload();
            let content = payload
                .get("message")
                .or_else(|| payload.get("content"))
                .or_else(|| payload.get("text"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            let mut message = json!({
                "role": "user",
                "content": content,
                "timestamp": timestamp,
            });
            message[USER_MESSAGE_EVENT_MARKER] = Value::Bool(true);
            copy_optional_message_fields(payload, &mut message, PRESERVED_MESSAGE_FIELDS);
            replay.messages.push(message);
            Ok(())
        }
        EventKind::TurnStarted
        | EventKind::TaskStarted
        | EventKind::TurnComplete
        | EventKind::TaskComplete
        | EventKind::TurnAborted
        | EventKind::ThreadRolledBack
        | EventKind::ThreadItem
        | EventKind::TurnCheckpointSet
        | EventKind::TurnCheckpointClear => Ok(()),
    }
}

fn apply_compacted(
    replay: &mut RolloutReconstruction,
    compacted: &CompactedItem,
    timestamp: &str,
) -> Result<(), WorkerProtocolError> {
    let replacement_history = compacted.replacement_history().ok_or_else(|| {
        replay_semantic_error(
            "thread log compacted item is missing replacementHistory",
            timestamp,
            json!({ "compacted": compacted }),
        )
    })?;
    replay.messages = replacement_history
        .iter()
        .map(|item| item.as_value().clone())
        .collect();
    replay.compaction_overlap_candidate = replacement_history
        .last()
        .map(|item| item.as_value().clone());
    replay.token_usage_info = None;
    replay.context_checkpoint = Some(compacted.as_value().clone());
    Ok(())
}

fn same_message_identity(left: &Value, right: &Value) -> bool {
    left.get("role") == right.get("role")
        && thread_item_content(left) == thread_item_content(right)
        && match (
            left.get("messageId").or_else(|| left.get("message_id")),
            right.get("messageId").or_else(|| right.get("message_id")),
        ) {
            (Some(left_id), Some(right_id)) => left_id == right_id,
            _ => true,
        }
}

fn attach_token_usage_to_history(replay: &mut RolloutReconstruction) {
    if replay.messages.is_empty() {
        return;
    }
    let Some(token_usage_info) = replay.token_usage_info.as_ref() else {
        return;
    };
    let Ok(token_usage_value) = serde_json::to_value(token_usage_info) else {
        return;
    };
    let target_index = replay
        .messages
        .iter()
        .rev()
        .position(|message| message.get("role").and_then(Value::as_str) == Some("assistant"))
        .map(|reverse_index| replay.messages.len() - 1 - reverse_index)
        .unwrap_or_else(|| replay.messages.len() - 1);
    let target = &mut replay.messages[target_index];
    if target.get("tokenUsageInfo").is_none() {
        target["tokenUsageInfo"] = token_usage_value.clone();
    }
    if target.get("usage").is_none() {
        target["usage"] = usage_from_token_usage_info(&token_usage_value);
    }
}

fn token_usage_info_value(event: &Value) -> Option<&Value> {
    event
        .get("info")
        .or_else(|| event.get("tokenUsageInfo"))
        .or_else(|| event.get("token_usage_info"))
        .or_else(|| {
            let payload = event.get("payload")?;
            payload
                .get("info")
                .or_else(|| payload.get("tokenUsageInfo"))
                .or_else(|| payload.get("token_usage_info"))
        })
}

fn parse_provider_call_usage(
    value: &Value,
    timestamp: &str,
) -> Result<(TokenUsage, Option<i64>), WorkerProtocolError> {
    let usage = value
        .get("usage")
        .ok_or_else(|| missing_token_usage_field(timestamp, "usage", value))?;
    Ok((
        parse_token_usage(usage, timestamp)?,
        optional_i64_field_any(
            value,
            &["modelContextWindow", "model_context_window"],
            timestamp,
            "modelContextWindow",
        )?,
    ))
}

fn parse_token_usage(value: &Value, timestamp: &str) -> Result<TokenUsage, WorkerProtocolError> {
    if !value.is_object() {
        return Err(replay_semantic_error(
            "thread log token usage fields must be objects",
            timestamp,
            json!({ "tokenUsage": value }),
        ));
    }
    Ok(TokenUsage {
        input_tokens: optional_i64_field_any(
            value,
            &["inputTokens", "input_tokens"],
            timestamp,
            "inputTokens",
        )?
        .unwrap_or_default(),
        cached_input_tokens: optional_i64_field_any(
            value,
            &["cachedInputTokens", "cached_input_tokens"],
            timestamp,
            "cachedInputTokens",
        )?
        .unwrap_or_default(),
        output_tokens: optional_i64_field_any(
            value,
            &["outputTokens", "output_tokens"],
            timestamp,
            "outputTokens",
        )?
        .unwrap_or_default(),
        reasoning_output_tokens: optional_i64_field_any(
            value,
            &["reasoningOutputTokens", "reasoning_output_tokens"],
            timestamp,
            "reasoningOutputTokens",
        )?
        .unwrap_or_default(),
        total_tokens: required_i64_field_any(
            value,
            &["totalTokens", "total_tokens"],
            timestamp,
            "totalTokens",
        )?,
    })
}

fn usage_from_token_usage_info(token_usage_info: &Value) -> Value {
    let last = token_usage_info
        .get("lastTokenUsage")
        .expect("TokenUsageInfo serializes lastTokenUsage");
    let total = token_usage_info.get("totalTokenUsage");
    let used_tokens =
        i64_field_any(last, &["totalTokens"]).expect("TokenUsageInfo serializes totalTokens");
    let context_window = i64_field_any(token_usage_info, &["modelContextWindow"]);
    let remaining_tokens = context_window.map(|window| window.saturating_sub(used_tokens).max(0));
    let percent = context_window
        .filter(|window| *window > 0)
        .map(|window| ((used_tokens as f64 / window as f64) * 100.0).clamp(0.0, 100.0));
    json!({
        "cachedTokens": i64_field_any(last, &["cachedInputTokens"]),
        "completionTokens": i64_field_any(last, &["outputTokens"]),
        "contextWindowRemainingTokens": remaining_tokens,
        "contextWindowTokens": context_window,
        "contextWindowUsedTokens": used_tokens,
        "estimatedContextTokens": used_tokens,
        "promptTokens": i64_field_any(last, &["inputTokens"]),
        "reasoningOutputTokens": i64_field_any(last, &["reasoningOutputTokens"]),
        "totalTokens": used_tokens,
        "cumulativeUsageTokens": total.and_then(|usage| i64_field_any(usage, &["totalTokens"])),
        "percent": percent,
    })
}

fn copy_optional_message_fields(payload: &Value, message: &mut Value, fields: &[&str]) {
    let Some(message_object) = message.as_object_mut() else {
        return;
    };
    for field in fields {
        if let Some(value) = payload.get(*field) {
            message_object.insert((*field).to_string(), value.clone());
        }
    }
}

fn thread_item_content(payload: &Value) -> String {
    let content = payload
        .get("content")
        .or_else(|| payload.get("text"))
        .unwrap_or(payload);
    if content.is_null() {
        return String::new();
    }
    if let Some(parts) = content.as_array() {
        return parts
            .iter()
            .filter_map(|part| {
                part.as_str()
                    .or_else(|| part.get("text").and_then(Value::as_str))
            })
            .collect::<String>();
    }
    content
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| content.to_string())
}

fn field_any<'a>(value: &'a Value, fields: &[&str]) -> Option<&'a Value> {
    fields.iter().find_map(|field| value.get(*field))
}

fn i64_field_any(value: &Value, fields: &[&str]) -> Option<i64> {
    field_any(value, fields).and_then(|field| {
        field
            .as_i64()
            .or_else(|| field.as_u64().and_then(|number| i64::try_from(number).ok()))
    })
}

fn optional_i64_field_any(
    value: &Value,
    fields: &[&str],
    timestamp: &str,
    display_field: &str,
) -> Result<Option<i64>, WorkerProtocolError> {
    let Some(field) = field_any(value, fields) else {
        return Ok(None);
    };
    parse_i64_field(field).map(Some).ok_or_else(|| {
        replay_semantic_error(
            format!("thread log token usage field {display_field} must be an integer"),
            timestamp,
            json!({
                "field": display_field,
                "tokenUsage": value
            }),
        )
    })
}

fn required_i64_field_any(
    value: &Value,
    fields: &[&str],
    timestamp: &str,
    display_field: &str,
) -> Result<i64, WorkerProtocolError> {
    field_any(value, fields)
        .ok_or_else(|| {
            replay_semantic_error(
                format!("thread log token usage is missing {display_field}"),
                timestamp,
                json!({ "tokenUsage": value }),
            )
        })
        .and_then(|field| {
            parse_i64_field(field).ok_or_else(|| {
                replay_semantic_error(
                    format!("thread log token usage field {display_field} must be an integer"),
                    timestamp,
                    json!({
                        "field": display_field,
                        "tokenUsage": value
                    }),
                )
            })
        })
}

fn parse_i64_field(field: &Value) -> Option<i64> {
    field
        .as_i64()
        .or_else(|| field.as_u64().and_then(|number| i64::try_from(number).ok()))
}

fn missing_token_usage_field(timestamp: &str, field: &str, value: &Value) -> WorkerProtocolError {
    replay_semantic_error(
        format!("thread log token_count event is missing {field}"),
        timestamp,
        json!({ "tokenUsageInfo": value }),
    )
}

fn replay_semantic_error(
    message: impl Into<String>,
    timestamp: &str,
    detail: Value,
) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        message.into(),
        json!({
            "method": "rollout.reconstruct",
            "timestamp": timestamp,
            "detail": detail
        }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

#[cfg(test)]
#[path = "reconstruction_tests.rs"]
mod tests;
