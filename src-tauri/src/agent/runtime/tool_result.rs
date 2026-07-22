use super::tool_projection::legacy_tool_content;
use super::{NativeAgentToolCall, NativeAgentToolResult, NativeToolResultEnvelope};
use serde_json::Value;
use std::ops::{Deref, DerefMut};

impl NativeToolResultEnvelope {
    pub fn generic_success(tool_call: &NativeAgentToolCall, raw_content: Value) -> Self {
        let model_content = legacy_tool_content(&raw_content);
        Self::from_parts(
            "ok",
            model_content.clone(),
            model_content,
            "generic_result",
            tool_call.name.clone(),
            serde_json::json!({
                "kind": "generic_result",
                "value": raw_content,
            }),
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
            "generic_error",
            tool_call.name.clone(),
            serde_json::json!({
                "kind": "generic_error",
                "value": raw_content,
            }),
            serde_json::json!([]),
            serde_json::json!([]),
            serde_json::json!([]),
            tool_call,
            raw_content,
        )
    }

    pub fn approval_denied(
        tool_call: &NativeAgentToolCall,
        summary: String,
        guidance: String,
    ) -> Self {
        Self::from_parts(
            "denied",
            summary.clone(),
            summary.clone(),
            "approval_denied",
            tool_call.name.clone(),
            serde_json::json!({
                "kind": "approval_denied",
                "guidance": guidance,
            }),
            serde_json::json!([]),
            serde_json::json!([]),
            serde_json::json!([]),
            tool_call,
            serde_json::json!({
                "guidance": guidance,
            }),
        )
    }

    fn from_parts(
        status: &str,
        summary: String,
        model_content: String,
        ui_type: &str,
        title: String,
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
                "ui": {
                    "type": ui_type,
                    "title": title,
                    "actions": [],
                },
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
}
