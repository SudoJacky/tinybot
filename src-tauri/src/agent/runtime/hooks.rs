use crate::agent::runtime_protocol::AgentTraceContext;
use crate::runtime::observability::AgentRuntimeMetrics;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;
use std::sync::Arc;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentHookStage {
    BeforeProviderRequest,
    AfterProviderResponse,
    BeforeToolUse,
    AfterToolUse,
    PermissionRequest,
    TurnStart,
    TurnComplete,
    TurnAbort,
    ThreadStart,
    ThreadStop,
    CompactionComplete,
}

impl AgentHookStage {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::BeforeProviderRequest => "before_provider_request",
            Self::AfterProviderResponse => "after_provider_response",
            Self::BeforeToolUse => "before_tool_use",
            Self::AfterToolUse => "after_tool_use",
            Self::PermissionRequest => "permission_request",
            Self::TurnStart => "turn_start",
            Self::TurnComplete => "turn_complete",
            Self::TurnAbort => "turn_abort",
            Self::ThreadStart => "thread_start",
            Self::ThreadStop => "thread_stop",
            Self::CompactionComplete => "compaction_complete",
        }
    }

    fn supports_denial(self) -> bool {
        matches!(
            self,
            Self::BeforeProviderRequest
                | Self::BeforeToolUse
                | Self::PermissionRequest
                | Self::TurnStart
                | Self::ThreadStart
        )
    }

    fn supports_input_replacement(self) -> bool {
        self == Self::BeforeToolUse
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentHookDecision {
    Continue,
    Deny { reason: String },
    ReplaceNormalizedInput { normalized_input: Value },
    AppendDiagnosticMetadata { metadata: Value },
}

impl AgentHookDecision {
    fn kind(&self) -> &'static str {
        match self {
            Self::Continue => "continue",
            Self::Deny { .. } => "deny",
            Self::ReplaceNormalizedInput { .. } => "replace_normalized_input",
            Self::AppendDiagnosticMetadata { .. } => "append_diagnostic_metadata",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct AgentHookInvocation {
    pub stage: AgentHookStage,
    pub trace_context: AgentTraceContext,
    pub provider_attempt_id: Option<String>,
    pub tool_call_id: Option<String>,
    pub tool_name: Option<String>,
    pub normalized_input: Option<Value>,
    pub outcome: Option<String>,
}

impl AgentHookInvocation {
    pub(crate) fn lifecycle(stage: AgentHookStage, trace_context: AgentTraceContext) -> Self {
        Self {
            stage,
            trace_context,
            provider_attempt_id: None,
            tool_call_id: None,
            tool_name: None,
            normalized_input: None,
            outcome: None,
        }
    }

    pub(crate) fn provider(
        stage: AgentHookStage,
        trace_context: AgentTraceContext,
        provider_attempt_id: String,
        outcome: Option<String>,
    ) -> Self {
        Self {
            stage,
            trace_context,
            provider_attempt_id: Some(provider_attempt_id),
            tool_call_id: None,
            tool_name: None,
            normalized_input: None,
            outcome,
        }
    }

    pub(crate) fn tool(
        stage: AgentHookStage,
        trace_context: AgentTraceContext,
        tool_call_id: String,
        tool_name: String,
        normalized_input: Option<Value>,
        outcome: Option<String>,
    ) -> Self {
        Self {
            stage,
            trace_context,
            provider_attempt_id: None,
            tool_call_id: Some(tool_call_id),
            tool_name: Some(tool_name),
            normalized_input,
            outcome,
        }
    }
}

pub trait AgentHook: Send + Sync + 'static {
    fn name(&self) -> &'static str {
        "agent_hook"
    }

    fn evaluate(&self, invocation: &AgentHookInvocation) -> Result<AgentHookDecision, String>;
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentHookDecisionRecord {
    pub hook_name: String,
    pub stage: AgentHookStage,
    pub decision: AgentHookDecision,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct AgentHookEvaluation {
    pub normalized_input: Option<Value>,
    pub input_replaced: bool,
    pub denied_reason: Option<String>,
    pub diagnostic_metadata: serde_json::Map<String, Value>,
    pub decisions: Vec<AgentHookDecisionRecord>,
}

impl AgentHookEvaluation {
    pub(crate) fn event_payload(&self, invocation: &AgentHookInvocation) -> Value {
        let decisions = self
            .decisions
            .iter()
            .map(|record| {
                serde_json::json!({
                    "hookName": record.hook_name,
                    "stage": record.stage,
                    "decision": record.decision.kind(),
                })
            })
            .collect::<Vec<_>>();
        serde_json::json!({
            "requestId": invocation.trace_context.request_id,
            "traceId": invocation.trace_context.trace_id,
            "runId": invocation.trace_context.run_id,
            "turnId": invocation.trace_context.turn_id,
            "threadId": invocation.trace_context.thread_id,
            "stage": invocation.stage,
            "providerAttemptId": invocation.provider_attempt_id,
            "toolCallId": invocation.tool_call_id,
            "toolName": invocation.tool_name,
            "outcome": invocation.outcome,
            "deniedReason": self.denied_reason,
            "diagnosticMetadata": self.diagnostic_metadata,
            "decisions": decisions,
        })
    }
}

#[derive(Clone)]
pub(crate) struct AgentHookPipeline {
    hooks: Arc<Vec<Arc<dyn AgentHook>>>,
}

impl Default for AgentHookPipeline {
    fn default() -> Self {
        Self {
            hooks: Arc::new(Vec::new()),
        }
    }
}

impl fmt::Debug for AgentHookPipeline {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AgentHookPipeline")
            .field("hook_count", &self.hooks.len())
            .finish()
    }
}

impl AgentHookPipeline {
    pub(crate) fn with_hook(&self, hook: Arc<dyn AgentHook>) -> Self {
        let mut hooks = self.hooks.as_ref().clone();
        hooks.push(hook);
        Self {
            hooks: Arc::new(hooks),
        }
    }

    pub(crate) fn evaluate(
        &self,
        invocation: AgentHookInvocation,
        metrics: &AgentRuntimeMetrics,
    ) -> Result<AgentHookEvaluation, String> {
        let mut invocation = invocation;
        let mut evaluation = AgentHookEvaluation {
            normalized_input: invocation.normalized_input.clone(),
            ..AgentHookEvaluation::default()
        };
        for hook in self.hooks.iter() {
            let decision = hook.evaluate(&invocation).map_err(|error| {
                metrics.increment("hook.error");
                format!(
                    "agent hook `{}` failed at {}: {error}",
                    hook.name(),
                    invocation.stage.as_str()
                )
            })?;
            metrics.increment(&format!(
                "hook.{}.{}",
                invocation.stage.as_str(),
                decision.kind()
            ));
            apply_decision(&mut invocation, &mut evaluation, hook.name(), decision)?;
            if evaluation.denied_reason.is_some() {
                break;
            }
        }
        Ok(evaluation)
    }
}

fn apply_decision(
    invocation: &mut AgentHookInvocation,
    evaluation: &mut AgentHookEvaluation,
    hook_name: &str,
    decision: AgentHookDecision,
) -> Result<(), String> {
    match &decision {
        AgentHookDecision::Continue => {}
        AgentHookDecision::Deny { reason } => {
            if !invocation.stage.supports_denial() {
                return Err(format!(
                    "agent hook `{hook_name}` returned deny at unsupported stage {}",
                    invocation.stage.as_str()
                ));
            }
            let reason = reason.trim();
            if reason.is_empty() {
                return Err(format!(
                    "agent hook `{hook_name}` returned deny without a reason"
                ));
            }
            evaluation.denied_reason = Some(reason.to_string());
        }
        AgentHookDecision::ReplaceNormalizedInput { normalized_input } => {
            if !invocation.stage.supports_input_replacement() {
                return Err(format!(
                    "agent hook `{hook_name}` returned input replacement at unsupported stage {}",
                    invocation.stage.as_str()
                ));
            }
            evaluation.normalized_input = Some(normalized_input.clone());
            evaluation.input_replaced = true;
            invocation.normalized_input = Some(normalized_input.clone());
        }
        AgentHookDecision::AppendDiagnosticMetadata { metadata } => {
            let object = metadata.as_object().ok_or_else(|| {
                format!("agent hook `{hook_name}` diagnostic metadata must be a JSON object")
            })?;
            for (key, value) in object {
                evaluation
                    .diagnostic_metadata
                    .insert(key.clone(), sanitize_diagnostic_value(key, value, 0));
            }
        }
    }
    evaluation.decisions.push(AgentHookDecisionRecord {
        hook_name: hook_name.to_string(),
        stage: invocation.stage,
        decision,
    });
    Ok(())
}

fn sanitize_diagnostic_value(key: &str, value: &Value, depth: usize) -> Value {
    let normalized_key = key.to_ascii_lowercase();
    if [
        "prompt",
        "secret",
        "password",
        "authorization",
        "api_key",
        "apikey",
        "arguments",
        "input",
        "output",
        "content",
        "path",
        "memory",
    ]
    .iter()
    .any(|sensitive| normalized_key.contains(sensitive))
    {
        return Value::String("[redacted]".to_string());
    }
    if depth >= 4 {
        return Value::String("[truncated]".to_string());
    }
    match value {
        Value::String(value) => Value::String(value.chars().take(256).collect()),
        Value::Array(values) => Value::Array(
            values
                .iter()
                .take(16)
                .map(|value| sanitize_diagnostic_value("item", value, depth + 1))
                .collect(),
        ),
        Value::Object(values) => Value::Object(
            values
                .iter()
                .take(32)
                .map(|(key, value)| {
                    (
                        key.clone(),
                        sanitize_diagnostic_value(key, value, depth + 1),
                    )
                })
                .collect(),
        ),
        value => value.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trace_context() -> AgentTraceContext {
        AgentTraceContext {
            request_id: "request-1".to_string(),
            trace_id: "trace-1".to_string(),
            run_id: "run-1".to_string(),
            turn_id: "turn-1".to_string(),
            thread_id: Some("thread-1".to_string()),
            parent_run_id: None,
        }
    }

    struct InvalidAfterHook;

    impl AgentHook for InvalidAfterHook {
        fn evaluate(&self, _invocation: &AgentHookInvocation) -> Result<AgentHookDecision, String> {
            Ok(AgentHookDecision::Deny {
                reason: "too late".to_string(),
            })
        }
    }

    #[test]
    fn invalid_decision_for_stage_fails_instead_of_becoming_success() {
        let pipeline = AgentHookPipeline::default().with_hook(Arc::new(InvalidAfterHook));
        let error = pipeline
            .evaluate(
                AgentHookInvocation::tool(
                    AgentHookStage::AfterToolUse,
                    trace_context(),
                    "tool-1".to_string(),
                    "workspace.read_file".to_string(),
                    None,
                    Some("completed".to_string()),
                ),
                &AgentRuntimeMetrics::isolated(),
            )
            .expect_err("after-tool denial should be rejected");

        assert!(error.contains("unsupported stage after_tool_use"));
    }

    #[test]
    fn diagnostic_metadata_redacts_sensitive_values_before_emission() {
        struct DiagnosticHook;

        impl AgentHook for DiagnosticHook {
            fn evaluate(
                &self,
                _invocation: &AgentHookInvocation,
            ) -> Result<AgentHookDecision, String> {
                Ok(AgentHookDecision::AppendDiagnosticMetadata {
                    metadata: serde_json::json!({
                        "code": "safe-code",
                        "arguments": { "token": "must-not-leak" },
                        "nested": { "apiKey": "must-not-leak" },
                    }),
                })
            }
        }

        let evaluation = AgentHookPipeline::default()
            .with_hook(Arc::new(DiagnosticHook))
            .evaluate(
                AgentHookInvocation::lifecycle(AgentHookStage::TurnStart, trace_context()),
                &AgentRuntimeMetrics::isolated(),
            )
            .expect("diagnostic hook should evaluate");

        assert_eq!(evaluation.diagnostic_metadata["code"], "safe-code");
        assert_eq!(evaluation.diagnostic_metadata["arguments"], "[redacted]");
        assert_eq!(
            evaluation.diagnostic_metadata["nested"]["apiKey"],
            "[redacted]"
        );
    }
}
