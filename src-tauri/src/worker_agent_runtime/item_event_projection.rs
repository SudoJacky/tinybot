use super::items::{
    AgentApprovalItem, AgentContextCompactionItem, AgentErrorItem, AgentFileReferenceItem,
    AgentSubagentItem, AgentUserInputItem,
};
use super::{AgentItem, AgentUsageItem};
use serde_json::Value;

pub(super) fn attach_agent_item(event_name: &str, mut payload: Value) -> Value {
    if payload.get("agentItem").is_some() {
        return payload;
    }
    let Some(item) = agent_item_for_runtime_event(event_name, &payload) else {
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

fn agent_item_for_runtime_event(event_name: &str, payload: &Value) -> Option<AgentItem> {
    match event_name {
        "agent.awaiting_approval" | "agent.approval.decision" => {
            Some(AgentItem::Approval(AgentApprovalItem {
                id: required_string(payload, &["approvalId", "approval_id"], event_name),
                tool_call_id: optional_string(payload, &["toolCallId", "tool_call_id"]),
                status: optional_string(payload, &["status"])
                    .unwrap_or_else(|| "completed".to_string()),
                reason: optional_string(payload, &["guidance", "reason", "summary", "content"]),
                decision: optional_string(payload, &["decision"]),
                scope: optional_string(payload, &["scope"]),
            }))
        }
        "agent.awaiting_form" | "agent.form.resolution" => {
            Some(AgentItem::UserInput(AgentUserInputItem {
                id: required_string(payload, &["formId", "form_id"], event_name),
                status: optional_string(payload, &["status"])
                    .unwrap_or_else(|| "completed".to_string()),
                action: optional_string(payload, &["action"]),
                field_ids: form_field_ids(payload.get("form")),
            }))
        }
        "agent.plan.progress" | "agent.task_progress" => {
            Some(AgentItem::PlanProgress(super::AgentPlanProgressItem {
                id: required_string(payload, &["planId", "plan_id"], event_name),
                summary: optional_string(payload, &["summary", "content"]).unwrap_or_default(),
                completed: optional_u32(payload, &["completed"]),
                total: optional_u32(payload, &["total"]),
            }))
        }
        name if name.starts_with("agent.delegate.") => {
            let action = name.trim_start_matches("agent.delegate.").to_string();
            let agent_id = optional_string(payload, &["delegateId", "subagentId"])
                .unwrap_or_else(|| "multiple".to_string());
            let id = optional_string(payload, &["delegateEventId"]).unwrap_or_else(|| {
                optional_string(payload, &["sourceToolCallId"])
                    .map(|source| format!("{agent_id}:{action}:{source}"))
                    .unwrap_or_else(|| format!("{agent_id}:{action}"))
            });
            Some(AgentItem::Subagent(AgentSubagentItem {
                id,
                agent_id,
                action,
                status: optional_string(payload, &["status"])
                    .unwrap_or_else(|| subagent_default_status(name).to_string()),
                message: optional_string(
                    payload,
                    &["terminalResult", "blockerSummary", "task", "content"],
                ),
            }))
        }
        "agent.context.compacted" | "agent.context.trimmed" => {
            let run_id = required_string(payload, &["runId", "run_id"], event_name);
            let iteration = payload
                .get("iteration")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let strategy = optional_string(payload, &["strategy"]).unwrap_or_default();
            Some(AgentItem::ContextCompaction(AgentContextCompactionItem {
                id: format!("{run_id}:context:{iteration}"),
                summary: strategy,
                dropped_item_count: payload
                    .get("droppedMessageCount")
                    .or_else(|| payload.get("dropped_item_count"))
                    .and_then(Value::as_u64)
                    .unwrap_or(0) as usize,
            }))
        }
        "agent.error" | "agent.cancelled" | "agent.tool.cleanup_timeout" => {
            let run_id = required_string(payload, &["runId", "run_id"], event_name);
            let code = optional_string(payload, &["stopReason", "code"])
                .unwrap_or_else(|| event_name.trim_start_matches("agent.").to_string());
            let message =
                optional_string(payload, &["message", "error"]).unwrap_or_else(|| code.clone());
            Some(AgentItem::Error(AgentErrorItem {
                id: Some(format!("{run_id}:error:{code}")),
                code,
                message,
                cancelled: event_name == "agent.cancelled"
                    || payload
                        .get("cancelled")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
            }))
        }
        "agent.usage" => {
            let run_id = required_string(payload, &["runId", "run_id"], event_name);
            let mut usage = AgentUsageItem::from_provider_payload(
                payload
                    .get("usage")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({})),
            )
            .expect("runtime usage payload must be an object");
            usage.id = Some(format!(
                "{run_id}:usage:{}",
                payload
                    .get("iteration")
                    .and_then(Value::as_i64)
                    .unwrap_or(0)
            ));
            Some(AgentItem::Usage(usage))
        }
        "agent.file.reference" => Some(AgentItem::FileReference(AgentFileReferenceItem {
            id: required_string(payload, &["referenceId", "reference_id"], event_name),
            path: required_string(payload, &["path", "url"], event_name),
            mime_type: optional_string(payload, &["mimeType", "mime_type"]),
            reference_kind: optional_string(payload, &["referenceKind", "reference_kind"])
                .unwrap_or_else(|| "file".to_string()),
        })),
        _ => None,
    }
}

fn required_string(payload: &Value, keys: &[&str], event_name: &str) -> String {
    optional_string(payload, keys).unwrap_or_else(|| {
        panic!(
            "runtime event `{event_name}` requires one of: {}",
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

fn optional_u32(payload: &Value, keys: &[&str]) -> u32 {
    keys.iter()
        .find_map(|key| payload.get(*key).and_then(Value::as_u64))
        .unwrap_or(0)
        .min(u32::MAX as u64) as u32
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

fn subagent_default_status(event_name: &str) -> &'static str {
    match event_name {
        "agent.delegate.cancelled" => "cancelled",
        "agent.delegate.closed" => "closed",
        "agent.delegate.result" => "completed",
        "agent.delegate.wait" | "agent.delegate.notification" => "waiting",
        _ => "running",
    }
}
