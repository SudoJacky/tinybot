use super::tool_outcome_projection::project_tool_outcome;
use super::tool_projection::legacy_tool_content;
use super::{
    NativeAgentToolCall, NativeAgentToolResult, NativeToolOutcome, NativeToolResultEnvelope,
};
use serde_json::Value;
use std::ops::{Deref, DerefMut};

impl NativeToolResultEnvelope {
    pub fn generic_success(tool_call: &NativeAgentToolCall, raw_content: Value) -> Self {
        let model_content = legacy_tool_content(&raw_content);
        Self::generic_success_with_model_content(
            tool_call,
            model_content.clone(),
            model_content,
            raw_content,
        )
    }

    fn generic_success_with_model_content(
        tool_call: &NativeAgentToolCall,
        summary: String,
        model_content: String,
        raw_content: Value,
    ) -> Self {
        Self::from_parts(
            "ok",
            summary,
            model_content,
            generic_ui("generic_result", tool_call.name.clone()),
            serde_json::json!({
                "kind": "generic_result",
            }),
            serde_json::json!([]),
            serde_json::json!([]),
            serde_json::json!([]),
            tool_call,
            raw_content,
        )
    }

    fn success_with_outcome(
        tool_call: &NativeAgentToolCall,
        raw_content: Value,
        outcome: NativeToolOutcome,
    ) -> Self {
        let projection = project_tool_outcome(tool_call, &raw_content, &outcome);
        Self::from_parts(
            "ok",
            projection.summary,
            projection.model_content,
            projection.ui,
            projection.structured,
            serde_json::json!([]),
            serde_json::json!([]),
            serde_json::json!([]),
            tool_call,
            raw_content,
        )
    }

    pub fn generic_error(
        tool_call: &NativeAgentToolCall,
        summary: String,
        raw_content: Value,
    ) -> Self {
        Self::from_parts(
            "error",
            summary.clone(),
            summary,
            generic_ui("generic_error", tool_call.name.clone()),
            serde_json::json!({
                "kind": "generic_error",
            }),
            serde_json::json!([]),
            serde_json::json!([]),
            serde_json::json!([]),
            tool_call,
            raw_content,
        )
    }

    fn from_parts(
        status: &str,
        summary: String,
        model_content: String,
        ui: Value,
        structured: Value,
        references: Value,
        artifacts: Value,
        side_effects: Value,
        tool_call: &NativeAgentToolCall,
        raw_content: Value,
    ) -> Self {
        Self {
            value: serde_json::json!({
                "status": status,
                "summary": summary,
                "modelContent": model_content,
                "structured": structured,
                "ui": ui,
                "references": references,
                "artifacts": artifacts,
                "sideEffects": side_effects,
                "metrics": {
                    "durationMs": Value::Null,
                    "modelChars": model_content.chars().count(),
                    "rawChars": raw_content.to_string().chars().count(),
                },
                "trace": {
                    "toolCallId": tool_call.id,
                    "toolName": tool_call.name,
                },
                "continuation": Value::Null,
                "redactions": [],
                "truncation": {
                    "truncated": false,
                },
                "raw": raw_content,
            }),
        }
    }
}

impl Deref for NativeToolResultEnvelope {
    type Target = Value;

    fn deref(&self) -> &Self::Target {
        &self.value
    }
}

impl DerefMut for NativeToolResultEnvelope {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.value
    }
}

impl NativeAgentToolResult {
    pub fn generic_success(tool_call: &NativeAgentToolCall, raw_content: Value) -> Self {
        let envelope = NativeToolResultEnvelope::generic_success(tool_call, raw_content);
        let model_content = envelope
            .get("modelContent")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        Self {
            content: Value::String(model_content),
            envelope,
        }
    }

    pub fn generic_error(tool_call: &NativeAgentToolCall, message: String) -> Self {
        let envelope = NativeToolResultEnvelope::generic_error(
            tool_call,
            message.clone(),
            Value::String(message.clone()),
        );
        Self {
            content: Value::String(message),
            envelope,
        }
    }

    pub(crate) fn generic_success_with_model_content(
        tool_call: &NativeAgentToolCall,
        summary: String,
        model_content: String,
        raw_content: Value,
    ) -> Self {
        let envelope = NativeToolResultEnvelope::generic_success_with_model_content(
            tool_call,
            summary,
            model_content.clone(),
            raw_content,
        );
        Self {
            content: Value::String(model_content),
            envelope,
        }
    }

    pub(crate) fn success_with_outcome(
        tool_call: &NativeAgentToolCall,
        raw_content: Value,
        outcome: NativeToolOutcome,
    ) -> Self {
        let envelope =
            NativeToolResultEnvelope::success_with_outcome(tool_call, raw_content, outcome);
        let model_content = envelope
            .get("modelContent")
            .and_then(Value::as_str)
            .expect("native tool outcome must include model content")
            .to_string();
        Self {
            content: Value::String(model_content),
            envelope,
        }
    }
}

fn generic_ui(ui_type: &str, title: String) -> Value {
    serde_json::json!({
        "type": ui_type,
        "title": title,
        "actions": [],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn generic_envelope_keeps_raw_result_only_once() {
        let tool_call = NativeAgentToolCall {
            id: "call-1".to_string(),
            name: "exec_command".to_string(),
            arguments_json: r#"{"command":"echo hello"}"#.to_string(),
            result: Value::Null,
        };
        let raw = json!({ "content": "hello", "stdout": "hello" });

        let result = NativeAgentToolResult::generic_success(&tool_call, raw.clone());

        assert_eq!(result.envelope["raw"], raw);
        assert_eq!(result.envelope["structured"]["kind"], "generic_result");
        assert!(result.envelope["structured"].get("value").is_none());
    }

    #[test]
    fn outcome_envelope_exposes_guidance_to_the_model_and_keeps_raw_evidence() {
        let tool_call = NativeAgentToolCall {
            id: "call-web-navigation".to_string(),
            name: "web.act".to_string(),
            arguments_json: r#"{"snapshotId":"snapshot-1"}"#.to_string(),
            result: Value::Null,
        };
        let raw = json!({
            "status": "navigation_required",
            "actionExecuted": false,
            "suggestedUrl": "https://example.com/docs"
        });
        let outcome = NativeToolOutcome {
            effect: "alternative_required".to_string(),
            action_executed: Some(false),
            reason_code: "target_opens_new_window".to_string(),
            reason: "The target opens a new window.".to_string(),
            retry: super::super::NativeToolRetry::DoNotRetry,
            next_action: Some(super::super::NativeToolNextAction {
                tool: "web.open".to_string(),
                arguments: json!({ "url": "https://example.com/docs" }),
            }),
        };

        let result = NativeAgentToolResult::success_with_outcome(&tool_call, raw.clone(), outcome);
        let model_content: Value = serde_json::from_str(
            result.envelope["modelContent"]
                .as_str()
                .expect("model content should be JSON"),
        )
        .expect("model content should parse");

        assert_eq!(result.envelope["status"], "ok");
        assert_eq!(result.envelope["structured"]["kind"], "tool_outcome");
        assert_eq!(
            result.envelope["structured"]["outcome"]["retry"],
            "do_not_retry"
        );
        assert_eq!(
            model_content["toolOutcome"]["guidance"],
            "Do not repeat the same tool call. Follow nextAction by calling `web.open` with its provided arguments."
        );
        assert_eq!(
            result.envelope["summary"],
            "Alternative action required: The target opens a new window."
        );
        assert_eq!(result.envelope["ui"]["summary"], result.envelope["summary"]);
        assert_eq!(result.envelope["ui"]["actions"][0]["tool"], "web.open");
        assert_eq!(model_content["result"], raw);
        assert_eq!(result.envelope["raw"], raw);
    }
}
