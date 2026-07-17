use super::{
    CompactedItem, EventKind, EventMsg, ResponseItem, RolloutItem, RolloutLine,
    RolloutReconstruction, SessionMeta, TokenUsage, TokenUsageInfo, TurnContextItem,
};
use crate::worker_protocol::{
    WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource,
};
use serde_json::{json, Value};

const DEFAULT_TITLE: &str = "New session";
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
    "status",
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
                replay.world_state_baseline = None;
            }
            RolloutItem::TurnContext(context) => apply_turn_context(&mut replay, context),
            RolloutItem::WorldState(world_state) => {
                apply_world_state(&mut replay, world_state);
            }
            RolloutItem::InterAgentCommunication(_)
            | RolloutItem::InterAgentCommunicationMetadata { .. } => {}
        }
    }
    attach_token_usage_to_history(&mut replay);
    Ok(replay)
}

fn apply_world_state(replay: &mut RolloutReconstruction, world_state: &super::WorldStateItem) {
    if world_state.full {
        replay.world_state_baseline = world_state
            .state
            .is_object()
            .then(|| world_state.state.clone());
        return;
    }
    let Some(baseline) = replay.world_state_baseline.as_mut() else {
        return;
    };
    apply_json_merge_patch(baseline, &world_state.state);
    if !baseline.is_object() {
        replay.world_state_baseline = None;
    }
}

fn apply_json_merge_patch(target: &mut Value, patch: &Value) {
    let Value::Object(patch) = patch else {
        *target = patch.clone();
        return;
    };
    if !target.is_object() {
        *target = json!({});
    }
    let target = target
        .as_object_mut()
        .expect("merge-patch target was normalized to an object");
    for (key, value) in patch {
        if value.is_null() {
            target.remove(key);
            continue;
        }
        apply_json_merge_patch(target.entry(key.clone()).or_insert(Value::Null), value);
    }
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

pub fn latest_effective_compaction_index(lines: &[RolloutLine]) -> Option<usize> {
    effective_rollout_line_indexes(lines)
        .into_iter()
        .rev()
        .find(|index| matches!(lines[*index].item, RolloutItem::Compacted(_)))
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
        | RolloutItem::WorldState(_)
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
    let role = item
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or("assistant");
    let content = thread_item_content(item);
    let mut message = json!({
        "role": role,
        "content": content,
        "timestamp": timestamp
    });
    copy_optional_message_fields(item, &mut message, PRESERVED_MESSAGE_FIELDS);
    if let Some(candidate) = replay.compaction_overlap_candidate.take() {
        if same_message_identity(&candidate, &message) {
            replay.updated_at = timestamp.to_string();
            return;
        }
    }
    replay.messages.push(message);
    replay.updated_at = timestamp.to_string();
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
            replay.token_usage_info = Some(parse_token_usage_info(info, timestamp)?);
            Ok(())
        }
        EventKind::SessionCleared => {
            replay.messages.clear();
            replay.user_profile = json!({});
            replay.token_usage_info = None;
            replay.compaction_overlap_candidate = None;
            Ok(())
        }
        EventKind::TurnStarted
        | EventKind::TaskStarted
        | EventKind::TurnComplete
        | EventKind::TaskComplete
        | EventKind::TurnAborted
        | EventKind::UserMessage
        | EventKind::ThreadRolledBack
        | EventKind::ThreadItem
        | EventKind::AgentRunUpsert
        | EventKind::AgentRunTrace
        | EventKind::AgentRunCheckpointSet
        | EventKind::AgentRunCheckpointClear
        | EventKind::AgentRunTerminal
        | EventKind::Legacy(_) => Ok(()),
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

fn parse_token_usage_info(
    value: &Value,
    timestamp: &str,
) -> Result<TokenUsageInfo, WorkerProtocolError> {
    parse_token_usage_info_fields(value, timestamp)
}

fn parse_token_usage_info_fields(
    value: &Value,
    timestamp: &str,
) -> Result<TokenUsageInfo, WorkerProtocolError> {
    Ok(TokenUsageInfo {
        total_token_usage: parse_token_usage(
            field_any(value, &["totalTokenUsage", "total_token_usage"])
                .ok_or_else(|| missing_token_usage_field(timestamp, "totalTokenUsage", value))?,
            timestamp,
        )?,
        last_token_usage: parse_token_usage(
            field_any(value, &["lastTokenUsage", "last_token_usage"])
                .ok_or_else(|| missing_token_usage_field(timestamp, "lastTokenUsage", value))?,
            timestamp,
        )?,
        model_context_window: optional_i64_field_any(
            value,
            &["modelContextWindow", "model_context_window"],
            timestamp,
            "modelContextWindow",
        )?,
    })
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
    payload
        .get("content")
        .and_then(Value::as_str)
        .or_else(|| payload.get("text").and_then(Value::as_str))
        .or_else(|| payload.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| {
            payload
                .get("content")
                .or_else(|| payload.get("text"))
                .map(Value::to_string)
                .unwrap_or_default()
        })
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
mod tests {
    use super::*;
    use crate::worker_thread_log::{ThreadLogItem, ThreadLogLine, ThreadMeta};
    use serde_json::json;

    #[test]
    fn replay_projects_messages_and_latest_token_count() {
        let replay = reconstruct_rollout(&[
            meta_line("thread-1", Some("session-1"), "2026-07-08T10:00:00Z"),
            response_line(
                "2026-07-08T10:01:00Z",
                json!({
                    "role": "user",
                    "messageId": "user-1",
                    "content": "hello"
                }),
            ),
            token_count_line("2026-07-08T10:02:00Z", 172, 128000),
            token_count_line("2026-07-08T10:03:00Z", 200, 128000),
        ])
        .unwrap();

        assert_eq!(replay.thread_id, "thread-1");
        assert_eq!(replay.session_id, "session-1");
        assert_eq!(replay.title, DEFAULT_TITLE);
        assert_eq!(replay.updated_at, "2026-07-08T10:03:00Z");
        assert_eq!(replay.messages.len(), 1);
        assert_eq!(replay.messages[0]["messageId"], "user-1");
        assert_eq!(
            replay.messages[0]["tokenUsageInfo"]["lastTokenUsage"]["totalTokens"],
            200
        );
        assert_eq!(replay.messages[0]["usage"]["contextWindowUsedTokens"], 200);
        assert_eq!(replay.messages[0]["usage"]["contextWindowTokens"], 128000);
        assert_eq!(replay.messages[0]["usage"]["cumulativeUsageTokens"], 1200);
        assert_eq!(
            replay
                .token_usage_info
                .unwrap()
                .last_token_usage
                .total_tokens,
            200
        );
    }

    #[test]
    fn replay_preserves_existing_frontend_fields() {
        let replay = reconstruct_rollout(&[
            meta_line("thread-fields", None, "2026-07-08T10:00:00Z"),
            response_line(
                "2026-07-08T10:01:00Z",
                json!({
                    "role": "assistant",
                    "id": "response-id",
                    "message_id": "message-snake",
                    "messageId": "message-camel",
                    "content": [{"type": "output_text", "text": "structured"}],
                    "usage": {"totalTokens": 9},
                    "tokenUsageInfo": {"lastTokenUsage": {"totalTokens": 9}},
                    "metadata": {"k": "v"},
                    "references": [{"uri": "file:///tmp/a"}],
                    "context_references": [{"id": "ctx-snake"}],
                    "contextReferences": [{"id": "ctx-camel"}],
                    "tool_activities": [{"id": "tool-snake"}],
                    "toolActivities": [{"id": "tool-camel"}],
                    "artifacts": [{"id": "artifact-1"}],
                    "reasoning_content": "snake reasoning",
                    "reasoningContent": "camel reasoning",
                    "tool_calls": [{"id": "call-snake"}],
                    "toolCalls": [{"id": "call-camel"}],
                    "tool_call_id": "call-result-snake",
                    "toolCallId": "call-result-camel",
                    "name": "lookup",
                    "arguments_json": "{}",
                    "argumentsJson": "{}",
                    "function": {"name": "lookup"}
                }),
            ),
        ])
        .unwrap();

        let message = &replay.messages[0];
        assert_eq!(replay.session_id, "thread-fields");
        assert_eq!(
            message["content"],
            "[{\"text\":\"structured\",\"type\":\"output_text\"}]"
        );
        assert_eq!(message["id"], "response-id");
        assert_eq!(message["messageId"], "message-camel");
        assert_eq!(message["message_id"], "message-snake");
        assert_eq!(message["usage"]["totalTokens"], 9);
        assert_eq!(
            message["tokenUsageInfo"]["lastTokenUsage"]["totalTokens"],
            9
        );
        assert_eq!(message["metadata"]["k"], "v");
        assert_eq!(message["references"][0]["uri"], "file:///tmp/a");
        assert_eq!(message["contextReferences"][0]["id"], "ctx-camel");
        assert_eq!(message["context_references"][0]["id"], "ctx-snake");
        assert_eq!(message["toolActivities"][0]["id"], "tool-camel");
        assert_eq!(message["tool_activities"][0]["id"], "tool-snake");
        assert_eq!(message["artifacts"][0]["id"], "artifact-1");
        assert_eq!(message["reasoningContent"], "camel reasoning");
        assert_eq!(message["reasoning_content"], "snake reasoning");
        assert_eq!(message["toolCalls"][0]["id"], "call-camel");
        assert_eq!(message["tool_calls"][0]["id"], "call-snake");
        assert_eq!(message["toolCallId"], "call-result-camel");
        assert_eq!(message["tool_call_id"], "call-result-snake");
        assert_eq!(message["name"], "lookup");
        assert_eq!(message["argumentsJson"], "{}");
        assert_eq!(message["arguments_json"], "{}");
        assert_eq!(message["function"]["name"], "lookup");
    }

    #[test]
    fn replay_compacted_replacement_history_wins() {
        let replay = reconstruct_rollout(&[
            meta_line(
                "thread-compact",
                Some("session-compact"),
                "2026-07-08T10:00:00Z",
            ),
            response_line(
                "2026-07-08T10:01:00Z",
                json!({
                    "role": "user",
                    "messageId": "old-user",
                    "content": "old"
                }),
            ),
            ThreadLogLine {
                timestamp: "2026-07-08T10:02:00Z".to_string(),
                ordinal: None,
                item: ThreadLogItem::Compacted(compacted_item(json!({
                    "replacementHistory": [
                        {
                            "role": "assistant",
                            "messageId": "compact-summary",
                            "content": "Summary of earlier context",
                            "timestamp": "2026-07-08T10:02:00Z"
                        }
                    ]
                }))),
            },
        ])
        .unwrap();

        assert_eq!(replay.messages.len(), 1);
        assert_eq!(replay.messages[0]["messageId"], "compact-summary");
    }

    #[test]
    fn replay_compacted_clears_previous_token_usage() {
        let replay = reconstruct_rollout(&[
            meta_line(
                "thread-compact-usage",
                Some("session-compact-usage"),
                "2026-07-08T10:00:00Z",
            ),
            response_line(
                "2026-07-08T10:01:00Z",
                json!({
                    "role": "assistant",
                    "messageId": "old-assistant",
                    "content": "old"
                }),
            ),
            ThreadLogLine {
                timestamp: "2026-07-08T10:02:00Z".to_string(),
                ordinal: None,
                item: ThreadLogItem::EventMsg(event_msg(json!({
                    "type": "token_count",
                    "info": {
                        "totalTokenUsage": usage_value(1500),
                        "lastTokenUsage": usage_value(300),
                        "modelContextWindow": 128000
                    }
                }))),
            },
            ThreadLogLine {
                timestamp: "2026-07-08T10:03:00Z".to_string(),
                ordinal: None,
                item: ThreadLogItem::Compacted(compacted_item(json!({
                    "replacementHistory": []
                }))),
            },
        ])
        .unwrap();

        assert!(replay.messages.is_empty());
        assert!(replay.token_usage_info.is_none());
    }

    #[test]
    fn replay_attaches_token_count_that_arrives_after_assistant_message() {
        let replay = reconstruct_rollout(&[
            meta_line(
                "thread-token",
                Some("session-token"),
                "2026-07-08T10:00:00Z",
            ),
            response_line(
                "2026-07-08T10:01:00Z",
                json!({
                    "role": "user",
                    "messageId": "user-token",
                    "content": "hello"
                }),
            ),
            response_line(
                "2026-07-08T10:02:00Z",
                json!({
                    "role": "assistant",
                    "messageId": "assistant-token",
                    "content": "hi"
                }),
            ),
            ThreadLogLine {
                timestamp: "2026-07-08T10:03:00Z".to_string(),
                ordinal: None,
                item: ThreadLogItem::EventMsg(event_msg(json!({
                    "type": "token_count",
                    "payload": {
                        "tokenUsageInfo": {
                            "totalTokenUsage": usage_value(1500),
                            "lastTokenUsage": usage_value(300),
                            "modelContextWindow": 128000
                        }
                    }
                }))),
            },
        ])
        .unwrap();

        assert_eq!(replay.messages[0].get("usage"), None);
        assert_eq!(replay.messages[1]["messageId"], "assistant-token");
        assert_eq!(
            replay.messages[1]["tokenUsageInfo"]["lastTokenUsage"]["totalTokens"],
            300
        );
        assert_eq!(replay.messages[1]["usage"]["contextWindowUsedTokens"], 300);
        assert_eq!(replay.messages[1]["usage"]["cumulativeUsageTokens"], 1500);
    }

    #[test]
    fn replay_errors_on_malformed_token_count() {
        let error = reconstruct_rollout(&[
            meta_line(
                "thread-bad-token",
                Some("session-bad-token"),
                "2026-07-08T10:00:00Z",
            ),
            ThreadLogLine {
                timestamp: "2026-07-08T10:01:00Z".to_string(),
                ordinal: None,
                item: ThreadLogItem::EventMsg(event_msg(json!({
                    "type": "token_count",
                    "info": {
                        "totalTokenUsage": usage_value(1500),
                        "lastTokenUsage": {
                            "inputTokens": 1
                        },
                        "modelContextWindow": 128000
                    }
                }))),
            },
        ])
        .unwrap_err();

        assert_eq!(error.code, WorkerProtocolErrorCode::InvalidProtocol);
        assert_eq!(error.source, WorkerProtocolErrorSource::RustCore);
        assert_eq!(error.details["method"], "rollout.reconstruct");
        assert!(error.message.contains("totalTokens"));
    }

    #[test]
    fn replay_errors_on_present_non_integer_optional_token_field() {
        let error = reconstruct_rollout(&[
            meta_line(
                "thread-bad-optional-token",
                Some("session-bad-optional-token"),
                "2026-07-08T10:00:00Z",
            ),
            ThreadLogLine {
                timestamp: "2026-07-08T10:01:00Z".to_string(),
                ordinal: None,
                item: ThreadLogItem::EventMsg(event_msg(json!({
                    "type": "token_count",
                    "info": {
                        "totalTokenUsage": usage_value(1500),
                        "lastTokenUsage": {
                            "inputTokens": 1,
                            "outputTokens": "162",
                            "totalTokens": 172
                        },
                        "modelContextWindow": 128000
                    }
                }))),
            },
        ])
        .unwrap_err();

        assert_eq!(error.code, WorkerProtocolErrorCode::InvalidProtocol);
        assert_eq!(error.source, WorkerProtocolErrorSource::RustCore);
        assert_eq!(error.details["method"], "rollout.reconstruct");
        assert_eq!(error.details["detail"]["field"], "outputTokens");
        assert!(error.message.contains("must be an integer"));
    }

    #[test]
    fn replay_errors_on_token_count_missing_info() {
        let error = reconstruct_rollout(&[
            meta_line(
                "thread-missing-token",
                Some("session-missing-token"),
                "2026-07-08T10:00:00Z",
            ),
            ThreadLogLine {
                timestamp: "2026-07-08T10:01:00Z".to_string(),
                ordinal: None,
                item: ThreadLogItem::EventMsg(event_msg(json!({
                    "type": "token_count"
                }))),
            },
        ])
        .unwrap_err();

        assert_eq!(error.code, WorkerProtocolErrorCode::InvalidProtocol);
        assert_eq!(error.source, WorkerProtocolErrorSource::RustCore);
        assert_eq!(error.details["method"], "rollout.reconstruct");
        assert!(error.message.contains("missing token usage info"));
    }

    #[test]
    fn replay_errors_on_malformed_compacted_line() {
        let error = CompactedItem::from_value(json!({
            "replacementHistory": {
                "role": "assistant",
                "content": "not an array"
            }
        }))
        .unwrap_err();

        assert!(error.contains("must be an array"));
    }

    #[test]
    fn rollback_discards_compaction_from_removed_turn() {
        let replay = reconstruct_rollout(&[
            meta_line(
                "thread-rollback-compact",
                Some("session-rollback-compact"),
                "2026-07-08T10:00:00Z",
            ),
            event_line("2026-07-08T10:01:00Z", "turn_started", json!({})),
            response_line(
                "2026-07-08T10:01:01Z",
                json!({"role": "user", "content": "first"}),
            ),
            compacted_line("2026-07-08T10:01:02Z", "first summary"),
            event_line("2026-07-08T10:01:03Z", "turn_complete", json!({})),
            event_line("2026-07-08T10:02:00Z", "turn_started", json!({})),
            response_line(
                "2026-07-08T10:02:01Z",
                json!({"role": "user", "content": "second"}),
            ),
            compacted_line("2026-07-08T10:02:02Z", "removed summary"),
            event_line("2026-07-08T10:02:03Z", "turn_complete", json!({})),
            event_line(
                "2026-07-08T10:03:00Z",
                "thread_rolled_back",
                json!({"num_turns": 1}),
            ),
        ])
        .unwrap();

        assert_eq!(replay.messages.len(), 1);
        assert_eq!(replay.messages[0]["content"], "first summary");
        assert_eq!(
            replay.context_checkpoint.unwrap()["replacementHistory"][0]["content"],
            "first summary"
        );
    }

    #[test]
    fn transcript_ignores_compaction_replacement_history() {
        let replay = reconstruct_transcript(&[
            meta_line(
                "thread-transcript",
                Some("session-transcript"),
                "2026-07-08T10:00:00Z",
            ),
            response_line(
                "2026-07-08T10:01:00Z",
                json!({"role": "user", "content": "original"}),
            ),
            compacted_line("2026-07-08T10:02:00Z", "model-only summary"),
            response_line(
                "2026-07-08T10:03:00Z",
                json!({"role": "assistant", "content": "answer"}),
            ),
        ])
        .unwrap();

        assert_eq!(replay.messages.len(), 2);
        assert_eq!(replay.messages[0]["content"], "original");
        assert_eq!(replay.messages[1]["content"], "answer");
        assert!(replay.context_checkpoint.is_none());
    }

    #[test]
    fn replay_restores_world_state_from_latest_compaction_window() {
        let lines = vec![
            RolloutLine {
                timestamp: "2026-07-17T10:00:00Z".to_string(),
                ordinal: None,
                item: RolloutItem::WorldState(super::super::WorldStateItem::full(json!({
                    "environment": { "status": "old" }
                }))),
            },
            compacted_line("2026-07-17T10:00:01Z", "summary"),
            RolloutLine {
                timestamp: "2026-07-17T10:00:02Z".to_string(),
                ordinal: None,
                item: RolloutItem::WorldState(super::super::WorldStateItem::full(json!({
                    "environment": {
                        "status": "starting",
                        "cwd": "D:/workspace",
                        "obsolete": true
                    }
                }))),
            },
            RolloutLine {
                timestamp: "2026-07-17T10:00:03Z".to_string(),
                ordinal: None,
                item: RolloutItem::WorldState(super::super::WorldStateItem::patch(json!({
                    "environment": {
                        "status": "ready",
                        "obsolete": null
                    }
                }))),
            },
        ];

        let replay = reconstruct_rollout(&lines).unwrap();

        assert_eq!(
            replay.world_state_baseline,
            Some(json!({
                "environment": {
                    "status": "ready",
                    "cwd": "D:/workspace"
                }
            }))
        );
    }

    #[test]
    fn replay_ignores_world_state_patch_without_a_full_snapshot() {
        let lines = vec![RolloutLine {
            timestamp: "2026-07-17T10:00:00Z".to_string(),
            ordinal: None,
            item: RolloutItem::WorldState(super::super::WorldStateItem::patch(json!({
                "environment": { "status": "ready" }
            }))),
        }];

        assert!(reconstruct_rollout(&lines)
            .unwrap()
            .world_state_baseline
            .is_none());
    }

    fn meta_line(thread_id: &str, session_id: Option<&str>, timestamp: &str) -> ThreadLogLine {
        ThreadLogLine {
            timestamp: timestamp.to_string(),
            ordinal: None,
            item: ThreadLogItem::SessionMeta(ThreadMeta {
                schema_version: crate::worker_thread_log::THREAD_LOG_SCHEMA_VERSION,
                thread_id: thread_id.to_string(),
                session_id: session_id.map(str::to_string),
                created_at: timestamp.to_string(),
                cwd: String::new(),
                source: "desktop".to_string(),
                model_provider: Some("deepseek".to_string()),
                model: Some("deepseek-v4-pro".to_string()),
                base_instructions: None,
                history_mode: Some("default".to_string()),
                forked_from_thread_id: None,
                parent_thread_id: None,
                originator: Some("Tinybot Desktop".to_string()),
            }),
        }
    }

    fn response_line(timestamp: &str, item: Value) -> ThreadLogLine {
        ThreadLogLine {
            timestamp: timestamp.to_string(),
            ordinal: None,
            item: ThreadLogItem::ResponseItem(response_item(item)),
        }
    }

    fn event_line(timestamp: &str, event_type: &str, payload: Value) -> ThreadLogLine {
        ThreadLogLine {
            timestamp: timestamp.to_string(),
            ordinal: None,
            item: ThreadLogItem::EventMsg(event_msg(json!({
                "type": event_type,
                "payload": payload
            }))),
        }
    }

    fn compacted_line(timestamp: &str, summary: &str) -> ThreadLogLine {
        ThreadLogLine {
            timestamp: timestamp.to_string(),
            ordinal: None,
            item: ThreadLogItem::Compacted(compacted_item(json!({
                "replacementHistory": [{
                    "role": "assistant",
                    "content": summary
                }]
            }))),
        }
    }

    fn token_count_line(timestamp: &str, last_tokens: i64, context_window: i64) -> ThreadLogLine {
        ThreadLogLine {
            timestamp: timestamp.to_string(),
            ordinal: None,
            item: ThreadLogItem::EventMsg(event_msg(json!({
                "type": "token_count",
                "info": {
                    "total_token_usage": usage_value(1000 + last_tokens),
                    "last_token_usage": usage_value(last_tokens),
                    "model_context_window": context_window
                }
            }))),
        }
    }

    fn event_msg(value: Value) -> EventMsg {
        serde_json::from_value(value).unwrap()
    }

    fn response_item(value: Value) -> ResponseItem {
        ResponseItem::from_value(value).unwrap()
    }

    fn compacted_item(value: Value) -> CompactedItem {
        CompactedItem::from_value(value).unwrap()
    }

    fn usage_value(total_tokens: i64) -> Value {
        json!({
            "input_tokens": total_tokens / 2,
            "cached_input_tokens": 0,
            "output_tokens": total_tokens / 2,
            "reasoning_output_tokens": 0,
            "total_tokens": total_tokens
        })
    }
}
