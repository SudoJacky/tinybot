use crate::agent::runtime_protocol::AgentTraceContext;
use crate::command_hooks::{
    CommandHookEngine, CommandHookEvaluation, CommandHookEvent, CommandHookRequest,
};
use crate::runtime::observability::AgentRuntimeMetrics;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;
use std::sync::Arc;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentHookStage {
    UserPromptSubmit,
    BeforeProviderRequest,
    AfterProviderResponse,
    BeforeToolUse,
    AfterToolUse,
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
            Self::UserPromptSubmit => "user_prompt_submit",
            Self::BeforeProviderRequest => "before_provider_request",
            Self::AfterProviderResponse => "after_provider_response",
            Self::BeforeToolUse => "before_tool_use",
            Self::AfterToolUse => "after_tool_use",
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
            Self::UserPromptSubmit
                | Self::BeforeProviderRequest
                | Self::BeforeToolUse
                | Self::TurnStart
                | Self::ThreadStart
                | Self::CompactionComplete
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
    pub session_id: Option<String>,
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    pub prompt: Option<String>,
    pub tool_response: Option<Value>,
    pub compaction_trigger: Option<String>,
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
            session_id: None,
            model: None,
            permission_mode: None,
            prompt: None,
            tool_response: None,
            compaction_trigger: None,
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
            session_id: None,
            model: None,
            permission_mode: None,
            prompt: None,
            tool_response: None,
            compaction_trigger: None,
        }
    }

    pub(crate) fn user_prompt(
        trace_context: AgentTraceContext,
        session_id: String,
        model: String,
        permission_mode: String,
        prompt: String,
    ) -> Self {
        Self {
            stage: AgentHookStage::UserPromptSubmit,
            trace_context,
            provider_attempt_id: None,
            tool_call_id: None,
            tool_name: None,
            normalized_input: None,
            outcome: None,
            session_id: Some(session_id),
            model: Some(model),
            permission_mode: Some(permission_mode),
            prompt: Some(prompt),
            tool_response: None,
            compaction_trigger: None,
        }
    }

    pub(crate) fn tool(
        stage: AgentHookStage,
        trace_context: AgentTraceContext,
        session_id: String,
        model: String,
        permission_mode: String,
        tool_call_id: String,
        tool_name: String,
        normalized_input: Value,
        tool_response: Option<Value>,
    ) -> Self {
        debug_assert!(matches!(
            stage,
            AgentHookStage::BeforeToolUse | AgentHookStage::AfterToolUse
        ));
        Self {
            stage,
            trace_context,
            provider_attempt_id: None,
            tool_call_id: Some(tool_call_id),
            tool_name: Some(tool_name),
            normalized_input: Some(normalized_input),
            outcome: None,
            session_id: Some(session_id),
            model: Some(model),
            permission_mode: Some(permission_mode),
            prompt: None,
            tool_response,
            compaction_trigger: None,
        }
    }

    pub(crate) fn post_compact(
        trace_context: AgentTraceContext,
        session_id: String,
        model: String,
        permission_mode: String,
        trigger: String,
    ) -> Self {
        Self {
            stage: AgentHookStage::CompactionComplete,
            trace_context,
            provider_attempt_id: None,
            tool_call_id: None,
            tool_name: None,
            normalized_input: None,
            outcome: None,
            session_id: Some(session_id),
            model: Some(model),
            permission_mode: Some(permission_mode),
            prompt: None,
            tool_response: None,
            compaction_trigger: Some(trigger),
        }
    }

    fn command_request(&self) -> Option<CommandHookRequest> {
        let event = match self.stage {
            AgentHookStage::UserPromptSubmit => CommandHookEvent::UserPromptSubmit,
            AgentHookStage::BeforeToolUse => CommandHookEvent::PreToolUse,
            AgentHookStage::AfterToolUse => CommandHookEvent::PostToolUse,
            AgentHookStage::CompactionComplete => CommandHookEvent::PostCompact,
            _ => return None,
        };
        Some(CommandHookRequest {
            event,
            session_id: self.session_id.clone().unwrap_or_default(),
            turn_id: self.trace_context.turn_id.clone(),
            model: self.model.clone().unwrap_or_default(),
            permission_mode: self
                .permission_mode
                .clone()
                .unwrap_or_else(|| "local-worker".to_string()),
            prompt: self.prompt.clone(),
            tool_name: self.tool_name.clone(),
            tool_match_names: self.tool_name.clone().into_iter().collect(),
            tool_use_id: self.tool_call_id.clone(),
            tool_input: self.normalized_input.clone(),
            tool_response: self.tool_response.clone(),
            trigger: self.compaction_trigger.clone(),
        })
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
    pub command_runs: Vec<CommandHookRunRecord>,
    pub additional_context: Vec<String>,
    pub system_messages: Vec<String>,
    pub tool_feedback: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommandHookRunRecord {
    pub hook_name: String,
    pub hook_hash: String,
    pub source_path: String,
    pub duration_ms: u64,
    pub decision: String,
    pub failure: Option<String>,
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
        let command_runs = self
            .command_runs
            .iter()
            .map(|record| serde_json::json!(record))
            .collect::<Vec<_>>();
        serde_json::json!({
            "requestId": invocation.trace_context.request_id,
            "traceId": invocation.trace_context.trace_id,
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
            "commandRuns": command_runs,
            "additionalContextCount": self.additional_context.len(),
            "systemMessages": self.system_messages,
            "toolFeedbackCount": self.tool_feedback.len(),
        })
    }
}

#[derive(Clone)]
pub(crate) struct AgentHookPipeline {
    hooks: Arc<Vec<Arc<dyn AgentHook>>>,
    command_hooks: Arc<CommandHookEngine>,
}

impl Default for AgentHookPipeline {
    fn default() -> Self {
        Self {
            hooks: Arc::new(Vec::new()),
            command_hooks: Arc::new(CommandHookEngine::default()),
        }
    }
}

impl fmt::Debug for AgentHookPipeline {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AgentHookPipeline")
            .field("hook_count", &self.hooks.len())
            .field("command_hook_engine", &self.command_hooks)
            .finish()
    }
}

impl AgentHookPipeline {
    #[cfg(test)]
    pub(crate) fn with_hook(&self, hook: Arc<dyn AgentHook>) -> Self {
        let mut hooks = self.hooks.as_ref().clone();
        hooks.push(hook);
        Self {
            hooks: Arc::new(hooks),
            command_hooks: self.command_hooks.clone(),
        }
    }

    #[cfg_attr(test, allow(dead_code))]
    pub(crate) fn with_command_hooks(&self, command_hooks: CommandHookEngine) -> Self {
        Self {
            hooks: self.hooks.clone(),
            command_hooks: Arc::new(command_hooks),
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

    pub(crate) async fn evaluate_command_hooks(
        &self,
        invocation: AgentHookInvocation,
        metrics: &AgentRuntimeMetrics,
    ) -> Result<AgentHookEvaluation, String> {
        let mut evaluation = self.evaluate(invocation.clone(), metrics)?;
        let Some(request) = invocation.command_request() else {
            return Ok(evaluation);
        };
        let command_evaluation = self.command_hooks.evaluate(&request).await;
        merge_command_evaluation(&invocation, &mut evaluation, command_evaluation, metrics);
        Ok(evaluation)
    }
}

fn merge_command_evaluation(
    invocation: &AgentHookInvocation,
    evaluation: &mut AgentHookEvaluation,
    command_evaluation: CommandHookEvaluation,
    metrics: &AgentRuntimeMetrics,
) {
    let mut replacement = evaluation.normalized_input.clone();
    for run in command_evaluation.runs {
        metrics.increment(&format!(
            "hook.{}.{}",
            invocation.stage.as_str(),
            run.decision
        ));
        if run.failure.is_some() {
            metrics.increment("hook.error");
        }
        if let Some(reason) = run.denied_reason.as_deref() {
            append_unique_reason(&mut evaluation.denied_reason, reason);
        }
        if let Some(updated_input) = run.updated_input.as_ref() {
            match replacement.as_ref() {
                Some(existing) if evaluation.input_replaced && existing != updated_input => {
                    append_unique_reason(
                        &mut evaluation.denied_reason,
                        "trusted PreToolUse hooks returned conflicting updatedInput values",
                    );
                }
                _ => {
                    replacement = Some(updated_input.clone());
                    evaluation.normalized_input = Some(updated_input.clone());
                    evaluation.input_replaced = true;
                }
            }
        }
        if let Some(context) = run.additional_context.as_deref() {
            evaluation.additional_context.push(context.to_string());
        }
        if let Some(message) = run.system_message.as_deref() {
            evaluation.system_messages.push(message.to_string());
        }
        if let Some(feedback) = run.tool_feedback.as_deref() {
            evaluation.tool_feedback.push(feedback.to_string());
        }
        evaluation.command_runs.push(CommandHookRunRecord {
            hook_name: run.hook_name,
            hook_hash: run.hook_hash,
            source_path: run.source_path.to_string_lossy().to_string(),
            duration_ms: run.duration_ms,
            decision: run.decision,
            failure: run
                .failure
                .map(|message| message.chars().take(512).collect()),
        });
    }
}

fn append_unique_reason(target: &mut Option<String>, reason: &str) {
    let reason = reason.trim();
    if reason.is_empty() {
        return;
    }
    match target {
        Some(existing) if existing.split("; ").any(|item| item == reason) => {}
        Some(existing) => {
            existing.push_str("; ");
            existing.push_str(reason);
        }
        None => *target = Some(reason.to_string()),
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
#[path = "hooks_tests.rs"]
mod tests;
