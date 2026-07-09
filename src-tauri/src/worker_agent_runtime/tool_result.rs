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

    pub fn file_excerpt(tool_call: &NativeAgentToolCall, path: String, excerpt: String) -> Self {
        Self::from_parts(
            "ok",
            format!("Read file excerpt: {path}"),
            excerpt.clone(),
            "file_excerpt",
            path.clone(),
            serde_json::json!({
                "kind": "file_excerpt",
                "path": path,
                "excerpt": excerpt,
            }),
            serde_json::json!([{ "type": "workspace_file", "path": path }]),
            serde_json::json!([]),
            serde_json::json!([]),
            tool_call,
            serde_json::json!({ "path": path, "excerpt": excerpt }),
        )
    }

    pub fn search_results(tool_call: &NativeAgentToolCall, query: String, matches: Value) -> Self {
        let match_count = matches.as_array().map_or(0, Vec::len);
        Self::from_parts(
            "ok",
            format!("Found {match_count} result(s) for {query}"),
            matches.to_string(),
            "search_results",
            query.clone(),
            serde_json::json!({
                "kind": "search_results",
                "query": query,
                "matches": matches,
            }),
            serde_json::json!([]),
            serde_json::json!([]),
            serde_json::json!([]),
            tool_call,
            serde_json::json!({ "query": query, "matches": matches }),
        )
    }

    pub fn command_output(
        tool_call: &NativeAgentToolCall,
        command: String,
        exit_code: i64,
        stdout: String,
        stderr: String,
    ) -> Self {
        let summary = format!("Command exited with code {exit_code}: {command}");
        let model_content = if stderr.trim().is_empty() {
            stdout.clone()
        } else {
            format!("{stdout}\n{stderr}")
        };
        Self::from_parts(
            "ok",
            summary,
            model_content,
            "command_output",
            command.clone(),
            serde_json::json!({
                "kind": "command_output",
                "command": command,
                "exitCode": exit_code,
                "stdout": stdout,
                "stderr": stderr,
            }),
            serde_json::json!([]),
            serde_json::json!([]),
            serde_json::json!([{ "type": "command", "command": command, "exitCode": exit_code }]),
            tool_call,
            serde_json::json!({
                "command": command,
                "exitCode": exit_code,
                "stdout": stdout,
                "stderr": stderr,
            }),
        )
    }

    pub fn knowledge_context(
        tool_call: &NativeAgentToolCall,
        summary: String,
        snippets: Value,
    ) -> Self {
        Self::from_parts(
            "ok",
            summary.clone(),
            snippets.to_string(),
            "knowledge_context",
            summary,
            serde_json::json!({
                "kind": "knowledge_context",
                "snippets": snippets,
            }),
            serde_json::json!([]),
            serde_json::json!([]),
            serde_json::json!([]),
            tool_call,
            serde_json::json!({ "snippets": snippets }),
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
}
