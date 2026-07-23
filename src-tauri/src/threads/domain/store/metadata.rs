use crate::threads::domain::types::{
    ThreadItem, ThreadItemKind, ThreadMetadata, ThreadMetadataPatch, ThreadRecord, ThreadStatus,
};
use serde_json::Value;
use std::collections::HashMap;

use super::{DEFAULT_THREAD_TITLE, TITLE_SOURCE_KEY, TITLE_SOURCE_MANUAL};

pub(super) fn apply_metadata_patch(record: &mut ThreadRecord, patch: ThreadMetadataPatch) {
    let has_explicit_title = patch.title.is_some();
    if let Some(title) = patch.title {
        record.title = title;
    }
    if let Some(summary) = patch.summary {
        record.metadata.summary = Some(summary);
    }
    if let Some(preview) = patch.preview {
        record.metadata.preview = Some(preview);
    }
    if let Some(tags) = patch.tags {
        record.metadata.tags = tags;
    }
    if let Some(model) = patch.model {
        record.metadata.model = Some(model);
    }
    if let Some(working_directory) = patch.working_directory {
        record.metadata.working_directory = Some(working_directory);
    }
    if let Some(last_user_message_at) = patch.last_user_message_at {
        record.metadata.last_user_message_at = Some(last_user_message_at);
    }
    if let Some(last_assistant_message_at) = patch.last_assistant_message_at {
        record.metadata.last_assistant_message_at = Some(last_assistant_message_at);
    }
    if let Some(last_activity_at) = patch.last_activity_at {
        record.metadata.last_activity_at = Some(last_activity_at);
    }
    if let Some(has_active_turn) = patch.has_active_turn {
        record.metadata.has_active_turn = has_active_turn;
    }
    if let Some(extra) = patch.extra {
        record.metadata.extra = extra;
    }
    if has_explicit_title {
        set_metadata_extra_string(
            &mut record.metadata.extra,
            TITLE_SOURCE_KEY,
            TITLE_SOURCE_MANUAL,
        );
    }
}

pub(super) fn set_metadata_extra_string(extra: &mut Value, key: &str, value: &str) {
    if !extra.is_object() {
        *extra = Value::Object(Default::default());
    }
    if let Some(map) = extra.as_object_mut() {
        map.insert(key.to_string(), Value::String(value.to_string()));
    }
}

pub(super) fn recompute_dynamic_metadata(record: &mut ThreadRecord, items: &[ThreadItem]) {
    const DEFAULT_TURN_KEY: &str = "__thread_default_run__";

    #[derive(Default)]
    struct TurnLifecycle {
        active: bool,
        waiting_for_approval: bool,
        terminal: bool,
        last_sequence: u64,
    }

    record.metadata.item_count = items.len() as u64;
    record.metadata.turn_count = 0;
    record.metadata.has_active_turn = false;
    record.metadata.last_user_message_at = None;
    record.metadata.last_assistant_message_at = None;
    record.metadata.last_activity_at = items.last().map(|item| item.created_at.clone());
    let mut preview = record.metadata.preview.clone();
    let mut status_when_no_active = if items.is_empty() {
        ThreadStatus::Empty
    } else {
        ThreadStatus::Idle
    };
    let mut turn_lifecycles: HashMap<String, TurnLifecycle> = HashMap::new();
    for item in items {
        let run_key = item
            .turn_id
            .clone()
            .unwrap_or_else(|| DEFAULT_TURN_KEY.to_string());
        match &item.kind {
            ThreadItemKind::UserMessage(payload) => {
                record.metadata.last_user_message_at = Some(item.created_at.clone());
                let user_preview = preview_from_payload(payload);
                if preview.is_none() {
                    preview = user_preview.clone();
                }
                if record.title == DEFAULT_THREAD_TITLE
                    && metadata_extra_string(&record.metadata, TITLE_SOURCE_KEY)
                        != Some(TITLE_SOURCE_MANUAL)
                {
                    if let Some(title) = user_preview {
                        record.title = title;
                    }
                }
            }
            ThreadItemKind::AssistantMessageCompleted(payload) => {
                record.metadata.last_assistant_message_at = Some(item.created_at.clone());
                preview = preview_from_payload(payload).or(preview);
            }
            ThreadItemKind::TurnStarted(_) => {
                record.metadata.turn_count = record.metadata.turn_count.saturating_add(1);
                if record.root_turn_id.is_none() {
                    record.root_turn_id = item.turn_id.clone();
                }
                let lifecycle = turn_lifecycles.entry(run_key).or_default();
                lifecycle.active = true;
                lifecycle.waiting_for_approval = false;
                lifecycle.terminal = false;
                lifecycle.last_sequence = item.sequence;
            }
            ThreadItemKind::TurnCompleted(_) => {
                if let ThreadItemKind::TurnCompleted(payload) = &item.kind {
                    if let Some(token_usage_info) = payload.get("tokenUsageInfo") {
                        set_metadata_extra_value(
                            &mut record.metadata.extra,
                            "tokenUsageInfo",
                            token_usage_info.clone(),
                        );
                    }
                }
                let lifecycle = turn_lifecycles.entry(run_key).or_default();
                if !lifecycle.terminal {
                    lifecycle.active = false;
                    lifecycle.waiting_for_approval = false;
                    lifecycle.terminal = true;
                    lifecycle.last_sequence = item.sequence;
                    status_when_no_active = ThreadStatus::Idle;
                }
            }
            ThreadItemKind::SubagentCompleted(_) => {
                let lifecycle = turn_lifecycles.entry(run_key).or_default();
                if !lifecycle.terminal {
                    lifecycle.active = false;
                    lifecycle.waiting_for_approval = false;
                    lifecycle.terminal = true;
                    lifecycle.last_sequence = item.sequence;
                    status_when_no_active = ThreadStatus::Idle;
                }
            }
            ThreadItemKind::ApprovalRequested(_) => {
                let lifecycle = turn_lifecycles.entry(run_key).or_default();
                if !lifecycle.terminal {
                    lifecycle.active = true;
                    lifecycle.waiting_for_approval = true;
                    lifecycle.last_sequence = item.sequence;
                }
            }
            ThreadItemKind::ApprovalResolved(_) => {
                if let Some(lifecycle) = turn_lifecycles.get_mut(&run_key) {
                    if lifecycle.active && !lifecycle.terminal {
                        lifecycle.waiting_for_approval = false;
                        lifecycle.last_sequence = item.sequence;
                    }
                }
            }
            ThreadItemKind::Error(_) => {
                let lifecycle = turn_lifecycles.entry(run_key).or_default();
                if !lifecycle.terminal {
                    lifecycle.active = false;
                    lifecycle.waiting_for_approval = false;
                    lifecycle.terminal = true;
                    lifecycle.last_sequence = item.sequence;
                    status_when_no_active = ThreadStatus::Failed;
                }
            }
            ThreadItemKind::Cancelled(_) => {
                let lifecycle = turn_lifecycles.entry(run_key).or_default();
                if !lifecycle.terminal {
                    lifecycle.active = false;
                    lifecycle.waiting_for_approval = false;
                    lifecycle.terminal = true;
                    lifecycle.last_sequence = item.sequence;
                    status_when_no_active = ThreadStatus::Idle;
                }
            }
            _ => {}
        }
    }
    record.metadata.has_active_turn = turn_lifecycles.values().any(|lifecycle| lifecycle.active);
    record.active_turn_id = turn_lifecycles
        .iter()
        .filter(|(turn_id, lifecycle)| lifecycle.active && turn_id.as_str() != DEFAULT_TURN_KEY)
        .max_by_key(|(_, lifecycle)| lifecycle.last_sequence)
        .map(|(turn_id, _)| turn_id.clone());
    let status = if turn_lifecycles
        .values()
        .any(|lifecycle| lifecycle.active && lifecycle.waiting_for_approval)
    {
        ThreadStatus::WaitingForApproval
    } else if record.metadata.has_active_turn {
        ThreadStatus::Running
    } else {
        status_when_no_active
    };
    record.metadata.preview = preview;
    if record.status != ThreadStatus::Archived {
        record.status = status;
    }
}

fn metadata_extra_string<'a>(metadata: &'a ThreadMetadata, key: &str) -> Option<&'a str> {
    metadata.extra.get(key).and_then(Value::as_str)
}

fn set_metadata_extra_value(extra: &mut Value, key: &str, value: Value) {
    if !extra.is_object() {
        *extra = Value::Object(Default::default());
    }
    if let Some(map) = extra.as_object_mut() {
        map.insert(key.to_string(), value);
    }
}

fn preview_from_payload(payload: &Value) -> Option<String> {
    payload
        .get("text")
        .or_else(|| payload.get("content"))
        .and_then(Value::as_str)
        .map(|value| value.trim().chars().take(160).collect::<String>())
        .filter(|value| !value.is_empty())
}
