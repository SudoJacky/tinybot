use super::catalog::NativeProviderApiMode;
use super::completion::{NativeProviderFailure, NativeProviderFailureKind};
use serde_json::Value;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ProviderStopReason {
    Stop,
    ToolCalls,
    OutputLimit,
    ContentFilter,
    Cancelled,
    Failed,
}

impl ProviderStopReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stop => "stop",
            Self::ToolCalls => "tool_calls",
            Self::OutputLimit => "output_limit",
            Self::ContentFilter => "content_filter",
            Self::Cancelled => "cancelled",
            Self::Failed => "failed",
        }
    }
}

/// The same terminal contract is checked after streaming and non-streaming calls,
/// before any output can become a final answer, tool invocation, or summary.
#[derive(Debug, Eq, PartialEq)]
pub(super) struct ProviderCompletionOutcome {
    pub reason: ProviderStopReason,
    pub raw_reason: String,
    error_message: Option<String>,
}

impl ProviderCompletionOutcome {
    pub fn from_response(protocol: NativeProviderApiMode, body: &Value) -> Result<Self, String> {
        let (reason, raw_reason) = match protocol {
            NativeProviderApiMode::ChatCompletions => {
                let raw = body
                    .pointer("/choices/0/finish_reason")
                    .and_then(Value::as_str)
                    .ok_or("chat/completions response ended without choices[0].finish_reason")?;
                let has_tools = body
                    .pointer("/choices/0/message/tool_calls")
                    .and_then(Value::as_array)
                    .is_some_and(|calls| !calls.is_empty());
                let reason = match raw {
                    "stop" if !has_tools => ProviderStopReason::Stop,
                    "tool_calls" if has_tools => ProviderStopReason::ToolCalls,
                    "stop" | "tool_calls" => {
                        return Err(format!(
                            "chat/completions finish_reason `{raw}` conflicts with tool_calls"
                        ));
                    }
                    "length" => ProviderStopReason::OutputLimit,
                    "content_filter" => ProviderStopReason::ContentFilter,
                    other => {
                        return Err(format!(
                            "unsupported chat/completions finish_reason `{other}`"
                        ))
                    }
                };
                (reason, raw.to_string())
            }
            NativeProviderApiMode::Responses => {
                let status = body
                    .get("status")
                    .and_then(Value::as_str)
                    .ok_or("Responses API response is missing status")?;
                match status {
                    "completed" => {
                        let output = body
                            .get("output")
                            .and_then(Value::as_array)
                            .ok_or("Responses API completed response requires output")?;
                        if output.iter().any(|item| {
                            item.get("status")
                                .and_then(Value::as_str)
                                .is_some_and(|status| status != "completed")
                        }) {
                            return Err(
                                "Responses API completed response contains unfinished output"
                                    .into(),
                            );
                        }
                        let reason = if output.iter().any(|item| item["type"] == "function_call") {
                            ProviderStopReason::ToolCalls
                        } else {
                            ProviderStopReason::Stop
                        };
                        (reason, status.to_string())
                    }
                    "incomplete" => {
                        let raw = body.pointer("/incomplete_details/reason").and_then(Value::as_str)
                            .filter(|reason| !reason.is_empty())
                            .ok_or("Responses API incomplete response requires incomplete_details.reason")?;
                        let reason = match raw {
                            "max_output_tokens" => ProviderStopReason::OutputLimit,
                            "content_filter" => ProviderStopReason::ContentFilter,
                            _ => ProviderStopReason::Failed,
                        };
                        (reason, raw.to_string())
                    }
                    "cancelled" => (ProviderStopReason::Cancelled, status.to_string()),
                    "failed" => (
                        ProviderStopReason::Failed,
                        body.pointer("/error/code")
                            .and_then(Value::as_str)
                            .unwrap_or(status)
                            .to_string(),
                    ),
                    other => {
                        return Err(format!(
                            "Responses API returned non-terminal or unsupported status `{other}`"
                        ))
                    }
                }
            }
        };
        Ok(Self {
            reason,
            raw_reason,
            error_message: body
                .pointer("/error/message")
                .and_then(Value::as_str)
                .map(str::to_string),
        })
    }

    pub fn require_complete(
        &self,
        protocol: NativeProviderApiMode,
    ) -> Result<(), NativeProviderFailure> {
        let kind = match self.reason {
            ProviderStopReason::Stop | ProviderStopReason::ToolCalls => return Ok(()),
            ProviderStopReason::OutputLimit => NativeProviderFailureKind::OutputLimit,
            ProviderStopReason::ContentFilter => NativeProviderFailureKind::ContentFilter,
            ProviderStopReason::Cancelled => NativeProviderFailureKind::Cancelled,
            ProviderStopReason::Failed => NativeProviderFailureKind::Provider,
        };
        Err(NativeProviderFailure::new(
            kind,
            format!(
                "{} response did not complete: {} (raw reason: `{}`){}",
                protocol.as_str(),
                self.reason.as_str(),
                self.raw_reason,
                self.error_message
                    .as_ref()
                    .map(|message| format!(": {message}"))
                    .unwrap_or_default(),
            ),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn chat_terminal_reasons_are_explicit_and_consistent_with_tools() {
        for (raw, tools, expected) in [
            ("stop", json!([]), ProviderStopReason::Stop),
            (
                "tool_calls",
                json!([{"id": "call-1"}]),
                ProviderStopReason::ToolCalls,
            ),
            (
                "length",
                json!([{"function": {"arguments": "{"}}]),
                ProviderStopReason::OutputLimit,
            ),
            (
                "content_filter",
                json!([]),
                ProviderStopReason::ContentFilter,
            ),
        ] {
            let outcome = ProviderCompletionOutcome::from_response(
                NativeProviderApiMode::ChatCompletions,
                &json!({"choices": [{"finish_reason": raw, "message": {"tool_calls": tools}}]}),
            )
            .unwrap();
            assert_eq!(outcome.reason, expected);
            assert_eq!(outcome.raw_reason, raw);
        }
        for body in [
            json!({"choices": [{"message": {"content": "partial"}}]}),
            json!({"choices": [{"finish_reason": "new_reason"}]}),
            json!({"choices": [{"finish_reason": "tool_calls", "message": {"tool_calls": []}}]}),
            json!({"choices": [{"finish_reason": "stop", "message": {"tool_calls": [{}]}}]}),
        ] {
            assert!(ProviderCompletionOutcome::from_response(
                NativeProviderApiMode::ChatCompletions,
                &body
            )
            .is_err());
        }
    }

    #[test]
    fn responses_incomplete_cannot_become_a_final_answer() {
        let protocol = NativeProviderApiMode::Responses;
        let outcome = ProviderCompletionOutcome::from_response(
            protocol,
            &json!({
                "status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"},
                "output": [{"type": "function_call", "arguments": "{"}],
            }),
        )
        .unwrap();
        let error = outcome.require_complete(protocol).unwrap_err();
        assert_eq!(error.kind(), NativeProviderFailureKind::OutputLimit);
        assert!(error.message().contains("max_output_tokens"));
        for body in [
            json!({}),
            json!({"status": "in_progress"}),
            json!({"status": "incomplete"}),
            json!({"status": "completed", "output": [{"status": "incomplete"}]}),
        ] {
            assert!(ProviderCompletionOutcome::from_response(protocol, &body).is_err());
        }
    }
}
