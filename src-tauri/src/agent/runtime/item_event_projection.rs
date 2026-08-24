use super::items::{
    AgentContextCompactionItem, AgentErrorItem, AgentFileReferenceItem, AgentSubagentItem,
    AgentSubagentMessageItem, AgentUserInputItem,
};
use super::{AgentItem, AgentUsageItem};
use crate::agent::runtime_protocol::AgentEventKind;
use serde_json::Value;

pub(super) fn attach_agent_item(kind: AgentEventKind, mut payload: Value) -> Value {
    if payload.get("agentItem").is_some() {
        return payload;
    }
    let Some(item) = agent_item_for_runtime_event(kind, &payload) else {
        return payload;
    };
    let object = payload
        .as_object_mut()
        .expect("runtime event payload with an agent item must be an object");
    object.insert(
        "agentItem".to_string(),
        serde_json::to_value(item).expect("typed agent item must serialize"),
    );
    payload
}

fn agent_item_for_runtime_event(kind: AgentEventKind, payload: &Value) -> Option<AgentItem> {
    match kind {
        AgentEventKind::AwaitingForm | AgentEventKind::FormResolution => {
            Some(AgentItem::UserInput(AgentUserInputItem {
                id: required_string(payload, &["formId", "form_id"], kind),
                command_id: optional_string(payload, &["commandId", "command_id"]),
                status: optional_string(payload, &["status"])
                    .unwrap_or_else(|| "completed".to_string()),
                action: optional_string(payload, &["action"]),
                field_ids: form_field_ids(payload.get("form")),
                values: payload.get("values").cloned(),
                errors: payload.get("errors").cloned(),
            }))
        }
        AgentEventKind::PlanProgress | AgentEventKind::TaskProgress => {
            let mut steps = payload
                .get("steps")
                .or_else(|| payload.get("plan"))
                .cloned()
                .map(|steps| {
                    serde_json::from_value(steps).unwrap_or_else(|error| {
                        panic!("runtime plan progress steps are invalid: {error}")
                    })
                })
                .unwrap_or_else(|| panic!("runtime plan progress requires complete steps"));
            let derived = super::validate_and_normalize_plan_steps(&mut steps)
                .unwrap_or_else(|error| panic!("runtime plan progress is invalid: {error}"));
            if payload.get("completed").and_then(Value::as_u64)
                != Some(u64::from(derived.completed))
                || payload.get("total").and_then(Value::as_u64) != Some(u64::from(derived.total))
                || optional_string(payload, &["currentStep", "current_step"]).as_deref()
                    != derived.current_step.as_deref()
            {
                panic!("runtime plan progress derived fields do not match its steps");
            }
            Some(AgentItem::PlanProgress(super::AgentPlanProgressItem {
                id: required_string(payload, &["planId", "plan_id"], kind),
                explanation: optional_string(payload, &["explanation"]),
                steps,
                summary: optional_string(payload, &["summary", "content"]).unwrap_or_default(),
                completed: derived.completed,
                total: derived.total,
                current_step: derived.current_step,
            }))
        }
        kind if kind.delegate_action().is_some() => {
            if matches!(
                kind,
                AgentEventKind::DelegateUserMessage | AgentEventKind::DelegateMessage
            ) {
                return Some(AgentItem::SubagentMessage(AgentSubagentMessageItem {
                    id: required_string(
                        payload,
                        &["messageId", "eventId", "delegateEventId"],
                        kind,
                    ),
                    agent_id: required_string(payload, &["delegateId", "subagentId"], kind),
                    content: required_string(payload, &["content", "message"], kind),
                    visibility: optional_string(payload, &["visibility"])
                        .unwrap_or_else(|| "user".to_string()),
                }));
            }
            let action = kind
                .delegate_action()
                .expect("delegate event must have an action")
                .to_string();
            let agent_id = optional_string(payload, &["delegateId", "subagentId"])
                .unwrap_or_else(|| "multiple".to_string());
            let id = agent_id.clone();
            Some(AgentItem::Subagent(AgentSubagentItem {
                id,
                agent_id,
                action,
                status: optional_string(payload, &["status"])
                    .unwrap_or_else(|| subagent_default_status(kind).to_string()),
                message: optional_string(
                    payload,
                    &["terminalResult", "blockerSummary", "task", "content"],
                ),
            }))
        }
        AgentEventKind::ContextCompacted | AgentEventKind::ContextTrimmed => {
            let turn_id = required_string(payload, &["turnId", "turn_id"], kind);
            let iteration = payload
                .get("iteration")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let strategy = optional_string(payload, &["strategy"]).unwrap_or_default();
            Some(AgentItem::ContextCompaction(AgentContextCompactionItem {
                id: format!("{turn_id}:context:{iteration}"),
                summary: strategy,
                dropped_item_count: payload
                    .get("droppedMessageCount")
                    .or_else(|| payload.get("dropped_item_count"))
                    .and_then(Value::as_u64)
                    .unwrap_or(0) as usize,
                estimated_tokens_before: optional_u64(
                    payload,
                    &["estimatedTokensBefore", "estimated_tokens_before"],
                ),
                estimated_tokens_after: optional_u64(
                    payload,
                    &["estimatedTokensAfter", "estimated_tokens_after"],
                ),
            }))
        }
        AgentEventKind::Error
        | AgentEventKind::Cancelled
        | AgentEventKind::CleanupTimeout
        | AgentEventKind::ToolCleanupTimeout
        | AgentEventKind::ContextCompactionFailed => {
            let turn_id = required_string(payload, &["turnId", "turn_id"], kind);
            let code = optional_string(payload, &["stopReason", "code"])
                .unwrap_or_else(|| kind.wire_name().trim_start_matches("agent.").to_string());
            let message =
                optional_string(payload, &["message", "error"]).unwrap_or_else(|| code.clone());
            Some(AgentItem::Error(AgentErrorItem {
                id: Some(format!("{turn_id}:error:{code}")),
                code,
                message,
                command_id: optional_string(payload, &["commandId", "command_id"]),
                cancelled: kind == AgentEventKind::Cancelled
                    || payload
                        .get("cancelled")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
            }))
        }
        AgentEventKind::Usage => {
            let turn_id = required_string(payload, &["turnId", "turn_id"], kind);
            let mut usage = AgentUsageItem::from_provider_payload(
                payload
                    .get("providerUsage")
                    .or_else(|| payload.get("provider_usage"))
                    .or_else(|| payload.get("usage"))
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({})),
            )
            .expect("runtime usage payload must be an object");
            usage.id = Some(format!(
                "{turn_id}:usage:{}",
                payload
                    .get("iteration")
                    .and_then(Value::as_i64)
                    .unwrap_or(0)
            ));
            Some(AgentItem::Usage(usage))
        }
        AgentEventKind::FileReference => Some(AgentItem::FileReference(AgentFileReferenceItem {
            id: required_string(payload, &["referenceId", "reference_id"], kind),
            path: required_string(payload, &["path", "url"], kind),
            mime_type: optional_string(payload, &["mimeType", "mime_type"]),
            reference_kind: optional_string(payload, &["referenceKind", "reference_kind"])
                .unwrap_or_else(|| "file".to_string()),
        })),
        _ => None,
    }
}

fn required_string(payload: &Value, keys: &[&str], kind: AgentEventKind) -> String {
    optional_string(payload, keys).unwrap_or_else(|| {
        panic!(
            "runtime event `{}` requires one of: {}",
            kind.wire_name(),
            keys.join(", ")
        )
    })
}

fn optional_string(payload: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        payload
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })
}

fn optional_u64(payload: &Value, keys: &[&str]) -> Option<u64> {
    keys.iter()
        .find_map(|key| payload.get(*key).and_then(Value::as_u64))
}

fn form_field_ids(form: Option<&Value>) -> Vec<String> {
    ["questions", "fields"]
        .iter()
        .find_map(|key| form?.get(*key).and_then(Value::as_array))
        .into_iter()
        .flatten()
        .filter_map(|field| optional_string(field, &["id", "fieldId", "field_id"]))
        .collect()
}

fn subagent_default_status(kind: AgentEventKind) -> &'static str {
    match kind {
        AgentEventKind::DelegateCancelled => "cancelled",
        AgentEventKind::DelegateClosed => "closed",
        AgentEventKind::DelegateResult => "completed",
        AgentEventKind::DelegateWait | AgentEventKind::DelegateNotification => "waiting",
        _ => "running",
    }
}
