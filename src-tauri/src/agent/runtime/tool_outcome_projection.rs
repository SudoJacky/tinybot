use super::{NativeAgentToolCall, NativeToolNextAction, NativeToolOutcome, NativeToolRetry};
use serde_json::Value;

pub(super) struct NativeToolOutcomeProjection {
    pub summary: String,
    pub model_content: String,
    pub structured: Value,
    pub ui: Value,
}

pub(super) fn project_tool_outcome(
    tool_call: &NativeAgentToolCall,
    raw_content: &Value,
    outcome: &NativeToolOutcome,
) -> NativeToolOutcomeProjection {
    let structured_outcome =
        serde_json::to_value(outcome).expect("native tool outcome must serialize to JSON");
    let guidance = outcome_guidance(outcome);
    let mut model_outcome = structured_outcome.clone();
    model_outcome["guidance"] = Value::String(guidance);
    let summary = outcome_summary(outcome);
    let actions = outcome
        .next_action
        .as_ref()
        .map(project_ui_action)
        .into_iter()
        .collect::<Vec<_>>();
    NativeToolOutcomeProjection {
        summary: summary.clone(),
        model_content: serde_json::json!({
            "toolOutcome": model_outcome,
            "result": raw_content,
        })
        .to_string(),
        structured: serde_json::json!({
            "kind": "tool_outcome",
            "outcome": structured_outcome,
        }),
        ui: serde_json::json!({
            "type": "tool_outcome",
            "title": tool_call.name,
            "summary": summary,
            "actions": actions,
        }),
    }
}

fn outcome_summary(outcome: &NativeToolOutcome) -> String {
    let label = match outcome.effect.as_str() {
        "unchanged" => "No change",
        "stale_state" => "State changed",
        "in_progress" => "Still running",
        "partial_result" => "Partial result",
        "alternative_required" => "Alternative action required",
        "user_action_required" => "User action required",
        "failed" => "Tool failed",
        "cancelled" => "Tool cancelled",
        "timed_out" => "Tool timed out",
        _ => "Special tool result",
    };
    format!("{label}: {}", compact_text(&outcome.reason, 160))
}

fn outcome_guidance(outcome: &NativeToolOutcome) -> String {
    let retry_guidance = match outcome.retry {
        NativeToolRetry::DoNotRetry => "Do not repeat the same tool call.",
        NativeToolRetry::RetryWithUpdatedState => {
            "Use the returned updated state to reassess before issuing a new tool call."
        }
        NativeToolRetry::AfterUserAction => {
            "Pause automated work until the required user action is complete, then reassess the current state."
        }
        NativeToolRetry::Replan => {
            "Do not retry automatically. Inspect the reason and current evidence, then replan."
        }
    };
    match outcome.next_action.as_ref() {
        Some(next_action) => format!(
            "{retry_guidance} Follow nextAction by calling `{}` with its provided arguments.",
            next_action.tool
        ),
        None => retry_guidance.to_string(),
    }
}

fn project_ui_action(next_action: &NativeToolNextAction) -> Value {
    serde_json::json!({
        "type": "tool_call",
        "label": format!("Use {}", next_action.tool),
        "tool": next_action.tool,
        "arguments": next_action.arguments,
    })
}

fn compact_text(text: &str, max_chars: usize) -> String {
    let mut characters = text.trim().chars();
    let compact = characters.by_ref().take(max_chars).collect::<String>();
    if characters.next().is_some() {
        format!("{compact}…")
    } else {
        compact
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projection_generates_model_guidance_and_ui_from_structured_facts() {
        let tool_call = NativeAgentToolCall {
            id: "call-navigation".to_string(),
            name: "web.act".to_string(),
            arguments_json: "{}".to_string(),
            result: Value::Null,
        };
        let outcome = NativeToolOutcome {
            effect: "alternative_required".to_string(),
            action_executed: Some(false),
            reason_code: "target_opens_new_window".to_string(),
            reason: "The target opens a new browser window.".to_string(),
            retry: NativeToolRetry::DoNotRetry,
            next_action: Some(NativeToolNextAction {
                tool: "web.open".to_string(),
                arguments: serde_json::json!({ "url": "https://example.com/docs" }),
            }),
        };

        let projection = project_tool_outcome(
            &tool_call,
            &serde_json::json!({ "status": "navigation_required" }),
            &outcome,
        );
        let model_content: Value =
            serde_json::from_str(&projection.model_content).expect("model content should be JSON");

        assert_eq!(
            projection.summary,
            "Alternative action required: The target opens a new browser window."
        );
        assert_eq!(projection.structured["outcome"]["retry"], "do_not_retry");
        assert!(projection.structured["outcome"].get("guidance").is_none());
        assert!(model_content["toolOutcome"]["guidance"]
            .as_str()
            .is_some_and(|guidance| guidance.contains("Follow nextAction")));
        assert_eq!(projection.ui["summary"], projection.summary);
        assert_eq!(projection.ui["actions"][0]["tool"], "web.open");
    }
}
